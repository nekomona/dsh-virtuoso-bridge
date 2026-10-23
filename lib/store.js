/** Durable plugin settings: source selection, runtime defaults and connections. */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { id as newId, ensureDir, isLoopbackHost, readJson, sanitizeId, writeJson } from './util.js'

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
  const kind = input.kind === 'local' || input.kind === 'remote'
    ? input.kind
    : isLoopbackHost(host) ? 'local' : 'remote'
  const effectiveKind = kind === 'local' && !isLoopbackHost(host) ? 'remote' : kind
  const port = Number.parseInt(input.port, 10)
  const localPort = input.localPort === '' || input.localPort === undefined || input.localPort === null
    ? undefined
    : Number.parseInt(input.localPort, 10)
  const connection = {
    id: existing?.id ?? input.id ?? newId('conn_'),
    name,
    kind: effectiveKind,
    host,
    user: String(input.user ?? '').trim(),
    port: Number.isFinite(port) && port > 0 ? port : 65432,
    localPort: Number.isFinite(localPort) && localPort > 0 ? localPort : undefined,
    jumpHost: String(input.jumpHost ?? '').trim(),
    jumpUser: String(input.jumpUser ?? '').trim(),
    sshBackend: input.sshBackend === 'paramiko' ? 'paramiko' : 'openssh',
    spectreHost: String(input.spectreHost ?? '').trim(),
    envShell: input.envShell === 'sh' ? 'sh' : 'csh',
    identityFile: String(input.identityFile ?? '').trim(),
    extraEnv: normalizeEnv(input.extraEnv),
    notes: String(input.notes ?? '').trim().slice(0, 2000),
    enabled: input.enabled !== false,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  if (!connection.host) throw new Error('host is required')
  if (connection.port < 1 || connection.port > 65535) throw new Error('port must be between 1 and 65535')
  if (connection.localPort !== undefined && (connection.localPort < 1 || connection.localPort > 65535)) {
    throw new Error('localPort must be between 1 and 65535')
  }
  return connection
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
  for (const key of ['source', 'pythonPath', 'autoInstall', 'autoStart', 'defaultConnection', 'logToCiw', 'maxScripts']) {
    if (value[key] !== undefined) output[key] = value[key]
  }
  return output
}
