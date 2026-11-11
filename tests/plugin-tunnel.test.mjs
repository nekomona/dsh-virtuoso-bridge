import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The plugin-owned SSH tunnel shim: Python helpers must adopt the Host's
// ``ssh`` process (PID + local port) instead of starting their own forward,
// and must answer tunnel liveness from that PID without TCP-probing the port.
//
// Two kinds of evidence are used:
//   * an editable-source style fake package written into a temp directory,
//     to prove the installer patches whatever ``SSHClient`` class is imported;
//   * the plugin venv's real ``virtuoso_bridge`` package, to prove the patch
//     behaves correctly against the pinned upstream implementation.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNTIME = path.join(ROOT, 'runtime')
const PROFILE = 'dsh_tunnel'

const scratchDirs = []
function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** Run a probe with file-backed stdio (pipe-based spawns can be denied). */
function probeStdout(command, args, options = {}) {
  const runDir = scratch('vb-tunnel-probe-')
  const stdoutPath = path.join(runDir, 'stdout.txt')
  const stderrPath = path.join(runDir, 'stderr.txt')
  const stdoutFd = openSync(stdoutPath, 'w')
  const stderrFd = openSync(stderrPath, 'w')
  let result
  try {
    result = spawnSync(command, args, {
      ...options,
      stdio: ['ignore', stdoutFd, stderrFd],
      encoding: undefined,
    })
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
  return {
    status: result.status,
    error: result.error,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  }
}

function findPython() {
  for (const candidate of [process.env.VB_TEST_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const probe = probeStdout(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { timeout: 15_000 })
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate
  }
  return undefined
}

function findRealPython() {
  const candidates = [
    process.env.VB_TEST_VENV_PYTHON,
    path.join(process.env.USERPROFILE || '', '.dsh', 'virtuoso-bridge', 'default', 'venv', 'Scripts', 'python.exe'),
    path.join(process.env.HOME || '', '.dsh', 'virtuoso-bridge', 'default', 'venv', 'bin', 'python'),
    process.env.VB_TEST_PYTHON,
    'python3',
    'python',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = probeStdout(candidate, ['-c', 'import virtuoso_bridge.transport.tunnel as t; print(t.SSHClient.__name__)'], {
      timeout: 60_000,
    })
    if (probe.status === 0 && probe.stdout.trim() === 'SSHClient') return candidate
  }
  return undefined
}

const PYTHON = findPython()
const NO_PYTHON = PYTHON ? false : 'no python3 interpreter on PATH (set VB_TEST_PYTHON to one)'
const REAL_PYTHON = findRealPython()
const NO_REAL_PYTHON = REAL_PYTHON
  ? false
  : 'no interpreter with virtuoso_bridge is available (set VB_TEST_VENV_PYTHON to the plugin venv python)'

test.after(() => {
  for (const dir of scratchDirs.reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A child may still hold a handle on Windows; the OS reclaims it.
    }
  }
})

/** A hermetic environment for one helper process: no ambient VB_* values. */
function helperEnv({ pythonPath = RUNTIME, extra = {} } = {}) {
  const home = scratch('vb-tunnel-home-')
  const state = scratch('vb-tunnel-state-')
  const logs = scratch('vb-tunnel-logs-')
  const data = scratch('vb-tunnel-data-')
  const base = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: home,
    USERPROFILE: home,
    PYTHONPATH: pythonPath,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    VB_STATE_DIR: state,
    VB_LOG_DIR: logs,
    VB_PLUGIN_DATA_DIR: data,
    VB_PLUGIN_CACHE_DIR: data,
    VB_RUNTIME_PROFILE: PROFILE,
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) delete base[key]
    else base[key] = String(value)
  }
  // Drop undefined placeholders so spawn never sees an invalid env entry.
  for (const key of Object.keys(base)) {
    if (base[key] === undefined) delete base[key]
  }
  return base
}

function runPython(python, script, env) {
  // stdout/stderr go to files instead of pipes: a pipe-based spawn is denied in
  // some confined environments, and the helpers' JSON is the only output read.
  const runDir = scratch('vb-tunnel-run-')
  const stdoutPath = path.join(runDir, 'stdout.txt')
  const stderrPath = path.join(runDir, 'stderr.txt')
  const stdoutFd = openSync(stdoutPath, 'w')
  const stderrFd = openSync(stderrPath, 'w')
  let result
  try {
    result = spawnSync(python, ['-c', script], {
      cwd: RUNTIME,
      env,
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout: 180_000,
    })
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  }
}

function lastJson(result, label) {
  assert.equal(result.status, 0, `${label}: exit ${result.status}\n${result.stderr}\n${result.stdout}`)
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))
}

