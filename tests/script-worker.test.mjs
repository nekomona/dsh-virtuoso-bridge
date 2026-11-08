import assert from 'node:assert/strict'
import test, { after as afterAll } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FIXTURES = path.join(HERE, 'fixtures')
const CLASSIC_RUNNER = path.join(ROOT, 'runtime', 'vb_script.py')
const WORKER = path.join(ROOT, 'runtime', 'vb_script_worker.py')
const HAS_WORKER = existsSync(WORKER)

// Status states the runner defines; a job directory may end in any of them.
const JOB_STATES = new Set(['running', 'succeeded', 'failed', 'timeout', 'cancelled'])
// Keys that legitimately differ between two runs of the same script.
const VOLATILE_EVENT_KEYS = new Set([
  'time',
  'elapsedSeconds',
  'connectSeconds',
  'tunnelReused',
  'reusedTunnelPort',
  'sessionSetup',
  'phase',
])

/**
 * The tests need a Python 3 interpreter. They never use the plugin venv: the
 * fixture package on PYTHONPATH is all the runner may import, so nothing here
 * reads the user's store, ~/.dsh, or the network.
 */
function findPython() {
  const candidates = [process.env.VB_TEST_PYTHON, 'python3', 'python'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        timeout: 15_000,
      })
      if (probe.status === 0 && probe.stdout.trim() === '3') return candidate
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

const PYTHON = findPython()
const NO_PYTHON = PYTHON ? false : 'no python3 interpreter on PATH (set VB_TEST_PYTHON to one)'
const NO_WORKER = HAS_WORKER ? false : 'runtime/vb_script_worker.py is not present yet'

const scratchDirs = []

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vb-worker-test-'))
  scratchDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratchDirs.reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A killed child may still hold a handle on Windows; the OS reclaims it.
    }
  }
})

/** Windows paths differ in case; compare resolved paths platform-appropriately. */
function assertSamePath(actual, expected, message) {
  const normalize = (value) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  assert.equal(normalize(actual), normalize(expected), message)
}

/** A job environment that cannot reach anything outside the fixture tree. */
function jobEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VB_')) continue
    env[key] = value
  }
  env.PYTHONPATH = FIXTURES
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTHONUNBUFFERED = '1'
  return Object.assign(env, extra)
}

function writeJob(root, name, code, context = {}) {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'script.py'), code, 'utf8')
  const payload = {
    jobId: name,
    autoConnect: false,
    timeoutSec: 60,
    dataDir: dir,
    workdir: dir,
    ...context,
  }
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify(payload, null, 2), 'utf8')
  return dir
}

