'use strict';

/**
 * Unit Tests for Image Processing Lambda Function
 *
 * This file focuses on unit testing specific behaviors of the image processing
 * functionality using mocks, emphasizing:
 *
 * - Edge cases (invalid parameters, extreme values)
 * - Error handling (S3 errors, oversized images)
 * - Parameter validation
 * - Content type handling
 *
 * These tests run quickly with minimal dependencies as they don't perform actual
 * image transformations. They complement the integration tests by validating the
 * decision-making logic and error handling without the overhead of processing real images.
 */

const { createCloudFrontEvent } = require('./utils');

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
    return {
        S3Client: jest.fn().mockImplementation(() => ({
            send: mockS3Send
        })),
        GetObjectCommand: jest.fn().mockImplementation((params) => ({
            ...params,
            constructor: { name: 'GetObjectCommand' }
        }))
    };
});

jest.mock('sharp', () => {
    const mockSharp = jest.fn().mockReturnValue({
        resize: jest.fn().mockReturnThis(),
        webp: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('test-buffer'))
    });
    
    mockSharp.fit = {
        cover: 'cover',
        inside: 'inside'
    };
    
    return mockSharp;
});

jest.mock('animated-gif-detector', () => {
    return jest.fn().mockImplementation((buffer) => {
        return buffer._isAnimated === true;
    });
});

describe('Image Processing Unit Tests', () => {
    const jpegBuffer = Buffer.from('fake-jpeg-data');
    const gifBuffer = Buffer.from('fake-gif-data');
    const animatedGifBuffer = Object.assign(Buffer.from('animated-gif-data'), { _isAnimated: true });
    
    let sharp;
    let handler;
    
    beforeEach(() => {
        jest.clearAllMocks();
        
        mockS3Send.mockResolvedValue({
            ContentType: 'image/jpeg',
            Body: {
                [Symbol.asyncIterator]: async function* () {
                    yield jpegBuffer;
                }
            }
        });
        
        sharp = require('sharp');
        handler = require('../index').handler;
    });
    
    test('should handle invalid query parameters gracefully', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'width=invalid&height=NaN',
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(sharp().resize).toHaveBeenCalledWith({
            width: null,
            height: null,
            fit: 'inside',
            withoutEnlargement: true,
        });
    });
    
    test('should clamp quality parameters to valid ranges', async () => {
        const highQualityEvent = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'quality=999',
            headers: {
                'accept': [{ key: 'Accept', value: 'image/webp' }]
            },
        });
        
        const callback1 = jest.fn();
        await handler(highQualityEvent, {}, callback1);
        expect(sharp().webp).toHaveBeenCalledWith({ quality: 100 });
        
        jest.clearAllMocks();
        
        const lowQualityEvent = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'quality=-50',
            headers: {
                'accept': [{ key: 'Accept', value: 'image/webp' }]
            },
        });
        
        const callback2 = jest.fn();
        await handler(lowQualityEvent, {}, callback2);
        expect(sharp().webp).toHaveBeenCalledWith({ quality: 0 });
    });
    
    test('should skip processing for animated GIFs', async () => {
        mockS3Send.mockResolvedValueOnce({
            ContentType: 'image/gif',
            Body: {
                [Symbol.asyncIterator]: async function* () {
                    yield animatedGifBuffer;
                }
            }
        });
        
        const event = createCloudFrontEvent({ uri: '/animated.gif' });
        const originalResponse = event.Records[0].cf.response;
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });
    
    test('should skip processing for unsupported content types', async () => {
        mockS3Send.mockResolvedValueOnce({
            ContentType: 'application/pdf',
            Body: {
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from('pdf-data');
                }
            }
        });
        
        const event = createCloudFrontEvent({ uri: '/document.pdf' });
        const originalResponse = event.Records[0].cf.response;
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });
    
    test('should handle S3 errors gracefully', async () => {
        mockS3Send.mockRejectedValueOnce(new Error('S3 Error'));
        
        const event = createCloudFrontEvent({ uri: '/test-image.jpg' });
        const callback = jest.fn();
        
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
        
        await handler(event, {}, callback);
        
        expect(consoleLogSpy).toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        
        consoleLogSpy.mockRestore();
    });
    
    test('should return original response if resulting image is too large', async () => {
        const largeBuffer = Buffer.alloc(1400000, 'a'); // Create a buffer larger than 1330000 bytes
        
        sharp().toBuffer.mockResolvedValueOnce(largeBuffer);
        
        const event = createCloudFrontEvent({ uri: '/large-image.jpg' });
        const originalResponse = event.Records[0].cf.response;
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });
    
    test('should handle malformed S3 domain names', async () => {
        const event = createCloudFrontEvent();
        event.Records[0].cf.request.origin.s3.domainName = 'invalid-domain-format';
        const originalResponse = event.Records[0].cf.response;
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });
    
    test('should set correct content-type header for different transformations', async () => {
        const webpEvent = createCloudFrontEvent({
            uri: '/test-image.jpg',
            headers: {
                'accept': [{ key: 'Accept', value: 'image/webp' }]
            }
        });
        
        const callback1 = jest.fn();
        await handler(webpEvent, {}, callback1);
        
        expect(callback1.mock.calls[0][1].headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/webp' }
        ]);
        
        jest.clearAllMocks();
        
        mockS3Send.mockResolvedValueOnce({
            ContentType: 'image/gif',
            Body: {
                [Symbol.asyncIterator]: async function* () {
                    yield gifBuffer;
                }
            }
        });
        
        const gifEvent = createCloudFrontEvent({ uri: '/image.gif' });
        const callback2 = jest.fn();
        
        await handler(gifEvent, {}, callback2);
        
        expect(callback2.mock.calls[0][1].headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/png' }
        ]);
    });
    
    test('should not process when no content type is returned from S3', async () => {
        mockS3Send.mockResolvedValueOnce({
            Body: {
                [Symbol.asyncIterator]: async function* () {
                    yield jpegBuffer;
                }
            }
        });
        
        const event = createCloudFrontEvent({ uri: '/test-image.jpg' });
        const originalResponse = event.Records[0].cf.response;
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, originalResponse);
    });
});