const FAKE_RUNNER = String.raw`
"""Fake SSHRunner: records whether anything tried to start or signal a forward."""

import os


def _pid_is_alive(pid):
    """In the fake package, the plugin PID is this process when it is us."""
    try:
        return int(pid) == os.getpid()
    except (TypeError, ValueError):
        return False


class SSHRunner:
    def __init__(self):
        self._tunnel_proc = None
        self._tunnel_pid = None
        self._tunnel_using_external = False
        self.starts = 0
        self.stops = 0
        self.signalled = []

    @property
    def tunnel_pid(self):
        if self._tunnel_proc is not None:
            return self._tunnel_pid
        return self._tunnel_pid

    @tunnel_pid.setter
    def tunnel_pid(self, value):
        self._tunnel_pid = value
        if value is not None:
            self._tunnel_using_external = True

    @property
    def is_tunnel_alive(self):
        return bool(self._tunnel_using_external and _pid_is_alive(self._tunnel_pid))

    def detach_port_forward(self):
        self._tunnel_proc = None
        self._tunnel_pid = None
        self._tunnel_using_external = False

    def stop_port_forward(self):
        self.stops += 1
        if self._tunnel_pid is not None:
            self.signalled.append(self._tunnel_pid)
        self._tunnel_pid = None
        self._tunnel_using_external = False

    def start_port_forward(self, port, settle=1.5, *, remote_port=None):
        self.starts += 1
        return None

    @staticmethod
    def can_reach_port(port):
        raise AssertionError("SSHRunner.can_reach_port was called")
`

const FAKE_TUNNEL = String.raw`
"""Fake SSHClient: the surface upstream provides and the shim patches."""

import os

from virtuoso_bridge.transport.ssh import SSHRunner


class SSHClient:
    def __init__(self, *, port=65432):
        self._port = int(port)
        self._local_port = int(port)
        self._ssh_runner = SSHRunner()
        self._tunnel_endpoint = None

    @property
    def port(self):
        return self._local_port

    @property
    def remote_port(self):
        return self._port

    @property
    def ssh_runner(self):
        return self._ssh_runner

    @property
    def is_tunnel_alive(self):
        runner = self._ssh_runner
        return bool(runner.is_tunnel_alive) and self._tunnel_endpoint == (
            self._local_port, self._port, runner.tunnel_pid)

    @classmethod
    def from_env(cls, *, keep_remote_files=False, profile=None, selected_port=None,
                 read_selection=True, replace_setup=False):
        return cls(port=selected_port or int(os.environ.get("VB_STUB_PORT", "65432")))

    def ensure_tunnel(self):
        self._ssh_runner.start_port_forward(self._local_port, remote_port=self._port)

    @staticmethod
    def _state_is_live(state):
        if not state:
            return False
        return bool(state.get("mode") == "remote"
                    and SSHRunner.can_reach_port(state.get("port")))

    def stop(self):
        self._ssh_runner.stop_port_forward()
        self._tunnel_endpoint = None
`

function writeFakePackage(dir) {
  const pkg = path.join(dir, 'virtuoso_bridge')
  mkdirSync(path.join(pkg, 'transport'), { recursive: true })
  writeFileSync(
    path.join(pkg, '__init__.py'),
    '"""Fake editable/vendored virtuoso_bridge source tree (test fixture)."""\n\n'
      + 'from virtuoso_bridge.transport.tunnel import SSHClient\n\n'
      + '__version__ = "0.0.0-fake-source"\n',
    'utf8',
  )
  writeFileSync(
    path.join(pkg, 'env.py'),
    'def set_runtime_env_file(path):\n    return path\n\n\ndef load_vb_env(*args, **kwargs):\n    return None\n',
    'utf8',
  )
  writeFileSync(path.join(pkg, 'transport', '__init__.py'), '', 'utf8')
  writeFileSync(path.join(pkg, 'transport', 'ssh.py'), FAKE_RUNNER, 'utf8')
  writeFileSync(path.join(pkg, 'transport', 'tunnel.py'), FAKE_TUNNEL, 'utf8')
  return dir
}