function readJsonIfPresent(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    if (error.code === 'ENOENT') return { value: undefined }
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`)
  }
}

function readTextIfPresent(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readArtifacts(dir) {
  return {
    status: readJsonIfPresent(path.join(dir, 'status.json')).value,
    result: readJsonIfPresent(path.join(dir, 'result.json')).value,
    error: readJsonIfPresent(path.join(dir, 'error.json')).value,
    events: (readTextIfPresent(path.join(dir, 'events.jsonl')) ?? '')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line)),
    stdoutLog: readTextIfPresent(path.join(dir, 'stdout.log')),
    files: readdirSync(dir).sort(),
  }
}

/** Every ``*.json`` in a job directory must parse; a crash must not tear them. */
function assertJsonFilesParse(dir) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
    const raw = readFileSync(path.join(dir, name), 'utf8')
    assert.doesNotThrow(() => JSON.parse(raw), `${name} must stay parseable after a job ends`)
  }
}

function normalizeEvents(events) {
  const strip = (source) => {
    const normalized = {}
    for (const [key, value] of Object.entries(source)) {
      if (VOLATILE_EVENT_KEYS.has(key)) continue
      normalized[key] = value
    }
    return normalized
  }
  return events.map((event) => {
    const normalized = strip(event)
    // The runner stamps timings inside the final ``done`` payload as well.
    if (normalized.value && typeof normalized.value === 'object' && normalized.value.done === true) {
      normalized.value = strip(normalized.value)
    }
    return normalized
  })
}

/** The classic runner is the oracle: the worker must produce the same artifacts. */
function compareJobArtifacts(workerDir, classicDir) {
  const worker = readArtifacts(workerDir)
  const classic = readArtifacts(classicDir)

  assert.equal(worker.status?.state, classic.status?.state, 'status.state must match the classic runner')
  assert.equal(worker.status?.exitCode, classic.status?.exitCode, 'status.exitCode must match the classic runner')
  assert.deepEqual(worker.result, classic.result, 'result.json must match the classic runner')
  assert.equal(worker.error?.type, classic.error?.type, 'error.type must match the classic runner')
  assert.equal(worker.error?.message, classic.error?.message, 'error.message must match the classic runner')
  if (classic.error) {
    assert.equal(typeof worker.error?.traceback, 'string')
    assert.ok(worker.error.traceback.length > 0, 'error.traceback must be reported')
    assert.ok(
      worker.error.traceback.includes(classic.error.message),
      'error.traceback must mention the exception message',
    )
  }
  assert.deepEqual(
    normalizeEvents(worker.events),
    normalizeEvents(classic.events),
    'events.jsonl must match the classic runner (timings excluded)',
  )
  return { worker, classic }
}

function runClassic(dir) {
  const completed = spawnSync(PYTHON, ['-u', CLASSIC_RUNNER, dir], {
    cwd: dir,
    env: jobEnv(),
    encoding: 'utf8',
    timeout: 120_000,
  })
  return {
    code: completed.status,
    signal: completed.signal,
    stdout: completed.stdout ?? '',
    stderr: completed.stderr ?? '',
  }
}

/**
 * Minimal client for the worker protocol: newline-delimited JSON on stdout,
 * requests correlated by id, ``event`` lines collected separately.
 */
class WorkerClient {
  constructor(client, env) {
    this.client = client
    this.env = env
    this.pending = new Map()
    this.events = []
    this.stdoutLines = []
    this.stderr = ''
    this.ready = undefined
    this.exit = new Promise((resolve) => {
      client.once('exit', (code, signal) => resolve({ code, signal }))
    })
    this.#pump()
  }

  #pump() {
    let buffer = ''
    this.client.stdout.setEncoding('utf8')
    this.client.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        this.stdoutLines.push(line)
        this.#handleLine(line)
      }
    })
    this.client.stderr.setEncoding('utf8')
    this.client.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000)
    })
    this.client.once('exit', (code, signal) => {
      const detail = `worker exited (code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''})${this.stderr ? `: ${this.stderr.trim().slice(-400)}` : ''}`
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(detail))
      }
      this.pending.clear()
    })
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      assert.fail(`worker stdout must be newline-delimited JSON, got: ${line.slice(0, 200)}`)
    }
    if (message.event === 'ready') {
      this.ready?.resolve(message)
      return
    }
    if (message.event) {
      this.events.push(message)
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else {
      const error = new Error(message.error?.message ?? 'worker request failed')
      error.kind = message.error?.kind
      error.traceback = message.error?.traceback
      entry.reject(error)
    }
  }

  get pid() {
    return this.client.pid
  }

  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.client.exitCode !== null || this.client.signalCode !== null) {
        reject(new Error('worker is not running'))
        return
      }
      const id = `r${this.pending.size + 1}_${Date.now()}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`worker request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.client.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  async jobEvents(jobId, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const match = this.events.find((event) => event.event === 'job' && (!jobId || event.jobId === jobId))
      if (match) return match
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return undefined
  }

  async shutdown() {
    try {
      await this.request('shutdown', {}, { timeoutMs: 10_000 })
    } catch {
      // The worker may exit before answering; the exit wait below settles it.
    }
    const exited = await Promise.race([this.exit, new Promise((resolve) => setTimeout(() => resolve(undefined), 10_000))])
    if (!exited) {
      this.kill()
      await this.exit
    }
    return exited
  }

  kill() {
    try {
      this.client.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

async function startWorker({ session = 'test-session', runtime = 'rt_fixture', env = {} } = {}) {
  const merged = jobEnv({ VB_STUB_PORT: '65432', ...env })
  const client = spawn(PYTHON, ['-u', WORKER, '--runtime', runtime, '--session', session], {
    cwd: ROOT,
    env: merged,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const worker = new WorkerClient(client, merged)
  worker.ready = {}
  worker.ready.promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not print a ready line${worker.stderr ? `: ${worker.stderr.slice(-300)}` : ''}`)), 30_000)
    worker.ready.resolve = (message) => {
      clearTimeout(timer)
      resolve(message)
    }
  })
  worker.readyMessage = await worker.ready.promise
  return worker
}

