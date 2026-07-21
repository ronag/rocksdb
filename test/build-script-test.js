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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-build-script-'))
  const bin = path.join(root, 'bin')
  const linux = path.join(root, 'prebuilds', 'linux-x64')
  const darwin = path.join(root, 'prebuilds', 'darwin-arm64')

  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(linux, { recursive: true })
  fs.mkdirSync(darwin, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'build.sh'), path.join(root, 'build.sh'))
  fs.chmodSync(path.join(root, 'build.sh'), 0o755)
  fs.writeFileSync(path.join(linux, addon), 'old')
  fs.writeFileSync(path.join(linux, 'stale.node'), 'stale')
  fs.writeFileSync(path.join(darwin, addon), 'darwin')

  executable(path.join(bin, 'git'), '#!/bin/bash\nexit 0\n')
  executable(path.join(bin, 'mv'), `#!/bin/bash
set -euo pipefail
phase=
case "$1:$2" in
  prebuilds/linux-x64:prebuilds/.linux-x64-backup.*/linux-x64)
    phase=backup
    ;;
  prebuilds/.linux-x64-backup.*/linux-x64:prebuilds/linux-x64)
    phase=restore
    ;;
  prebuilds/.linux-x64.*:prebuilds/linux-x64)
    phase=candidate
    ;;
esac
case "\${FAKE_MV_MODE:-success}:$phase" in
  backup-fail-before:backup)
    exit 42
    ;;
  backup-term-before:backup)
    kill -TERM "$PPID"
    exit 143
    ;;
  backup-fail-after:backup|candidate-fail-after:candidate)
    /bin/mv "$@"
    exit 42
    ;;
  backup-term-after:backup|candidate-term-after:candidate)
    /bin/mv "$@"
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
if [ "\${FAKE_RM_TARGET_FAIL:-}" = "1" ] && [ "$target" = "prebuilds/linux-x64" ]; then
  exit 42
fi
exec /bin/rm "$@"
`)
  executable(path.join(bin, 'docker'), `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
test "$1" = build
shift
target=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      shift
      target=$1
      ;;
    --output)
      shift
      output=$1
      ;;
  esac
  shift
done
test "$target" = artifact
case "$output" in
  type=local,dest=*) destination=\${output#type=local,dest=} ;;
  *) exit 64 ;;
esac
test -d "$destination"

case "\${FAKE_DOCKER_BUILD_MODE:-success}" in
  fail-before-output)
    exit 42
    ;;
  missing)
    ;;
  symlink)
    ln -s "$FAKE_DOCKER_LOG" "$destination/${addon}"
    ;;
  extra)
    printf 'candidate\n' > "$destination/${addon}"
    printf 'extra\n' > "$destination/extra.node"
    ;;
  *)
    printf 'candidate\n' > "$destination/${addon}"
    ;;
esac

case "\${FAKE_DOCKER_BUILD_MODE:-success}" in
  fail-after-output)
    exit 42
    ;;
  term-after-output)
    kill -TERM "$PPID"
    exit 143
    ;;
esac
`)

  return { bin, darwin, linux, root }
}

function runBuild (context, extraEnv = {}) {
  const log = path.join(context.root, 'docker.log')
  const result = spawnSync('/bin/bash', ['./build.sh'], {
    cwd: context.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_DOCKER_LOG: log,
      PATH: `${context.bin}${path.delimiter}${process.env.PATH}`
    }
  })

  return { log: fs.readFileSync(log, 'utf8'), result }
}

function assertOldPlatforms (t, context, message) {
  t.deepEqual(fs.readdirSync(context.linux).toSorted(), [addon, 'stale.node'].toSorted(), message)
  t.equal(fs.readFileSync(path.join(context.linux, addon), 'utf8'), 'old')
  t.equal(fs.readFileSync(path.join(context.darwin, addon), 'utf8'), 'darwin', 'Darwin is untouched')
}

function assertNoTemporaryPlatforms (t, context) {
  t.notOk(
    fs.readdirSync(path.join(context.root, 'prebuilds')).some((entry) => entry.startsWith('.linux-x64')),
    'staging and backup directories are removed'
  )
}

