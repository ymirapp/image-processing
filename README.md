<p align="center">
    <a href="https://ymirapp.com" target="_blank" align="center">
        <img src="https://cdn-std.droplr.net/files/acc_680806/69fc3k" width="280">
    </a>
</p>

# Ymir image processing function

[![Actions Status](https://github.com/ymirapp/image-processing/workflows/Continuous%20Integration/badge.svg)](https://github.com/ymirapp/image-processing/actions)

[Ymir][1] [Lambda@Edge][3] function used by [CloudFront][4] to process and optimize images.

## Installation

Install the depencies using npm:

```
$ npm ci
```

## Building

To build a zip archive of the Lambda function to upload to AWS, you can run the following command:

```
$ npm run build-zip
```

## Links

 * [Documentation][2]

[1]: https://ymirapp.com
[2]: https://docs.ymirapp.com
[3]: https://aws.amazon.com/lambda/edge/
[4]: https://aws.amazon.com/cloudfront/
