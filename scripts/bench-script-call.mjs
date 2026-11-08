#!/usr/bin/env node
/**
 * Live benchmark for `virtuoso_bridge_script` calls.
 *
 * The harness reproduces what the plugin does for one script job — same job
 * directory, same `context.json`, same environment, same runner — and measures
 * the wall time plus the phases the runner reports in `status.json`.
 *
 *   node scripts/bench-script-call.mjs --connection NAME [--runs 5]
 *        [--body trivial|realistic|both] [--threshold MS] [--json]
 *        [--mode runner|worker] [--session KEY] [--concurrent N]
 *        [--runner PATH] [--data-dir PATH] [--keep] [--timeout-ms MS]
 *
 * It never talks to Virtuoso itself: a job needs an already running runtime
 * (the plugin's tunnel/daemon) and the venv from the local store. Run it against
 * an idle connection only — the benchmark pushes real jobs through the bridge.
 *
 * Environment synthesis is deliberately not filtered: the Paramiko backend
 * resolves the connection with `ssh -G`, which needs the inherited environment.
 *
 * Phases: the runner reports `sessionSetup.phase`; keys ending in `Ms` are
 * milliseconds, plain keys are seconds. Missing phases print `-`. `connectMs`
 * falls back to `sessionSetup.connectSeconds` and `bodyMs` to
 * `status.elapsedSeconds`, so a runner without phase instrumentation still
 * produces a usable table.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { envForProfile, isLoopbackHost, profileNameFor } from '../lib/util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKTREE = path.dirname(HERE)
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'virtuoso-bridge', 'default')

const BODIES = {
  trivial: `result = 1
`,
  realistic: `remote = "/tmp/vb-bench-%s.txt" % context.get("jobId")
skill = client.execute_skill("1+1")
shell = client.run_shell_command("true")
uploaded = client.upload_file(job_dir / "script.py", remote)
downloaded = client.download_file(remote, job_dir / "roundtrip.txt")
client.run_shell_command("rm -f " + remote)
result = {
    "skill": str(getattr(skill, "status", "")),
    "shell": str(getattr(shell, "status", "")),
    "upload": str(getattr(uploaded, "status", "")),
    "download": str(getattr(downloaded, "status", "")),
    "bytes": (job_dir / "roundtrip.txt").stat().st_size,
}
`,
}

function usage() {
  return [
    'Usage: node scripts/bench-script-call.mjs --connection NAME [options]',
    '',
    '  --connection NAME   connection from the plugin store (required unless one is default)',
    '  --runs N           runs per body (default 5)',
    '  --warmup N         discarded warm-up runs per body (default 1)',
    '  --body KIND        trivial | realistic | both (default both)',
    '  --threshold MS     exit 1 when the trivial median exceeds MS',
    '  --json             machine-readable output',
    '  --mode MODE        runner (default) | worker',
    '  --session KEY      session key for worker mode (default bench)',
    '  --workers N        worker processes with distinct session keys (default 1)',
    '  --hold-ms MS       keep the workers alive after their jobs, for a census (default 0)',
    '  --worker PATH      worker entry point (default <worktree>/runtime/vb_script_worker.py)',
    '  --concurrent N     run N jobs at once, each with its own session key (default 1)',
    '  --runner PATH      runner to spawn (default <worktree>/runtime/vb_script.py)',
    '  --data-dir PATH    plugin data dir (default ~/.dsh/virtuoso-bridge/default)',
    '  --timeout-ms MS    per-run hard timeout (default 300000)',
    '  --keep             keep job directories',
    '',
    'Run against an idle connection. Never benchmark a connection other agents use.',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    connection: undefined,
    runs: 5,
    warmup: 1,
    body: 'both',
    threshold: undefined,
    json: false,
    mode: 'runner',
    session: 'bench',
    concurrent: 1,
    workers: 1,
    holdMs: 0,
    runner: path.join(WORKTREE, 'runtime', 'vb_script.py'),
    worker: path.join(WORKTREE, 'runtime', 'vb_script_worker.py'),
    dataDir: DEFAULT_DATA_DIR,
    timeoutMs: 300_000,
    keep: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    switch (arg) {
      case '--connection': options.connection = next(); break
      case '--runs': options.runs = positiveInt(next(), arg); break
      case '--warmup': options.warmup = nonNegativeInt(next(), arg); break
      case '--body': options.body = choice(next(), ['trivial', 'realistic', 'both'], arg); break
      case '--threshold': options.threshold = positiveNumber(next(), arg); break
      case '--json': options.json = true; break
      case '--mode': options.mode = choice(next(), ['runner', 'worker'], arg); break
      case '--session': options.session = next(); break
      case '--concurrent': options.concurrent = positiveInt(next(), arg); break
      case '--workers': options.workers = positiveInt(next(), arg); break
      case '--hold-ms': options.holdMs = nonNegativeInt(next(), arg); break
      case '--worker': options.worker = path.resolve(next()); break
      case '--runner': options.runner = path.resolve(next()); break
      case '--data-dir': options.dataDir = path.resolve(next()); break
      case '--timeout-ms': options.timeoutMs = positiveInt(next(), arg); break
      case '--keep': options.keep = true; break
      case '--help': case '-h': options.help = true; break
      default: throw new Error(`unknown option ${arg}`)
    }
  }
  return options
}

function positiveInt(value, flag) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} needs a positive integer`)
  return parsed
}

function nonNegativeInt(value, flag) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} needs a non-negative integer`)
  return parsed
}

function positiveNumber(value, flag) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} needs a non-negative number`)
  return parsed
}

function choice(value, allowed, flag) {
  if (!allowed.includes(value)) throw new Error(`${flag} must be one of ${allowed.join(', ')}`)
  return value
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Provenance for a number that gets quoted later: which runner bytes ran. */
async function runnerProvenance(runnerPath) {
  try {
    const bytes = await fsp.readFile(runnerPath)
    return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  } catch {
    return undefined
  }
}

