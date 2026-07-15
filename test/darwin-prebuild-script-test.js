'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('tape')

const addon = '@nxtedition+rocksdb.node'

function executable (file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fixture () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-darwin-prebuild-'))
  const bin = path.join(root, 'bin')
  const scripts = path.join(root, 'scripts')
  const prebuilds = path.join(root, 'prebuilds')
  const darwin = path.join(prebuilds, 'darwin-arm64')
  const linux = path.join(prebuilds, 'linux-x64')

  fs.mkdirSync(bin)
  fs.mkdirSync(scripts)
  fs.mkdirSync(darwin, { recursive: true })
  fs.mkdirSync(linux)
  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'build-darwin-prebuild.sh'),
    path.join(scripts, 'build-darwin-prebuild.sh')
  )
  fs.chmodSync(path.join(scripts, 'build-darwin-prebuild.sh'), 0o755)
  fs.writeFileSync(path.join(darwin, addon), 'old')
  fs.writeFileSync(path.join(darwin, 'stale.node'), 'stale')
  fs.writeFileSync(path.join(linux, addon), 'linux')

  executable(path.join(bin, 'npx'), `#!/bin/bash
set -euo pipefail
printf 'JOBS=%s ROCKS_LEVEL_DEPS_PREFIX=%s GYP_DEFINES=%s %s\\n' \
  "\${JOBS:-}" "\${ROCKS_LEVEL_DEPS_PREFIX:-}" "\${GYP_DEFINES:-}" "$*" >> "$FAKE_NPX_LOG"
if [ "\${FAKE_PREBUILDIFY_MODE:-success}" = "fail" ]; then
  exit 42
fi
out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    shift
    out=$1
  fi
  shift
done
test -n "$out"
candidate="$out/prebuilds/darwin-arm64"
mkdir -p "$candidate"
printf 'candidate\\n' > "$candidate/${addon}"
if [ "\${FAKE_PREBUILDIFY_MODE:-success}" = "extra" ]; then
  printf 'extra\\n' > "$candidate/extra.node"
fi
`)

  executable(path.join(bin, 'mv'), `#!/bin/bash
set -euo pipefail
phase=
case "$1:$2" in
  prebuilds/darwin-arm64:prebuilds/.darwin-arm64-backup.*/darwin-arm64)
    phase=backup
    ;;
  prebuilds/.darwin-arm64-backup.*/darwin-arm64:prebuilds/darwin-arm64)
    phase=restore
    ;;
  prebuilds/.darwin-arm64-out.*/prebuilds/darwin-arm64:prebuilds/darwin-arm64)
    phase=candidate
    ;;
esac
case "\${FAKE_MV_MODE:-success}:$phase" in
  fail:candidate)
    exit 42
    ;;
  fail-after:candidate|backup-fail-after:backup)
    /bin/mv "$@"
    exit 42
    ;;
  interrupt:candidate|backup-term-after:backup)
    /bin/mv "$@"
    kill -TERM "$PPID"
    exit 143
    ;;
  backup-fail-before:backup)
    exit 42
    ;;
  backup-term-before:backup)
    kill -TERM "$PPID"
    exit 143
    ;;
  restore-fail:candidate)
    /bin/mv "$@"
    exit 42
    ;;
  restore-fail:restore)
    exit 43
    ;;
esac
exec /bin/mv "$@"
`)

  executable(path.join(bin, 'rm'), `#!/bin/bash
set -euo pipefail
target=
for argument in "$@"; do target=$argument; done
if [ "\${FAKE_RM_TARGET_FAIL:-}" = "1" ] && [ "$target" = "prebuilds/darwin-arm64" ]; then
  exit 42
fi
exec /bin/rm "$@"
`)

  executable(path.join(bin, 'npm'), `#!/bin/bash
set -euo pipefail
printf 'PREBUILDS_ONLY=%s %s\n' "\${PREBUILDS_ONLY:-}" "$*" >> "$FAKE_NPM_LOG"
test "$(cat prebuilds/darwin-arm64/${addon})" = candidate
if [ "\${FAKE_NPM_FAIL:-}" = "1" ]; then
  exit 42
fi
`)

  return {
    bin,
    darwin,
    linux,
    log: path.join(root, 'npx.log'),
    npmLog: path.join(root, 'npm.log'),
    prebuilds,
    root
  }
}