// ---------------------------------------------------------------------------
// Fixture sanity: the stub package and the artifact contract the worker must
// reproduce. These run without the worker so the oracle can never drift.
// ---------------------------------------------------------------------------

test('the fixture package stands in for virtuoso_bridge without a network', { skip: NO_PYTHON }, (t) => {
  const root = scratch()
  const dir = writeJob(
    root,
    'stub-import',
    'import virtuoso_bridge as vb\nresult = {"version": vb.__version__, "client": vb.VirtuosoClient.__name__}\n',
  )
  const run = runClassic(dir)
  assert.equal(run.code, 0, run.stderr)
  const { status, result } = readArtifacts(dir)
  assert.equal(status?.state, 'succeeded')
  assert.equal(result?.version, '0.0.0-fixture')
  assert.equal(result?.client, 'VirtuosoClient')
  t.diagnostic(`fixture python: ${PYTHON}`)
})

test('the classic runner defines the job artifact contract', { skip: NO_PYTHON }, async (t) => {
  const root = scratch()
  const cases = {
    success: {
      code: 'result = {"ok": True, "items": [1, 2]}\n',
      check: ({ status, result }) => {
        assert.equal(status?.state, 'succeeded')
        assert.deepEqual(result, { ok: true, items: [1, 2] })
      },
    },
    exception: {
      code: 'raise ValueError("boom")\n',
      check: ({ status, error, result }) => {
        assert.equal(status?.state, 'failed')
        assert.equal(status?.exitCode, 1)
        assert.equal(error?.type, 'ValueError')
        assert.equal(error?.message, 'boom')
        assert.equal(result, undefined)
      },
    },
    sysexit: {
      code: 'raise SystemExit(3)\n',
      check: ({ status, error }) => {
        assert.equal(status?.state, 'failed')
        assert.equal(status?.exitCode, 3)
        assert.equal(error, undefined, 'SystemExit is not an exception report')
      },
    },
    emit: {
      code: 'emit({"a": 1})\nemit({"b": 2}, tag="x")\nresult = 1\n',
      check: ({ events }) => {
        assert.deepEqual(normalizeEvents(events), [
          { value: { a: 1 } },
          { tag: 'x', value: { b: 2 } },
          { value: { done: true, state: 'succeeded' } },
        ])
      },
    },
    nonserializable: {
      code: 'class Boom:\n    def __repr__(self):\n        raise RuntimeError("no repr")\nresult = Boom()\n',
      check: ({ events, status, result }) => {
        assert.equal(status?.state, 'succeeded')
        assert.equal(result, undefined, 'an unserializable result writes no result.json')
        assert.deepEqual(normalizeEvents(events), [
          { value: { warning: 'resultNotSerializable', error: 'no repr' } },
          { value: { done: true, state: 'succeeded' } },
        ])
      },
    },
  }
  for (const [name, spec] of Object.entries(cases)) {
    await t.test(name, () => {
      const dir = writeJob(root, `classic-${name}`, spec.code)
      const run = runClassic(dir)
      spec.check({ ...readArtifacts(dir), run })
    })
  }
})

// ---------------------------------------------------------------------------
// Worker protocol. Skipped until runtime/vb_script_worker.py exists.
// ---------------------------------------------------------------------------

test('the worker announces ready, answers ping and reports status', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const worker = await startWorker({ session: 'proto-session', runtime: 'rt_proto' })
  t.after(async () => {
    await worker.shutdown()
  })

  assert.equal(worker.readyMessage.event, 'ready')
  assert.equal(worker.readyMessage.runtime, 'rt_proto')
  assert.equal(worker.readyMessage.session, 'proto-session')
  assert.equal(worker.readyMessage.version, 1)
  assert.equal(worker.readyMessage.pid, worker.pid, 'the ready pid must be the process pid')

  const ping = await worker.request('ping')
  assert.equal(typeof ping, 'object')

  const status = await worker.request('status')
  assert.equal(typeof status, 'object', 'status must return an object')
  t.diagnostic(`status shape: ${JSON.stringify(status)}`)
  if ('pid' in status) assert.equal(status.pid, worker.pid)
  if ('runtime' in status) assert.equal(status.runtime, 'rt_proto')
  if ('session' in status) assert.equal(status.session, 'proto-session')
  if ('busy' in status) assert.equal(status.busy, false, 'an idle worker is not busy')
})

