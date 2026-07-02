#!/bin/bash
set -e

# The Dockerfile targets x86-64 explicitly (znver3 march flags, prebuildify
# --arch x64), so the image must be built for linux/amd64 even on arm64 hosts
# (e.g. Apple Silicon), where it runs under emulation. Without this the native
# arm64 gcc rejects -march=znver3 ("unknown value 'znver3'") and the build fails.
PLATFORM=linux/amd64

# Build on the remote x86-64 docker host by default (avoids emulation on
# Apple Silicon). Override with DOCKER_HOST=... ./build.sh, or
# DOCKER_HOST= ./build.sh to use the local docker daemon.
export DOCKER_HOST="${DOCKER_HOST-ssh://nxtop@hq-test-srv1.nxt.io}"

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
