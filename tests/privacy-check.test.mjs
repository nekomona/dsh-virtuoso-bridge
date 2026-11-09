import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const scriptPath = path.resolve(import.meta.dirname, '..', 'scripts', 'check-branch-privacy.mjs')

const secretHost = ['secret', 'host', 'abc'].join('-')
const privateIp = [10, 20, 30, 40].join('.')
const privateHome = ['', 'home', 'alice'].join('/')

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-privacy-'))
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true })
  await fs.copyFile(scriptPath, path.join(dir, 'scripts', 'check-branch-privacy.mjs'))
  // The rules live in a shared module, so the scratch repository needs it too.
  await fs.mkdir(path.join(dir, 'scripts', 'lib'), { recursive: true })
  await fs.copyFile(
    path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'private-rules.mjs'),
    path.join(dir, 'scripts', 'lib', 'private-rules.mjs'),
  )
  const git = (args) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'user.name=Git User', '-c', 'user.email=git.user@example.com', ...args],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  git(['init', '-q'])
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'base commit'])
  return { dir, git }
}

function runCheck(dir, extraEnv = {}, base = 'HEAD^', nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, path.join(dir, 'scripts', 'check-branch-privacy.mjs'), '--base', base], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, VB_PRIVATE_NAMES: '', ...extraEnv },
  })
}

/**
 * Preload that makes the check see the operating-system identity of a CI
 * runner (or of any other account) instead of this machine's account.
 */
async function writeIdentityStub(dir, username, homedir) {
  const stub = path.join(dir, 'identity-stub.cjs')
  await fs.writeFile(
    stub,
    [
      "const os = require('node:os')",
      `os.userInfo = () => ({ uid: 1001, gid: 1001, username: ${JSON.stringify(username)}, homedir: ${JSON.stringify(homedir)}, shell: '/bin/bash' })`,
      `os.homedir = () => ${JSON.stringify(homedir)}`,
      '',
    ].join('\n'),
    'utf8',
  )
  return stub
}

test('a secret name in a commit message is rejected without echoing it', async () => {
  const { dir, git } = await makeRepo()
  try {
    await fs.writeFile(path.join(dir, 'change.txt'), 'clean\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', `note ${secretHost}`])
    const result = runCheck(dir, { VB_PRIVATE_NAMES: secretHost })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /commit .* message line \d+: \[private-name\]/)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secretHost))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a private address and home path in an added line are rejected', async () => {
  const { dir, git } = await makeRepo()
  try {
    await fs.writeFile(path.join(dir, 'change.txt'), `${privateIp}\n${privateHome}\n`, 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'add configuration'])
    const result = runCheck(dir)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /\[private-ipv4\]|\[unix-home-path\]/)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(privateIp.replace(/\./g, '\\.')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a value added and removed later is still caught in history', async () => {
  const { dir, git } = await makeRepo()
  try {
    await fs.writeFile(path.join(dir, 'change.txt'), `${privateIp}\n`, 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'temporary configuration'])
    git(['rm', '-q', 'change.txt'])
    git(['commit', '-q', '-m', 'remove temporary configuration'])
    const result = runCheck(dir, {}, 'HEAD~2')
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /\[private-ipv4\]/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('documented placeholders and the git identity stay allowed', async () => {
  const { dir, git } = await makeRepo()
  try {
    await fs.writeFile(path.join(dir, 'change.txt'), 'host.example designer home=/home/username\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'document placeholders'])
    const result = runCheck(dir)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the CI runner account is not treated as private data', async () => {
  // GitHub-hosted runners run every job as `runner` (with a generic home
  // directory), and "job runner" is an ordinary phrase in this repository's
  // docs and code. That account must never be derived as a private value.
  const { dir, git } = await makeRepo()
  try {
    await fs.writeFile(path.join(dir, 'change.txt'), 'the job runner keeps one worker per runtime\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'document the job runner and its worker'])
    const stub = await writeIdentityStub(dir, 'runner', ['', 'home', 'runner'].join('/'))
    const result = runCheck(dir, { GITHUB_ACTIONS: 'true', CI: 'true' }, 'HEAD^', ['--require', stub])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /no developer identity on CI/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a developer account name is still rejected outside CI', async () => {
  const { dir, git } = await makeRepo()
  try {
    await fs.writeFile(path.join(dir, 'change.txt'), 'hand this over to alice\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'plan the handover'])
    const stub = await writeIdentityStub(dir, 'alice', ['', 'home', 'alice'].join('/'))
    const result = runCheck(dir, { GITHUB_ACTIONS: '', CI: '' }, 'HEAD^', ['--require', stub])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /\[user-name\]/)
    assert.doesNotMatch(result.stdout + result.stderr, /\balice\b/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