const FAKE_SCRIPT = String.raw`
import json, os
import vb_plugin_env as vpe
from virtuoso_bridge.transport.tunnel import SSHClient

# The fake package defines "alive" as "is this process", so the fake Host PID
# is this interpreter.  Setting it alone does not switch adoption on.
os.environ["VB_PLUGIN_TUNNEL_PID"] = str(os.getpid())
out = {"package": __import__("virtuoso_bridge").__version__}
config = vpe.plugin_tunnel_config()
out["config"] = None if config is None else config.as_dict()
out["install"] = vpe.install_plugin_tunnel()
out["isolated"] = os.path.basename(vpe.isolate_runtime_env())
out["marker"] = getattr(SSHClient, "_vb_plugin_tunnel_marker", None)
client = SSHClient.from_env(profile="dsh_tunnel")
out["local"] = client._local_port
out["remote"] = client.remote_port
out["endpoint"] = None if client._tunnel_endpoint is None else list(client._tunnel_endpoint)
out["runner_pid"] = client.ssh_runner.tunnel_pid
out["alive"] = client.is_tunnel_alive
out["starts"] = client.ssh_runner.starts
adopted = getattr(client, "_vb_plugin_tunnel", None)
out["adopted"] = None if adopted is None else adopted
try:
    client.ensure_tunnel()
    out["ensure"] = "returned"
except Exception as exc:
    out["ensure"] = type(exc).__name__ + ": " + str(exc)
out["starts_after_ensure"] = client.ssh_runner.starts
state = {"mode": "remote", "port": client._local_port, "remote_port": client.remote_port,
         "tunnel_pid": int(os.environ["VB_PLUGIN_TUNNEL_PID"])}
try:
    out["state_live"] = SSHClient._state_is_live(state)
except Exception as exc:
    out["state_live"] = type(exc).__name__ + ": " + str(exc)
client.stop()
out["after_stop"] = {
    "signalled": list(client.ssh_runner.signalled),
    "endpoint": None if client._tunnel_endpoint is None else list(client._tunnel_endpoint),
    "runner_pid": client.ssh_runner.tunnel_pid,
}
print(json.dumps(out))
`

test('the shim patches an editable/vendored SSHClient class, and is a no-op without the switch', { skip: NO_PYTHON }, () => {
  const fakeRoot = writeFakePackage(scratch('vb-tunnel-fake-'))
  const pythonPath = [fakeRoot, RUNTIME].join(path.delimiter)

  // Without the switch nothing is patched and upstream code still runs.
  const off = runPython(
    PYTHON,
    FAKE_SCRIPT,
    helperEnv({
      pythonPath,
      extra: {
        VB_STUB_PORT: '65081',
        VB_LOCAL_PORT_dsh_tunnel: '44444',
      },
    }),
  )
  const offOut = lastJson(off, 'fake package, switch off')
  assert.equal(offOut.package, '0.0.0-fake-source', 'the test must patch the fake source tree, not site-packages')
  assert.equal(offOut.config, null)
  assert.equal(offOut.install, null)
  assert.equal(offOut.marker, null, 'no switch must leave the class unpatched')
  assert.equal(offOut.endpoint, null)
  assert.equal(offOut.runner_pid, null)
  assert.equal(offOut.alive, false)
  assert.equal(offOut.starts_after_ensure, 1, 'upstream ensure_tunnel must still start a forward when not patched')
  assert.match(offOut.state_live, /AssertionError: SSHRunner.can_reach_port was called/,
    'upstream _state_is_live must still probe the port when not patched')

  // With the switch on the same (fake, editable) class is adopted in place.
  const on = runPython(
    PYTHON,
    FAKE_SCRIPT,
    helperEnv({
      pythonPath,
      extra: {
        VB_STUB_PORT: '65081',
        VB_LOCAL_PORT_dsh_tunnel: '44444',
        VB_PLUGIN_TUNNEL_OWNER: 'plugin',
        VB_PLUGIN_TUNNEL_LOCAL_PORT: '44555',
        VB_PLUGIN_TUNNEL_REMOTE_PORT: '65081',
      },
    }),
  )
  const onOut = lastJson(on, 'fake package, switch on')
  assert.equal(onOut.package, '0.0.0-fake-source')
  assert.equal(onOut.config.owner, 'plugin')
  assert.equal(onOut.config.localPort, 44555)
  assert.equal(onOut.config.remotePort, 65081)
  assert.ok(Number(onOut.config.pid) > 0)
  assert.equal(onOut.marker, 'plugin-tunnel-shim-v1')
  assert.ok(Array.isArray(onOut.install.patched) && onOut.install.patched.includes('SSHClient.from_env'))
  assert.ok(onOut.install.patched.includes('SSHRunner.stop_port_forward'))
  assert.equal(onOut.local, 44555, 'the plugin local port is authoritative')
  assert.deepEqual(onOut.endpoint, [44555, 65081, Number(onOut.config.pid)])
  assert.equal(onOut.runner_pid, Number(onOut.config.pid))
  assert.equal(onOut.alive, true)
  assert.equal(onOut.adopted.adopted, true)
  assert.equal(onOut.ensure, 'returned', 'ensure_tunnel must return while the plugin PID is alive')
  assert.equal(onOut.starts_after_ensure, 0, 'ensure_tunnel must not start a second forward')
  assert.equal(onOut.state_live, true, 'a matching saved PID is live without a port probe')
  assert.deepEqual(onOut.after_stop.signalled, [], 'stop() must never signal the plugin PID')
  assert.equal(onOut.after_stop.endpoint, null)
  assert.equal(onOut.after_stop.runner_pid, null)
})

