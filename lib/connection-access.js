/**
 * The user-approval gate for connection-profile creation and retargeting.
 *
 * A saved connection is a standing grant: starting it opens an SSH session and
 * an authenticated bridge daemon on the remote account, where the agent can run
 * shell commands, Python and SKILL. Creating one — or pointing an existing row
 * at a different SSH target — is therefore a modification outside the
 * workspace. It asks the user once through the tools pipeline's approval seam,
 * unless the session already has Full access (`danger-full-access`), where no
 * larger grant remains to confirm.
 */

export const RUNTIME_TOOL_DEFAULT = 'virtuoso_bridge_runtime'
export const FULL_ACCESS_MODE = 'danger-full-access'

/**
 * Fields that define which account a connection can reach. Anything else on a
 * saved row (notes, scratch roots, sub-instances, environment) does not widen
 * access and can be updated without a new approval.
 */
const ACCESS_TARGET_FIELDS = [
  'host',
  'user',
  'sshPort',
  'jumpHost',
  'jumpUser',
  'daemonHost',
  'deployHost',
  'guiHost',
  'spectreHost',
]

/**
 * Resolve the saved row a `save_connection` input would update, mirroring
 * `BridgeManager#saveConnection`: an explicit id wins, otherwise a name.
 * @param {object|undefined} input - the raw `connectionConfig` argument.
 * @param {object|undefined} store - the settings store (`connection(ref)`).
 * @returns {object|undefined} the existing connection, if any.
 */
export function existingConnectionFor(input, store) {
  if (!input || typeof input !== 'object' || typeof store?.connection !== 'function') return undefined
  if (String(input.id ?? '').trim()) return store.connection(input.id)
  if (String(input.name ?? '').trim()) return store.connection(input.name)
  return undefined
}

function normalizedPort(raw) {
  const port = Number.parseInt(raw, 10)
  return Number.isFinite(port) && port > 0 ? String(port) : '22'
}

/**
 * The effective SSH target a save would persist. `normalizeConnection` derives
 * every one of these fields from the incoming input alone (it inherits only the
 * id, creation time and sub-instances), so an update that omits a target field
 * really does replace it and must be compared as such.
 */
function normalizedTarget(input) {
  return {
    host: String(input?.host ?? '').trim(),
    user: String(input?.user ?? '').trim(),
    sshPort: normalizedPort(input?.sshPort),
    jumpHost: String(input?.jumpHost ?? '').trim(),
    jumpUser: String(input?.jumpUser ?? '').trim(),
    daemonHost: String(input?.daemonHost ?? '').trim(),
    deployHost: String(input?.deployHost ?? '').trim(),
    guiHost: String(input?.guiHost ?? '').trim(),
    spectreHost: String(input?.spectreHost ?? '').trim(),
  }
}

/**
 * Whether saving `input` would create the row or move it to a different SSH
 * target. The comparison uses the store's normalization semantics, so an update
 * that drops a target field counts as a change, while an update that repeats
 * the target saves without a prompt.
 * @param {object} input - the raw `connectionConfig` argument.
 * @param {object|undefined} existing - the row the save would update.
 * @returns {boolean} true when the save grants a new or different target.
 */
export function accessTargetChanged(input, existing) {
  if (!existing) return true
  const next = normalizedTarget(input)
  const previous = normalizedTarget(existing)
  return ACCESS_TARGET_FIELDS.some((field) => next[field] !== previous[field])
}

/**
 * Human-readable `user@host:port via jump` label for the approval card.
 * @param {object} input - the raw `connectionConfig` argument.
 * @returns {string} the target as the user should read it.
 */
export function connectionAccessTarget(input) {
  const { host, user, sshPort, jumpHost } = normalizedTarget(input)
  let target = user ? `${user}@${host || 'an unspecified host'}` : host || 'an unspecified host'
  if (sshPort !== '22') target += `:${sshPort}`
  if (jumpHost) target += ` via ${jumpHost}`
  return target
}

function approvalText(name, target, retarget) {
  if (retarget) {
    return {
      en: `Point the existing connection "${name}" at ${target}? Starting it gives this agent full access on that host — shell, Python and SKILL — outside this workspace.`,
      zh: `将现有连接“${name}”改为指向 ${target}？启动后，该智能体将在这台主机上获得完全访问权限（shell、Python 与 SKILL），超出当前工作区。`,
    }
  }
  return {
    en: `Create the new connection "${name}" to ${target}? Starting it gives this agent full access on that host — shell, Python and SKILL — outside this workspace.`,
    zh: `创建到 ${target} 的新连接“${name}”？启动后，该智能体将在这台主机上获得完全访问权限（shell、Python 与 SKILL），超出当前工作区。`,
  }
}

