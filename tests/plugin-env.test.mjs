import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeChildEnv, envForProfile, isPathInside } from '../lib/util.js'

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

const scratchDirs = []
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vb-plugin-env-'))
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

test('foreign interpreter and upstream variables never reach a helper process', () => {
  const base = {
    PATH: '/usr/bin',
    USERNAME: 'local-user',
    HOME: '/home/username',
    PYTHONPATH: '/home/username/virtuoso-bridge/src',
    PYTHONHOME: '/home/username/virtuoso-bridge/venv',
    PYTHONSTARTUP: '/home/username/startup.py',
    VIRTUAL_ENV: '/home/username/virtuoso-bridge/venv',
    VIRTUAL_ENV_PROMPT: '(virtuoso-bridge)',
    VB_PROFILE: 'other',
    VB_REMOTE_HOST: 'other.example',
    VB_REMOTE_SCRATCH_ROOT: '/other-install/scratch',
    VB_CLIENT_ID: 'other-client',
    VB_KNOWN_HOSTS: '/other-install/known_hosts',
    VB_FORCE_VENDOR_SRC: '1',
  }
  const env = bridgeChildEnv(base)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.USERNAME, 'local-user')
  assert.equal(env.HOME, '/home/username')
  for (const key of [
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONSTARTUP',
    'VIRTUAL_ENV',
    'VIRTUAL_ENV_PROMPT',
    'VB_PROFILE',
    'VB_REMOTE_HOST',
    'VB_REMOTE_SCRATCH_ROOT',
    'VB_CLIENT_ID',
    'VB_KNOWN_HOSTS',
    'VB_FORCE_VENDOR_SRC',
  ]) {
    assert.equal(env[key], undefined, `${key} must not leak into a bridge helper`)
  }
})

