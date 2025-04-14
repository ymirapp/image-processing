'use strict';

global.mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: global.mockS3Send,
    })),
    GetObjectCommand: jest.fn().mockImplementation((params) => ({
      ...params,
      constructor: { name: 'GetObjectCommand' },
    })),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});