/** Resolve the connection and everything the plugin would use for one job. */
async function resolveTarget(options) {
  const settingsPath = path.join(options.dataDir, 'settings.json')
  const settings = await readJsonFile(settingsPath)
  if (!settings) throw new Error(`no plugin store at ${settingsPath}; pass --data-dir`)
  const connections = Array.isArray(settings.connections) ? settings.connections : []
  if (connections.length === 0) throw new Error('the plugin store has no connections')

  let connection
  if (options.connection) {
    connection = connections.find((item) => item.name === options.connection || item.id === options.connection)
    if (!connection) {
      throw new Error(`unknown connection ${options.connection}; store has ${connections.map((item) => item.name).join(', ')}`)
    }
  } else if (settings.defaultConnection) {
    connection = connections.find((item) => item.id === settings.defaultConnection)
  }
  if (!connection) throw new Error('pass --connection NAME (the store has no default connection)')

  const profile = profileNameFor(connection.name || connection.id)
  const install = await readJsonFile(path.join(options.dataDir, 'install.json'))
  const venvPython = install?.venvPython
    ? install.venvPython
    : process.platform === 'win32'
      ? path.join(options.dataDir, 'venv', 'Scripts', 'python.exe')
      : path.join(options.dataDir, 'venv', 'bin', 'python')
  if (!existsSync(venvPython)) throw new Error(`venv interpreter not found at ${venvPython}; run setup install first`)
  if (!existsSync(options.runner)) throw new Error(`runner not found at ${options.runner}`)

  const cacheDir = settings.cacheDir ? path.resolve(settings.cacheDir) : options.dataDir
  return { connection, profile, venvPython, cacheDir, dataDir: options.dataDir, settings }
}

/**
 * The exact environment the plugin hands to a script job: the inherited
 * environment plus the VB_* variables for this profile. Nothing is filtered —
 * `ssh -G` needs the inherited environment to resolve the Paramiko backend.
 */
