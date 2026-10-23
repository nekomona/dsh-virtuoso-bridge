/** Agent-facing tools and the prompt section that makes them discoverable. */
import { truncate } from './util.js'

const RUNTIME_TOOL = 'virtuoso_bridge_runtime'
const API_TOOL = 'virtuoso_bridge_api'
const SCRIPT_TOOL = 'virtuoso_bridge_script'
const SETUP_TOOL = 'virtuoso_bridge_setup'

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(args, value) {
    return [{ type: 'text', text: renderText(args, value) }]
  },
}

function renderText(args, value) {
  if (value && value.ok === false && value.error) {
    return `FAILED: ${value.error.message}${value.error.hint ? `\nHint: ${value.error.hint}` : ''}`
  }
  if (args?.action === 'status' || args?.action === 'list') {
    const lines = []
    const state = value?.state ?? value
    if (state?.setup) {
      lines.push(`setup: ${state.setup.installed ? 'installed' : 'not installed'}${state.setup.source?.mode ? ` (${state.setup.source.mode})` : ''}`)
    }
    if (state?.capabilities) {
      const dashboard = state.capabilities.dashboard
      lines.push(
        `dashboard endpoint: ${state.capabilities.webServer ? 'enabled' : 'disabled'}` +
          (dashboard?.origin ? ` at ${dashboard.origin}${dashboard.basePath ?? ''}` : '') +
          ` · credentials: ${state.capabilities.credentials ? 'available' : 'unavailable'}`,
      )
    }
    for (const runtime of state?.runtimes ?? []) {
      lines.push(`runtime ${runtime.id}: ${runtime.state}${runtime.health?.summary ? ` - ${runtime.health.summary}` : ''}${runtime.setupHint ? `; CIW: ${runtime.setupHint}` : ''}`)
    }
    for (const connection of state?.connections ?? []) {
      lines.push(`connection ${connection.name} (${connection.id}): ${connection.kind} ${connection.user ? `${connection.user}@` : ''}${connection.host}:${connection.port}${connection.hasSecret ? ' [token stored]' : ''}`)
    }
    for (const agent of state?.agents ?? []) {
      lines.push(`agent ${agent.sessionId}: ${agent.calls} calls, ${agent.live ? 'live' : 'closed'}, last ${new Date(agent.lastUsedAt).toISOString()}`)
    }
    for (const action of (state?.actions ?? []).filter((item) => item.state === 'running')) {
      lines.push(`action ${action.kind}: ${action.label}`)
    }
    if (lines.length) return lines.join('\n')
  }
  return truncate(JSON.stringify(value, null, 2), 14_000)
}

function failure(error) {
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code ?? 'ERROR',
      traceback: error?.traceback ? truncate(error.traceback, 4000) : undefined,
      hint: hintFor(error),
    },
  }
}

function hintFor(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/not installed|venv|Python >=/i.test(message)) {
    return 'Call virtuoso_bridge_setup with action "install" (optionally set source.localRepoPath for a development checkout).'
  }
  if (/not running|start it first/i.test(message)) {
    return 'Call virtuoso_bridge_runtime with action "start".'
  }
  if (/daemon did not respond|waiting/i.test(message)) {
    return 'Run the printed load("...") line in the Virtuoso CIW, then poll status again.'
  }
  return undefined
}

function errorOf(error) {
  return lossless(failure(error))
}

/** Tool values must be lossless JSON: drop undefined, stringify the exotic. */
function lossless(value, seen) {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = lossless(item, seen)
      return next === undefined ? null : next
    })
  }
  if (typeof value === 'object') {
    if (seen?.has(value)) return '[circular]'
    const nextSeen = seen ?? new WeakSet()
    nextSeen.add(value)
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      const next = lossless(item, nextSeen)
      if (next !== undefined) output[key] = next
    }
    nextSeen.delete(value)
    return output
  }
  return String(value)
}

function toolResult(value) {
  return lossless(value)
}