test('without the switch upstream SSHClient behaviour is unchanged', { skip: NO_REAL_PYTHON }, () => {
  const script = String.raw`
import json, os
import vb_plugin_env as vpe
from virtuoso_bridge.transport import tunnel as T

calls = {"start": 0, "can_reach": 0}
T.SSHRunner.can_reach_port = staticmethod(
    lambda port: calls.__setitem__("can_reach", calls["can_reach"] + 1) or False)


def recording_start(self, port, settle=1.5, *, remote_port=None):
    calls["start"] += 1
    return None


T.SSHRunner.start_port_forward = recording_start

out = {"isolated": os.path.basename(vpe.isolate_runtime_env())}
out["config"] = vpe.plugin_tunnel_config()
out["install"] = vpe.install_plugin_tunnel()
out["marker"] = getattr(T.SSHClient, "_vb_plugin_tunnel_marker", None)
ssh = T.SSHClient.from_env(keep_remote_files=True, profile="dsh_tunnel")
out.update(
    local=ssh._local_port,
    port=ssh.port,
    remote=ssh.remote_port,
    endpoint=ssh._tunnel_endpoint,
    runner_pid=ssh.ssh_runner.tunnel_pid,
    alive=ssh.is_tunnel_alive,
    adopted=getattr(ssh, "_vb_plugin_tunnel", None),
)
try:
    ssh.ensure_tunnel()
    out["ensure"] = "returned"
except Exception as exc:
    out["ensure"] = type(exc).__name__ + ": " + str(exc)
out["calls"] = calls
print(json.dumps(out))
`
  const result = runPython(
    REAL_PYTHON,
    script,
    helperEnv({
      extra: {
        VB_LOCAL_PORT_dsh_tunnel: '44444',
        VB_REMOTE_PORT_dsh_tunnel: '65081',
        VB_REMOTE_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DAEMON_HOST_dsh_tunnel: 'fixture.invalid',
        VB_GUI_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DEPLOY_HOST_dsh_tunnel: 'fixture.invalid',
        VB_REMOTE_USER_dsh_tunnel: 'designer',
        VB_AUTO_SESSIONS_dsh_tunnel: '0',
      },
    }),
  )
  const out = lastJson(result, 'real upstream, switch off')
  assert.equal(out.config, null)
  assert.equal(out.install, null)
  assert.equal(out.marker, null)
  assert.equal(out.local, 44444, 'VB_LOCAL_PORT still decides the local port upstream')
  assert.equal(out.port, 44444)
  assert.equal(out.remote, 65081)
  assert.equal(out.endpoint, null)
  assert.equal(out.runner_pid, null)
  assert.equal(out.alive, false)
  assert.equal(out.adopted, null)
  assert.match(out.ensure, /No free local port found after 10 attempts/,
    'unpatched ensure_tunnel must still try to start its own forward')
  assert.equal(out.calls.start, 10)
  assert.equal(out.calls.can_reach, 10)
})

