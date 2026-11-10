import assert from 'node:assert/strict'
import test from 'node:test'
import {
  connectionAccessDecision,
  createConnectionAccessGate,
  installConnectionAccessGate,
  sessionSandboxMode,
} from '../lib/connection-access.js'
import { registerTools } from '../lib/tools.js'

const TOOL = 'virtuoso_bridge_runtime'

const LAB = {
  id: 'conn_lab',
  name: 'lab',
  kind: 'remote',
  host: 'lab.example',
  user: 'designer',
  sshPort: 22,
  jumpHost: '',
  jumpUser: '',
  daemonHost: '',
  deployHost: '',
  guiHost: '',
  spectreHost: '',
}

function storeWith(connections = []) {
  return {
    connection(ref) {
      if (!ref) return undefined
      const text = String(ref)
      return (
        connections.find((item) => item.id === text) ??
        connections.find((item) => item.name === text) ??
        connections.find((item) => item.name.toLowerCase() === text.toLowerCase())
      )
    },
  }
}

function execOf(args, { name = TOOL, agent = { session: { id: 'session_test' } } } = {}) {
  return { name, arguments: args, agent }
}

function decision(request) {
  return connectionAccessDecision({ toolName: TOOL, ...request })
}

test('creating a connection asks for approval under a confined sandbox', () => {
  const result = decision({
    exec: execOf({
      action: 'save_connection',
      connectionConfig: { name: 'new-lab', host: 'new.example', user: 'designer' },
    }),
    store: storeWith([LAB]),
    sandboxMode: 'workspace-write',
  })
  assert.equal(result.kind, 'ask')
  assert.match(result.reason, /create connection "new-lab"/)
  assert.match(result.reason, /designer@new\.example/)
  assert.match(result.reason, /full access/)
  assert.match(result.displayReason.en, /Create the new connection "new-lab" to designer@new\.example/)
  assert.match(result.displayReason.zh, /new-lab/)
  assert.match(result.displayReason.zh, /new\.example/)
})

test('Full access skips the approval', () => {
  const result = decision({
    exec: execOf({
      action: 'save_connection',
      connectionConfig: { name: 'new-lab', host: 'new.example' },
    }),
    store: storeWith([]),
    sandboxMode: 'danger-full-access',
  })
  assert.equal(result, undefined)
})

test('updating an existing connection without changing its SSH target is not gated', () => {
  const result = decision({
    exec: execOf({
      action: 'save_connection',
      connectionConfig: { id: 'conn_lab', host: 'lab.example', user: 'designer', remoteWorkDir: '/projects/new' },
    }),
    store: storeWith([LAB]),
    sandboxMode: 'workspace-write',
  })
  assert.equal(result, undefined)
})

test('same-name save updates the row and is not gated', () => {
  const result = decision({
    exec: execOf({
      action: 'save_connection',
      connectionConfig: { name: 'LAB', host: 'lab.example', user: 'designer', notes: 'renamed note' },
    }),
    store: storeWith([LAB]),
    sandboxMode: 'workspace-write',
  })
  assert.equal(result, undefined, 'the store resolves names case-insensitively')
})

test('pointing an existing connection at another host asks for approval', () => {
  const result = decision({
    exec: execOf({
      action: 'save_connection',
      connectionConfig: { id: 'conn_lab', host: 'other.example' },
    }),
    store: storeWith([LAB]),
    sandboxMode: 'workspace-write',
  })
  assert.equal(result.kind, 'ask')
  assert.match(result.reason, /retarget connection "lab"/)
  assert.match(result.displayReason.en, /Point the existing connection "lab" at other\.example/)
})

test('changing the SSH account, port, jump host or role host asks for approval', () => {
  for (const patch of [
    { user: 'root' },
    { sshPort: 2222 },
    { jumpHost: 'bastion.example' },
    { daemonHost: 'daemon.example' },
    { spectreHost: 'spectre.example' },
  ]) {
    const result = decision({
      exec: execOf({ action: 'save_connection', connectionConfig: { id: 'conn_lab', host: 'lab.example', ...patch } }),
      store: storeWith([LAB]),
      sandboxMode: 'workspace-write',
    })
    assert.equal(result?.kind, 'ask', `expected approval for ${JSON.stringify(patch)}`)
  }
})

test('an update that drops a target field counts as an access change', () => {
  const result = decision({
    exec: execOf({
      action: 'save_connection',
      connectionConfig: { id: 'conn_lab', host: 'lab.example' },
    }),
    store: storeWith([LAB]),
    sandboxMode: 'workspace-write',
  })
  assert.equal(result.kind, 'ask', 'omitting user would drop the saved SSH account')
  assert.match(result.displayReason.en, /at lab\.example/)
})

test('non-connection actions are never gated', () => {
  for (const action of ['start', 'status', 'delete_connection', 'test_connection']) {
    assert.equal(
      decision({ exec: execOf({ action }), store: storeWith([LAB]), sandboxMode: 'read-only' }),
      undefined,
    )
  }
})

test('other tools, agentless calls and empty configs are never gated', () => {
  assert.equal(
    decision({
      exec: execOf({ action: 'save_connection', connectionConfig: { name: 'x', host: 'x.example' } }, { name: 'other_tool' }),
      store: storeWith([]),
      sandboxMode: 'workspace-write',
    }),
    undefined,
  )
  assert.equal(
    decision({
      exec: execOf({ action: 'save_connection', connectionConfig: { name: 'x', host: 'x.example' } }, { agent: null }),
      store: storeWith([]),
      sandboxMode: 'workspace-write',
    }),
    undefined,
  )
  assert.equal(decision({ exec: execOf({ action: 'save_connection' }), store: storeWith([]) }), undefined)
})

