'use strict';

/**
 * Integration Tests for Image Processing Lambda Function
 *
 * This file provides end-to-end testing of the image processing functionality
 * with real image transformations, focusing on:
 *
 * - Complete processing pipelines from input to output
 * - Verification of actual image transformations (resizing, format conversion)
 * - Visual quality and dimension validation
 * - Format conversions with real image data
 * - Combined transformation scenarios (multiple operations at once)
 *
 * These tests create actual image files and process them through the full
 * Lambda function pipeline, validating that the entire system works correctly
 * together with real-world inputs and outputs. While slower than unit tests,
 * they provide confidence that the image processing delivers the expected results.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { startFakeS3 } = require('./fake-s3');
const { createCloudFrontEvent, invokeHandler } = require('./utils');

// Made with ImageMagick, not sharp, so the tests decode files sharp didn't encode itself.
const FIXTURES = {
  'alpha.png': 'image/png',
  'animated.gif': 'image/gif',
  'animated.webp': 'image/webp',
  'cmyk.jpg': 'image/jpeg',
  'exif-rotated.jpg': 'image/jpeg',
  'progressive.jpg': 'image/jpeg',
  'static.gif': 'image/gif',
};

const QUADRANTS = { topLeft: 'red', topRight: 'green', bottomLeft: 'blue', bottomRight: 'white' };

/**
 * Names the colour of the pixel 10% in from the given corner of an image, tolerating the colour
 * shifts of lossy encoding and colour space conversion.
 *
 * @param {Buffer} image Encoded image
 * @param {string} corner One of topLeft, topRight, bottomLeft or bottomRight
 * @return {Promise<string>} red, green, blue, white or transparent
 */
async function colourAt(image, corner) {
  const { width, height } = await sharp(image).metadata();
  const left = Math.floor(corner.endsWith('Left') ? width * 0.1 : width * 0.9);
  const top = Math.floor(corner.startsWith('top') ? height * 0.1 : height * 0.9);
  const [red, green, blue, alpha] = await sharp(image)
    .toColourspace('srgb')
    .ensureAlpha()
    .extract({ left, top, width: 1, height: 1 })
    .raw()
    .toBuffer();

  if (128 > alpha) {
    return 'transparent';
  }

  if (200 < Math.min(red, green, blue)) {
    return 'white';
  }

  const brightest = Math.max(red, green, blue);

  return brightest === red ? 'red' : brightest === green ? 'green' : 'blue';
}

/**
 * Names the colour at each corner of an image.
 *
 * @param {Buffer} image Encoded image
 * @return {Promise<Object>} Colour names keyed by corner
 */
async function coloursAtCorners(image) {
  const colours = {};

  for (const corner of Object.keys(QUADRANTS)) {
    colours[corner] = await colourAt(image, corner);
  }

  return colours;
}

