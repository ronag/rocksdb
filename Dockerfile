# Build on the Node 26 Debian Bookworm image. The binding and bundled RocksDB
# both target C++20, which Bookworm's GCC 12 supports. Its glibc 2.36 /
# libstdc++ (GCC 12) symbols are the ABI baseline the generic npm prebuild
# targets, enforced by scripts/check-linux-prebuild.js.
FROM node:26.4.0-bookworm@sha256:6000864d78f7f7e4f1a832c014fc7ff50dc95c60c665c7b722281e3dc5b58dfd AS build

# Bookworm's CMake 3.25 already satisfies RE2's 3.22 minimum, so the distro
# package is used directly instead of a pinned upstream tarball.
RUN apt-get update && apt-get install -y \
  build-essential \
  ccache \
  cmake \
  git \
  python3 \
  curl \
  ca-certificates \
  make \
  libssl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /rocks-level

# JOBS caps every build stage's parallelism (cmake --parallel, make -j,
# node-gyp) — the rocksdb translation units are memory-heavy, so lower it
# (docker build --build-arg JOBS=4) if the build OOMs, e.g. under x86
# emulation on an arm64 host.
ARG JOBS=8

# Linux prebuilds target the x86-64-v3 microarchitecture level by default.
# build.sh forwards an explicitly set ROCKS_LEVEL_MARCH so private builds can
# select another CPU or use an empty value for a portable x86-64 artifact.
ARG ROCKS_LEVEL_MARCH=x86-64-v3

# Route every compiler invocation (cmake for the deps, node-gyp for the addon)
# through ccache. Debian's ccache package ships masquerade symlinks in
# /usr/lib/ccache; prepending it to PATH transparently caches gcc/g++/cc/c++.
# The cache lives on a BuildKit cache mount at CCACHE_DIR. build.sh uploads a
# project-local seed and downloads the updated cache after each release build.
ENV PATH="/usr/lib/ccache:${PATH}"
ENV CCACHE_DIR=/ccache
ENV CCACHE_MAXSIZE=2G

# The build scripts (build-deps.js / install.js) add their own ccache layer for
# local dev builds. Disable it here: this image already routes cc/g++ through
# ccache via the PATH masquerade above, and a second layer would invoke
# "ccache ccache gcc", which ccache rejects as a recursive invocation.
ENV ROCKS_LEVEL_CCACHE=0

# Build abseil/re2/zstd before copying package metadata so the expensive native
# dependency layer survives both source edits and package-only changes. These
# scripts use only Node built-ins; npm dependencies are installed afterward for
# the addon build.
COPY scripts/build-deps.js scripts/deps-prefix.js ./scripts/
RUN --mount=type=cache,target=/ccache,id=rocks-level-ccache,sharing=locked \
    --mount=type=bind,from=ccache,target=/ccache-seed,ro \
    cp -an /ccache-seed/. /ccache/ 2>/dev/null || true; \
    ROCKS_LEVEL_MARCH="$ROCKS_LEVEL_MARCH" JOBS="$JOBS" node scripts/build-deps.js

COPY package.json ./
# @nxtedition/slice is a private npm package, so npm needs registry auth to
# install it. The npmrc is provided as a BuildKit secret (see build.sh) mounted
# at npm's user-config path, keeping the token out of every image layer. It is
# optional so public/local builds that already have the package cached still run.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm install --ignore-scripts

COPY . .

# Exercise the real forced-source install path on Bookworm, so npm consumers
# and prebuild generation cannot take different paths.
RUN --mount=type=cache,target=/ccache,id=rocks-level-ccache,sharing=locked \
    --mount=type=bind,from=ccache,target=/ccache-seed,ro \
    cp -an /ccache-seed/. /ccache/ 2>/dev/null || true; \
    ROCKS_LEVEL_MARCH="$ROCKS_LEVEL_MARCH" JOBS="$JOBS" MAKEFLAGS="-j$JOBS" \
    npm_config_build_from_source=true node scripts/install.js

# The addon uses the stable Node-API and node-gyp built it for this image's
# x64 runtime. Install the stripped output under prebuildify's generic Node-API
# name without compiling the same source tree a second time.
RUN mkdir -p prebuilds/linux-x64 \
  && cp build/Release/leveldown.node prebuilds/linux-x64/@nxtedition+rocksdb.node \
  && strip prebuilds/linux-x64/@nxtedition+rocksdb.node --strip-all

# Reject accidental toolchain ABI drift before an artifact can leave the
# image. The checker also verifies that dependency tuning matches the build
# argument, preventing a cached prefix with different tuning from being reused.
RUN ROCKS_LEVEL_MARCH="$ROCKS_LEVEL_MARCH" node scripts/check-linux-prebuild.js

# test-prebuild sets PREBUILDS_ONLY=1, which node-gyp-build's loader honors: it
# skips build/Release and loads the addon from prebuilds/, so the tests exercise
# the shipped binary.
RUN npm run test-prebuild

# Export only the validated release artifact. build.sh uses BuildKit's local
# exporter, avoiding a temporary daemon container and its lifetime hazards.
FROM scratch AS artifact
COPY --from=build /rocks-level/prebuilds/linux-x64/@nxtedition+rocksdb.node /@nxtedition+rocksdb.node

# Dump the compiler cache so build.sh can download it to the local project.
# Cache-mount contents live in the builder, not in any layer, so a RUN must
# copy them into a normal path before a scratch stage can export them. This
# reuses the fully cached `build` stage, so only the copy below runs.
FROM build AS ccache-dump
RUN --mount=type=cache,target=/ccache,id=rocks-level-ccache,sharing=locked \
    mkdir -p /ccache-out && cp -a /ccache/. /ccache-out/ 2>/dev/null || true

FROM scratch AS ccache-artifact
COPY --from=ccache-dump /ccache-out /
