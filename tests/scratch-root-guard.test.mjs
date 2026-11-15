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

test('a configured tilde scratch root is normalised before a client computes a path', { skip: NO_PYTHON }, () => {
  const script = String.raw`
import json, os
from vb_plugin_env import ScratchRootError, normalize_client_scratch_root

class Result:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr

class Runner:
    def __init__(self, home="/home/username", resolved="/home/username/.virtuoso-bridge", home_ok=True):
        self.home = home
        self.resolved = resolved
        self.home_ok = home_ok
        self.commands = []
    def run_command(self, command, timeout=None):
        self.commands.append(command)
        if "getent passwd" in command:
            if not self.home_ok:
                return Result("", 1, "Host key verification failed.")
            return Result(self.home + "\n")
        if "readlink -f" in command:
            return Result(self.resolved + "\n")
        return Result("")

def run(root, runner, profile="dsh_lab"):
    os.environ["VB_REMOTE_SCRATCH_ROOT"] = root
    os.environ.pop("VB_REMOTE_SCRATCH_ROOT_dsh_lab", None)
    ssh = type("SSH", (), {})()
    if runner is not None:
        ssh.deployment_runner = runner
    try:
        value = normalize_client_scratch_root(ssh, profile)
        return {
            "ok": True,
            "value": value,
            "env": os.environ.get("VB_REMOTE_SCRATCH_ROOT"),
            "profileEnv": os.environ.get("VB_REMOTE_SCRATCH_ROOT_dsh_lab"),
            "commands": runner.commands if runner is not None else [],
        }
    except ScratchRootError as error:
        return {
            "ok": False,
            "code": error.code,
            "message": str(error),
            "path": error.path,
            "hint": error.hint,
            "commands": runner.commands if runner is not None else [],
        }

out = {}
out["tilde"] = run("~/.virtuoso-bridge", Runner())
out["absolute"] = run("/opt/virtuoso", Runner())
out["empty"] = run("", Runner())
out["relative"] = run("scratch", Runner())
out["no_runner"] = run("~/.virtuoso-bridge", None)
out["home_failure"] = run("~/.virtuoso-bridge", Runner(home_ok=False))
print(json.dumps(out))
`
  const result = spawnSync(PYTHON, ['-c', script], {
    cwd: RUNTIME,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))

  // (a) ~/.virtuoso-bridge becomes the remote account home; the environment is
  // rewritten so every later helper derives the same absolute work dir.
  assert.equal(out.tilde.ok, true)
  assert.equal(out.tilde.value, '/home/username/.virtuoso-bridge')
  assert.equal(out.tilde.env, '/home/username/.virtuoso-bridge')
  assert.equal(out.tilde.profileEnv, '/home/username/.virtuoso-bridge')
  assert.ok(out.tilde.commands.some((command) => command.includes('getent passwd')))
  assert.ok(out.tilde.commands.some((command) => command.includes('readlink -f')))

  // (b) an absolute root is already correct and costs no remote command.
  assert.equal(out.absolute.value, '/opt/virtuoso')
  assert.equal(out.absolute.env, '/opt/virtuoso')
  assert.deepEqual(out.absolute.commands, [])

  // An unset root keeps the upstream /tmp default.
  assert.equal(out.empty.value, '')

  // (d) a relative root can never become an absolute remote path.
  assert.equal(out.relative.ok, false)
  assert.equal(out.relative.code, 'scratch-root-invalid')
  assert.equal(out.relative.path, 'scratch')
  // It is rejected before any canonicalisation command runs.
  assert.equal(out.relative.commands.some((command) => command.includes('readlink -f')), false)

  // (c) local mode has no remote home: the value is left exactly as configured.
  assert.equal(out.no_runner.value, '~/.virtuoso-bridge')
  assert.equal(out.no_runner.env, '~/.virtuoso-bridge')

  // A home that cannot be resolved reports one stable code, never a bare error.
  assert.equal(out.home_failure.ok, false)
  assert.equal(out.home_failure.code, 'scratch-root-home')
  assert.equal(out.home_failure.path, '~/.virtuoso-bridge')
  assert.match(out.home_failure.hint, /absolute remoteScratchRoot/)
})

test('the scratch-root guard installs once and runs through SSHClient.from_env', { skip: NO_PYTHON }, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'vb-scratch-guard-'))
  const script = String.raw`
import json, os
from vb_plugin_env import SCRATCH_ROOT_PATCH_MARKER, install_scratch_root_guard
from virtuoso_bridge.transport.tunnel import SSHClient

class Result:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr

class Runner:
    def __init__(self):
        self.commands = []
    def run_command(self, command, timeout=None):
        self.commands.append(command)
        if "getent passwd" in command:
            return Result("/home/username\n")
        if "readlink -f" in command:
            return Result("/home/username/.virtuoso-bridge\n")
        return Result("")

class RemoteClient(SSHClient):
    # A remote-shaped client so the guard sees the deployment runner the real
    # helper attaches; the fixture constructor alone stays local.
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.deployment_runner = Runner()

first = install_scratch_root_guard()
second = install_scratch_root_guard()

os.environ["VB_REMOTE_SCRATCH_ROOT"] = "~/.virtuoso-bridge"
os.environ.pop("VB_REMOTE_SCRATCH_ROOT_dsh_guard", None)
client = RemoteClient.from_env(profile="dsh_guard")

print(json.dumps({
    "marker": getattr(SSHClient, "_vb_scratch_root_marker", None),
    "expectedMarker": SCRATCH_ROOT_PATCH_MARKER,
    "first": first,
    "second": second,
    "isClassmethod": isinstance(SSHClient.__dict__.get("from_env"), classmethod),
    "isRemoteClient": isinstance(client, RemoteClient),
    "env": os.environ.get("VB_REMOTE_SCRATCH_ROOT"),
    "profileEnv": os.environ.get("VB_REMOTE_SCRATCH_ROOT_dsh_guard"),
    "commands": client.deployment_runner.commands,
}))
`
  const result = spawnSync(PYTHON, ['-c', script], {
    cwd: RUNTIME,
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: FIXTURES,
      HOME: home,
      USERPROFILE: home,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  try {
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))

    // (e) idempotent: the second call reports installed and never re-wraps, so
    // the marker still names this guard and from_env stays a classmethod.
    assert.equal(out.first, true)
    assert.equal(out.second, true)
    assert.equal(out.marker, 'scratch-root-guard-v1')
    assert.equal(out.marker, out.expectedMarker)
    assert.equal(out.isClassmethod, true)

    // The wrapper calls the captured factory with the same cls and normalises
    // the client it returned, rewriting the environment for later helpers.
    assert.equal(out.isRemoteClient, true)
    assert.equal(out.env, '/home/username/.virtuoso-bridge')
    assert.equal(out.profileEnv, '/home/username/.virtuoso-bridge')
    assert.ok(out.commands.some((command) => command.includes('getent passwd')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
