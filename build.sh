#!/bin/bash
set -e

# The Dockerfile targets x86-64 explicitly (znver3 march flags, prebuildify
# --arch x64), so the image must be built for linux/amd64 even on arm64 hosts
# (e.g. Apple Silicon), where it runs under emulation. Without this the native
# arm64 gcc rejects -march=znver3 ("unknown value 'znver3'") and the build fails.
PLATFORM=linux/amd64

echo "Initializing submodules..."
git submodule update --init

echo "Building image..."
# JOBS caps build parallelism for the memory-heavy rocksdb compile (default 8,
# see Dockerfile). Lower it (e.g. JOBS=4 ./build.sh) if the build still OOMs on
# a memory-constrained Docker, or raise it on a large host.
docker build --platform "$PLATFORM" ${JOBS:+--build-arg JOBS="$JOBS"} --iidfile prebuilds.iid .

echo "Extracting prebuilds from image..."
IMG=$(cat prebuilds.iid)
ID=$(docker create --platform "$PLATFORM" $IMG)
docker cp "$ID:/rocks-level/prebuilds" ./

echo "Cleaning up..."
docker rm $ID > /dev/null
rm prebuilds.iid

echo "All done!"
