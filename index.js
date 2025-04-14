'use strict';

const animated = require('animated-gif-detector');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

/**
 * AWS Lambda function that processes images from S3 based on query parameters.
 * Supports resizing, format conversion, and quality adjustments for images.
 *
 * @param {Object} event - Lambda event object containing CloudFront request/response
 * @param {Object} context - Lambda context object
 * @param {Function} callback - Lambda callback function
 * @returns {void}
 */
exports.handler = async (event, context, callback) => {
  try {
    const request = event.Records[0].cf.request;
    const response = event.Records[0].cf.response;

    if ('200' !== response.status || !isCloudFrontRequestValid(request)) {
      return callback(null, response);
    }

    const bucketInfo = extractBucketInfo(request);

    if (!bucketInfo) {
      return callback(null, response);
    }

    const allowedContentTypes = ['image/gif', 'image/jpeg', 'image/png'];
    const key = decodeURIComponent(request.uri.substring(1));
    const objectResponse = await fetchOriginalImageFromS3(bucketInfo, key);

    if (!objectResponse.ContentType || !allowedContentTypes.includes(objectResponse.ContentType)) {
      return callback(null, response);
    }

    const objectBody = await streamToBuffer(objectResponse.Body);
    const params = new URLSearchParams(request.querystring);
    const formatParam = params.get('format');
    const preserveOriginalFormat = formatParam === 'original';

    if (
      'image/gif' === objectResponse.ContentType &&
      (animated(objectBody) || preserveOriginalFormat)
    ) {
      return callback(null, response);
    }

    let contentType = null;
    const image = sharp(objectBody);

    if (!preserveOriginalFormat) {
      contentType = await processImageFormat(image, objectResponse, request, params, formatParam);
    }

    if (params.has('width') || params.has('height')) {
      applyResize(image, params);
    }

    const buffer = await image.toBuffer();
    const responseBody = buffer.toString('base64');

    if (isResponseTooLarge(responseBody)) {
      return callback(null, response);
    }

    if (contentType) {
      response.headers['content-type'] = contentType;
    }

    response.body = responseBody;
    response.bodyEncoding = 'base64';

    callback(null, response);
  } catch (error) {
    console.log(error);
  }
};

/**
 * Checks if the CloudFront request is valid for processing.
 *
 * @param {Object} request - CloudFront request object
 * @returns {boolean} True if processing should be skipped, false otherwise
 */
function isCloudFrontRequestValid(request) {
  return request.origin && request.origin.s3 && request.origin.s3.domainName;
}

/**
 * Extracts the S3 bucket info from the request's origin domain name.
 *
 * @param {Object} request - CloudFront request object
 * @returns {Object|null} The bucket info or null if not valid
 */
function extractBucketInfo(request) {
  const match = request.origin.s3.domainName.match(/([^.]*)\.s3\.([^.]*)\.amazonaws\.com/i);

  return !match ? null : { name: match[1], region: match[2] };
}

/**
 * Fetches the original image from S3.
 *
 * @param {Object} bucketInfo - Object containing bucket name and region
 * @param {string} key - S3 object key
 * @returns {Promise<Object>} Promise resolving to the S3 object
 */
function fetchOriginalImageFromS3(bucketInfo, key) {
  const s3Client = new S3Client({ region: bucketInfo.region });
  const getObjectCommand = new GetObjectCommand({ Bucket: bucketInfo.name, Key: key });

  return s3Client.send(getObjectCommand);
}

/**
 * Processes the image format based on settings and request headers.
 *
 * @param {Object} image - Sharp image object
 * @param {Object} objectResponse - S3 object response
 * @param {Object} request - CloudFront request object
 * @param {URLSearchParams} params - URL query parameters
 * @param {string|null} formatSetting - Format parameter from query string
 * @returns {Array|null} Content-Type header array or null if no change
 */
function processImageFormat(image, objectResponse, request, params, formatSetting) {
  let contentType = null;

  if (formatSetting && formatSetting !== 'auto') {
    return applyExplicitFormat(image, formatSetting);
  }

  if ('image/gif' === objectResponse.ContentType) {
    image.png();
    contentType = [{ key: 'Content-Type', value: 'image/png' }];
  }

  if (request.headers['accept'] && request.headers['accept'][0].value.match('image/webp')) {
    const quality = calculateQuality(params);
    image.webp({ quality });
    contentType = [{ key: 'Content-Type', value: 'image/webp' }];
  }

  return contentType;
}

/**
 * Applies an explicit format to the image based on the format setting.
 *
 * @param {Object} image - Sharp image object
 * @param {string} formatSetting - Format parameter from query string
 * @returns {Array|null} Content-Type header array or null if format is not recognized
 */
function applyExplicitFormat(image, formatSetting) {
  switch (formatSetting.toLowerCase()) {
    case 'webp':
      image.webp();
      return [{ key: 'Content-Type', value: 'image/webp' }];
    case 'png':
      image.png();
      return [{ key: 'Content-Type', value: 'image/png' }];
    case 'jpeg':
    case 'jpg':
      image.jpeg();
      return [{ key: 'Content-Type', value: 'image/jpeg' }];
    default:
      return null;
  }
}

/**
 * Calculates the quality setting for image compression.
 * Defaults to 82 if not specified, and ensures quality is between 0 and 100.
 *
 * @param {URLSearchParams} params - URL query parameters
 * @returns {number} Quality value (0-100)
 */
function calculateQuality(params) {
  const rawQuality = parseInt(params.get('quality'), 10) || 82;
  return Math.round(Math.min(Math.max(rawQuality, 0), 100));
}

/**
 * Applies resize transformations to the image based on query parameters.
 * Supports width, height, and cropping options.
 *
 * @param {Object} image - Sharp image object
 * @param {URLSearchParams} params - URL query parameters
 * @returns {void}
 */
function applyResize(image, params) {
  image.resize({
    width: parseInt(params.get('width'), 10) || null,
    height: parseInt(params.get('height'), 10) || null,
    fit: params.has('cropped') ? sharp.fit.cover : sharp.fit.inside,
    withoutEnlargement: true,
  });
}

/**
 * Checks if the response body is too large to be returned.
 * AWS Lambda has limits on response size.
 *
 * @param {string} responseBody - Base64 encoded response body
 * @returns {boolean} True if response is too large, false otherwise
 */
function isResponseTooLarge(responseBody) {
  return 1330000 < Buffer.byteLength(responseBody);
}

/**
 * Converts a readable stream to a Buffer.
 *
 * @param {ReadableStream} stream - The stream to convert
 * @returns {Promise<Buffer>} Promise resolving to a Buffer containing the stream data
 */
async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}