test('with the switch on from_env adopts the plugin PID and ensure_tunnel never probes or spawns', { skip: NO_REAL_PYTHON }, () => {
  const script = String.raw`
import json, os, subprocess
import vb_plugin_env as vpe
from virtuoso_bridge.transport import tunnel as T

os.environ["VB_PLUGIN_TUNNEL_PID"] = str(os.getpid())
out = {"install": vpe.install_plugin_tunnel()}
out["isolated"] = os.path.basename(vpe.isolate_runtime_env())
out["install_again"] = vpe.install_plugin_tunnel()
ssh = T.SSHClient.from_env(keep_remote_files=True, profile="dsh_tunnel")
out.update(
    local=ssh._local_port,
    port=ssh.port,
    remote=ssh.remote_port,
    endpoint=list(ssh._tunnel_endpoint or []),
    alive=ssh.is_tunnel_alive,
    runner_pid=ssh.ssh_runner.tunnel_pid,
    external=ssh.ssh_runner._tunnel_using_external,
    adopted=getattr(ssh, "_vb_plugin_tunnel", None),
    plugin_report=vpe.plugin_tunnel_report(),
)
calls = {"popen": 0, "can_reach": 0, "start": 0}
def forbidden_popen(*args, **kwargs):
    calls["popen"] += 1
    raise AssertionError("subprocess.Popen must not be called")
subprocess.Popen = forbidden_popen
T.SSHRunner.can_reach_port = staticmethod(
    lambda port: calls.__setitem__("can_reach", calls["can_reach"] + 1) or False)
T.SSHRunner.start_port_forward = (
    lambda self, port, settle=1.5, *, remote_port=None:
        calls.__setitem__("start", calls["start"] + 1))
out["ensure"] = ssh.ensure_tunnel()
out["calls_after_ensure"] = dict(calls)
state = {"mode": "remote", "port": ssh._local_port, "remote_port": ssh.remote_port,
         "tunnel_pid": os.getpid()}
out["state_live_matching"] = T.SSHClient._state_is_live(state)
out["calls_after_matching"] = dict(calls)
other = dict(state, tunnel_pid=os.getppid())
out["state_live_other"] = T.SSHClient._state_is_live(other)
out["calls_after_other"] = dict(calls)
ssh.save_state()
saved = T.SSHClient.read_state("dsh_tunnel", target=ssh.target) or {}
out["saved"] = {"mode": saved.get("mode"), "port": saved.get("port"),
                "remote_port": saved.get("remote_port"), "tunnel_pid": saved.get("tunnel_pid")}
ssh.close()
out["after_close"] = {"endpoint": list(ssh._tunnel_endpoint or []),
                      "runner_pid": ssh.ssh_runner.tunnel_pid,
                      "alive": ssh.is_tunnel_alive}
print(json.dumps(out))
`
  const result = runPython(
    REAL_PYTHON,
    script,
    helperEnv({
      extra: {
        VB_LOCAL_PORT_dsh_tunnel: '44444',
        VB_REMOTE_PORT_dsh_tunnel: '65081',
        VB_REMOTE_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DAEMON_HOST_dsh_tunnel: 'fixture.invalid',
        VB_GUI_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DEPLOY_HOST_dsh_tunnel: 'fixture.invalid',
        VB_REMOTE_USER_dsh_tunnel: 'designer',
        VB_AUTO_SESSIONS_dsh_tunnel: '0',
        VB_PLUGIN_TUNNEL_OWNER: 'plugin',
        VB_PLUGIN_TUNNEL_LOCAL_PORT: '44555',
        VB_PLUGIN_TUNNEL_REMOTE_PORT: '65081',
      },
    }),
  )
  const out = lastJson(result, 'real upstream, switch on')
  assert.equal(out.install.patched.length, 6)
  assert.deepEqual(out.install_again.patched, [], 'installation is idempotent')
  assert.equal(out.install_again.alreadyInstalled, true)
  assert.equal(out.local, 44555, 'VB_PLUGIN_TUNNEL_LOCAL_PORT overrides VB_LOCAL_PORT')
  assert.equal(out.port, 44555)
  assert.equal(out.remote, 65081)
  assert.equal(out.runner_pid, out.adopted.pid)
  assert.equal(out.external, true, 'the PID must be recorded as an external forward')
  assert.deepEqual(out.endpoint, [44555, 65081, out.adopted.pid])
  assert.equal(out.alive, true, 'is_tunnel_alive must answer from the plugin PID')
  assert.equal(out.adopted.adopted, true)
  assert.equal(out.adopted.remotePortMismatch, false)
  assert.equal(out.plugin_report.alive, true)
  assert.equal(out.plugin_report.localPort, 44555)
  assert.equal(out.ensure, null, 'ensure_tunnel returns while the plugin PID is alive')
  assert.deepEqual(out.calls_after_ensure, { popen: 0, can_reach: 0, start: 0 },
    'ensure_tunnel must neither spawn ssh nor probe the forwarded port')
  assert.equal(out.state_live_matching, true, 'a matching saved PID is live without a port probe')
  assert.deepEqual(out.calls_after_matching, { popen: 0, can_reach: 0, start: 0 })
  assert.equal(out.state_live_other, false, 'a different PID keeps upstream behaviour')
  assert.equal(out.calls_after_other.can_reach, 1, 'only the non-plugin state is port-probed')
  assert.equal(out.calls_after_other.popen, 0)
  assert.deepEqual(out.saved, {
    mode: 'remote',
    port: 44555,
    remote_port: 65081,
    tunnel_pid: out.adopted.pid,
  }, 'saved state must publish the plugin PID and its local port for sibling helpers')
  assert.deepEqual(out.after_close.endpoint, [44555, 65081, out.adopted.pid],
    'close() must stay as-is (it never stops the tunnel)')
  assert.equal(out.after_close.alive, true)
})

