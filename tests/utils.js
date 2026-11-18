'use strict';

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
 * Invokes the image processing function with the given CloudFront event. Calls the handler in
 * this process, or the deployed artifact over HTTP when IMAGE_PROCESSING_FUNCTION_URL is set.
 *
 * @param {Object} event CloudFront event data
 * @return {Promise<Object>} CloudFront response returned by the function
 */
async function invokeHandler(event) {
  const url = process.env.IMAGE_PROCESSING_FUNCTION_URL;

  if (!url) {
    return require('../index').handler(event);
  }

  const response = await fetch(url, { method: 'POST', body: JSON.stringify(event) });

  if (!response.ok) {
    throw new Error(
      `Invoking ${url} failed with status ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
}

module.exports = {
  createCloudFrontEvent,
  invokeHandler,
};
