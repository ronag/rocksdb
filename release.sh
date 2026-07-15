#!/bin/bash
set -e

cd "$(dirname "$0")"

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
BRANCH=$(git rev-parse --abbrev-ref HEAD)
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

# Never let private CPU tuning leak into either public artifact. Exporting the
# empty value here also covers every dependency build below, including Darwin
# when the release shell started with ROCKS_LEVEL_MARCH set.
export ROCKS_LEVEL_MARCH=

echo "Building linux prebuilds (docker)..."
# build.sh still supports explicit tuned builds outside the release flow.
./build.sh

echo "Building darwin-arm64 prebuilds (node $NODE_TARGET)..."
# The local mac prebuild links re2/abseil/zstd statically, so build them into
# deps/.prefix/darwin-arm64 first with portable tuning. Generate into a staging
# directory and atomically install only the validated known platform, preserving
# the previous artifact if generation or installation fails.
npm run build-deps
JOBS=16 ./scripts/build-darwin-prebuild.sh "$NODE_TARGET"

echo "Checking release prebuild manifest..."
# Validate both the working tree and npm's exact dry-run pack list. Extra
# platform directories or native files abort before versioning or publishing.
node scripts/check-release-prebuilds.js

read -r -p "Version bump (patch/minor/major): " BUMP
case "$BUMP" in
  patch | minor | major) ;;
  *)
    echo "Invalid bump: '$BUMP' (expected patch, minor or major)" >&2
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