test('a declared remote-port mismatch is reported instead of silently re-pointing the client', { skip: NO_REAL_PYTHON }, () => {
  const script = String.raw`
import json, os
import vb_plugin_env as vpe
from virtuoso_bridge.transport import tunnel as T

os.environ["VB_PLUGIN_TUNNEL_PID"] = str(os.getpid())
vpe.isolate_runtime_env()
ssh = T.SSHClient.from_env(keep_remote_files=True, profile="dsh_tunnel")
adopted = getattr(ssh, "_vb_plugin_tunnel", None)
out = {
    "adopted": adopted,
    "endpoint": list(ssh._tunnel_endpoint or []),
    "ensure": ssh.ensure_tunnel(),
    "alive": ssh.is_tunnel_alive,
}
print(json.dumps(out))
`
  const result = runPython(
    REAL_PYTHON,
    script,
    helperEnv({
      extra: {
        VB_LOCAL_PORT_dsh_tunnel: '44444',
        VB_REMOTE_PORT_dsh_tunnel: '65081',
        VB_REMOTE_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DAEMON_HOST_dsh_tunnel: 'fixture.invalid',
        VB_GUI_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DEPLOY_HOST_dsh_tunnel: 'fixture.invalid',
        VB_REMOTE_USER_dsh_tunnel: 'designer',
        VB_AUTO_SESSIONS_dsh_tunnel: '0',
        VB_PLUGIN_TUNNEL_OWNER: 'plugin',
        VB_PLUGIN_TUNNEL_LOCAL_PORT: '44555',
        VB_PLUGIN_TUNNEL_REMOTE_PORT: '65082',
      },
    }),
  )
  const out = lastJson(result, 'real upstream, remote-port mismatch')
  assert.equal(out.adopted.remotePortMismatch, true)
  assert.equal(out.adopted.declaredRemotePort, 65082)
  assert.equal(out.adopted.remotePort, 65081, 'the client keeps its resolved daemon port')
  assert.deepEqual(out.endpoint, [44555, 65081, out.adopted.pid],
    'the endpoint describes the client daemon port, and the mismatch stays visible')
  assert.equal(out.ensure, null, 'liveness still decides, never a second tunnel')
  assert.equal(out.alive, true)
})

test('a dead plugin PID is reported from the PID and never replaced by a new tunnel', { skip: NO_REAL_PYTHON }, () => {
  const script = String.raw`
import json, os, subprocess, sys
import vb_plugin_env as vpe
from virtuoso_bridge.transport import tunnel as T
from virtuoso_bridge.transport.ssh import _pid_is_alive

dead = subprocess.Popen([sys.executable, "-c", "pass"])
dead.wait()
os.environ["VB_PLUGIN_TUNNEL_PID"] = str(dead.pid)
out = {"deadPid": dead.pid, "deadAlive": _pid_is_alive(dead.pid)}
out["isolated"] = os.path.basename(vpe.isolate_runtime_env())
out["marker"] = getattr(T.SSHClient, "_vb_plugin_tunnel_marker", None)
out["install"] = bool(vpe.install_plugin_tunnel())

calls = {"popen": 0, "can_reach": 0, "start": 0}
def forbidden_popen(*args, **kwargs):
    calls["popen"] += 1
    raise AssertionError("subprocess.Popen must not be called")
subprocess.Popen = forbidden_popen
T.SSHRunner.can_reach_port = staticmethod(
    lambda port: calls.__setitem__("can_reach", calls["can_reach"] + 1) or False)
T.SSHRunner.start_port_forward = (
    lambda self, port, settle=1.5, *, remote_port=None:
        calls.__setitem__("start", calls["start"] + 1))

ssh = T.SSHClient.from_env(keep_remote_files=True, profile="dsh_tunnel")
out["alive"] = ssh.is_tunnel_alive
out["endpoint"] = list(ssh._tunnel_endpoint or [])
out["report"] = vpe.plugin_tunnel_report()
try:
    ssh.ensure_tunnel()
    out["error"] = None
except RuntimeError as exc:
    out["error"] = str(exc)
out["calls"] = calls
print(json.dumps(out))
`
  const result = runPython(
    REAL_PYTHON,
    script,
    helperEnv({
      extra: {
        VB_LOCAL_PORT_dsh_tunnel: '44444',
        VB_REMOTE_PORT_dsh_tunnel: '65081',
        VB_REMOTE_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DAEMON_HOST_dsh_tunnel: 'fixture.invalid',
        VB_GUI_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DEPLOY_HOST_dsh_tunnel: 'fixture.invalid',
        VB_REMOTE_USER_dsh_tunnel: 'designer',
        VB_AUTO_SESSIONS_dsh_tunnel: '0',
        VB_PLUGIN_TUNNEL_OWNER: 'plugin',
        VB_PLUGIN_TUNNEL_LOCAL_PORT: '44555',
        VB_PLUGIN_TUNNEL_REMOTE_PORT: '65081',
      },
    }),
  )
  const out = lastJson(result, 'real upstream, dead plugin PID')
  assert.equal(out.deadAlive, false)
  assert.equal(out.marker, 'plugin-tunnel-shim-v1', 'isolate_runtime_env installs the shim automatically')
  assert.equal(out.install, true)
  assert.equal(out.alive, false, 'is_tunnel_alive reports the dead plugin PID')
  assert.equal(out.report.alive, false)
  assert.equal(
    out.error,
    `the DSH plugin tunnel (pid ${out.deadPid}) is no longer running; restart the runtime`,
  )
  assert.deepEqual(out.calls, { popen: 0, can_reach: 0, start: 0 },
    'a dead plugin tunnel must never be replaced by a Python-owned ssh.exe')
})

