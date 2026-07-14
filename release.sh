#!/bin/bash
set -e

cd "$(dirname "$0")"

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

echo "Building linux prebuilds (docker)..."
# build.sh runs the Docker image, which builds its deps (Zen 3-tuned) and the
# prebuild inside the container, then extracts prebuilds/linux-x64.
./build.sh

echo "Building darwin-arm64 prebuilds (node $NODE_TARGET)..."
# The local mac prebuild links re2/abseil/zstd statically, so build them into
# deps/.prefix/darwin-arm64 first (portable/native tuning — Zen 3 is x86-only).
npm run build-deps
JOBS=16 npx prebuildify -t "$NODE_TARGET" --napi --strip --arch arm64

echo "Testing darwin-arm64 prebuilds..."
# PREBUILDS_ONLY makes node-gyp-build fail instead of silently falling back to
# build/Release, proving the artifact that will be published actually loads.
npm run test-prebuild

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
