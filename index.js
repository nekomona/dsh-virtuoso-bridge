/**
 * Host half of the Virtuoso Bridge plugin.
 *
 * Owns the process-wide setup manager, saved connections, sidecars and script
 * jobs; registers the agent tools, the prompt section and the dashboard HTTP
 * transport.  The browser half lives in client.js.
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeManager } from './lib/manager.js'
import { registerHttp } from './lib/http.js'
import { registerTools } from './lib/tools.js'
import { SettingsStore } from './lib/store.js'
import { SetupManager } from './lib/setup.js'
import { ensureDir } from './lib/util.js'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')
const pluginDir = path.dirname(fileURLToPath(import.meta.url))

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config)
  const log = createLogger(ctx)
  log('info', `host plugin loading (data: ${dataDir})`)

  ctx.effect(() => {
    let manager
    let tools
    let http
    let disposed = false
    const store = new SettingsStore({ dataDir, baseConfig: config })
    const setup = new SetupManager({
      pluginDir,
      dataDir,
      store,
      log: (level, message) => log(level, message),
    })
    manager = new BridgeManager({
      ctx,
      pluginDir,
      dataDir,
      store,
      setup,
      credentials: ctx.get('credentials'),
      log,
      version: pkg.version,
    })
    http = registerHttp({ ctx, manager, log })
    tools = registerTools({ ctx, manager, log })

    const ready = (async () => {
      await ensureDir(dataDir)
      await store.load()
      manager.credentials = ctx.get('credentials')
      await manager.init()
      log('info', 'host plugin ready')
    })().catch((error) => {
      log('error', `initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    })

    return async () => {
      if (disposed) return
      disposed = true
      log('info', 'host plugin unloading')
      try {
        tools?.dispose()
      } catch {
        // ignore
      }
      try {
        http?.dispose()
      } catch {
        // ignore
      }
      await ready.catch(() => {})
      await manager?.dispose().catch(() => {})
      log('info', 'host plugin unloaded')
    }
  }, 'virtuoso-bridge: host plugin')
}

function resolveDataDir(config) {
  const configured = config?.dataDir ?? process.env.VB_PLUGIN_DATA_DIR
  if (configured) return path.resolve(String(configured).replace(/^~(?=$|[\\/])/, os.homedir()))
  const profile = process.env.DSH_PROFILE ?? 'default'
  return path.join(os.homedir(), '.dsh', 'virtuoso-bridge', String(profile))
}

function createLogger(ctx) {
  return (level, message) => {
    const line = `[virtuoso-bridge] ${message}`
    try {
      const logger = ctx.logger
      if (level === 'error' && logger?.error) logger.error(line)
      else if (level === 'warn' && logger?.warn) logger.warn(line)
      else if (level === 'debug') {
        if (process.env.DSH_DEBUG_VIRTUOSO_BRIDGE) console.log(line)
      } else if (logger?.info) logger.info(line)
      else if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    } catch {
      // Logging must never break the plugin.
    }
  }
}
