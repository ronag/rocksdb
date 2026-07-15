# Prerequisites

Building from source needs `git`, `cmake`, and a C/C++ toolchain. The native
dependencies (abseil, re2, zstd) are downloaded and built automatically — see
[scripts/build-deps.js](scripts/build-deps.js). The dependency script fetches
audited full commit IDs and verifies each detached checkout before building it.

# Installing from source

`npm install` / `yarn install` uses a matching prebuild when one exists. When
none does, it builds the dependencies and the addon from source automatically
(into a temp dir that is removed afterward — nothing is left on the machine).
Nothing extra to run.

The Node.js runtime is TypeScript in `src/`. The package `prepare` lifecycle
compiles it to the gitignored `lib/` directory during source installs and before
publication. Run `npm run build` directly for a standalone typecheck and build;
`npm test` always rebuilds the runtime before executing the test suite.

# Generating prebuilds

## Linux

- `./build.sh`

Builds a portable x86-64 prebuild inside Docker (see [Dockerfile](Dockerfile))
and exports it to `prebuilds/linux-x64`. This requires Docker with BuildKit's
`type=local` output support; `build.sh` enables BuildKit explicitly and exports
the final scratch artifact stage without creating a temporary container. The
build image is based on the official Node 26 Bullseye variant. The Linux binding
uses the same C++20 language level as the bundled RocksDB, which GCC 10 supports.
The build rejects artifacts that require symbols newer than Bullseye's
glibc/libstdc++ ABI.

GCC 10 lacks one C++20 `using enum` feature used by the vendored RocksDB
header. The RocksDB gyp target generates an exact-match compatibility overlay
that qualifies those three enum values instead, without modifying the vendored
source. This Linux-only action runs for Docker, npm source installs and
prebuildify. Its test and build both fail if the single expected source block
drifts, so an upstream change must be reviewed rather than patched
approximately. Darwin and Windows continue to include the original header.

Uses the local Docker daemon; point `DOCKER_HOST=ssh://user@host` at a remote
amd64 host to avoid emulation on Apple Silicon. CPU tuning remains available
for private, hardware-controlled deployments:

- `ROCKS_LEVEL_MARCH=znver2 ./build.sh`

Do not publish that tuned artifact as the generic npm prebuild. `release.sh`
always clears `ROCKS_LEVEL_MARCH` for its Linux build.

The base image digest, CMake tarball checksum, RocksDB submodule and native
dependency commits are pinned, and the resulting ABI and CPU baseline are
checked. This is not a byte-for-byte reproducible build: Bullseye packages
still resolve through mutable `apt` repositories, and this package has no
tracked npm lockfile, so `npm install` resolves an unpinned dependency graph.

## macOS

- `npm run build-deps`
- `JOBS=16 ./scripts/build-darwin-prebuild.sh "$(sed -n 's/^FROM node:\([0-9.]*\).*/\1/p' Dockerfile)"`

The helper target is the node version from the Dockerfile's `FROM` line, so both
platforms' prebuilds stay on the same ABI (release.sh derives it the same way).
It stages and smoke-tests the Darwin artifact before replacing the prior one.

`build-deps` builds abseil/re2/zstd into `deps/.prefix/darwin-arm64` (portable
tuning) so the prebuild can link them statically — the resulting addon has no
runtime dependency on a Homebrew install.

# Releasing

`npm run release` ([release.sh](release.sh)) generates and smoke-tests both
platforms' prebuilds, then prompts for a version bump and publishes.
