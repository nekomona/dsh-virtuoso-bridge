import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FIXTURES = path.join(HERE, 'fixtures')
const RUNTIME = path.join(ROOT, 'runtime')

function findPython() {
  for (const candidate of [process.env.VB_TEST_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 15_000 })
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate
  }
  return undefined
}

const PYTHON = findPython()
const NO_PYTHON = PYTHON ? false : 'no python3 interpreter on PATH (set VB_TEST_PYTHON to one)'

test('a signed daemon is attached before deployment, while missing/automatic cases fall back', { skip: NO_PYTHON }, () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vb-attach-'))
  const script = String.raw`
import json, os, sys
sys.path.insert(0, os.getcwd())
import vb_daemon_probe
import vb_sidecar

calls = {"ensure_tunnel": 0, "probe": 0}

class SSH:
    _discover_instances = False
    remote_port = 65081
    port = 12345
    _remote_setup_done = False
    _remote_virtuoso_setup_path = None
    def ensure_tunnel(self):
        calls["ensure_tunnel"] += 1
    def read_daemon_token(self):
        return "token"
    def read_state(self):
        return {"setup_path": "/home/username/.virtuoso-bridge/old/virtuoso_setup.il"}

def probe(port, token, timeout):
    calls["probe"] += 1
    return dict(os.environ_probe_result)

vb_daemon_probe.probe_tunnel_daemon = probe

def attempt(probe_result, discover=False):
    os.environ_probe_result = probe_result
    ssh = SSH()
    ssh._discover_instances = discover
    runtime = vb_sidecar.BridgeRuntime(profile="dsh_voyager", local=False, timeout=10)
    returned = runtime._try_attach_existing(ssh, 10)
    return {
        "returned": bool(returned),
        "attached": bool((runtime.attach_info or {}).get("attached")),
        "setup_flag": bool(ssh._remote_setup_done),
        "setup_path": ssh._remote_virtuoso_setup_path,
        "reason": (runtime.attach_info or {}).get("reason"),
        "calls": dict(calls),
    }

out = {}
out["ready"] = attempt({"state": "ready", "signed": True, "auth": True})
out["no_listener"] = attempt({"state": "no-listener", "signed": False})
out["auth"] = attempt({"state": "auth", "signed": False})
out["automatic"] = attempt({"state": "ready", "signed": True, "auth": True}, discover=True)
print(json.dumps(out))
`
  const result = spawnSync(PYTHON, ['-c', script], {
    cwd: RUNTIME,
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: FIXTURES,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      VB_PLUGIN_DATA_DIR: dataDir,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  try {
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))
    assert.equal(out.ready.attached, true)
    assert.equal(out.ready.setup_flag, true)
    assert.match(out.ready.setup_path, /virtuoso_setup\.il$/)
    assert.equal(out.no_listener.attached, false)
    assert.equal(out.no_listener.setup_flag, false)
    assert.match(out.no_listener.reason, /no attachable daemon/)
    assert.equal(out.auth.attached, false)
    assert.equal(out.automatic.attached, false)
    assert.match(out.automatic.reason, /automatic session/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
