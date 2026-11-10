import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BridgeManager } from '../lib/manager.js'

function findPython() {
  for (const candidate of [process.env.VB_TEST_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 15_000 })
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate
  }
  return undefined
}

const PYTHON = findPython()
const NO_PYTHON = PYTHON ? false : 'no python3 interpreter on PATH (set VB_TEST_PYTHON to one)'

const scratchDirs = []
function scratch(prefix = 'vb-manager-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

test.after(() => {
  for (const dir of scratchDirs.reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A child may still hold a handle on Windows; the OS reclaims it.
    }
  }
})

/** A manager wired to a stub deploy helper instead of a real Python client. */
function buildManager({ connection, settings = {} }) {
  const pluginDir = scratch()
  const dataDir = scratch()
  mkdirSync(path.join(pluginDir, 'runtime'), { recursive: true })
  writeFileSync(
    path.join(pluginDir, 'runtime', 'vb_deploy.py'),
    [
      'import json, os, sys',
      'print(json.dumps({',
      '  "ok": True,',
      '  "argv": sys.argv[1:],',
      '  "scratchEnv": os.environ.get("VB_REMOTE_SCRATCH_ROOT", ""),',
      '  "pythonpath": os.environ.get("PYTHONPATH", ""),',
      '  "ambientRemoteHost": os.environ.get("VB_REMOTE_HOST", ""),',
      '  "setupPath": "/resolved/scratch/daemon/virtuoso_setup.il",',
      '  "scratchRoot": "/resolved/scratch",',
      '}))',
    ].join('\n'),
    'utf8',
  )
  const snapshot = { ...settings, connections: [connection] }
  const store = {
    snapshot: () => JSON.parse(JSON.stringify(snapshot)),
    connection: (ref) => (ref === connection.id || ref === connection.name ? connection : undefined),
  }
  const setup = { venvPython: PYTHON, cacheDir: path.join(dataDir, 'cache') }
  const manager = new BridgeManager({
    ctx: undefined,
    pluginDir,
    dataDir,
    store,
    setup,
    credentials: undefined,
    userQuestions: undefined,
    log: () => {},
    version: 'test',
  })
  return { manager, pluginDir, dataDir }
}

test('deploy_daemon runs the plugin helper with the saved connection and an isolated env', { skip: NO_PYTHON }, async () => {
  const connection = {
    id: 'conn_lab',
    name: 'lab',
    kind: 'remote',
    host: 'lab.example',
    user: 'designer',
    sshPort: 22,
    sshBackend: 'openssh',
    port: 65432,
    autoSessions: false,
    subInstances: [],
    remoteScratchRoot: '~/.scratch/',
    envShell: 'auto',
    extraEnv: {},
  }
  const { manager, dataDir } = buildManager({
    connection,
    settings: { defaultRemoteScratchRoot: '/global/scratch' },
  })
  const previous = {
    PYTHONPATH: process.env.PYTHONPATH,
    VB_REMOTE_HOST: process.env.VB_REMOTE_HOST,
  }
  process.env.PYTHONPATH = '/home/username/virtuoso-bridge/src'
  process.env.VB_REMOTE_HOST = 'other.example'
  try {
    const result = await manager.deployDaemon('lab')
    assert.equal(result.ok, true)
    assert.equal(result.configuredScratchRoot, '~/.scratch/')
    assert.equal(result.scratchRoot, '/resolved/scratch')
    assert.equal(result.argv.includes('--env-file'), true)
    const envFileArg = result.argv[result.argv.indexOf('--env-file') + 1]
    assert.equal(path.dirname(envFileArg), dataDir)
    assert.equal(path.basename(envFileArg), 'empty.env')
    assert.equal(result.scratchEnv, '~/.scratch/', 'the saved scratch root must reach the helper unchanged')
    assert.equal(result.pythonpath, '', 'PYTHONPATH from another installation must not reach the helper')
    assert.equal(result.ambientRemoteHost, '', 'ambient VB_* values must not select another host')
    await manager.dispose()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('deploy_daemon falls back to the global default scratch root and passes the instance port', { skip: NO_PYTHON }, async () => {
  const connection = {
    id: 'conn_auto',
    name: 'auto',
    kind: 'remote',
    host: 'auto.example',
    user: 'designer',
    sshPort: 22,
    sshBackend: 'paramiko',
    autoSessions: true,
    instancePort: 40001,
    subInstances: [],
    remoteScratchRoot: '',
    envShell: 'auto',
    extraEnv: {},
  }
  const { manager } = buildManager({ connection, settings: { defaultRemoteScratchRoot: '/global/scratch' } })
  const result = await manager.deployDaemon('auto')
  assert.equal(result.configuredScratchRoot, '/global/scratch')
  assert.equal(result.argv[result.argv.indexOf('--instance-port') + 1], '40001')
  await manager.dispose()
})
