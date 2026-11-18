#!/usr/bin/env bash
#
# Builds ymir-image-processing.zip and runs the integration tests against it in the AWS Lambda
# Node.js 22 image, so they cover the shipped binaries and the runtime's own AWS SDK. The
# function reads its images from the tests' fake S3 server on the host.

set -euo pipefail

cd "$(dirname "$0")/.."

image="public.ecr.aws/lambda/nodejs:22"
function_port="${FUNCTION_PORT:-9000}"
s3_port="${FAKE_S3_PORT:-9001}"
task_dir="$(mktemp -d)"
container=""

cleanup() {
  status=$?

  if [ -n "$container" ]; then
    if [ "$status" -ne 0 ]; then
      echo "Function logs:"
      docker logs "$container" 2>&1 | tail -50
    fi

    docker rm -f "$container" >/dev/null
  fi

  rm -rf "$task_dir"
}
trap cleanup EXIT

npm run build-zip
unzip -q ymir-image-processing.zip -d "$task_dir"

docker run --rm --platform linux/amd64 -v "$task_dir:/var/task:ro" --entrypoint node "$image" -e "
  require('/var/task/node_modules/sharp');

  if (!Object.keys(require.cache).some((path) => path.includes('/@img/sharp-linux-x64/'))) {
    console.error('sharp did not load its native linux-x64 binary');
    process.exit(1);
  }
"

# The SDK only sends path-style requests, which the fake S3 server expects, to an IP endpoint.
host_ip="$(docker run --rm --platform linux/amd64 --add-host host.docker.internal:host-gateway --entrypoint getent "$image" ahostsv4 host.docker.internal | awk 'NR == 1 { print $1 }')"

container="$(docker run -d --platform linux/amd64 -p "$function_port:8080" -v "$task_dir:/var/task:ro" \
  -e AWS_ENDPOINT_URL_S3="http://$host_ip:$s3_port" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test \
  "$image" index.handler)"

for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:$function_port" && break
  sleep 1
done

IMAGE_PROCESSING_FUNCTION_URL="http://localhost:$function_port/2015-03-31/functions/function/invocations" \
  FAKE_S3_PORT="$s3_port" npx jest --testTimeout=30000 tests/image-processing-integration.test.js