describe('Image Processing Integration', () => {
  const originalEnvironment = process.env;
  let fakeS3;

  beforeAll(async () => {
    fakeS3 = await startFakeS3(parseInt(process.env.FAKE_S3_PORT, 10) || 0);

    if (!process.env.IMAGE_PROCESSING_FUNCTION_URL) {
      process.env = {
        ...originalEnvironment,
        AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${fakeS3.port}`,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      };
    }

    fakeS3.putObject(
      'test-image.jpg',
      'image/jpeg',
      await sharp({
        create: {
          width: 300,
          height: 200,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .jpeg()
        .toBuffer(),
    );

    fakeS3.putObject(
      'test-image.gif',
      'image/gif',
      await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .gif()
        .toBuffer(),
    );

    fakeS3.putObject(
      'test-image.webp',
      'image/webp',
      await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .webp()
        .toBuffer(),
    );

    for (const [key, contentType] of Object.entries(FIXTURES)) {
      fakeS3.putObject(key, contentType, fs.readFileSync(path.join(__dirname, 'fixtures', key)));
    }
  });

  beforeEach(() => {
    fakeS3.requests.splice(0);
  });

  afterAll(async () => {
    process.env = originalEnvironment;

    await fakeS3.close();
  });

  test('should fetch the original image from the bucket and region in the origin domain', async () => {
    await invokeHandler(
      createCloudFrontEvent({
        uri: '/test-image.jpg',
        region: 'us-west-2',
        bucket: 'my-test-bucket',
      }),
    );

    expect(fakeS3.requests).toEqual([
      { bucket: 'my-test-bucket', key: 'test-image.jpg', region: 'us-west-2' },
    ]);
  });

  test('should process a simple JPEG without transformations', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(200);
  });

  test('should resize JPEG image with width parameter', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'width=150',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(150);
    expect(metadata.height).toBe(100);
  });

  test('should convert to WebP when Accept header includes webp', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      headers: {
        accept: [{ key: 'Accept', value: 'image/webp,image/*' }],
      },
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/webp' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(200);
  });

  test('should convert GIF to PNG format', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.gif',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toEqual([{ key: 'Content-Type', value: 'image/png' }]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(200);
  });

  test('should apply custom quality when parameter is provided', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'quality=30',
      headers: {
        accept: [{ key: 'Accept', value: 'image/webp,image/*' }],
      },
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/webp' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(200);
  });

  test('should combine multiple transformations', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'width=250&quality=50',
      headers: {
        accept: [{ key: 'Accept', value: 'image/webp,image/*' }],
      },
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/webp' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(250);
    expect(metadata.height).toBe(Math.round(200 * (250 / 300)));
  });

  test('should not process animated GIFs', async () => {
    const event = createCloudFrontEvent({
      uri: '/animated.gif',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response).toEqual(createCloudFrontEvent().Records[0].cf.response);
  });

  test('should not process a GIF when format=original is specified', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.gif',
      querystring: 'format=original',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response).toEqual(createCloudFrontEvent().Records[0].cf.response);
  });

  test('should preserve original JPEG format when format=original is specified, even with WebP Accept header', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'format=original',
      headers: {
        accept: [{ key: 'Accept', value: 'image/webp,image/*' }],
      },
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toBeDefined();
    expect(response.headers['content-type'][0].value).toBe('image/jpeg');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
  });

  test('should preserve original JPEG format when format=original is specified with resize parameters, even with WebP Accept header', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'width=150&height=100&format=original',
      headers: {
        accept: [{ key: 'Accept', value: 'image/webp,image/*' }],
      },
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toBeDefined();
    expect(response.headers['content-type'][0].value).toBe('image/jpeg');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(150);
    expect(metadata.height).toBe(100);
  });

  test('should force conversion to specific format when explicitly requested', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'format=webp',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/webp' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
  });

  test('should process WebP images as input format', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(300);
  });

  test('should resize WebP images', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      querystring: 'width=200',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(150);
  });

  test('should convert WebP to other formats', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      querystring: 'format=jpeg',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/jpeg' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(300);
  });

  test('should resize and convert WebP images simultaneously', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      querystring: 'width=300&format=png',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toEqual([{ key: 'Content-Type', value: 'image/png' }]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(225);
  });

  describe('with real-world images', () => {
    const WEBP = [{ key: 'Accept', value: 'image/webp,image/*' }];

    test.each([
      {
        name: 'resizes a progressive JPEG',
        key: 'progressive.jpg',
        querystring: 'width=200',
        format: 'jpeg',
        size: [200, 150],
        corners: QUADRANTS,
      },
      {
        name: 'converts a progressive JPEG to WebP',
        key: 'progressive.jpg',
        accept: WEBP,
        format: 'webp',
        size: [400, 300],
        corners: QUADRANTS,
      },
      {
        name: 'resizes a CMYK JPEG to an sRGB JPEG',
        key: 'cmyk.jpg',
        querystring: 'width=200',
        format: 'jpeg',
        size: [200, 150],
        corners: QUADRANTS,
      },
      {
        name: 'converts a CMYK JPEG to WebP',
        key: 'cmyk.jpg',
        accept: WEBP,
        format: 'webp',
        size: [400, 300],
        corners: QUADRANTS,
      },
      {
        name: 'keeps the transparency of a PNG when resizing it',
        key: 'alpha.png',
        querystring: 'width=200',
        format: 'png',
        size: [200, 150],
        corners: {
          topLeft: 'transparent',
          topRight: 'blue',
          bottomLeft: 'transparent',
          bottomRight: 'blue',
        },
      },
      {
        name: 'keeps the transparency of a PNG when converting it to WebP',
        key: 'alpha.png',
        accept: WEBP,
        format: 'webp',
        size: [400, 300],
        corners: {
          topLeft: 'transparent',
          topRight: 'blue',
          bottomLeft: 'transparent',
          bottomRight: 'blue',
        },
      },
      {
        name: 'converts a palette GIF to PNG',
        key: 'static.gif',
        format: 'png',
        size: [400, 300],
        corners: QUADRANTS,
      },
      {
        name: 'converts a palette GIF to WebP',
        key: 'static.gif',
        accept: WEBP,
        format: 'webp',
        size: [400, 300],
        corners: QUADRANTS,
      },
    ])('$name', async ({ key, querystring, accept, format, size, corners }) => {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: `/${key}`, querystring, headers: accept ? { accept } : {} }),
      );

      expect(response.bodyEncoding).toBe('base64');

      const image = Buffer.from(response.body, 'base64');
      const metadata = await sharp(image).metadata();

      expect(metadata.format).toBe(format);
      expect(metadata.space).toBe('srgb');
      expect([metadata.width, metadata.height]).toEqual(size);
      expect(await coloursAtCorners(image)).toEqual(corners);
    });

    // Known bug: the handler never calls rotate(), so the EXIF orientation is dropped and portrait
    // photos are served sideways. Change test.failing to test once the bug is fixed.
    test.failing('serves an EXIF-rotated JPEG upright', async () => {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: '/exif-rotated.jpg', querystring: 'width=150' }),
      );
      const image = Buffer.from(response.body, 'base64');
      const metadata = await sharp(image).metadata();

      expect([metadata.width, metadata.height]).toEqual([150, 200]);
      expect(await coloursAtCorners(image)).toEqual(QUADRANTS);
    });

    // Known bug: only animated GIFs skip processing, so animated WebP images are served as their
    // first frame. Change test.failing to test once the bug is fixed.
    test.failing('keeps every frame of an animated WebP', async () => {
      const response = await invokeHandler(createCloudFrontEvent({ uri: '/animated.webp' }));

      if (undefined === response.body) {
        return;
      }

      const metadata = await sharp(Buffer.from(response.body, 'base64')).metadata();

      expect(metadata.pages).toBe(5);
    });
  });
});
