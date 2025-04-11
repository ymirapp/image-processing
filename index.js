'use strict';

const animated = require('animated-gif-detector');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const s3Client = new S3Client();

exports.handler = async (event, context, callback) => {
  try {
    const request = event.Records[0].cf.request;
    const response = event.Records[0].cf.response;

    if (shouldSkipProcessing(request, response)) {
      return callback(null, response);
    }

    const bucketDetails = extractBucketDetails(request);

    if (!bucketDetails) {
      return callback(null, response);
    }

    const allowedContentTypes = ['image/gif', 'image/jpeg', 'image/png'];
    const bucket = bucketDetails;
    const key = decodeURIComponent(request.uri.substring(1));
    const params = new URLSearchParams(request.querystring);
    const formatSetting = params.get('format');

    const objectResponse = await fetchOriginalImage(bucket, key);

    if (shouldSkipImageProcessing(objectResponse, allowedContentTypes)) {
      return callback(null, response);
    }

    const isAnimatedGif =
      'image/gif' === objectResponse.ContentType &&
      animated(await streamToBuffer(objectResponse.Body));

    if (isAnimatedGif) {
      return callback(null, response);
    }

    const objectBody = await streamToBuffer(objectResponse.Body);
    const image = sharp(objectBody);
    const preserveOriginalFormat = formatSetting === 'original';

    let contentType = null;

    if (!preserveOriginalFormat) {
      contentType = await processImageFormat(image, objectResponse, request, params, formatSetting);
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

function shouldSkipProcessing(request, response) {
  return (
    '200' !== response.status ||
    !request.origin ||
    !request.origin.s3 ||
    !request.origin.s3.domainName
  );
}

function extractBucketDetails(request) {
  const match = request.origin.s3.domainName.match(/([^.]*)\.s3(\.[^.]*)?\.amazonaws\.com/i);

  if (!match || !match[1] || 'string' !== typeof match[1]) {
    return null;
  }

  return match[1];
}

function fetchOriginalImage(bucket, key) {
  const getObjectCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
  return s3Client.send(getObjectCommand);
}

function shouldSkipImageProcessing(objectResponse, allowedContentTypes) {
  return !objectResponse.ContentType || !allowedContentTypes.includes(objectResponse.ContentType);
}

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

function calculateQuality(params) {
  const rawQuality = parseInt(params.get('quality'), 10) || 82;
  return Math.round(Math.min(Math.max(rawQuality, 0), 100));
}

function applyResize(image, params) {
  image.resize({
    width: parseInt(params.get('width'), 10) || null,
    height: parseInt(params.get('height'), 10) || null,
    fit: params.has('cropped') ? sharp.fit.cover : sharp.fit.inside,
    withoutEnlargement: true,
  });
}

function isResponseTooLarge(responseBody) {
  return 1330000 < Buffer.byteLength(responseBody);
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}
