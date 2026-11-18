'use strict';

const http = require('http');

/**
 * Starts an HTTP server that answers path-style S3 GetObject requests (GET /<bucket>/<key>)
 * from objects stored in memory, and records the bucket, key and signing region of each request.
 *
 * @param {number} port Port to listen on on all interfaces, 0 for a random one
 * @return {Promise<Object>} The running fake S3 server
 */
function startFakeS3(port = 0) {
  const objects = new Map();
  const requests = [];

  const server = http.createServer((request, response) => {
    const [, bucket, ...keyParts] = new URL(request.url, 'http://localhost').pathname.split('/');
    const key = decodeURIComponent(keyParts.join('/'));
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\/s3\//.exec(request.headers.authorization);
    const object = objects.get(key);

    requests.push({ bucket, key, region: region ? region[1] : null });

    if (!object) {
      response.writeHead(404, { 'Content-Type': 'application/xml' });
      response.end('<Error><Code>NoSuchKey</Code></Error>');

      return;
    }

    response.writeHead(200, object.contentType ? { 'Content-Type': object.contentType } : {});
    response.end(object.body);
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        port: server.address().port,
        requests,
        putObject: (key, contentType, body) => objects.set(key, { contentType, body }),
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

module.exports = {
  startFakeS3,
};
