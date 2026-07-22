#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: build-darwin-prebuild.sh <node-version>" >&2
  exit 64
fi

cd "$(dirname "$0")/.."

PLATFORM=darwin-arm64
ADDON=@nxtedition+rocksdb.node
TARGET_DIR="prebuilds/$PLATFORM"
DEPS_PREFIX="$PWD/deps/.prefix/$PLATFORM"
OUT_DIR=
CANDIDATE_DIR=
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
    echo "Could not restore the prior Darwin prebuild; preserved it at $BACKUP_DIR." >&2
    cleanup_status=1
  elif [ -n "$BACKUP_ROOT" ]; then
    if rm -rf "$BACKUP_ROOT"; then
      BACKUP_ROOT=
      BACKUP_DIR=
    else
      cleanup_status=1
    fi
  fi

  # If there was no prior platform, an interrupt can arrive after the candidate
  # rename returns but before COMMITTED is set. Remove that uncommitted target
  # so a failed command never appears to have installed a release artifact.
  if [ "$COMMITTED" -eq 0 ] && [ "$HAD_TARGET" -eq 0 ] && \
      { [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; }; then
    if ! rm -rf "$TARGET_DIR"; then
      echo "Could not remove the uncommitted Darwin prebuild at $TARGET_DIR; remove it manually." >&2
      cleanup_status=1
    fi
  fi

  if [ -n "$OUT_DIR" ]; then
    if rm -rf "$OUT_DIR"; then
      OUT_DIR=
    else
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

mkdir -p prebuilds
OUT_DIR=$(mktemp -d "prebuilds/.$PLATFORM-out.XXXXXX")
CANDIDATE_DIR="$OUT_DIR/prebuilds/$PLATFORM"

# prebuildify writes <out>/prebuilds/<platform>-<arch>. Keeping the output root
# below prebuilds ensures the candidate and destination live on one filesystem.
# Pin the matching persistent dependency prefix just like scripts/prebuildify.js
# so a caller's temporary ROCKS_LEVEL_DEPS_PREFIX cannot contaminate a release.
BUILD_ENV=(GYP_DEFINES= ROCKS_LEVEL_DEPS_PREFIX="$DEPS_PREFIX" JOBS="${JOBS:-16}")
# Cache the rocksdb + binding.cc compile across release rebuilds when ccache is
# available (matches scripts/build-deps.js); ROCKS_LEVEL_CCACHE=0 opts out.
if [ "${ROCKS_LEVEL_CCACHE:-}" != "0" ] && command -v ccache >/dev/null 2>&1; then
  BUILD_ENV+=(CC="ccache ${CC:-cc}" CXX="ccache ${CXX:-c++}")
fi
env "${BUILD_ENV[@]}" \
  npx prebuildify -t "$1" --napi --strip --arch arm64 --out "$OUT_DIR"

EXPECTED_PREBUILD="$CANDIDATE_DIR/$ADDON"
if [ ! -d "$CANDIDATE_DIR" ]; then
  echo "Expected prebuildify to create $CANDIDATE_DIR." >&2
  exit 1
fi

EXTRACTED_ENTRIES=$(find "$CANDIDATE_DIR" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
if [ ! -f "$EXPECTED_PREBUILD" ] || [ -L "$EXPECTED_PREBUILD" ] || [ "$EXTRACTED_ENTRIES" -ne 1 ]; then
  echo "Expected exactly one Darwin prebuild named $ADDON." >&2
  exit 1
fi

# Preserve the prior known-good platform until a complete candidate has been
# generated and validated. The EXIT/INT/TERM cleanup restores this backup if
# either rename fails or the installation is interrupted before it commits.
if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  BACKUP_ROOT=$(mktemp -d "prebuilds/.$PLATFORM-backup.XXXXXX")
  BACKUP_DIR="$BACKUP_ROOT/$PLATFORM"
  mv "$TARGET_DIR" "$BACKUP_DIR"
fi

if ! mv "$CANDIDATE_DIR" "$TARGET_DIR"; then
  echo "Could not install the staged Darwin prebuild." >&2
  exit 1
fi

# Test while rollback is still armed. PREBUILDS_ONLY prevents a future package
# script change from falling back to build/Release at this transaction boundary.
PREBUILDS_ONLY=1 npm run test-prebuild
COMMITTED=1

if ! cleanup_resources; then
  trap - EXIT INT TERM
  exit 1
fi
trap - EXIT INT TERM
