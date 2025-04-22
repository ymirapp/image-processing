'use strict';

const handler = require('../index').handler;
const { createCloudFrontEvent } = require('./utils');

describe('Image Processing Lambda Function', () => {
  describe('Main handler function', () => {
    test('handler exists', () => {
      expect(typeof handler).toBe('function');
    });

    test('should correctly identify invalid CloudFront requests - missing origin', async () => {
      const invalidEvent = createCloudFrontEvent();
      delete invalidEvent.Records[0].cf.request.origin;

      const originalResponse = invalidEvent.Records[0].cf.response;
      const response = await handler(invalidEvent);

      expect(response).toBe(originalResponse);
    });

    test('should correctly identify invalid CloudFront requests - missing s3 origin', async () => {
      const invalidEvent = createCloudFrontEvent();
      invalidEvent.Records[0].cf.request.origin = { custom: {} };

      const originalResponse = invalidEvent.Records[0].cf.response;
      const response = await handler(invalidEvent);

      expect(response).toBe(originalResponse);
    });

    test('should correctly identify invalid CloudFront requests - missing domain name', async () => {
      const invalidEvent = createCloudFrontEvent();
      delete invalidEvent.Records[0].cf.request.origin.s3.domainName;

      const originalResponse = invalidEvent.Records[0].cf.response;
      const response = await handler(invalidEvent);

      expect(response).toBe(originalResponse);
    });

    test('should correctly identify invalid CloudFront requests - invalid S3 domain', async () => {
      const event = createCloudFrontEvent();
      event.Records[0].cf.request.origin.s3.domainName = 'invalid-domain';
      const originalResponse = event.Records[0].cf.response;

      const response = await handler(event);

      expect(response).toBe(originalResponse);
    });

    test('should return unchanged response for non-200 status', async () => {
      const event = createCloudFrontEvent({ status: '404' });
      const originalResponse = event.Records[0].cf.response;

      const response = await handler(event);

      expect(response).toBe(originalResponse);
    });
  });
});