export function registerTools({ ctx, manager, log }) {
  const registrations = []
  const register = (definition) => {
    registrations.push(ctx.tools.register(definition))
  }

  register({
    name: RUNTIME_TOOL,
    description:
      'Manage virtuoso-bridge-lite (Cadence Virtuoso) runtimes that this DSH profile keeps alive across conversations. ' +
      'Use action "status" first. "start" creates or reuses the managed SSH tunnel and daemon connection for a saved server connection; ' +
      'if the state is "waiting", the user must load the printed setup in the CIW. "stop" tears down the tunnel and daemon session. ' +
      'Also creates, updates and tests connection profiles; credentials are stored through DSH, never returned.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'start', 'stop', 'restart', 'ping', 'connections', 'save_connection', 'delete_connection', 'test_connection', 'orphans', 'stop_orphan'],
          description: 'The runtime or connection operation to perform.',
        },
        connection: { type: 'string', description: 'Connection id or name; omit to use the default connection.' },
        runtime: { type: 'string', description: 'Runtime id (rt_...) when several runtimes exist.' },
        waitMs: { type: 'integer', description: 'Wait budget for start/ping before returning a pending snapshot (default 15000).' },
        connectionConfig: {
          type: 'object',
          description: 'For save_connection: {name, host, user, port, jumpHost, jumpUser, kind, sshBackend, spectreHost, envShell, identityFile, localPort, extraEnv, notes, enabled}.',
          additionalProperties: true,
        },
        secret: {
          type: 'object',
          description: 'For save_connection: write-only credentials, e.g. {"daemonToken": "..."} or {"daemonToken": null} to clear.',
          additionalProperties: true,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 300_000,
    isConcurrencySafe(args) {
      return ['status', 'list', 'connections', 'orphans'].includes(args?.action)
    },
    async execute(args, exec) {
      const agentId = exec.agent?.id
      try {
        switch (args.action) {
          case 'status':
          case 'list':
            return toolResult({ ok: true, state: manager.getState() })
          case 'connections':
            return toolResult({
              ok: true,
              connections: manager.store.snapshot().connections.map((connection) => manager.publicConnection(connection)),
            })
          case 'start':
            return toolResult({
              ok: true,
              runtime: await manager.startRuntime(args.connection, { waitMs: args.waitMs ?? 15_000, agentId }),
            })
          case 'stop':
            return toolResult({ ok: true, runtime: await manager.stopRuntime(args.runtime ?? args.connection, { agentId }) })
          case 'restart':
            return toolResult({
              ok: true,
              runtime: await manager.startRuntime(args.connection, { waitMs: args.waitMs ?? 15_000, agentId, restart: true }),
            })
          case 'ping': {
            const runtime = manager.runtimeRef(args.runtime ?? args.connection)
            if (!runtime) throw new Error('no managed runtime is available; start one first')
            const status = await runtime.sidecar.request('status', {}, 30_000)
            runtime.status = status
            runtime.lastHealthAt = Date.now()
            manager.emit()
            return toolResult({ ok: true, runtime: runtime.id, status })
          }
          case 'save_connection': {
            if (!args.connectionConfig) throw new Error('connectionConfig is required')
            const saved = await manager.saveConnection(args.connectionConfig, args.secret)
            return toolResult({ ok: true, connection: saved })
          }
          case 'delete_connection':
            return toolResult({ ok: true, deleted: await manager.deleteConnection(args.connection) })
          case 'test_connection':
            return toolResult({ ok: true, result: await manager.testConnection(args.connection, { agentId }) })
          case 'orphans':
            return toolResult({ ok: true, orphans: await manager.scanOrphans() })
          case 'stop_orphan':
            return toolResult({ ok: true, result: await manager.stopOrphan(args.connection) })
          default:
            throw new Error(`unknown action ${args.action}`)
        }
      } catch (error) {
        log?.('warn', `${RUNTIME_TOOL} failed: ${error instanceof Error ? error.message : String(error)}`)
        return errorOf(error)
      }
    },
  })

  register({
    name: API_TOOL,
    description:
      'Call any public function of the isolated virtuoso-bridge-lite Python API through the managed runtime. ' +
      'Use action "describe" to list targets, classes, methods and Python signatures; then action "call" with target/method/args/kwargs. ' +
      'Targets include client, client.schematic, client.layout, client.library, client.symbol, client.maestro, client.sos, client.dialogs, client.requests and spectre; ' +
      'use "class:VirtuosoClient" for class documentation. Functions returning dataclasses are converted to JSON. ' +
      'Large results are written to a file and returned as a preview plus path.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['describe', 'call'], description: 'describe the API or execute one method.' },
        target: { type: 'string', description: 'Dotted object path, e.g. client.schematic or spectre. class:<Name> describes a class.' },
        method: { type: 'string', description: 'Method name for action "call".' },
        args: { type: 'array', description: 'Positional arguments. Use {"$type":"path","value":"..."} for Path and {"$type":"bytes","data":"<base64>"} for bytes.', items: {} },
        kwargs: { type: 'object', description: 'Keyword arguments.', additionalProperties: true },
        runtime: { type: 'string', description: 'Runtime id; omit when exactly one runtime is active.' },
        connection: { type: 'string', description: 'Connection id or name when no runtime id is given.' },
        timeoutSec: { type: 'integer', description: 'Bridge-side operation timeout in seconds (default 600).' },
        depth: { type: 'integer', description: 'Describe recursion depth (default 2).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 6 * 60 * 60 * 1000,
    isConcurrencySafe(args) {
      return args?.action === 'describe'
    },
    async execute(args, exec) {
      try {
        if (args.action === 'describe') {
          return toolResult({
            ok: true,
            api: await manager.describeApi({
              runtime: args.runtime ?? args.connection,
              target: args.target,
              depth: args.depth,
              agentId: exec.agent?.id,
            }),
          })
        }
        if (args.action === 'call') {
          if (!args.method) throw new Error('method is required for action "call"')
          return toolResult({
            ok: true,
            call: await manager.callApi({
              runtime: args.runtime ?? args.connection,
              target: args.target ?? 'client',
              method: args.method,
              args: args.args ?? [],
              kwargs: args.kwargs ?? {},
              timeoutSec: args.timeoutSec ?? 600,
              agentId: exec.agent?.id,
            }),
          })
        }
        throw new Error(`unknown action ${args.action}`)
      } catch (error) {
        log?.('warn', `${API_TOOL} failed: ${error instanceof Error ? error.message : String(error)}`)
        return errorOf(error)
      }
    },
  })

  register({
    name: SCRIPT_TOOL,
    description:
      'Submit and control Python scripts that run inside the plugin-managed virtuoso-bridge venv, for batched work that does not fit individual tool calls. ' +
      'The script runs in its own process with the virtuoso-bridge package importable and a job directory; use connect() to reuse the running tunnel/daemon, ' +
      'emit(value) for progress and assign result for a structured result. Jobs survive across tool calls and conversations in this DSH process. ' +
      'Actions: run (code or path), status, list, cancel. Long jobs return a job id immediately.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'status', 'list', 'cancel'], description: 'Script operation.' },
        code: { type: 'string', description: 'Inline Python source for action "run".' },
        path: { type: 'string', description: 'Path to a Python file for action "run" (absolute or workspace-relative).' },
        job: { type: 'string', description: 'Job id for status/cancel.' },
        runtime: { type: 'string', description: 'Runtime id; omit to use the only active runtime, or run without a connection.' },
        connection: { type: 'string', description: 'Connection id or name.' },
        connect: { type: 'boolean', description: 'When a runtime is selected, pre-connect and expose client (default true).' },
        waitMs: { type: 'integer', description: 'How long run waits before returning the job id (default 10000).' },
        timeoutSec: { type: 'integer', description: 'Hard job timeout in seconds (default 3600).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 300_000,
    isConcurrencySafe(args) {
      return ['status', 'list'].includes(args?.action)
    },
    async execute(args, exec) {
      try {
        switch (args.action) {
          case 'run':
            return toolResult({
              ok: true,
              job: await manager.runScript({
                runtime: args.runtime,
                connection: args.connection,
                code: args.code,
                filePath: args.path,
                connect: args.connect,
                waitMs: args.waitMs ?? 10_000,
                timeoutSec: args.timeoutSec ?? 3600,
                agentId: exec.agent?.id,
              }),
            })
          case 'status':
            return toolResult({ ok: true, job: manager.getScript(args.job) })
          case 'list':
            return toolResult({ ok: true, jobs: manager.listScripts() })
          case 'cancel':
            return toolResult({ ok: true, job: await manager.cancelScript(args.job) })
          default:
            throw new Error(`unknown action ${args.action}`)
        }
      } catch (error) {
        log?.('warn', `${SCRIPT_TOOL} failed: ${error instanceof Error ? error.message : String(error)}`)
        return errorOf(error)
      }
    },
  })

  register({
    name: SETUP_TOOL,
    description:
      'Install, update and diagnose the isolated virtuoso-bridge-lite environment used by this plugin. ' +
      'The plugin bundles a snapshot, but can also install from a local development checkout (source.localRepoPath) or clone a git repository at a ref. ' +
      'Use action "status" before installing, "install" to create or repair the venv, "diagnose" for a readiness report, and "configure" or "set_source" to persist choices. ' +
      'Installation may take minutes and returns a pending result after waitMs; poll "status".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'update', 'diagnose', 'configure', 'set_source', 'caches', 'clear_cache'], description: 'Setup operation.' },
        recreate: { type: 'boolean', description: 'Delete and recreate the venv before installing.' },
        waitMs: { type: 'integer', description: 'How long install waits before returning (default 20000).' },
        source: {
          type: 'object',
          description: 'Source selection: {mode: bundled|local|git, localRepoPath, repoUrl, gitRef}.',
          additionalProperties: true,
        },
        settings: {
          type: 'object',
          description: 'Runtime defaults: {pythonPath, autoInstall, autoStart, defaultConnection, logToCiw, maxScripts}.',
          additionalProperties: true,
        },
        cache: { type: 'string', description: 'Cache id for clear_cache: pip, sources, jobs, results or logs.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 1_800_000,
    isConcurrencySafe(args) {
      return ['status', 'caches', 'diagnose'].includes(args?.action)
    },
    async execute(args, exec) {
      try {
        switch (args.action) {
          case 'status': {
            const setup = await manager.refreshSetup(true)
            const caches = await manager.refreshCaches()
            return toolResult({ ok: true, setup, caches })
          }
          case 'install':
          case 'update': {
            const waitMs = args.waitMs ?? 20_000
            const promise = manager.install({ recreate: args.recreate === true, agentId: exec.agent?.id })
            const result = await Promise.race([
              promise.then((value) => ({ done: true, value })),
              new Promise((resolve) => setTimeout(() => resolve({ done: false }), waitMs)),
            ])
            if (!result.done) {
              return toolResult({
                ok: true,
                pending: true,
                setup: manager.setupStatus,
                message: 'installation is still running; poll action "status"',
              })
            }
            return toolResult({ ok: result.value?.ok === true, install: result.value, setup: manager.setupStatus })
          }
          case 'diagnose':
            return toolResult({ ok: true, diagnosis: await manager.diagnose({ agentId: exec.agent?.id }) })
          case 'configure': {
            if (!args.settings) throw new Error('settings is required')
            return toolResult({ ok: true, result: await manager.updateSettings(args.settings) })
          }
          case 'set_source': {
            if (!args.source) throw new Error('source is required')
            return toolResult({ ok: true, setup: await manager.updateSource(args.source) })
          }
          case 'caches':
            return toolResult({ ok: true, caches: await manager.refreshCaches(true) })
          case 'clear_cache':
            if (!args.cache) throw new Error('cache is required')
            return toolResult({ ok: true, result: await manager.clearCache(args.cache) })
          default:
            throw new Error(`unknown action ${args.action}`)
        }
      } catch (error) {
        log?.('warn', `${SETUP_TOOL} failed: ${error instanceof Error ? error.message : String(error)}`)
        return errorOf(error)
      }
    },
  })

  const promptSection = ctx.get('systemPrompt')
  let promptDisposer
  if (promptSection) {
    promptDisposer = promptSection.section({
      name: 'virtuoso-bridge',
      order: 41,
      text: [
        '## Cadence Virtuoso (virtuoso-bridge-lite)',
        '',
        `The ${RUNTIME_TOOL}, ${API_TOOL}, ${SCRIPT_TOOL} and ${SETUP_TOOL} tools control a managed virtuoso-bridge-lite environment.`,
        'Use them instead of running Python, SKILL, ssh or the virtuoso-bridge CLI through the shell.',
        '',
        `1. ${RUNTIME_TOOL} action "status" shows setup, saved connections and live runtimes. Start with action "start".`,
        '   A runtime may report "waiting": its SSH tunnel is up but the Virtuoso CIW has not loaded the bridge setup. Tell the user to run the printed load("...") line in the CIW, then poll status.',
        `2. ${API_TOOL} action "describe" lists every public Python method and signature; action "call" invokes one on client, client.schematic, client.layout, client.library, client.symbol, client.maestro, client.sos, client.dialogs, client.requests or spectre.`,
        `3. ${SCRIPT_TOOL} runs batched Python in the isolated plugin venv. Use connect() inside the script to reuse the runtime; assign result for structured output.`,
        `4. ${SETUP_TOOL} installs or repairs the venv from the bundled snapshot, a local development checkout, or a git repository.`,
        '',
        'The background tunnel and daemon are process-wide and survive across conversations; the dashboard in the right sidebar ("Virtuoso Bridge") shows the same state. Never assume a background daemon is healthy: poll the runtime status before relying on it.',
      ].join('\n'),
    })
    registrations.push(promptDisposer)
  }

  return {
    dispose() {
      for (const dispose of registrations.reverse()) {
        try {
          dispose()
        } catch {
          // ignore
        }
      }
    },
  }
}

export { RUNTIME_TOOL, API_TOOL, SCRIPT_TOOL, SETUP_TOOL }
