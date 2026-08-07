#!/bin/bash
set -e

cd "$(dirname "$0")"

# Releases and their tags must originate from the canonical branch.
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != master ] && [ "$BRANCH" != main ]; then
  echo "Releases must be run from master or main (current branch: ${BRANCH:-detached HEAD})." >&2
  exit 1
fi

# Never let an explicit local fault-injection build leak into published
# artifacts. Both dependency and addon builds inherit this shell environment.
export ROCKS_LEVEL_TEST_FAULTS=0

# Fail fast: npm publish needs a valid login, so check before the slow builds.
if ! npm whoami --registry https://registry.npmjs.org > /dev/null 2>&1; then
  echo "Not logged in to npm, run 'npm login' first." >&2
  exit 1
fi

# Fail fast: npm version refuses a dirty tree, so check before the slow builds.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean, commit or stash changes first." >&2
  exit 1
fi

# Fail fast: don't build/publish on a branch that's behind or diverged from origin.
echo "Fetching origin..."
git fetch origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
BASE=$(git merge-base HEAD "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  : # up to date
elif [ "$LOCAL" = "$BASE" ]; then
  echo "Branch '$BRANCH' is behind origin, pull the latest changes first." >&2
  exit 1
elif [ "$REMOTE" = "$BASE" ]; then
  : # local is ahead, fine to push
else
  echo "Branch '$BRANCH' has diverged from origin, reconcile before releasing." >&2
  exit 1
fi

# Keep the local arm64 build targeting the same node version as the Docker image.
NODE_TARGET=$(sed -n 's/^FROM node:\([0-9.]*\).*/\1/p' Dockerfile)
if [ -z "$NODE_TARGET" ]; then
  echo "Could not determine node version from Dockerfile." >&2
  exit 1
fi

# Generate both platforms' prebuilds up front, before any version bump or
# publish, so a build failure aborts the release with nothing changed.

# Ignore caller-specific CPU tuning for the public Linux artifact. With no
# override, build.sh uses the Dockerfile's audited x86-64-v3/znver3 defaults.
unset ROCKS_LEVEL_MARCH
unset ROCKS_LEVEL_MTUNE

# A caller may use ROCKS_LEVEL_DEPS_PREFIX for a one-off source build. Public
# builds must instead use the dependencies created by their pinned build path:
# Linux builds inside Docker, while the Darwin helper explicitly selects the
# persistent deps/.prefix/darwin-arm64 populated below.
unset ROCKS_LEVEL_DEPS_PREFIX

# GYP_DEFINES is a generic caller escape hatch. Public builds accept their
# audited project variables and explicit ROCKS_LEVEL_* inputs only; in
# particular, a caller must not be able to re-enable native test fault hooks.
unset GYP_DEFINES

echo "Building linux prebuilds (docker)..."
./build.sh

echo "Building darwin-arm64 prebuilds (node $NODE_TARGET)..."
# The local mac prebuild links re2/abseil/zstd statically, so build them into
# deps/.prefix/darwin-arm64 first with portable tuning. Generate into a staging
# directory and atomically install only the validated known platform, preserving
# the previous artifact if generation or installation fails.
export ROCKS_LEVEL_MARCH=
export ROCKS_LEVEL_MTUNE=
npm run build-deps
JOBS=16 ./scripts/build-darwin-prebuild.sh "$NODE_TARGET"

echo "Checking release prebuild manifest..."
# Validate both the working tree and npm's exact dry-run pack list. Extra
# platform directories or native files abort before versioning or publishing.
node scripts/check-release-prebuilds.js

# Accept the version bump either as the first argument or interactively. It may
# be a keyword (patch/minor/major) or an explicit semver version (e.g. 1.2.3).
BUMP="$1"
if [ -z "$BUMP" ]; then
  read -r -p "Version bump (patch/minor/major or explicit version): " BUMP
fi
case "$BUMP" in
  patch | minor | major) ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "Invalid version: '$BUMP' (expected patch, minor, major or an explicit version like 1.2.3)" >&2
    exit 1
    ;;
esac

npm version "$BUMP"

# Pin the registry: if the script is invoked via yarn (or an .npmrc override),
# npm_config_registry points at registry.yarnpkg.com where our npmjs auth
# token doesn't apply, and publish fails with ENEEDAUTH.
npm publish --registry https://registry.npmjs.org

git push
git push --tags

echo "Published $(node -p "require('./package.json').version")."