test('the worker reproduces the classic job artifacts', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({ session: 'parity-session' })
  t.after(async () => {
    await worker.shutdown()
  })

  const cases = {
    success: 'result = {"ok": True, "items": [1, 2]}\n',
    exception: 'raise ValueError("boom")\n',
    sysexit3: 'raise SystemExit(3)\n',
    sysexit0: 'raise SystemExit(0)\n',
    emit: 'emit({"a": 1})\nemit({"b": 2}, tag="x")\nresult = 1\n',
    nonserializable: 'class Boom:\n    def __repr__(self):\n        raise RuntimeError("no repr")\nresult = Boom()\n',
    stdout: 'for i in range(3):\n    print("line %d" % i)\nresult = 7\n',
  }

  for (const [name, code] of Object.entries(cases)) {
    await t.test(name, async () => {
      const classicDir = writeJob(root, `classic-${name}`, code)
      const classicRun = runClassic(classicDir)
      const workerDir = writeJob(root, `worker-${name}`, code)
      const response = await worker.request('run', { jobDir: workerDir, jobId: `worker-${name}`, timeoutSec: 60 })
      const { worker: workerArtifacts } = compareJobArtifacts(workerDir, classicDir)

      if (name === 'stdout') {
        // Script output must never reach the protocol stream: every stdout line
        // the worker wrote must already have parsed as JSON.
        assert.ok(
          worker.stdoutLines.every((line) => {
            try {
              JSON.parse(line)
              return true
            } catch {
              return false
            }
          }),
          'script prints must not leak into the JSON protocol stream',
        )
        const printed = workerArtifacts.stdoutLog ?? ''
        const responseText = JSON.stringify(response ?? {})
        assert.ok(
          printed.includes('line 0') || responseText.includes('line 0'),
          'printed output must be retrievable (job stdout.log or the run result)',
        )
        t.diagnostic(
          `stdout capture: log=${printed !== ''} response=${responseText.includes('line 0')} classic=${
            classicRun.stdout.includes('line 0')
          }`,
        )
      }
      assert.equal(workerArtifacts.status?.state, readArtifacts(classicDir).status?.state)
    })
  }
})

test('a failing autoConnect does not fail the job', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({
    session: 'connect-failure-session',
    env: { VB_STUB_FROM_ENV_ERROR: 'fixture refuses to connect' },
  })
  t.after(async () => {
    await worker.shutdown()
  })

  const dir = writeJob(root, 'connect-failure', 'result = "ran"\n', { autoConnect: true })
  const response = await worker.request('run', { jobDir: dir, jobId: 'connect-failure', timeoutSec: 60 })
  const artifacts = readArtifacts(dir)
  t.diagnostic(`connect failure response: ${JSON.stringify(response)}`)

  assert.equal(artifacts.status?.state, 'succeeded', 'a connect failure must not fail the job')
  assert.equal(artifacts.result, 'ran')
  const warning = normalizeEvents(artifacts.events).find((event) => event.value?.warning === 'autoConnectFailed')
  assert.ok(warning, 'a connect failure must be reported as an autoConnectFailed event')
  assert.match(String(warning.value.error), /fixture refuses to connect/)

  const status = await worker.request('status')
  t.diagnostic(`status after a failed connect: connected=${status?.connected}`)
  if ('connected' in status) assert.equal(status.connected, false, 'a failed connect leaves the worker unconnected')
})

test('the worker connects once and reuses the client across jobs', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const calls = path.join(root, 'calls.jsonl')
  const worker = await startWorker({ session: 'connect-session', env: { VB_STUB_CALL_LOG: calls } })
  t.after(async () => {
    await worker.shutdown()
  })

  for (const name of ['c1', 'c2', 'c3']) {
    const dir = writeJob(root, name, 'result = 1\n', { autoConnect: true })
    await worker.request('run', { jobDir: dir, jobId: name, timeoutSec: 60 })
  }

  const records = readTextIfPresent(calls)
    ?.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.kind === 'from_env') ?? []
  t.diagnostic(`from_env calls across three autoConnect jobs: ${records.length}`)
  assert.equal(records.length, 1, 'a long-lived worker must connect once, not once per job')
})

