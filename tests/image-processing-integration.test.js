'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createCloudFrontEvent, ensureFixturesDirectory } = require('./utils');

describe('Image Processing Integration', () => {
    const fixturesDir = ensureFixturesDirectory();
    let handler;
    let mockS3GetObject;
    
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
        
        mockS3GetObject = jest.fn().mockResolvedValue({
            ContentType: 'image/jpeg',
            Body: fs.readFileSync(path.join(fixturesDir, 'test-image.jpg'))
        });
        
        jest.mock('aws-sdk', () => ({
            S3: jest.fn().mockImplementation(() => ({
                getObject: jest.fn().mockImplementation(() => ({
                    promise: mockS3GetObject
                }))
            }))
        }));
        
        jest.mock('animated-gif-detector', () => {
            return jest.fn().mockImplementation((buffer) => {
                return buffer._isAnimated === true;
            });
        });
        
        handler = require('../index').handler;
    });
    
    afterEach(() => {
        jest.unmock('aws-sdk');
        jest.unmock('animated-gif-detector');
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
        mockS3GetObject.mockResolvedValue({
            ContentType: 'image/gif',
            Body: fs.readFileSync(path.join(fixturesDir, 'test-image.gif'))
        });
        
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
        mockS3GetObject.mockResolvedValue({
            ContentType: 'image/jpeg',
            Body: fs.readFileSync(path.join(fixturesDir, 'test-image.jpg'))
        });
        
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
        mockS3GetObject.mockResolvedValue({
            ContentType: 'image/jpeg',
            Body: fs.readFileSync(path.join(fixturesDir, 'test-image.jpg'))
        });
        
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
        const animatedGifBuffer = Buffer.from('test-animated-gif');
        animatedGifBuffer._isAnimated = true;
        
        mockS3GetObject.mockResolvedValue({
            ContentType: 'image/gif',
            Body: animatedGifBuffer
        });
        
        const event = createCloudFrontEvent({ 
            uri: '/animated.gif'
        });
        
        event.Records[0].cf.response.headers['content-type'] = [
            { key: 'Content-Type', value: 'image/gif' }
        ];
        
        const callback = jest.fn();
        await handler(event, {}, callback);
        
        expect(callback).toHaveBeenCalledTimes(1);
    
        const originalResponse = event.Records[0].cf.response;
        const response = callback.mock.calls[0][1];
        
        expect(response).toBe(originalResponse);
        
        expect(response.headers['content-type']).toEqual([
            { key: 'Content-Type', value: 'image/gif' }
        ]);
    });
});
