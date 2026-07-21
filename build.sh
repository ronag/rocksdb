#!/bin/bash
set -euo pipefail

# The published prebuild targets x86-64 (Zen 3 by default), so the build must
# use linux/amd64 even on arm64 hosts (e.g. Apple Silicon under emulation).
PLATFORM=linux/amd64
TARGET_DIR=prebuilds/linux-x64
# Persistent client-side ccache location. BuildKit uploads it to whichever
# builder is active and downloads the updated cache after a successful build,
# so switching between local and remote Docker hosts keeps the build warm.
CCACHE_LOCAL_DIR="${ROCKS_LEVEL_CCACHE_DIR:-.cache/ccache}"
STAGE_DIR=
BACKUP_ROOT=
BACKUP_DIR=
COMMITTED=0
HAD_TARGET=0

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  HAD_TARGET=1
fi

cleanup_resources() {
  local cleanup_status=0
  local preserve_backup=0

  if [ -n "$STAGE_DIR" ]; then
    if rm -rf "$STAGE_DIR"; then
      STAGE_DIR=
    else
      cleanup_status=1
    fi
  fi

  if [ -n "$BACKUP_DIR" ] && { [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; }; then
    if [ "$COMMITTED" -eq 1 ]; then
      :
    else
      if { [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; } && ! rm -rf "$TARGET_DIR"; then
        preserve_backup=1
      elif ! mv "$BACKUP_DIR" "$TARGET_DIR"; then
        preserve_backup=1
      fi
    fi
  fi

  if [ "$preserve_backup" -eq 1 ]; then
    echo "Could not restore the prior Linux prebuild; preserved it at $BACKUP_DIR." >&2
    cleanup_status=1
  elif [ -n "$BACKUP_ROOT" ]; then
    if rm -rf "$BACKUP_ROOT"; then
      BACKUP_ROOT=
      BACKUP_DIR=
    else
      cleanup_status=1
    fi
  fi

  # If there was no prior platform, a failed mv or signal can arrive after the
  # candidate rename but before COMMITTED is set. Remove that uncommitted target.
  if [ "$COMMITTED" -eq 0 ] && [ "$HAD_TARGET" -eq 0 ] && \
      { [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; }; then
    if ! rm -rf "$TARGET_DIR"; then
      echo "Could not remove the uncommitted Linux prebuild at $TARGET_DIR; remove it manually." >&2
      cleanup_status=1
    fi
  fi

  return "$cleanup_status"
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if ! cleanup_resources && [ "$status" -eq 0 ]; then
    status=1
  fi
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Initializing submodules..."
git submodule update --init

# BuildKit's local exporter writes the scratch artifact stage directly into a
# same-filesystem candidate directory. No image or extraction container needs
# to outlive docker build.
mkdir -p prebuilds
STAGE_DIR=$(mktemp -d "prebuilds/.linux-x64.XXXXXX")

# The Dockerfile seeds its ccache mount from this client-side build context, so
# it must exist (empty is fine on the very first build).
mkdir -p "$CCACHE_LOCAL_DIR"

echo "Building and exporting prebuild..."
# JOBS caps build parallelism for the memory-heavy rocksdb compile (default 8,
# see Dockerfile). Lower it (e.g. JOBS=4 ./build.sh) on a memory-constrained
# Docker host. The Dockerfile defaults ROCKS_LEVEL_MARCH to znver3; an explicitly
# set value overrides it, including an empty value for a portable x86-64 build.
BUILD_ARGS=(
  --platform "$PLATFORM"
  --target artifact
  --output "type=local,dest=$STAGE_DIR"
  --build-context "ccache=$CCACHE_LOCAL_DIR"
)
if [ -n "${JOBS:-}" ]; then
  BUILD_ARGS+=(--build-arg "JOBS=$JOBS")
fi
if [ "${ROCKS_LEVEL_MARCH+x}" = x ]; then
  BUILD_ARGS+=(--build-arg "ROCKS_LEVEL_MARCH=$ROCKS_LEVEL_MARCH")
fi
DOCKER_BUILDKIT=1 docker build "${BUILD_ARGS[@]}" .

EXPECTED_PREBUILD="$STAGE_DIR/@nxtedition+rocksdb.node"
EXTRACTED_ENTRIES=$(find "$STAGE_DIR" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
if [ ! -f "$EXPECTED_PREBUILD" ] || [ -L "$EXPECTED_PREBUILD" ] || [ "$EXTRACTED_ENTRIES" -ne 1 ]; then
  echo "Expected exactly one Linux prebuild named @nxtedition+rocksdb.node." >&2
  exit 1
fi
chmod 0755 "$STAGE_DIR"

# Preserve the prior known-good platform until the validated candidate is
# installed. The backup child does not exist until the target rename succeeds.
if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  BACKUP_ROOT=$(mktemp -d "prebuilds/.linux-x64-backup.XXXXXX")
  BACKUP_DIR="$BACKUP_ROOT/linux-x64"
  mv "$TARGET_DIR" "$BACKUP_DIR"
fi

if ! mv "$STAGE_DIR" "$TARGET_DIR"; then
  echo "Could not install the staged Linux prebuild." >&2
  exit 1
fi
COMMITTED=1
STAGE_DIR=

echo "Cleaning up..."
if ! cleanup_resources; then
  trap - EXIT INT TERM
  exit 1
fi
trap - EXIT INT TERM

# Download the Docker builder's updated compiler cache into the project. This
# is a pure optimization for the next release, so it must never fail a release
# whose artifact is already built, validated, and installed above.
echo "Downloading compiler cache to $CCACHE_LOCAL_DIR..."
CCACHE_DOWNLOAD_DIR=$(mktemp -d "$(dirname "$CCACHE_LOCAL_DIR")/.ccache-download.XXXXXX") || CCACHE_DOWNLOAD_DIR=
if [ -n "$CCACHE_DOWNLOAD_DIR" ]; then
  if DOCKER_BUILDKIT=1 docker build \
    --platform "$PLATFORM" \
    --target ccache-artifact \
    --build-context "ccache=$CCACHE_LOCAL_DIR" \
    --output "type=local,dest=$CCACHE_DOWNLOAD_DIR" \
    . \
    && cp -a "$CCACHE_DOWNLOAD_DIR/." "$CCACHE_LOCAL_DIR/"; then
    :
  else
    echo "Warning: could not download compiler cache to $CCACHE_LOCAL_DIR; continuing." >&2
  fi
  rm -rf "$CCACHE_DOWNLOAD_DIR"
else
  echo "Warning: could not create a local compiler cache download directory; continuing." >&2
fi

echo "All done!"
