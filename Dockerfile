# Build on the oldest official Node 26 Debian image. The binding and bundled
# RocksDB both target C++20, which Bullseye's GCC 10 supports, and the older
# toolchain keeps the generic npm prebuild usable on older Linux distributions.
FROM node:26.4.0-bullseye@sha256:547115894d02507bae039a4eecdc0feb1ce337d7e7dcda5cd19d521bb29da4d3 AS build

RUN apt-get update && apt-get install -y \
  build-essential \
  git \
  python3 \
  curl \
  ca-certificates \
  make \
  libssl-dev \
  && rm -rf /var/lib/apt/lists/*

# Bullseye's CMake 3.18 is older than RE2's 3.22 minimum. Install the pinned
# upstream Kitware binary without changing the distro or runtime ABI baseline.
ARG CMAKE_VERSION=3.22.6
ARG CMAKE_SHA256=09e1b34026c406c5bf4d1b053eadb3a8519cb360e37547ebf4b70ab766d94fbc
RUN curl -fsSL \
    "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-x86_64.tar.gz" \
    -o /tmp/cmake.tar.gz \
  && echo "$CMAKE_SHA256  /tmp/cmake.tar.gz" | sha256sum --check - \
  && tar -xzf /tmp/cmake.tar.gz --strip-components=1 -C /usr/local \
  && rm /tmp/cmake.tar.gz \
  && cmake --version

WORKDIR /rocks-level

# JOBS caps every build stage's parallelism (cmake --parallel, make -j,
# node-gyp) — the rocksdb translation units are memory-heavy, so lower it
# (docker build --build-arg JOBS=4) if the build OOMs, e.g. under x86
# emulation on an arm64 host.
ARG JOBS=8

# Generic npm prebuilds intentionally leave this empty. Private deployments
# can opt into CPU-specific tuning with, for example,
#   ROCKS_LEVEL_MARCH=znver2 ./build.sh
ARG ROCKS_LEVEL_MARCH=

# Build abseil/re2/zstd before copying package metadata so the expensive native
# dependency layer survives both source edits and package-only changes. These
# scripts use only Node built-ins; npm dependencies are installed afterward for
# the addon build.
COPY scripts/build-deps.js scripts/deps-prefix.js ./scripts/
RUN ROCKS_LEVEL_MARCH="$ROCKS_LEVEL_MARCH" JOBS="$JOBS" node scripts/build-deps.js

COPY package.json ./
RUN npm install --ignore-scripts

COPY . .

# Exercise the real forced-source install path on Bullseye. The rocksdb gyp
# target generates its audited GCC 10 compatibility header before compilation,
# so npm consumers and prebuild generation cannot take different paths.
RUN ROCKS_LEVEL_MARCH="$ROCKS_LEVEL_MARCH" JOBS="$JOBS" MAKEFLAGS="-j$JOBS" \
    npm_config_build_from_source=true node scripts/install.js

# The addon uses the stable Node-API and node-gyp built it for this image's
# x64 runtime. Install the stripped output under prebuildify's generic Node-API
# name without compiling the same source tree a second time.
RUN mkdir -p prebuilds/linux-x64 \
  && cp build/Release/leveldown.node prebuilds/linux-x64/@nxtedition+rocksdb.node \
  && strip prebuilds/linux-x64/@nxtedition+rocksdb.node --strip-all

# Reject accidental toolchain ABI drift before an artifact can leave the
# image. The checker also verifies that dependency tuning matches the build
# argument, preventing a cached tuned prefix from masquerading as portable.
RUN ROCKS_LEVEL_MARCH="$ROCKS_LEVEL_MARCH" node scripts/check-linux-prebuild.js

# test-prebuild sets PREBUILDS_ONLY=1, which node-gyp-build's loader honors: it
# skips build/Release and loads the addon from prebuilds/, so the tests exercise
# the shipped binary.
RUN npm run test-prebuild

# Export only the validated release artifact. build.sh uses BuildKit's local
# exporter, avoiding a temporary daemon container and its lifetime hazards.
FROM scratch AS artifact
COPY --from=build /rocks-level/prebuilds/linux-x64/@nxtedition+rocksdb.node /@nxtedition+rocksdb.node
