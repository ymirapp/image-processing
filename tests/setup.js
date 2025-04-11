'use strict';

jest.mock('@aws-sdk/client-s3', () => {
    const mockSend = jest.fn();
    
    return {
        S3Client: jest.fn().mockImplementation(() => ({
            send: mockSend
        })),
        GetObjectCommand: jest.fn().mockImplementation((params) => ({
            ...params,
            __type: 'GetObjectCommand',
        }))
    };
});

beforeEach(() => {
    jest.clearAllMocks();
});
