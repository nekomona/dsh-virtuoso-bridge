/** Process-wide runtime manager: setup, connections, sidecars, scripts, state. */
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clamp,
  delay,
  ensureDir,
  envForProfile,
  fileExistsSync,
  findExecutable,
  id as newId,
  isLoopbackHost,
  killTree,
  pidAlive,
  profileNameFor,
  readJson,
  readTail,
  runProcess,
  truncate,
  bridgeChildEnv,
  writeJson,
} from './util.js'
import { Sidecar } from './sidecar.js'
import {
  buildSshConfig,
  evaluateHostKeys,
  hostKeyAlgorithmsForTypes,
  hostSpec,
  probeHostKeys,
  trustHostKey,
} from './ssh.js'
import { buildTunnelArgs, pickLocalPort, SshTunnel, tunnelPortUsable } from './tunnel.js'

const RUNTIME_STATES = new Set(['starting', 'connecting', 'waiting', 'running', 'needs-trust', 'stopping', 'stopped', 'error'])
const MAX_LOG_LINES = 500
const MAX_ACTIONS = 60
const MAX_JOBS = 40

export class BridgeManager {
  constructor({ ctx, pluginDir, dataDir, store, setup, credentials, userQuestions, log, version }) {
    this.ctx = ctx
    this.pluginDir = pluginDir
    this.dataDir = dataDir
    this.store = store
    this.setup = setup
    this.credentials = credentials
    this.userQuestions = userQuestions
    this.version = version
    this.logSink = log
    this.runtimes = new Map()
    this.actions = new Map()
    this.jobs = new Map()
    // Long-lived script workers, keyed `${runtimeId}::${sessionId}`. Sessions
    // must never share a process: the key is the isolation boundary.
    this.workers = new Map()
    this.workerStarts = new Map()
    this.workerLocks = new Map()
    this.agentUsage = new Map()
    this.logs = []
    this.listeners = new Set()
    this.secretFlags = {}
    this.orphans = []
    this.setupStatus = { installed: false, loading: true }
    this.cacheInfo = { entries: [], disk: undefined }
    this.dashboard = undefined
    this.installPromise = undefined
    this.installWaiters = []
    this.changeTimer = undefined
    this.healthTimer = undefined
    this.disposed = false
    this.startedAt = Date.now()
    this.#startLogFile()
  }

  // -- lifecycle ----------------------------------------------------------

  async init() {
    await ensureDir(path.join(this.dataDir, 'logs'))
    this.userQuestions = this.userQuestions ?? this.ctx?.get?.('userQuestions')
    this.#log('info', `virtuoso-bridge plugin ${this.version} starting`)
    await this.refreshSecrets()
    await this.setup.ensureInstructions().catch((error) => {
      this.#log('warn', `could not install bridge documentation: ${messageOf(error)}`)
    })
    this.setupStatus = await this.setup.status().catch((error) => ({
      installed: false,
      error: String(error),
    }))
    this.cacheInfo = await this.setup.caches().catch(() => ({ entries: [], disk: undefined }))
    this.orphans = await this.scanOrphans().catch(() => [])
    await this.loadJobs().catch(() => {})
    this.healthTimer = setInterval(() => this.healthLoop().catch(() => {}), 20_000)
    this.healthTimer.unref?.()
    this.emit()
    const autoStart = this.store.snapshot().autoStart ?? []
    if (autoStart.length) {
      delay(750).then(async () => {
        for (const connectionId of autoStart) {
          if (this.disposed) return
          try {
            await this.startRuntime(connectionId, { waitMs: 1, auto: true })
          } catch (error) {
            this.#log('warn', `auto-start ${connectionId} failed: ${messageOf(error)}`)
          }
        }
      })
    }
  }

  async dispose() {
    this.disposed = true
    this.clearTimer(this.healthTimer)
    this.clearTimer(this.changeTimer)
    for (const job of this.jobs.values()) {
      if (job.state === 'running') {
        this.#killJob(job, 'plugin-unloaded')
      }
    }
    const runtimes = [...this.runtimes.values()]
    await Promise.all([...this.workers.values()].map((entry) => this.#disposeWorker(entry, 'plugin-unloaded').catch(() => {})))
    this.workers.clear()
    await Promise.all(
      runtimes.map(async (runtime) => {
        if (runtime.sidecar) {
          await runtime.sidecar.stop({ stopTunnel: true, timeoutMs: 5_000 }).catch(() => {})
        }
        if (runtime.tunnel) await this.#stopPluginTunnel(runtime).catch(() => {})
      }),
    )
    this.runtimes.clear()
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    if (this.disposed || this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      if (this.disposed) return
      const state = this.getState()
      for (const listener of this.listeners) {
        try {
          listener(state)
        } catch {
          // Observers must not break the manager.
        }
      }
    }, 120)
    this.changeTimer.unref?.()
  }

  clearTimer(timer) {
    if (timer) clearTimeout(timer)
  }

  // -- logging ------------------------------------------------------------

  #startLogFile() {
    this.logFile = path.join(this.dataDir, 'logs', 'plugin.log')
    this.logQueue = Promise.resolve()
    this.#log('info', 'plugin log opened')
  }