test('build script exports and atomically installs only the Linux artifact', function (t) {
  const context = fixture()

  try {
    const { log, result } = runBuild(context)

    t.equal(result.status, 0, result.stderr || 'build script succeeds')
    t.match(
      log,
      /build --platform linux\/amd64 --target artifact --output type=local,dest=prebuilds\/\.linux-x64\./,
      'Docker exports the scratch artifact directly into staging'
    )
    t.deepEqual(fs.readdirSync(context.linux), [addon], 'stale Linux artifacts are removed')
    t.equal(fs.readFileSync(path.join(context.linux, addon), 'utf8'), 'candidate\n')
    t.equal(fs.statSync(context.linux).mode & 0o777, 0o755, 'installed platform is traversable')
    t.equal(fs.readFileSync(path.join(context.darwin, addon), 'utf8'), 'darwin', 'Darwin is untouched')
    assertNoTemporaryPlatforms(t, context)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})

test('build script preserves explicit CPU tuning overrides, including portable builds', function (t) {
  for (const [march, expected] of [
    ['znver2', '--build-arg ROCKS_LEVEL_MARCH=znver2'],
    ['', '--build-arg ROCKS_LEVEL_MARCH= ']
  ]) {
    const context = fixture()

    try {
      const { log, result } = runBuild(context, { ROCKS_LEVEL_MARCH: march })

      t.equal(result.status, 0, result.stderr || `build with ${JSON.stringify(march)} succeeds`)
      t.ok(log.includes(expected), `forwards ${JSON.stringify(march)} to Docker`)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('build script preserves the old platform on build failure or interruption', function (t) {
  for (const mode of ['fail-before-output', 'fail-after-output', 'term-after-output']) {
    const context = fixture()

    try {
      const { result } = runBuild(context, { FAKE_DOCKER_BUILD_MODE: mode })

      t.notEqual(result.status, 0, `${mode} does not report success`)
      assertOldPlatforms(t, context, `${mode} preserves the prior Linux directory`)
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('build script rejects invalid exported artifact manifests', function (t) {
  for (const mode of ['missing', 'symlink', 'extra']) {
    const context = fixture()

    try {
      const { result } = runBuild(context, { FAKE_DOCKER_BUILD_MODE: mode })

      t.notEqual(result.status, 0, `${mode} artifact fails validation`)
      assertOldPlatforms(t, context, `${mode} preserves the prior Linux directory`)
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('build script preserves the old platform around every backup rename window', function (t) {
  for (const mode of [
    'backup-fail-before',
    'backup-term-before',
    'backup-fail-after',
    'backup-term-after'
  ]) {
    const context = fixture()

    try {
      const { result } = runBuild(context, { FAKE_MV_MODE: mode })

      t.notEqual(result.status, 0, `${mode} does not report success`)
      assertOldPlatforms(t, context, `${mode} preserves the prior Linux directory`)
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('build script rolls back post-candidate-rename errors and signals', function (t) {
  for (const mode of ['candidate-fail-after', 'candidate-term-after']) {
    const context = fixture()

    try {
      const { result } = runBuild(context, { FAKE_MV_MODE: mode })

      t.notEqual(result.status, 0, `${mode} does not report success`)
      assertOldPlatforms(t, context, `${mode} restores the prior Linux directory`)
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('failed first Linux install removes a post-rename candidate', function (t) {
  for (const mode of ['candidate-fail-after', 'candidate-term-after']) {
    const context = fixture()

    try {
      fs.rmSync(context.linux, { recursive: true })
      const { result } = runBuild(context, { FAKE_MV_MODE: mode })

      t.notEqual(result.status, 0, `${mode} does not report success`)
      t.notOk(fs.existsSync(context.linux), `${mode} removes the uncommitted first install`)
      t.equal(fs.readFileSync(path.join(context.darwin, addon), 'utf8'), 'darwin', 'Darwin is untouched')
      assertNoTemporaryPlatforms(t, context)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }

  t.end()
})

test('failed first Linux rollback reports an unremovable candidate', function (t) {
  const context = fixture()

  try {
    fs.rmSync(context.linux, { recursive: true })
    const { result } = runBuild(context, {
      FAKE_MV_MODE: 'candidate-fail-after',
      FAKE_RM_TARGET_FAIL: '1'
    })

    t.notEqual(result.status, 0, 'cleanup failure does not report success')
    t.equal(
      fs.readFileSync(path.join(context.linux, addon), 'utf8'),
      'candidate\n',
      'the unremovable candidate remains identifiable'
    )
    t.match(result.stderr, /uncommitted Linux prebuild at prebuilds\/linux-x64; remove it manually/)
    assertNoTemporaryPlatforms(t, context)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})

test('build script preserves the recovery backup when restoration fails', function (t) {
  const context = fixture()

  try {
    const { result } = runBuild(context, { FAKE_MV_MODE: 'restore-fail' })
    const backupRoots = fs.readdirSync(path.join(context.root, 'prebuilds'))
      .filter((entry) => entry.startsWith('.linux-x64-backup.'))

    t.notEqual(result.status, 0, 'restore failure does not report success')
    t.notOk(fs.existsSync(context.linux), 'the rejected candidate is not left as the target')
    t.equal(backupRoots.length, 1, 'one recovery root is preserved')
    t.equal(
      fs.readFileSync(path.join(context.root, 'prebuilds', backupRoots[0], 'linux-x64', addon), 'utf8'),
      'old',
      'the recovery root contains the prior addon, not the candidate'
    )
    t.match(result.stderr, /preserved it at .*\.linux-x64-backup\..*\/linux-x64/)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }

  t.end()
})
