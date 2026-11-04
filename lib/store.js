/** Durable plugin settings: source selection, runtime defaults and connections. */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { defaultDaemonPort, id as newId, ensureDir, isLoopbackHost, readJson, writeJson } from './util.js'

export const DEFAULT_REPO_URL = 'https://github.com/Arcadia-1/virtuoso-bridge-lite.git'

export function defaultSettings() {
  return {
    version: 1,
    source: {
      mode: 'bundled',
      localRepoPath: '',
      repoUrl: DEFAULT_REPO_URL,
      gitRef: 'main',
    },
    pythonPath: 'python',
    autoInstall: false,
    autoStart: [],
    defaultConnection: '',
    logToCiw: false,
    maxScripts: 4,
    cacheDir: '',
    installSshExtra: true,
    connections: [],
  }
}

export function normalizeSource(input) {
  const source = { ...defaultSettings().source, ...(input ?? {}) }
  const mode = ['bundled', 'local', 'git'].includes(source.mode) ? source.mode : 'bundled'
  return {
    mode,
    localRepoPath: String(source.localRepoPath ?? '').trim(),
    repoUrl: String(source.repoUrl ?? '').trim() || DEFAULT_REPO_URL,
    gitRef: String(source.gitRef ?? '').trim() || 'main',
  }
}

export function normalizeConnection(input, existing) {
  const host = String(input.host ?? '').trim()
  const name = String(input.name ?? '').trim() || host || 'connection'
  const user = String(input.user ?? '').trim()
  const kind = input.kind === 'local' || input.kind === 'remote'
    ? input.kind
    : isLoopbackHost(host) ? 'local' : 'remote'
  const effectiveKind = kind === 'local' && !isLoopbackHost(host) ? 'remote' : kind
  const autoSessions = input.autoSessions === true || input.autoSessions === 'true'
  const port = Number.parseInt(input.port, 10)
  const instancePort = Number.parseInt(input.instancePort, 10)
  const sshPort = Number.parseInt(input.sshPort, 10)
  const sshMaxSessions = Number.parseInt(input.sshMaxSessions, 10)
  const localPort = input.localPort === '' || input.localPort === undefined || input.localPort === null
    ? undefined
    : Number.parseInt(input.localPort, 10)
  const envShell = input.envShell === 'sh' || input.envShell === 'csh' ? input.envShell : 'auto'
  const remoteWorkDir = String(input.remoteWorkDir ?? '').trim()
  const daemonSetup = String(input.daemonSetup ?? '').trim()
  const remoteScratchRoot = String(input.remoteScratchRoot ?? '').trim()
  const subInstances = normalizeSubInstances(input.subInstances, existing?.subInstances)
  if (autoSessions && remoteWorkDir && !remoteWorkDir.startsWith('/')) {
    throw new Error('remoteWorkDir must be an absolute remote path')
  }
  const connection = {
    id: existing?.id ?? input.id ?? newId('conn_'),
    name,
    kind: effectiveKind,
    host,
    user,
    autoSessions,
    // Fixed legacy daemon endpoint. Empty means the bridge derives the
    // per-user default in fixed mode; automatic sessions leave it unset.
    port: autoSessions ? undefined : (Number.isFinite(port) && port > 0 ? port : defaultDaemonPort(user)),
    instancePort: Number.isFinite(instancePort) && instancePort > 0 ? instancePort : undefined,
    sshPort: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : 22,
    sshMaxSessions: Number.isFinite(sshMaxSessions) && sshMaxSessions > 0 ? sshMaxSessions : undefined,
    localPort: Number.isFinite(localPort) && localPort > 0 ? localPort : undefined,
    jumpHost: String(input.jumpHost ?? '').trim(),
    jumpUser: String(input.jumpUser ?? '').trim(),
    sshBackend: input.sshBackend === 'paramiko' ? 'paramiko' : 'openssh',
    sshProxy: String(input.sshProxy ?? '').trim(),
    daemonHost: String(input.daemonHost ?? '').trim(),
    deployHost: String(input.deployHost ?? '').trim(),
    guiHost: String(input.guiHost ?? '').trim(),
    spectreHost: String(input.spectreHost ?? '').trim(),
    remoteWorkDir,
    daemonSetup,
    remoteScratchRoot,
    subInstances,
    clientId: String(input.clientId ?? '').trim(),
    envShell,
    cadenceEnvScript: String(input.cadenceEnvScript ?? input.envScript ?? '').trim(),
    detectedShell: ['csh', 'sh'].includes(input.detectedShell) ? input.detectedShell : undefined,
    detectedAt: Number.isFinite(Number(input.detectedAt)) ? Number(input.detectedAt) : undefined,
    detectedScript: String(input.detectedScript ?? '').trim() || undefined,
    identityFile: String(input.identityFile ?? '').trim(),
    extraEnv: normalizeEnv(input.extraEnv),
    notes: String(input.notes ?? '').trim().slice(0, 2000),
    enabled: input.enabled !== false,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  if (!connection.host) throw new Error('host is required')
  if (connection.port !== undefined && (connection.port < 1 || connection.port > 65535)) {
    throw new Error('port must be between 1 and 65535')
  }
  if (connection.instancePort !== undefined && (connection.instancePort < 1 || connection.instancePort > 65535)) {
    throw new Error('instancePort must be between 1 and 65535')
  }
  if (connection.sshPort < 1 || connection.sshPort > 65535) throw new Error('sshPort must be between 1 and 65535')
  if (connection.localPort !== undefined && (connection.localPort < 1 || connection.localPort > 65535)) {
    throw new Error('localPort must be between 1 and 65535')
  }
  return connection
}

function normalizeSubInstances(value, existing) {
  if (!Array.isArray(value)) return []
  const existingById = new Map((existing ?? []).map((item) => [item.id, item]))
  const seenWorkDirs = new Set()
  const output = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const workDir = String(item.workDir ?? item.workdir ?? '').trim()
    if (!workDir) throw new Error('sub-instance workDir is required')
    if (!workDir.startsWith('/')) throw new Error('sub-instance workDir must be an absolute remote path')
    if (seenWorkDirs.has(workDir)) throw new Error(`duplicate sub-instance workDir ${workDir}`)
    seenWorkDirs.add(workDir)
    const leaf = workDir.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) || 'workdir'
    const id = String(item.id ?? '').trim() || newId('sub_')
    const previous = existingById.get(id)
    const instancePort = Number.parseInt(item.instancePort, 10)
    output.push({
      id,
      name: String(item.name ?? previous?.name ?? leaf).trim() || leaf,
      workDir,
      autoSessions: true,
      instancePort: Number.isFinite(instancePort) && instancePort > 0 ? instancePort : undefined,
      enabled: item.enabled !== false,
    })
  }
  return output
}

