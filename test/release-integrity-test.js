'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const test = require('tape')
const {
  DEPENDENCIES,
  cloneAtCommit,
  stampMatches,
  supportsSha1ObjectFormat,
  verifyCheckout
} = require('../scripts/build-deps.js')

function git (args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

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

test('dependency checkout requires Git object-format support', function (t) {
  t.notOk(supportsSha1ObjectFormat('git version 2.26.3'), 'Git 2.26 is rejected')
  t.ok(supportsSha1ObjectFormat('git version 2.27.0'), 'Git 2.27 is accepted')
  t.ok(supportsSha1ObjectFormat('git version 3.0.0'), 'future major versions are accepted')
  t.notOk(supportsSha1ObjectFormat('unknown'), 'unparseable versions fail closed')
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
    march: process.env.ROCKS_LEVEL_MARCH || '',
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
  const build = script.indexOf('JOBS=16 npx prebuildify')
  const smokeTest = script.indexOf('npm run test-prebuild', build)
  const version = script.indexOf('npm version "$BUMP"')
  const publish = script.indexOf('npm publish --registry')

  t.ok(build >= 0, 'Darwin prebuild command exists')
  t.ok(smokeTest > build, 'smoke test follows Darwin prebuild generation')
  t.ok(version > smokeTest, 'smoke test precedes the version bump')
  t.ok(publish > smokeTest, 'smoke test precedes publish')
  t.equal((script.match(/npm run test-prebuild/g) || []).length, 1, 'release performs one local artifact smoke test')
  t.end()
})
