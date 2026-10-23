/** One long-lived Python sidecar speaking newline-delimited JSON. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { id as newId, killTree } from './util.js'

export class Sidecar {
  constructor({ python, script, args = [], env, cwd, label, onEvent, onLog }) {
    this.python = python
    this.script = script
    this.args = args
    this.env = env
    this.cwd = cwd
    this.label = label ?? 'sidecar'
    this.onEvent = onEvent
    this.onLog = onLog
    this.child = undefined
    this.pending = new Map()
    this.buffer = ''
    this.stderrBuffer = ''
    this.closed = false
    this.exitInfo = undefined
    this.readyPromise = undefined
    this.readyResolve = undefined
    this.readyReject = undefined
    this.exited = undefined
  }

  get pid() {
    return this.child?.pid
  }

  async start({ timeoutMs = 60_000 } = {}) {
    if (this.child) return this
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.exited = new Promise((resolve) => {
      this._resolveExit = resolve
    })
    this.child = spawn(this.python, [this.script, ...this.args], {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    this.child.stderr.on('data', (chunk) => this.#onStderr(chunk))
    this.child.on('error', (error) => {
      this.closed = true
      this.readyReject?.(error)
      this.#rejectPending(new Error(`sidecar spawn failed: ${error.message}`))
      this._resolveExit?.({ code: null, signal: null, error: String(error) })
    })
    this.child.on('close', (code, signal) => {
      this.closed = true
      this.exitInfo = { code, signal }
      this.readyReject?.(new Error(`sidecar exited before ready (code ${code ?? 'unknown'})`))
      this.#rejectPending(new Error(`virtuoso-bridge sidecar exited (code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''})`))
      this._resolveExit?.({ code, signal })
      this.onLog?.('warn', `sidecar closed (code ${code ?? 'unknown'})`)
    })
    const timer = setTimeout(() => {
      this.readyReject?.(new Error('sidecar did not become ready in time'))
      killTree(this.pid)
    }, timeoutMs)
    try {
      await this.readyPromise
    } finally {
      clearTimeout(timer)
    }
    return this
  }

  #onStdout(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.#handleLine(line)
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > 8_000_000) {
      this.onLog?.('warn', 'sidecar stdout buffer grew too large; resetting')
      this.buffer = ''
    }
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.onLog?.('info', `${path.basename(this.label)}: ${line.slice(0, 500)}`)
      return
    }
    if (message.event) {
      if (message.event === 'ready') {
        this.readyResolve?.({ ...message })
        return
      }
      this.onEvent?.(message)
      return
    }
    if (message.id === undefined || message.id === null) {
      this.onEvent?.(message)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) {
      pending.resolve(message.result)
    } else {
      const error = new Error(message.error?.message ?? 'sidecar request failed')
      error.code = message.error?.kind ?? 'SIDECAR_ERROR'
      error.traceback = message.error?.traceback
      pending.reject(error)
    }
  }

  #onStderr(chunk) {
    this.stderrBuffer = (this.stderrBuffer + chunk).slice(-120_000)
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) this.onLog?.('debug', line.trim())
    }
  }

  #rejectPending(error) {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(requestId)
    }
  }

  request(method, params = {}, timeoutMs = 300_000) {
    if (!this.child || this.closed) {
      return Promise.reject(new Error('virtuoso-bridge sidecar is not running'))
    }
    const requestId = newId('rpc_')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`sidecar request ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  async stop({ stopTunnel = true, timeoutMs = 8_000 } = {}) {
    if (!this.child) return
    if (!this.closed) {
      try {
        await this.request('disconnect', { stopTunnel }, Math.min(timeoutMs, 5_000))
      } catch {
        // The process may already be gone.
      }
      try {
        await this.request('shutdown', { stopTunnel: false }, 2_000)
      } catch {
        // ignore
      }
    }
    this.closed = true
    try {
      this.child.stdin.end()
    } catch {
      // ignore
    }
    const exited = await Promise.race([
      this.exited?.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
    if (!exited) {
      killTree(this.pid)
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
    }
    this.child = undefined
  }

  tailStderr(maxChars = 8_000) {
    return this.stderrBuffer.slice(-maxChars)
  }
}