function normalizeEnv(value) {
  if (!value || typeof value !== 'object') return {}
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (item === undefined || item === null) continue
    const text = String(item)
    if (text.length > 4000) continue
    output[key] = text
  }
  return output
}

export function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const output = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'connections') {
      output.connections = Array.isArray(value) ? value.map((item) => ({ ...item })) : []
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(output[key] ?? {}, value)
    } else {
      output[key] = value
    }
  }
  return output
}

export class SettingsStore {
  constructor({ dataDir, baseConfig }) {
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'settings.json')
    this.baseConfig = baseConfig ?? {}
    this.data = defaultSettings()
    this.listeners = new Set()
  }

  async load() {
    await ensureDir(this.dataDir)
    const persisted = await readJson(this.file, undefined)
    let data = deepMerge(defaultSettings(), sanitizeConfig(this.baseConfig))
    if (persisted) data = deepMerge(data, persisted)
    data.source = normalizeSource(data.source)
    data.connections = Array.isArray(data.connections)
      ? data.connections.filter((item) => item && item.host).map((item) => normalizeConnection(item, item))
      : []
    data.autoStart = Array.isArray(data.autoStart) ? data.autoStart.filter((item) => typeof item === 'string') : []
    data.pythonPath = String(data.pythonPath ?? 'python').trim() || 'python'
    data.autoInstall = Boolean(data.autoInstall)
    data.logToCiw = Boolean(data.logToCiw)
    data.installSshExtra = data.installSshExtra !== false
    data.cacheDir = String(data.cacheDir ?? '').trim()
    data.maxScripts = Math.max(1, Math.min(32, Number(data.maxScripts) || 4))
    this.data = data
    if (!persisted) await this.save()
    return this.snapshot()
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data))
  }

  connection(ref) {
    if (!ref) return undefined
    const text = String(ref)
    return (
      this.data.connections.find((item) => item.id === text) ??
      this.data.connections.find((item) => item.name === text) ??
      this.data.connections.find((item) => item.name.toLowerCase() === text.toLowerCase())
    )
  }

  async save() {
    await writeJson(this.file, this.data)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener failure must not break persistence.
      }
    }
    return this.snapshot()
  }

  async update(patch) {
    this.data = deepMerge(this.data, patch ?? {})
    this.data.source = normalizeSource(this.data.source)
    this.data.autoStart = Array.isArray(this.data.autoStart) ? this.data.autoStart : []
    this.data.installSshExtra = this.data.installSshExtra !== false
    this.data.cacheDir = String(this.data.cacheDir ?? '').trim()
    this.data.maxScripts = Math.max(1, Math.min(32, Number(this.data.maxScripts) || 4))
    await this.save()
    return this.snapshot()
  }

  async upsertConnection(input) {
    const existing = this.connection(input.id)
    const connection = normalizeConnection(input, existing)
    if (existing) {
      this.data.connections = this.data.connections.map((item) => (item.id === existing.id ? connection : item))
    } else {
      this.data.connections.push(connection)
    }
    if (!this.data.defaultConnection) this.data.defaultConnection = connection.id
    await this.save()
    return connection
  }

  async removeConnection(ref) {
    const existing = this.connection(ref)
    if (!existing) return false
    this.data.connections = this.data.connections.filter((item) => item.id !== existing.id)
    this.data.autoStart = this.data.autoStart.filter((item) => item !== existing.id)
    if (this.data.defaultConnection === existing.id) {
      this.data.defaultConnection = this.data.connections[0]?.id ?? ''
    }
    await this.save()
    return true
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function sanitizeConfig(value) {
  if (!value || typeof value !== 'object') return {}
  const output = {}
  for (const key of ['source', 'pythonPath', 'autoInstall', 'autoStart', 'defaultConnection', 'logToCiw', 'maxScripts', 'cacheDir', 'installSshExtra']) {
    if (value[key] !== undefined) output[key] = value[key]
  }
  return output
}
