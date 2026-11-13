import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MAX_SCRIPT_BYTES,
  describeScriptSource,
  readScriptSource,
  resolveScriptPath,
} from '../lib/script-source.js'
import { registerTools } from '../lib/tools.js'

const scratchDirs = []
function scratch(prefix = 'vb-script-input-') {
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

test('inline code needs no file', async () => {
  const source = await readScriptSource({ code: 'result = 1\n' })
  assert.equal(source.code, 'result = 1\n')
  assert.deepEqual(source.source, { kind: 'inline' })
  assert.equal(describeScriptSource(source.source), 'inline')
})

test('a relative path resolves against the Session working directory', async () => {
  const cwd = scratch()
  writeFileSync(path.join(cwd, 'batch.py'), 'result = {"ok": True}\n', 'utf8')
  const source = await readScriptSource({ filePath: 'batch.py', cwd })
  assert.equal(source.code, 'result = {"ok": True}\n')
  assert.deepEqual(source.source, { kind: 'file', path: path.join(cwd, 'batch.py') })
  assert.equal(describeScriptSource(source.source), 'batch.py')
})

test('an absolute path is used as given', async () => {
  const cwd = scratch()
  const target = path.join(cwd, 'abs.py')
  writeFileSync(target, 'result = 2\n', 'utf8')
  const source = await readScriptSource({ filePath: target })
  assert.equal(source.source.path, target)
  assert.equal(source.code, 'result = 2\n')
})

test('resolveScriptPath leaves absolute paths alone and normalizes relative ones', () => {
  const cwd = path.join('root', 'workspace')
  assert.equal(resolveScriptPath(path.resolve('C:/x/y.py')), path.resolve('C:/x/y.py'))
  assert.equal(resolveScriptPath('  sub/../batch.py  ', cwd), path.resolve(cwd, 'batch.py'))
})

test('a missing file reports the resolved path', async () => {
  const cwd = scratch()
  await assert.rejects(
    readScriptSource({ filePath: 'nope.py', cwd }),
    (error) => {
      assert.match(error.message, /script file not found/)
      assert.ok(error.message.includes(path.join(cwd, 'nope.py')), error.message)
      return true
    },
  )
})

test('code and path are mutually exclusive', async () => {
  await assert.rejects(
    readScriptSource({ code: 'result = 1\n', filePath: 'batch.py' }),
    /either code or path/,
  )
})

test('a run with neither source is rejected', async () => {
  await assert.rejects(readScriptSource({}), /script code is empty/)
})

test('a directory is not a script file', async () => {
  const cwd = scratch()
  mkdirSync(path.join(cwd, 'jobs'))
  await assert.rejects(readScriptSource({ filePath: 'jobs', cwd }), /not a regular file/)
})

test('an empty file is rejected', async () => {
  const cwd = scratch()
  writeFileSync(path.join(cwd, 'empty.py'), '   \n\n', 'utf8')
  await assert.rejects(readScriptSource({ filePath: 'empty.py', cwd }), /script file is empty/)
})

test('an oversized file is rejected before its body is read', async () => {
  const cwd = scratch()
  writeFileSync(path.join(cwd, 'huge.py'), 'x', 'utf8')
  let read = false
  await assert.rejects(
    readScriptSource({
      filePath: 'huge.py',
      cwd,
      stat: async () => ({ isFile: () => true, size: MAX_SCRIPT_BYTES + 1 }),
      readFile: async () => {
        read = true
        return 'x'
      },
    }),
    /too large/,
  )
  assert.equal(read, false)
})

test('the script tool passes the agent working directory to the run', async () => {
  const workspace = scratch()
  const registrations = []
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => workspace }
      return undefined
    },
  }
  let captured
  const manager = {
    ready: Promise.resolve(),
    setup: {},
    async runScript(options) {
      captured = options
      return { state: 'succeeded', result: { ok: true } }
    },
  }
  registerTools({ ctx, manager, log: () => {} })
  const tool = registrations.find((definition) => definition.name === 'virtuoso_bridge_script')
  assert.ok(tool, 'the script tool is registered')
  const output = await tool.execute(
    { action: 'run', description: 'Run a workspace file', path: 'batch.py' },
    { agent: { id: 'agent-1' } },
  )
  assert.equal(captured.filePath, 'batch.py')
  assert.equal(captured.cwd, workspace)
  assert.match(String(output), /^Success/)
})

test('without a live agent the script tool falls back to the process directory', async () => {
  const registrations = []
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
  }
  let captured
  const manager = {
    ready: Promise.resolve(),
    setup: {},
    async runScript(options) {
      captured = options
      return { state: 'succeeded', result: { ok: true } }
    },
  }
  registerTools({ ctx, manager, log: () => {} })
  const tool = registrations.find((definition) => definition.name === 'virtuoso_bridge_script')
  await tool.execute({ action: 'run', description: 'Run a file', path: 'batch.py' }, {})
  assert.equal(captured.cwd, process.cwd())
})