test('stop() clears state and closes runners without signalling the plugin PID', { skip: NO_REAL_PYTHON }, () => {
  const script = String.raw`
import json, os, subprocess, sys, time
import vb_plugin_env as vpe
from virtuoso_bridge.transport import tunnel as T
from virtuoso_bridge.transport.ssh import _pid_is_alive

tunnel_proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
try:
    os.environ["VB_PLUGIN_TUNNEL_PID"] = str(tunnel_proc.pid)
    out = {"tunnelPid": tunnel_proc.pid}
    out["isolated"] = os.path.basename(vpe.isolate_runtime_env())
    out["install"] = bool(vpe.install_plugin_tunnel())
    ssh = T.SSHClient.from_env(keep_remote_files=True, profile="dsh_tunnel")
    out["adopted"] = getattr(ssh, "_vb_plugin_tunnel", None)
    out["alive_before"] = ssh.is_tunnel_alive
    # A saved state naming the plugin PID is exactly what makes upstream stop()
    # re-adopt (and kill) that PID; the shim must survive this path.
    state = {
        "mode": "remote",
        "port": ssh._local_port,
        "remote_port": ssh.remote_port,
        "tunnel_pid": tunnel_proc.pid,
        "target": ssh.target,
        "remote_user": ssh.remote_user,
        "remote_host": ssh.remote_host,
        "daemon_host": ssh.daemon_host,
        "deploy_host": ssh.deploy_host,
        "gui_host": ssh.gui_host,
        "spectre_host": ssh.spectre_host,
        "setup_path": None,
        "identity_path": None,
        "profile": "dsh_tunnel",
        "started_at": 0,
    }
    T._write_private_json(T._state_file("dsh_tunnel", ssh.target), state)
    out["state_before"] = bool(T.SSHClient.read_state("dsh_tunnel", target=ssh.target))
    ssh.stop()
    time.sleep(0.5)
    out["tunnel_process_alive"] = _pid_is_alive(tunnel_proc.pid)
    out["tunnel_poll"] = tunnel_proc.poll()
    out["endpoint_after"] = list(ssh._tunnel_endpoint or [])
    out["runner_pid_after"] = ssh.ssh_runner.tunnel_pid
    out["runner_alive_after"] = ssh.ssh_runner.is_tunnel_alive
    out["state_after"] = T.SSHClient.read_state("dsh_tunnel", target=ssh.target)
finally:
    tunnel_proc.terminate()
    try:
        tunnel_proc.wait(timeout=5)
    except Exception:
        tunnel_proc.kill()
print(json.dumps(out))
`
  const result = runPython(
    REAL_PYTHON,
    script,
    helperEnv({
      extra: {
        VB_LOCAL_PORT_dsh_tunnel: '44444',
        VB_REMOTE_PORT_dsh_tunnel: '65081',
        VB_REMOTE_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DAEMON_HOST_dsh_tunnel: 'fixture.invalid',
        VB_GUI_HOST_dsh_tunnel: 'fixture.invalid',
        VB_DEPLOY_HOST_dsh_tunnel: 'fixture.invalid',
        VB_REMOTE_USER_dsh_tunnel: 'designer',
        VB_AUTO_SESSIONS_dsh_tunnel: '0',
        VB_PLUGIN_TUNNEL_OWNER: 'plugin',
        VB_PLUGIN_TUNNEL_LOCAL_PORT: '44555',
        VB_PLUGIN_TUNNEL_REMOTE_PORT: '65081',
      },
    }),
  )
  const out = lastJson(result, 'real upstream, stop()')
  assert.equal(out.alive_before, true)
  assert.equal(out.state_before, true)
  assert.equal(out.tunnel_process_alive, true, 'stop() must not signal the plugin-owned ssh process')
  assert.equal(out.tunnel_poll, null, 'the plugin tunnel process must still be running')
  assert.deepEqual(out.endpoint_after, [])
  assert.equal(out.runner_pid_after, null)
  assert.equal(out.runner_alive_after, false)
  assert.equal(out.state_after, null, 'stop() still clears the saved tunnel state')
})

