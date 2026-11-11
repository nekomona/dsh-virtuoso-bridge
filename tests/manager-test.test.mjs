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

const dirs = []
function scratch(prefix = 'vb-manager-test-') {
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

test('Test Connection reports SSH, Python, scratch root and daemon even with no runtime sidecar', { skip: NO_PYTHON }, async () => {
  const connection = {
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
    remoteScratchRoot: '~/.virtuoso_bridge',
    envShell: 'auto',
    extraEnv: {},
  }
  const pluginDir = scratch()
  const dataDir = scratch()
  mkdirSync(path.join(pluginDir, 'runtime'), { recursive: true })
  writeFileSync(
    path.join(pluginDir, 'runtime', 'vb_health.py'),
    [
      'import json',
      'print(json.dumps({',
      '  "ok": True,',
      '  "ready": False,',
      '  "verdict": "daemon-not-ready",',
      '  "checks": {',
      '    "ssh": {"ok": True, "elapsedMs": 3405, "backend": "openssh"},',
      '    "remotePython": {"ok": True, "selected": {"path": "/usr/bin/python3", "version": "Python 3.9.21"}},',
      '    "scratchRoot": {"ok": False, "exists": False, "resolved": "/home/username/.virtuoso_bridge",',
      '      "error": "the scratch root does not exist: /home/username/.virtuoso_bridge",',
      '      "code": "scratch-root-missing", "hint": "mkdir -p -m 700 /home/username/.virtuoso_bridge"},',
      '    "daemon": {"checked": True, "state": "no-listener", "port": 65081, "remotePort": 65081}',
      '  }',
      '}))',
    ].join('\n'),
    'utf8',
  )
  const store = {
    snapshot: () => ({ connections: [connection], defaultRemoteScratchRoot: '' }),
    connection: (ref) => (ref === connection.id || ref === connection.name ? connection : undefined),
  }
  const manager = new BridgeManager({
    ctx: undefined,
    pluginDir,
    dataDir,
    store,
    setup: { venvPython: PYTHON, cacheDir: path.join(dataDir, 'cache') },
    credentials: undefined,
    userQuestions: undefined,
    log: () => {},
    version: 'test',
  })
  try {
    const result = await manager.testConnection('lab')
    assert.equal(result.ok, true, 'SSH success stays the compatibility ok flag')
    assert.equal(result.ready, false)
    assert.equal(result.verdict, 'daemon-not-ready')
    // No runtime is up, so Test opens a short Host probe tunnel to the daemon
    // port. `lab.example` is unreachable here; the structured checks still come
    // back and the daemon reports the real tunnel cause instead of a fake state.
    assert.equal(result.checks.daemon.state, 'unreachable')
    assert.match(result.checks.daemon.summary, /Host test tunnel failed/)
    assert.equal(result.checks.scratchRoot.exists, false)
    assert.match(result.checks.scratchRoot.hint, /mkdir -p -m 700/)
    assert.match(result.detail, /SSH ok \(3405 ms\)/)
    assert.match(result.detail, /scratch root missing/)
    assert.match(result.detail, /daemon unreachable: Host test tunnel failed/)
    assert.equal(result.daemon.state, 'unreachable')
  } finally {
    await manager.dispose()
  }
})