function jobEnvironment(target, jobDir, sessionKey) {
  const env = envForProfile(target.connection, target.profile)
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.VB_PLUGIN_DATA_DIR = target.dataDir
  env.VB_PLUGIN_CACHE_DIR = target.cacheDir
  env.VB_SCRIPT_JOB_DIR = jobDir
  if (sessionKey) env.VB_SCRIPT_SESSION = sessionKey
  // The plugin writes a generated SSH config only when the connection needs one
  // (identity file, non-default port, pinned host keys) and removes it otherwise.
  // Mirror whatever the plugin left behind instead of inventing a value.
  const configPath = path.join(target.dataDir, 'ssh', `config-${target.profile}`)
  if (existsSync(configPath)) env.VB_SSH_CONFIG = configPath
  else delete env.VB_SSH_CONFIG
  return env
}

/** Worker mode: N long-lived workers with distinct session keys. */
async function workerMode(target, options, bodies, print) {
  if (!existsSync(options.worker)) throw new Error(`worker not found at ${options.worker}`)
  const sessions =
    options.workers === 1
      ? [options.session]
      : Array.from({ length: options.workers }, (_, index) => `${options.session}-${index + 1}`)
  const runtimeLabel = `bench-${String(target.connection.name || 'connection').replace(/[^A-Za-z0-9_.-]/g, '_')}`
  const baseEnv = jobEnvironment(target, os.tmpdir(), sessions[0])
  // The plugin deletes this before spawning the worker: it is per job, and a
  // worker process runs many jobs.
  delete baseEnv.VB_SCRIPT_JOB_DIR
  const workers = []
  const rows = []
  for (const session of sessions) {
    const worker = new ScriptWorker({
      python: target.venvPython,
      script: options.worker,
      args: ['--runtime', runtimeLabel, '--session', session],
      env: { ...baseEnv, VB_SCRIPT_SESSION: session },
      cwd: target.dataDir,
      label: session,
    })
    await worker.start()
    workers.push(worker)
    print?.(`worker ${session}: pid ${worker.child.pid}`)
  }
  try {
    for (const body of bodies) {
      for (const worker of workers) {
        for (let jobIndex = 1; jobIndex <= options.runs; jobIndex += 1) {
          rows.push(await runWorkerJob(worker, target, options, body, jobIndex))
        }
      }
    }
    if (options.holdMs > 0) {
      print?.(
        `HOLDING ${workers.length} worker(s) pids=${workers.map((worker) => worker.child.pid).join(',')} ` +
          `for ${options.holdMs} ms — census window`,
      )
      await new Promise((resolve) => setTimeout(resolve, options.holdMs))
    }
  } finally {
    for (const worker of workers) await worker.stop()
    print?.(`teardown: ${workers.length} worker(s) stopped`)
  }
  return rows
}

function workerSummary(rows) {
  const byBody = new Map()
  for (const row of rows) {
    if (!byBody.has(row.body)) byBody.set(row.body, [])
    byBody.get(row.body).push(row)
  }
  return byBody
}

