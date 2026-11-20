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

const crypto = require('crypto');
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
  'photo.jpg': 'image/jpeg',
  'photo.webp': 'image/webp',
  'progressive.jpg': 'image/jpeg',
  'static.gif': 'image/gif',
};

const QUADRANTS = { topLeft: 'red', topRight: 'green', bottomLeft: 'blue', bottomRight: 'white' };

const ACCEPT_WEBP = [{ key: 'Accept', value: 'image/webp,image/*' }];

/**
 * Reads a file from the fixtures directory.
 *
 * @param {string} name File name
 * @return {Buffer} File contents
 */
function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name));
}

/**
 * Creates the CloudFront response the function receives, which it returns when it leaves the
 * image unchanged.
 *
 * @return {Object} CloudFront response
 */
function originalResponse() {
  return createCloudFrontEvent().Records[0].cf.response;
}

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
      fakeS3.putObject(key, contentType, readFixture(key));
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

  test.each([
    { name: 'a non-image content type', contentType: 'text/css' },
    { name: 'a missing content type', contentType: null },
  ])('returns the origin response without fetching from S3 for $name', async ({ contentType }) => {
    const event = createCloudFrontEvent({ uri: '/test-image.jpg', contentType });
    const response = await invokeHandler(event);

    expect(response).toEqual(event.Records[0].cf.response);
    expect(fakeS3.requests).toEqual([]);
  });

  test('reuses its S3 connection across invocations', async () => {
    const connections = fakeS3.connections();

    await invokeHandler(
      createCloudFrontEvent({ uri: '/test-image.jpg', querystring: 'width=100' }),
    );
    await invokeHandler(createCloudFrontEvent({ uri: '/test-image.jpg', querystring: 'width=50' }));

    expect(fakeS3.requests).toHaveLength(2);
    expect(fakeS3.connections() - connections).toBeLessThanOrEqual(1);
  });

  test('should fetch the object for a URL-encoded key', async () => {
    fakeS3.putObject('my photos/café.jpg', 'image/jpeg', readFixture('progressive.jpg'));

    const response = await invokeHandler(
      createCloudFrontEvent({ uri: '/my%20photos/caf%C3%A9.jpg', querystring: 'width=200' }),
    );
    const metadata = await sharp(Buffer.from(response.body, 'base64')).metadata();

    expect(fakeS3.requests.map((request) => request.key)).toEqual(['my photos/café.jpg']);
    expect([metadata.width, metadata.height]).toEqual([200, 150]);
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
      querystring: 'width=100',
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
    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(100);
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

    expect(response).toEqual(originalResponse());
  });

  test('should not process a GIF when format=original is specified', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.gif',
      querystring: 'format=original',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await invokeHandler(event);

    expect(response).toEqual(originalResponse());
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

    expect(response).toEqual(originalResponse());
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

    expect(response.headers).toEqual(originalResponse().headers);

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
        accept: ACCEPT_WEBP,
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
        accept: ACCEPT_WEBP,
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
        accept: ACCEPT_WEBP,
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
        querystring: 'width=200',
        format: 'png',
        size: [200, 150],
        corners: QUADRANTS,
      },
      {
        name: 'converts a palette GIF to WebP',
        key: 'static.gif',
        accept: ACCEPT_WEBP,
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

    test('serves an EXIF-rotated JPEG upright', async () => {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: '/exif-rotated.jpg', querystring: 'width=150' }),
      );
      const image = Buffer.from(response.body, 'base64');
      const metadata = await sharp(image).metadata();

      expect([metadata.width, metadata.height]).toEqual([150, 200]);
      expect(await coloursAtCorners(image)).toEqual(QUADRANTS);
    });

    test('returns an animated WebP unchanged', async () => {
      const response = await invokeHandler(createCloudFrontEvent({ uri: '/animated.webp' }));

      expect(response).toEqual(originalResponse());
    });
  });

  describe('resizing', () => {
    test.each([
      { name: 'resizes to a height', querystring: 'height=150', size: [200, 150] },
      {
        name: 'fits the image inside a width and height',
        querystring: 'height=100&width=100',
        size: [100, 75],
      },
      {
        name: 'crops a WordPress thumbnail to the exact size',
        querystring: 'height=150&width=150&cropped',
        size: [150, 150],
      },
      {
        name: 'crops from the centre',
        querystring: 'height=300&width=100&cropped',
        size: [100, 300],
      },
      { name: 'never enlarges the image', querystring: 'width=1000', size: [400, 300] },
      {
        name: 'ignores dimensions that are not numbers',
        querystring: 'width=abc&height=NaN',
        size: [400, 300],
      },
      { name: 'ignores a width of 0', querystring: 'width=0', size: [400, 300] },
    ])('$name', async ({ querystring, size }) => {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: '/progressive.jpg', querystring }),
      );
      const image = Buffer.from(response.body, 'base64');
      const metadata = await sharp(image).metadata();

      expect(metadata.format).toBe('jpeg');
      expect([metadata.width, metadata.height]).toEqual(size);
      expect(await coloursAtCorners(image)).toEqual(QUADRANTS);
    });
  });

  describe('output format', () => {
    test.each([
      {
        name: 'converts to JPEG with format=jpg',
        key: 'static.gif',
        querystring: 'format=jpg',
        format: 'jpeg',
        contentType: 'image/jpeg',
      },
      {
        name: 'accepts an uppercase format',
        key: 'progressive.jpg',
        querystring: 'format=PNG',
        format: 'png',
        contentType: 'image/png',
      },
      {
        name: 'converts to WebP with format=webp without a WebP Accept header',
        key: 'static.gif',
        querystring: 'format=webp',
        format: 'webp',
        contentType: 'image/webp',
      },
      {
        name: 'negotiates WebP with format=auto',
        key: 'progressive.jpg',
        querystring: 'format=auto',
        accept: ACCEPT_WEBP,
        format: 'webp',
        contentType: 'image/webp',
      },
      {
        name: 'keeps the format when the Accept header has no WebP',
        key: 'progressive.jpg',
        accept: [{ key: 'Accept', value: 'image/avif,image/*' }],
        format: 'jpeg',
        contentType: null,
      },
      {
        name: 'negotiates WebP when the format is unknown',
        key: 'progressive.jpg',
        querystring: 'format=tiff',
        accept: ACCEPT_WEBP,
        format: 'webp',
        contentType: 'image/webp',
      },
      {
        name: 'keeps the format when the format is unknown',
        key: 'progressive.jpg',
        querystring: 'format=tiff',
        format: 'jpeg',
        contentType: null,
      },
    ])('$name', async ({ key, querystring, accept, format, contentType }) => {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: `/${key}`, querystring, headers: accept ? { accept } : {} }),
      );
      const image = Buffer.from(response.body, 'base64');

      expect((await sharp(image).metadata()).format).toBe(format);
      expect(await coloursAtCorners(image)).toEqual(QUADRANTS);
      expect(response.headers).toEqual(
        contentType
          ? { 'content-type': [{ key: 'Content-Type', value: contentType }] }
          : originalResponse().headers,
      );
    });
  });

  describe('quality', () => {
    /**
     * Requests an image with the given query string and Accept header.
     *
     * @param {string} key Key of the image
     * @param {string} querystring Query string of the request
     * @param {Array|undefined} accept Accept header of the request
     * @return {Promise<Object>} The image the function returned and its format
     */
    async function requestImage(key, querystring, accept) {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: `/${key}`, querystring, headers: accept ? { accept } : {} }),
      );
      const image = Buffer.from(response.body, 'base64');

      return { image, format: (await sharp(image).metadata()).format };
    }

    test.each([
      { name: 'negotiated WebP', key: 'photo.jpg', accept: ACCEPT_WEBP, format: 'webp' },
      { name: 'a JPEG kept as JPEG', key: 'photo.jpg', format: 'jpeg' },
      { name: 'a WebP kept as WebP', key: 'photo.webp', format: 'webp' },
      { name: 'format=webp', key: 'photo.jpg', params: 'format=webp', format: 'webp' },
      { name: 'format=jpg', key: 'photo.webp', params: 'format=jpg', format: 'jpeg' },
      {
        name: 'format=original',
        key: 'photo.jpg',
        params: 'format=original',
        accept: ACCEPT_WEBP,
        format: 'jpeg',
      },
    ])('encodes $name at the requested quality', async ({ key, params, accept, format }) => {
      const prefix = params ? `${params}&` : '';
      const low = await requestImage(key, `${prefix}quality=10`, accept);
      const high = await requestImage(key, `${prefix}quality=90`, accept);

      expect([low.format, high.format]).toEqual([format, format]);
      expect(low.image.length).toBeLessThan(high.image.length);
    });

    test('defaults negotiated WebP to quality 82 when the quality is missing, 0 or not a number', async () => {
      const expected = (await requestImage('photo.jpg', 'quality=82', ACCEPT_WEBP)).image;

      for (const querystring of ['', 'quality=0', 'quality=abc']) {
        const { image } = await requestImage('photo.jpg', querystring, ACCEPT_WEBP);

        expect(Buffer.compare(image, expected)).toBe(0);
      }
    });

    test('keeps the JPEG encoder default when the quality is 0 or not a number', async () => {
      const expected = (await requestImage('photo.jpg', '')).image;

      for (const querystring of ['quality=0', 'quality=abc']) {
        const { image } = await requestImage('photo.jpg', querystring);

        expect(Buffer.compare(image, expected)).toBe(0);
      }
    });

    test('caps the quality at 100', async () => {
      const expected = (await requestImage('photo.jpg', 'quality=100', ACCEPT_WEBP)).image;
      const { image } = await requestImage('photo.jpg', 'quality=999', ACCEPT_WEBP);

      expect(Buffer.compare(image, expected)).toBe(0);
    });

    test('raises a negative quality to the lowest quality', async () => {
      const expected = (await requestImage('photo.jpg', 'quality=1', ACCEPT_WEBP)).image;
      const { image } = await requestImage('photo.jpg', 'quality=-50', ACCEPT_WEBP);

      expect(Buffer.compare(image, expected)).toBe(0);
    });
  });

  describe('when re-encoding at the same size does not make the image smaller', () => {
    beforeAll(async () => {
      fakeS3.putObject(
        'palette.png',
        'image/png',
        await sharp(readFixture('photo.jpg')).png({ palette: true }).toBuffer(),
      );
    });

    test.each([
      { name: 'a palette PNG that re-encodes bigger', key: 'palette.png' },
      { name: 'a JPEG already at the default quality', key: 'test-image.jpg' },
      { name: 'a WebP already at the default quality', key: 'test-image.webp' },
    ])('returns the original response for $name', async ({ key }) => {
      const response = await invokeHandler(createCloudFrontEvent({ uri: `/${key}` }));

      expect(response).toEqual(originalResponse());
    });

    test.each([
      { name: 'an explicit format', querystring: 'format=png', format: 'png' },
      { name: 'an explicit quality', querystring: 'format=original&quality=100', format: 'png' },
      { name: 'a resize', querystring: 'width=200', format: 'png' },
    ])('still encodes the image for $name', async ({ querystring, format }) => {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: '/palette.png', querystring }),
      );

      expect(response.bodyEncoding).toBe('base64');
      expect((await sharp(Buffer.from(response.body, 'base64')).metadata()).format).toBe(format);
    });
  });

  describe('when the image cannot be processed', () => {
    beforeAll(async () => {
      const progressive = readFixture('progressive.jpg');

      fakeS3.putObject('document.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
      fakeS3.putObject('no-content-type.jpg', undefined, progressive);
      fakeS3.putObject('corrupt.jpg', 'image/jpeg', Buffer.from('not an image'));
      fakeS3.putObject('image.svg', 'image/png', readFixture('image.svg'));
      fakeS3.putObject('image.avif', 'image/webp', readFixture('image.avif'));
      fakeS3.putObject('image.tiff', 'image/jpeg', readFixture('image.tiff'));
      fakeS3.putObject(
        'noise.png',
        'image/png',
        await sharp(crypto.randomBytes(1000 * 1000 * 3), {
          raw: { width: 1000, height: 1000, channels: 3 },
        })
          .png()
          .toBuffer(),
      );
    });

    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test.each([
      { name: 'an unsupported content type', key: 'document.pdf' },
      { name: 'a missing content type', key: 'no-content-type.jpg' },
      { name: 'a corrupt image', key: 'corrupt.jpg' },
      { name: 'an SVG stored as a PNG', key: 'image.svg' },
      { name: 'an AVIF stored as a WebP', key: 'image.avif' },
      { name: 'a TIFF stored as a JPEG', key: 'image.tiff' },
      { name: 'a missing object', key: 'missing.jpg' },
      { name: 'an output too large for a Lambda@Edge response', key: 'noise.png' },
    ])('returns the original response for $name', async ({ key }) => {
      const response = await invokeHandler(createCloudFrontEvent({ uri: `/${key}` }));

      expect(response).toEqual(originalResponse());
    });

    test('processes a large image once resizing makes its output small enough', async () => {
      const response = await invokeHandler(
        createCloudFrontEvent({ uri: '/noise.png', querystring: 'width=300' }),
      );
      const metadata = await sharp(Buffer.from(response.body, 'base64')).metadata();

      expect(metadata.format).toBe('png');
      expect([metadata.width, metadata.height]).toEqual([300, 300]);
    });
  });
});