test('a save without a host is left to the normal validation error', () => {
  assert.equal(
    decision({
      exec: execOf({ action: 'save_connection', connectionConfig: { name: 'no-host' } }),
      store: storeWith([]),
      sandboxMode: 'workspace-write',
    }),
    undefined,
  )
  assert.equal(
    decision({
      exec: execOf({ action: 'save_connection', connectionConfig: { id: 'conn_lab', notes: 'no host here' } }),
      store: storeWith([LAB]),
      sandboxMode: 'workspace-write',
    }),
    undefined,
  )
})

test('the gate listener delegates untouched calls and returns ask for new ones', async () => {
  const store = storeWith([LAB])
  const gate = createConnectionAccessGate({ toolName: TOOL, store, sandboxModeOf: () => 'workspace-write' })
  let delegated = 0
  const next = async () => {
    delegated += 1
    return { kind: 'allow' }
  }

  assert.deepEqual(await gate(execOf({ action: 'status' }), next), { kind: 'allow' })
  assert.equal(delegated, 1)

  const ask = await gate(
    execOf({ action: 'save_connection', connectionConfig: { name: 'fresh', host: 'fresh.example' } }),
    next,
  )
  assert.equal(ask.kind, 'ask')
  assert.equal(delegated, 1, 'an ask decision must not fall through to later listeners')

  assert.deepEqual(
    await gate(
      execOf({
        action: 'save_connection',
        connectionConfig: { id: 'conn_lab', host: 'lab.example', user: 'designer', notes: 'x' },
      }),
      next,
    ),
    { kind: 'allow' },
  )
  assert.equal(delegated, 2)
})

test('a failing store lookup fails closed to an approval', async () => {
  const gate = createConnectionAccessGate({
    toolName: TOOL,
    store: {
      connection() {
        throw new Error('settings are unreadable')
      },
    },
    sandboxModeOf: () => 'workspace-write',
  })
  const ask = await gate(
    execOf({ action: 'save_connection', connectionConfig: { name: 'fresh', host: 'fresh.example' } }),
    async () => ({ kind: 'allow' }),
  )
  assert.equal(ask.kind, 'ask')
})

test('sessionSandboxMode prefers the sandbox policy and falls back to the shell executor', () => {
  const session = { id: 's1' }
  const policyCtx = {
    get: (name) => (name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined),
  }
  const shellCtx = {
    get: (name) => (name === 'shell' ? { sandboxMode: 'workspace-write' } : undefined),
  }
  assert.equal(sessionSandboxMode(policyCtx, { session }), 'danger-full-access')
  assert.equal(sessionSandboxMode(shellCtx, { session }), 'workspace-write')
  assert.equal(sessionSandboxMode({ get: () => undefined }, { session }), undefined)
  const brokenPolicyCtx = {
    get: (name) => (name === 'sandboxPolicy' ? { resolve: () => { throw new Error('projection unavailable') } } : { sandboxMode: 'danger-full-access' }),
  }
  assert.equal(
    sessionSandboxMode(brokenPolicyCtx, { session }),
    undefined,
    'a failing policy service must not fall back to an unconfined default',
  )
})

test('install registers the gate on tools/pre-execute and removes it on dispose', async () => {
  const handlers = new Set()
  const ctx = {
    on(event, handler) {
      assert.equal(event, 'tools/pre-execute')
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    get(name) {
      return name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined
    },
  }
  const dispose = installConnectionAccessGate({ ctx, manager: { store: storeWith([]) }, toolName: TOOL })
  assert.equal(handlers.size, 1)
  const [gate] = handlers
  const ask = await gate(
    execOf({ action: 'save_connection', connectionConfig: { name: 'fresh', host: 'fresh.example' } }),
    async () => ({ kind: 'allow' }),
  )
  assert.equal(ask.kind, 'ask')
  dispose()
  assert.equal(handlers.size, 0)
})

test('install uses the Full access session policy to skip the warning', async () => {
  let gate
  const ctx = {
    on(_event, handler) {
      gate = handler
      return () => {}
    },
    get(name) {
      return name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined
    },
  }
  installConnectionAccessGate({ ctx, manager: { store: storeWith([]) }, toolName: TOOL })
  const result = await gate(
    execOf({ action: 'save_connection', connectionConfig: { name: 'fresh', host: 'fresh.example' } }),
    async () => ({ kind: 'allow' }),
  )
  assert.deepEqual(result, { kind: 'allow' })
})

test('registerTools installs the gate and disposes it with the tools', async () => {
  const listeners = new Map()
  const ctx = {
    tools: { register: () => () => {} },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    get(name) {
      return name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined
    },
  }
  const manager = { ready: undefined, setup: { instructionsDir: 'docs' }, store: storeWith([]) }
  const tools = registerTools({ ctx, manager, log: () => {} })
  const gate = listeners.get('tools/pre-execute')
  assert.equal(typeof gate, 'function')
  const ask = await gate(
    execOf({ action: 'save_connection', connectionConfig: { name: 'fresh', host: 'fresh.example' } }),
    async () => ({ kind: 'allow' }),
  )
  assert.equal(ask.kind, 'ask')
  tools.dispose()
  assert.equal(listeners.size, 0)
})