test('a second run while the worker is busy is rejected or queued', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({ session: 'busy-session' })
  t.after(async () => {
    await worker.shutdown()
  })

  const firstDir = writeJob(root, 'busy-first', 'import time\ntime.sleep(3)\nresult = "first"\n')
  const secondDir = writeJob(root, 'busy-second', 'result = "second"\n')

  const first = worker.request('run', { jobDir: firstDir, jobId: 'busy-first', timeoutSec: 60 })
  // Wait until the worker actually reports the job in flight; a fixed sleep
  // races the dispatch thread that sets the busy flag.
  const deadline = Date.now() + 5_000
  let sawBusy = false
  while (Date.now() < deadline) {
    const status = await worker.request('status')
    if (status?.busy) {
      sawBusy = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(sawBusy, true, 'the worker must report the job in flight before a second run is sent')

  let outcome
  let kind
  try {
    await worker.request('run', { jobDir: secondDir, jobId: 'busy-second', timeoutSec: 60 }, { timeoutMs: 20_000 })
    outcome = 'queued'
  } catch (error) {
    outcome = 'rejected'
    kind = error.kind
  }
  t.diagnostic(`concurrent run while busy: ${outcome}${kind ? ` (kind=${kind})` : ''}`)

  if (outcome === 'rejected') assert.equal(kind, 'busy', 'a rejection while busy must use error.kind "busy"')
  else assert.equal(readArtifacts(secondDir).status?.state, 'succeeded', 'a queued run must still complete')

  await first
  assert.equal(readArtifacts(firstDir).status?.state, 'succeeded')
})

test('the protocol stays answerable while a job is blocked in a C call', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({ session: 'blocked-session' })
  t.after(async () => {
    await worker.shutdown()
  })

  // time.sleep() blocks the job thread inside a C call, where the worker cannot
  // raise into it. The protocol must still answer other requests, keep busy=true
  // until the body returns, and then run the queued work normally.
  const blockedDir = writeJob(root, 'blocked', 'import time\ntime.sleep(2)\nresult = "blocked-done"\n')
  const run = worker.request('run', { jobDir: blockedDir, jobId: 'blocked', timeoutSec: 60 })

  const deadline = Date.now() + 5_000
  let sawBusy = false
  while (Date.now() < deadline) {
    const status = await worker.request('status', {}, { timeoutMs: 3_000 })
    if (status?.busy) {
      sawBusy = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(sawBusy, true, 'status must answer with busy=true while the body is blocked')

  const started = Date.now()
  const statusWhileBlocked = await worker.request('status', {}, { timeoutMs: 3_000 })
  const statusMs = Date.now() - started
  t.diagnostic(`status while blocked: busy=${statusWhileBlocked?.busy} in ${statusMs}ms`)
  assert.equal(statusWhileBlocked?.busy, true, 'the worker stays busy until the blocked body returns')
  assert.ok(statusMs < 1_500, `status must answer promptly while the body is blocked, took ${statusMs}ms`)

  const queuedDir = writeJob(root, 'blocked-second', 'result = "second"\n')
  const secondStarted = Date.now()
  let secondKind
  try {
    await worker.request('run', { jobDir: queuedDir, jobId: 'blocked-second', timeoutSec: 60 }, { timeoutMs: 3_000 })
  } catch (error) {
    secondKind = error.kind
  }
  const secondMs = Date.now() - secondStarted
  t.diagnostic(`run while blocked: kind=${secondKind} in ${secondMs}ms`)
  assert.equal(secondKind, 'busy', 'a run received while a blocked job holds the worker must be refused')
  assert.ok(secondMs < 1_500, `a run while blocked must be answered promptly, took ${secondMs}ms`)

  await run
  const idle = await worker.request('status')
  assert.equal(idle?.busy, false, 'busy must clear once the blocked body returns')
  assert.equal(readArtifacts(blockedDir).result, 'blocked-done', 'the blocked body still produced its result')
})

test('jobs are isolated: namespace, cwd and sys.modules', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({ session: 'isolation-session' })
  t.after(async () => {
    await worker.shutdown()
  })

  const outside = path.join(root, 'outside')
  mkdirSync(outside, { recursive: true })

  const first = writeJob(
    root,
    'iso-1',
    [
      'import os, sys',
      'leaked = 41',
      'open("helper.py", "w").write("VALUE = 1\\n")',
      'sys.path.insert(0, str(work_dir))',
      'import helper',
      `os.chdir(${JSON.stringify(outside)})`,
      'result = {"leaked": leaked, "helper": helper.VALUE}',
      '',
    ].join('\n'),
  )
  await worker.request('run', { jobDir: first, jobId: 'iso-1', timeoutSec: 60 })
  assert.deepEqual(readArtifacts(first).result, { leaked: 41, helper: 1 })

  const second = writeJob(
    root,
    'iso-2',
    [
      'import os, sys',
      'open("helper.py", "w").write("VALUE = 2\\n")',
      'sys.path.insert(0, str(work_dir))',
      'import helper',
      'result = {"leaked": "leaked" in globals(), "cwd": os.path.realpath(os.getcwd()), "helper": helper.VALUE}',
      '',
    ].join('\n'),
  )
  await worker.request('run', { jobDir: second, jobId: 'iso-2', timeoutSec: 60 })
  const result = readArtifacts(second).result
  assert.equal(result?.leaked, false, 'a job must not see the previous job namespace')
  assert.equal(result?.helper, 2, 'a workdir module must be re-read, not reused from sys.modules')
  assertSamePath(result?.cwd, second, 'the worker must restore the job workdir')
})

test('two workers with different sessions are separate processes', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const alpha = await startWorker({ session: 'session-alpha' })
  const beta = await startWorker({ session: 'session-beta' })
  t.after(async () => {
    await alpha.shutdown()
    await beta.shutdown()
  })

  assert.equal(alpha.readyMessage.session, 'session-alpha')
  assert.equal(beta.readyMessage.session, 'session-beta')
  assert.notEqual(alpha.pid, beta.pid, 'sessions must not share a process')

  const markerJob = writeJob(
    root,
    'marker',
    'import virtuoso_bridge as vb\nvb.SESSION_MARKER = "alpha"\nresult = os.getcwd()\n',
  )
  await alpha.request('run', { jobDir: markerJob, jobId: 'marker', timeoutSec: 60 })

  const probeJob = writeJob(
    root,
    'probe',
    'import os, virtuoso_bridge as vb\nresult = {"marker": getattr(vb, "SESSION_MARKER", None), "cwd": os.path.realpath(os.getcwd())}\n',
  )
  await beta.request('run', { jobDir: probeJob, jobId: 'probe', timeoutSec: 60 })
  const probe = readArtifacts(probeJob).result
  assert.equal(probe?.marker, null, 'a marker written in one session must not be visible in another')
  assertSamePath(probe?.cwd, probeJob)
  assertSamePath(readArtifacts(markerJob).result, markerJob, 'the first session keeps its own workdir')
})

