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
publication. As in `nxtedition/lib`, `npm run typecheck` uses the no-emit
`tsconfig.json`, while `npm run build` cleans `lib/` and emits with
`tsconfig.build.json`. TypeScript and rimraf remain development dependencies;
npm installs both dependency sets before running `prepare` for Git installs.
`npm test` runs typechecking and a clean build before executing the test suite.

# Generating prebuilds

## Linux

- `./build.sh`

Builds an `x86-64-v3`-tuned x86-64 prebuild inside Docker (see
[Dockerfile](Dockerfile)) and exports it to `prebuilds/linux-x64`. This requires
Docker with BuildKit's `type=local` output support; `build.sh` enables BuildKit
explicitly and exports the final scratch artifact stage without creating a
temporary container. The build image is based on the official Node 26 Bookworm
variant. The Linux binding uses the same C++20 language level as the bundled
RocksDB, which GCC 12 supports. The build rejects artifacts that require symbols
newer than Bookworm's glibc/libstdc++ ABI.

Uses the local Docker daemon; point `DOCKER_HOST=ssh://user@host` at a remote
amd64 host to avoid emulation on Apple Silicon. `ROCKS_LEVEL_MARCH` defaults to
the GCC/Clang microarchitecture level `x86-64-v3` (AVX2/BMI2/FMA, i.e. Haswell
and Zen 1 or newer) and can be overridden:

- `ROCKS_LEVEL_MARCH=znver3 ./build.sh`
- `ROCKS_LEVEL_MARCH= ./build.sh` for a portable x86-64 artifact

`release.sh` ignores caller overrides and uses the `x86-64-v3` default for Linux,
then clears the variable so the Darwin arm64 build remains portable.

To keep repeated releases fast, the Docker build routes every compiler
invocation through `ccache` on a BuildKit cache mount. `build.sh` uploads the
gitignored project-local `.cache/ccache` directory to the active builder before
building, then downloads the updated cache into that directory afterward. The
cache therefore survives image rebuilds and `docker builder prune`, remains on
the local machine when `DOCKER_HOST` points at a remote builder, and can seed
any other builder used from the same checkout. Downloading is best-effort and
never fails a release. Override the location with `ROCKS_LEVEL_CCACHE_DIR`.

The base image digest, RocksDB submodule and native dependency commits are
pinned, and the resulting ABI and CPU baseline are checked. This is not a
byte-for-byte reproducible build: Bookworm packages still resolve through
mutable `apt` repositories, and this package has no tracked npm lockfile, so
`npm install` resolves an unpinned dependency graph.

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