test('a script body without connect() still gets the tunnel shim installed', { skip: NO_REAL_PYTHON }, () => {
  const dataDir = scratch('vb-script-shim-data-')
  const jobDir = scratch('vb-script-shim-job-')
  const context = {
    jobId: 'shim-job',
    profile: PROFILE,
    local: false,
    timeoutSec: 30,
    logToCiw: false,
    // The job deliberately never calls connect(): the body imports the client
    // itself, so only run-time isolation can prevent an upstream tunnel.
    autoConnect: false,
    dataDir,
    connection: {},
    t0Ms: 0,
  }
  writeFileSync(path.join(jobDir, 'context.json'), JSON.stringify(context), 'utf8')
  writeFileSync(
    path.join(jobDir, 'script.py'),
    [
      'import os',
      'from virtuoso_bridge.transport import tunnel as T',
      'result = {',
      '  "marker": getattr(T.SSHClient, "_vb_plugin_tunnel_marker", None),',
      '  "owner": os.environ.get("VB_PLUGIN_TUNNEL_OWNER"),',
      '}',
    ].join('\n'),
    'utf8',
  )
  const env = helperEnv({
    extra: {
      VB_PLUGIN_TUNNEL_OWNER: 'plugin',
      VB_PLUGIN_TUNNEL_PID: String(process.pid),
      VB_PLUGIN_TUNNEL_LOCAL_PORT: '44555',
      VB_PLUGIN_TUNNEL_REMOTE_PORT: '65081',
    },
  })
  const run = probeStdout(REAL_PYTHON, [path.join(RUNTIME, 'vb_script.py'), jobDir], {
    cwd: jobDir,
    env: { ...env, VB_PLUGIN_DATA_DIR: dataDir, VB_SCRIPT_JOB_DIR: jobDir },
    timeout: 180_000,
  })
  assert.equal(run.status, 0, `script helper failed:\n${run.stderr}\n${run.stdout}`)
  const result = JSON.parse(readFileSync(path.join(jobDir, 'result.json'), 'utf8'))
  assert.equal(result.marker, 'plugin-tunnel-shim-v1')
  assert.equal(result.owner, 'plugin')
})

test('the health helper never starts an upstream tunnel without a plugin forward', { skip: NO_REAL_PYTHON }, () => {
  const script = String.raw`
import json
import vb_health

class Forbidden:
    def read_daemon_token(self):
        raise AssertionError("read_daemon_token must not run without a Host tunnel")
    def ensure_tunnel(self):
        raise AssertionError("ensure_tunnel must not run without a Host tunnel")
    def _require_runner(self):
        raise AssertionError("runner must not be used without a Host tunnel")

out = vb_health._daemon_report(Forbidden(), 65081, 1)
print(json.dumps(out))
`
  const env = helperEnv()
  for (const key of ['VB_PLUGIN_TUNNEL_OWNER', 'VB_PLUGIN_TUNNEL_PID', 'VB_LOCAL_PORT', 'VB_LOCAL_PORT_dsh_tunnel']) {
    delete env[key]
  }
  const result = runPython(REAL_PYTHON, script, env)
  const out = lastJson(result, 'vb_health without a Host tunnel')
  assert.equal(out.state, 'no-forward')
  assert.equal(out.checked, true)
})

test('the health helper probes through an adopted Host tunnel', { skip: NO_REAL_PYTHON }, () => {
  const script = String.raw`
import json
import vb_daemon_probe
import vb_health

calls = {"ensure": 0, "stop": 0}

class FakeRunner:
    def stop_port_forward(self):
        calls["stop"] += 1

class Adopted:
    def read_daemon_token(self):
        return None
    def ensure_tunnel(self):
        calls["ensure"] += 1
    def _require_runner(self):
        return FakeRunner()

vb_daemon_probe.probe_tunnel_daemon = lambda port, token, timeout: {
    "state": "ready", "port": port, "signed": True, "checked": True
}
out = vb_health._daemon_report(Adopted(), 65081, 1)
out["calls"] = calls
print(json.dumps(out))
`
  const env = helperEnv({
    extra: {
      VB_PLUGIN_TUNNEL_OWNER: 'plugin',
      VB_PLUGIN_TUNNEL_PID: String(process.pid),
      VB_PLUGIN_TUNNEL_LOCAL_PORT: '44555',
      VB_PLUGIN_TUNNEL_REMOTE_PORT: '65081',
    },
  })
  const result = runPython(REAL_PYTHON, script, env)
  const out = lastJson(result, 'vb_health with an adopted Host tunnel')
  assert.equal(out.state, 'ready')
  assert.equal(out.calls.ensure, 1, 'adoption is validated through ensure_tunnel')
  assert.equal(out.calls.stop, 1, 'the helper detaches its adopted forward on exit')
})
