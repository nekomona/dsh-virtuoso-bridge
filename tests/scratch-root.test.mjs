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

function scratch(prefix = 'vb-scratch-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

test('scratch root preparation creates missing home roots, refuses foreign ones and classifies failures', { skip: NO_PYTHON }, () => {
  const dataDir = scratch()
  const script = String.raw`
import json, os, sys
sys.path.insert(0, os.getcwd())
from vb_plugin_env import ScratchRootError, classify_deployment_failure, ensure_scratch_root

class Result:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr

class Runner:
    def __init__(self, kind="MISSING", owner="1000", mode="755"):
        self.kind = kind
        self.owner = owner
        self.mode = mode
        self.commands = []
        self.path = ""
    def run_command(self, command, timeout=None):
        self.commands.append(command)
        if "getent passwd" in command:
            return Result("/home/username\n")
        if command.startswith("id -u"):
            return Result("1000\n")
        if "readlink -f" in command:
            import re
            match = re.search(r"readlink -f -- ([^ ]+)", command)
            return Result((match.group(1) if match else os.environ["VB_TEST_ROOT"]) + "\n")
        if "printf 'KIND" in command:
            parent = "/home/username" if os.environ["VB_TEST_ROOT"].startswith("/home/") else "/tmp"
            return Result(
                "KIND %s\nOWNER %s\nMODE %s\nPARENT %s\nPARENTKIND DIR\nWRITABLE %s\nPARENTWRITABLE yes\n"
                % (self.kind, self.owner, self.mode, parent, "yes" if self.kind == "DIR" else "no")
            )
        if "mkdir -p -m 700" in command:
            self.kind = "DIR"
            self.owner = "1000"
            self.mode = "700"
            return Result("")
        if "chmod 700" in command:
            self.mode = "700"
            return Result("")
        if "[ -e" in command:
            return Result(os.environ.get("VB_TEST_SIBLING", ""))
        return Result("")

def run(root, discover, kind="MISSING", owner="1000", mode="755", sibling=""):
    os.environ["VB_REMOTE_SCRATCH_ROOT"] = root
    os.environ["VB_TEST_ROOT"] = root.replace("~/", "/home/username/")
    os.environ["VB_TEST_SIBLING"] = sibling
    runner = Runner(kind, owner, mode)
    ssh = type("SSH", (), {"_discover_instances": discover, "deployment_runner": runner})()
    try:
        info = ensure_scratch_root(ssh, "prof")
        return {"ok": True, "info": info, "commands": runner.commands, "env": os.environ.get("VB_REMOTE_SCRATCH_ROOT")}
    except ScratchRootError as error:
        return {"ok": False, "code": error.code, "message": str(error), "hint": error.hint, "commands": runner.commands}

out = {}
out["missing_home"] = run("~/.virtuoso_bridge", False)
out["missing_home_hint"] = run("~/.virtuoso_bridge", False, sibling="/home/username/.virtuoso-bridge")
out["missing_outside"] = run("/scratch/foreign-root", False)
out["symlink"] = run("~/.virtuoso_bridge", False, kind="SYMLINK")
out["owner"] = run("~/.virtuoso_bridge", False, kind="DIR", owner="1001", mode="700")
out["tighten"] = run("~/.virtuoso_bridge", False, kind="DIR", owner="1000", mode="755")
out["tmp_auto"] = run("/tmp", True, kind="MISSING")
out["classify_enoent"] = classify_deployment_failure(RuntimeError("Refusing to deploy: No such file or directory"), {"prepareRoot": "/home/username/.virtuoso_bridge", "home": "/home/username"})
out["classify_symlink"] = classify_deployment_failure(RuntimeError("remote scratch directory is a symlink"), {})
out["classify_owner"] = classify_deployment_failure(RuntimeError("remote scratch directory has wrong owner"), {})
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

    assert.equal(out.missing_home.ok, true)
    assert.equal(out.missing_home.info.created, true)
    assert.equal(out.missing_home.info.root, '/home/username/.virtuoso_bridge')
    assert.equal(out.missing_home.info.prepared, true)
    assert.ok(out.missing_home.commands.some((command) => command.includes('mkdir -p -m 700')))

    assert.equal(out.missing_home_hint.info.suggestion, '/home/username/.virtuoso-bridge')
    assert.match(out.missing_home_hint.info.warning, /'_' vs '-'/)

    assert.equal(out.missing_outside.ok, false)
    assert.equal(out.missing_outside.code, 'scratch-root-missing')
    assert.match(out.missing_outside.hint, /mkdir -p -m 700/)
    assert.equal(out.missing_outside.commands.some((command) => command.includes('mkdir -p -m 700')), false)

    assert.equal(out.symlink.code, 'scratch-root-symlink')
    assert.equal(out.owner.code, 'scratch-root-owner')
    assert.equal(out.tighten.info.tightened, true)
    assert.equal(out.tighten.info.mode, '700')

    assert.equal(out.tmp_auto.info.root, '/tmp')
    assert.equal(out.tmp_auto.info.publishRoot, '/tmp/virtuoso_bridge_fixture')
    assert.equal(out.tmp_auto.env, '/tmp')
    assert.equal(out.tmp_auto.info.created, true)

    assert.equal(out.classify_enoent.code, 'scratch-root-missing')
    assert.match(out.classify_enoent.hint, /mkdir -p -m 700/)
    assert.equal(out.classify_symlink.code, 'scratch-root-symlink')
    assert.equal(out.classify_owner.code, 'scratch-root-owner')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
