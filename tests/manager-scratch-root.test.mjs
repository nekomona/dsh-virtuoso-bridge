import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BridgeManager } from '../lib/manager.js'

const dirs = []
function scratch(prefix = 'vb-manager-scratch-root-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test.after(() => {
  for (const dir of dirs.reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the OS reclaims it.
    }
  }
})

function testConnection(overrides = {}) {
  return {
    id: 'conn_lab',
    name: 'lab',
    kind: 'remote',
    host: 'lab.example',
    user: 'designer',
    sshPort: 22,
    sshBackend: 'openssh',
    port: 65081,
    autoSessions: false,
    subInstances: [],
    remoteScratchRoot: '~/.virtuoso-bridge',
    envShell: 'auto',
    extraEnv: {},
    ...overrides,
  }
}

function makeManager(connection, settings = {}) {
  const dataDir = scratch()
  const store = {
    snapshot: () => ({ connections: [connection], defaultRemoteScratchRoot: '', ...settings }),
    connection: (ref) => (ref === connection.id || ref === connection.name ? connection : undefined),
  }
  return new BridgeManager({
    ctx: undefined,
    pluginDir: scratch(),
    dataDir,
    store,
    setup: { venvPython: 'unused-by-this-test', cacheDir: path.join(dataDir, 'cache') },
    credentials: undefined,
    userQuestions: undefined,
    log: () => {},
    version: 'test',
  })
}

// A runtime the sidecar already started: it resolved the tilde and reported
// both the absolute root and the raw value it was configured with.
function seedRuntime(manager, connection, overrides = {}) {
  const runtime = {
    id: `rt_${connection.id}`,
    connectionId: connection.id,
    connection,
    profile: 'lab',
    state: 'running',
    scratchRoot: '/home/username/.virtuoso-bridge',
    scratchConfigured: '~/.virtuoso-bridge',
    ...overrides,
  }
  manager.runtimes.set(runtime.id, runtime)
  return runtime
}

test('a matching running runtime supplies the resolved absolute scratch root', async () => {
  const connection = testConnection()
  const manager = makeManager(connection)
  try {
    seedRuntime(manager, connection)
    const env = manager.buildConnectionEnv(connection, 'lab')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT, '/home/username/.virtuoso-bridge')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT_lab, '/home/username/.virtuoso-bridge')
  } finally {
    await manager.dispose()
  }
})

test('the resolved root also applies when the configured value is the default setting', async () => {
  const connection = testConnection({ remoteScratchRoot: '' })
  const manager = makeManager(connection, { defaultRemoteScratchRoot: '~/.virtuoso-bridge' })
  try {
    seedRuntime(manager, connection)
    const env = manager.buildConnectionEnv(connection, 'lab')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT, '/home/username/.virtuoso-bridge')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT_lab, '/home/username/.virtuoso-bridge')
  } finally {
    await manager.dispose()
  }
})

test('a changed configured value falls back to the raw value', async () => {
  const connection = testConnection()
  const manager = makeManager(connection)
  try {
    seedRuntime(manager, connection)
    const env = manager.buildConnectionEnv(testConnection({ remoteScratchRoot: '~/.virtuoso-bridge-v2' }), 'lab')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT, '~/.virtuoso-bridge-v2')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT_lab, '~/.virtuoso-bridge-v2')
  } finally {
    await manager.dispose()
  }
})

test('no runtime leaves the configured value raw', async () => {
  const connection = testConnection()
  const manager = makeManager(connection)
  try {
    const env = manager.buildConnectionEnv(connection, 'lab')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT, '~/.virtuoso-bridge')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT_lab, '~/.virtuoso-bridge')
  } finally {
    await manager.dispose()
  }
})

test('an already absolute configured value is left as-is', async () => {
  const connection = testConnection({ remoteScratchRoot: '/home/username/scratch' })
  const manager = makeManager(connection)
  try {
    // The runtime matches on connection id and configured value, so only the
    // absolute-path guard can keep it from replacing the configured value.
    seedRuntime(manager, connection, {
      scratchRoot: '/home/username/.virtuoso-bridge',
      scratchConfigured: '/home/username/scratch',
    })
    const env = manager.buildConnectionEnv(connection, 'lab')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT, '/home/username/scratch')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT_lab, '/home/username/scratch')
  } finally {
    await manager.dispose()
  }
})
