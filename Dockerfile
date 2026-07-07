FROM node:26.4.0-trixie

RUN apt-get update && apt-get install -y \
  build-essential \
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

# Copy only what each step needs so the expensive dependency layers survive
# source edits: package.json for npm install, scripts/ for build-deps, and
# the full tree only for the final addon build.
COPY package.json ./
RUN npm install --ignore-scripts

# Build abseil/re2/zstd once into the persistent deps/.prefix so the following
# prebuildify step (a separate node-gyp build) can link against them. Tuned for
# Zen 3 to match the -march=znver3 the gyp files apply to rocksdb + binding.cc,
# so the shipped Linux prebuild is optimized for the deployment servers.
COPY scripts/ scripts/
RUN ROCKS_LEVEL_MARCH=znver3 JOBS=$JOBS npm run build-deps

COPY . .

# prebuildify is a pinned devDependency, so npx resolves the local install
# instead of fetching the latest version from the registry. The ABI target is
# the container's own node (the FROM image), so there is no second version
# string to keep in sync.
RUN JOBS=$JOBS MAKEFLAGS="-j$JOBS" npx prebuildify -t "$(node -p process.versions.node)" --napi --strip --arch x64

# test-prebuild sets PREBUILDS_ONLY=1, which node-gyp-build's loader honors: it
# skips build/Release and loads the addon from prebuilds/, so the tests exercise
# the shipped binary.
RUN npm run test-prebuild
