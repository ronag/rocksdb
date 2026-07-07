# Prerequisites

Building from source needs `git`, `cmake`, and a C/C++ toolchain. The native
dependencies (abseil, re2, zstd) are downloaded and built automatically — see
[scripts/build-deps.js](scripts/build-deps.js).

# Installing from source

`npm install` / `yarn install` uses a matching prebuild when one exists. When
none does, it builds the dependencies and the addon from source automatically
(into a temp dir that is removed afterward — nothing is left on the machine).
Nothing extra to run.

# Generating prebuilds

## Linux

- `./build.sh`

Builds a Zen 3-tuned prebuild inside Docker (see [Dockerfile](Dockerfile)) and
extracts it to `prebuilds/linux-x64`. Uses the local Docker daemon; point
`DOCKER_HOST=ssh://user@host` at a remote amd64 host to avoid emulation on
Apple Silicon (`release.sh` does this by default).

## macOS

- `npm run build-deps`
- `JOBS=16 npx prebuildify -t "$(sed -n 's/^FROM node:\([0-9.]*\).*/\1/p' Dockerfile)" --napi --strip --arch arm64`

The `-t` target is the node version from the Dockerfile's `FROM` line, so both
platforms' prebuilds stay on the same ABI (release.sh derives it the same way).

`build-deps` builds abseil/re2/zstd into `deps/.prefix/darwin-arm64` (portable
tuning) so the prebuild can link them statically — the resulting addon has no
runtime dependency on a Homebrew install.

# Releasing

`npm run release` ([release.sh](release.sh)) generates both platforms' prebuilds,
then prompts for a version bump and publishes.
