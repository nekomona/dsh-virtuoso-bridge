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
    const details = value.error.details ? `\nDetails: ${truncate(JSON.stringify(value.error.details), 6000)}` : ''
    return `FAILED: ${value.error.message}${details}${value.error.hint ? `\nHint: ${value.error.hint}` : ''}`
  }
  const pending = value?.runtime?.pendingHostKey ?? value?.pendingHostKey ?? value?.result?.pendingHostKey
  if (pending) {
    const lines = [
      `HOST KEY CONFIRMATION REQUIRED for ${pending.host}:${pending.sshPort}`,
      pending.message ?? 'Confirm the server fingerprint before connecting.',
    ]
    for (const entry of pending.unknown ?? []) {
      lines.push(`  ${entry.type} ${entry.fingerprint}`)
    }
    for (const conflict of pending.conflicts ?? []) {
      lines.push(
        `  CHANGED ${conflict.incoming?.type ?? ''} ${conflict.incoming?.fingerprint ?? ''} ` +
          `(known: ${(conflict.existing ?? []).map((item) => item.fingerprint).join(', ')})`,
      )
    }
    lines.push('Ask the user to confirm the fingerprint, then call action "trust_host" with that fingerprint.')
    return lines.join('\n')
  }
  if (value?.needsConfirmation) {
    const backends = value.backends ?? value.preflight?.backends
    return [
      'USER CONFIRMATION REQUIRED before installation.',
      value.message ?? 'OpenSSH is missing; confirm installing with the Paramiko backend.',
      backends
        ? `OpenSSH: ${backends.openssh?.available ? backends.openssh.path : 'not found'} · Paramiko: ${backends.paramiko?.installed ? `installed ${backends.paramiko.version ?? ''}` : 'will be installed'}`
        : '',
      'Ask the user. If they approve, retry action "install" with confirm=true.',
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (args?.action === 'host_key' && (value?.entries || value?.probe?.entries)) {
    const probe = value.probe ?? value
    const entries = value.entries ?? probe.entries ?? []
    const known = value.known ?? probe.known ?? []
    const unknown = value.unknown ?? probe.unknown ?? []
    const lines = [`host keys for ${probe.host ?? value.host}:${probe.sshPort ?? value.sshPort} (${probe.source ?? value.source})`]
    for (const entry of entries) {
      const state = known.includes(entry.fingerprint) ? 'trusted' : unknown.includes(entry.fingerprint) ? 'UNTRUSTED' : 'changed'
      lines.push(`  ${entry.type} ${entry.fingerprint} [${state}]`)
    }
    if (probe.conflicts?.length || value.conflicts?.length) {
      for (const conflict of value.conflicts ?? probe.conflicts) {
        const incoming = typeof conflict.incoming === 'string' ? conflict.incoming : conflict.incoming?.fingerprint
        lines.push(`  conflict: ${incoming} (known: ${(conflict.existing ?? []).join(', ')})`)
      }
    }
    return lines.join('\n')
  }
  if (args?.action === 'status' || args?.action === 'list') {
    const lines = []
    const state = value?.state ?? value
    if (state?.setup) {
      lines.push(`setup: ${state.setup.installed ? 'installed' : 'not installed'}${state.setup.source ? ` (${state.setup.source})` : ''}${state.setup.installing ? ', installing' : ''}`)
      if (state.setup.backend) {
        const backend = state.setup.backend
        lines.push(
          `ssh backends: openssh=${backend.openssh ? 'available' : 'missing'} · paramiko=${backend.paramiko ? 'installed' : 'missing'}`,
        )
      }
      if (state.setup.cacheDir) lines.push(`cache: ${state.setup.cacheDir}`)
    }
    for (const runtime of state?.runtimes ?? []) {
      const daemon = runtime.daemon ? `; daemon: ${runtime.daemon.state}${runtime.daemon.summary ? ` (${runtime.daemon.summary})` : ''}` : ''
      const instance = runtime.instance
        ? `; instance: port ${runtime.instance.port}, pid ${runtime.instance.pid}, ${runtime.instance.work_dir}`
        : ''
      const compatibility = runtime.daemonCompatibility ? `; ${runtime.daemonCompatibility}` : ''
      const sub = runtime.subInstanceName ? ` [${runtime.subInstanceName}]` : ''
      const error = runtime.error ? `; error: ${truncate(String(runtime.error), 360)}` : ''
      const setup = runtime.setupHint && runtime.state !== 'running' && runtime.daemon?.state !== 'ready'
        ? `; CIW: ${runtime.setupHint}`
        : ''
      lines.push(`runtime ${runtime.id}:${sub} ${runtime.state}${daemon}${instance}${compatibility}${setup}${error}`)
    }
    for (const connection of state?.connections ?? []) {
      lines.push(
        `connection ${connection.name} (${connection.id}): ${connection.kind} ${connection.user ? `${connection.user}@` : ''}${connection.host}` +
          `${connection.autoSessions ? ' auto' : `:${connection.port}`}${connection.autoSessions && connection.instancePort ? ` instance:${connection.instancePort}` : ''}` +
          `${connection.sshPort && connection.sshPort !== 22 ? ` ssh:${connection.sshPort}` : ''} [${connection.runtime}${connection.daemon ? `/${connection.daemon.state}` : ''}]${connection.hasSecret ? ' [token stored]' : ''}`,
      )
    }
    for (const agent of state?.agents ?? []) {
      lines.push(`agent ${agent.sessionId}: ${agent.calls} calls, ${agent.live ? 'live' : 'closed'}, last ${new Date(agent.lastUsedAt).toISOString()}`)
    }
    for (const action of state?.activeActions ?? []) {
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
      message: truncate(error instanceof Error ? error.message : String(error), 1600),
      code: error?.code ?? 'ERROR',
      details: compactDetails(error?.details),
      hint: hintFor(error),
    },
  }
}

function compactDetails(details) {
  if (!details || typeof details !== 'object') return undefined
  return {
    stage: details.stage,
    message: details.message ? truncate(String(details.message), 1200) : undefined,
    host: details.host,
    sshPort: details.sshPort,
    sshBackend: details.sshBackend,
    hostKeys: details.probe?.entries
      ? details.probe.entries.map((entry) => ({ host: entry.host, type: entry.type, fingerprint: entry.fingerprint }))
      : undefined,
    pendingHostKey: details.pendingHostKey?.unknown
      ? {
          host: details.pendingHostKey.host,
          sshPort: details.pendingHostKey.sshPort,
          unknown: details.pendingHostKey.unknown.map((entry) => ({ type: entry.type, fingerprint: entry.fingerprint })),
          conflicts: (details.pendingHostKey.conflicts ?? []).map((conflict) => ({
            incoming: conflict.incoming?.fingerprint,
            existing: (conflict.existing ?? []).map((entry) => entry.fingerprint),
          })),
        }
      : undefined,
  }
}

function hintFor(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/host key|authenticity of host|remote host identification/i.test(message)) {
    return 'Ask the user to confirm the displayed fingerprint, then call virtuoso_bridge_runtime action "trust_host" with that fingerprint. Never trust a key without explicit confirmation.'
  }
  if (/openssh|ssh is not on path/i.test(message)) {
    return 'OpenSSH is missing. Installation can continue with the Paramiko backend after the user confirms; retry virtuoso_bridge_setup install with confirm=true.'
  }
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
  const awaitReady = async () => {
    if (manager.ready) await manager.ready
  }

  register({
    name: RUNTIME_TOOL,
    description:
      'Manage virtuoso-bridge-lite (Cadence Virtuoso) runtimes that this DSH profile keeps alive across conversations. ' +
      'Use action "status" first. "start" creates or reuses the managed SSH tunnel and daemon connection for a saved server connection; ' +
      'if the state is "waiting", the user must load the printed setup in the CIW. If the state is "needs-trust", show the fingerprint to the user, ' +
      'ask whether to trust it, and only then call action "trust_host" with that fingerprint. "stop" tears down the tunnel and daemon session. ' +
      'Also creates, updates, tests and shell-probes connection profiles; credentials are stored through DSH, never returned.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'start', 'stop', 'restart', 'ping', 'connections', 'save_connection', 'delete_connection', 'test_connection', 'instances', 'select_instance', 'deploy_daemon', 'detect_shell', 'host_key', 'trust_host', 'orphans', 'stop_orphan'],
          description: 'The runtime or connection operation to perform.',
        },
        connection: { type: 'string', description: 'Connection id or name; omit to use the default connection.' },
        runtime: { type: 'string', description: 'Runtime id (rt_...) when several runtimes exist.' },
        waitMs: { type: 'integer', description: 'Wait budget for status, start, or ping before returning a pending snapshot (default 15000; status waits for any state change).' },
        fingerprint: { type: 'string', description: 'For trust_host: the SHA256 fingerprint the user explicitly confirmed.' },
        port: { type: 'integer', description: 'For select_instance: the discovered daemon port to select.' },
        subInstance: { type: 'string', description: 'For start/restart: a configured workdir sub-instance id, name or absolute workdir.' },
        workDir: { type: 'string', description: 'For start/restart/instances: select or filter by an absolute remote working directory.' },
        replace: { type: 'boolean', description: 'For deploy_daemon: explicitly replace differing generated bootstrap files (never a shared setup).' },
        timeoutSec: { type: 'integer', description: 'For instances: discovery timeout in seconds (default 20).' },
        connectionConfig: {
          type: 'object',
          description: 'For save_connection: {name, host, user, port, autoSessions, instancePort, remoteWorkDir, daemonSetup, remoteScratchRoot, sshPort, jumpHost, jumpUser, kind, sshBackend, sshProxy, sshMaxSessions, daemonHost, deployHost, guiHost, spectreHost, envShell, cadenceEnvScript, identityFile, localPort, clientId, extraEnv, notes, enabled}. In fixed mode leave port blank to derive it from the SSH user; automatic sessions leave port unset.',
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
      await awaitReady()
      const agentId = exec.agent?.id
      try {
        switch (args.action) {
          case 'status':
          case 'list': {
            const settled = args.waitMs ? await manager.waitForStartSettled(args.waitMs) : !manager.hasPendingStart()
            return toolResult({ ok: true, state: manager.getAgentState(), pending: !settled })
          }
          case 'connections':
            return toolResult({
              ok: true,
              connections: manager.store.snapshot().connections.map((connection) => manager.compactConnection(manager.publicConnection(connection))),
            })
          case 'start':
            return toolResult({
              ok: true,
              runtime: manager.compactRuntime(
                await manager.startRuntime(args.connection, { waitMs: args.waitMs ?? 15_000, agentId, agent: exec.agent, subInstance: args.subInstance ?? args.workDir }),
              ),
            })
          case 'stop':
            return toolResult({
              ok: true,
              runtime: manager.compactRuntime(await manager.stopRuntime(args.runtime ?? args.connection, { agentId })),
            })
          case 'restart':
            return toolResult({
              ok: true,
              runtime: manager.compactRuntime(
                await manager.startRuntime(args.connection, { waitMs: args.waitMs ?? 15_000, agentId, agent: exec.agent, subInstance: args.subInstance ?? args.workDir, restart: true }),
              ),
            })
          case 'host_key': {
            const probe = await manager.inspectHostKey(args.connection ?? args.runtime)
            return toolResult({
              ok: probe.ok !== false,
              probe: {
                host: probe.host,
                sshPort: probe.sshPort,
                source: probe.source,
                entries: probe.entries ?? probe.probe?.entries ?? [],
                known: probe.known ?? probe.probe?.known ?? [],
                unknown: probe.unknown ?? probe.probe?.unknown ?? [],
                conflicts: probe.conflicts ?? probe.probe?.conflicts ?? [],
                error: probe.probe?.error,
              },
            })
          }
          case 'trust_host': {
            if (!args.fingerprint) throw new Error('fingerprint is required and must be explicitly confirmed by the user')
            const trust = await manager.trustHost(args.connection ?? args.runtime, args.fingerprint, {
              subInstance: args.subInstance,
              runtimeId: args.runtime,
            })
            return toolResult({
              ok: true,
              trust: {
                trusted: trust.trusted,
                already: trust.already,
                conflict: trust.conflict,
                message: trust.message,
                entry: trust.entry,
                connection: manager.compactConnection(trust.connection),
              },
            })
          }
          case 'detect_shell': {
            const detection = await manager.detectShell(args.connection ?? args.runtime, { agentId })
            return toolResult({
              ok: true,
              detection: {
                ok: detection.ok,
                recommended: detection.recommended,
                found: detection.found,
                reason: detection.reason,
                connection: manager.compactConnection(detection.connection),
                results: Object.fromEntries(
                  Object.entries(detection.results ?? {}).map(([shell, result]) => [
                    shell,
                    { ok: result.ok, found: result.found, returncode: result.returncode, error: result.error },
                  ]),
                ),
              },
            })
          }
          case 'ping': {
            const runtime = manager.runtimeRef(args.runtime ?? args.connection)
            if (!runtime) throw new Error('no managed runtime is available; start one first')
            const status = await runtime.sidecar.request('status', {}, 30_000)
            runtime.status = status
            runtime.lastHealthAt = Date.now()
            manager.emit()
            return toolResult({
              ok: true,
              runtime: manager.compactRuntime(manager.snapshotRuntime(runtime)),
              daemon: manager.daemonInfo(status.daemon),
            })
          }
          case 'save_connection': {
            if (!args.connectionConfig) throw new Error('connectionConfig is required')
            const saved = await manager.saveConnection(args.connectionConfig, args.secret)
            return toolResult({ ok: true, connection: manager.compactConnection(saved) })
          }
          case 'delete_connection':
            return toolResult({ ok: true, deleted: await manager.deleteConnection(args.connection) })
          case 'test_connection':
            return toolResult({ ok: true, result: await manager.testConnection(args.connection, { agentId }) })
          case 'instances':
            return toolResult({ ok: true, result: await manager.listInstances(args.connection, { timeoutSec: args.timeoutSec }) })
          case 'select_instance': {
            if (!args.port) throw new Error('port is required for select_instance')
            const current = manager.store.connection(manager.connectionRef(args.connection))
            if (!current) throw new Error(`unknown connection ${args.connection}`)
            const saved = await manager.saveConnection({ ...current, instancePort: Number(args.port) }, undefined, { restart: true })
            return toolResult({
              ok: true,
              connection: manager.compactConnection(saved),
              message: `instance selector set to port ${args.port}; an active runtime restarts against it, otherwise start it next`,
            })
          }
          case 'deploy_daemon':
            return toolResult({ ok: true, result: await manager.deployDaemon(args.connection, { replace: args.replace === true }) })
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
      await awaitReady()
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
      await awaitReady()
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
      'The Paramiko SSH extra is installed by default. If OpenSSH (ssh) is not on PATH, install stops and asks for confirmation before continuing with Paramiko only. ' +
      'Use action "status" before installing, "preflight" to inspect backends and source, "install" to create or repair the venv, "diagnose" for a readiness report, and "configure" or "set_source" to persist choices. ' +
      'Status and preflight return a compact state projection; use "diagnose" or the dashboard when plugin-level details are required. ' +
      'Installation may take minutes and returns a pending result after waitMs; poll "status".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'preflight', 'install', 'update', 'diagnose', 'configure', 'set_source', 'caches', 'clear_cache'], description: 'Setup operation.' },
        recreate: { type: 'boolean', description: 'Delete and recreate the venv before installing.' },
        confirm: { type: 'boolean', description: 'For install/update: the user approved installing without OpenSSH (Paramiko backend only).' },
        waitMs: { type: 'integer', description: 'How long install waits before returning (default 20000).' },
        source: {
          type: 'object',
          description: 'Source selection: {mode: bundled|local|git, localRepoPath, repoUrl, gitRef}.',
          additionalProperties: true,
        },
        settings: {
          type: 'object',
          description: 'Runtime defaults: {pythonPath, autoInstall, autoStart, defaultConnection, logToCiw, maxScripts, cacheDir, installSshExtra, defaultRemoteScratchRoot}.',
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
      await awaitReady()
      try {
        switch (args.action) {
          case 'status': {
            const setup = await manager.refreshSetup(true)
            return toolResult({ ok: true, setup: manager.compactSetup(setup) })
          }
          case 'preflight': {
            const preflight = await manager.setup.preflight()
            return toolResult({ ok: true, preflight: compactPreflight(preflight) })
          }
          case 'install':
          case 'update': {
            const waitMs = args.waitMs ?? 20_000
            const promise = manager.install({ recreate: args.recreate === true, agentId: exec.agent?.id, confirm: args.confirm === true })
            const result = await Promise.race([
              promise.then((value) => ({ done: true, value })),
              new Promise((resolve) => setTimeout(() => resolve({ done: false }), waitMs)),
            ])
            if (!result.done) {
              return toolResult({
                ok: true,
                pending: true,
                setup: manager.compactSetup(manager.setupStatus),
                message: 'installation is still running; poll action "status"',
              })
            }
            return toolResult({
              ok: result.value?.ok === true,
              install: {
                ok: result.value?.ok === true,
                version: result.value?.version,
                warnings: result.value?.warnings,
                needsConfirmation: result.value?.needsConfirmation === true,
                message: result.value?.message,
              },
              setup: manager.compactSetup(manager.setupStatus),
              needsConfirmation: result.value?.needsConfirmation === true,
              message: result.value?.message,
            })
          }
          case 'diagnose': {
            const diagnosis = await manager.diagnose({ agentId: exec.agent?.id })
            return toolResult({
              ok: diagnosis.ok,
              diagnosis: {
                ok: diagnosis.ok,
                checks: (diagnosis.checks ?? []).map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })),
              },
            })
          }
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
        `Installed virtuoso-bridge documentation and skills: ${manager.setup.instructionsDir}`,
        'Before using bridge commands, read the matching installed SKILL.md and references (relative to that directory); do not guess `virtuoso-bridge` CLI flags:',
        '  skills/virtuoso/SKILL.md, skills/spectre/SKILL.md, skills/netlist/SKILL.md, skills/optimizer/SKILL.md, skills/search/SKILL.md',
        '  skills/virtuoso/references/connection.md for connection, deployment, automatic sessions and instance selection.',
        'For long Maestro runs and dialogs, use the existing MaestroJobManager, client.dialogs and x11.dismiss_window APIs; the recipes are in references/agent-workflows.md. Do not add or expect a plugin-side runner, job store, dialog manager or scheduler.',
        'The installed skill catalog entry "virtuoso-bridge" indexes the same files.',
        '',
        `1. ${RUNTIME_TOOL} action "status" returns compact setup, connection, runtime, daemon, selected-instance and active-operation state. Add waitMs only while a start is in progress to wait for a state change. Start with action "start".`,
        '   A runtime may report "waiting": its SSH tunnel is up but the Virtuoso CIW has not loaded the bridge setup. Tell the user to run the printed load("...") line in the CIW, then poll status.',
        '   A runtime may report "needs-trust" on a first connection. The plugin opens a confirmation question in the conversation when a live agent is available; otherwise use the dashboard. Show the fingerprint and only call trust_host after the user confirms it.',
        '   The daemon field distinguishes a running daemon from an unreachable, auth-failed or version-mismatched daemon even when the SSH runtime is up. The instance field names the selected automatic-session port, Virtuoso PID and working directory.',
        '   For automatic sessions use action "instances" to list discoverable daemons, then action "select_instance" with the chosen port (or save a connection with autoSessions/instancePort) before starting. Do not guess a port when several instances match. Configured workdir sub-instances are started with subInstance (id, name or absolute workdir) and use their workdir as the discovery filter.',
        '   Use action "deploy_daemon" to prepare the account bootstrap without connecting; load the returned load line in the intended idle CIW. Shared setups managed by install-daemon are never replaced by a client.',
        `2. ${API_TOOL} action "describe" lists every public Python method and signature; action "call" invokes one on client, client.schematic, client.layout, client.library, client.symbol, client.maestro, client.sos, client.dialogs, client.requests or spectre.`,
        `3. ${SCRIPT_TOOL} runs batched Python in the isolated plugin venv. Use connect() inside the script to reuse the runtime; assign result for structured output.`,
        `4. ${SETUP_TOOL} installs or repairs the venv from the bundled snapshot, a local development checkout, or a git repository. It installs the Paramiko extra by default; if OpenSSH is missing it asks for confirmation before continuing with Paramiko only.`,
        '',
        'Connections use a fixed daemon port derived from the SSH user by default, or opt into automatic sessions with OS-assigned ports, an optional work-directory filter, a shared daemon setup path and an explicit instance-port selector. csh/sh is auto-detected from the configured Cadence environment script. Configuration, including the cache directory, is in the left sidebar\'s "Virtuoso Bridge" page.',
        'The background tunnel and daemon are process-wide and survive across conversations; the right-sidebar runtime panel (toggled from the composer when the current session has an active bridge) shows the same state. Never assume a background daemon is healthy: poll the runtime status before relying on it.',
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

function compactPreflight(preflight) {
  if (!preflight) return undefined
  return {
    ok: Boolean(preflight.python?.ok && preflight.source?.exists),
    python: { ok: Boolean(preflight.python?.ok), version: preflight.python?.version },
    source: preflight.source?.mode,
    installed: Boolean(preflight.installed),
    venvReady: Boolean(preflight.venv?.exists),
    backends: preflight.backends
      ? {
          openssh: { available: Boolean(preflight.backends.openssh?.available), version: preflight.backends.openssh?.version },
          paramiko: { installed: Boolean(preflight.backends.paramiko?.installed), version: preflight.backends.paramiko?.version },
          preferred: preflight.backends.preferred,
          needsConfirmation: Boolean(preflight.backends.needsConfirmation),
        }
      : undefined,
    needsConfirmation: Boolean(preflight.needsConfirmation),
    message: preflight.message,
  }
}