function printWorkerSummary(body, rows) {
  const first = rows.filter((row) => row.jobIndex === 1)
  const warm = rows.filter((row) => row.jobIndex > 1)
  const med = (values) => {
    const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)
    return sorted.length ? quantile(sorted, 0.5) : undefined
  }
  const reused = warm.filter((row) => row.clientReused).length
  console.log(
    `${body}: connect job (job#1, n=${first.length}) wall ${formatMs(med(first.map((row) => row.wallMs)))} ms · ` +
      `connect ${formatMs(med(first.map((row) => row.connectMs)))} ms || ` +
      `warm (job#2+, n=${warm.length}) wall ${formatMs(med(warm.map((row) => row.wallMs)))} ms · ` +
      `connect ${formatMs(med(warm.map((row) => row.connectMs)))} ms · clientReused ${reused}/${warm.length}`,
  )
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return undefined
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Normalize `sessionSetup.phase` regardless of ms/seconds spelling. */
function readPhases(sessionSetup) {
  const phase = sessionSetup && typeof sessionSetup.phase === 'object' ? sessionSetup.phase : {}
  const suspicious = []
  const pick = (names) => {
    for (const name of names) {
      const raw = phase[name]
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const value = name.endsWith('Ms') || name.endsWith('MS') ? raw : raw * 1000
        // A phase before the job started or longer than an hour means the
        // runner's clock basis is wrong (seconds vs milliseconds); report the
        // gap instead of printing a nonsense column.
        if (value < 0 || value > 3_600_000) {
          suspicious.push(`${name}=${raw}`)
          return undefined
        }
        return value
      }
    }
    return undefined
  }
  return {
    envMs: pick(['envMs', 'env', 'envSeconds']),
    importMs: pick(['importMs', 'import', 'importSeconds']),
    connectMs: pick(['connectMs', 'connect', 'connectSeconds']),
    bodyMs: pick(['bodyMs', 'body', 'bodySeconds']),
    settleMs: pick(['settleMs', 'settle', 'settleSeconds']),
    suspicious,
  }
}

function spawnAndWait(command, args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-16_000) })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16_000) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, timedOut, stdout, stderr: `${stderr}${error.message}`, pid: child.pid, startedAt })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, stdout, stderr, pid: child.pid, startedAt })
    })
  })
}

async function writeJob(dir, body, target, options, sessionKey) {
  await fsp.mkdir(dir, { recursive: true })
  const context = {
    jobId: `bench_${path.basename(dir)}`,
    profile: target.profile,
    local: target.connection.kind === 'local' || isLoopbackHost(target.connection.host),
    timeoutSec: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
    logToCiw: false,
    autoConnect: true,
    dataDir: options.dataDir,
    connection: { name: target.connection.name, host: target.connection.host },
    session: sessionKey,
    t0Ms: Date.now(),
  }
  await Promise.all([
    fsp.writeFile(path.join(dir, 'script.py'), body, 'utf8'),
    fsp.writeFile(path.join(dir, 'context.json'), JSON.stringify(context, null, 2), 'utf8'),
  ])
  return context
}

/**
 * Client for `runtime/vb_script_worker.py` — the same newline-delimited JSON
 * protocol `lib/sidecar.js` speaks: `{id, method, params}` → `{id, ok, result}`.
 */
class ScriptWorker {
  constructor({ python, script, args, env, cwd, label }) {
    this.python = python
    this.script = script
    this.args = args
    this.env = env
    this.cwd = cwd
    this.label = label
    this.child = undefined
    this.buffer = ''
    this.stderr = ''
    this.pending = new Map()
    this.logs = []
    this.closed = false
    this.nextId = 1
  }

