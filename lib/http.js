/** Same-origin dashboard transport: state, actions and a Server-Sent Events feed. */
import { randomBytes } from 'node:crypto'

const BASE_PATH = '/__dsh/virtuoso-bridge'
const MAX_BODY_BYTES = 2 * 1024 * 1024

export function registerHttp({ ctx, manager, log }) {
  const webServer = ctx.get('webServer')
  if (!webServer) {
    log?.('warn', 'webServer service is unavailable; the dashboard HTTP endpoint is disabled')
    return { enabled: false, token: undefined, basePath: BASE_PATH, dispose() {} }
  }
  const token = randomBytes(24).toString('hex')
  const clients = new Set()
  let disposed = false

  const offIndex = ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_VIRTUOSO_BRIDGE__',
      value: { token, basePath: BASE_PATH, version: manager.version },
    })
  })

  const origin = safeOrigin(webServer)

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

  function authorized(request, url) {
    const supplied = request.headers['x-vb-token'] ?? url.searchParams.get('token') ?? ''
    if (supplied && timingSafeEqual(String(supplied), token)) return true
    const site = String(request.headers['sec-fetch-site'] ?? '')
    const requestOrigin = String(request.headers.origin ?? '')
    if (site === 'same-origin' && (!requestOrigin || !origin || requestOrigin === origin)) return true
    if (site === 'none' && !requestOrigin) return true
    return false
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    if (!url.pathname.startsWith(BASE_PATH)) {
      writeJson(response, 404, { ok: false, error: { message: 'not found', code: 'NOT_FOUND' } })
      return
    }
    const suffix = url.pathname.slice(BASE_PATH.length) || '/'
    if (!authorized(request, url)) {
      writeJson(response, 403, { ok: false, error: { message: 'dashboard token is missing or stale; reload the page', code: 'FORBIDDEN' } })
      return
    }
    if (suffix === '/health') {
      writeJson(response, 200, { ok: true, version: manager.version })
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
      response.write(`retry: 3000\n\n`)
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

  log?.('info', `dashboard endpoint ready at ${BASE_PATH}`)

  return {
    enabled: true,
    token,
    basePath: BASE_PATH,
    origin,
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
