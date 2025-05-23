'use strict';

global.mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation((configuration) => {
      global.lastS3ClientConfiguration = configuration;

      return {
        send: global.mockS3Send,
      };
    }),
    GetObjectCommand: jest.fn().mockImplementation((params) => {
      global.lastS3GetObjectCommandInput = params;

      return {
        ...params,
        constructor: { name: 'GetObjectCommand' },
      };
    }),
  };
});

beforeEach(() => {
  jest.clearAllMocks();

  global.lastS3ClientConfiguration = null;
  global.lastS3GetObjectCommandInput = null;
});