  async start({ timeoutMs = 60_000 } = {}) {
    const child = spawn(this.python, ['-u', this.script, ...this.args], {
      env: this.env,
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16_000)
    })
    child.on('close', (code) => {
      this.closed = true
      for (const [, pending] of this.pending) pending.reject(new Error(`worker exited (code ${code ?? 'unknown'})`))
      this.pending.clear()
    })
    child.on('error', (error) => {
      this.closed = true
      for (const [, pending] of this.pending) pending.reject(error)
      this.pending.clear()
    })
    await this.#waitFor((message) => message.event === 'ready', timeoutMs, 'worker ready')
    return this
  }

  #onStdout(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.#onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.logs.push({ level: 'raw', message: line.slice(0, 300) })
      return
    }
    if (message.event) {
      if (message.event === 'log') this.logs.push({ level: message.level, message: message.message })
      this.#emitEvent(message)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(Object.assign(new Error(message.error?.message ?? 'worker request failed'), { kind: message.error?.kind }))
  }

  #emitEvent(message) {
    for (const waiter of this.eventWaiters) {
      if (waiter.predicate(message)) {
        this.eventWaiters.delete(waiter)
        waiter.resolve(message)
      }
    }
  }

  get eventWaiters() {
    this._eventWaiters ??= new Set()
    return this._eventWaiters
  }

  #waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject }
      this.eventWaiters.add(waiter)
      const timer = setTimeout(() => {
        this.eventWaiters.delete(waiter)
        reject(new Error(`timed out waiting for ${label}`))
      }, timeoutMs)
      const done = waiter.resolve
      waiter.resolve = (value) => {
        clearTimeout(timer)
        done(value)
      }
    })
  }

  request(method, params = {}, timeoutMs = 300_000) {
    if (!this.child || this.closed) return Promise.reject(new Error('worker is not running'))
    const id = `w${this.nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`worker ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async stop({ timeoutMs = 15_000 } = {}) {
    if (!this.child || this.closed) return
    try {
      await this.request('shutdown', {}, 5_000)
    } catch {
      // the worker may already be gone
    }
    const exited = await Promise.race([
      new Promise((resolve) => this.child.once('close', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
    if (!exited) {
      this.child.kill()
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    this.closed = true
  }
}

/** One measured job through a warm worker (one run request). */
async function runWorkerJob(worker, target, options, bodyName, jobIndex) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vb-bench-'))
  const context = await writeJob(dir, BODIES[bodyName], target, options, worker.args.at(-1))
  const t0 = Date.now()
  let outcome
  let failure
  try {
    outcome = await worker.request('run', { jobDir: dir, jobId: context.jobId, timeoutSec: context.timeoutSec }, options.timeoutMs)
  } catch (error) {
    failure = error
  }
  const wallMs = Date.now() - t0
  const status = await readJsonFile(path.join(dir, 'status.json'))
  const error = await readJsonFile(path.join(dir, 'error.json'))
  const sessionSetup = status?.sessionSetup && typeof status.sessionSetup === 'object' ? status.sessionSetup : undefined
  const phases = readPhases(sessionSetup)
  const connectMs =
    phases.connectMs ?? (typeof sessionSetup?.connectSeconds === 'number' ? sessionSetup.connectSeconds * 1000 : undefined)
  const bodyMs = phases.bodyMs ?? (typeof status?.elapsedSeconds === 'number' ? status.elapsedSeconds * 1000 : undefined)
  const row = {
    body: bodyName,
    session: worker.args.at(-1),
    workerPid: worker.child?.pid,
    jobIndex,
    wallMs,
    envMs: phases.envMs,
    importMs: phases.importMs,
    connectMs,
    bodyMs,
    settleMs: phases.settleMs,
    phaseSuspicious: phases.suspicious,
    readyMs: typeof status?.startedAt === 'number' ? status.startedAt * 1000 - context.t0Ms : undefined,
    tunnelReused: typeof sessionSetup?.tunnelReused === 'boolean' ? sessionSetup.tunnelReused : undefined,
    clientReused: sessionSetup?.clientReused === true,
    state: failure ? 'failed' : (outcome?.state ?? status?.state ?? 'unknown'),
    exitCode: failure ? 1 : 0,
    timedOut: false,
    pid: worker.child?.pid,
    result: undefined,
    error: failure?.message ?? error?.message,
    stdoutTail: '',
    stderrTail: worker.stderr ? worker.stderr.trim().split(/\r?\n/).slice(-2).join(' | ') : '',
    dir,
  }
  const result = await readJsonFile(path.join(dir, 'result.json'))
  row.result = result === undefined ? undefined : summarizeResult(result)
  if (!options.keep) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  return row
}


async function runOnce(target, options, bodyName, sessionKey) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vb-bench-'))
  const context = await writeJob(dir, BODIES[bodyName], target, options, sessionKey)
  const env = jobEnvironment(target, dir, sessionKey)
  const wallStart = Date.now()
  const child = await spawnAndWait(target.venvPython, ['-u', options.runner, dir], {
    env,
    cwd: dir,
    timeoutMs: options.timeoutMs,
  })
  const wallMs = Date.now() - wallStart
  const status = await readJsonFile(path.join(dir, 'status.json'))
  const error = await readJsonFile(path.join(dir, 'error.json'))
  const result = await readJsonFile(path.join(dir, 'result.json'))
  const sessionSetup = status?.sessionSetup && typeof status.sessionSetup === 'object' ? status.sessionSetup : undefined
  const phases = readPhases(sessionSetup)
  const connectMs = phases.connectMs ?? (typeof sessionSetup?.connectSeconds === 'number' ? sessionSetup.connectSeconds * 1000 : undefined)
  const bodyMs = phases.bodyMs ?? (typeof status?.elapsedSeconds === 'number' ? status.elapsedSeconds * 1000 : undefined)
  // spawn -> script body start: the whole interpreter + import + connect phase,
  // available even when the runner reports no phases.
  const readyMs = typeof status?.startedAt === 'number' ? status.startedAt * 1000 - context.t0Ms : undefined
  const row = {
    body: bodyName,
    session: sessionKey,
    wallMs,
    envMs: phases.envMs,
    importMs: phases.importMs,
    connectMs,
    bodyMs,
    settleMs: phases.settleMs,
    phaseSuspicious: phases.suspicious,
    readyMs,
    tunnelReused: typeof sessionSetup?.tunnelReused === 'boolean' ? sessionSetup.tunnelReused : undefined,
    state: status?.state ?? (child.code === 0 ? 'unknown' : 'failed'),
    exitCode: child.code,
    timedOut: child.timedOut,
    pid: child.pid,
    result: result === undefined ? undefined : summarizeResult(result),
    error: error?.message,
    stdoutTail: child.stdout ? child.stdout.trim().split(/\r?\n/).slice(-3).join(' | ') : '',
    stderrTail: child.stderr ? child.stderr.trim().split(/\r?\n/).slice(-3).join(' | ') : '',
    dir,
  }
  if (!options.keep) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  return row
}

function summarizeResult(value) {
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).slice(0, 8))
}

function summarize(rows) {
  const walls = rows.map((row) => row.wallMs).sort((a, b) => a - b)
  const stat = (key) => {
    const values = rows.map((row) => row[key]).filter((value) => typeof value === 'number').sort((a, b) => a - b)
    return {
      count: values.length,
      min: values[0],
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      p75: quantile(values, 0.75),
      max: values[values.length - 1],
    }
  }
  return {
    runs: rows.length,
    failed: rows.filter((row) => row.state !== 'succeeded' || row.exitCode !== 0 || row.timedOut).length,
    wall: { min: walls[0], median: quantile(walls, 0.5), p25: quantile(walls, 0.25), p75: quantile(walls, 0.75), max: walls[walls.length - 1] },
    readyMs: stat('readyMs'),
    envMs: stat('envMs'),
    importMs: stat('importMs'),
    connectMs: stat('connectMs'),
    bodyMs: stat('bodyMs'),
    settleMs: stat('settleMs'),
    tunnelReused: {
      yes: rows.filter((row) => row.tunnelReused === true).length,
      no: rows.filter((row) => row.tunnelReused === false).length,
      unknown: rows.filter((row) => row.tunnelReused === undefined).length,
    },
    phaseSuspicious: rows.reduce((sum, row) => sum + (row.phaseSuspicious?.length ?? 0), 0),
  }
}

function formatMs(value) {
  if (typeof value !== 'number') return '-'
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1)
}

