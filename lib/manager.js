/** Process-wide runtime manager: setup, connections, sidecars, scripts, state. */
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
} from './util.js'
import { Sidecar } from './sidecar.js'
import { evaluateHostKeys, hostSpec, probeHostKeys, trustHostKey } from './ssh.js'

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
    await Promise.all(
      runtimes.map(async (runtime) => {
        if (runtime.sidecar) {
          await runtime.sidecar.stop({ stopTunnel: true, timeoutMs: 5_000 }).catch(() => {})
        }
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
    for (const key of ['pythonPath', 'autoInstall', 'autoStart', 'defaultConnection', 'logToCiw', 'maxScripts', 'source', 'cacheDir', 'installSshExtra']) {
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
      runtime.pendingHostKey = undefined
      if (runtime.state === 'needs-trust') runtime.state = 'stopped'
      runtime.error = undefined
      runtime.errorDetail = undefined
      runtime.stage = 'stopped'
    }
    this.#log('info', `connection ${saved.name} saved`)
    const connection = this.publicConnection(saved)
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
    const profile = profileNameFor(connection.id)
    const env = this.buildConnectionEnv(deployConnection, profile)
    env.VB_PLUGIN_DATA_DIR = this.dataDir
    env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
    env.VB_RUNTIME_PROFILE = profile
    const args = [
      path.join(this.pluginDir, 'runtime', 'vb_deploy.py'),
      '--profile', profile,
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
      throw new Error(parsed?.error ?? (result.stderr || result.stdout || 'daemon deployment returned no result').trim().slice(-3000))
    }
    return {
      ...parsed,
      connection: this.compactConnection(this.publicConnection(connection)),
    }
  }

  async listInstances(ref, options = {}) {    const connection = this.store.connection(this.connectionRef(ref))
    if (!connection) throw new Error(`unknown connection ${ref}`)
    const profile = profileNameFor(connection.id)
    const env = this.buildConnectionEnv(connection, profile)
    env.VB_PLUGIN_DATA_DIR = this.dataDir
    env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
    env.VB_RUNTIME_PROFILE = profile
    const args = [
      path.join(this.pluginDir, 'runtime', 'vb_instances.py'),
      '--profile', profile,
      '--timeout', String(Math.max(5, Number(options.timeoutSec) || 20)),
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
      ok: true,
      connection: this.compactConnection(this.publicConnection(connection)),
      autoSessions: Boolean(parsed.autoSessions),
      instances: parsed.instances ?? [],
      selected: parsed.selected ?? null,
      expectedWorkDir: parsed.expectedWorkDir ?? '',
      setupPath: parsed.setupPath ?? null,
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
      let detail = ''
      let pendingHostKey
      const runtime = this.runtimes.get(`rt_${connection.id}`)
      let daemon = { state: 'unknown', checked: false, summary: 'start the runtime to probe the remote daemon' }
      if (local) {
        const probePort = connection.instancePort || connection.port
        if (!probePort) {
          ok = false
          detail = 'automatic local instance discovery requires a Linux daemon host; select an instance port or use a remote host'
          daemon = { state: 'unknown', checked: false, summary: detail }
        } else {
          const result = await tcpProbe(connection.host, probePort, 5_000)
          ok = result.ok
          detail = result.detail
          daemon = {
            state: result.ok ? 'ready' : 'unreachable',
            checked: true,
            responsive: result.ok,
            tcpReachable: result.ok,
            summary: result.detail,
          }
        }
      } else {
        const profile = profileNameFor(connection.id)
        const configPath = await this.#ensureSshConfig(connection)
        const env = this.buildConnectionEnv(connection, profile)
        if (configPath) env.VB_SSH_CONFIG = configPath
        env.VB_RUNTIME_PROFILE = profile
        env.VB_PLUGIN_DATA_DIR = this.dataDir
        env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
        const helper = path.join(this.pluginDir, 'runtime', 'vb_ssh_test.py')
        const probe = await runProcess(
          this.setup.venvPython,
          [helper, '--profile', profile, '--timeout', '20'],
          { env, timeoutMs: 30_000, maxOutput: 60_000 },
        ).catch((error) => ({ ok: false, stdout: '', stderr: messageOf(error) }))
        let parsed
        try {
          parsed = JSON.parse((probe.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '{}')
        } catch {
          parsed = undefined
        }
        if (parsed) {
          ok = parsed.ok === true
          detail = ok
            ? `SSH login succeeded in ${Date.now() - started} ms`
            : String(parsed.error ?? parsed.stderr ?? 'SSH test failed').slice(-1500)
          if (!ok && /host key|known_hosts|authenticity of host|remote host identification|no matching host key/i.test(detail)) {
            const hostKeyProbe = await probeHostKeys(connection, {
              dataDir: this.dataDir,
              pluginDir: this.pluginDir,
              python: this.setup.venvPython,
              sshConfigPath: configPath,
              backend: connection.sshBackend,
            }).catch((error) => ({ ok: false, entries: [], error: messageOf(error) }))
            if (hostKeyProbe.ok && hostKeyProbe.entries?.length) {
              const evaluation = await evaluateHostKeys(hostKeyProbe.entries, connection, {
                dataDir: this.dataDir,
                pluginDir: this.pluginDir,
                python: this.setup.venvPython,
              }).catch(() => ({ unknown: [], conflicts: [], known: [] }))
              pendingHostKey = {
                host: connection.host,
                sshPort: Number(connection.sshPort) || 22,
                entries: hostKeyProbe.entries,
                unknown: evaluation.unknown,
                conflicts: evaluation.conflicts,
                source: hostKeyProbe.source,
                message: 'The SSH host key is not trusted yet.',
              }
            }
          }
        } else {
          detail = String(probe.stderr || probe.stdout || 'SSH test helper produced no result').slice(-1500)
        }
      }
      if (runtime?.sidecar && ['running', 'waiting'].includes(runtime.state)) {
        try {
          const status = await runtime.sidecar.request('status', {}, 10_000)
          runtime.status = status
          runtime.lastHealthAt = Date.now()
          daemon = this.daemonInfo(status.daemon)
        } catch (error) {
          daemon = { state: 'unreachable', checked: true, summary: messageOf(error) }
        }
      }
      this.finishAction(action, ok ? 'succeeded' : 'failed', detail)
      return {
        ok,
        latencyMs: Date.now() - started,
        detail: detail.slice(-1500),
        pendingHostKey,
        daemon,
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
    const sshConfigPath = await this.#ensureSshConfig(connection)
    const probe = await probeHostKeys(connection, {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      sshConfigPath,
      backend: connection.sshBackend,
    })
    if (!probe.ok) {
      return { ok: false, connection: this.publicConnection(connection), probe }
    }
    const evaluation = await evaluateHostKeys(probe.entries, connection, { dataDir: this.dataDir, pluginDir: this.pluginDir, python: this.setup.venvPython })
    return {
      ok: true,
      connection: this.publicConnection(connection),
      host: connection.host,
      sshPort: Number(connection.sshPort) || 22,
      entries: probe.entries.map((entry) => ({
        host: entry.hostSpec || hostSpec(connection.host, connection.sshPort),
        type: entry.type,
        fingerprint: entry.fingerprint,
      })),
      known: evaluation.known.map((entry) => entry.fingerprint),
      unknown: evaluation.unknown.map((entry) => entry.fingerprint),
      conflicts: evaluation.conflicts.map((item) => ({
        incoming: item.incoming.fingerprint,
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
    const result = await trustHostKey(connection, String(fingerprint), {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      sshConfigPath: await this.#ensureSshConfig(connection, runtime?.profile),
      knownHostsPath: options.knownHostsPath,
      port: Number(connection.sshPort) || 22,
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
        ? { host: result.entry.hostSpec || hostSpec(connection.host, connection.sshPort), type: result.entry.type, fingerprint: result.entry.fingerprint }
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
      hostKeyResolve: undefined,
      hostKeyWait: undefined,
      daemon: undefined,
      instance: undefined,
      daemonCompatibility: undefined,
      stage: undefined,
      envShell: undefined,
      setupHint: undefined,
      sidecar: undefined,
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

  runtimeProfileFor(connection, sub) {
    return profileNameFor(sub ? `${connection.id}_${sub.id}` : connection.id)
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
      await this.stopRuntime(runtimeId, { stopTunnel: true }).catch(() => {})
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
    if (ref) return ref
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
    const profile = profileNameFor(connection.id)
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
    const fingerprints = entries.map((entry) => `- \`${entry.type}\` \`${entry.fingerprint}\``).join('\n')
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
    const sshConfigPath = await this.#ensureSshConfig(connection, runtime.profile)
    const probe = await probeHostKeys(connection, {
      dataDir: this.dataDir,
      pluginDir: this.pluginDir,
      python: this.setup.venvPython,
      sshConfigPath,
      backend: connection.sshBackend,
    }).catch((error) => ({
      ok: false,
      entries: [],
      error: messageOf(error),
    }))
    runtime.hostKeyProbe = {
      ok: Boolean(probe.ok),
      source: probe.source,
      error: probe.error,
      host: connection.host,
      port: Number(connection.sshPort) || 22,
      checkedAt: Date.now(),
      entries: (probe.entries ?? []).map((entry) => ({
        host: entry.hostSpec || hostSpec(connection.host, connection.sshPort),
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
    const evaluation = await evaluateHostKeys(probe.entries, connection, { dataDir: this.dataDir, pluginDir: this.pluginDir, python: this.setup.venvPython })
    if (evaluation.unknown.length || evaluation.conflicts.length) {
      runtime.pendingHostKey = {
        host: connection.host,
        sshPort: Number(connection.sshPort) || 22,
        source: probe.source,
        checkedAt: Date.now(),
        entries: probe.entries,
        unknown: evaluation.unknown,
        conflicts: evaluation.conflicts,
        message:
          evaluation.conflicts.length > 0
            ? 'The server offered a host key that differs from known_hosts. Verify it before replacing the old entry.'
            : 'The server host key is not trusted yet. Confirm the fingerprint to add it to known_hosts.',
      }
      runtime.state = 'needs-trust'
      runtime.stage = 'needs-trust'
      runtime.error = runtime.pendingHostKey.message
      this.#log('warn', `host key confirmation required for ${connection.name}: ${runtime.pendingHostKey.unknown.map((entry) => `${entry.type} ${entry.fingerprint}`).join(', ')}`)
      this.emit()
      const decision = await this.#promptHostKey(runtime, runtime.pendingHostKey, options)
      if (decision === 'trusted') {
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
          const trusted = await this.trustHost(connection.id, entry.fingerprint).catch((error) => {
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
            sshPort: Number(connection.sshPort) || 22,
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
    runtime.hostKeyCheckedAt = Date.now()
    runtime.pendingHostKey = undefined
    return true
  }

  async #startRuntimeInner(runtime, options) {
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
      const profile = runtime.profile || profileNameFor(runtime.connectionId)
      const local = runtime.connection.kind === 'local' || isLoopbackHost(runtime.connection.host)
      runtime.stage = 'shell'
      runtime.envShell = await this.#resolveShell(runtime.connection)
      const effectiveConnection = { ...runtime.connection, envShell: runtime.envShell }
      const secret = await this.readSecret(runtime.connectionId)
      const env = this.buildConnectionEnv(effectiveConnection, profile)
      const sshConfig = await this.#ensureSshConfig(runtime.connection, profile)
      if (sshConfig) env.VB_SSH_CONFIG = sshConfig
      env.VB_RUNTIME_PROFILE = profile
      env.VB_RUNTIME_LOCAL = local ? '1' : '0'
      env.VB_PLUGIN_DATA_DIR = this.dataDir
      env.VB_RUNTIME_TIMEOUT = String(runtime.connection.connectTimeoutSec ?? 120)
      env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
      if (secret?.daemonToken) env.VB_SCRIPT_DAEMON_TOKEN = secret.daemonToken
      runtime.state = 'connecting'
      runtime.stage = 'connect'
      runtime.error = undefined
      this.emit()
      const sidecar = new Sidecar({
        python: this.setup.venvPython,
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
          instancePort: runtime.connection.autoSessions ? runtime.connection.instancePort : undefined,
        },
        (Number(runtime.connection.connectTimeoutSec ?? 120) + 90) * 1000,
      )
      runtime.status = connectResult
      runtime.instance = connectResult?.instances?.selected ?? connectResult?.client?.instanceRecord ?? null
      runtime.daemonCompatibility = connectResult?.instances?.compatibility ?? null
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
        tunnelAlive: daemon.tunnel_process_alive,
      }
      runtime.lastHealthAt = Date.now()
      runtime.setupHint = connectResult?.state?.setup_path
        ? `load("${connectResult.state.setup_path}")`
        : undefined
      runtime.lastUsedAt = Date.now()
      runtime.stage = 'ready'
      if (responsive) {
        this.#log('info', `${runtime.connection.name} is ready`)
      } else {
        this.#log('warn', `${runtime.connection.name} tunnel is up but the Virtuoso daemon did not answer. ${runtime.setupHint ? `Run ${runtime.setupHint} in the CIW.` : 'Load the bridge setup in the CIW.'}`)
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
        at: Date.now(),
      }
      this.#log('error', `start of ${runtime.connection.name} failed (${runtime.errorDetail.stage}): ${runtime.error}`)
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
          const setupPath = status.state?.setup_path ?? status.instances?.setupPath
          if (setupPath) runtime.setupHint = `load("${setupPath}")`
        } catch {
          // The original connection error remains authoritative.
        }
      }
      runtime.state = 'error'
      if (/daemon identity|Bridge authentication failed|daemon did not answer|capability handshake/i.test(runtime.error ?? '')) {
        runtime.daemon = {
          state: 'auth-failed',
          checked: true,
          responsive: false,
          summary: 'the remote daemon did not answer the bridge capability handshake',
          checkedAt: Date.now(),
        }
      } else if (/daemon did not respond|no response from the daemon|tcp.*unreachable/i.test(runtime.error ?? '')) {
        runtime.daemon = {
          state: 'unreachable',
          checked: true,
          responsive: false,
          summary: 'the remote daemon did not respond',
          checkedAt: Date.now(),
        }
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
      if (runtime.sidecar) {
        await runtime.sidecar.stop({ stopTunnel: options.stopTunnel !== false, timeoutMs: 8_000 })
      } else if (options.stopTunnel !== false) {
        await this.stopOrphan(runtime.connectionId, { silent: true }).catch(() => {})
      }
      runtime.sidecar = undefined
      runtime.pid = undefined
      runtime.state = 'stopped'
      runtime.health = undefined
      runtime.status = undefined
      runtime.setupHint = undefined
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

  buildConnectionEnv(connection, profile) {
    const env = envForProfile(connection, profile)
    const settings = this.store.snapshot()
    if (settings.logToCiw) env.VB_LOG_TO_CIW = '1'
    return env
  }

  async #ensureSshConfig(connection, profile) {
    const configDir = path.join(this.dataDir, 'ssh')
    const configPath = path.join(configDir, `config-${profile || profileNameFor(connection.id)}`)
    const sshPort = Number(connection.sshPort) || 22
    if (!connection.identityFile && sshPort === 22) {
      await fsp.rm(configPath, { force: true }).catch(() => {})
      return undefined
    }
    await ensureDir(configDir)
    const userConfig = path.join(os.homedir(), '.ssh', 'config')
    const include = fileExistsSync(userConfig) ? `Include "${userConfig.replace(/\\/g, '/')}"\n` : ''
    const hosts = [
      connection.host,
      connection.daemonHost,
      connection.deployHost,
      connection.guiHost,
      connection.spectreHost,
    ].filter((value, index, all) => value && all.indexOf(value) === index)
    const lines = [include]
    for (const host of hosts) {
      lines.push(
        `Host ${host}\n`,
        `  Port ${sshPort}\n`,
        connection.identityFile ? `  IdentityFile "${connection.identityFile.replace(/\\/g, '/')}"\n` : '',
        connection.user ? `  User ${connection.user}\n` : '',
        connection.identityFile ? '  IdentitiesOnly yes\n' : '',
      )
    }
    await fsp.writeFile(configPath, lines.join(''), 'utf8')
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
      daemonCompatibility: runtime.daemonCompatibility ?? runtime.status?.instances?.compatibility ?? null,
      sshPort: runtime.connection.sshPort,
      sshBackend: runtime.connection.sshBackend,
      envShell: runtime.envShell || runtime.connection.envShell,
      profile: runtime.profile || profileNameFor(runtime.connectionId),
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
      error: runtime.error,
      errorDetail: runtime.errorDetail,
      pendingHostKey: runtime.pendingHostKey,
      hostKeyProbe: runtime.hostKeyProbe,
      setupHint: runtime.setupHint,
      package: runtime.status?.package,
      actions: [...runtime.actionIds].map((actionId) => this.actions.get(actionId)).filter(Boolean).map((action) => action.id),
      agents: [...runtime.agentUsage.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt),
      logTail: runtime.logTail.slice(-20),
    }
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
      try {
        const status = await runtime.sidecar.request('status', {}, 20_000)
        runtime.status = status
        if (status?.pid) runtime.pid = status.pid
        runtime.instance = status.instances?.selected ?? status.client?.instanceRecord ?? runtime.instance
        runtime.daemonCompatibility = status.instances?.compatibility ?? runtime.daemonCompatibility
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
          tunnelAlive: daemon.tunnel_process_alive,
        }
        runtime.setupHint = status.state?.setup_path ? `load("${status.state.setup_path}")` : runtime.setupHint
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

  // -- scripts ------------------------------------------------------------

  async runScript(options) {
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
      profile: runtime ? runtime.profile || profileNameFor(runtime.connectionId) : undefined,
      local: runtime ? runtime.connection.kind === 'local' || isLoopbackHost(runtime.connection.host) : false,
      timeoutSec: job.timeoutSec,
      logToCiw: settings.logToCiw,
      autoConnect: job.autoConnect,
      dataDir: this.dataDir,
      connection: runtime ? this.publicConnection(runtime.connection) : undefined,
    }
    await fsp.writeFile(job.contextPath, JSON.stringify(context, null, 2), 'utf8')
    const env = runtime ? this.buildConnectionEnv(runtime.connection, runtime.profile || profileNameFor(runtime.connectionId)) : { ...process.env }
    if (runtime) {
      const sshConfig = await this.#ensureSshConfig(runtime.connection, runtime.profile)
      if (sshConfig) env.VB_SSH_CONFIG = sshConfig
    }
    env.PYTHONUNBUFFERED = '1'
    env.PYTHONDONTWRITEBYTECODE = '1'
    env.VB_PLUGIN_DATA_DIR = this.dataDir
    env.VB_PLUGIN_CACHE_DIR = this.setup.cacheDir
    env.VB_SCRIPT_JOB_DIR = job.dir
    if (secret?.daemonToken) env.VB_SCRIPT_DAEMON_TOKEN = secret.daemonToken
    const action = this.startAction({
      kind: 'script.run',
      label: `Script ${job.id}`,
      runtimeId: runtime?.id,
      connectionId: runtime?.connectionId,
      agentId: options.agentId,
      meta: { jobId: job.id },
    })
    job.actionId = action.id
    this.jobs.set(job.id, job)
    this.#trimJobs()
    const child = (await import('node:child_process')).spawn(
      this.setup.venvPython,
      ['-u', path.join(this.pluginDir, 'runtime', 'vb_script.py'), job.dir],
      { cwd: job.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    )
    job.pid = child.pid
    const stdoutHandle = await fsp.open(job.stdoutPath, 'a')
    const stderrHandle = await fsp.open(job.stderrPath, 'a')
    child.stdout.on('data', (chunk) => {
      stdoutHandle.write(chunk).catch(() => {})
      job.outputTail = (job.outputTail + chunk.toString('utf8')).slice(-30_000)
    })
    child.stderr.on('data', (chunk) => {
      stderrHandle.write(chunk).catch(() => {})
      job.errorTail = (job.errorTail + chunk.toString('utf8')).slice(-30_000)
    })
    job.child = child
    job.killTimer = setTimeout(() => {
      if (job.state !== 'running') return
      job.timedOut = true
      this.#killJob(job, 'timeout')
    }, job.timeoutSec * 1000)
    job.killTimer.unref?.()
    job.settled = new Promise((resolve) => {
      child.on('close', async (code, signal) => {
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
        this.finishAction(action, job.state === 'succeeded' ? 'succeeded' : 'failed', job.error)
        this.#log(job.state === 'succeeded' ? 'info' : 'warn', `script ${job.id} ${job.state}`)
        this.emit()
        resolve(job)
      })
      child.on('error', (error) => {
        job.error = String(error)
        job.state = 'failed'
        job.finishedAt = Date.now()
        this.finishAction(action, 'failed', job.error)
        this.emit()
        resolve(job)
      })
    })
    const waitMs = clamp(Number(options.waitMs ?? 10_000), 0, 120_000)
    if (waitMs > 0) {
      await Promise.race([job.settled, delay(waitMs)])
    }
    this.#log('info', `script ${job.id} started in ${runtime ? runtime.connection.name : 'the plugin venv'}`)
    this.emit()
    return this.snapshotJob(job)
  }

  snapshotJob(job) {
    return {
      id: job.id,
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
    if (!job.pid) {
      job.state = reason === 'timeout' ? 'timeout' : 'cancelled'
      return
    }
    this.#log('warn', `killing script ${job.id} (${reason})`)
    killTree(job.pid)
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
      const profile = profileNameFor(connection.id)
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
    this.orphans = found
    return found
  }

  async stopOrphan(ref, options = {}) {
    const connection = this.store.connection(ref)
    if (!connection) throw new Error(`unknown connection ${ref}`)
    const profile = profileNameFor(connection.id)
    const probe = await this.setup.probeVenv()
    if (!probe.ok) throw new Error(`the plugin venv is not ready: ${probe.reason}`)
    const env = this.buildConnectionEnv(connection, profile)
    env.PYTHONUNBUFFERED = '1'
    const result = await runProcess(
      this.setup.venvPython,
      [path.join(this.pluginDir, 'runtime', 'vb_stop_profile.py'), '--profile', profile],
      { env, timeoutMs: 60_000, maxOutput: 40_000 },
    )
    const detail = result.stdout.trim() || result.stderr.trim()
    if (!result.ok) {
      if (!options.silent) throw new Error(`could not stop the tunnel: ${detail}`)
    } else if (!options.silent) {
      this.#log('info', `orphan tunnel for ${connection.name} stopped: ${detail}`)
    }
    this.orphans = await this.scanOrphans()
    this.emit()
    return { ok: result.ok, detail, profile }
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
      venvReady: Boolean(setup.venv?.exists && setup.venv?.package),
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
      daemonCompatibility: runtime.daemonCompatibility,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      lastUsedAt: runtime.lastUsedAt,
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
            sshPort: pending.sshPort,
            message: pending.message,
            unknown: (pending.unknown ?? []).map((entry) => ({ type: entry.type, fingerprint: entry.fingerprint })),
            conflicts: (pending.conflicts ?? []).map((conflict) => ({
              incoming: { type: conflict.incoming?.type, fingerprint: conflict.incoming?.fingerprint },
              existing: (conflict.existing ?? []).map((entry) => entry.fingerprint),
            })),
          }
        : undefined,
      agents: (runtime.agents ?? []).map((agent) => ({ sessionId: agent.sessionId, calls: agent.calls, lastUsedAt: agent.lastUsedAt })),
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
    const agents = [...this.agentUsage.values()]
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .slice(0, 30)
      .map((usage) => ({ ...usage, live: liveAgents.has(String(usage.sessionId)) }))
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
        cacheDir: settings.cacheDir,
        installSshExtra: settings.installSshExtra,
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
        return this.testConnection(this.connectionRef(data.connection ?? data.id), { agentId })
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
