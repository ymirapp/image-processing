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

      const callback = jest.fn();
      const handler = require('../index').handler;
      const originalResponse = invalidEvent.Records[0].cf.response;

      await handler(invalidEvent, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });

    test('should correctly identify invalid CloudFront requests - missing s3 origin', async () => {
      const invalidEvent = createCloudFrontEvent();
      invalidEvent.Records[0].cf.request.origin = { custom: {} };

      const callback = jest.fn();
      const handler = require('../index').handler;
      const originalResponse = invalidEvent.Records[0].cf.response;

      await handler(invalidEvent, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });

    test('should correctly identify invalid CloudFront requests - missing domain name', async () => {
      const invalidEvent = createCloudFrontEvent();
      delete invalidEvent.Records[0].cf.request.origin.s3.domainName;

      const callback = jest.fn();
      const handler = require('../index').handler;
      const originalResponse = invalidEvent.Records[0].cf.response;

      await handler(invalidEvent, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });

    test('should correctly identify invalid CloudFront requests - invalid S3 domain', async () => {
      const event = createCloudFrontEvent();
      event.Records[0].cf.request.origin.s3.domainName = 'invalid-domain';
      const callback = jest.fn();

      await handler(event, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, event.Records[0].cf.response);
    });

    test('should return unchanged response for non-200 status', async () => {
      const event = createCloudFrontEvent({ status: '404' });
      const callback = jest.fn();

      await handler(event, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, event.Records[0].cf.response);
    });
  });
});
