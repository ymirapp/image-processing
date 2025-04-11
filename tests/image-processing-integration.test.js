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

describe('Image Processing Integration', () => {
    const fixturesDir = ensureFixturesDirectory();
    let handler;
    
    beforeAll(async () => {
        await sharp({
            create: {
                width: 300,
                height: 200,
                channels: 3,
                background: { r: 255, g: 0, b: 0 }
            }
        })
        .jpeg()
        .toFile(path.join(fixturesDir, 'test-image.jpg'));
        
        await sharp({
            create: {
                width: 200,
                height: 200,
                channels: 3,
                background: { r: 0, g: 255, b: 0 }
            }
        })
        .gif()
        .toFile(path.join(fixturesDir, 'test-image.gif'));
    });
    
    beforeEach(() => {
        jest.resetModules();
        
        mockS3Send.mockImplementation(async (command) => {
            if (command.constructor.name === 'GetObjectCommand') {
                const key = command.Key;
                if (key === 'test-image.jpg') {
                    return {
                        ContentType: 'image/jpeg',
                        Body: {
                            [Symbol.asyncIterator]: async function* () {
                                yield fs.readFileSync(path.join(fixturesDir, 'test-image.jpg'));
                            }
                        }
                    };
                } else if (key === 'test-image.gif') {
                    return {
                        ContentType: 'image/gif',
                        Body: {
                            [Symbol.asyncIterator]: async function* () {
                                yield fs.readFileSync(path.join(fixturesDir, 'test-image.gif'));
                            }
                        }
                    };
                } else if (key === 'animated.gif') {
                    return {
                        ContentType: 'image/gif',
                        Body: {
                            [Symbol.asyncIterator]: async function* () {
                                yield fs.readFileSync(path.join(fixturesDir, 'animated.gif'));
                            }
                        }
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
        const event = createCloudFrontEvent({ uri: '/test-image.jpg' });
        
        let responseResult;
        const callback = jest.fn((error, response) => {
            responseResult = response;
        });
        
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, expect.any(Object));
        
        const response = callback.mock.calls[0][1];
        
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
            querystring: 'width=150'
        });
        
        const callback = jest.fn();
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, expect.any(Object));
        
        const response = callback.mock.calls[0][1];
        
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
                'accept': [{ key: 'Accept', value: 'image/webp,image/*' }]
            }
        });
        
        const callback = jest.fn();
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, expect.any(Object));
        
        const response = callback.mock.calls[0][1];
        
        expect(response.status).toBe('200');
        expect(response.bodyEncoding).toBe('base64');
        
        expect(response.headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/webp' }
        ]);
        
        const responseBuffer = Buffer.from(response.body, 'base64');
        const metadata = await sharp(responseBuffer).metadata();
        
        expect(metadata.format).toBe('webp');
        expect(metadata.width).toBe(300);
        expect(metadata.height).toBe(200);
    });
    
    test('should convert GIF to PNG format', async () => {
        const event = createCloudFrontEvent({ 
            uri: '/test-image.gif'
        });
        
        const callback = jest.fn();
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null, expect.any(Object));
        
        const response = callback.mock.calls[0][1];
        
        expect(response.status).toBe('200');
        expect(response.bodyEncoding).toBe('base64');
        
        expect(response.headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/png' }
        ]);
        
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
                'accept': [{ key: 'Accept', value: 'image/webp,image/*' }]
            }
        });
        
        const callback = jest.fn();
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        
        const response = callback.mock.calls[0][1];
        
        expect(response.headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/webp' }
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
                'accept': [{ key: 'Accept', value: 'image/webp,image/*' }]
            },
        });
        
        const callback = jest.fn();
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
        
        const response = callback.mock.calls[0][1];
        
        expect(response.headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/webp' }
        ]);
        
        const responseBuffer = Buffer.from(response.body, 'base64');
        const metadata = await sharp(responseBuffer).metadata();
        
        expect(metadata.format).toBe('webp');
        expect(metadata.width).toBe(250);
        expect(metadata.height).toBe(Math.round(200 * (250/300)));
    });
    
    test('should not process animated GIFs', async () => {
        const event = createCloudFrontEvent({ uri: '/animated.gif' });
        const originalResponse = event.Records[0].cf.response;
        
        const callback = jest.fn();
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);

        expect(callback.mock.calls[0][1]).toBe(originalResponse);
        expect(callback.mock.calls[0][1].bodyEncoding).toBeUndefined();
    });
});
