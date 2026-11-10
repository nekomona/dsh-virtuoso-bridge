/** Small, dependency-free helpers shared by the Host half. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const isWindows = process.platform === 'win32'

export function id(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

/**
 * The bridge's stable per-user daemon port (SHA-1 of the SSH user, 65000-65499).
 * Mirrors virtuoso_bridge.virtuoso.basic.bridge._default_remote_port.
 */
export function defaultDaemonPort(user) {
  const name = String(user ?? '').trim()
  if (!name) return 65432
  const digest = createHash('sha1').update(name, 'utf8').digest('hex')
  return 65000 + (Number.parseInt(digest.slice(0, 8), 16) % 500)
}

export function sshTarget(connection) {
  const host = String(connection.host ?? '').trim()
  const user = String(connection.user ?? '').trim()
  return user ? `${user}@${host}` : host
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function nowSeconds() {
  return Date.now() / 1000
}

export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJson(file, value, options = {}) {
  await ensureDir(path.dirname(file))
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  if (options.mode) await fsp.chmod(temporary, options.mode).catch(() => {})
  await fsp.rename(temporary, file)
}

export async function readTail(file, maxBytes = 16_000) {
  try {
    const stat = await fsp.stat(file)
    const start = Math.max(0, stat.size - maxBytes)
    const handle = await fsp.open(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size))
      await handle.read(buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

export function fileExistsSync(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function dirExistsSync(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walk a directory and return its total size. Deliberately bounded: a huge
 * venv must not freeze the state endpoint.
 */
export async function directoryUsage(dir, options = {}) {
  const maxFiles = options.maxFiles ?? 40_000
  const deadline = Date.now() + (options.timeoutMs ?? 4_000)
  const result = { path: dir, bytes: 0, files: 0, dirs: 0, truncated: false }
  if (!dirExistsSync(dir)) return result
  const stack = [dir]
  while (stack.length) {
    if (Date.now() > deadline || result.files >= maxFiles) {
      result.truncated = true
      break
    }
    const current = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        result.dirs += 1
        stack.push(target)
      } else if (entry.isFile()) {
        result.files += 1
        try {
          result.bytes += (await fsp.stat(target)).size
        } catch {
          // A file disappeared while walking; ignore it.
        }
        if (result.files >= maxFiles || Date.now() > deadline) {
          result.truncated = true
          break
        }
      }
    }
  }
  return result
}

export async function freeDisk(dir) {
  try {
    const stats = await fsp.statfs(dir)
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize }
  } catch {
    return undefined
  }
}

/** Run a process to completion, collecting bounded output. */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? 30_000
    const maxOutput = options.maxOutput ?? 200_000
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
    } catch (error) {
      resolve({ ok: false, code: null, stdout, stderr: String(error), error: String(error), timedOut: false, durationMs: 0 })
      return
    }
    const started = Date.now()
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ durationMs: Date.now() - started, timedOut, stdout, stderr, ...payload })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdout = (stdout + text).slice(-maxOutput)
      options.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stderr = (stderr + text).slice(-maxOutput)
      options.onStderr?.(text)
    })
    child.on('error', (error) => finish({ ok: false, code: null, error: String(error) }))
    child.on('close', (code, signal) => finish({ ok: code === 0 && !timedOut, code, signal }))
    if (options.signal) {
      const abort = () => {
        timedOut = false
        killTree(child.pid)
      }
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
    }
  })
}

/** Start a detached child and keep line-oriented stdout parsing in the caller. */
export function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  })
  return child
}

/** Kill a process tree; safe to call with a dead pid. */
export function killTree(pid) {
  if (!pid) return
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // ignore
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }
}

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

/** Locate an executable on PATH (or pass through an absolute path). */
export async function findExecutable(name, env = process.env) {
  if (!name) return undefined
  if (path.isAbsolute(name) || name.includes(path.sep)) {
    try {
      await fsp.access(name, fs.constants.X_OK)
      return name
    } catch {
      return undefined
    }
  }
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions = isWindows ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = path.join(dir, isWindows && !name.toLowerCase().endsWith(extension.toLowerCase()) ? name + extension : name)
      try {
        await fsp.access(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // continue
      }
    }
  }
  return undefined
}

export async function probePython(candidate, env = process.env) {
  const executable = await findExecutable(candidate, env)
  if (!executable) return undefined
  const result = await runProcess(executable, ['--version'], { env, timeoutMs: 8_000 })
  const text = `${result.stdout}${result.stderr}`.trim()
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/i.exec(text)
  return {
    command: candidate,
    executable,
    version: match ? `${match[1]}.${match[2]}.${match[3]}` : text,
    major: match ? Number(match[1]) : 0,
    minor: match ? Number(match[2]) : 0,
    ok: result.ok && match !== null,
    detail: text,
  }
}

