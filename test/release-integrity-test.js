'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const test = require('tape')
const {
  DEPENDENCIES,
  cloneAtCommit,
  createSha1ObjectFormatCheck,
  stampMatches,
  supportsSha1ObjectFormat,
  verifyCheckout
} = require('../scripts/build-deps.js')
const cpuFlags = require('../scripts/cpu-flags.js')

function git (args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

function executable (file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function runReleaseBranchCheck (branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-release-'))
  const bin = path.join(root, 'bin')
  const npmLog = path.join(root, 'npm.log')

  try {
    fs.mkdirSync(bin)
    fs.copyFileSync(path.join(__dirname, '..', 'release.sh'), path.join(root, 'release.sh'))
    executable(
      path.join(bin, 'git'),
      `#!/bin/bash
if [ "$1:$2" = "branch:--show-current" ]; then
  printf '%s' "\${FAKE_GIT_BRANCH:-}"
  exit 0
fi
exit 99
`
    )
    executable(
      path.join(bin, 'npm'),
      `#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
exit 99
`
    )

    const result = spawnSync('/bin/bash', ['./release.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GIT_BRANCH: branch,
        FAKE_NPM_LOG: npmLog,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`
      }
    })

    return {
      npmCalled: fs.existsSync(npmLog),
      result
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('release requires the master branch before running npm', function (t) {
  for (const [branch, visibleBranch] of [
    ['feature/release', 'feature/release'],
    ['', 'detached HEAD']
  ]) {
    const { npmCalled, result } = runReleaseBranchCheck(branch)

    t.equal(result.status, 1, `${visibleBranch} is rejected`)
    t.match(result.stderr, new RegExp(`current branch: ${visibleBranch}`))
    t.notOk(npmCalled, `${visibleBranch} is rejected before npm authentication`)
  }

  const { npmCalled, result } = runReleaseBranchCheck('master')
  t.equal(result.status, 1, 'the fake npm authentication stops the master fixture')
  t.ok(npmCalled, 'master proceeds to npm authentication')
  t.match(result.stderr, /Not logged in to npm/, 'master reaches the existing authentication guard')
  t.end()
})

test('native dependencies use exact audited upstream commits', function (t) {
  t.same(
    Object.fromEntries(
      Object.entries(DEPENDENCIES).map(([name, dependency]) => [name, dependency.commit])
    ),
    {
      abseil: '4447c7562e3bc702ade25105912dce503f0c4010',
      re2: '927f5d53caf8111721e734cf24724686bb745f55',
      zstd: 'f8745da6ff1ad1e7bab384bd1f9d742439278e99'
    }
  )

  for (const dependency of Object.values(DEPENDENCIES)) {
    t.match(dependency.commit, /^[0-9a-f]{40}$/, 'pin is a full lowercase SHA-1')
  }
  t.end()
})

test('Linux prebuild base is pinned to the audited amd64 image manifest', function (t) {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8')
  const from = dockerfile.match(/^FROM\s+(\S+)\s+AS\s+build$/m)?.[1]

  t.equal(
    from,
    'node:26.4.0-bookworm@sha256:6000864d78f7f7e4f1a832c014fc7ff50dc95c60c665c7b722281e3dc5b58dfd'
  )
  t.match(
    dockerfile,
    /FROM scratch AS artifact\nCOPY --from=build \/rocks-level\/prebuilds\/linux-x64\/@nxtedition\+rocksdb\.node \/@nxtedition\+rocksdb\.node/,
    'the final stage exports exactly the validated addon'
  )
  t.match(dockerfile, /^ARG ROCKS_LEVEL_MARCH=x86-64-v3$/m, 'Linux prebuilds default to x86-64-v3')
  t.match(dockerfile, /^ARG ROCKS_LEVEL_MTUNE=znver3$/m, 'Linux prebuilds stay tuned for Zen 3')
  t.end()
})

test('dependency checkout requires Git object-format support', function (t) {
  t.notOk(supportsSha1ObjectFormat('git version 2.26.3'), 'Git 2.26 is rejected')
  t.ok(supportsSha1ObjectFormat('git version 2.27.0'), 'Git 2.27 is accepted')
  t.ok(supportsSha1ObjectFormat('git version 3.0.0'), 'future major versions are accepted')
  t.notOk(supportsSha1ObjectFormat('unknown'), 'unparseable versions fail closed')
  t.end()
})

test('Git object-format preflight memoizes success and preserves failure detail', function (t) {
  let calls = 0
  const ensureSupport = createSha1ObjectFormatCheck(() => {
    ++calls
    return 'git version 2.27.0'
  })

  ensureSupport()
  ensureSupport()
  t.equal(calls, 1, 'successful Git version detection runs once')

  const cause = new Error('spawnSync git ENOENT')
  const fail = createSha1ObjectFormatCheck(() => {
    throw cause
  })

  try {
    fail()
    t.fail('missing Git rejects the preflight')
  } catch (err) {
    t.equal(err.cause, cause, 'the original failure is retained as the cause')
    t.match(err.message, /spawnSync git ENOENT/, 'the visible message contains the spawn failure')
  }

  t.end()
})

test('dependency checkout is detached at and verified against the requested commit', function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-dependency-'))

  try {
    const origin = path.join(root, 'origin')
    fs.mkdirSync(origin)
    git(['init', '--quiet', '--initial-branch=main', '--object-format=sha1', origin])
    git(['-C', origin, 'config', 'user.name', 'rocks-level test'])
    git(['-C', origin, 'config', 'user.email', 'rocks-level@example.invalid'])

    const source = path.join(origin, 'source.txt')
    fs.writeFileSync(source, 'first\n')
    git(['-C', origin, 'add', 'source.txt'])
    git(['-C', origin, 'commit', '--quiet', '-m', 'first'])
    const requestedCommit = git(['-C', origin, 'rev-parse', 'HEAD'])

    fs.writeFileSync(source, 'second\n')
    git(['-C', origin, 'commit', '--quiet', '-am', 'second'])
    const latestCommit = git(['-C', origin, 'rev-parse', 'HEAD'])

    const checkout = path.join(root, 'checkout')
    const dependency = {
      repository: `file://${origin}`,
      commit: requestedCommit
    }
    cloneAtCommit(dependency, checkout)

    t.equal(git(['-C', checkout, 'rev-parse', 'HEAD']), requestedCommit)
    t.notEqual(requestedCommit, latestCommit, 'test origin advanced past the pin')
    t.equal(git(['-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'checkout is detached')
    t.doesNotThrow(() => verifyCheckout(dependency, checkout), 'matching HEAD is accepted')
    t.throws(
      () => verifyCheckout({ ...dependency, commit: latestCommit }, checkout),
      /dependency checkout verification failed/,
      'a different HEAD is rejected'
    )

    const invalidCheckout = path.join(root, 'invalid-checkout')
    t.throws(
      () => cloneAtCommit({ ...dependency, commit: 'main' }, invalidCheckout),
      /full lowercase SHA-1/,
      'mutable refs are rejected before git runs'
    )
    t.notOk(fs.existsSync(invalidCheckout), 'an invalid ref leaves no source directory')

    const missingCheckout = path.join(root, 'missing-checkout')
    t.throws(
      () => cloneAtCommit({ ...dependency, commit: 'f'.repeat(40) }, missingCheckout),
      'an unavailable full commit is rejected'
    )
    t.notOk(fs.existsSync(missingCheckout), 'a failed fetch removes its partial repository')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  t.end()
})

test('dependency cache stamp contains commits and rejects the old tag stamp', function (t) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-stamp-'))
  const stamp = (dependencies) => ({
    march: cpuFlags.march(),
    mtune: cpuFlags.mtune(),
    macosDeploymentTarget: process.platform === 'darwin' ? '13.4.0' : null,
    ...dependencies
  })

  try {
    fs.writeFileSync(path.join(prefix, '.stamp.json'), JSON.stringify(stamp({
      abseil: '20240722.0',
      re2: '2025-11-05',
      zstd: 'v1.5.7'
    })))
    t.notOk(stampMatches(prefix), 'tag-based cache is invalidated')

    fs.writeFileSync(path.join(prefix, '.stamp.json'), JSON.stringify(stamp({
      abseil: DEPENDENCIES.abseil.commit,
      re2: DEPENDENCIES.re2.commit,
      zstd: DEPENDENCIES.zstd.commit
    })))
    t.ok(stampMatches(prefix), 'commit-based cache is reusable')
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true })
  }

  t.end()
})

test('release tests the Darwin prebuild before changing package state', function (t) {
  const script = fs.readFileSync(path.join(__dirname, '..', 'release.sh'), 'utf8')
  const helper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-darwin-prebuild.sh'), 'utf8')
  const darwinBuildCommand = 'JOBS=16 ./scripts/build-darwin-prebuild.sh "$NODE_TARGET"'
  const clearFaults = script.indexOf('export ROCKS_LEVEL_TEST_FAULTS=0')
  const linuxBuild = script.indexOf('./build.sh')
  const build = script.indexOf(darwinBuildCommand)
  const candidateInstall = helper.indexOf('mv "$CANDIDATE_DIR" "$TARGET_DIR"')
  const smokeTest = helper.indexOf('npm run test-prebuild', candidateInstall)
  const commit = helper.indexOf('COMMITTED=1', smokeTest)
  const manifestCheck = script.indexOf('node scripts/check-release-prebuilds.js', build)
  const version = script.indexOf('npm version "$BUMP"')
  const publish = script.indexOf('npm publish --registry')

  t.ok(clearFaults >= 0, 'release explicitly disables native fault injection')
  t.ok(linuxBuild >= 0, 'Linux prebuild command exists')
  t.ok(clearFaults < linuxBuild, 'fault injection is disabled before the Linux build')
  t.ok(clearFaults < build, 'fault injection is disabled before the Darwin build')
  t.ok(build >= 0, 'Darwin prebuild command exists')
  t.ok(smokeTest > candidateInstall, 'the installed candidate is smoke-tested')
  t.ok(commit > smokeTest, 'smoke failure remains inside the rollback boundary')
  t.ok(manifestCheck > build, 'pack manifest is checked after artifact smoke testing')
  t.ok(version > build, 'smoke-tested helper precedes the version bump')
  t.ok(version > manifestCheck, 'pack manifest is checked before the version bump')
  t.ok(publish > build, 'smoke-tested helper precedes publish')
  t.ok(publish > manifestCheck, 'pack manifest is checked before publish')
  t.equal(
    ((script + helper).match(/npm run test-prebuild/g) || []).length,
    1,
    'release performs one local artifact smoke test'
  )
  t.end()
})

test('release stages and atomically installs only its known Darwin platform directory', function (t) {
  const script = fs.readFileSync(path.join(__dirname, '..', 'release.sh'), 'utf8')
  const helper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-darwin-prebuild.sh'), 'utf8')
  const dependencies = script.indexOf('npm run build-deps')
  const buildDarwin = script.indexOf('JOBS=16 ./scripts/build-darwin-prebuild.sh "$NODE_TARGET"')

  t.ok(buildDarwin > dependencies, 'Darwin dependency failure leaves the prior artifact untouched')
  t.match(helper, /--out "\$OUT_DIR"/, 'prebuildify writes to an isolated output root')
  t.match(helper, /EXPECTED_PREBUILD="\$CANDIDATE_DIR\/\$ADDON"/, 'the staged addon is validated')
  t.match(helper, /BACKUP_ROOT=.*backup/, 'the prior platform is backed up for rollback')
  t.notOk(/rm -rf prebuilds(?:\s|$)/m.test(script), 'unrelated platform directories are not deleted')
  t.end()
})

test('release uses x86-64-v3 for Linux and portable tuning for Darwin', function (t) {
  const script = fs.readFileSync(path.join(__dirname, '..', 'release.sh'), 'utf8')
  const useLinuxDefault = script.indexOf('unset ROCKS_LEVEL_MARCH')
  const useLinuxTuneDefault = script.indexOf('unset ROCKS_LEVEL_MTUNE')
  const linuxBuild = script.indexOf('./build.sh', useLinuxDefault)
  const clearTuning = script.indexOf('export ROCKS_LEVEL_MARCH=', linuxBuild)
  const clearTuneTuning = script.indexOf('export ROCKS_LEVEL_MTUNE=', linuxBuild)
  const darwinDependencies = script.indexOf('npm run build-deps', clearTuning)
  const darwinBuild = script.indexOf(
    'JOBS=16 ./scripts/build-darwin-prebuild.sh "$NODE_TARGET"',
    darwinDependencies
  )

  t.ok(useLinuxDefault >= 0, 'the release ignores caller tuning for Linux')
  t.ok(useLinuxTuneDefault >= 0, 'the release ignores caller -mtune for Linux')
  t.ok(linuxBuild > useLinuxDefault, 'Linux uses the Dockerfile default')
  t.ok(linuxBuild > useLinuxTuneDefault, 'Linux uses the Dockerfile -mtune default')
  t.ok(clearTuning > linuxBuild, 'CPU tuning is cleared after the Linux build')
  t.ok(clearTuneTuning > linuxBuild, '-mtune is cleared after the Linux build')
  t.ok(darwinDependencies > clearTuning, 'Darwin dependencies inherit the cleared value')
  t.ok(darwinDependencies > clearTuneTuning, 'Darwin dependencies inherit the cleared -mtune')
  t.ok(darwinBuild > darwinDependencies, 'Darwin prebuild uses the portable dependencies')
  t.equal(
    (script.match(/^\s*(?:export\s+)?ROCKS_LEVEL_MARCH=/gm) || []).length,
    1,
    'there is one portable tuning assignment'
  )
  t.equal(
    (script.match(/^\s*(?:export\s+)?ROCKS_LEVEL_MTUNE=/gm) || []).length,
    1,
    'there is one portable -mtune assignment'
  )
  t.end()
})

test('release clears private dependency prefix overrides before public builds', function (t) {
  const script = fs.readFileSync(path.join(__dirname, '..', 'release.sh'), 'utf8')
  const helper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-darwin-prebuild.sh'), 'utf8')
  const clearPrefix = script.indexOf('unset ROCKS_LEVEL_DEPS_PREFIX')
  const linuxBuild = script.indexOf('./build.sh', clearPrefix)
  const darwinDependencies = script.indexOf('npm run build-deps', linuxBuild)
  const darwinBuild = script.indexOf(
    'JOBS=16 ./scripts/build-darwin-prebuild.sh "$NODE_TARGET"',
    darwinDependencies
  )

  t.ok(clearPrefix >= 0, 'the release environment clears private dependency overrides')
  t.ok(linuxBuild > clearPrefix, 'the Linux public build starts with no caller prefix')
  t.ok(darwinDependencies > linuxBuild, 'Darwin dependencies use their persistent prefix')
  t.ok(darwinBuild > darwinDependencies, 'Darwin prebuild runs after its dependencies')
  t.match(
    helper,
    /ROCKS_LEVEL_DEPS_PREFIX="\$DEPS_PREFIX" JOBS=/,
    'the Darwin helper pins prebuildify to its matching persistent prefix'
  )
  t.equal(
    (script.match(/^unset ROCKS_LEVEL_DEPS_PREFIX$/gm) || []).length,
    1,
    'there is one release-wide dependency override reset'
  )
  t.end()
})

// The dependency layer is built before the source tree is copied, from an
// explicit list of scripts, so a new local require in build-deps.js only fails
// once the Docker build reaches that stage.
test('the dependency stage copies every script build-deps.js requires', function (t) {
  const root = path.join(__dirname, '..')
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
  const buildDeps = fs.readFileSync(path.join(root, 'scripts', 'build-deps.js'), 'utf8')
  const copy = /^COPY ((?:scripts\/\S+ )+)\.\/scripts\/$/m.exec(dockerfile)

  t.ok(copy, 'the dependency stage copies a fixed list of scripts')
  const copied = new Set(copy[1].trim().split(' '))
  t.ok(copied.has('scripts/build-deps.js'), 'the dependency build script itself is copied')

  for (const [, required] of buildDeps.matchAll(/require\('\.\/([^']+)'\)/g)) {
    t.ok(copied.has(`scripts/${required}`), `scripts/${required} reaches the dependency stage`)
  }
  t.end()
})

// The addon, rocksdb and the dependency prefix must agree on one baseline: a
// mismatch links objects compiled for different instruction sets into a single
// artifact. Keeping the flag list in one script is what makes that true, so no
// .gyp file may spell the flags out again.
test('every compiled part of a tuned build takes its CPU flags from one place', function (t) {
  const gypFiles = {
    'binding.gyp': 'node scripts/cpu-flags.js',
    'deps/rocksdb/rocksdb.gyp': 'node ../../scripts/cpu-flags.js'
  }

  for (const [file, command] of Object.entries(gypFiles)) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    const code = source.replaceAll(/^\s*#.*$/gm, '')
    t.ok(source.includes(`"<!@(${command})"`), `${file} resolves its CPU flags through cpu-flags.js`)
    t.notOk(/-m(?:arch|tune|pclmul)\b/.test(code), `${file} spells out no CPU flags of its own`)
  }

  const buildDeps = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-deps.js'), 'utf8')
  t.match(buildDeps, /cpuFlags\.flags\(\)/, 'the dependency build uses the same resolver')
  t.end()
})

test('public prebuild generation cannot inherit caller GYP definitions', function (t) {
  const bindingGyp = fs.readFileSync(path.join(__dirname, '..', 'binding.gyp'), 'utf8')
  const release = fs.readFileSync(path.join(__dirname, '..', 'release.sh'), 'utf8')
  const helper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-darwin-prebuild.sh'), 'utf8')
  const prebuildify = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prebuildify.js'), 'utf8')
  const clearGyp = release.indexOf('unset GYP_DEFINES')
  const linuxBuild = release.indexOf('./build.sh', clearGyp)
  const darwinBuild = release.indexOf(
    'JOBS=16 ./scripts/build-darwin-prebuild.sh "$NODE_TARGET"',
    linuxBuild
  )

  t.match(
    bindingGyp,
    /"rocks_level_test_faults":\s*"<!\(node/,
    'the fault variable is assigned rather than defined as an overridable default'
  )
  t.notOk(
    /"rocks_level_test_faults%"/.test(bindingGyp),
    'GYP_DEFINES cannot override the intended fault-test environment switch'
  )
  t.ok(clearGyp >= 0, 'the release clears caller GYP definitions')
  t.ok(linuxBuild > clearGyp, 'the Linux public build follows the reset')
  t.ok(darwinBuild > linuxBuild, 'the Darwin public build follows the reset')
  t.match(helper, /GYP_DEFINES= ROCKS_LEVEL_DEPS_PREFIX=/, 'the Darwin helper also sanitizes GYP')
  t.match(prebuildify, /GYP_DEFINES: ''/, 'the general prebuild helper also sanitizes GYP')
  t.end()
})