test('cancel settles the in-flight job and leaves coherent artifacts', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({ session: 'cancel-session' })
  t.after(async () => {
    await worker.shutdown()
  })

  // A Python-level loop is interruptible at a bytecode boundary; a blocking C
  // call such as time.sleep() is not, and the plugin then has to kill the
  // worker. The interruptible case is what this test can hold the worker to.
  const dir = writeJob(
    root,
    'cancel-me',
    'import time\nend = time.time() + 60\nwhile time.time() < end:\n    pass\nresult = "never"\n',
    { timeoutSec: 120 },
  )
  const run = worker.request('run', { jobDir: dir, jobId: 'cancel-me', timeoutSec: 120 })

  const busyDeadline = Date.now() + 5_000
  while (Date.now() < busyDeadline) {
    const status = await worker.request('status')
    if (status?.busy) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  let cancelAnswered = false
  try {
    await worker.request('cancel', { jobId: 'cancel-me' }, { timeoutMs: 10_000 })
    cancelAnswered = true
  } catch (error) {
    t.diagnostic(`cancel request failed: ${error.message}`)
  }
  t.diagnostic(`cancel answered while the job was running: ${cancelAnswered}`)
  assert.equal(cancelAnswered, true, 'cancel must be answered while a job is in flight')

  const settled = await Promise.race([
    run.then(() => 'resolved').catch(() => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('still-running'), 20_000)),
  ])
  t.diagnostic(`cancelled run settled as: ${settled}`)

  assert.notEqual(settled, 'still-running', 'cancel must settle the run request')
  assertJsonFilesParse(dir)
  const state = readArtifacts(dir).status?.state
  t.diagnostic(`cancelled job state: ${state}`)
  assert.ok(JOB_STATES.has(state), `cancelled job status must carry a known state, saw ${state}`)

  const after = writeJob(root, 'after-cancel', 'result = "alive"\n')
  try {
    await worker.request('run', { jobDir: after, jobId: 'after-cancel', timeoutSec: 60 }, { timeoutMs: 20_000 })
    assert.equal(readArtifacts(after).result, 'alive')
  } catch (error) {
    t.diagnostic(`worker not reusable after cancel: ${error.message}`)
  }
})