function printTable(label, rows, summary) {
  const reused = `${summary.tunnelReused.yes}/${rows.length}`
  const comparable = summary.tunnelReused.no === 0
  const header = ['body', 'runs', 'wall med', 'p25', 'p75', 'ready', 'env', 'import', 'connect', 'body', 'settle', 'reused']
  const line = [
    label,
    String(summary.runs),
    formatMs(summary.wall.median),
    formatMs(summary.wall.p25),
    formatMs(summary.wall.p75),
    formatMs(summary.readyMs.median),
    formatMs(summary.envMs.median),
    formatMs(summary.importMs.median),
    formatMs(summary.connectMs.median),
    formatMs(summary.bodyMs.median),
    formatMs(summary.settleMs.median),
    comparable ? reused : `${reused} !!`,
  ]
  const widths = header.map((name, index) => Math.max(name.length, line[index].length))
  const render = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()
  if (!printTable.printed) {
    console.log(render(header))
    console.log(widths.map((width) => '-'.repeat(width)).join('  '))
    printTable.printed = true
  }
  console.log(render(line))
  if (!comparable) {
    console.log(
      `!! NOT COMPARABLE: ${summary.tunnelReused.no}/${rows.length} runs re-warmed the tunnel ` +
        '(sessionSetup.tunnelReused=false). Those runs measured the full warm-up path.',
    )
  }
  const failed = rows.filter((row) => row.state !== 'succeeded' || row.exitCode !== 0 || row.timedOut)
  for (const row of failed) {
    console.log(`!! run failed (state=${row.state} exit=${row.exitCode} pid=${row.pid}): ${row.error ?? row.stderrTail ?? 'no detail'}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return 0
  }
  const target = await resolveTarget(options)
  const runnerSha = await runnerProvenance(options.runner)
  const bodies = options.body === 'both' ? ['trivial', 'realistic'] : [options.body]
  const rows = []
  const bodyWarmup = new Map()
  const startedAt = new Date().toISOString()
  const warnings = []
  const print = options.json ? undefined : (line) => console.log(line)

  if (!options.json) {
    if (options.mode === 'worker') {
      console.log(
        `bench: ${target.connection.name} (profile ${target.profile}) · worker ${path.relative(WORKTREE, options.worker)}` +
          `${options.workers > 1 ? ` × ${options.workers} (distinct sessions)` : ''} · ` +
          `${options.runs} job(s)/worker × ${bodies.join('+')}`,
      )
    } else {
      console.log(
        `bench: ${target.connection.name} (profile ${target.profile}) · runner ${path.relative(WORKTREE, options.runner)}` +
          `${runnerSha ? ` @ ${runnerSha}` : ''} · ` +
          `${options.runs} run(s) × ${bodies.join('+')}${options.concurrent > 1 ? ` · ${options.concurrent} concurrent` : ''}`,
      )
    }
  }

  if (options.mode === 'worker') {
    rows.push(...(await workerMode(target, options, bodies, print)))
  } else {
    for (const body of bodies) {
      // The first job after an idle period pays one-off bridge setup (daemon
      // token and handshake caches) that later jobs inherit, so it is measured
      // but excluded: without this, two consecutive bench runs differ by tens of
      // percent and nothing is comparable.
      const warmupRows = []
      for (let index = 0; index < options.warmup; index += 1) {
        const row = await runOnce(target, options, body, options.session)
        row.warmup = true
        warmupRows.push(row)
      }
      if (warmupRows.length && !options.json) {
        const failedWarmup = warmupRows.filter((row) => row.state !== 'succeeded' || row.exitCode !== 0)
        console.log(
          `warmup: ${warmupRows.length} ${body} run(s) ${failedWarmup.length ? 'WITH FAILURES' : 'ok'} ` +
            `(wall ${warmupRows.map((row) => formatMs(row.wallMs)).join(', ')} ms, excluded)`,
        )
      }
      const groups = []
      for (let index = 0; index < options.runs; index += options.concurrent) {
        const batchSize = Math.min(options.concurrent, options.runs - index)
        const batch = await Promise.all(
          Array.from({ length: batchSize }, (_, slot) =>
            runOnce(target, options, body, batchSize > 1 ? `${options.session}-${slot + 1}` : options.session),
          ),
        )
        rows.push(...batch)
        groups.push(batch)
    }
    if (options.concurrent > 1) {
      const totals = groups.map((group) => Math.max(...group.map((row) => row.wallMs)))
      const batchTotal = totals.reduce((sum, value) => sum + value, 0)
      if (!options.json) {
        console.log(
          `${body}: ${options.concurrent} concurrent · slowest batch run ` +
            `${formatMs(Math.max(...totals))} ms · batches summed ${formatMs(batchTotal)} ms`,
        )
      }
    }
    bodyWarmup.set(body, warmupRows)
    }
  }

  const byBody = new Map()
  for (const body of bodies) {
    const bodyRows = rows.filter((row) => row.body === body)
    byBody.set(body, { rows: bodyRows, summary: summarize(bodyRows) })
  }
  const notComparable = [...byBody.values()].some(({ summary }) => summary.tunnelReused.no > 0)
  if (notComparable) warnings.push('one or more runs re-warmed the tunnel; those numbers are not comparable')
  const suspicious = rows.filter((row) => row.phaseSuspicious?.length)
  if (suspicious.length) {
    warnings.push(
      `the runner reported implausible phases in ${suspicious.length} run(s): ` +
        suspicious[0].phaseSuspicious.join(', '),
    )
    if (!options.json) {
      console.log(
        `!! RUNNER PHASE BUG: ${suspicious.length}/${rows.length} runs reported an implausible phase ` +
          `(${suspicious[0].phaseSuspicious.join(', ')}). Those columns print "-". ` +
          'The runner mixes epoch seconds with epoch milliseconds.',
      )
    }
  }
  const failed = rows.filter((row) => row.state !== 'succeeded' || row.exitCode !== 0 || row.timedOut)
  if (failed.length) warnings.push(`${failed.length} of ${rows.length} runs failed`)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          connection: target.connection.name,
          profile: target.profile,
          runner: path.relative(WORKTREE, options.runner),
          runnerSha256: runnerSha,
          mode: options.mode,
          worker: options.mode === 'worker' ? path.relative(WORKTREE, options.worker) : undefined,
          workers: options.mode === 'worker' ? options.workers : undefined,
          holdMs: options.mode === 'worker' ? options.holdMs : undefined,
          startedAt,
          concurrent: options.concurrent,
          warmupPerBody: options.warmup,
          warmupRuns: [...bodyWarmup.values()].flat(),
          bodies: Object.fromEntries([...byBody].map(([body, value]) => [body, value.summary])),
          runs: rows,
          warnings,
        },
        null,
        2,
      ),
    )
  } else {
    for (const body of bodies) {
      const { rows: bodyRows, summary } = byBody.get(body)
      printTable(body, bodyRows, summary)
    }
    if (options.mode === 'worker') {
      console.log('')
      for (const body of bodies) printWorkerSummary(body, byBody.get(body).rows)
      console.log('worker jobs: wall = request→response; the first job per worker pays connect(), later jobs reuse the client')
    } else {
      console.log('')
      console.log('columns: ready = spawn+import+connect (ms), body = script body (ms); - = phase not reported')
    }
  }

  const thresholdRows =
    options.mode === 'worker'
      ? rows.filter((row) => row.body === 'trivial' && row.jobIndex > 1)
      : rows.filter((row) => row.body === 'trivial')
  if (typeof options.threshold === 'number') {
    if (!thresholdRows.length) {
      console.error('bench: no runs to compare against --threshold')
      return 1
    }
    const measured = quantile(thresholdRows.map((row) => row.wallMs).sort((a, b) => a - b), 0.5)
    const scope = options.mode === 'worker' ? 'trivial warm (job#2+)' : 'trivial'
    const verdict = measured <= options.threshold ? 'PASS' : 'FAIL'
    console.log(`threshold: ${scope} median ${formatMs(measured)} ms vs ${options.threshold} ms -> ${verdict}`)
    if (verdict === 'FAIL') return 1
  }
  return failed.length > 0 ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`bench: ${error instanceof Error ? error.message : String(error)}`)
    if (process.env.BENCH_DEBUG && error instanceof Error && error.stack) console.error(error.stack)
    if (error instanceof Error && /needs|unknown option|must be/.test(error.message)) console.error(usage())
    process.exitCode = 1
  })