function approvalDecision(input, existing) {
  const name = String(input.name ?? '').trim() ||
    String(existing?.name ?? '').trim() ||
    String(input.host ?? '').trim() ||
    'connection'
  const target = connectionAccessTarget(input)
  const retarget = Boolean(existing)
  const reason = retarget
    ? `retarget connection "${name}" to ${target}: a saved connection grants full access on that host outside this workspace`
    : `create connection "${name}" to ${target}: a saved connection grants full access on that host outside this workspace`
  return { kind: 'ask', reason, displayReason: approvalText(name, target, retarget) }
}

/**
 * Decide whether one tool execution needs the connection-access approval.
 * @param {object} request - decision inputs.
 * @param {string} request.toolName - the runtime tool's registered name.
 * @param {object} request.exec - the pending tool execution (name, arguments, agent).
 * @param {object} [request.store] - the settings store.
 * @param {string} [request.sandboxMode] - the session's effective DSH file policy.
 * @returns {object|undefined} an `ask` decision, or undefined when no approval is needed.
 */
export function connectionAccessDecision({ toolName, exec, store, sandboxMode }) {
  const args = exec?.arguments
  if (!exec || exec.name !== toolName || !exec.agent) return undefined
  if (!args || args.action !== 'save_connection') return undefined
  const input = args.connectionConfig
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  // A save without a host fails the store's own validation before anything is granted.
  if (!String(input.host ?? '').trim()) return undefined
  const existing = existingConnectionFor(input, store)
  if (existing && !accessTargetChanged(input, existing)) return undefined
  if (sandboxMode === FULL_ACCESS_MODE) return undefined
  return approvalDecision(input, existing)
}

/**
 * Build the `tools/pre-execute` listener. Returning `ask` makes the shared
 * pipeline resolve it through `ctx.approval`, so the standard permission card
 * warns the user and a rejection is final for that call.
 * @param {object} options - gate wiring.
 * @param {string} [options.toolName] - the runtime tool's registered name.
 * @param {object} [options.store] - the settings store.
 * @param {(exec: object) => string|undefined} [options.sandboxModeOf] - session policy lookup.
 * @returns {(exec: object, next: Function) => Promise<object>} the gate listener.
 */
export function createConnectionAccessGate({
  toolName = RUNTIME_TOOL_DEFAULT,
  store,
  sandboxModeOf,
} = {}) {
  return async function connectionAccessGate(exec, next) {
    const delegate = typeof next === 'function' ? next : () => Promise.resolve({ kind: 'allow' })
    if (exec?.name !== toolName || exec?.arguments?.action !== 'save_connection' || !exec?.agent) return delegate()
    const input = exec.arguments.connectionConfig
    if (!input || typeof input !== 'object' || Array.isArray(input)) return delegate()
    let decision
    try {
      decision = connectionAccessDecision({ toolName, exec, store, sandboxMode: sandboxModeOf?.(exec) })
    } catch {
      // A failed lookup must not silently open the gate: ask as for a new target.
      decision = approvalDecision(input, undefined)
    }
    return decision ?? delegate()
  }
}

/**
 * Read the session's effective DSH file policy. The sandbox policy service is
 * authoritative; the shell executor's composition default is the fallback for
 * profiles that mount no policy service.
 * @param {object} ctx - the plugin context.
 * @param {object} [agent] - the calling agent.
 * @returns {string|undefined} `read-only`, `workspace-write`, `danger-full-access` or undefined.
 */
export function sessionSandboxMode(ctx, agent) {
  if (!agent?.session) return undefined
  try {
    const policy = ctx?.get?.('sandboxPolicy')
    if (typeof policy?.resolve === 'function') {
      const mode = policy.resolve({ session: agent.session })?.mode
      // A policy service that cannot answer fails closed: ask instead of
      // assuming the deployment's unconfined default applies to this session.
      return typeof mode === 'string' ? mode : undefined
    }
  } catch {
    return undefined
  }
  try {
    const shell = ctx?.get?.('shell')
    return typeof shell?.sandboxMode === 'string' ? shell.sandboxMode : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the gate on the tools pipeline; the returned disposer removes it.
 * @param {object} options - installation inputs.
 * @param {object} options.ctx - the plugin context.
 * @param {object} options.manager - the bridge manager (provides `store`).
 * @param {string} [options.toolName] - the runtime tool's registered name.
 * @returns {() => void} disposer.
 */
export function installConnectionAccessGate({ ctx, manager, toolName = RUNTIME_TOOL_DEFAULT } = {}) {
  if (typeof ctx?.on !== 'function') return () => {}
  const gate = createConnectionAccessGate({
    toolName,
    store: manager?.store,
    sandboxModeOf: (exec) => sessionSandboxMode(ctx, exec?.agent),
  })
  return ctx.on('tools/pre-execute', gate)
}
