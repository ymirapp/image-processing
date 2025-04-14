'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Creates CloudFront event data for testing.
 *
 * @param {Object} options Configuration options
 * @return {Object} CloudFront event data
 */
function createCloudFrontEvent(options = {}) {
  const bucket = options.bucket || 'test-bucket';
  const headers = options.headers || {};
  const querystring = options.querystring || '';
  const region = options.region || 'us-east-1';
  const status = options.status || '200';
  const uri = options.uri || '/test-image.jpg';

  return {
    Records: [
      {
        cf: {
          request: {
            uri,
            querystring,
            headers,
            origin: {
              s3: {
                domainName: `${bucket}.s3.${region}.amazonaws.com`,
                authMethod: 'none',
                path: '',
                port: 443,
                protocol: 'https',
                region: region,
              },
            },
          },
          response: {
            status,
            statusDescription: 'OK',
            headers: {
              'content-type': [
                {
                  key: 'Content-Type',
                  value: 'image/jpeg',
                },
              ],
            },
          },
        },
      },
    ],
  };
}

/**
 * Ensures fixtures directory exists.
 */
function ensureFixturesDirectory() {
  const fixturesDir = path.join(__dirname, 'fixtures');

  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  return fixturesDir;
}

module.exports = {
  createCloudFrontEvent,
  ensureFixturesDirectory,
};