export function sanitizeId(value, fallback = 'item') {
  const text = String(value ?? '').trim().toLowerCase()
  const cleaned = text.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

export function profileNameFor(connectionId) {
  return `dsh_${sanitizeId(connectionId, 'connection').replace(/-/g, '_')}`
}

export function isLoopbackHost(host) {
  const text = String(host ?? '').trim().toLowerCase()
  return (
    text === 'localhost' ||
    text === '127.0.0.1' ||
    text === '::1' ||
    text === '[::1]' ||
    text.endsWith('.localhost')
  )
}

export function truncate(text, limit = 4_000) {
  const value = typeof text === 'string' ? text : JSON.stringify(text)
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n... (${value.length - limit} more chars)`
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (/token|password|passphrase|secret|key/i.test(key) && typeof item === 'string') {
        output[key] = item ? '<hidden>' : ''
      } else {
        output[key] = redact(item)
      }
    }
    return output
  }
  return value
}

export function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return 0
  }
}

/**
 * Environment variables that must never leak from the DSH host into a bridge
 * helper process.
 *
 * A second virtuoso-bridge installation commonly lives next to the plugin
 * (`~/virtuoso-bridge`, an activated virtualenv, or `~/.virtuoso-bridge/.env`).
 * Its exported values would otherwise select another package, another known
 * hosts file, another state directory, or another remote scratch root, and the
 * plugin's saved connection would no longer be authoritative. `-E -s` on the
 * helper interpreter covers the interpreter side; this list covers the
 * variables the Python client reads itself.
 */
const FOREIGN_CHILD_ENV = new Set([
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PYTHONSAFEPATH',
  'PYTHONEXECUTABLE',
  'PYTHONCASEOK',
  'VIRTUAL_ENV',
  'VIRTUAL_ENV_PROMPT',
  'VIRTUAL_ENV_DISABLE_PROMPT',
  'VB_PROFILE',
  'VB_FORCE_VENDOR_SRC',
  'VB_ENV_FILE',
  'VB_HOME',
  'VB_STATE_DIR',
  'VB_CACHE_DIR',
  'VB_CONFIG_DIR',
  'VB_TMP_DIR',
  'VB_OUTPUT_DIR',
  'VB_LOG_DIR',
])

/** A child-process environment the plugin fully owns. */
export function bridgeChildEnv(base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value === undefined) continue
    if (FOREIGN_CHILD_ENV.has(key)) continue
    // Every upstream VB_* variable is owned by this plugin. An ambient value
    // (for example VB_CLIENT_ID, VB_SSH_BACKEND or VB_REMOTE_SCRATCH_ROOT from
    // another installation) must not override the selected connection; the
    // plugin re-adds exactly the variables it derives from that connection.
    if (/^VB_/i.test(key)) continue
    env[key] = value
  }
  return env
}

/** True when `candidate` is `root` or lives strictly below it. */
export function isPathInside(candidate, root) {
  if (!candidate || !root) return false
  const normalize = (value) => {
    const resolved = path.resolve(String(value))
    return isWindows ? resolved.toLowerCase() : resolved
  }
  const target = normalize(candidate)
  const base = normalize(root)
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`)
}

export function envForProfile(connection, profile) {
  // Never inherit the ambient environment: another bridge installation can set
  // PYTHONPATH/PYTHONHOME, an activated virtualenv, or upstream VB_* values.
  const env = bridgeChildEnv()
  const local = isLoopbackHost(connection.host)
  const suffix = `_${profile}`
  const host = connection.host
  const user = connection.user || undefined
  const autoSessions = Boolean(connection.autoSessions)
  const daemonHost = connection.daemonHost || host
  const guiHost = connection.guiHost || host
  const deployHost = connection.deployHost || guiHost
  const set = (key, value) => {
    const name = `${key}${suffix}`
    if (value === undefined || value === null || value === '') {
      delete env[name]
      return
    }
    env[name] = String(value)
  }
  set('VB_REMOTE_HOST', host)
  set('VB_DAEMON_HOST', daemonHost)
  set('VB_GUI_HOST', guiHost)
  set('VB_DEPLOY_HOST', deployHost)
  set('VB_SPECTRE_HOST', connection.spectreHost || daemonHost)
  set('VB_REMOTE_USER', user)
  set('VB_AUTO_SESSIONS', autoSessions ? '1' : '0')
  set('VB_REMOTE_PORT', autoSessions ? '' : connection.port)
  set('VB_REMOTE_WORK_DIR', connection.remoteWorkDir || '')
  set('VB_DAEMON_SETUP', connection.daemonSetup || '')
  set('VB_REMOTE_SCRATCH_ROOT', connection.remoteScratchRoot || '')
  set('VB_CLIENT_ID', connection.clientId || '')
  set('VB_LOCAL_PORT', connection.localPort || '')
  set('VB_JUMP_HOST', connection.jumpHost || '')
  set('VB_JUMP_USER', connection.jumpUser || '')
  set('VB_SSH_BACKEND', connection.sshBackend || '')
  set('VB_SSH_PROXY', connection.sshProxy || '')
  set('VB_SSH_MAX_SESSIONS', connection.sshMaxSessions || '')
  set('VB_CADENCE_ENV_SHELL', connection.envShell && connection.envShell !== 'auto' ? connection.envShell : '')
  set('VB_CADENCE_CSHRC', connection.cadenceEnvScript || '')
  if (local) env[`VB_DAEMON_HOST${suffix}`] = 'localhost'
  for (const [key, value] of Object.entries(connection.extraEnv ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[`${key}${suffix}`] = String(value)
  }
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONDONTWRITEBYTECODE = '1'
  return env
}
