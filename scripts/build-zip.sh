#!/usr/bin/env bash
#
# Builds ymir-image-processing.zip from a production install of package-lock.json with the
# linux x64 binaries Lambda@Edge runs, whatever platform the build runs on.

set -euo pipefail

cd "$(dirname "$0")/.."

zip_path="$PWD/ymir-image-processing.zip"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

cp index.js package.json package-lock.json "$build_dir/"
(cd "$build_dir" && npm ci --omit=dev --os=linux --cpu=x64 --ignore-scripts --no-audit --no-fund)

rm -f "$zip_path"
(cd "$build_dir" && zip -qrX "$zip_path" index.js node_modules)

echo "Built $zip_path"
