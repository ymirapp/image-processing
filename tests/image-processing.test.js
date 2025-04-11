'use strict';

const fs = require('fs');
const path = require('path');
const { createCloudFrontEvent, ensureFixturesDirectory } = require('./utils');

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

describe('Image Processing', () => {
    const jpegBuffer = Buffer.from('fake-jpeg-data');
    const pngBuffer = Buffer.from('fake-png-data');
    const gifBuffer = Buffer.from('fake-gif-data');
    const animatedGifBuffer = Buffer.from('animated-gif-data');
    animatedGifBuffer._isAnimated = true;
    
    let sharp;
    let animated;
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
        animated = require('animated-gif-detector');
        handler = require('../index').handler;
    });
    
    test('should process JPEG image without transformation parameters', async () => {
        const event = createCloudFrontEvent({ uri: '/test-image.jpg' });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        
        const response = callback.mock.calls[0][1];
        expect(response.status).toBe('200');
        expect(response.bodyEncoding).toBe('base64');
    });
    
    test('should convert to WebP when Accept header includes webp', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            headers: {
                'accept': [{ key: 'Accept', value: 'image/webp,image/*' }]
            },
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        
        const response = callback.mock.calls[0][1];
        expect(response.status).toBe('200');
        expect(response.headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/webp' }
        ]);

        expect(sharp().webp).toHaveBeenCalled();
    });
    
    test('should resize image with width parameter', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'width=300',
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(sharp().resize).toHaveBeenCalledWith({
            width: 300,
            height: null,
            fit: 'inside',
            withoutEnlargement: true,
        });
    });
    
    test('should resize image with height parameter', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'height=200',
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(sharp().resize).toHaveBeenCalledWith({
            width: null,
            height: 200,
            fit: 'inside',
            withoutEnlargement: true,
        });
    });
    
    test('should resize image with both width and height parameters', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'width=300&height=200',
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(sharp().resize).toHaveBeenCalledWith({
            width: 300,
            height: 200,
            fit: 'inside',
            withoutEnlargement: true,
        });
    });
    
    test('should use cover fit when cropped parameter is present', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'width=300&height=200&cropped',
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(sharp().resize).toHaveBeenCalledWith({
            width: 300,
            height: 200,
            fit: 'cover',
            withoutEnlargement: true,
        });
    });
    
    test('should apply custom quality when parameter is provided', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'quality=50',
            headers: {
                'accept': [{ key: 'Accept', value: 'image/webp,image/*' }]
            },
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(sharp().webp).toHaveBeenCalledWith({ quality: 50 });
    });
    
    test('should clamp quality to 100 for values above 100', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'quality=150',
            headers: {
                'accept': [{ key: 'Accept', value: 'image/webp,image/*' }]
            },
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(sharp().webp).toHaveBeenCalledWith({ quality: 100 });
    });
    
    test('should clamp quality to 0 for negative values', async () => {
        const event = createCloudFrontEvent({
            uri: '/test-image.jpg',
            querystring: 'quality=-10',
            headers: {
                'accept': [{ key: 'Accept', value: 'image/webp,image/*' }]
            },
        });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(sharp().webp).toHaveBeenCalledWith({ quality: 0 });
    });
    
    test('should convert GIF to PNG', async () => {
        mockS3Send.mockResolvedValueOnce({
            ContentType: 'image/gif',
            Body: {
                [Symbol.asyncIterator]: async function* () {
                    yield gifBuffer;
                }
            }
        });
        
        const event = createCloudFrontEvent({ uri: '/test-image.gif' });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][1].headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/png' },
        ]);

        expect(sharp().png).toHaveBeenCalled();
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
        
        const event = createCloudFrontEvent({ uri: '/animated-test.gif' });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][1]).toBe(event.Records[0].cf.response);
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
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][1]).toBe(event.Records[0].cf.response);
    });
    
    test('should return original response if resulting image is too large', async () => {
        const largeBuffer = Buffer.alloc(1400000, 'a');
        
        sharp().toBuffer.mockResolvedValueOnce(largeBuffer);
        
        const event = createCloudFrontEvent({ uri: '/large-image.jpg' });
        const callback = jest.fn();
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][1]).toBe(event.Records[0].cf.response);
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
});
