/**
 * Plugin-owned SSH port-forward tunnel.
 *
 * The bridge needs a long-lived `ssh -N -L` forward for every remote runtime.
 * Starting that process inside the Python sidecar has two drawbacks:
 *
 *  - it is deliberately detached ("free-running"), so nothing in the plugin
 *    owns its lifetime and status can only be inferred by dialling the forward
 *    port;
 *  - its diagnostics live in the sidecar, so a failed or dropped tunnel is
 *    reported late and imprecisely.
 *
 * This module makes the Host plugin the owner instead.  `SshTunnel` spawns the
 * OpenSSH client as a hidden child process, decides readiness from OpenSSH's
 * own verbose log instead of connecting to the forward port, and reports every
 * state change from child-process events.  The Python sidecar then adopts that
 * forward (see runtime/vb_plugin_env.py) and never starts a second tunnel.
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { bridgeChildEnv, killTree } from './util.js'

/** Bound stderr kept for diagnostics; OpenSSH's `-v` log is chatty. */
const STDERR_TAIL_LIMIT = 12_000

/** OpenSSH prints this once authentication succeeded and `-N` is running. */
const SESSION_READY = /Entering interactive session/i
/** Printed when the local `-L` listener is bound, before authentication. */
const LISTENER_READY = /Local forwarding listening on/i

const FAILURE_HINTS = [
  [/permission denied/i, 'SSH authentication failed (permission denied)'],
  [/host key verification failed|remote host identification has changed|no matching host key/i, 'SSH host-key verification failed'],
  [/could not resolve hostname|name or service not known/i, 'the SSH host name could not be resolved'],
  [/address already in use|cannot listen/i, 'the local tunnel port is already in use'],
  [/connection refused/i, 'the SSH connection was refused'],
  [/connection timed out|operation timed out|connect timeout/i, 'the SSH connection timed out'],
  [/connection closed by|connection reset by peer/i, 'the SSH server closed the connection'],
]

/** Turn the tail of OpenSSH's error output into one actionable sentence. */
export function classifyTunnelFailure(stderr) {
  const text = String(stderr ?? '')
  for (const [pattern, message] of FAILURE_HINTS) {
    if (pattern.test(text)) return message
  }
  return undefined
}

/** Last meaningful line of an OpenSSH log, for a short error message. */
export function lastTunnelLine(stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^debug\d:/i.test(lines[index])) continue
    return lines[index]
  }
  return lines.at(-1) ?? ''
}

/**
 * A free localhost port, allocated by binding to port 0 and releasing it.
 *
 * Choosing a port this way never dials the tunnel endpoint, and an OS-assigned
 * port cannot collide with another running runtime.  OpenSSH binds both the
 * IPv6 and IPv4 loopback for `-L`, so a candidate is only accepted when both
 * families are free.
 */
export async function pickLocalPort(host = '127.0.0.1') {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await allocateEphemeralPort(host)
    if (await tunnelPortUsable(port)) return port
  }
  throw new Error('could not allocate a free local tunnel port')
}

function allocateEphemeralPort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (error) => {
      server.close(() => {})
      reject(error)
    })
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('could not allocate a local tunnel port'))
      })
    })
  })
}

/**
 * Bind one localhost family and report the result.
 *
 * `unsupported` distinguishes "no IPv6 stack/address on this host" from
 * "another process owns the port", so port selection does not fail on hosts
 * without IPv6.
 */
export function probeBind(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (error) => {
      const code = error?.code ?? ''
      resolve({ ok: false, code, unsupported: ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(code) })
    })
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve({ ok: true, code: '' }))
    })
  })
}

/** Whether this host/port can be bound right now (a local bind test only). */
export async function canBind(port, host = '127.0.0.1') {
  return (await probeBind(port, host)).ok
}

/** Whether `ssh -L` can bind this port on both loopback families. */
export async function tunnelPortUsable(port) {
  const v4 = await probeBind(port, '127.0.0.1')
  if (!v4.ok) return false
  const v6 = await probeBind(port, '::1')
  return v6.ok || v6.unsupported
}

/**
 * The OpenSSH command line for the tunnel.
 *
 * Mirrors `virtuoso_bridge.transport.ssh.SSHRunner.start_port_forward` so the
 * forward behaves exactly as the upstream-managed tunnel did (generated SSH
 * config, pinned host-key algorithms, jump host, identity file, batch mode).
 * `-v` is added only so readiness and failure can be read from OpenSSH itself;
 * `-N` keeps it a pure forward with no shell.
 */
