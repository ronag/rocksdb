#!/bin/bash
set -e

cd "$(dirname "$0")"

export DOCKER_HOST="${DOCKER_HOST:-ssh://nxtop@hq-test-srv1.nxt.io}"

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

echo "Building linux prebuilds (docker)..."
./build.sh

echo "Building darwin-arm64 prebuilds (node $NODE_TARGET)..."
JOBS=16 npx prebuildify -t "$NODE_TARGET" --napi --strip --arch arm64

read -r -p "Version bump (patch/minor/major): " BUMP
case "$BUMP" in
  patch | minor | major) ;;
  *)
    echo "Invalid bump: '$BUMP' (expected patch, minor or major)" >&2
    exit 1
    ;;
esac

npm version "$BUMP"
npm publish

git push
git push --tags

echo "Published $(node -p "require('./package.json').version")."
