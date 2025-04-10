'use strict';

const AWS = require('aws-sdk-mock');

beforeEach(() => {
    AWS.restore();
});
