'use strict';

const animated = require('animated-gif-detector');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const s3Client = new S3Client();

exports.handler = async (event, context, callback) => {
  try {
    const request = event.Records[0].cf.request;
    const response = event.Records[0].cf.response;

    if (
      '200' !== response.status ||
      !request.origin ||
      !request.origin.s3 ||
      !request.origin.s3.domainName
    ) {
      return callback(null, response);
    }

    const match = request.origin.s3.domainName.match(/([^.]*)\.s3(\.[^.]*)?\.amazonaws\.com/i);

    if (!match || !match[1] || 'string' !== typeof match[1]) {
      return callback(null, response);
    }

    const allowedContentTypes = ['image/gif', 'image/jpeg', 'image/png'];
    const bucket = match[1];
    const key = decodeURIComponent(request.uri.substring(1));

    const getObjectCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
    const objectResponse = await s3Client.send(getObjectCommand);

    if (
      !objectResponse.ContentType ||
      !allowedContentTypes.includes(objectResponse.ContentType) ||
      ('image/gif' === objectResponse.ContentType &&
        animated(await streamToBuffer(objectResponse.Body)))
    ) {
      return callback(null, response);
    }

    let contentType = null;
    const objectBody = await streamToBuffer(objectResponse.Body);
    const image = sharp(objectBody);
    const params = new URLSearchParams(request.querystring);

    if ('image/gif' === objectResponse.ContentType) {
      image.png();
      contentType = [{ key: 'Content-Type', value: 'image/png' }];
    }

    if (request.headers['accept'] && request.headers['accept'][0].value.match('image/webp')) {
      image.webp({
        quality: Math.round(Math.min(Math.max(parseInt(params.get('quality'), 10) || 82, 0), 100)),
      });
      contentType = [{ key: 'Content-Type', value: 'image/webp' }];
    }

    if (params.has('width') || params.has('height')) {
      image.resize({
        width: parseInt(params.get('width'), 10) || null,
        height: parseInt(params.get('height'), 10) || null,
        fit: params.has('cropped') ? sharp.fit.cover : sharp.fit.inside,
        withoutEnlargement: true,
      });
    }

    const buffer = await image.toBuffer();
    const responseBody = buffer.toString('base64');

    if (1330000 < Buffer.byteLength(responseBody)) {
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

// Helper function to convert a stream to a buffer
async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}
