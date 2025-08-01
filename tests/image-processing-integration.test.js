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
const { createCloudFrontEvent, ensureFixturesDirectory } = require('./utils');

describe('Image Processing Integration', () => {
  const fixturesDir = ensureFixturesDirectory();
  let handler;

  beforeAll(async () => {
    await sharp({
      create: {
        width: 300,
        height: 200,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toFile(path.join(fixturesDir, 'test-image.jpg'));

    await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .gif()
      .toFile(path.join(fixturesDir, 'test-image.gif'));

    await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .webp()
      .toFile(path.join(fixturesDir, 'test-image.webp'));
  });

  beforeEach(() => {
    jest.resetModules();

    mockS3Send.mockImplementation((command) => {
      if (command.constructor.name === 'GetObjectCommand') {
        const key = command.Key;
        if (key === 'test-image.jpg') {
          return {
            ContentType: 'image/jpeg',
            Body: {
              [Symbol.asyncIterator]: function* () {
                yield fs.readFileSync(path.join(fixturesDir, 'test-image.jpg'));
              },
            },
          };
        } else if (key === 'test-image.gif') {
          return {
            ContentType: 'image/gif',
            Body: {
              [Symbol.asyncIterator]: function* () {
                yield fs.readFileSync(path.join(fixturesDir, 'test-image.gif'));
              },
            },
          };
        } else if (key === 'test-image.webp') {
          return {
            ContentType: 'image/webp',
            Body: {
              [Symbol.asyncIterator]: function* () {
                yield fs.readFileSync(path.join(fixturesDir, 'test-image.webp'));
              },
            },
          };
        } else if (key === 'animated.gif') {
          return {
            ContentType: 'image/gif',
            Body: {
              [Symbol.asyncIterator]: function* () {
                yield fs.readFileSync(path.join(fixturesDir, 'animated.gif'));
              },
            },
          };
        }
      }
      throw new Error(`Unexpected command or key: ${command.constructor.name}, ${command.Key}`);
    });

    handler = require('../index').handler;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('should process a simple JPEG without transformations', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(200);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should resize JPEG image with width parameter', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'width=150',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(150);
    expect(metadata.height).toBe(100);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
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

    const response = await handler(event);

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

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should convert GIF to PNG format', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.gif',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toEqual([{ key: 'Content-Type', value: 'image/png' }]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(200);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
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

    const response = await handler(event);

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/webp' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(200);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
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

    const response = await handler(event);

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/webp' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(250);
    expect(metadata.height).toBe(Math.round(200 * (250 / 300)));

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should not process animated GIFs', async () => {
    const event = createCloudFrontEvent({
      uri: '/animated.gif',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });
    const originalResponse = event.Records[0].cf.response;

    const response = await handler(event);

    expect(response).toBe(originalResponse);
    expect(response.bodyEncoding).toBeUndefined();

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should not process a GIF when format=original is specified', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.gif',
      querystring: 'format=original',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });
    const originalResponse = event.Records[0].cf.response;

    const response = await handler(event);

    expect(response).toBe(originalResponse);
    expect(response.bodyEncoding).toBeUndefined();

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
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

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toBeDefined();
    expect(response.headers['content-type'][0].value).toBe('image/jpeg');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
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

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toBeDefined();
    expect(response.headers['content-type'][0].value).toBe('image/jpeg');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(150);
    expect(metadata.height).toBe(100);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should force conversion to specific format when explicitly requested', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.jpg',
      querystring: 'format=webp',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

    expect(response.headers['content-type']).toEqual([
      { key: 'Content-Type', value: 'image/webp' },
    ]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should process WebP images as input format', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(300);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should resize WebP images', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      querystring: 'width=200',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(150);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should convert WebP to other formats', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      querystring: 'format=jpeg',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

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

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });

  test('should resize and convert WebP images simultaneously', async () => {
    const event = createCloudFrontEvent({
      uri: '/test-image.webp',
      querystring: 'width=300&format=png',
      region: 'us-west-2',
      bucket: 'my-test-bucket',
    });

    const response = await handler(event);

    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');

    expect(response.headers['content-type']).toEqual([{ key: 'Content-Type', value: 'image/png' }]);

    const responseBuffer = Buffer.from(response.body, 'base64');
    const metadata = await sharp(responseBuffer).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(225);

    expect(lastS3ClientConfiguration.region).toBe('us-west-2');
    expect(lastS3GetObjectCommandInput.Bucket).toBe('my-test-bucket');
  });
});