  #log(level, message) {
    const entry = { time: Date.now(), level, message: String(message) }
    this.logs.push(entry)
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    this.logSink?.(level, entry.message)
    const line = `${new Date(entry.time).toISOString()} [${level}] ${entry.message}\n`
    this.logQueue = (this.logQueue ?? Promise.resolve())
      .then(() => fsp.appendFile(this.logFile, line, 'utf8'))
      .catch(() => {})
  }

  log(level, message) {
    this.#log(level, message)
  }

  // -- secrets ------------------------------------------------------------

  secretKey(connectionId) {
    return `virtuoso-bridge/connection/${connectionId}`
  }

  async readSecret(connectionId) {
    if (!this.credentials) return undefined
    try {
      const record = await this.credentials.readRecord(this.secretKey(connectionId))
      const payload = record?.kind === 'grant' ? record.payload : undefined
      if (payload && typeof payload === 'object') return payload
      if (record?.kind === 'api-key') return { version: 1, daemonToken: record.key }
    } catch (error) {
      this.#log('warn', `could not read credential for ${connectionId}: ${messageOf(error)}`)
    }
    return undefined
  }

  async writeSecret(connectionId, payload) {
    if (!this.credentials) {
      throw new Error('the credentials service is unavailable; start DSH with the credentials plugin enabled')
    }
    const value = {
      version: 1,
      daemonToken: payload.daemonToken ? String(payload.daemonToken) : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await this.credentials.modifyRecord(this.secretKey(connectionId), async () => ({
      kind: 'grant',
      payload: value,
    }))
    this.secretFlags[connectionId] = Boolean(value.daemonToken)
    this.emit()
    return { stored: true, hasDaemonToken: Boolean(value.daemonToken) }
  }

  async clearSecret(connectionId) {
    if (!this.credentials) return false
    await this.credentials.deleteRecord(this.secretKey(connectionId))
    this.secretFlags[connectionId] = false
    this.emit()
    return true
  }

  async refreshSecrets() {
    for (const connection of this.store.snapshot().connections) {
      const secret = await this.readSecret(connection.id)
      this.secretFlags[connection.id] = Boolean(secret?.daemonToken)
    }
    return this.secretFlags
  }

  // -- setup --------------------------------------------------------------

  async refreshSetup(forceProbe = true) {
    this.setupStatus = await this.setup.status()
    this.emit()
    return this.setupStatus
  }

  async refreshCaches(force = false) {
    this.cacheInfo = await this.setup.caches(force)
    this.emit()
    return this.cacheInfo
  }

  async install(options = {}) {
    if (this.installPromise) return this.installPromise
    const preflight = await this.setup.preflight().catch((error) => ({ error: messageOf(error) }))
    if (!options.confirm && preflight?.needsConfirmation) {
      this.setupStatus = { ...(this.setupStatus ?? {}), backends: preflight.backends }
      this.emit()
      return {
        ok: false,
        needsConfirmation: true,
        reason: 'openssh-missing',
        message:
          preflight.message ??
          'OpenSSH (ssh) was not found on PATH. Continue to install the Paramiko backend? The OpenSSH backend will remain unavailable.',
        preflight,
        backends: preflight.backends,
      }
    }
    const action = this.startAction({
      kind: 'setup.install',
      label: options.recreate ? 'Reinstalling virtuoso-bridge' : 'Installing virtuoso-bridge',
      agentId: options.agentId,
    })
    this.#log('info', 'installation started')
    this.setupStatus = { ...(this.setupStatus ?? {}), installing: true, installLog: this.setup.installLog.slice(-80) }
    const progress = setInterval(() => {
      this.setupStatus = {
        ...(this.setupStatus ?? {}),
        installing: true,
        installStartedAt: this.setup.installStartedAt || Date.now(),
        installLog: this.setup.installLog.slice(-100),
      }
      this.emit()
    }, 1500)
    progress.unref?.()
    this.installPromise = (async () => {
      try {
        const result = await this.setup.install({ recreate: options.recreate === true })
        result.preflight = preflight
        if (result.ok) {
          this.#log('info', `installation succeeded: ${result.package?.version ?? 'unknown version'}`)
          this.finishAction(action, 'succeeded')
        } else {
          this.#log('error', `installation failed: ${result.error}`)
          this.finishAction(action, 'failed', result.error)
        }
        this.setupStatus = await this.setup.status()
        this.emit()
        return result
      } finally {
        clearInterval(progress)
        this.installPromise = undefined
        this.emit()
      }
    })()
    return this.installPromise
  }

  async updateSource(patch) {
    const source = { ...this.store.snapshot().source, ...(patch ?? {}) }
    await this.store.update({ source })
    this.setup.invalidate()
    this.setupStatus = await this.setup.status()
    this.emit()
    return this.setupStatus
  }

  async updateSettings(patch) {
    const accepted = {}
    for (const key of ['pythonPath', 'autoInstall', 'autoStart', 'defaultConnection', 'logToCiw', 'maxScripts', 'scriptWorker', 'scriptWorkerIdleMs', 'scriptWorkerMax', 'source', 'cacheDir', 'installSshExtra', 'defaultRemoteScratchRoot']) {
      if (patch?.[key] !== undefined) accepted[key] = patch[key]
    }
    if (accepted.cacheDir !== undefined) {
      const value = String(accepted.cacheDir ?? '').trim()
      if (value) {
        const directory = path.resolve(value)
        await ensureDir(directory)
        const probe = path.join(directory, `.vb-write-${process.pid}-${Date.now()}`)
        try {
          await fsp.writeFile(probe, 'ok', 'utf8')
          await fsp.rm(probe, { force: true })
        } catch (error) {
          throw new Error(`cache directory is not writable: ${directory}: ${messageOf(error)}`)
        }
        accepted.cacheDir = directory
      } else {
        accepted.cacheDir = ''
      }
    }
    if (accepted.installSshExtra !== undefined) accepted.installSshExtra = accepted.installSshExtra !== false
    if (accepted.defaultRemoteScratchRoot !== undefined) {
      const value = String(accepted.defaultRemoteScratchRoot ?? '').trim()
      if (value && !value.startsWith('/') && !value.startsWith('~/')) {
        throw new Error('defaultRemoteScratchRoot must be an absolute remote path or start with ~/')
      }
      accepted.defaultRemoteScratchRoot = value
    }
    await this.store.update(accepted)
    this.setup.invalidate()
    await this.refreshSecrets()
    this.setupStatus = await this.setup.status()
    await this.refreshCaches(true).catch(() => {})
    this.emit()
    return { settings: this.store.snapshot(), setup: this.setupStatus }
  }

  async diagnose(options = {}) {
    const action = this.startAction({ kind: 'setup.diagnose', label: 'Diagnosing the Python environment', agentId: options.agentId })
    try {
      const result = await this.setup.diagnose()
      let dashboard
      try {
        dashboard = await this.dashboard?.selfTest?.()
      } catch (error) {
        dashboard = { ok: false, error: messageOf(error) }
      }
      if (dashboard) {
        result.checks = Array.isArray(result.checks) ? result.checks : []
        result.checks.push({
          name: 'dashboard',
          ok: Boolean(dashboard.ok),
          detail: dashboard.ok
            ? `${dashboard.route} answered health=${dashboard.healthStatus} state=${dashboard.stateStatus}`
            : `${dashboard.route ?? '(no route)'} failed: ${dashboard.error ?? 'unknown error'}`,
        })
        result.dashboard = dashboard
        result.ok = result.ok && Boolean(dashboard.ok)
      }
      this.finishAction(action, result.ok ? 'succeeded' : 'failed', result.ok ? undefined : 'one or more checks failed')
      return result
    } catch (error) {
      this.finishAction(action, 'failed', messageOf(error))
      throw error
    }
  }

  // -- connections --------------------------------------------------------

  async saveConnection(input, secret, options = {}) {
    const before = input?.id
      ? this.store.connection(input.id)
      : input?.name
        ? this.store.connection(input.name)
        : undefined
    const saved = await this.store.upsertConnection(input)
    if (secret) {
      const existing = (await this.readSecret(saved.id)) ?? {}
      const payload = {
        daemonToken: secret.daemonToken !== undefined ? String(secret.daemonToken) : existing.daemonToken,
      }
      if (secret.daemonToken === null || secret.daemonToken === '') payload.daemonToken = undefined
      await this.writeSecret(saved.id, payload)
    }
    await this.refreshSecrets()
    const related = [...this.runtimes.values()].filter((item) => item.connectionId === saved.id)
    for (const runtime of related) {
      const sub = runtime.subInstanceId
        ? (saved.subInstances ?? []).find((item) => item.id === runtime.subInstanceId)
        : undefined
      if (runtime.subInstanceId && !sub) {
        await this.stopRuntime(runtime.id, { stopTunnel: true }).catch(() => {})
        this.runtimes.delete(runtime.id)
        continue
      }
      runtime.connection = this.runtimeConnectionFor(saved, sub)
      runtime.profile = this.runtimeProfileFor(saved, sub)
      runtime.subInstance = sub
      runtime.subInstanceId = sub?.id
      runtime.subInstanceName = sub?.name || runtime.connection.subInstanceName
      runtime.hostKeyCheckedAt = undefined
      runtime.hostKeyProbe = undefined
      runtime.hostKeyAlgorithms = undefined
      runtime.sshEndpoint = undefined
      runtime.sshConfigPath = undefined
      runtime.attach = undefined
      runtime.scratchRoot = ''
      runtime.scratchConfigured = ''
      runtime.pendingHostKey = undefined
      if (runtime.state === 'needs-trust') runtime.state = 'stopped'
      runtime.error = undefined
      runtime.errorDetail = undefined
      runtime.stage = 'stopped'
    }
    this.#log('info', `connection ${saved.name} ${before ? 'updated' : 'saved'}`)
    const connection = this.publicConnection(saved)
    connection.updated = Boolean(before)
    connection.created = !before
    if (options.restart && this.runtimes.has(`rt_${saved.id}`)) {
      await this.startRuntime(saved.id, { waitMs: 200, restart: true }).catch(() => {})
    }
    this.emit()
    return connection
  }

  async deleteConnection(ref, options = {}) {
    const connection = this.store.connection(ref)
    if (!connection) throw new Error(`unknown connection ${ref}`)
    const runtimes = [...this.runtimes.values()].filter((item) => item.connectionId === connection.id)
    for (const runtime of runtimes) {
      await this.stopRuntime(runtime.id, { stopTunnel: true }).catch(() => {})
      this.runtimes.delete(runtime.id)
    }
    await this.clearSecret(connection.id).catch(() => {})
    await this.store.removeConnection(connection.id)
    this.orphans = await this.scanOrphans().catch(() => [])
    this.#log('info', `connection ${connection.name} deleted`)
    this.emit()
    return { deleted: connection.id }
  }

  daemonInfo(daemon) {
    if (!daemon || daemon.daemon_responsive === undefined) {
      return { state: 'unknown', checked: false, summary: daemon?.summary }
    }
    return {
      state: daemon.daemon_responsive ? 'ready' : daemon.tcp_reachable ? 'no-response' : 'unreachable',
      checked: true,
      responsive: Boolean(daemon.daemon_responsive),
      tcpReachable: Boolean(daemon.tcp_reachable),
      tunnelAlive: Boolean(daemon.tunnel_process_alive),
      summary: daemon.summary,
      checkedAt: Date.now(),
    }
  }

  async deployDaemon(ref, options = {}) {
    const connection = this.store.connection(this.connectionRef(ref))
    if (!connection) throw new Error(`unknown connection ${ref}`)
    const deployConnection = {
      ...connection,
      autoSessions: Boolean(connection.autoSessions || (connection.subInstances ?? []).length),
    }
    const profile = this.profileFor(connection)
    const env = this.buildConnectionEnv(deployConnection, profile)
    env.VB_PLUGIN_DATA_DIR = this.dataDir
    env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
    env.VB_RUNTIME_PROFILE = profile
    const args = [
      '-E', '-s',
      path.join(this.pluginDir, 'runtime', 'vb_deploy.py'),
      '--profile', profile,
      '--env-file', await this.emptyRuntimeEnvFile(),
    ]
    if (connection.instancePort) args.push('--instance-port', String(connection.instancePort))
    if (options.replace) args.push('--replace')
    const result = await runProcess(this.setup.venvPython, args, {
      env,
      cwd: this.dataDir,
      timeoutMs: 240_000,
      maxOutput: 200_000,
    })
    let parsed
    try {
      parsed = JSON.parse((result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}')
    } catch {
      parsed = undefined
    }
    if (!parsed?.ok) {
      const message = parsed?.error ?? (result.stderr || result.stdout || 'daemon deployment returned no result').trim().slice(-3000)
      const error = new Error(message)
      error.code = parsed?.errorCode ?? 'DEPLOY_FAILED'
      error.details = {
        code: parsed?.errorCode,
        path: parsed?.path,
        hint: parsed?.hint,
        scratchRoot: parsed?.scratchRoot,
        resolvedRoot: parsed?.resolvedRoot,
        scratchConfigured: parsed?.scratchConfigured,
        scratchCreated: parsed?.scratchCreated,
        scratchTightened: parsed?.scratchTightened,
        stage: 'deploy',
      }
      throw error
    }
    const settings = this.store.snapshot()
    return {
      ...parsed,
      configuredScratchRoot: connection.remoteScratchRoot || settings.defaultRemoteScratchRoot || '',
      connection: this.compactConnection(this.publicConnection(connection)),
    }
  }

  async #discoverInstances(connection, profile, env, options = {}) {
    const args = [
      '-E', '-s',
      path.join(this.pluginDir, 'runtime', 'vb_instances.py'),
      '--profile', profile,
      '--timeout', String(Math.max(5, Number(options.timeoutSec) || 20)),
      '--env-file', await this.emptyRuntimeEnvFile(),
    ]
    if (connection.instancePort) args.push('--instance-port', String(connection.instancePort))
    const result = await runProcess(this.setup.venvPython, args, {
      env,
      cwd: this.dataDir,
      timeoutMs: 60_000,
      maxOutput: 200_000,
    })
    let parsed
    try {
      parsed = JSON.parse((result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}')
    } catch {
      parsed = undefined
    }
    if (!parsed?.ok) {
      throw new Error(parsed?.error ?? (result.stderr || result.stdout || 'instance discovery returned no result').trim().slice(-2000))
    }
    return {
      autoSessions: Boolean(parsed.autoSessions),
      instances: parsed.instances ?? [],
      selected: parsed.selected ?? null,
      expectedWorkDir: parsed.expectedWorkDir ?? '',
      setupPath: parsed.setupPath ?? null,
    }
  }

  async listInstances(ref, options = {}) {
    const connection = this.store.connection(this.connectionRef(ref))
    if (!connection) throw new Error(`unknown connection ${ref}`)
    const profile = this.profileFor(connection)
    const env = this.buildConnectionEnv(connection, profile)
    env.VB_PLUGIN_DATA_DIR = this.dataDir
    env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
    env.VB_RUNTIME_PROFILE = profile
    const discovered = await this.#discoverInstances(connection, profile, env, options)
    return {
      ok: true,
      connection: this.compactConnection(this.publicConnection(connection)),
      ...discovered,
    }
  }

  async testConnection(ref, options = {}) {
    const connection = this.store.connection(ref)
    if (!connection) throw new Error(`unknown connection ${ref}`)
    const action = this.startAction({
      kind: 'connection.test',
      label: `Testing ${connection.name}`,
      connectionId: connection.id,
      agentId: options.agentId,
    })
    try {
      const local = connection.kind === 'local' || isLoopbackHost(connection.host)
      const started = Date.now()
      let ok = false
      let ready = false
      let verdict = 'failed'
      let detail = ''
      let pendingHostKey
      let checks = {}
      let ssh = { ok: false }
      let remotePython
      let scratchRoot
      let daemon = { state: 'unknown', checked: false, summary: 'not probed' }
      let runtime = options.runtime ? this.runtimes.get(String(options.runtime)) : undefined
      const explicitRuntime = Boolean(options.runtime || options.subInstance || options.workDir)
      let subInstance
      if (!runtime && (options.subInstance || options.workDir)) {
        subInstance = this.findSubInstance(connection, options.subInstance ?? options.workDir)
        runtime = this.runtimes.get(this.runtimeKeyFor(connection, subInstance))
      }
      // An explicit runtime/sub-instance must not silently fall back to the base
      // runtime: its tunnel would point at a different profile/workdir.
      if (!runtime && !explicitRuntime) runtime = this.runtimes.get(`rt_${connection.id}`)
      // Reuse the Host-owned forward when this runtime already has one. The
      // health helper then adopts that PID instead of opening a second tunnel.
      const reusedTunnel = runtime?.tunnel?.alive ? runtime.tunnel : undefined
      // A stopped sub-instance Test still uses its own profile/workdir so a Host
      // probe tunnel and the SSH helper resolve the same endpoint.
      const testedConnection = runtime?.connection ?? (subInstance ? this.runtimeConnectionFor(connection, subInstance) : connection)
      const testedProfile = runtime?.profile ?? (subInstance ? this.runtimeProfileFor(connection, subInstance) : this.profileFor(connection))
      if (local) {
        const probePort = connection.instancePort || connection.port
        ssh = { ok: true, local: true, detail: 'local connection: SSH is not used' }
        if (!probePort) {
          ok = false
          detail = 'automatic local instance discovery requires a Linux daemon host; select an instance port or use a remote host'
          daemon = { state: 'unknown', checked: false, summary: detail }
        } else {
          const result = await tcpProbe(connection.host, probePort, 5_000)
          ok = true
          daemon = {
            state: result.ok ? 'ready' : 'unreachable',
            checked: true,
            responsive: result.ok,
            tcpReachable: result.ok,
            port: probePort,
            summary: result.detail,
          }
          detail = result.detail
        }
        ready = ok && daemon.state === 'ready'
        verdict = ready ? 'ready' : ok ? 'daemon-not-ready' : 'unreachable'
        checks = { ssh, daemon }
        if (!detail) detail = summarizeHealth(checks, ok)
      } else {
        const effectiveConnection = testedConnection
        const profile = testedProfile
        const env = this.buildConnectionEnv(effectiveConnection, profile)
        env.VB_RUNTIME_PROFILE = profile
        env.VB_PLUGIN_DATA_DIR = this.dataDir
        env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
        const probePort = reusedTunnel
          ? Number(reusedTunnel.remotePort) || 0
          : effectiveConnection.autoSessions
            ? Number(effectiveConnection.instancePort) || 0
            : Number(effectiveConnection.port) || 0
        const helper = path.join(this.pluginDir, 'runtime', 'vb_health.py')
        const args = [
          '-E', '-s', helper,
          '--profile', profile,
          '--timeout', '20',
          '--env-file', await this.emptyRuntimeEnvFile(),
        ]
        let probeTunnel
        let probeTunnelError
        if (reusedTunnel) {
          // Point the helper at the running runtime's forward (PID + ports).
          // `vb_health.py` adopts it through the same shim as the sidecar, so its
          // `ensure_tunnel()` is a no-op and its cleanup cannot kill the PID.
          this.applyTunnelEnv(runtime, env)
          if (probePort) args.push('--port', String(probePort))
          this.#log(
            'debug',
            `test of ${connection.name} reuses the runtime SSH tunnel on localhost:${reusedTunnel.localPort}`,
          )
        } else if (probePort > 0) {
          // The runtime is stopped, but its daemon port is known: open a short
          // Host-owned probe tunnel (hidden, non-detached) for this Test instead
          // of letting the helper spawn the old free-running upstream forward.
          const budget = Math.min(45_000, Math.max(15_000, (Number(effectiveConnection.connectTimeoutSec) || 20) * 1000))
          try {
            probeTunnel = await this.launchTunnel(effectiveConnection, probePort, {
              timeoutMs: budget,
              label: `${connection.name} test tunnel`,
            })
          } catch (error) {
            probeTunnelError = error
            this.#log(
              'warn',
              `test of ${connection.name}: Host probe tunnel could not be opened: ${messageOf(error)}`,
            )
          }
          if (probeTunnel) {
            this.applyTunnelEnv({ connection: effectiveConnection, profile, tunnel: probeTunnel }, env)
            args.push('--port', String(probePort))
            this.#log(
              'debug',
              `test of ${connection.name} uses a Host probe tunnel on localhost:${probeTunnel.localPort}`,
            )
          }
        }
        let probe
        try {
          probe = await runProcess(this.setup.venvPython, args, {
            env,
            timeoutMs: 60_000,
            maxOutput: 120_000,
          })
        } finally {
          if (probeTunnel) await probeTunnel.stop({ timeoutMs: 5_000 }).catch(() => {})
        }
        let parsed
        try {
          parsed = JSON.parse((probe.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '')
        } catch {
          parsed = undefined
        }
        if (parsed?.checks) {
          checks = parsed.checks
          ssh = checks.ssh ?? { ok: false }
          remotePython = checks.remotePython
          scratchRoot = checks.scratchRoot
          daemon = checks.daemon ?? daemon
          ok = ssh.ok === true
          ready = parsed.ready === true
          verdict = parsed.verdict ?? (ready ? 'ready' : ok ? 'daemon-not-ready' : 'unreachable')
          detail = summarizeHealth(checks, ok)
          if (probeTunnelError) {
            // SSH checks still ran without a tunnel; report the real reason the
            // daemon could not be probed instead of a generic no-listener.
            const reason = messageOf(probeTunnelError)
            daemon = {
              checked: true,
              state: 'unreachable',
              port: probePort || undefined,
              remotePort: probePort || undefined,
              error: reason,
              summary: `Host test tunnel failed: ${reason}`,
              source: 'probe',
            }
            checks = { ...checks, daemon }
            ready = false
            verdict = ok ? 'daemon-not-ready' : 'unreachable'
            detail = summarizeHealth(checks, ok)
          }
        } else {
          ok = false
          verdict = 'failed'
          detail = String(
            parsed?.error ??
              probe.stderr ??
              probe.stdout ??
              (probeTunnelError ? messageOf(probeTunnelError) : 'health helper produced no result'),
          ).slice(-1500)
          ssh = { ok: false, error: detail }
        }
        if (!ok && /host key|known_hosts|authenticity of host|remote host identification|no matching host key/i.test(`${ssh.error ?? ''} ${detail}`)) {
          const hostKeyProbe = await probeHostKeys(connection, {
            dataDir: this.dataDir,
            pluginDir: this.pluginDir,
            python: this.setup.venvPython,
            backend: connection.sshBackend,
          }).catch((error) => ({ ok: false, entries: [], error: messageOf(error) }))
          if (hostKeyProbe.ok && hostKeyProbe.entries?.length) {
            const endpoint = hostKeyProbe.endpoint
            const evaluation = await evaluateHostKeys(hostKeyProbe.entries, connection, {
              dataDir: this.dataDir,
              pluginDir: this.pluginDir,
              python: this.setup.venvPython,
              endpoint,
            }).catch(() => ({ unknown: [], conflicts: [], known: [] }))
            pendingHostKey = {
              host: connection.host,
              resolvedHost: endpoint?.host,
              sshPort: endpoint?.port ?? (Number(connection.sshPort) || 22),
              knownHostSpecs: endpoint?.knownHostSpecs,
              entries: hostKeyProbe.entries,
              unknown: evaluation.unknown,
              conflicts: evaluation.conflicts,
              source: hostKeyProbe.source,
              message: 'The SSH host key is not trusted yet.',
            }
          }
        }
      }
      if (runtime?.sidecar && ['running', 'waiting'].includes(runtime.state)) {
        try {
          const status = await runtime.sidecar.request('status', {}, 10_000)
          runtime.status = status
          runtime.lastHealthAt = Date.now()
          daemon = { ...this.daemonInfo(status.daemon), source: 'runtime' }
          checks = { ...checks, daemon }
          ready = daemon.state === 'ready'
          verdict = ready ? 'ready' : ok ? 'daemon-not-ready' : 'unreachable'
          if (!detail) detail = summarizeHealth(checks, ok)
        } catch (error) {
          daemon = { state: 'unreachable', checked: true, summary: messageOf(error), source: 'runtime' }
          checks = { ...checks, daemon }
        }
      }
      this.finishAction(action, ok ? 'succeeded' : 'failed', detail)
      return {
        ok,
        ready,
        verdict,
        latencyMs: Date.now() - started,
        detail: String(detail).slice(-1500),
        checks,
        ssh,
        remotePython,
        scratchRoot,
        daemon,
        pendingHostKey,
        connection: this.compactConnection(this.publicConnection(connection)),
      }
    } catch (error) {
      this.finishAction(action, 'failed', messageOf(error))
      throw error
    }
  }

  async inspectHostKey(ref) {
    const connection = this.store.connection(this.connectionRef(ref))
    if (!connection) throw new Error(`unknown connection ${ref}`)
    // Probe the resolved endpoint with the user's own ssh_config. Generating or
    // deleting a pinned config here could remove the file a running runtime's
    // tunnel was started with.
    const probe = await probeHostKeys(connection, {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      backend: connection.sshBackend,
    })
    if (!probe.ok) {
      return { ok: false, connection: this.publicConnection(connection), probe }
    }
    const endpoint = probe.endpoint
    const evaluation = await evaluateHostKeys(probe.entries, connection, {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      endpoint,
    })
    const describeEntry = (entry) => ({
      host: entry.hostSpec || hostSpec(entry.host, endpoint?.port ?? connection.sshPort),
      knownHostSpecs: entry.knownHostSpecs,
      role: entry.role,
      resolvedHost: entry.resolvedHost,
      type: entry.type,
      fingerprint: entry.fingerprint,
    })
    return {
      ok: true,
      connection: this.publicConnection(connection),
      host: connection.host,
      sshPort: endpoint?.port ?? (Number(connection.sshPort) || 22),
      resolvedHost: endpoint?.host,
      knownHostSpecs: endpoint?.knownHostSpecs,
      entries: probe.entries.map(describeEntry),
      known: evaluation.known.map((entry) => entry.fingerprint),
      unknown: evaluation.unknown.map((entry) => entry.fingerprint),
      conflicts: evaluation.conflicts.map((item) => ({
        incoming: item.incoming.fingerprint,
        incomingHost: item.incoming.hostSpec || item.incoming.knownHostSpecs?.[0],
        existing: item.existing.map((entry) => entry.fingerprint),
      })),
      source: probe.source,
    }
  }

  async trustHost(ref, fingerprint, options = {}) {
    const connection = this.store.connection(this.connectionRef(ref))
    if (!connection) throw new Error(`unknown connection ${ref}`)
    if (!fingerprint) throw new Error('fingerprint is required')
    const runtimeId = options.runtimeId
      ?? this.runtimeKeyFor(connection, options.subInstance ? this.findSubInstance(connection, options.subInstance) : undefined)
    const runtime = this.runtimes.get(runtimeId)
    // The probe resolves HostName/Port/HostKeyAlias and only ever writes a key
    // it actually offered; the tool-supplied fingerprint selects, never defines.
    const result = await trustHostKey(connection, String(fingerprint), {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      knownHostsPath: options.knownHostsPath,
      endpoint: options.endpoint,
      backend: connection.sshBackend,
    })
    if (runtime) {
      if (result.trusted) {
        runtime.pendingHostKey = undefined
        runtime.hostKeyProbe = undefined
        runtime.hostKeyCheckedAt = Date.now()
        runtime.error = undefined
        runtime.errorDetail = undefined
        runtime.stage = 'stopped'
        if (runtime.state === 'needs-trust') runtime.state = 'stopped'
        this.#log('info', `trusted ${result.entry?.type ?? 'host'} key ${fingerprint} for ${connection.name}`)
        try {
          runtime.hostKeyResolve?.('trusted')
        } catch {
          // ignore
        }
      } else {
        runtime.error = result.message || 'host key conflict'
        this.#log('warn', `host key conflict for ${connection.name}: ${runtime.error}`)
      }
    }
    this.emit()
    return {
      ...result,
      connection: this.publicConnection(connection),
      entry: result.entry
        ? {
            host: result.entry.hostSpec || hostSpec(connection.host, connection.sshPort),
            knownHostSpecs: result.entry.knownHostSpecs,
            role: result.entry.role,
            resolvedHost: result.entry.resolvedHost,
            type: result.entry.type,
            fingerprint: result.entry.fingerprint,
          }
        : undefined,
    }
  }

  publicConnection(connection) {
    const runtime = this.runtimes.get(`rt_${connection.id}`)
    const snapshot = runtime ? this.snapshotRuntime(runtime) : undefined
    return {
      ...connection,
      hasSecret: Boolean(this.secretFlags[connection.id]),
      runtimeId: `rt_${connection.id}`,
      runtime: snapshot?.state ?? 'stopped',
      connectionStatus: snapshot?.connectionStatus ?? 'stopped',
      daemon: snapshot?.daemon,
    }
  }

  // -- runtimes -----------------------------------------------------------

  #newRuntime(connection, options = {}) {
    return {
      id: options.id ?? `rt_${connection.id}`,
      connectionId: connection.id,
      connection,
      profile: options.profile,
      subInstance: options.subInstance,
      subInstanceId: options.subInstance?.id,
      subInstanceName: options.subInstance?.name,
      state: 'stopped',
      startedAt: undefined,
      lastUsedAt: undefined,
      lastHealthAt: undefined,
      health: undefined,
      error: undefined,
      errorDetail: undefined,
      pendingHostKey: undefined,
      hostKeyProbe: undefined,
      hostKeyCheckedAt: undefined,
      hostKeyAlgorithms: undefined,
      sshEndpoint: undefined,
      sshConfigPath: undefined,
      attach: undefined,
      scratchRoot: '',
      scratchConfigured: '',
      hostKeyResolve: undefined,
      hostKeyWait: undefined,
      daemon: undefined,
      daemonProbe: undefined,
      instance: undefined,
      daemonCompatibility: undefined,
      dialog: undefined,
      projectWorkDir: undefined,
      wasReady: false,
      stage: undefined,
      envShell: undefined,
      setupHint: undefined,
      sidecar: undefined,
      tunnel: undefined,
      tunnelDropped: undefined,
      tunnelRestarts: 0,
      resolvedInstancePort: undefined,
      instanceRecord: undefined,
      pid: undefined,
      startPromise: undefined,
      agentUsage: new Map(),
      actionIds: new Set(),
      logTail: [],
      status: undefined,
    }
  }

  runtimeKeyFor(connection, sub) {
    return sub ? `rt_${connection.id}__${sub.id}` : `rt_${connection.id}`
  }

  profileFor(connection) {
    return profileNameFor(connection.name || connection.id)
  }

  runtimeProfileFor(connection, sub) {
    const subName = sub ? sub.name || String(sub.workDir || '').replace(/\/+$/, '').split('/').filter(Boolean).at(-1) || sub.id : ''
    return profileNameFor(`${connection.name || connection.id}${subName ? `_${subName}` : ''}`)
  }

  runtimeConnectionFor(connection, sub) {
    if (!sub) return connection
    const leaf = String(sub.workDir || '').replace(/\/+$/, '').split('/').filter(Boolean).at(-1)
    const name = sub.name || leaf || 'workdir'
    return {
      ...connection,
      name: `${connection.name} / ${name}`,
      autoSessions: true,
      remoteWorkDir: sub.workDir,
      instancePort: sub.instancePort,
      subInstanceId: sub.id,
      subInstanceName: name,
    }
  }

  findSubInstance(connection, value) {
    const text = String(value ?? '').trim()
    if (!text) return undefined
    const sub = (connection.subInstances ?? []).find(
      (item) => item.id === text || item.name === text || item.workDir === text,
    )
    if (!sub) throw new Error(`unknown sub-instance ${value} for connection ${connection.name}`)
    return sub
  }

  runtimeRef(ref) {
    if (!ref) {
      const settings = this.store.snapshot()
      const preferred = settings.defaultConnection
        ? this.runtimes.get(`rt_${settings.defaultConnection}`)
        : undefined
      const active = new Set(['running', 'waiting', 'starting', 'connecting'])
      if (preferred && active.has(preferred.state)) return preferred
      const live = [...this.runtimes.values()].filter((runtime) => active.has(runtime.state))
      if (live.length === 1) return live[0]
      if (live.length > 1) throw new Error(`multiple runtimes are active (${live.map((item) => item.id).join(', ')}); name one`)
      return preferred
    }
    const text = String(ref)
    if (this.runtimes.has(text)) return this.runtimes.get(text)
    const connection = this.store.connection(text)
    if (connection) return this.runtimes.get(`rt_${connection.id}`)
    return undefined
  }

  async startRuntime(ref, options = {}) {
    const direct = ref ? this.runtimes.get(String(ref)) : undefined
    const connection = this.store.connection(direct ? direct.connectionId : this.connectionRef(ref))
    if (!connection) throw new Error(`unknown connection ${ref}`)
    if (!connection.enabled) throw new Error(`connection ${connection.name} is disabled`)
    let sub = direct?.subInstance ?? null
    if (!sub && (options.subInstance || options.workDir)) {
      sub = this.findSubInstance(connection, options.subInstance ?? options.workDir)
    }
    const runtimeId = this.runtimeKeyFor(connection, sub)
    const profile = this.runtimeProfileFor(connection, sub)
    let runtime = this.runtimes.get(runtimeId)
    if (runtime && options.agentId) this.attachAgent(options.agentId, runtime, 'runtime.start')
    if (options.restart && runtime) {
      await this.stopRuntime(runtimeId, { stopTunnel: true, keepTunnelRestarts: true }).catch(() => {})
      runtime = undefined
    } else if (runtime && ['running', 'waiting'].includes(runtime.state)) {
      return this.snapshotRuntime(runtime)
    } else if (runtime?.startPromise) {
      // A start (or a host-key question) is already in flight. Wait for it
      // instead of returning "starting" immediately, which made a poll look
      // frozen even when the daemon was already reachable.
      const waitMs = clamp(Number(options.waitMs ?? 15_000), 0, 180_000)
      if (waitMs === 0) return { ...this.snapshotRuntime(runtime), pending: true }
      const result = await Promise.race([
        runtime.startPromise.then(() => ({ done: true })).catch(() => ({ done: true })),
        delay(waitMs).then(() => ({ done: false })),
      ])
      if (result.done && runtime.state === 'error') {
        const failure = new Error(runtime.error ?? 'runtime failed to start')
        failure.details = runtime.errorDetail
        throw failure
      }
      return { ...this.snapshotRuntime(runtime), ...(result.done ? {} : { pending: true }) }
    } else if (runtime && ['starting', 'connecting', 'stopping'].includes(runtime.state)) {
      const waitMs = clamp(Number(options.waitMs ?? 15_000), 0, 180_000)
      if (waitMs > 0) await this.waitForChange(waitMs)
      return this.snapshotRuntime(runtime)
    }
    if (!runtime) {
      runtime = this.#newRuntime(this.runtimeConnectionFor(connection, sub), { id: runtimeId, profile, subInstance: sub })
      this.runtimes.set(runtimeId, runtime)
      if (options.agentId) this.attachAgent(options.agentId, runtime, 'runtime.start')
    }
    runtime.connection = this.runtimeConnectionFor(connection, sub)
    runtime.profile = profile
    runtime.subInstance = sub
    runtime.subInstanceId = sub?.id
    runtime.subInstanceName = sub?.name || runtime.connection.subInstanceName
    runtime.autoSessions = runtime.connection.autoSessions
    runtime.instancePort = runtime.connection.instancePort
    runtime.state = 'starting'
    runtime.error = undefined
    runtime.errorDetail = undefined
    runtime.tunnelDropped = undefined
    runtime.resolvedInstancePort = undefined
    runtime.instanceRecord = undefined
    runtime.stage = 'start'
    runtime.startedAt = Date.now()
    runtime.startPromise = this.#startRuntimeInner(runtime, options)
    const waitMs = clamp(Number(options.waitMs ?? 15_000), 0, 180_000)
    if (waitMs === 0) return this.snapshotRuntime(runtime)
    const result = await Promise.race([
      runtime.startPromise.then(() => ({ done: true })).catch(() => ({ done: true })),
      delay(waitMs).then(() => ({ done: false })),
    ])
    if (!result.done) {
      return { ...this.snapshotRuntime(runtime), pending: true }
    }
    if (runtime.state === 'error') {
      const failure = new Error(runtime.error ?? 'runtime failed to start')
      failure.details = runtime.errorDetail
      throw failure
    }
    return this.snapshotRuntime(runtime)
  }

  connectionRef(ref) {
    if (ref) {
      // Tool calls often name the runtime (rt_...) instead of the connection.
      const runtime = this.runtimes.get(String(ref))
      return runtime ? runtime.connectionId : ref
    }
    const settings = this.store.snapshot()
    if (settings.defaultConnection && this.store.connection(settings.defaultConnection)) {
      return settings.defaultConnection
    }
    if (settings.connections.length === 1) return settings.connections[0].id
    if (!settings.connections.length) throw new Error('no server connection is configured; add one in the Virtuoso Bridge settings')
    throw new Error(`connection is required; choose one of ${settings.connections.map((item) => item.name).join(', ')}`)
  }

  async detectShell(ref, options = {}) {
    const connection = this.store.connection(this.connectionRef(ref))
    if (!connection) throw new Error(`unknown connection ${ref}`)
    if (!connection.cadenceEnvScript) {
      return {
        ok: false,
        connection: this.publicConnection(connection),
        reason: 'no Cadence environment script is configured; set cadenceEnvScript first',
        recommended: null,
      }
    }
    const probe = await this.setup.probeVenv()
    if (!probe.ok) throw new Error(`the plugin venv is not ready: ${probe.reason}`)
    const profile = this.profileFor(connection)
    const env = this.buildConnectionEnv(connection, profile)
    env.VB_PLUGIN_DATA_DIR = this.dataDir
    env.VB_RUNTIME_PROFILE = profile
    const sshConfig = await this.#ensureSshConfig(connection)
    if (sshConfig) env.VB_SSH_CONFIG = sshConfig
    const action = this.startAction({
      kind: 'shell.detect',
      label: `Detecting the shell for ${connection.name}`,
      connectionId: connection.id,
      agentId: options.agentId,
    })
    try {
      const result = await runProcess(
        this.setup.venvPython,
        [
          '-E', '-s',
          path.join(this.pluginDir, 'runtime', 'vb_shell_probe.py'),
          '--profile', profile,
          '--script', connection.cadenceEnvScript,
          '--timeout', String(Math.max(10, Number(connection.shellProbeTimeoutSec) || 35)),
        ],
        { env, cwd: this.dataDir, timeoutMs: 120_000, maxOutput: 200_000 },
      )
      let parsed
      try {
        parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '')
      } catch {
        parsed = undefined
      }
      if (!parsed) {
        throw new Error(`shell probe returned no JSON: ${(result.stderr || result.stdout).trim().slice(-2000)}`)
      }
      let saved = connection
      if (parsed.recommended) {
        saved = await this.store.upsertConnection({
          ...connection,
          detectedShell: parsed.recommended,
          detectedAt: Date.now(),
          detectedScript: connection.cadenceEnvScript,
        })
        const runtime = this.runtimes.get(`rt_${connection.id}`)
        if (runtime) runtime.connection = saved
        this.#log('info', `shell auto-detected for ${connection.name}: ${parsed.recommended}`)
      } else {
        this.#log('warn', `shell detection for ${connection.name} found no Virtuoso environment: ${JSON.stringify(parsed.results ?? {}).slice(0, 800)}`)
      }
      this.finishAction(action, parsed.recommended ? 'succeeded' : 'failed', parsed.recommended ? undefined : 'no shell exposed Virtuoso')
      this.emit()
      return { ...parsed, ok: Boolean(parsed.recommended), connection: this.publicConnection(saved) }
    } catch (error) {
      this.finishAction(action, 'failed', messageOf(error))
      this.emit()
      throw error
    }
  }

  async #resolveShell(connection) {
    if (connection.envShell === 'csh' || connection.envShell === 'sh') return connection.envShell
    if (!connection.cadenceEnvScript) return 'csh'
    const cached =
      connection.detectedShell &&
      connection.detectedScript === connection.cadenceEnvScript &&
      connection.detectedAt &&
      Date.now() - connection.detectedAt < 24 * 60 * 60 * 1000
    if (cached) return connection.detectedShell
    try {
      const detection = await this.detectShell(connection.id)
      if (detection.recommended) return detection.recommended
      this.#log('warn', `shell detection for ${connection.name} found nothing; falling back to csh`)
    } catch (error) {
      this.#log('warn', `shell detection for ${connection.name} failed: ${messageOf(error)}; falling back to csh`)
    }
    return 'csh'
  }

  async #promptHostKey(runtime, pending, options = {}) {
    if (!pending.unknown?.length) return 'cancel'
    if (!this.userQuestions?.ask) {
      this.#log('warn', 'userQuestions service is unavailable; host-key confirmation stays in the dashboard')
      return 'unavailable'
    }
    const configuredAgent = options.agentId ? this.ctx?.get?.('agents')?.get?.(options.agentId) : undefined
    const liveRoots = this.ctx?.get?.('agents')?.roots?.() ?? []
    const agent = options.agent ?? configuredAgent ?? (liveRoots.length === 1 ? liveRoots[0] : undefined)
    if (!agent) {
      this.#log('warn', 'no unambiguous live agent is available for a host-key confirmation question')
      return 'unavailable'
    }
    const entries = pending.unknown
    const fingerprints = entries
      .map((entry) => {
        const host = entry.knownHostSpecs?.[0] || entry.hostSpec || pending.host
        const role = entry.role === 'jump' ? ' (jump host)' : ''
        return `- ${host}${role}: \`${entry.type}\` \`${entry.fingerprint}\``
      })
      .join('\n')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000)
    timeout.unref?.()
    const external = new Promise((resolve) => {
      runtime.hostKeyResolve = resolve
    })
    runtime.hostKeyWait = { controller, promise: external }
    const question = {
      questions: [
        {
          id: 'trust-host-key',
          header: 'SSH host key',
          question: `Trust the SSH host key for ${pending.host}:${pending.sshPort}?`,
          detail:
            `The server offered host keys that are not in known_hosts:\n\n${fingerprints}\n\n` +
            'Only trust them if you verified the fingerprints with the server administrator. ' +
            '"Trust and start" appends them to `~/.ssh/known_hosts` and continues the connection.',
          options: [
            { label: 'Trust and start', description: 'Append the displayed keys to known_hosts and continue.' },
            { label: 'Cancel', description: 'Leave the runtime stopped; the sidebar keeps the prompt.' },
          ],
          multiSelect: false,
        },
      ],
      agent,
      signal: controller.signal,
    }
    try {
      const answer = await Promise.race([
        this.userQuestions.ask(question).then((value) => ({ answer: value })),
        external.then(() => ({ trustedExternally: true })),
      ])
      if (answer.trustedExternally) return 'trusted'
      const selected = answer.answer?.answers?.find((item) => item.id === 'trust-host-key')?.selected ?? []
      return selected.includes('Trust and start') ? 'trust' : 'cancel'
    } catch (error) {
      if (error?.code !== 'ASK_ABORTED' && error?.code !== 'ASK_CANCELLED') {
        this.#log('warn', `host-key confirmation question failed: ${messageOf(error)}`)
      }
      return 'cancel'
    } finally {
      clearTimeout(timeout)
      try {
        controller.abort()
      } catch {
        // ignore
      }
      runtime.hostKeyWait = undefined
      runtime.hostKeyResolve = undefined
    }
  }

  async #checkHostKey(runtime, action, options = {}) {
    const connection = runtime.connection
    if (connection.kind === 'local' || isLoopbackHost(connection.host)) return true
    if (!options.forceHostKeyCheck && runtime.pendingHostKey) {
      runtime.state = 'needs-trust'
      runtime.stage = 'needs-trust'
      runtime.error = runtime.pendingHostKey.message
      this.finishAction(action, 'blocked', 'host key confirmation required')
      this.emit()
      return false
    }
    const checkedAt = runtime.hostKeyCheckedAt
    if (!options.forceHostKeyCheck && checkedAt && Date.now() - checkedAt < 15 * 60_000) return true
    runtime.stage = 'host-key'
    this.emit()
    // Probe the endpoint SSH actually reaches (HostName/Port/HostKeyAlias from
    // ssh_config), not the raw saved host/default port. The latter reports a
    // fingerprint for a different server when the saved host is an alias.
    const probe = await probeHostKeys(connection, {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      backend: connection.sshBackend,
    }).catch((error) => ({
      ok: false,
      entries: [],
      error: messageOf(error),
    }))
    const endpoint = probe.endpoint
    runtime.sshEndpoint = endpoint
    runtime.hostKeyProbe = {
      ok: Boolean(probe.ok),
      source: probe.source,
      error: probe.error,
      host: connection.host,
      resolvedHost: endpoint?.host,
      port: endpoint?.port ?? (Number(connection.sshPort) || 22),
      knownHostSpecs: endpoint?.knownHostSpecs,
      checkedAt: Date.now(),
      entries: (probe.entries ?? []).map((entry) => ({
        host: entry.hostSpec || hostSpec(entry.host || connection.host, endpoint?.port ?? connection.sshPort),
        role: entry.role,
        resolvedHost: entry.resolvedHost,
        type: entry.type,
        fingerprint: entry.fingerprint,
      })),
    }
    if (!probe.ok || !probe.entries?.length) {
      // Do not block on a probe-only failure: the bridge's own SSH error is
      // the authoritative report and may still identify the cause.
      this.#log('warn', `host-key probe for ${connection.name} failed: ${probe.error ?? 'no key offered'}`)
      return true
    }
    const evaluation = await evaluateHostKeys(probe.entries, connection, {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      endpoint,
    })
    const knownKeys = evaluation.known ?? []
    const unknownKeys = evaluation.unknown ?? []
    const conflictKeys = evaluation.conflicts ?? []
    const pinHostKeyAlgorithms = String(connection.sshBackend ?? '').trim().toLowerCase() !== 'paramiko'
    const classification = classifyHostKeyState({ known: knownKeys, unknown: unknownKeys, conflicts: conflictKeys, entries: probe.entries })
    const { unknownToTrust, blockingConflicts, targetTrusted, jumpTrusted } = classification
    if (classification.pinTypes.length && pinHostKeyAlgorithms) {
      // At least one offered key type is already in known_hosts. The SSH
      // client can only prove this host's identity with a key it trusts, so
      // pin the generated SSH config to exactly those types. Extra or changed
      // key types the server also offers (typically an rsa key that was never
      // added) must not block a connection that OpenSSH can authenticate.
      runtime.hostKeyAlgorithms = hostKeyAlgorithmsForTypes(classification.pinTypes)
    }
    if (!targetTrusted || !jumpTrusted) {
      const changed = blockingConflicts.length > 0
      runtime.pendingHostKey = {
        host: connection.host,
        resolvedHost: endpoint?.host,
        sshPort: endpoint?.port ?? (Number(connection.sshPort) || 22),
        knownHostSpecs: endpoint?.knownHostSpecs,
        source: probe.source,
        checkedAt: Date.now(),
        entries: probe.entries,
        unknown: unknownToTrust,
        conflicts: blockingConflicts,
        message: changed
          ? 'The server offered a host key that differs from known_hosts. Verify it before replacing the old entry.'
          : 'The server host key is not trusted yet. Confirm the fingerprint to add it to known_hosts.',
      }
      runtime.state = 'needs-trust'
      runtime.stage = 'needs-trust'
      runtime.error = runtime.pendingHostKey.message
      const offered = [...unknownToTrust, ...blockingConflicts.map((item) => item.incoming)]
        .filter(Boolean)
        .map((entry) => {
          const host = entry.knownHostSpecs?.[0] || entry.hostSpec || connection.host
          return `${host} ${entry.type} ${entry.fingerprint}`
        })
        .join(', ')
      this.#log('warn', `host key confirmation required for ${connection.name}: ${offered || '(no fingerprint returned)'}`)
      if (changed) {
        const detail = blockingConflicts
          .map((item) => `${item.incoming.knownHostSpecs?.[0] || item.incoming.hostSpec} ${item.incoming.type} ${item.incoming.fingerprint} (known: ${(item.existing ?? []).map((entry) => entry.fingerprint).join(', ')})`)
          .join('; ')
        this.#log('warn', `known_hosts conflict for ${connection.name}: ${detail}`)
      }
      this.emit()
      if (!unknownToTrust.length) {
        // A changed key of a type that is already in known_hosts is never
        // replaced automatically. There is nothing the user can "trust" here,
        // so give an actionable instruction instead of silently cancelling.
        const stale = [...new Set(
          blockingConflicts.flatMap((item) => item.incoming.knownHostSpecs ?? [item.incoming.hostSpec || connection.host]),
        )]
        runtime.error =
          `The server's ${blockingConflicts.map((item) => item.incoming.type).join(', ')} host key changed. ` +
          `Review the fingerprint, remove the stale ${stale.join(', ')} entry from ~/.ssh/known_hosts ` +
          `(for example with \`ssh-keygen -R '${stale[0] ?? connection.host}'\`), then start again.`
        this.finishAction(action, 'blocked', 'the server host key changed; remove the stale known_hosts entry first')
        this.emit()
        return false
      }
      const decision = await this.#promptHostKey(runtime, runtime.pendingHostKey, options)
      if (decision === 'trusted') {
        // Another actor confirmed the offered keys through trust_host while
        // this question was open; pin the types that are now trusted.
        if (pinHostKeyAlgorithms) {
          runtime.hostKeyAlgorithms = hostKeyAlgorithmsForTypes(classification.trustedTargetTypes)
        }
        runtime.pendingHostKey = undefined
        runtime.hostKeyCheckedAt = Date.now()
        runtime.state = 'starting'
        runtime.stage = 'setup'
        runtime.error = undefined
        this.emit()
        return true
      }
      if (decision === 'trust') {
        const unknown = [...runtime.pendingHostKey.unknown]
        const conflicts = [...(runtime.pendingHostKey.conflicts ?? [])]
        for (const entry of unknown) {
          // Reuse the probe's resolved endpoint: every offered key must be
          // written under the names this same endpoint will be checked with.
          const trusted = await this.trustHost(connection.id, entry.fingerprint, { endpoint }).catch((error) => {
            this.#log('warn', `could not trust ${entry.fingerprint}: ${messageOf(error)}`)
            return undefined
          })
          if (!trusted?.trusted) {
            runtime.state = 'needs-trust'
            runtime.stage = 'needs-trust'
            this.finishAction(action, 'blocked', 'host key trust failed')
            this.emit()
            return false
          }
        }
        if (conflicts.length) {
          runtime.pendingHostKey = {
            host: connection.host,
            resolvedHost: endpoint?.host,
            sshPort: endpoint?.port ?? (Number(connection.sshPort) || 22),
            knownHostSpecs: endpoint?.knownHostSpecs,
            source: probe.source,
            checkedAt: Date.now(),
            entries: probe.entries,
            unknown: [],
            conflicts,
            message: 'The server offered host keys that differ from known_hosts. Verify them before replacing the old entries.',
          }
          runtime.state = 'needs-trust'
          runtime.stage = 'needs-trust'
          runtime.error = runtime.pendingHostKey.message
          this.finishAction(action, 'blocked', 'host key conflict requires review')
          this.emit()
          return false
        }
        if (pinHostKeyAlgorithms) {
          runtime.hostKeyAlgorithms = hostKeyAlgorithmsForTypes(classification.trustedTargetTypes)
        }
        runtime.pendingHostKey = undefined
        runtime.hostKeyCheckedAt = Date.now()
        runtime.state = 'starting'
        runtime.stage = 'setup'
        runtime.error = undefined
        this.emit()
        return true
      }
      this.finishAction(action, 'blocked', 'host key confirmation required')
      this.emit()
      return false
    }
    if (knownKeys.length && (unknownKeys.length || conflictKeys.length)) {
      const ignored = [...unknownKeys, ...conflictKeys.map((item) => item.incoming)]
        .filter(Boolean)
        .map((entry) => `${entry.type} ${entry.fingerprint}`)
        .join(', ')
      this.#log(
        'warn',
        `${connection.name}: using already-trusted ${knownKeys.map((entry) => entry.type).join(', ')} host key(s); ` +
          `the server also offered key(s) this host was not trusted for (${ignored}). ` +
          (pinHostKeyAlgorithms
            ? 'SSH is pinned to the trusted types'
            : 'the Paramiko backend checks the negotiated key against known_hosts'),
      )
    }
    runtime.hostKeyCheckedAt = Date.now()
    runtime.pendingHostKey = undefined
    return true
  }

  async #startRuntimeInner(runtime, options) {
    // A restart or a recovery start replaces the tunnel PID, so no long-lived
    // script worker may keep the previous adoption environment.
    await this.stopRuntimeWorkers(runtime.id, 'runtime-start').catch(() => {})
    const action = this.startAction({
      kind: 'runtime.start',
      label: `Starting ${runtime.connection.name}`,
      connectionId: runtime.connectionId,
      runtimeId: runtime.id,
      agentId: options.agentId,
    })
    runtime.actionIds.add(action.id)
    try {
      if (!(await this.#checkHostKey(runtime, action, options))) {
        return this.snapshotRuntime(runtime)
      }
      runtime.stage = 'setup'
      if (!this.setupStatus?.installed) {
        if (this.store.snapshot().autoInstall) {
          this.#log('info', 'virtuoso-bridge is not installed; installing before start')
          const installResult = await this.install({ agentId: options.agentId })
          if (installResult?.needsConfirmation) throw new Error(installResult.message)
          if (!installResult.ok) throw new Error(`automatic installation failed: ${installResult.error}`)
        } else {
          throw new Error(
            'virtuoso-bridge is not installed in the plugin venv yet. Run virtuoso_bridge_setup with action "install", or use the dashboard setup panel.',
          )
        }
      }
      const probe = await this.setup.probeVenv()
      if (!probe.ok) throw new Error(`the plugin venv is unusable: ${probe.reason}`)
      const profile = runtime.profile || this.profileFor(runtime.connection)
      const local = runtime.connection.kind === 'local' || isLoopbackHost(runtime.connection.host)
      runtime.stage = 'shell'
      runtime.envShell = await this.#resolveShell(runtime.connection)
      const effectiveConnection = { ...runtime.connection, envShell: runtime.envShell }
      const secret = await this.readSecret(runtime.connectionId)
      const env = this.buildConnectionEnv(effectiveConnection, profile)
      const sshConfig = await this.#ensureSshConfig(runtime.connection, profile, {
        hostKeyAlgorithms: runtime.hostKeyAlgorithms,
        endpoint: runtime.sshEndpoint,
      })
      runtime.sshConfigPath = sshConfig
      if (sshConfig) env.VB_SSH_CONFIG = sshConfig
      env.VB_RUNTIME_PROFILE = profile
      env.VB_RUNTIME_LOCAL = local ? '1' : '0'
      env.VB_PLUGIN_DATA_DIR = this.dataDir
      env.VB_RUNTIME_TIMEOUT = String(runtime.connection.connectTimeoutSec ?? 120)
      env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
      if (secret?.daemonToken) env.VB_SCRIPT_DAEMON_TOKEN = secret.daemonToken
      if (this.usesPluginTunnel(runtime.connection)) {
        runtime.stage = 'tunnel'
        this.emit()
        const plan = await this.#resolveTunnelRemotePort(runtime, env)
        await this.#startPluginTunnel(runtime, plan.remotePort)
        this.applyTunnelEnv(runtime, env)
        this.#log(
          'info',
          `${runtime.connection.name}: plugin-owned SSH tunnel is up on localhost:${runtime.tunnel.localPort} ` +
            `-> remote 127.0.0.1:${runtime.tunnel.remotePort} (pid ${runtime.tunnel.pid})`,
        )
      }
      runtime.state = 'connecting'
      runtime.stage = 'connect'
      runtime.error = undefined
      this.emit()
      const sidecar = new Sidecar({
        python: this.setup.venvPython,
        pythonArgs: ['-E', '-s'],
        script: path.join(this.pluginDir, 'runtime', 'vb_sidecar.py'),
        args: ['--profile', profile, ...(local ? ['--local'] : [])],
        env,
        cwd: this.dataDir,
        label: `${runtime.connection.name} sidecar`,
        onEvent: (event) => this.#onSidecarEvent(runtime, event),
        onLog: (level, message) => {
          runtime.logTail.push({ time: Date.now(), level, message })
          if (runtime.logTail.length > 200) runtime.logTail.shift()
          this.#log(level === 'debug' ? 'debug' : level, `[${runtime.connection.name}] ${message}`)
          this.emit()
        },
      })
      runtime.sidecar = sidecar
      await sidecar.start({ timeoutMs: 90_000 })
      runtime.pid = sidecar.pid
      this.#log('info', `sidecar for ${runtime.connection.name} ready (pid ${runtime.pid})`)
      const connectResult = await sidecar.request(
        'connect',
        {
          timeoutSec: runtime.connection.connectTimeoutSec ?? 120,
          daemonToken: secret?.daemonToken,
          logToCiw: this.store.snapshot().logToCiw,
          instancePort: runtime.connection.autoSessions
            ? runtime.resolvedInstancePort ?? runtime.connection.instancePort
            : undefined,
        },
        (Number(runtime.connection.connectTimeoutSec ?? 120) + 90) * 1000,
      )
      if (runtime.tunnel && runtime.connection.autoSessions) {
        const selectedPort = Number(
          connectResult?.instances?.selected?.port ?? connectResult?.client?.instanceRecord?.port ?? 0,
        )
        if (selectedPort && selectedPort !== runtime.tunnel.remotePort) {
          throw new Error(
            `the SSH tunnel forwards to daemon port ${runtime.tunnel.remotePort}, but the sidecar selected ` +
              `instance ${selectedPort}; restart the runtime after selecting the instance again`,
          )
        }
      }
      runtime.status = connectResult
      runtime.instance = connectResult?.instances?.selected ?? connectResult?.client?.instanceRecord ?? null
      runtime.daemonCompatibility = connectResult?.instances?.compatibility ?? null
      runtime.daemonProbe = connectResult?.daemonProbe ?? null
      runtime.attach = connectResult?.attach ?? null
      runtime.scratchRoot = connectResult?.scratchRoot || ''
      runtime.scratchConfigured = connectResult?.scratchConfigured || ''
      if (runtime.attach?.attached) {
        this.#log(
          'info',
          `${runtime.connection.name} reused an already running bridge daemon` +
            (runtime.attach.setupPath ? ` (${runtime.attach.setupPath})` : '') +
            '; no new setup was loaded',
        )
      }
      if (connectResult?.pid) runtime.pid = connectResult.pid
      const daemon = connectResult?.daemon ?? {}
      const responsive = Boolean(daemon.daemon_responsive)
      runtime.state = responsive ? 'running' : 'waiting'
      runtime.health = {
        ok: responsive,
        checkedAt: Date.now(),
        summary: daemon.summary,
        tcpReachable: daemon.tcp_reachable,
        daemonResponsive: daemon.daemon_responsive,
        tunnelAlive: runtime.tunnel ? runtime.tunnel.alive : daemon.tunnel_process_alive,
      }
      runtime.lastHealthAt = Date.now()
      if (responsive) {
        runtime.wasReady = true
        runtime.dialog = undefined
        runtime.setupHint = undefined
        runtime.daemonProbe = null
        runtime.tunnelRestarts = 0
        await this.inspectRuntimeWorkDir(runtime)
      } else {
        runtime.setupHint = !runtime.wasReady && connectResult?.state?.setup_path
          ? `load("${connectResult.state.setup_path}")`
          : undefined
        // Nothing answers the bridge yet; an X11 dialog probe would only add
        // noise and cannot distinguish a dialog from a not-yet-loaded CIW.
        if (runtime.daemonProbe?.state !== 'no-listener') await this.inspectRuntimeDialogs(runtime)
      }
      runtime.lastUsedAt = Date.now()
      runtime.stage = 'ready'
      if (responsive) {
        this.#log('info', `${runtime.connection.name} is ready`)
      } else {
        const dialogTitle = runtime.dialog?.dialogs?.[0]?.title
        this.#log(
          'warn',
          `${runtime.connection.name} tunnel is up but the Virtuoso daemon did not answer. ` +
            (dialogTitle
              ? `A CIW dialog is blocking it: ${dialogTitle}.`
              : runtime.setupHint
                ? `Run ${runtime.setupHint} in the CIW.`
                : 'Check the CIW for a modal dialog or a busy operation.'),
        )
      }
      this.finishAction(action, 'succeeded', responsive ? undefined : 'waiting for the CIW daemon')
      this.emit()
      return this.snapshotRuntime(runtime)
    } catch (error) {
      runtime.error = messageOf(error)
      runtime.errorDetail = {
        stage: runtime.stage ?? 'start',
        message: runtime.error,
        traceback: error?.traceback,
        code: error?.code,
        host: runtime.connection.host,
        sshPort: Number(runtime.connection.sshPort) || 22,
        sshBackend: runtime.connection.sshBackend,
        probe: runtime.hostKeyProbe,
        tunnel: runtime.tunnel?.snapshot() ?? runtime.tunnelDropped ?? undefined,
        tunnelStderrTail: error?.stderrTail,
        at: Date.now(),
      }
      this.#log('error', `start of ${runtime.connection.name} failed (${runtime.errorDetail.stage}): ${runtime.error}`)
      if (runtime.tunnel && !runtime.sidecar) {
        // The forward was opened but nothing adopted it: never leave a hidden
        // ssh process behind a failed start.
        await this.#stopPluginTunnel(runtime)
      }
      if (/host key verification failed|authenticity of host|remote host identification has changed|no matching host key/i.test(runtime.error)) {
        const resolved = await this.#checkHostKey(runtime, action, { forceHostKeyCheck: true }).catch(() => false)
        if (!resolved && runtime.pendingHostKey) {
          if (runtime.sidecar) {
            await runtime.sidecar.stop({ stopTunnel: true, timeoutMs: 4_000 }).catch(() => {})
            runtime.sidecar = undefined
          }
          runtime.errorDetail.hint = 'Confirm the host-key fingerprint and trust it, then start again.'
          this.emit()
          return this.snapshotRuntime(runtime)
        }
      }
      if (runtime.sidecar) {
        try {
          const status = await runtime.sidecar.request('status', {}, 10_000)
          runtime.status = status
          runtime.instance = status.instances?.selected ?? runtime.instance
          runtime.daemonCompatibility = status.instances?.compatibility ?? runtime.daemonCompatibility
          runtime.daemonProbe = status.daemonProbe ?? runtime.daemonProbe
          const setupPath = status.state?.setup_path ?? status.instances?.setupPath
          if (setupPath) runtime.setupHint = `load("${setupPath}")`
        } catch {
          // The original connection error remains authoritative.
        }
      }
      runtime.state = 'error'
      const daemonFailure = classifyDaemonFailure(runtime.error, runtime.daemonProbe)
      const loadHint = runtime.setupHint
      if (daemonFailure === 'version-mismatch') {
        runtime.daemon = {
          state: 'version-mismatch',
          checked: true,
          responsive: false,
          summary: 'the remote daemon is an older build and does not speak this client capability handshake',
          checkedAt: Date.now(),
        }
        runtime.errorDetail.hint =
          'The remote daemon is older than this client. Deploy the current setup with virtuoso_bridge_runtime action "deploy_daemon", ' +
          'then load its printed line in the intended idle CIW' +
          (loadHint ? ` and start again: ${loadHint}` : '.') +
          ' A plain restart or reconnect does not deploy files or reload the setup.'
      } else if (daemonFailure === 'auth-failed') {
        runtime.daemon = {
          state: 'auth-failed',
          checked: true,
          responsive: false,
          summary: 'the remote daemon did not authenticate this client',
          checkedAt: Date.now(),
        }
        runtime.errorDetail.hint =
          'The daemon behind the port is a bridge daemon but does not accept this client token. ' +
          'It may belong to another account or its bridge token was rotated. Deploy the current setup and load it in the intended idle CIW' +
          (loadHint ? `: ${loadHint}` : '.')
      } else if (daemonFailure === 'unreachable') {
        runtime.daemon = {
          state: 'no-response',
          checked: true,
          responsive: false,
          summary: 'no bridge daemon answered behind the SSH tunnel',
          checkedAt: Date.now(),
        }
        runtime.errorDetail.hint =
          'SSH login succeeded but nothing answers the bridge on the configured daemon port. ' +
          'The CIW has not loaded the prepared setup (an old bundle listening on another port is not used automatically). ' +
          'Deploy the current setup with virtuoso_bridge_runtime action "deploy_daemon", then load its printed line in the intended idle CIW' +
          (loadHint ? ` and start again: ${loadHint}` : '.')
      }
      this.finishAction(action, 'failed', runtime.error)
      if (runtime.sidecar) {
        await runtime.sidecar.stop({ stopTunnel: true, timeoutMs: 4_000 }).catch(() => {})
        runtime.sidecar = undefined
      }
      this.emit()
      const wrapped = error instanceof Error ? error : new Error(runtime.error)
      wrapped.details = runtime.errorDetail
      throw wrapped
    } finally {
      runtime.actionIds.delete(action.id)
      runtime.startPromise = undefined
    }
  }

  async stopRuntime(ref, options = {}) {
    const runtime = this.runtimeRef(ref)
    if (!runtime) return { stopped: false, reason: 'no such runtime' }
    if (runtime.state === 'stopping') return this.snapshotRuntime(runtime)
    const action = this.startAction({
      kind: 'runtime.stop',
      label: `Stopping ${runtime.connection.name}`,
      connectionId: runtime.connectionId,
      runtimeId: runtime.id,
      agentId: options.agentId,
    })
    runtime.actionIds.add(action.id)
    runtime.state = 'stopping'
    this.emit()
    try {
      await this.stopRuntimeWorkers(runtime.id, 'runtime-stop')
      if (runtime.sidecar) {
        // The Python-side shim detaches the adopted forward before upstream's
        // stop() runs, so upstream clears its state/selection without signalling
        // the Host-owned PID. The Host then kills its own child below.
        await runtime.sidecar.stop({
          stopTunnel: options.stopTunnel !== false,
          timeoutMs: 8_000,
        })
      } else if (!runtime.tunnel && options.stopTunnel !== false) {
        await this.stopOrphan(runtime.connectionId, { silent: true }).catch(() => {})
      }
      if (runtime.tunnel) await this.#stopPluginTunnel(runtime)
      runtime.sidecar = undefined
      runtime.pid = undefined
      runtime.state = 'stopped'
      runtime.health = undefined
      runtime.status = undefined
      runtime.setupHint = undefined
      runtime.dialog = undefined
      runtime.projectWorkDir = undefined
      runtime.wasReady = false
      runtime.attach = undefined
      runtime.scratchRoot = ''
      runtime.scratchConfigured = ''
      runtime.tunnelDropped = undefined
      runtime.resolvedInstancePort = undefined
      runtime.instanceRecord = undefined
      if (!options.keepTunnelRestarts) runtime.tunnelRestarts = 0
      runtime.lastUsedAt = Date.now()
      this.#log('info', `${runtime.connection.name} stopped`)
      this.finishAction(action, 'succeeded')
      this.orphans = await this.scanOrphans().catch(() => [])
      this.emit()
      return this.snapshotRuntime(runtime)
    } catch (error) {
      runtime.state = 'error'
      runtime.error = messageOf(error)
      this.finishAction(action, 'failed', runtime.error)
      this.emit()
      throw error
    } finally {
      runtime.actionIds.delete(action.id)
    }
  }

  /**
   * The empty runtime env file that keeps the upstream client from loading the
   * user's other `~/.virtuoso-bridge/.env`.
   *
   * Upstream `load_vb_env(override=True)` walks upward from the helper's cwd and
   * falls back to `~/.virtuoso-bridge/.env`, so a second installation's saved
   * host/scratch values would replace the ones this plugin passes. Pointing the
   * upstream loader at an empty file makes that load a no-op.
   */
  async emptyRuntimeEnvFile() {
    const file = path.join(this.dataDir, 'empty.env')
    await fsp.mkdir(this.dataDir, { recursive: true })
    await fsp.writeFile(file, '# intentionally empty: the DSH plugin owns VB_* values\n', 'utf8')
    return file
  }

  buildConnectionEnv(connection, profile) {
    const env = envForProfile(connection, profile)
    const settings = this.store.snapshot()
    const scratchRoot = connection.remoteScratchRoot || settings.defaultRemoteScratchRoot || ''
    if (scratchRoot) {
      // Upstream reads the unsuffixed variable for remote scratch paths; keep
      // the profile-scoped copy as well for profile-aware helpers.
      env.VB_REMOTE_SCRATCH_ROOT = scratchRoot
      env[`VB_REMOTE_SCRATCH_ROOT_${profile}`] = scratchRoot
    } else {
      delete env.VB_REMOTE_SCRATCH_ROOT
      delete env[`VB_REMOTE_SCRATCH_ROOT_${profile}`]
    }
    if (settings.logToCiw) env.VB_LOG_TO_CIW = '1'
    return env
  }

  /**
   * Whether the Host plugin owns this runtime's SSH tunnel.
   *
   * Fixed-port remote connections have a known daemon port before the sidecar
   * starts. Automatic-session connections need one read-only instance discovery
   * first (the same SSH path `virtuoso_bridge_runtime` `instances` uses), after
   * which the Host also opens the forward itself.
   */
  usesPluginTunnel(connection) {
    if (!connection || connection.kind === 'local' || isLoopbackHost(connection.host)) return false
    if (connection.autoSessions) return true
    const remotePort = Number(connection.port)
    return Number.isInteger(remotePort) && remotePort > 0 && remotePort <= 65535
  }

  /**
   * Pick the daemon port an automatic-session tunnel must forward to.
   *
   * Mirrors upstream's selection rule: an explicit `instancePort` wins, then the
   * saved selection, then a single discovered instance. Anything ambiguous is
   * refused with the available list instead of silently forwarding to a
   * different CIW.
   */
  chooseTunnelRemotePort(connection, discovered) {
    const rows = discovered?.instances ?? []
    const explicit = Number(connection?.instancePort) || 0
    const saved = Number(discovered?.selected?.port) || 0
    const wanted = explicit || saved || (rows.length === 1 ? Number(rows[0].port) || 0 : 0)
    if (!wanted) {
      const list = rows.map((row) => `${row.port} (pid ${row.pid}, ${row.work_dir})`).join('; ') || 'none'
      throw new Error(
        `automatic-session discovery found ${rows.length} bridge instance(s): ${list}. ` +
          'Select one with virtuoso_bridge_runtime action "select_instance" before starting the runtime.',
      )
    }
    const row = rows.find((item) => Number(item.port) === wanted)
    if (!row) {
      const list = rows.map((item) => item.port).join(', ') || 'none'
      throw new Error(`the selected automatic-session instance port ${wanted} is no longer available (found: ${list})`)
    }
    return { remotePort: wanted, record: row }
  }

  async #resolveTunnelRemotePort(runtime, env) {
    const connection = runtime.connection
    if (!connection.autoSessions) {
      const remotePort = Number(connection.port)
      if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
        throw new Error('this connection has no daemon port to forward to')
      }
      return { remotePort }
    }
    const profile = runtime.profile || this.profileFor(connection)
    const discovered = await this.#discoverInstances(connection, profile, env, {
      timeoutSec: Math.min(90, Math.max(10, Number(connection.connectTimeoutSec) || 20)),
    })
    const choice = this.chooseTunnelRemotePort(connection, discovered)
    runtime.resolvedInstancePort = choice.remotePort
    runtime.instanceRecord = choice.record
    if (discovered.setupPath) runtime.setupHint = `load("${discovered.setupPath}")`
    this.#log(
      'info',
      `${connection.name}: automatic-session discovery selected instance ${choice.remotePort} ` +
        `(pid ${choice.record.pid}, ${choice.record.work_dir})`,
    )
    return choice
  }

  pluginTunnelRecordPath(connectionId) {
    const safe = String(connectionId || 'connection').replace(/[^A-Za-z0-9_.-]+/g, '_')
    return path.join(this.dataDir, 'tunnels', `${safe}.json`)
  }

  async #persistTunnelRecord(runtime) {
    const tunnel = runtime.tunnel
    if (!tunnel) return
    try {
      await writeJson(this.pluginTunnelRecordPath(runtime.connectionId), {
        owner: 'plugin',
        connectionId: runtime.connectionId,
        connectionName: runtime.connection.name,
        profile: runtime.profile,
        pid: tunnel.pid,
        localPort: tunnel.localPort,
        remotePort: tunnel.remotePort,
        host: runtime.connection.daemonHost || runtime.connection.host,
        startedAt: tunnel.startedAt ?? Date.now(),
      })
    } catch (error) {
      this.#log('warn', `could not persist the tunnel record for ${runtime.connection.name}: ${messageOf(error)}`)
    }
  }

  async #clearTunnelRecord(connectionId) {
    await fsp.rm(this.pluginTunnelRecordPath(connectionId), { force: true }).catch(() => {})
  }

  /**
   * Put the Host-owned forward into a helper's environment.
   *
   * The Python sidecar and every script helper call `isolate_runtime_env()`
   * before constructing an `SSHClient`, which installs the adoption shim and
   * reads these variables. The profile-scoped local/remote ports are also
   * upstream's own variables, so a helper that predates the shim still lands on
   * the plugin's forward instead of a second `ssh.exe`.
   */
  applyTunnelEnv(runtime, env) {
    const tunnel = runtime?.tunnel
    if (!tunnel) return env
    const profile = runtime.profile || this.profileFor(runtime.connection)
    const suffix = `_${profile}`
    if (tunnel.localPort) env[`VB_LOCAL_PORT${suffix}`] = String(tunnel.localPort)
    if (tunnel.remotePort) env[`VB_REMOTE_PORT${suffix}`] = String(tunnel.remotePort)
    env.VB_PLUGIN_TUNNEL_OWNER = 'plugin'
    if (tunnel.pid) env.VB_PLUGIN_TUNNEL_PID = String(tunnel.pid)
    if (tunnel.localPort) env.VB_PLUGIN_TUNNEL_LOCAL_PORT = String(tunnel.localPort)
    if (tunnel.remotePort) env.VB_PLUGIN_TUNNEL_REMOTE_PORT = String(tunnel.remotePort)
    return env
  }

  async #allocateTunnelPort(connection) {
    const configured = Number(connection.localPort) || 0
    if (configured >= 1 && configured <= 65535) {
      for (let offset = 0; offset < 10 && configured + offset <= 65535; offset += 1) {
        const candidate = configured + offset
        if (await tunnelPortUsable(candidate)) return candidate
      }
      this.#log('warn', `configured local tunnel port ${configured} is not free; using an OS-assigned port`)
    }
    return pickLocalPort()
  }

  /**
   * Launch one Host-owned forward and wait for OpenSSH to report the session.
   *
   * `ssh -N -L` is spawned from the Host and not detached. On Windows a
   * non-detached `windowsHide` child keeps a hidden console, which its implicit
   * `ProxyJump`/`ProxyCommand` child inherits — detaching was exactly what made
   * that grandchild pop a console window. Used both for runtime ownership and
   * for the short-lived Test probe tunnel.
   */
  async launchTunnel(connection, remotePort, options = {}) {
    const sshExecutable = await findExecutable('ssh')
    if (!sshExecutable) {
      throw new Error('OpenSSH ssh was not found on PATH; the plugin cannot open its SSH tunnel')
    }
    const sshConfigPath = options.sshConfigPath
    if (sshConfigPath && !fileExistsSync(sshConfigPath)) {
      // The generated config carries the host-key algorithm pin and the
      // identity/port mapping. A tunnel without it could silently bypass both.
      throw new Error(`the generated SSH config ${sshConfigPath} is missing; refusing to start an unpinned tunnel`)
    }
    const timeoutMs = options.timeoutMs ?? Math.max(60_000, (Number(connection.connectTimeoutSec) || 120) * 1000)
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // `tunnelPortUsable` is a bind test, but a race can still lose the port to
      // another process; retry on OpenSSH's bind failure instead of failing the
      // whole start. Both loopback families are bound by `ssh -L`.
      const localPort = attempt === 0 ? await this.#allocateTunnelPort(connection) : await pickLocalPort()
      const built = buildTunnelArgs({
        sshExecutable,
        connection: { ...connection, daemonHost: connection.daemonHost || connection.host },
        sshConfigPath,
        localPort,
        remotePort,
        connectTimeoutSec: connection.connectTimeoutSec,
      })
      const tunnel = new SshTunnel({
        command: built.command,
        args: built.args,
        // The ssh client gets the plugin-owned environment (no ambient VB_*),
        // which keeps the selected connection authoritative.
        env: bridgeChildEnv(),
        cwd: this.dataDir,
        label: options.label ?? `${connection.name} tunnel`,
        log: (level, message) => this.#log(level === 'debug' ? 'debug' : level, message),
      })
      if (options.onExit) tunnel.once('exit', options.onExit)
      try {
        await tunnel.start({ timeoutMs, localPort, remotePort })
      } catch (error) {
        lastError = error
        const detail = `${error?.message ?? ''}\n${error?.stderrTail ?? ''}`
        if (attempt < 2 && /address already in use|cannot listen|bind:/i.test(detail)) {
          this.#log('warn', `${connection.name}: local tunnel port ${localPort} was taken; retrying on another port`)
          continue
        }
        break
      }
      return tunnel
    }
    const tail = lastError?.stderrTail ? `\n${lastError.stderrTail}` : ''
    const wrapped = new Error(`the SSH tunnel could not be opened: ${lastError?.message ?? 'unknown error'}${tail}`)
    wrapped.code = lastError?.code ?? 'TUNNEL_FAILED'
    wrapped.stderrTail = lastError?.stderrTail
    throw wrapped
  }

  async #startPluginTunnel(runtime, remotePort) {
    const connection = runtime.connection
    const tunnel = await this.launchTunnel(connection, remotePort, {
      sshConfigPath: runtime.sshConfigPath,
      label: `${connection.name} tunnel`,
      onExit: (snapshot) => this.#onTunnelExit(runtime, snapshot),
    })
    runtime.tunnel = tunnel
    await this.#persistTunnelRecord(runtime)
    return tunnel
  }

  /**
   * The Host's forward exited on its own. Its child events are the status
   * source, so this reacts immediately instead of waiting for a port probe.
   */
  #onTunnelExit(runtime, snapshot) {
    if (this.disposed) return
    runtime.tunnel = undefined
    runtime.tunnelDropped = snapshot
    void this.#clearTunnelRecord(runtime.connectionId)
    const message = snapshot?.lastError || 'the SSH tunnel exited'
    const wasActive = ['running', 'waiting', 'connecting', 'error'].includes(runtime.state)
    this.#log('warn', `${runtime.connection.name}: ${message}`)
    runtime.error = message
    runtime.errorDetail = { stage: 'tunnel', message, tunnel: snapshot, at: Date.now() }
    runtime.health = {
      ok: false,
      checkedAt: Date.now(),
      summary: message,
      tcpReachable: false,
      daemonResponsive: false,
      tunnelAlive: false,
    }
    if (['running', 'waiting', 'connecting'].includes(runtime.state)) runtime.state = 'error'
    this.emit()
    if (!wasActive || !runtime.sidecar) return
    const attempts = Number(runtime.tunnelRestarts || 0)
    if (attempts >= 2) {
      this.#log('error', `${runtime.connection.name}: the SSH tunnel dropped twice; leaving the runtime stopped`)
      return
    }
    runtime.tunnelRestarts = attempts + 1
    const waitMs = 1_000 * runtime.tunnelRestarts
    this.#log('info', `${runtime.connection.name}: restarting after the tunnel dropped (attempt ${runtime.tunnelRestarts})`)
    delay(waitMs)
      .then(() => {
        if (this.disposed) return
        const current = this.runtimes.get(runtime.id)
        if (!current || current.tunnel || ['starting', 'connecting', 'stopping'].includes(current.state)) return
        this.startRuntime(current.id, { restart: true, waitMs: 0, auto: true }).catch((error) => {
          this.#log('warn', `automatic restart of ${runtime.connection.name} failed: ${messageOf(error)}`)
        })
      })
      .catch(() => {})
  }

  async #stopPluginTunnel(runtime) {
    const tunnel = runtime?.tunnel
    runtime.tunnel = undefined
    runtime.tunnelDropped = undefined
    await this.#clearTunnelRecord(runtime.connectionId)
    if (tunnel) await tunnel.stop({ timeoutMs: 5_000 }).catch(() => {})
  }

  async #ensureSshConfig(connection, profile, options = {}) {
    const configDir = path.join(this.dataDir, 'ssh')
    const hostKeyAlgorithms = [...new Set((options.hostKeyAlgorithms ?? []).filter(Boolean))]
    const backend = String(connection.sshBackend ?? '').trim().toLowerCase()
    const pinAlgorithms = backend === 'paramiko' ? [] : hostKeyAlgorithms
    const sshPort = Number(options.endpoint?.port) || Number(connection.sshPort) || 22
    // A generated config is needed for an explicit identity, a non-default SSH
    // port, or to pin HostKeyAlgorithms to the host key types already trusted.
    // The Paramiko backend resolves the file with `ssh -G` and uses its own
    // known_hosts RejectPolicy; it rejects the canonical
    // `StrictHostKeyChecking=true` that OpenSSH prints for `yes`, so it keeps
    // the plain config and no pin is written for it.
    if (!connection.identityFile && sshPort === 22 && !pinAlgorithms.length) return undefined
    const userConfig = path.join(os.homedir(), '.ssh', 'config')
    const include = fileExistsSync(userConfig) ? `Include "${userConfig.replace(/\\/g, '/')}"\n` : ''
    const hosts = [
      connection.host,
      connection.daemonHost,
      connection.deployHost,
      connection.guiHost,
      connection.spectreHost,
    ].filter((value, index, all) => value && all.indexOf(value) === index)
    // The file name carries a hash of everything it renders. A changed pin set,
    // port, identity or host therefore gets a new file, and a running runtime
    // keeps using the exact file its tunnel and sidecar were started with. The
    // previous shared names were deleted on some calls, which broke later SSH
    // commands of an already-running runtime (writes failed while a manual ssh
    // into the same directory succeeded).
    const signature = JSON.stringify({ backend, sshPort, hostKeyAlgorithms: pinAlgorithms, hosts, include, connection: {
      host: connection.host,
      user: connection.user,
      identityFile: connection.identityFile,
    } })
    const digest = createHash('sha256').update(signature).digest('hex').slice(0, 10)
    const configPath = path.join(configDir, `config-${profile || this.profileFor(connection)}-${digest}`)
    const config = buildSshConfig({ connection, hosts, sshPort, include, hostKeyAlgorithms: pinAlgorithms })
    await ensureDir(configDir)
    await fsp.writeFile(configPath, config.text, 'utf8')
    return configPath
  }

  async #onSidecarEvent(runtime, event) {
    if (event.event === 'log') {
      this.#log(event.level ?? 'info', `[${runtime.connection.name}] ${event.message ?? ''}`)
    } else if (event.event === 'ready') {
      this.#log('info', `sidecar ready for ${runtime.connection.name}`)
    }
    this.emit()
  }

  snapshotRuntime(runtime) {
    const health = runtime.health
    const daemon = health
      ? {
          state: health.daemonResponsive ? 'ready' : health.tcpReachable ? 'no-response' : 'unreachable',
          responsive: Boolean(health.daemonResponsive),
          tcpReachable: Boolean(health.tcpReachable),
          tunnelAlive: health.tunnelAlive,
          checkedAt: health.checkedAt,
          summary: health.summary,
        }
      : runtime.daemon
        ? runtime.daemon
        : runtime.status?.daemon
          ? { state: 'unknown', summary: runtime.status.daemon.summary, checkedAt: runtime.lastHealthAt }
          : undefined
    const connectionStatus =
      runtime.pendingHostKey
        ? 'needs-confirmation'
        : runtime.tunnelDropped && ['error', 'waiting', 'running'].includes(runtime.state)
          ? 'tunnel-down'
          : runtime.state === 'running'
            ? daemon?.state === 'ready'
              ? 'ok'
              : 'daemon'
          : runtime.state === 'waiting'
            ? 'daemon-waiting'
            : runtime.state === 'starting' || runtime.state === 'connecting'
              ? 'connecting'
              : runtime.state === 'stopped'
                ? 'stopped'
                : runtime.state === 'needs-trust'
                  ? 'needs-confirmation'
                  : 'error'
    return {
      id: runtime.id,
      connectionId: runtime.connectionId,
      name: runtime.connection.name,
      kind: runtime.connection.kind,
      host: runtime.connection.host,
      user: runtime.connection.user,
      port: runtime.connection.port,
      autoSessions: Boolean(runtime.connection.autoSessions),
      instancePort: runtime.connection.instancePort,
      instance: runtime.instance ?? runtime.status?.instances?.selected ?? null,
      remoteWorkDir: runtime.projectWorkDir || runtime.connection.remoteWorkDir || runtime.status?.state?.remote_work_dir || '',
      daemonCompatibility: runtime.daemonCompatibility ?? runtime.status?.instances?.compatibility ?? null,
      daemonProbe: runtime.daemonProbe ?? runtime.status?.daemonProbe ?? null,
      sshPort: runtime.connection.sshPort,
      sshBackend: runtime.connection.sshBackend,
      envShell: runtime.envShell || runtime.connection.envShell,
      profile: runtime.profile || this.profileFor(runtime.connection),
      subInstanceId: runtime.subInstanceId,
      subInstanceName: runtime.subInstanceName,
      state: RUNTIME_STATES.has(runtime.state) ? runtime.state : 'error',
      connectionStatus,
      stage: runtime.stage,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      lastUsedAt: runtime.lastUsedAt,
      lastHealthAt: runtime.lastHealthAt,
      health,
      daemon,
      tunnel: runtime.tunnel ? runtime.tunnel.snapshot() : runtime.tunnelDropped ?? undefined,
      error: runtime.error,
      errorDetail: runtime.errorDetail,
      pendingHostKey: runtime.pendingHostKey,
      hostKeyProbe: runtime.hostKeyProbe,
      setupHint: runtime.setupHint,
      attach: runtime.attach,
      scratchRoot: runtime.scratchRoot,
      scratchConfigured: runtime.scratchConfigured,
      dialog: runtime.dialog,
      wasReady: Boolean(runtime.wasReady),
      package: runtime.status?.package,
      actions: [...runtime.actionIds].map((actionId) => this.actions.get(actionId)).filter(Boolean).map((action) => action.id),
      agents: [...runtime.agentUsage.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt),
      workers: this.#snapshotWorkers(runtime.id),
      workerLimit: this.workerLimit(),
      logTail: runtime.logTail.slice(-20),
    }
  }

  async inspectRuntimeWorkDir(runtime) {
    if (!runtime?.sidecar || runtime.sidecar.closed) return undefined
    try {
      const result = await runtime.sidecar.request('working_dir', {}, 15_000)
      if (result?.ok && result.workDir) runtime.projectWorkDir = result.workDir
    } catch (error) {
      this.#log('debug', `working directory probe failed for ${runtime.connection.name}: ${messageOf(error)}`)
    }
    return runtime.projectWorkDir
  }

  async refreshDialogEvidence() {
    for (const runtime of this.runtimes.values()) {
      if (!['running', 'waiting', 'error'].includes(runtime.state)) continue
      if (runtime.health?.daemonResponsive) continue
      if (runtime.daemonProbe?.state === 'no-listener') continue
      await this.inspectRuntimeDialogs(runtime)
    }
    this.emit()
  }

  async inspectRuntimeDialogs(runtime) {    if (!runtime?.sidecar || runtime.sidecar.closed) return undefined
    try {
      const report = await runtime.sidecar.request('dialogs', {}, 25_000)
      const dialogs = Array.isArray(report?.dialogs)
        ? report.dialogs.map((item) => ({
            title: item.title || '',
            window_id: item.dismiss_id || item.window_id || '',
            modal: Boolean(item.modal),
            ownership: item.ownership || item.source || '',
            class: item.class,
          }))
        : []
      runtime.dialog = {
        ok: Boolean(report?.ok),
        status: report?.status || (report?.ok ? 'clear' : 'indeterminate'),
        target: report?.target,
        dialogs,
        error: report?.error,
        checkedAt: Date.now(),
      }
    } catch (error) {
      runtime.dialog = {
        ok: false,
        status: 'indeterminate',
        error: messageOf(error),
        checkedAt: Date.now(),
      }
    }
    return runtime.dialog
  }

  async healthLoop() {
    if (this.disposed) return
    for (const runtime of this.runtimes.values()) {
      if (!['running', 'waiting', 'error'].includes(runtime.state)) continue
      if (!runtime.sidecar || runtime.sidecar.closed) {
        if (runtime.state !== 'error') {
          runtime.state = 'error'
          runtime.error = 'sidecar process is not running'
          this.#log('error', `${runtime.connection.name}: sidecar disappeared`)
          this.emit()
        }
        continue
      }
      if (runtime.tunnel && !runtime.tunnel.alive) {
        // A missed child event must still be caught here; this reads the child's
        // own state, never the forwarding port.
        this.#onTunnelExit(runtime, runtime.tunnel.snapshot())
        continue
      }
      try {
        const status = await runtime.sidecar.request('status', {}, 20_000)
        runtime.status = status
        if (status?.pid) runtime.pid = status.pid
        runtime.instance = status.instances?.selected ?? status.client?.instanceRecord ?? runtime.instance
        runtime.daemonCompatibility = status.instances?.compatibility ?? runtime.daemonCompatibility
        if (runtime.daemonProbe?.state !== 'ready') runtime.daemonProbe = status.daemonProbe ?? runtime.daemonProbe
        runtime.autoSessions = status.instances?.autoSessions ?? runtime.connection.autoSessions
        runtime.instancePort = runtime.connection.instancePort
        const daemon = status.daemon ?? {}
        const responsive = Boolean(daemon.daemon_responsive)
        runtime.lastHealthAt = Date.now()
        runtime.health = {
          ok: responsive,
          checkedAt: Date.now(),
          summary: daemon.summary,
          tcpReachable: daemon.tcp_reachable,
          daemonResponsive: daemon.daemon_responsive,
          // The Host owns the forward, so its child state is authoritative; the
          // sidecar's field is only used for upstream-managed (auto-session) tunnels.
          tunnelAlive: runtime.tunnel ? runtime.tunnel.alive : daemon.tunnel_process_alive,
          pluginTunnel: status.pluginTunnel ?? undefined,
        }
        if (!responsive && status.state?.setup_path && !runtime.wasReady) {
          runtime.setupHint = `load("${status.state.setup_path}")`
        } else if (responsive || runtime.wasReady) {
          runtime.setupHint = undefined
        }
        if (!responsive) {
          if (runtime.daemonProbe?.state !== 'no-listener') await this.inspectRuntimeDialogs(runtime)
        } else {
          const wasReadyBefore = runtime.wasReady
          runtime.dialog = undefined
          runtime.daemonProbe = null
          runtime.wasReady = true
          if (!wasReadyBefore || !runtime.projectWorkDir) await this.inspectRuntimeWorkDir(runtime)
        }
        if (responsive && runtime.state === 'waiting') {
          runtime.state = 'running'
          runtime.error = undefined
          this.#log('info', `${runtime.connection.name} daemon is now answering`)
        } else if (!responsive && runtime.state === 'running') {
          runtime.state = 'waiting'
          this.#log('warn', `${runtime.connection.name} daemon stopped answering; waiting for the CIW`)
        }
        this.emit()
      } catch (error) {
        this.#log('warn', `health check failed for ${runtime.connection.name}: ${messageOf(error)}`)
        if (runtime.sidecar?.closed) {
          runtime.state = 'error'
          runtime.error = `sidecar exited: ${runtime.sidecar.tailStderr(2000)}`
          this.emit()
        } else {
          await this.inspectRuntimeDialogs(runtime)
          runtime.health = {
            ok: false,
            checkedAt: Date.now(),
            summary: `health check failed: ${messageOf(error)}`,
            tcpReachable: runtime.health?.tcpReachable,
            daemonResponsive: false,
            tunnelAlive: runtime.health?.tunnelAlive,
          }
          if (runtime.state === 'running') runtime.state = 'waiting'
          this.emit()
        }
      }
    }
    if (this.orphans.some((item) => item.state === 'running')) {
      this.orphans = await this.scanOrphans().catch(() => this.orphans)
    }
  }

  // -- agent tools: API calls --------------------------------------------

  async callApi(options) {
    const runtime = this.#requireRuntime(options.runtime, options.connection)
    if (!runtime.sidecar || runtime.sidecar.closed) throw new Error(`runtime ${runtime.id} is not running`)
    const target = String(options.target ?? 'client')
    const method = options.method ? String(options.method) : undefined
    if (!method) throw new Error('method is required')
    this.attachAgent(options.agentId, runtime, `${target}.${method}`)
    const action = this.startAction({
      kind: 'api.call',
      label: `${target}.${method}()`,
      runtimeId: runtime.id,
      connectionId: runtime.connectionId,
      agentId: options.agentId,
    })
    runtime.actionIds.add(action.id)
    const timeoutSec = clamp(Number(options.timeoutSec ?? 600), 1, 86_400)
    try {
      const result = await runtime.sidecar.request(
        'call',
        {
          target,
          method,
          args: options.args ?? [],
          kwargs: options.kwargs ?? {},
          timeoutSec,
        },
        Math.max(60_000, (timeoutSec + 30) * 1000),
      )
      runtime.lastUsedAt = Date.now()
      this.finishAction(action, 'succeeded')
      this.emit()
      return { runtime: runtime.id, ...result }
    } catch (error) {
      this.finishAction(action, 'failed', messageOf(error))
      this.emit()
      throw error
    } finally {
      runtime.actionIds.delete(action.id)
    }
  }

  async describeApi(options) {
    const runtime = this.#requireRuntime(options.runtime, options.connection)
    if (!runtime.sidecar || runtime.sidecar.closed) throw new Error(`runtime ${runtime.id} is not running`)
    const action = this.startAction({
      kind: 'api.describe',
      label: options.target ? `describe ${options.target}` : 'describe the bridge API',
      runtimeId: runtime.id,
      connectionId: runtime.connectionId,
      agentId: options.agentId,
    })
    try {
      const result = await runtime.sidecar.request(
        'describe',
        { target: options.target, depth: options.depth },
        60_000,
      )
      this.finishAction(action, 'succeeded')
      this.emit()
      return { runtime: runtime.id, ...result }
    } catch (error) {
      this.finishAction(action, 'failed', messageOf(error))
      this.emit()
      throw error
    }
  }

  #requireRuntime(runtimeRef, connectionRef) {
    const runtime = this.runtimeRef(runtimeRef ?? connectionRef)
    if (!runtime) throw new Error(`no virtuoso-bridge runtime is running; use virtuoso_bridge_runtime action "start" first`)
    if (!['running', 'waiting'].includes(runtime.state)) {
      throw new Error(`runtime ${runtime.id} is ${runtime.state}; start it first`)
    }
    return runtime
  }

  attachAgent(agentId, runtime, label) {
    if (!agentId) return
    const key = String(agentId)
    let usage = this.agentUsage.get(key)
    if (!usage) {
      usage = { sessionId: key, firstUsedAt: Date.now(), lastUsedAt: Date.now(), calls: 0, runtimes: {}, labels: [] }
      this.agentUsage.set(key, usage)
    }
    usage.lastUsedAt = Date.now()
    usage.calls += 1
    usage.runtimes[runtime.id] = (usage.runtimes[runtime.id] ?? 0) + 1
    if (label) {
      usage.labels.unshift({ time: Date.now(), label })
      usage.labels = usage.labels.slice(0, 8)
    }
    let runtimeUsage = runtime.agentUsage.get(key)
    if (!runtimeUsage) {
      runtimeUsage = { sessionId: key, firstUsedAt: Date.now(), lastUsedAt: Date.now(), calls: 0, lastLabel: undefined }
      runtime.agentUsage.set(key, runtimeUsage)
    }
    runtimeUsage.lastUsedAt = Date.now()
    runtimeUsage.calls += 1
    runtimeUsage.lastLabel = label
    this.emit()
  }

  // -- script workers -----------------------------------------------------

  #workerKey(runtimeId, sessionId) {
    return `${runtimeId}::${sessionId}`
  }

  /** Why this run cannot use a worker, or undefined when it may. */
  workerDisabledReason() {
    if (process.env.VB_SCRIPT_DISABLE_WORKER === '1') return 'VB_SCRIPT_DISABLE_WORKER=1'
    if (this.store.snapshot().scriptWorker === false) return 'settings.scriptWorker is false'
    return undefined
  }

  /** Live worker budget per runtime; 0 means unlimited. */
  workerLimit() {
    const raw = Number(this.store.snapshot().scriptWorkerMax)
    if (!Number.isFinite(raw) || raw <= 0) return 0
    return Math.min(Math.floor(raw), 32)
  }

  /**
   * How long a worker must have been idle before its slot may be reclaimed.
   * Evicting a worker that was used seconds ago makes sessions take turns
   * killing each other's warm client, and every eviction costs a full client
   * construction on the next call. Below this threshold the run falls back to a
   * process per script instead, which is correct and costs one slow call.
   */
  workerEvictIdleMs() {
    const raw = Number(this.store.snapshot().scriptWorkerEvictIdleMs)
    if (!Number.isFinite(raw) || raw < 0) return 60_000
    return Math.min(Math.floor(raw), 24 * 60 * 60 * 1000)
  }

  listRuntimeWorkers(runtimeId) {
    return [...this.workers.values()].filter((entry) => entry.runtimeId === runtimeId)
  }

  #snapshotWorkers(runtimeId) {
    return this.listRuntimeWorkers(runtimeId)
      .map((entry) => ({
        sessionId: entry.sessionId,
        pid: entry.pid,
        busy: Boolean(entry.busy),
        jobs: entry.jobs,
        idleSeconds: Math.max(0, Math.round((Date.now() - entry.lastUsedAt) / 1000)),
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  /**
   * Serialise worker acquisition per runtime. The budget check, the eviction and
   * the start have to be atomic: two sessions arriving together must not both
   * judge the budget full, both pick the same idle worker and both start a
   * replacement, which would exceed scriptWorkerMax. `workerStarts` only
   * dedupes concurrent runs of the *same* session.
   */
  #withRuntimeLock(runtimeId, task) {
    const previous = this.workerLocks.get(runtimeId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const guard = run.then(() => {}, () => {})
    this.workerLocks.set(runtimeId, guard)
    void guard.then(() => {
      if (this.workerLocks.get(runtimeId) === guard) this.workerLocks.delete(runtimeId)
    })
    return run
  }

  /**
   * Get (or start) the worker for one runtime and one agent session. Returns
   * undefined whenever the caller must fall back to a process per script: the
   * budget is full of busy workers, or the worker fails to start. Never throws.
   */
  async #acquireWorker(runtime, sessionId, env) {
    const key = this.#workerKey(runtime.id, sessionId)
    const existing = this.workers.get(key)
    if (existing && existing.sidecar && !existing.sidecar.closed) return existing
    if (existing) await this.#disposeWorker(existing, 'closed')
    const pending = this.workerStarts.get(key)
    if (pending) return pending
    const starting = this.#withRuntimeLock(runtime.id, async () => {
      // Another session may have filled or vacated the budget while this run
      // waited for the lock, and this session's own worker may exist by now.
      const again = this.workers.get(key)
      if (again && again.sidecar && !again.sidecar.closed) return again
      const limit = this.workerLimit()
      const workers = this.listRuntimeWorkers(runtime.id)
      if (limit > 0 && workers.length >= limit) {
        // Reclaim a slot from an idle worker that has been idle long enough to
        // be genuinely finished. A busy worker is never evicted: that would kill
        // running user code. A worker that idled for only seconds is kept too,
        // so two sessions cannot thrash each other's warm client.
        const evictAfterMs = this.workerEvictIdleMs()
        const now = Date.now()
        const idle = workers
          .filter((entry) => !entry.busy && now - entry.lastUsedAt >= evictAfterMs)
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
        if (!idle) {
          const busy = workers.filter((entry) => entry.busy).length
          this.#log(
            'warn',
            `${runtime.connection.name} already runs ${workers.length} script worker(s) (limit ${limit}; ${busy} busy, ` +
              `none idle for ${Math.round(evictAfterMs / 1000)}s); running session ${sessionId} with a process per script`,
          )
          return undefined
        }
        this.#log('info', `script worker budget for ${runtime.connection.name} is full (${limit}); stopping idle worker ${idle.sessionId}`)
        await this.#disposeWorker(idle, 'budget')
      }
      return this.#startWorker(runtime, sessionId, env)
    })
    this.workerStarts.set(key, starting)
    try {
      return await starting
    } catch (error) {
      this.#log(
        'warn',
        `script worker for ${runtime.connection.name} (session ${sessionId}) could not start: ${messageOf(error)}; using a process per script`,
      )
      return undefined
    } finally {
      this.workerStarts.delete(key)
    }
  }

  async #startWorker(runtime, sessionId, env) {
    const key = this.#workerKey(runtime.id, sessionId)
    const entry = {
      key,
      runtimeId: runtime.id,
      sessionId: String(sessionId),
      connectionName: runtime.connection.name,
      sidecar: undefined,
      pid: undefined,
      busy: false,
      currentJobId: undefined,
      jobs: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      idleTimer: undefined,
      logTail: [],
    }
    const workerEnv = { ...env }
    // Per-job, so it must not leak into a process that runs many jobs.
    delete workerEnv.VB_SCRIPT_JOB_DIR
    const sidecar = new Sidecar({
      python: this.setup.venvPython,
      script: path.join(this.pluginDir, 'runtime', 'vb_script_worker.py'),
      args: ['--runtime', runtime.id, '--session', entry.sessionId],
      env: workerEnv,
      cwd: this.dataDir,
      label: `script worker ${entry.sessionId} @ ${runtime.connection.name}`,
      onEvent: (event) => this.#onWorkerEvent(entry, event),
      onLog: (level, message) => {
        entry.logTail.push({ time: Date.now(), level, message })
        if (entry.logTail.length > 40) entry.logTail.shift()
        this.#log(level === 'debug' ? 'debug' : level, `[worker ${entry.sessionId}] ${message}`)
      },
    })
    entry.sidecar = sidecar
    try {
      await sidecar.start({ timeoutMs: 60_000 })
    } catch (error) {
      entry.sidecar = undefined
      await sidecar.stop({ stopTunnel: false, timeoutMs: 1_500 }).catch(() => {})
      throw error
    }
    entry.pid = sidecar.pid
    this.workers.set(key, entry)
    this.#log('info', `script worker for ${runtime.connection.name} (session ${entry.sessionId}) ready (pid ${entry.pid})`)
    this.#armWorkerIdle(entry)
    this.emit()
    return entry
  }

  #onWorkerEvent(entry, event) {
    if (event?.event === 'job') {
      this.#log('debug', `[worker ${entry.sessionId}] job ${event.jobId ?? ''} -> ${event.state ?? 'unknown'}`)
      this.emit()
    }
  }

  /** Stop one worker and forget it. Safe to call twice, never stops a tunnel. */
  async #disposeWorker(entry, reason = 'idle') {
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    if (this.workers.get(entry.key) === entry) this.workers.delete(entry.key)
    const sidecar = entry.sidecar
    entry.sidecar = undefined
    entry.busy = false
    entry.currentJobId = undefined
    if (sidecar) {
      try {
        await sidecar.request('shutdown', {}, 1_500)
      } catch {
        // A worker that is already gone cannot answer; the kill below settles it.
      }
      const exited = await Promise.race([
        sidecar.exited ? sidecar.exited.then(() => true) : Promise.resolve(false),
        delay(1_500).then(() => false),
      ])
      if (!exited) {
        this.#log('debug', `script worker ${entry.sessionId} did not exit; killing it`)
        killTree(sidecar.pid)
      }
    }
    this.#log('debug', `script worker ${entry.sessionId} stopped (${reason})`)
    this.emit()
  }

  /** Idle workers shut down so a bench or census run leaves no processes. */
  #armWorkerIdle(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    const idleMs = Number(this.store.snapshot().scriptWorkerIdleMs)
    if (!Number.isFinite(idleMs) || idleMs <= 0) return
    entry.idleTimer = setTimeout(() => {
      if (entry.busy) {
        this.#armWorkerIdle(entry)
        return
      }
      void this.#disposeWorker(entry, 'idle')
    }, idleMs)
    entry.idleTimer.unref?.()
  }

  async stopRuntimeWorkers(runtimeId, reason = 'runtime-stop') {
    // Join the acquisition queue so a worker cannot be started while (or just
    // after) the runtime is being torn down.
    return this.#withRuntimeLock(runtimeId, async () => {
      const entries = this.listRuntimeWorkers(runtimeId)
      await Promise.all(entries.map((entry) => this.#disposeWorker(entry, reason).catch(() => {})))
      return entries.length
    })
  }

  // -- scripts ------------------------------------------------------------

  async runScript(options) {
    const t0Ms = Date.now()
    const description = String(options.description ?? '').trim()
    if (description && /[\r\n]/.test(description)) throw new Error('description must be one line')
    const settings = this.store.snapshot()
    const running = [...this.jobs.values()].filter((job) => job.state === 'running')
    if (running.length >= settings.maxScripts) {
      throw new Error(`the script concurrency limit (${settings.maxScripts}) is reached; wait for a job to finish or cancel one`)
    }
    let runtime
    try {
      if (options.runtime || options.connection) {
        runtime = this.#requireRuntime(options.runtime, options.connection)
      } else {
        const candidate = this.runtimeRef(undefined)
        runtime = candidate && ['running', 'waiting'].includes(candidate.state) ? candidate : undefined
      }
    } catch (error) {
      if (options.runtime || options.connection) throw error
      runtime = undefined
    }
    if (runtime && options.agentId) this.attachAgent(options.agentId, runtime, `script:${options.filePath ?? 'inline'}`)
    const code = options.filePath
      ? await fsp.readFile(path.resolve(options.filePath), 'utf8')
      : String(options.code ?? '')
    if (!code.trim()) throw new Error('script code is empty')
    const probe = await this.setup.probeVenv()
    if (!probe.ok) throw new Error(`the plugin venv is not ready: ${probe.reason}. Run virtuoso_bridge_setup action "install" first.`)
    const job = {
      id: newId('job_'),
      description: description || 'Python script',
      state: 'running',
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: undefined,
      runtimeId: runtime?.id,
      connectionId: runtime?.connectionId,
      agentId: options.agentId,
      timeoutSec: clamp(Number(options.timeoutSec ?? 3600), 1, 86_400),
      dir: path.join(this.setup.cacheDir, 'jobs', 'pending'),
      codePreview: truncate(code, 2_000),
      outputTail: '',
      errorTail: '',
      exitCode: undefined,
      error: undefined,
      cancelled: false,
      timedOut: false,
      autoConnect: options.connect !== false && Boolean(runtime),
      // Phase 0 timing: entry (tool call), spawn (job dir written / worker
      // request sent) and settle (result processed). All in epoch ms.
      timings: { entryMs: t0Ms, spawnMs: undefined, settleMs: undefined },
    }
    job.dir = path.join(this.setup.cacheDir, 'jobs', job.id)
    await ensureDir(job.dir)
    job.scriptPath = path.join(job.dir, 'script.py')
    job.contextPath = path.join(job.dir, 'context.json')
    job.stdoutPath = path.join(job.dir, 'stdout.log')
    job.stderrPath = path.join(job.dir, 'stderr.log')
    await fsp.writeFile(job.scriptPath, code, 'utf8')
    const secret = runtime ? await this.readSecret(runtime.connectionId) : undefined
    const context = {
      jobId: job.id,
      profile: runtime ? runtime.profile || this.profileFor(runtime.connection) : undefined,
      local: runtime ? runtime.connection.kind === 'local' || isLoopbackHost(runtime.connection.host) : false,
      timeoutSec: job.timeoutSec,
      logToCiw: settings.logToCiw,
      autoConnect: job.autoConnect,
      dataDir: this.dataDir,
      connection: runtime ? this.publicConnection(runtime.connection) : undefined,
      t0Ms,
    }
    await fsp.writeFile(job.contextPath, JSON.stringify(context, null, 2), 'utf8')
    const env = runtime
      ? this.buildConnectionEnv(runtime.connection, runtime.profile || this.profileFor(runtime.connection))
      : bridgeChildEnv()
    if (runtime) {
      // Reuse the config the running sidecar was started with. Asking for a
      // plain config here used to delete the pinned file the tunnel still used,
      // so later SSH transfers failed while a manual ssh write succeeded.
      let sshConfig = runtime.sshConfigPath && fileExistsSync(runtime.sshConfigPath) ? runtime.sshConfigPath : undefined
      if (!sshConfig) {
        sshConfig = await this.#ensureSshConfig(runtime.connection, runtime.profile, {
          hostKeyAlgorithms: runtime.hostKeyAlgorithms,
          endpoint: runtime.sshEndpoint,
        })
        runtime.sshConfigPath = sshConfig
      }
      if (sshConfig) env.VB_SSH_CONFIG = sshConfig
      // Script helpers import vb_plugin_env and adopt the Host-owned forward, so
      // they never start a second ssh tunnel for the same runtime.
      this.applyTunnelEnv(runtime, env)
    }
    env.PYTHONUNBUFFERED = '1'
    env.PYTHONDONTWRITEBYTECODE = '1'
    env.VB_PLUGIN_DATA_DIR = this.dataDir
    env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
    env.VB_SCRIPT_JOB_DIR = job.dir
    if (secret?.daemonToken) env.VB_SCRIPT_DAEMON_TOKEN = secret.daemonToken
    const action = this.startAction({
      kind: 'script.run',
      label: description || `Script ${job.id}`,
      runtimeId: runtime?.id,
      connectionId: runtime?.connectionId,
      agentId: options.agentId,
      meta: { jobId: job.id },
    })
    job.actionId = action.id
    this.jobs.set(job.id, job)
    this.#trimJobs()
    // One worker per (runtime, agent session). A different session must never
    // share the process: sessionId is part of the registry key.
    const sessionId = String(options.agentId ?? 'local')
    const disabled = runtime ? this.workerDisabledReason() : 'no runtime is selected'
    let worker
    if (runtime && !disabled) {
      worker = await this.#acquireWorker(runtime, sessionId, env)
      if (worker?.busy) {
        this.#log('debug', `script worker ${sessionId} is busy; running ${job.id} with a process per script`)
        worker = undefined
      }
    }
    job.timings.spawnMs = Date.now()
    if (worker) {
      job.worker = { sessionId: worker.sessionId, pid: worker.pid }
      job.workerEntry = worker
      worker.busy = true
      worker.currentJobId = job.id
      worker.jobs += 1
      worker.lastUsedAt = Date.now()
      job.settled = this.#runJobInWorker(job, worker, action, env)
    } else {
      if (runtime && disabled) this.#log('debug', `script ${job.id} uses a process per script (${disabled})`)
      job.settled = this.#runJobInProcess(job, env, action)
    }
    const waitMs = clamp(Number(options.waitMs ?? 5_000), 0, 120_000)
    if (waitMs > 0) {
      await Promise.race([job.settled, delay(waitMs)])
    }
    this.#log('info', `script ${job.id} started in ${runtime ? runtime.connection.name : 'the plugin venv'}`)
    this.emit()
    return this.snapshotJob(job)
  }

  /** Today's path: one interpreter per script, killed as a whole on timeout. */
  #runJobInProcess(job, env, action) {
    return new Promise((resolve) => {
      void (async () => {
        const child = (await import('node:child_process')).spawn(
          this.setup.venvPython,
          ['-u', path.join(this.pluginDir, 'runtime', 'vb_script.py'), job.dir],
          { cwd: job.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
        )
        job.pid = child.pid
        job.child = child
        let stdoutHandle
        let stderrHandle
        let settled = false
        // A spawn failure (missing interpreter) is emitted on the next tick,
        // before the log handles below exist: claim it first so it can never
        // become an uncaught 'error' event that takes the plugin down.
        child.on('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(job.killTimer)
          job.error = String(error)
          job.state = 'failed'
          job.finishedAt = Date.now()
          job.timings.settleMs = Date.now()
          this.finishAction(action, 'failed', job.error)
          this.#log('warn', `script ${job.id} could not start: ${job.error}`)
          this.emit()
          resolve(job)
        })
        stdoutHandle = await fsp.open(job.stdoutPath, 'a')
        stderrHandle = await fsp.open(job.stderrPath, 'a')
        child.stdout.on('data', (chunk) => {
          stdoutHandle.write(chunk).catch(() => {})
          job.outputTail = (job.outputTail + chunk.toString('utf8')).slice(-30_000)
        })
        child.stderr.on('data', (chunk) => {
          stderrHandle.write(chunk).catch(() => {})
          job.errorTail = (job.errorTail + chunk.toString('utf8')).slice(-30_000)
        })
        job.killTimer = setTimeout(() => {
          if (job.state !== 'running') return
          job.timedOut = true
          this.#killJob(job, 'timeout')
        }, job.timeoutSec * 1000)
        job.killTimer.unref?.()
        child.on('close', async (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(job.killTimer)
          await stdoutHandle.close().catch(() => {})
          await stderrHandle.close().catch(() => {})
          job.exitCode = code
          job.signal = signal
          job.finishedAt = Date.now()
          const status = await readJson(path.join(job.dir, 'status.json'), undefined)
          const statusState = status?.state
          if (job.cancelled) job.state = 'cancelled'
          else if (job.timedOut || statusState === 'timeout') job.state = 'timeout'
          else if (code === 0 && statusState !== 'failed') job.state = 'succeeded'
          else job.state = 'failed'
          const error = await readJson(path.join(job.dir, 'error.json'), undefined)
          if (error) job.error = `${error.type}: ${error.message}`
          else if (job.state === 'failed') job.error = (job.errorTail || job.outputTail || `exit code ${code}`).slice(-4000)
          job.result = await readJson(path.join(job.dir, 'result.json'), undefined)
          job.events = await readEvents(path.join(job.dir, 'events.jsonl'))
          job.status = status
          job.timings.settleMs = Date.now()
          this.finishAction(action, job.state === 'succeeded' ? 'succeeded' : 'failed', job.error)
          this.#log(job.state === 'succeeded' ? 'info' : 'warn', `script ${job.id} ${job.state}`)
          this.emit()
          resolve(job)
        })
        child.on('error', (error) => {
          clearTimeout(job.killTimer)
          job.error = String(error)
          job.state = 'failed'
          job.finishedAt = Date.now()
          job.timings.settleMs = Date.now()
          this.finishAction(action, 'failed', job.error)
          this.emit()
          resolve(job)
        })
      })().catch((error) => {
        job.error = messageOf(error)
        job.state = 'failed'
        job.finishedAt = Date.now()
        job.timings.settleMs = Date.now()
        this.finishAction(action, 'failed', job.error)
        this.emit()
        resolve(job)
      })
    })
  }

  /** Worker path: same job directory and artifacts, no per-call interpreter. */
  async #runJobInWorker(job, worker, action, env) {
    job.killTimer = setTimeout(() => {
      if (job.state !== 'running') return
      job.timedOut = true
      this.#killJob(job, 'timeout')
    }, job.timeoutSec * 1000)
    job.killTimer.unref?.()
    let busy = false
    let outcome
    try {
      outcome = await worker.sidecar.request(
        'run',
        { jobDir: job.dir, jobId: job.id, timeoutSec: job.timeoutSec },
        (job.timeoutSec + 30) * 1000,
      )
    } catch (error) {
      if (error?.code === 'busy') {
        busy = true
      } else {
        const tail = worker.sidecar?.tailStderr?.() ?? ''
        const tailText = tail ? `\n${String(tail).slice(-4_000)}` : ''
        outcome = {
          state: job.cancelled ? 'cancelled' : job.timedOut ? 'timeout' : 'failed',
          error: `script worker ${worker.sessionId} failed: ${messageOf(error)}${tailText}`,
        }
      }
    } finally {
      clearTimeout(job.killTimer)
      worker.busy = false
      worker.currentJobId = undefined
      worker.lastUsedAt = Date.now()
      if (worker.sidecar?.closed) void this.#disposeWorker(worker, 'died')
      else this.#armWorkerIdle(worker)
    }
    if (busy) {
      // Lost a race against another run on the same worker; keep the tool
      // working and use the process path for this job.
      job.worker = undefined
      job.workerEntry = undefined
      this.#log('debug', `script worker ${worker.sessionId} reported busy; running ${job.id} with a process per script`)
      return this.#runJobInProcess(job, env, action)
    }
    return this.#settleJobFromArtifacts(job, action, outcome ?? {})
  }

  async #settleJobFromArtifacts(job, action, workerResult = {}) {
    job.finishedAt = Date.now()
    const status = await readJson(path.join(job.dir, 'status.json'), undefined)
    const state = workerResult.state ?? status?.state
    // A job the user cancelled is 'cancelled', and a job whose kill timer
    // fired is 'timeout' even when the worker reports the interruption as a
    // cancellation: the reason the caller sees must be this side's, not the
    // worker's.
    if (job.cancelled) job.state = 'cancelled'
    else if (job.timedOut) job.state = 'timeout'
    else if (state === 'cancelled') job.state = 'cancelled'
    else if (state === 'timeout') job.state = 'timeout'
    else if (state === 'succeeded') job.state = 'succeeded'
    else job.state = 'failed'
    const error = await readJson(path.join(job.dir, 'error.json'), undefined)
    if (error) job.error = `${error.type}: ${error.message}`
    else if (workerResult.error) job.error = String(workerResult.error).slice(-4_000)
    else if (job.state === 'failed') {
      const tail = await readTail(job.stderrPath, 8_000)
      job.error = (job.errorTail || job.outputTail || tail || 'the script worker reported a failure').slice(-4_000)
    }
    job.result = await readJson(path.join(job.dir, 'result.json'), undefined)
    job.events = await readEvents(path.join(job.dir, 'events.jsonl'))
    job.status = status
    if (status?.exitCode !== undefined) job.exitCode = status.exitCode
    if (!job.outputTail) job.outputTail = await readTail(job.stdoutPath, 20_000)
    if (!job.errorTail) job.errorTail = await readTail(job.stderrPath, 20_000)
    job.timings.settleMs = Date.now()
    this.finishAction(action, job.state === 'succeeded' ? 'succeeded' : 'failed', job.error)
    this.#log(job.state === 'succeeded' ? 'info' : 'warn', `script ${job.id} ${job.state}`)
    this.emit()
    return job
  }

  snapshotJob(job) {
    return {
      id: job.id,
      description: job.description,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      pid: job.pid,
      runtimeId: job.runtimeId,
      connectionId: job.connectionId,
      agentId: job.agentId,
      timeoutSec: job.timeoutSec,
      exitCode: job.exitCode,
      error: job.error,
      result: job.result,
      events: job.events ?? [],
      output: job.outputTail.slice(-20_000),
      errorOutput: job.errorTail.slice(-20_000),
      dir: job.dir,
      scriptPath: job.scriptPath,
      status: job.status,
      codePreview: job.codePreview,
      autoConnect: job.autoConnect,
      timings: job.timings,
      worker: job.worker,
    }
  }

  getScript(ref) {
    const job = this.jobs.get(String(ref ?? ''))
    if (!job) throw new Error(`unknown script job ${ref}`)
    return this.snapshotJob(job)
  }

  listScripts() {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 50)
      .map((job) => ({
        id: job.id,
        description: job.description,
        state: job.state,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        runtimeId: job.runtimeId,
        exitCode: job.exitCode,
        error: job.error,
      }))
  }

  async cancelScript(ref) {
    const job = this.jobs.get(String(ref ?? ''))
    if (!job) throw new Error(`unknown script job ${ref}`)
    if (job.state !== 'running') return this.snapshotJob(job)
    job.cancelled = true
    this.#killJob(job, 'cancelled')
    await Promise.race([job.settled, delay(5_000)])
    return this.snapshotJob(job)
  }

  #killJob(job, reason) {
    if (job.workerEntry) {
      this.#log('warn', `cancelling script ${job.id} in its worker (${reason})`)
      void this.#cancelWorkerJob(job, reason)
      return
    }
    if (!job.pid) {
      job.state = reason === 'timeout' ? 'timeout' : 'cancelled'
      return
    }
    this.#log('warn', `killing script ${job.id} (${reason})`)
    killTree(job.pid)
  }

  /**
   * Cancel through the worker, and kill it if it neither answers nor settles.
   * Killing rejects the pending run request, so job.settled always resolves.
   */
  async #cancelWorkerJob(job, reason) {
    const entry = job.workerEntry
    const sidecar = entry?.sidecar
    let answered = false
    if (sidecar && !sidecar.closed) {
      try {
        const result = await sidecar.request('cancel', { jobId: job.id }, 2_000)
        answered = result?.cancelled !== false
      } catch {
        answered = false
      }
    }
    if (!answered && entry?.sidecar) {
      this.#log('warn', `script worker ${entry.sessionId} did not answer cancel for ${job.id}; killing it`)
      await this.#disposeWorker(entry, 'cancel-timeout')
      return
    }
    if (answered && entry) {
      const timer = setTimeout(() => {
        if (job.state === 'running' && entry.sidecar) {
          this.#log('warn', `script worker ${entry.sessionId} acknowledged cancel for ${job.id} but did not settle it; killing it`)
          void this.#disposeWorker(entry, 'cancel-timeout')
        }
      }, 3_000)
      timer.unref?.()
    }
  }

  #trimJobs() {
    const jobs = [...this.jobs.values()].sort((left, right) => right.createdAt - left.createdAt)
    for (const job of jobs.slice(MAX_JOBS)) {
      if (job.state !== 'running') this.jobs.delete(job.id)
    }
  }

  async loadJobs() {
    const jobsDir = path.join(this.setup.cacheDir, 'jobs')
    if (!fileExistsSync(jobsDir)) return
    const entries = await fsp.readdir(jobsDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'pending') continue
      const dir = path.join(jobsDir, entry.name)
      const status = await readJson(path.join(dir, 'status.json'), undefined)
      if (!status) continue
      const result = await readJson(path.join(dir, 'result.json'), undefined)
      const error = await readJson(path.join(dir, 'error.json'), undefined)
      const job = {
        id: entry.name,
        state: status.state === 'succeeded' ? 'succeeded' : status.state === 'timeout' ? 'timeout' : 'failed',
        createdAt: status.startedAt ? status.startedAt * 1000 : Date.now(),
        startedAt: status.startedAt ? status.startedAt * 1000 : undefined,
        finishedAt: status.updatedAt ? status.updatedAt * 1000 : undefined,
        runtimeId: undefined,
        connectionId: undefined,
        timeoutSec: status.timeoutSec,
        exitCode: status.exitCode,
        error: error ? `${error.type}: ${error.message}` : undefined,
        result,
        output: await readTail(path.join(dir, 'stdout.log'), 20_000),
        errorOutput: await readTail(path.join(dir, 'stderr.log'), 20_000),
        dir,
        scriptPath: path.join(dir, 'script.py'),
        status,
        outputTail: '',
        errorTail: '',
        codePreview: truncate(await readTail(path.join(dir, 'script.py'), 2_000), 2_000),
      }
      this.jobs.set(job.id, job)
    }
    this.#trimJobs()
  }

  // -- actions ------------------------------------------------------------

  startAction({ kind, label, runtimeId, connectionId, agentId, meta }) {
    const action = {
      id: newId('act_'),
      kind,
      label,
      runtimeId,
      connectionId,
      agentId,
      meta,
      state: 'running',
      startedAt: Date.now(),
      finishedAt: undefined,
      detail: undefined,
    }
    this.actions.set(action.id, action)
    while (this.actions.size > MAX_ACTIONS) {
      const oldest = [...this.actions.values()].sort((left, right) => left.startedAt - right.startedAt)[0]
      if (!oldest || oldest.state === 'running') break
      this.actions.delete(oldest.id)
    }
    this.#log('debug', `action ${kind} started: ${label}`)
    this.emit()
    return action
  }

  finishAction(action, state, detail) {
    action.state = state
    action.finishedAt = Date.now()
    action.detail = detail
    this.emit()
    return action
  }

  // -- orphan tunnels -----------------------------------------------------

  vblStateDir(env = process.env) {
    if (env.VB_STATE_DIR) return path.resolve(env.VB_STATE_DIR)
    if (env.VB_HOME) return path.resolve(env.VB_HOME, 'state')
    if (process.platform === 'win32') {
      return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'virtuoso_bridge', 'state')
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'virtuoso_bridge', 'state')
    }
    return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'virtuoso_bridge')
  }

  async scanOrphans() {
    const found = []
    for (const connection of this.store.snapshot().connections) {
      const profile = this.profileFor(connection)
      const env = this.buildConnectionEnv(connection, profile)
      const stateDir = this.vblStateDir(env)
      let entries = []
      try {
        entries = await fsp.readdir(stateDir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.startsWith(`state_${profile}`) || !entry.endsWith('.json')) continue
        const file = path.join(stateDir, entry)
        const state = await readJson(file, undefined)
        if (!state) continue
        const aliveTunnel = pidAlive(state.tunnel_pid)
        const runtime = this.runtimes.get(`rt_${connection.id}`)
        const managed = Boolean(runtime && ['running', 'waiting', 'starting', 'connecting'].includes(runtime.state))
        found.push({
          connectionId: connection.id,
          connectionName: connection.name,
          profile,
          file,
          mode: state.mode,
          host: state.daemon_host ?? state.remote_host,
          port: state.port,
          tunnelPid: state.tunnel_pid,
          tunnelAlive: aliveTunnel,
          setupPath: state.setup_path,
          managed,
          state: aliveTunnel && !managed ? 'orphaned' : aliveTunnel ? 'managed' : 'stale',
        })
      }
    }
    // Host-owned tunnels also leave a record of their own. The upstream state
    // file only appears once the sidecar adopted the forward, so a DSH host that
    // crashed during startup would otherwise leave an undiscoverable ssh.exe.
    const recordsDir = path.join(this.dataDir, 'tunnels')
    let records = []
    try {
      records = await fsp.readdir(recordsDir)
    } catch {
      records = []
    }
    for (const entry of records.filter((name) => name.toLowerCase().endsWith('.json'))) {
      const file = path.join(recordsDir, entry)
      const record = await readJson(file, undefined)
      if (!record?.pid) {
        await fsp.rm(file, { force: true }).catch(() => {})
        continue
      }
      const alive = pidAlive(record.pid)
      if (found.some((item) => item.tunnelPid === record.pid)) continue
      const managed = [...this.runtimes.values()].some((runtime) => runtime.tunnel?.pid === record.pid)
      if (!alive) await fsp.rm(file, { force: true }).catch(() => {})
      found.push({
        source: 'plugin',
        connectionId: record.connectionId,
        connectionName: record.connectionName,
        profile: record.profile,
        file,
        mode: record.mode ?? 'remote',
        host: record.host,
        port: record.localPort,
        tunnelPid: record.pid,
        tunnelAlive: alive,
        managed,
        state: alive && !managed ? 'orphaned' : alive ? 'managed' : 'stale',
      })
    }
    this.orphans = found
    return found
  }

  async stopOrphan(ref, options = {}) {
    const connection = this.store.connection(ref)
    if (!connection) throw new Error(`unknown connection ${ref}`)
    const profile = this.profileFor(connection)
    let killedPluginTunnel = false
    const record = await readJson(this.pluginTunnelRecordPath(connection.id), undefined)
    if (record?.pid && pidAlive(record.pid)) {
      const managedRuntime = [...this.runtimes.values()].find((runtime) => runtime.tunnel?.pid === record.pid)
      if (managedRuntime) {
        // A live runtime still owns this forward; do not kill it behind its back.
        return this.stopRuntime(managedRuntime.id, { stopTunnel: true })
      }
      // The Host owns this forward; stop it directly instead of asking the
      // upstream helper, which only knows pids recorded in its own state file.
      killTree(record.pid)
      killedPluginTunnel = true
    }
    await fsp.rm(this.pluginTunnelRecordPath(connection.id), { force: true }).catch(() => {})
    const probe = await this.setup.probeVenv()
    if (!probe.ok) throw new Error(`the plugin venv is not ready: ${probe.reason}`)
    const env = this.buildConnectionEnv(connection, profile)
    env.PYTHONUNBUFFERED = '1'
    const result = await runProcess(
      this.setup.venvPython,
      ['-E', '-s', path.join(this.pluginDir, 'runtime', 'vb_stop_profile.py'), '--profile', profile],
      { env, timeoutMs: 60_000, maxOutput: 40_000 },
    )
    const detail = result.stdout.trim() || result.stderr.trim()
    const ok = result.ok || killedPluginTunnel
    if (!ok) {
      if (!options.silent) throw new Error(`could not stop the tunnel: ${detail}`)
    } else if (!options.silent) {
      this.#log(
        'info',
        killedPluginTunnel
          ? `orphan plugin-owned tunnel for ${connection.name} stopped${detail ? `: ${detail}` : ''}`
          : `orphan tunnel for ${connection.name} stopped: ${detail}`,
      )
    }
    this.orphans = await this.scanOrphans()
    this.emit()
    return { ok, detail, profile, pluginTunnel: killedPluginTunnel }
  }

  // -- cache --------------------------------------------------------------

  async clearCache(ref, options = {}) {
    const result = await this.setup.clearCache(String(ref))
    if (String(ref) === 'jobs') this.jobs.clear()
    await this.refreshCaches(true)
    this.#log('info', `cache ${ref} cleared`)
    return result
  }

  // -- state --------------------------------------------------------------

  waitForChange(waitMs) {
    const timeout = clamp(Number(waitMs) || 0, 0, 180_000)
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      let done = false
      const finish = (changed) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(changed)
      }
      const listener = () => finish(true)
      const timer = setTimeout(() => finish(false), timeout)
      this.listeners.add(listener)
    })
  }

  hasPendingStart() {
    return [...this.runtimes.values()].some(
      (runtime) => Boolean(runtime.startPromise) || ['starting', 'connecting'].includes(runtime.state),
    )
  }

  async waitForStartSettled(waitMs) {
    const timeout = clamp(Number(waitMs) || 0, 0, 180_000)
    const deadline = Date.now() + timeout
    while (this.hasPendingStart() && Date.now() < deadline) {
      await this.waitForChange(Math.min(500, Math.max(1, deadline - Date.now())))
    }
    return !this.hasPendingStart()
  }

  clearActions() {
    const running = [...this.actions.values()].filter((action) => action.state === 'running')
    let removed = 0
    for (const [id, action] of this.actions) {
      if (action.state === 'running') continue
      this.actions.delete(id)
      for (const runtime of this.runtimes.values()) runtime.actionIds.delete(id)
      removed += 1
    }
    this.#log('info', `cleared ${removed} completed operation${removed === 1 ? '' : 's'}`)
    this.emit()
    return { removed, running: running.length }
  }

  compactSetup(setup) {
    if (!setup) return undefined
    return {
      installed: Boolean(setup.installed),
      installing: Boolean(setup.installing),
      source: setup.source?.mode,
      version: setup.venv?.package?.version,
      venvReady: Boolean(setup.venv?.exists && setup.venv?.package && !setup.venv?.foreignPackage),
      packageFile: setup.venv?.packageFile,
      reason: setup.venv?.reason,
      backend: setup.backends
        ? {
            openssh: Boolean(setup.backends.openssh?.available),
            paramiko: Boolean(setup.backends.paramiko?.installed),
            needsConfirmation: Boolean(setup.backends.needsConfirmation),
            preferred: setup.backends.preferred,
          }
        : undefined,
      lastInstallAt: setup.lastInstall?.installedAt,
      error: setup.error ?? setup.lastInstall?.error,
    }
  }

  compactConnection(connection) {
    if (!connection) return undefined
    return {
      id: connection.id,
      name: connection.name,
      kind: connection.kind,
      host: connection.host,
      user: connection.user,
      port: connection.port,
      autoSessions: Boolean(connection.autoSessions),
      instancePort: connection.instancePort,
      remoteWorkDir: connection.remoteWorkDir || '',
      remoteScratchRoot: connection.remoteScratchRoot || '',
      clientId: connection.clientId || '',
      daemonSetup: connection.daemonSetup || '',
      subInstances: (connection.subInstances ?? []).map((sub) => ({ id: sub.id, name: sub.name, workDir: sub.workDir })),
      sshPort: connection.sshPort,
      sshBackend: connection.sshBackend,
      envShell: connection.envShell,
      enabled: connection.enabled,
      hasSecret: Boolean(connection.hasSecret),
      runtime: connection.runtime ?? 'stopped',
      daemon: connection.daemon,
    }
  }

  compactRuntime(runtime) {
    if (!runtime) return undefined
    const pending = runtime.pendingHostKey
    return {
      id: runtime.id,
      connectionId: runtime.connectionId,
      name: runtime.name,
      state: runtime.state,
      connectionStatus: runtime.connectionStatus,
      stage: runtime.stage,
      envShell: runtime.envShell,
      subInstanceId: runtime.subInstanceId,
      subInstanceName: runtime.subInstanceName,
      autoSessions: Boolean(runtime.autoSessions),
      instancePort: runtime.instancePort,
      instance: runtime.instance,
      remoteWorkDir: runtime.remoteWorkDir,
      daemonCompatibility: runtime.daemonCompatibility,
      daemonProbe: runtime.daemonProbe,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      lastUsedAt: runtime.lastUsedAt,
      wasReady: Boolean(runtime.wasReady),
      dialog: runtime.dialog,
      health: runtime.health
        ? {
            ok: runtime.health.ok,
            summary: runtime.health.summary,
            daemonResponsive: runtime.health.daemonResponsive,
            checkedAt: runtime.health.checkedAt,
          }
        : undefined,
      daemon: runtime.daemon,
      setupHint: runtime.setupHint,
      attach: runtime.attach
        ? {
            attached: Boolean(runtime.attach.attached),
            port: runtime.attach.port,
            setupPath: runtime.attach.setupPath,
            message: runtime.attach.message,
            reason: runtime.attach.reason,
            probe: runtime.attach.probe
              ? { state: runtime.attach.probe.state, signed: runtime.attach.probe.signed, build: runtime.attach.probe.build }
              : undefined,
          }
        : undefined,
      scratchRoot: runtime.scratchRoot,
      scratchConfigured: runtime.scratchConfigured,
      error: runtime.error,
      errorSummary: runtime.errorDetail
        ? {
            stage: runtime.errorDetail.stage,
            message: runtime.errorDetail.message,
            hint: runtime.errorDetail.hint,
          }
        : undefined,
      pendingHostKey: pending
        ? {
            host: pending.host,
            resolvedHost: pending.resolvedHost,
            sshPort: pending.sshPort,
            knownHostSpecs: pending.knownHostSpecs,
            message: pending.message,
            unknown: (pending.unknown ?? []).map((entry) => ({
              host: entry.knownHostSpecs?.[0] || entry.hostSpec,
              role: entry.role,
              type: entry.type,
              fingerprint: entry.fingerprint,
            })),
            conflicts: (pending.conflicts ?? []).map((conflict) => ({
              incoming: {
                host: conflict.incoming?.knownHostSpecs?.[0] || conflict.incoming?.hostSpec,
                role: conflict.incoming?.role,
                type: conflict.incoming?.type,
                fingerprint: conflict.incoming?.fingerprint,
              },
              existing: (conflict.existing ?? []).map((entry) => entry.fingerprint),
            })),
          }
        : undefined,
      agents: (runtime.agents ?? []).map((agent) => ({ sessionId: agent.sessionId, calls: agent.calls, lastUsedAt: agent.lastUsedAt })),
      workers: runtime.workers,
      workerLimit: runtime.workerLimit,
      pending: Boolean(runtime.pending),
    }
  }

  getAgentState() {
    const state = this.getState()
    return {
      ok: true,
      generatedAt: state.generatedAt,
      setup: this.compactSetup(state.setup),
      connections: state.connections.map((connection) => this.compactConnection(connection)),
      runtimes: state.runtimes.map((runtime) => this.compactRuntime(runtime)),
      agents: state.agents.map((agent) => ({ sessionId: agent.sessionId, calls: agent.calls, lastUsedAt: agent.lastUsedAt, live: agent.live })),
      activeActions: state.actions
        .filter((action) => action.state === 'running')
        .map((action) => ({ kind: action.kind, label: action.label, startedAt: action.startedAt, runtimeId: action.runtimeId })),
    }
  }

  getState() {
    const settings = this.store.snapshot()
    const connections = settings.connections.map((connection) => this.publicConnection(connection))
    const runtimes = [...this.runtimes.values()]
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
      .map((runtime) => this.snapshotRuntime(runtime))
    const actions = [...this.actions.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 40)
    const liveAgents = new Set((this.ctx?.get?.('agents')?.list?.() ?? []).map((agent) => String(agent.id)))
    const activeSince = Date.now() - 10 * 60_000
    const runningAgentIds = new Set(
      actions
        .filter((action) => action.state === 'running' && action.agentId)
        .map((action) => String(action.agentId)),
    )
    const agents = [...this.agentUsage.values()]
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .slice(0, 30)
      .map((usage) => {
        const live = liveAgents.has(String(usage.sessionId))
        const active = (live && usage.lastUsedAt >= activeSince) || runningAgentIds.has(String(usage.sessionId))
        return { ...usage, live, active }
      })
    return {
      ok: true,
      version: this.version,
      pluginVersion: this.version,
      generatedAt: Date.now(),
      startedAt: this.startedAt,
      setup: this.setupStatus,
      settings: {
        source: settings.source,
        pythonPath: settings.pythonPath,
        autoInstall: settings.autoInstall,
        autoStart: settings.autoStart,
        defaultConnection: settings.defaultConnection,
        logToCiw: settings.logToCiw,
        maxScripts: settings.maxScripts,
        scriptWorker: settings.scriptWorker,
        scriptWorkerIdleMs: settings.scriptWorkerIdleMs,
        scriptWorkerMax: settings.scriptWorkerMax,
        scriptWorkerEvictIdleMs: settings.scriptWorkerEvictIdleMs,
        cacheDir: settings.cacheDir,
        installSshExtra: settings.installSshExtra,
        defaultRemoteScratchRoot: settings.defaultRemoteScratchRoot,
      },
      dataDir: this.dataDir,
      cacheDir: this.setup.cacheDir,
      pluginDir: this.pluginDir,
      connections,
      runtimes,
      agents,
      actions,
      jobs: this.listScripts(),
      caches: this.cacheInfo?.entries ?? [],
      disk: this.cacheInfo?.disk,
      orphans: this.orphans,
      logs: this.logs.slice(-60),
      secretsAvailable: Boolean(this.credentials),
      capabilities: {
        webServer: Boolean(this.dashboard?.enabled),
        credentials: Boolean(this.credentials),
        dashboard: this.dashboard
          ? {
              enabled: Boolean(this.dashboard.enabled),
              origin: this.dashboard.origin,
              basePath: this.dashboard.basePath,
            }
          : { enabled: false },
      },
    }
  }

  // -- HTTP action dispatch ----------------------------------------------

  async performAction(action, payload = {}, meta = {}) {
    const data = payload ?? {}
    const agentId = meta.agentId ?? data.agentId
    switch (action) {
      case 'runtime.start':
        return this.startRuntime(data.connection ?? data.runtime ?? data.id, {
          waitMs: data.waitMs ?? 15_000,
          agentId,
          subInstance: data.subInstance ?? data.workDir,
          restart: data.restart === true,
        })
      case 'runtime.stop':
        return this.stopRuntime(data.runtime ?? data.connection ?? data.id, { agentId, stopTunnel: data.stopTunnel !== false })
      case 'runtime.restart':
        return this.startRuntime(data.connection ?? data.runtime ?? data.id, { waitMs: data.waitMs ?? 15_000, agentId, subInstance: data.subInstance ?? data.workDir, restart: true })
      case 'runtime.host_key':
        return this.inspectHostKey(data.connection ?? data.runtime ?? data.id)
      case 'runtime.trust_host':
        return this.trustHost(data.connection ?? data.runtime ?? data.id, data.fingerprint, {
          subInstance: data.subInstance,
          runtimeId: data.runtime,
        })
      case 'runtime.ping': {
        const runtime = this.#requireRuntime(data.runtime ?? data.connection, undefined)
        const status = await runtime.sidecar.request('status', {}, 20_000)
        runtime.status = status
        runtime.lastHealthAt = Date.now()
        this.emit()
        return { runtime: runtime.id, status }
      }
      case 'runtime.daemon': {
        const runtime = this.#requireRuntime(data.runtime ?? data.connection, undefined)
        const status = await runtime.sidecar.request('status', {}, 15_000)
        runtime.status = status
        runtime.lastHealthAt = Date.now()
        this.emit()
        return { runtime: this.snapshotRuntime(runtime) }
      }
      case 'runtime.call':
        return this.callApi({ ...data, agentId })
      case 'runtime.describe':
        return this.describeApi({ ...data, agentId })
      case 'connection.save': {
        const saved = await this.saveConnection(data.connection ?? data, data.secret, { restart: data.restart === true })
        return saved
      }
      case 'connection.delete':
        return this.deleteConnection(this.connectionRef(data.connection ?? data.id))
      case 'connection.test':
        return this.testConnection(this.connectionRef(data.connection ?? data.id), {
          agentId,
          runtime: data.runtime,
          subInstance: data.subInstance ?? data.workDir,
        })
      case 'connection.instances':
        return this.listInstances(data.connection ?? data.id, data)
      case 'connection.deploy':
        return this.deployDaemon(data.connection ?? data.id, { replace: data.replace === true })
      case 'connection.detect_shell':
        return this.detectShell(data.connection ?? data.id, { agentId })
      case 'setup.install':
        return this.install({ recreate: data.recreate === true, agentId, confirm: data.confirm === true })
      case 'setup.update':
        return this.install({ recreate: data.recreate === true, agentId, confirm: data.confirm === true })
      case 'setup.preflight':
        return this.setup.preflight()
      case 'setup.configure':
        return this.updateSettings(data.patch ?? data.settings ?? data)
      case 'setup.source':
        return this.updateSource(data.source ?? data)
      case 'setup.diagnose':
        return this.diagnose({ agentId })
      case 'setup.refresh':
        return { setup: await this.refreshSetup(true), caches: await this.refreshCaches(true) }
      case 'cache.clear':
        return this.clearCache(data.cache ?? data.id)
      case 'cache.refresh':
        return this.refreshCaches(true)
      case 'orphan.stop':
        return this.stopOrphan(data.connection ?? data.id)
      case 'orphan.scan':
        return { orphans: await this.scanOrphans() }
      case 'script.run':
        return this.runScript({ ...data, agentId })
      case 'script.status':
        return this.getScript(data.job ?? data.id)
      case 'script.cancel':
        return this.cancelScript(data.job ?? data.id)
      case 'script.list':
        return this.listScripts()
      case 'logs.clear':
        this.logs = []
        this.emit()
        return { cleared: true }
      case 'actions.clear':
        return this.clearActions()
      default:
        throw new Error(`unknown dashboard action ${action}`)
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Split evaluated host-key offers into target and jump-host decisions.
 *
 * Both endpoints must be trusted: a known target must not mask an unknown jump
 * host, because the SSH backend separately verifies the jump connection and
 * fails the start afterwards. An extra untrusted key type (or a changed type
 * the host does not negotiate) of an endpoint that already has a trusted type
 * is not blocking; SSH is pinned to the trusted types.
 */
export function classifyHostKeyState({ known = [], unknown = [], conflicts = [], entries = [] } = {}) {
  const isJump = (entry) => entry?.role === 'jump'
  const targetKnownKeys = known.filter((entry) => !isJump(entry))
  const targetUnknownKeys = unknown.filter((entry) => !isJump(entry))
  const targetConflicts = conflicts.filter((item) => !isJump(item.incoming))
  const jumpOffered = entries.some((entry) => isJump(entry))
  const jumpKnownKeys = known.filter((entry) => isJump(entry))
  const jumpUnknownKeys = unknown.filter((entry) => isJump(entry))
  const jumpConflicts = conflicts.filter((item) => isJump(item.incoming))
  const targetTrusted = targetKnownKeys.length > 0
  const jumpTrusted = !jumpOffered || jumpKnownKeys.length > 0
  const blockingConflicts = [
    ...(targetTrusted ? [] : targetConflicts),
    ...(jumpTrusted ? [] : jumpConflicts),
  ]
  return {
    targetKnownKeys,
    jumpKnownKeys,
    unknownToTrust: [...targetUnknownKeys, ...jumpUnknownKeys],
    blockingConflicts,
    targetTrusted,
    jumpTrusted,
    needsTrust: !targetTrusted || !jumpTrusted,
    pinTypes: [...new Set(targetKnownKeys.map((entry) => entry.type))],
    trustedTargetTypes: [...new Set([...targetKnownKeys, ...targetUnknownKeys].map((entry) => entry.type))],
  }
}

/** Compact one-line summary of the structured Test Connection checks. */
export function summarizeHealth(checks = {}, sshOk = false) {
  const parts = []
  const ssh = checks.ssh ?? {}
  if (ssh.local) parts.push('local connection (no SSH)')
  else if (ssh.ok) parts.push(`SSH ok${ssh.elapsedMs ? ` (${ssh.elapsedMs} ms)` : ''}`)
  else parts.push(`SSH failed${ssh.error ? `: ${String(ssh.error).slice(0, 160)}` : ''}`)
  const python = checks.remotePython
  if (python) {
    parts.push(python.ok && python.selected ? `remote python ${python.selected.version || python.selected.path}` : 'no remote python')
  }
  const scratch = checks.scratchRoot
  if (scratch) {
    if (scratch.ok) parts.push(`scratch root ready${scratch.mode ? ` (${scratch.mode})` : ''}`)
    else if (scratch.code === 'scratch-root-missing' || scratch.exists === false) {
      parts.push(`scratch root missing${scratch.resolved ? `: ${scratch.resolved}` : ''}`)
    } else parts.push(`scratch root not ready${scratch.error ? `: ${String(scratch.error).slice(0, 160)}` : ''}`)
  }
  const daemon = checks.daemon
  if (daemon) {
    const state = daemon.state ?? 'unknown'
    parts.push(
      state === 'ready'
        ? `daemon ready${daemon.build ? ` (${daemon.build})` : ''}${daemon.signed ? ' signed' : ''}`
        : `daemon ${state}${daemon.summary || daemon.message ? `: ${String(daemon.summary || daemon.message).slice(0, 160)}` : ''}`,
    )
  }
  if (!parts.length) parts.push(sshOk ? 'SSH login succeeded' : 'connection test failed')
  return parts.join(' · ')
}

/**
 * Map a runtime start failure to the daemon condition the operator must act on.
 *
 * The upstream identity guard reports a missing daemon (CIW setup never
 * loaded) as "could not determine the Unix user of the daemon behind the
 * tunnel (Socket error: [WinError 10053] ...)". That reads like an SSH or
 * permissions problem, so classify it by the sidecar's side-effect-free
 * capability probe first and by stable message fragments second.
 */
export function classifyDaemonFailure(message, probe) {
  const text = String(message ?? '')
  const state = String(probe?.state ?? '')
  // Auth errors can also contain the word "protocol"; an AuthError prefix is
  // authoritative about what needs rotating, so check it first.
  if (
    state === 'auth' ||
    /AuthError|Bridge authentication failed|requires bridge token authentication|refused our token|token was rotated/i.test(
      text,
    )
  ) {
    return 'auth-failed'
  }
  if (
    state === 'legacy' ||
    /capability handshake|protocol version mismatch|unparseable capability|predates bridge|older build|older daemon|did not authenticate its handshake|instance-bound|updated setup|reload the setup/i.test(
      text,
    )
  ) {
    return 'version-mismatch'
  }
  if (
    state === 'no-listener' ||
    /could not determine the Unix user|identity check failed|WinError (?:10053|10054|10061)|Connection reset|Connection refused|Empty response from daemon|daemon did not answer|no listener|not loaded/i.test(
      text,
    )
  ) {
    return 'unreachable'
  }
  if (/daemon did not respond|no response from the daemon|tcp.*unreachable/i.test(text)) return 'unreachable'
  return undefined
}

async function readEvents(file) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const events = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A partially written trailing line is harmless.
      }
    }
    return events.slice(-80)
  } catch {
    return []
  }
}

async function tcpProbe(host, port, timeoutMs) {  const net = await import('node:net')
  const started = Date.now()
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (ok, detail) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, latencyMs: Date.now() - started, detail })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, `TCP ${host}:${port} reachable in ${Date.now() - started} ms`))
    socket.once('timeout', () => finish(false, `TCP ${host}:${port} timed out after ${timeoutMs} ms`))
    socket.once('error', (error) => finish(false, `TCP ${host}:${port} failed: ${error.message}`))
  })
}