test('a saved connection stays authoritative over ambient VB_* values', () => {
  const saved = {
    host: 'lab.example',
    user: 'designer',
    sshPort: 22,
    sshBackend: 'openssh',
    envShell: 'sh',
    extraEnv: {},
  }
  const mutations = {
    VB_REMOTE_HOST: 'other.example',
    VB_REMOTE_SCRATCH_ROOT: '/other-install/scratch',
    VB_CLIENT_ID: 'other-client',
    PYTHONPATH: '/home/username/virtuoso-bridge/src',
  }
  const previous = Object.fromEntries(Object.keys(mutations).map((key) => [key, process.env[key]]))
  Object.assign(process.env, mutations)
  try {
    const env = envForProfile(saved, 'dsh_lab')
    assert.equal(env.VB_REMOTE_HOST_dsh_lab, 'lab.example')
    assert.equal(env.VB_REMOTE_USER_dsh_lab, 'designer')
    assert.equal(env.VB_REMOTE_SCRATCH_ROOT_dsh_lab, undefined)
    assert.equal(env.VB_CLIENT_ID_dsh_lab, undefined)
    assert.equal(env.PYTHONPATH, undefined)
    // Only profile-scoped names are written: an unsuffixed ambient value can
    // never be picked up as a fallback by the upstream client.
    assert.equal(env.VB_REMOTE_HOST, undefined)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('isPathInside accepts the root and its children, never a sibling prefix', () => {
  const root = path.resolve('/tmp/vb-venv')
  assert.equal(isPathInside(path.join(root, 'Lib', 'site-packages'), root), true)
  assert.equal(isPathInside(root, root), true)
  assert.equal(isPathInside(`${root}-other`, root), false)
  assert.equal(isPathInside('', root), false)
})

test('helpers isolate the upstream .env loader with the plugin empty env file', { skip: NO_PYTHON }, () => {
  const dataDir = scratch()
  const home = scratch()
  mkdirSync(path.join(home, '.virtuoso-bridge'), { recursive: true })
  writeFileSync(
    path.join(home, '.virtuoso-bridge', '.env'),
    'VB_REMOTE_SCRATCH_ROOT=/from-the-other-install\nVB_DAEMON_SETUP=/other/virtuoso_setup.il\n',
    'utf8',
  )
  const callLog = path.join(dataDir, 'calls.jsonl')
  const setupPath = path.join('/configured/scratch', 'daemon', 'virtuoso_setup.il')
  const env = {
    PATH: process.env.PATH,
    PYTHONPATH: FIXTURES,
    HOME: home,
    USERPROFILE: home,
    VB_PLUGIN_DATA_DIR: dataDir,
    VB_REMOTE_SCRATCH_ROOT: '/configured/scratch',
    VB_RUNTIME_PROFILE: 'dsh_lab',
    VB_STUB_CALL_LOG: callLog,
    VB_STUB_SETUP_PATH: setupPath,
  }
  const run = spawnSync(
    PYTHON,
    [path.join(RUNTIME, 'vb_deploy.py'), '--profile', 'dsh_lab'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 },
  )
  assert.equal(run.status, 0, run.stderr)
  const payload = JSON.parse(run.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))
  assert.equal(payload.ok, true)
  assert.equal(payload.setupPath, setupPath)

  const calls = readFileSync(callLog, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const isolation = calls.find((call) => call.kind === 'set_runtime_env_file')
  assert.ok(isolation, 'the deploy helper must configure the runtime env file before importing the client')
  assert.equal(isolation.exists, true)
  assert.equal(path.basename(isolation.path), 'empty.env')
  assert.equal(path.dirname(isolation.path), dataDir)

  const fromEnv = calls.find((call) => call.kind === 'ssh_from_env')
  assert.equal(fromEnv.scratch, '/configured/scratch', 'the other install .env must not replace the saved scratch root')
  const load = calls.find((call) => call.kind === 'load_vb_env')
  assert.equal(load.applied, false, 'the upstream .env load must be a no-op')
  // Show the resolved absolute root next to the configured value. A POSIX
  // remote path is kept as-is on a Windows client (local mode ignores it).
  assert.equal(payload.scratchRoot, '/configured/scratch')
  assert.equal(payload.remoteScratchRoot, '/configured/scratch')
})

test('instance discovery and the SSH test also isolate the upstream .env', { skip: NO_PYTHON }, () => {
  for (const script of ['vb_instances.py', 'vb_ssh_test.py']) {
    const dataDir = scratch()
    const home = scratch()
    mkdirSync(path.join(home, '.virtuoso-bridge'), { recursive: true })
    writeFileSync(path.join(home, '.virtuoso-bridge', '.env'), 'VB_REMOTE_SCRATCH_ROOT=/from-the-other-install\n', 'utf8')
    const callLog = path.join(dataDir, 'calls.jsonl')
    const run = spawnSync(
      PYTHON,
      [path.join(RUNTIME, script), '--profile', 'dsh_lab'],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: FIXTURES,
          HOME: home,
          USERPROFILE: home,
          VB_PLUGIN_DATA_DIR: dataDir,
          VB_REMOTE_SCRATCH_ROOT: '/configured/scratch',
          VB_STUB_CALL_LOG: callLog,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    )
    assert.equal(run.status, 0, `${script}: ${run.stderr}`)
    const calls = readFileSync(callLog, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const isolation = calls.find((call) => call.kind === 'set_runtime_env_file')
    assert.ok(isolation, `${script} must configure the runtime env file`)
    assert.equal(path.basename(isolation.path), 'empty.env')
    const fromEnv = calls.find((call) => call.kind === 'ssh_from_env')
    assert.equal(fromEnv.scratch, '/configured/scratch')
    const load = calls.find((call) => call.kind === 'load_vb_env')
    assert.equal(load.applied, false)
  }
})

test('the remote scratch root is resolved and prepared as a private directory', { skip: NO_PYTHON }, () => {
  const script = `
import json, os
from vb_plugin_env import prepare_scratch_root

class Result:
    def __init__(self, stdout=""):
        self.returncode = 0
        self.stdout = stdout
        self.stderr = ""

class Runner:
    def __init__(self):
        self.commands = []
        self.existing = {}
    def _paths(self, command):
        return [p for p in ("/home/username/.scratch", "/tmp/virtuoso_bridge_fixture") if p in command]
    def run_command(self, command, timeout=None):
        self.commands.append(command)
        if "getent passwd" in command:
            return Result("/home/username\\n")
        if command.startswith("id -u"):
            return Result("1000\\n")
        if "printf 'KIND" in command or "printf 'KIND %s" in command or "KIND %s\\n" in command:
            paths = self._paths(command)
            path = paths[0] if paths else ""
            if path in self.existing:
                return Result(
                    "KIND DIR\\nOWNER 1000\\nMODE %s\\nPARENT %s\\nPARENTKIND DIR\\nWRITABLE yes\\nPARENTWRITABLE yes\\n"
                    % (self.existing[path], "/home/username" if path.startswith("/home") else "/tmp")
                )
            parent = "/home/username" if path.startswith("/home") else "/tmp"
            return Result(
                "KIND MISSING\\nOWNER \\nMODE \\nPARENT %s\\nPARENTKIND DIR\\nWRITABLE no\\nPARENTWRITABLE yes\\n" % parent
            )
        if "mkdir -p -m 700" in command:
            for path in self._paths(command):
                self.existing[path] = "700"
            return Result("")
        if "chmod 700" in command:
            for path in self._paths(command):
                self.existing[path] = "700"
            return Result("")
        if "readlink -f" in command:
            paths = self._paths(command)
            return Result((paths[0] if paths else "") + "\\n")
        return Result("")

ssh = type("SSH", (), {"_discover_instances": True, "deployment_runner": Runner()})()
os.environ["VB_REMOTE_SCRATCH_ROOT"] = "~/.scratch/"
os.environ["VB_PLUGIN_DATA_DIR"] = os.environ["VB_STUB_DATA"]
info = prepare_scratch_root(ssh, "dsh_lab")
tmp_ssh = type("SSH", (), {"_discover_instances": True, "deployment_runner": Runner()})()
os.environ["VB_REMOTE_SCRATCH_ROOT"] = "/tmp"
tmp_info = prepare_scratch_root(tmp_ssh, "dsh_lab")
print(json.dumps({
    "info": info,
    "env": os.environ.get("VB_REMOTE_SCRATCH_ROOT"),
    "tmp_info": tmp_info,
    "commands": ssh.deployment_runner.commands,
}))
`
  const dataDir = scratch()
  const run = spawnSync(PYTHON, ['-c', script], {
    cwd: RUNTIME,
    env: { PATH: process.env.PATH, PYTHONPATH: FIXTURES, HOME: scratch(), USERPROFILE: process.env.USERPROFILE, VB_STUB_DATA: dataDir },
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(run.status, 0, run.stderr)
  const output = JSON.parse(run.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))
  assert.equal(output.info.root, '/home/username/.scratch')
  assert.equal(output.info.publishRoot, '/home/username/.scratch')
  assert.equal(output.info.prepared, true)
  // The upstream default /tmp must stay in the environment: upstream derives
  // /tmp/virtuoso_bridge_<user> itself for every helper.
  assert.equal(output.tmp_info.root, '/tmp')
  assert.equal(output.tmp_info.publishRoot, '/tmp/virtuoso_bridge_fixture')
  assert.equal(output.env, '/tmp')
})
