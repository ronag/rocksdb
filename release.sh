#!/bin/bash
set -e

cd "$(dirname "$0")"

# Fail fast: npm version refuses a dirty tree, so check before the slow builds.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean, commit or stash changes first." >&2
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