export function buildTunnelArgs({
  sshExecutable = 'ssh',
  connection,
  sshConfigPath,
  localPort,
  remotePort,
  host,
  user,
  jumpHost,
  jumpUser,
  connectTimeoutSec = 20,
  verbose = true,
}) {
  const targetHost = String(host ?? connection?.daemonHost ?? connection?.host ?? '').trim()
  if (!targetHost) throw new Error('the connection has no SSH host')
  const targetUser = String(user ?? connection?.user ?? '').trim()
  const jump = String(jumpHost ?? connection?.jumpHost ?? '').trim()
  const jumpUserValue = String(jumpUser ?? connection?.jumpUser ?? '').trim()
  const timeout = Math.max(5, Number(connectTimeoutSec) || 20)
  const args = []
  if (verbose) args.push('-v')
  args.push(
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeout}`,
    '-o', 'GSSAPIAuthentication=no',
    '-o', 'HostbasedAuthentication=no',
    // A long-lived forward must own its own connection: attaching it to a
    // command-session ControlMaster makes the local listener disappear when
    // that master is retired.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ControlPersist=no',
    '-o', 'ExitOnForwardFailure=yes',
    // Lets the child report a dead server by exiting, so the Host learns about
    // a broken tunnel from the process itself instead of dialling its port.
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  )
  if (sshConfigPath) args.push('-F', sshConfigPath)
  if (connection?.identityFile) args.push('-i', connection.identityFile)
  if (jump) args.push('-J', jumpUserValue ? `${jumpUserValue}@${jump}` : jump)
  args.push('-N', '-L', `${localPort}:127.0.0.1:${remotePort}`)
  args.push(targetUser ? `${targetUser}@${targetHost}` : targetHost)
  return { command: sshExecutable, args, host: targetHost, user: targetUser || undefined }
}

export class SshTunnel extends EventEmitter {
  constructor({ command = 'ssh', args = [], env, cwd, label = 'ssh tunnel', log, logStderr = false }) {
    super()
    this.command = command
    this.args = args
    this.env = env ?? bridgeChildEnv()
    this.cwd = cwd
    this.label = label
    this.log = log
    this.logStderr = logStderr
    this.child = undefined
    this.pid = undefined
    this.state = 'idle'
    this.localPort = undefined
    this.remotePort = undefined
    this.startedAt = undefined
    this.readyAt = undefined
    this.exitInfo = undefined
    this.lastError = undefined
    this.stderr = ''
    this.listenerSeen = false
    this.expectedStop = false
    this.readyPromise = undefined
  }

  get alive() {
    return this.state === 'up' && this.exitInfo === undefined
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.pid,
      localPort: this.localPort,
      remotePort: this.remotePort,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      alive: this.alive,
      exitCode: this.exitInfo?.code ?? null,
      exitSignal: this.exitInfo?.signal ?? null,
      lastError: this.lastError,
      stderrTail: this.stderr.slice(-2_000),
    }
  }

  /**
   * Spawn the forward and wait until OpenSSH reports the session established.
   *
   * Resolves with this tunnel once the local forward exists; rejects with a
   * classified error (plus `stderrTail`) when OpenSSH exits first, the spawn
   * fails, or the readiness budget expires.
   */
  async start({ timeoutMs = 60_000, localPort, remotePort } = {}) {
    if (this.child) throw new Error('tunnel already started')
    if (localPort) this.localPort = Number(localPort)
    if (remotePort) this.remotePort = Number(remotePort)
    this.state = 'starting'
    this.startedAt = Date.now()
    this.exitInfo = undefined
    this.lastError = undefined
    this.expectedStop = false
    this.readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
    let child
    try {
      child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        // Hidden console: this is the process that used to pop a window.
        windowsHide: true,
        // Not detached: the Host plugin owns the lifetime, and the child must
        // not outlive it as a free-running process.
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
      })
    } catch (error) {
      this.state = 'down'
      this.lastError = `could not start ${this.command}: ${error.message}`
      throw Object.assign(new Error(this.lastError), { stderrTail: '' })
    }
    this.child = child
    this.pid = child.pid
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => this.#onStderr(chunk))
    child.once('error', (error) => this.#onSpawnError(error))
    child.once('exit', (code, signal) => this.#onExit(code, signal))
    const timer = setTimeout(() => {
      this.lastError = this.lastError ?? `the SSH tunnel did not become ready within ${Math.round(timeoutMs / 1000)}s`
      this.#rejectReady(Object.assign(new Error(this.lastError), { code: 'TUNNEL_TIMEOUT', stderrTail: this.stderr.slice(-4_000) }))
      this.stop().catch(() => {})
    }, Math.max(5_000, Number(timeoutMs) || 60_000))
    timer.unref?.()
    try {
      await this.readyPromise
    } finally {
      clearTimeout(timer)
      this._resolveReady = undefined
      this._rejectReady = undefined
    }
    if (this.exitInfo || child.exitCode !== null) {
      // The child exited in the instant between "ready" and this line.
      throw Object.assign(new Error(this.lastError ?? 'the SSH tunnel exited during startup'), {
        code: 'TUNNEL_EXITED',
        stderrTail: this.stderr.slice(-4_000),
      })
    }
    this.state = 'up'
    this.readyAt = Date.now()
    this.log?.('info', `${this.label}: localhost:${this.localPort} -> remote 127.0.0.1:${this.remotePort} (pid ${this.pid})`)
    return this
  }

  /** Stop the forward; resolves after the child is gone or the budget expires. */
  async stop({ timeoutMs = 5_000 } = {}) {
    const child = this.child
    if (!child) {
      if (['up', 'starting'].includes(this.state)) this.state = 'down'
      return
    }
    if (this.state === 'stopping') return
    this.expectedStop = true
    this.state = 'stopping'
    try {
      child.kill()
    } catch {
      // fall through to the tree kill below
    }
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(500, Number(timeoutMs) || 5_000))
        timer.unref?.()
      }),
    ])
    if (!exited) {
      // ssh spawned no children in normal operation, but make sure a stuck
      // Windows child cannot keep the local port bound.
      killTree(this.pid)
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
    this.#forget()
  }

  #forget() {
    this.child = undefined
    this.pid = undefined
    this.state = 'down'
  }

  #onStderr(chunk) {
    const text = String(chunk ?? '')
    this.stderr = (this.stderr + text).slice(-STDERR_TAIL_LIMIT)
    if (text.includes('Local forwarding listening')) this.listenerSeen = true
    if (this.logStderr) {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.log?.('debug', `${this.label}: ${line.trim()}`)
      }
    }
    if (this.state === 'starting' && SESSION_READY.test(text)) {
      this.#resolveReady(this)
      return
    }
    if (this.state === 'starting' && /^debug1: Authenticated to /m.test(text)) {
      // Some builds finish the session setup silently after this line; treat
      // an authenticated connection with a bound listener as ready.
      if (this.listenerSeen) this.#resolveReady(this)
    }
  }

  #onSpawnError(error) {
    if (this.state === 'starting' && this._rejectReady) {
      this.lastError = `could not start ${this.command}: ${error.message}`
      this.#rejectReady(Object.assign(new Error(this.lastError), { stderrTail: this.stderr.slice(-4_000) }))
      return
    }
    this.lastError = error.message
    this.state = 'down'
    this.#forget()
    this.emit('exit', this.snapshot())
  }

  #onExit(code, signal) {
    this.exitInfo = { code, signal }
    const wasStarting = this.state === 'starting'
    const expected = this.expectedStop
    this.state = 'down'
    const hint = classifyTunnelFailure(this.stderr)
    const detail = hint ?? lastTunnelLine(this.stderr)
    if (!expected) {
      this.lastError = code === 0 ? 'the SSH tunnel process exited' : `the SSH tunnel exited (code ${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`
    }
    if (wasStarting && this._rejectReady) {
      this.#rejectReady(
        Object.assign(new Error(this.lastError ?? 'the SSH tunnel exited during startup'), {
          code: 'TUNNEL_EXITED',
          stderrTail: this.stderr.slice(-4_000),
        }),
      )
    } else if (!expected) {
      this.log?.('warn', `${this.label}: ${this.lastError}`)
      this.emit('exit', this.snapshot())
    }
    this.#forget()
  }

  #resolveReady(value) {
    const resolve = this._resolveReady
    this._resolveReady = undefined
    this._rejectReady = undefined
    resolve?.(value)
  }

  #rejectReady(error) {
    const reject = this._rejectReady
    this._resolveReady = undefined
    this._rejectReady = undefined
    reject?.(error)
  }
}

/**
 * Wait until a spawned console process would be ready, or give up.
 *
 * Exposed for tests: the production path uses `SshTunnel.start`.
 */
export function tunnelReadyPatterns() {
  return { session: SESSION_READY, listener: LISTENER_READY }
}
