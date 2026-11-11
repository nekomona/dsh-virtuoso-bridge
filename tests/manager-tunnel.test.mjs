import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const dirs = []
function scratch(prefix = 'vb-manager-tunnel-') {
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

function makeManager({ connections = [], dataDir = scratch(), pluginDir = scratch() } = {}) {
  const store = {
    snapshot: () => ({
      connections,
      autoStart: [],
      logToCiw: false,
      defaultConnection: connections[0]?.id,
    }),
    connection: (ref) => connections.find((item) => item.id === ref || item.name === ref),
  }
  return new BridgeManager({
    ctx: {},
    pluginDir,
    dataDir,
    store,
    setup: { probeVenv: async () => ({ ok: true }), cacheDir: dataDir, venvPython: PYTHON ?? 'python' },
    credentials: undefined,
    userQuestions: undefined,
    log: () => {},
    version: 'test',
  })
}

function fakeHealthHelper(pluginDir) {
  mkdirSync(path.join(pluginDir, 'runtime'), { recursive: true })
  writeFileSync(
    path.join(pluginDir, 'runtime', 'vb_health.py'),
    [
      'import json, os, sys',
      'args = sys.argv[1:]',
      'profile = args[args.index("--profile") + 1]',
      'suffix = "_" + profile',
      'marker = "owner=%s pid=%s local=%s argv=%s" % (',
      '  os.environ.get("VB_PLUGIN_TUNNEL_OWNER", ""),',
      '  os.environ.get("VB_PLUGIN_TUNNEL_PID", ""),',
      '  os.environ.get("VB_LOCAL_PORT" + suffix, ""),',
      '  " ".join(args),',
      ')',
      'print(json.dumps({',
      '  "ok": True, "ready": True, "verdict": "ready",',
      '  "checks": {',
      '    "ssh": {"ok": True, "backend": "openssh", "detail": marker},',
      '    "daemon": {"checked": True, "state": "ready", "port": int(os.environ.get("VB_REMOTE_PORT" + suffix, "0")), "summary": "fake daemon"},',
      '  },',
      '}))',
    ].join('\n'),
    'utf8',
  )
  return pluginDir
}

const remoteFixed = {
  id: 'conn_lab',
  name: 'lab',
  kind: 'remote',
  host: 'lab.example',
  user: 'designer',
  sshPort: 22,
  sshBackend: 'openssh',
  port: 65081,
  autoSessions: false,
}

test('only remote connections get a plugin-owned tunnel', () => {
  const manager = makeManager({ connections: [remoteFixed] })
  assert.equal(manager.usesPluginTunnel(remoteFixed), true)
  assert.equal(manager.usesPluginTunnel({ ...remoteFixed, kind: 'local' }), false)
  assert.equal(manager.usesPluginTunnel({ ...remoteFixed, host: '127.0.0.1' }), false)
  // Automatic sessions are eligible after their read-only instance discovery.
  assert.equal(manager.usesPluginTunnel({ ...remoteFixed, autoSessions: true }), true)
  // A fixed-port connection without a known port has nothing to forward to.
  assert.equal(manager.usesPluginTunnel({ ...remoteFixed, port: undefined }), false)
})

test('automatic-session tunnels pick the same instance the client will select', () => {
  const manager = makeManager({ connections: [remoteFixed] })
  const rows = [
    { port: 41001, pid: 101, work_dir: '/work/a' },
    { port: 41002, pid: 202, work_dir: '/work/b' },
  ]
  assert.deepEqual(manager.chooseTunnelRemotePort({ autoSessions: true }, { instances: [rows[0]] }), {
    remotePort: 41001,
    record: rows[0],
  })
  assert.equal(
    manager.chooseTunnelRemotePort({ autoSessions: true, instancePort: 41002 }, { instances: rows }).remotePort,
    41002,
  )
  assert.equal(
    manager.chooseTunnelRemotePort({ autoSessions: true }, { instances: rows, selected: rows[1] }).remotePort,
    41002,
  )
  assert.throws(
    () => manager.chooseTunnelRemotePort({ autoSessions: true }, { instances: rows }),
    /Select one/,
  )
  assert.throws(
    () => manager.chooseTunnelRemotePort({ autoSessions: true, instancePort: 49999 }, { instances: rows }),
    /no longer available/,
  )
})

test('helper environments point Python at the Host-owned forward', () => {
  const manager = makeManager({ connections: [remoteFixed] })
  const runtime = {
    connection: remoteFixed,
    profile: 'dsh_lab',
    tunnel: { pid: 4242, localPort: 64123, remotePort: 65081 },
  }
  const env = manager.applyTunnelEnv(runtime, { KEEP: 'yes' })
  assert.equal(env.KEEP, 'yes')
  assert.equal(env.VB_LOCAL_PORT_dsh_lab, '64123')
  assert.equal(env.VB_REMOTE_PORT_dsh_lab, '65081')
  assert.equal(env.VB_PLUGIN_TUNNEL_OWNER, 'plugin')
  assert.equal(env.VB_PLUGIN_TUNNEL_PID, '4242')
  assert.equal(env.VB_PLUGIN_TUNNEL_LOCAL_PORT, '64123')
  assert.equal(env.VB_PLUGIN_TUNNEL_REMOTE_PORT, '65081')

  const untouched = manager.applyTunnelEnv({ connection: remoteFixed, profile: 'dsh_lab' }, { KEEP: 'yes' })
  assert.deepEqual(untouched, { KEEP: 'yes' })
})

test('stopping a runtime clears sidecar state before stopping the Host-owned tunnel', async () => {
  const manager = makeManager({ connections: [remoteFixed] })
  const calls = []
  const runtime = {
    id: 'rt_conn_lab',
    connectionId: remoteFixed.id,
    connection: remoteFixed,
    profile: 'dsh_lab',
    state: 'running',
    sidecar: {
      closed: false,
      stop: async (options) => calls.push(['sidecar.stop', options.stopTunnel]),
    },
    tunnel: {
      pid: 4242,
      alive: true,
      snapshot: () => ({ state: 'up', pid: 4242, localPort: 64123, remotePort: 65081, alive: true }),
      stop: async () => calls.push(['tunnel.stop', 4242]),
    },
    actionIds: new Set(),
    agentUsage: new Map(),
    logTail: [],
  }
  manager.runtimes.set(runtime.id, runtime)
  const snapshot = await manager.stopRuntime(runtime.id)
  assert.deepEqual(calls, [
    ['sidecar.stop', true],
    ['tunnel.stop', 4242],
  ])
  assert.equal(runtime.tunnel, undefined)
  assert.equal(runtime.state, 'stopped')
  assert.equal(snapshot.state, 'stopped')
})

test('Test Connection reuses a live runtime tunnel instead of opening another one', { skip: NO_PYTHON }, async () => {
  const pluginDir = fakeHealthHelper(scratch())
  const manager = makeManager({ connections: [remoteFixed], pluginDir })
  const runtime = {
    id: 'rt_conn_lab',
    connectionId: remoteFixed.id,
    connection: remoteFixed,
    profile: 'dsh_lab',
    state: 'running',
    tunnel: {
      alive: true,
      pid: 4242,
      localPort: 64123,
      remotePort: 65081,
      snapshot: () => ({ state: 'up', pid: 4242, localPort: 64123, remotePort: 65081, alive: true }),
    },
    actionIds: new Set(),
    agentUsage: new Map(),
    logTail: [],
  }
  manager.runtimes.set(runtime.id, runtime)
  const result = await manager.testConnection(remoteFixed.id)
  assert.equal(result.ok, true)
  const marker = result.checks.ssh.detail
  assert.match(marker, /owner=plugin/)
  assert.match(marker, /pid=4242/)
  assert.match(marker, /local=64123/)
  assert.match(marker, /--port 65081/)
  // The helper must not be pointed at a separate free local port.
  assert.doesNotMatch(marker, /--local-port/)
  assert.equal(result.daemon.state, 'ready')
})

test('Test Connection on a stopped runtime opens a short Host probe tunnel', { skip: NO_PYTHON }, async () => {
  const pluginDir = fakeHealthHelper(scratch())
  const manager = makeManager({ connections: [remoteFixed], pluginDir })
  let stopped = false
  const launched = []
  manager.launchTunnel = async (connection, remotePort) => {
    launched.push({ connection, remotePort })
    return {
      pid: 777,
      localPort: 64124,
      remotePort,
      alive: true,
      stop: async () => {
        stopped = true
      },
    }
  }
  const result = await manager.testConnection(remoteFixed.id)
  assert.equal(result.ok, true)
  assert.equal(result.daemon.state, 'ready')
  assert.deepEqual(
    launched.map((item) => item.remotePort),
    [65081],
  )
  assert.equal(stopped, true, 'the probe tunnel is always torn down')
  const marker = result.checks.ssh.detail
  assert.match(marker, /owner=plugin/)
  assert.match(marker, /pid=777/)
  assert.match(marker, /local=64124/)
  assert.match(marker, /--port 65081/)
  assert.doesNotMatch(marker, /--local-port/)
})

test('a failed Host probe tunnel still runs the SSH checks and reports the real cause', { skip: NO_PYTHON }, async () => {
  const pluginDir = fakeHealthHelper(scratch())
  const manager = makeManager({ connections: [remoteFixed], pluginDir })
  manager.launchTunnel = async () => {
    throw new Error('bind: permission denied')
  }
  const result = await manager.testConnection(remoteFixed.id)
  assert.equal(result.ok, true, 'SSH checks do not need the tunnel')
  assert.equal(result.daemon.state, 'unreachable')
  assert.match(result.daemon.summary, /Host test tunnel failed/)
  const marker = result.checks.ssh.detail
  assert.doesNotMatch(marker, /owner=plugin/)
  assert.doesNotMatch(marker, /--port/)
  assert.doesNotMatch(marker, /--local-port/)
})

test('a Host-owned tunnel record is reported as an orphan after a crash', async () => {
  const dataDir = scratch()
  const manager = makeManager({ connections: [], dataDir })
  const dir = path.join(dataDir, 'tunnels')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'conn_lab.json'),
    JSON.stringify({
      owner: 'plugin',
      connectionId: 'conn_lab',
      connectionName: 'lab',
      profile: 'dsh_lab',
      pid: process.pid,
      localPort: 64123,
      remotePort: 65081,
      host: 'lab.example',
    }),
    'utf8',
  )
  const found = await manager.scanOrphans()
  const row = found.find((item) => item.source === 'plugin' && item.tunnelPid === process.pid)
  assert.ok(row, 'the plugin tunnel record is discoverable')
  assert.equal(row.state, 'orphaned')
  assert.equal(row.port, 64123)
  assert.equal(row.managed, false)
})