test('a job timeout settles the run and leaves coherent artifacts', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({ session: 'timeout-session' })
  t.after(async () => {
    await worker.shutdown()
  })

  // Interruptible loop: the timeout watchdog raises into the job thread at a
  // bytecode boundary. A blocking C call would need the plugin to kill the
  // worker instead, which is the documented backstop.
  const dir = writeJob(
    root,
    'timeout-me',
    'import time\nend = time.time() + 60\nwhile time.time() < end:\n    pass\nresult = "never"\n',
    { timeoutSec: 1 },
  )
  const run = worker.request('run', { jobDir: dir, jobId: 'timeout-me', timeoutSec: 1 })
  const settled = await Promise.race([
    run.then((result) => ({ outcome: 'resolved', result })).catch((error) => ({ outcome: 'rejected', error })),
    new Promise((resolve) => setTimeout(() => resolve({ outcome: 'still-running' }), 20_000)),
  ])
  t.diagnostic(`timed-out run: ${settled.outcome} ${JSON.stringify(settled.result ?? settled.error?.message ?? '')}`)
  assert.notEqual(settled.outcome, 'still-running', 'a job that exceeds timeoutSec must settle')

  assertJsonFilesParse(dir)
  const status = readArtifacts(dir).status
  t.diagnostic(`timed-out job state: ${status?.state}`)
  assert.ok(JOB_STATES.has(status?.state), `timed-out job must carry a known state, saw ${status?.state}`)
})

test('shutdown exits the worker and ends the protocol', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const worker = await startWorker({ session: 'shutdown-session' })
  const exited = await worker.shutdown()
  assert.ok(exited, 'shutdown must end the worker process')
  t.diagnostic(`shutdown exit: code=${exited?.code} signal=${exited?.signal}`)
  await assert.rejects(() => worker.request('ping', {}, { timeoutMs: 2_000 }), /not running|exited/)
})

test('killing a worker mid-run leaves the job artifacts coherent', { skip: NO_WORKER || NO_PYTHON }, async (t) => {
  const root = scratch()
  const worker = await startWorker({ session: 'crash-session' })

  const dir = writeJob(root, 'crash-me', 'import time\ntime.sleep(30)\nresult = "never"\n')
  const run = worker.request('run', { jobDir: dir, jobId: 'crash-me', timeoutSec: 60 })
  await new Promise((resolve) => setTimeout(resolve, 600))

  worker.kill()
  const settled = await Promise.race([
    run.then(() => 'resolved').catch(() => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 15_000)),
  ])
  t.diagnostic(`run request after SIGKILL: ${settled}`)
  assert.notEqual(settled, 'hung', 'a dead worker must not leave a request hanging')

  assertJsonFilesParse(dir)
  const status = readArtifacts(dir).status
  t.diagnostic(`status after SIGKILL: ${JSON.stringify(status)}`)
  if (status) {
    assert.ok(JOB_STATES.has(status.state), `a half-finished status must still carry a known state, saw ${status?.state}`)
    assert.ok('startedAt' in status, 'a half-finished status must record when the job started')
  }
})