function runBuild (context, extraEnv = {}) {
  return spawnSync('/bin/bash', ['scripts/build-darwin-prebuild.sh', '26.4.0'], {
    cwd: context.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_NPX_LOG: context.log,
      FAKE_NPM_LOG: context.npmLog,
      PATH: `${context.bin}${path.delimiter}${process.env.PATH}`
    }
  })
}

function assertOldPlatforms (t, context, message) {
  t.deepEqual(fs.readdirSync(context.darwin).toSorted(), [addon, 'stale.node'].toSorted(), message)
  t.equal(fs.readFileSync(path.join(context.darwin, addon), 'utf8'), 'old')
  t.equal(fs.readFileSync(path.join(context.linux, addon), 'utf8'), 'linux', 'Linux is untouched')
}

function assertNoTemporaryPlatforms (t, context) {
  t.notOk(
    fs.readdirSync(context.prebuilds).some((entry) => entry.startsWith('.darwin-arm64-')),
    'staging and backup directories are removed'
  )
}

test('Darwin prebuild generation stages and atomically replaces only its platform', function (t) {
  const context = fixture()

  try {
    const result = runBuild(context)

    t.equal(result.status, 0, result.stderr || 'Darwin prebuild generation succeeds')
    t.deepEqual(fs.readdirSync(context.darwin), [addon], 'stale Darwin artifacts are removed')
    t.equal(fs.readFileSync(path.join(context.darwin, addon), 'utf8'), 'candidate\n')
    t.equal(fs.readFileSync(path.join(context.linux, addon), 'utf8'), 'linux', 'Linux is untouched')
    t.match(
      fs.readFileSync(context.log, 'utf8'),
      /^JOBS=16 ROCKS_LEVEL_DEPS_PREFIX=.*\/deps\/\.prefix\/darwin-arm64 GYP_DEFINES= prebuildify -t 26\.4\.0 --napi --strip --arch arm64 --out prebuilds\/\.darwin-arm64-out\./,
      'prebuildify writes to a same-filesystem staging root'
    )
    t.equal(
      fs.readFileSync(context.npmLog, 'utf8'),
      'PREBUILDS_ONLY=1 run test-prebuild\n',
      'the installed candidate is smoke-tested before commit'
    )
    assertNoTemporaryPlatforms(t, context)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})

test('Darwin prebuild generation pins its persistent dependency prefix', function (t) {
  const context = fixture()

  try {
    const result = runBuild(context, {
      GYP_DEFINES: 'rocks_level_test_faults=1',
      ROCKS_LEVEL_DEPS_PREFIX: '/tmp/rogue'
    })
    const log = fs.readFileSync(context.log, 'utf8')

    t.equal(result.status, 0, result.stderr || 'Darwin prebuild generation succeeds')
    t.match(
      log,
      /^JOBS=16 ROCKS_LEVEL_DEPS_PREFIX=.*\/deps\/\.prefix\/darwin-arm64 GYP_DEFINES= prebuildify /,
      'prebuildify uses the freshly built persistent prefix'
    )
    t.notOk(/\/tmp\/rogue/.test(log), 'the caller dependency prefix is not forwarded')
    t.notOk(/rocks_level_test_faults=1/.test(log), 'caller GYP definitions are not forwarded')
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})

test('Darwin prebuild generation preserves the old platform on build or validation failure', function (t) {
  for (const [mode, expected] of [
    ['fail', 'prebuildify failure'],
    ['extra', 'invalid candidate manifest']
  ]) {
    const context = fixture()

    try {
      const result = runBuild(context, { FAKE_PREBUILDIFY_MODE: mode })

      t.notEqual(result.status, 0, `${expected} fails the build`)
      assertOldPlatforms(t, context, `${expected} preserves the prior Darwin directory`)
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('Darwin prebuild generation restores the old platform on install failure or interruption', function (t) {
  for (const mode of ['fail', 'interrupt']) {
    const context = fixture()

    try {
      const result = runBuild(context, { FAKE_MV_MODE: mode })

      t.notEqual(result.status, 0, `${mode} does not report success`)
      assertOldPlatforms(t, context, `${mode} restores the prior Darwin directory`)
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('Darwin prebuild generation rolls back an unloadable candidate', function (t) {
  const context = fixture()

  try {
    const result = runBuild(context, { FAKE_NPM_FAIL: '1' })

    t.notEqual(result.status, 0, 'failed candidate smoke test is reported')
    assertOldPlatforms(t, context, 'the prior Darwin directory is restored')
    assertNoTemporaryPlatforms(t, context)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})

test('Darwin prebuild generation preserves the old platform around every backup rename window', function (t) {
  for (const mode of [
    'backup-fail-before',
    'backup-term-before',
    'backup-fail-after',
    'backup-term-after'
  ]) {
    const context = fixture()

    try {
      const result = runBuild(context, { FAKE_MV_MODE: mode })

      t.notEqual(result.status, 0, `${mode} does not report success`)
      assertOldPlatforms(t, context, `${mode} preserves the prior Darwin directory`)
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('failed first Darwin install leaves no uncommitted platform', function (t) {
  for (const mode of ['fail-after', 'interrupt']) {
    const context = fixture()

    try {
      fs.rmSync(context.darwin, { recursive: true })
      const result = runBuild(context, { FAKE_MV_MODE: mode })

      t.notEqual(result.status, 0, `${mode} does not report success`)
      t.notOk(fs.existsSync(context.darwin), `${mode} removes the uncommitted first install`)
      t.equal(fs.readFileSync(path.join(context.linux, addon), 'utf8'), 'linux', 'Linux is untouched')
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('failed first Darwin rollback reports an unremovable candidate', function (t) {
  const context = fixture()

  try {
    fs.rmSync(context.darwin, { recursive: true })
    const result = runBuild(context, {
      FAKE_MV_MODE: 'fail-after',
      FAKE_RM_TARGET_FAIL: '1'
    })

    t.notEqual(result.status, 0, 'cleanup failure does not report success')
    t.equal(
      fs.readFileSync(path.join(context.darwin, addon), 'utf8'),
      'candidate\n',
      'the unremovable candidate remains identifiable'
    )
    t.match(result.stderr, /uncommitted Darwin prebuild at prebuilds\/darwin-arm64; remove it manually/)
    t.notOk(
      fs.readdirSync(context.prebuilds).some((entry) => entry.startsWith('.darwin-arm64-')),
      'staging and backup directories are removed'
    )
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})

test('failed first Darwin smoke test leaves no uncommitted platform', function (t) {
  const context = fixture()

  try {
    fs.rmSync(context.darwin, { recursive: true })
    const result = runBuild(context, { FAKE_NPM_FAIL: '1' })

    t.notEqual(result.status, 0, 'smoke failure does not report success')
    t.notOk(fs.existsSync(context.darwin), 'the unloadable first artifact is removed')
    t.equal(fs.readFileSync(path.join(context.linux, addon), 'utf8'), 'linux', 'Linux is untouched')
    assertNoTemporaryPlatforms(t, context)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})

test('Darwin prebuild generation preserves the recovery backup when restoration fails', function (t) {
  const context = fixture()

  try {
    const result = runBuild(context, { FAKE_MV_MODE: 'restore-fail' })
    const backupRoots = fs.readdirSync(context.prebuilds)
      .filter((entry) => entry.startsWith('.darwin-arm64-backup.'))

    t.notEqual(result.status, 0, 'restore failure does not report success')
    t.notOk(fs.existsSync(context.darwin), 'the rejected candidate is not left as the target')
    t.equal(backupRoots.length, 1, 'one recovery root is preserved')
    t.equal(
      fs.readFileSync(path.join(context.prebuilds, backupRoots[0], 'darwin-arm64', addon), 'utf8'),
      'old',
      'the recovery root contains the prior addon, not the candidate'
    )
    t.match(result.stderr, /preserved it at .*\.darwin-arm64-backup\..*\/darwin-arm64/)
    t.notOk(
      fs.readdirSync(context.prebuilds).some((entry) => entry.startsWith('.darwin-arm64-out.')),
      'the rejected candidate staging root is removed'
    )
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})
