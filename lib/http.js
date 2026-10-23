/** Same-origin dashboard transport: bootstrap, state, actions and an SSE feed. */
import { randomBytes } from 'node:crypto'

const BASE_PATH = '/__dsh/virtuoso-bridge'
const MAX_BODY_BYTES = 2 * 1024 * 1024

export function registerHttp({ ctx, manager, log }) {
  // The caller injects ['webServer'] so this runs only once the service is
  // available. Read it through the context rather than a one-shot ctx.get()
  // captured at plugin activation: a cold boot activates the webserver after
  // feature plugins, which used to leave the route unregistered (HTTP 404).
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer) {
    log?.('warn', 'webServer service is unavailable; the dashboard HTTP endpoint is disabled')
    return { enabled: false, token: undefined, basePath: BASE_PATH, dispose() {} }
  }
  const token = randomBytes(24).toString('hex')
  const clients = new Set()
  let disposed = false
  const origin = safeOrigin(webServer)
  const note = (level, message) => {
    try {
      if (manager.log) manager.log(level, message)
      else log?.(level, message)
    } catch {
      // ignore
    }
  }

  const offIndex = ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_VIRTUOSO_BRIDGE__',
      value: { token, basePath: BASE_PATH, origin, version: manager.version },
    })
  })

  const route = webServer.register({
    kind: 'prefix',
    path: BASE_PATH,
    handler: async (request, response) => {
      try {
        await handle(request, response)
      } catch (error) {
        writeJson(response, 500, { ok: false, error: { message: messageOf(error), code: 'INTERNAL' } })
      }
    },
  })

  const offChange = manager.onChange((state) => {
    broadcast({ type: 'state', state })
  })

  const heartbeat = setInterval(() => {
    for (const response of clients) {
      try {
        response.write(': keepalive\n\n')
      } catch {
        clients.delete(response)
      }
    }
  }, 15_000)
  heartbeat.unref?.()

  /**
   * Local page policy. The dashboard is served from the same loopback origin;
   * a token is still required for non-local origins. Browser cross-site
   * requests are rejected even though they arrive from 127.0.0.1 at the TCP
   * layer. This keeps the endpoint usable after a page loaded before the
   * bundle was installed, when the token injection is absent.
   */
  function localRequest(request) {
    const headers = request.headers ?? {}
    const site = String(headers['sec-fetch-site'] ?? '')
    const requestOrigin = String(headers.origin ?? '')
    if (requestOrigin) {
      // The desktop shell uses its own app scheme; only DSH can originate it.
      if (requestOrigin.startsWith('dsh-app://')) return true
      if (site === 'cross-site') return false
      if (requestOrigin === 'null') return false
      if (requestOrigin.startsWith('file://')) return true
      try {
        const parsed = new URL(requestOrigin)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
        const expected = originUrl()
        if (expected && parsed.host === expected.host) return true
        if (expected?.port && parsed.port === expected.port && isLoopbackName(parsed.hostname)) return true
        return false
      } catch {
        return false
      }
    }
    if (site === 'cross-site') return false
    if (site === 'same-origin' || site === 'same-site' || site === 'none') return true
    // No browser metadata: accept a loopback Host header with the server port.
    const host = String(headers.host ?? '')
    if (!host) return false
    try {
      const parsed = new URL(`http://${host}`)
      const expected = originUrl()
      if (expected && parsed.host === expected.host) return true
      if (!isLoopbackName(parsed.hostname)) return false
      if (expected?.port && parsed.port && parsed.port !== expected.port) return false
      return true
    } catch {
      return false
    }
  }

  function originUrl() {
    if (!origin) return undefined
    try {
      return new URL(origin)
    } catch {
      return undefined
    }
  }

  function authorized(request, url) {
    const supplied = request.headers['x-vb-token'] ?? url.searchParams.get('token') ?? ''
    if (supplied && timingSafeEqual(String(supplied), token)) return true
    return localRequest(request)
  }

  function reject(request, response, url) {
    const headers = request.headers ?? {}
    note(
      'warn',
      `dashboard auth rejected: ${request.method} ${url.pathname} host=${headers.host ?? ''} ` +
        `origin=${headers.origin ?? ''} site=${headers['sec-fetch-site'] ?? ''} ` +
        `token=${headers['x-vb-token'] || url.searchParams.get('token') ? 'bad' : 'missing'}`,
    )
    writeJson(response, 403, {
      ok: false,
      error: {
        message: 'dashboard authorization failed; reload the page or use the Virtuoso Bridge settings page',
        code: 'FORBIDDEN',
      },
    })
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    if (!url.pathname.startsWith(BASE_PATH)) {
      writeJson(response, 404, { ok: false, error: { message: 'not found', code: 'NOT_FOUND' } })
      return
    }
    const requestOrigin = String(request.headers.origin ?? '')
    const desktopOrigin = requestOrigin.startsWith('dsh-app://')
    if (desktopOrigin) {
      response.setHeader('Access-Control-Allow-Origin', requestOrigin)
      response.setHeader('Access-Control-Allow-Headers', 'content-type, x-vb-token')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      response.setHeader('Vary', 'Origin')
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Max-Age': '600' })
        response.end()
        return
      }
    }
    const suffix = url.pathname.slice(BASE_PATH.length) || '/'
    if (suffix === '/health') {
      writeJson(response, 200, { ok: true, version: manager.version, basePath: BASE_PATH, origin })
      return
    }
    if (suffix === '/bootstrap') {
      // Token bootstrap is readable only from this machine (same site or a
      // local shell origin); a cross-site page is rejected before this point.
      if (!localRequest(request)) {
        reject(request, response, url)
        return
      }
      writeJson(response, 200, {
        ok: true,
        token,
        basePath: BASE_PATH,
        origin,
        version: manager.version,
      })
      return
    }
    if (!authorized(request, url)) {
      reject(request, response, url)
      return
    }
    if (suffix === '/state') {
      writeJson(response, 200, { ok: true, state: manager.getState() })
      return
    }
    if (suffix === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.write('retry: 3000\n\n')
      response.write(`data: ${JSON.stringify({ type: 'state', state: manager.getState() })}\n\n`)
      clients.add(response)
      request.on('close', () => clients.delete(response))
      return
    }
    if (suffix === '/action') {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { message: 'POST required', code: 'METHOD' } })
        return
      }
      const body = await readBody(request)
      if (!body || typeof body.action !== 'string') {
        writeJson(response, 400, { ok: false, error: { message: 'action is required', code: 'BAD_REQUEST' } })
        return
      }
      try {
        const result = await manager.performAction(body.action, body.payload ?? body, {
          agentId: body.agentId,
          surface: 'dashboard',
        })
        writeJson(response, 200, { ok: true, result, state: manager.getState() })
      } catch (error) {
        writeJson(response, 200, {
          ok: false,
          error: { message: messageOf(error), code: error?.code ?? 'ACTION_FAILED' },
          state: manager.getState(),
        })
      }
      return
    }
    writeJson(response, 404, { ok: false, error: { message: `unknown endpoint ${suffix}`, code: 'NOT_FOUND' } })
  }

  function broadcast(payload) {
    if (disposed) return
    const text = `data: ${JSON.stringify(payload)}\n\n`
    for (const response of clients) {
      try {
        response.write(text)
      } catch {
        clients.delete(response)
      }
    }
  }

  async function selfTest() {
    const base = origin || (webServer.port ? `http://127.0.0.1:${webServer.port}` : undefined)
    const result = {
      ok: false,
      origin: base,
      basePath: BASE_PATH,
      route: base ? `${base}${BASE_PATH}` : undefined,
      healthStatus: undefined,
      stateStatus: undefined,
      tokenSet: true,
      error: undefined,
    }
    if (!base) {
      result.error = 'webServer has no reachable origin yet'
      return result
    }
    try {
      const health = await fetch(`${base}${BASE_PATH}/health`, {
        headers: { 'x-vb-token': token },
        signal: AbortSignal.timeout(4_000),
      })
      result.healthStatus = health.status
      const state = await fetch(`${base}${BASE_PATH}/state`, {
        headers: { 'x-vb-token': token },
        signal: AbortSignal.timeout(6_000),
      })
      result.stateStatus = state.status
      result.ok = health.ok && state.ok
      if (!result.ok) result.error = `health=${health.status} state=${state.status}`
      return result
    } catch (error) {
      result.error = messageOf(error)
      return result
    }
  }

  note('info', `dashboard endpoint ready at ${BASE_PATH}${origin ? ` (${origin})` : ''}`)

  return {
    enabled: true,
    token,
    basePath: BASE_PATH,
    origin,
    selfTest,
    dispose() {
      disposed = true
      clearInterval(heartbeat)
      offChange()
      offIndex()
      route()
      for (const response of clients) {
        try {
          response.end()
        } catch {
          // ignore
        }
      }
      clients.clear()
    },
  }
}

function isLoopbackName(hostname) {
  const text = String(hostname ?? '').toLowerCase()
  return text === 'localhost' || text === '127.0.0.1' || text === '::1' || text === '[::1]' || text.startsWith('127.')
}

function safeOrigin(webServer) {
  try {
    return webServer.getOrigin()
  } catch {
    return undefined
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${messageOf(error)}`))
      }
    })
    request.on('error', reject)
  })
}

function writeJson(response, status, payload) {
  if (response.headersSent) {
    try {
      response.end()
    } catch {
      // ignore
    }
    return
  }
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return mismatch === 0
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
