'use strict';

const handler = require('../index').handler;
const { createCloudFrontEvent, ensureFixturesDirectory } = require('./utils');

describe('Image Processing Lambda Function', () => {
    describe('Main handler function', () => {
        test('handler exists', () => {
            expect(typeof handler).toBe('function');
        });
        
        test('should return unchanged response for non-200 status', async () => {
            const event = createCloudFrontEvent({ status: '404' });
            const callback = jest.fn();
            
            await handler(event, {}, callback);
            
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(null, event.Records[0].cf.response);
        });

        test('should return unchanged response for missing S3 origin', async () => {
            const event = createCloudFrontEvent();
            delete event.Records[0].cf.request.origin;
            const callback = jest.fn();
            
            await handler(event, {}, callback);
            
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(null, event.Records[0].cf.response);
        });

        test('should return unchanged response for invalid S3 domain', async () => {
            const event = createCloudFrontEvent();
            event.Records[0].cf.request.origin.s3.domainName = 'invalid-domain';
            const callback = jest.fn();
            
            await handler(event, {}, callback);
            
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(null, event.Records[0].cf.response);
        });
    });
});
