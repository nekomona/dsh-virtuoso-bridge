/** SSH host-key discovery and explicit trust management.
 *
 * The bridge uses the system OpenSSH client (or Paramiko) with BatchMode=yes,
 * so an unknown host key fails before authentication with no usable
 * fingerprint in the error.  This module discovers the offered keys with
 * ssh-keyscan, falling back to a temporary known_hosts file populated by a
 * non-interactive ssh probe, computes SHA-256 fingerprints, and appends one
 * explicitly confirmed key to the user's known_hosts.  It never trusts a key
 * on its own.
 */
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeChildEnv, ensureDir, findExecutable, isLoopbackHost, readTail, runProcess } from './util.js'

/**
 * The user's OpenSSH known_hosts file.
 *
 * Deliberately not read from the environment: a second virtuoso-bridge
 * installation (or an export from its shell) could point the plugin at a
 * different file, so the fingerprints it reports would not be the ones the
 * real SSH client uses.
 */
export function knownHostsPath() {
  return path.join(os.homedir(), '.ssh', 'known_hosts')
}

export function hostSpec(host, port) {
  const text = String(host ?? '').trim()
  const value = Number(port) || 22
  if (!text) return ''
  if (text.startsWith('[')) return text
  return value === 22 ? text : `[${text}]:${value}`
}

/** Host part of a known_hosts host spec (`[host]:port` → `host`). */
export function hostOfSpec(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return ''
  const first = text.split(',')[0]
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(first)
  if (bracketed) return bracketed[1]
  return first.replace(/:\d+$/, '')
}

/** Parse `ssh -G` output (lower-cased `key value` lines). */
export function parseSshGOutput(stdout) {
  const values = {}
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const key = match[1].toLowerCase()
    if (values[key] === undefined) values[key] = match[2].trim()
  }
  return values
}

function endpointPort(connection, lookup, fallback) {
  const configured = Number(connection?.sshPort) || 22
  const resolved = Number.parseInt(String(lookup?.port ?? ''), 10)
  // A blank/default `sshPort` must not win over an ssh_config alias: a saved
  // tool-call connection usually leaves it at 22 while `~/.ssh/config` maps the
  // alias to another port. An explicit non-default port still wins.
  if (configured !== 22) return configured
  return Number.isFinite(resolved) && resolved > 0 ? resolved : (Number(fallback) || 22)
}

/**
 * The endpoint an SSH command really reaches for a saved connection.
 *
 * OpenSSH applies `HostName`, `Port` and `HostKeyAlias` from `~/.ssh/config`.
 * Probing the raw saved host/default port instead therefore reads a different
 * server's key, and its fingerprint does not match the locally saved host key.
 * This mirrors the Paramiko backend's resolution (which also reads `ssh -G`).
 *
 * Known-host names follow each backend's lookup rule: OpenSSH keys the entry by
 * the name given on the command line (the saved alias), Paramiko by the
 * resolved hostname; `HostKeyAlias` replaces both. Both names are returned so a
 * key saved by either install is found and trust writes one usable entry.
 */
export function endpointFromLookup(connection, lookup = {}, extras = {}) {
  const alias = String(connection?.host ?? '').trim()
  const hostname = String(lookup.hostname ?? '').trim() || alias
  const port = endpointPort(connection, lookup, extras.port)
  const user = String(connection?.user ?? '').trim() || String(lookup.user ?? '').trim() || undefined
  const hostKeyAlias = String(lookup.hostkeyalias ?? '').trim()
  const keyHosts = hostKeyAlias
    ? [hostKeyAlias]
    : [...new Set([alias, hostname].filter(Boolean))]
  return {
    local: false,
    source: extras.source ?? 'ssh-config',
    alias,
    host: hostname,
    port,
    user,
    hostKeyAlias: hostKeyAlias || undefined,
    keyHosts,
    knownHostSpecs: keyHosts.map((value) => hostSpec(value, port)),
  }
}

function localEndpoint(connection) {
  const host = String(connection?.host ?? '').trim()
  const port = Number(connection?.sshPort) || 22
  return {
    local: true,
    source: 'local',
    alias: host,
    host,
    port,
    user: String(connection?.user ?? '').trim() || undefined,
    keyHosts: host ? [host] : [],
    knownHostSpecs: host ? [hostSpec(host, port)] : [],
  }
}

async function sshGet(executable, target, options = {}) {
  const args = ['-G']
  if (options.sshConfigPath) args.push('-F', options.sshConfigPath)
  args.push(target)
  const result = await runProcess(executable, args, {
    timeoutMs: 10_000,
    maxOutput: 120_000,
    env: options.env ?? bridgeChildEnv(),
  })
  if (!result.ok) return undefined
  return parseSshGOutput(result.stdout)
}

async function resolveRoleEndpoint(roleHost, roleUser, rolePort, options = {}) {
  const host = String(roleHost ?? '').trim()
  if (!host) return undefined
  const connection = { host, user: roleUser, sshPort: rolePort }
  if (isLoopbackHost(host)) return localEndpoint(connection)
  const lookup = options.lookups?.[host] ?? await sshGet(options.sshExecutable, roleUser ? `${roleUser}@${host}` : host, options)
  if (!lookup) {
    return {
      ...endpointFromLookup(connection, {}, { source: 'connection' }),
      warning: options.sshExecutable ? 'ssh -G failed; used the saved host/port' : 'ssh is not on PATH; used the saved host/port',
    }
  }
  return endpointFromLookup(connection, lookup, { source: 'ssh-config' })
}

/**
 * Resolve the target (and jump) endpoint of a connection.
 *
 * `options.lookups` lets tests supply `ssh -G` output without spawning a
 * process.
 */
export async function resolveSshEndpoint(connection, options = {}) {
  if (!connection || isLoopbackHost(connection.host)) return localEndpoint(connection)
  const sshExecutable = options.sshExecutable ?? (await findExecutable('ssh'))
  const lookups = options.lookups ?? {}
  const target = await resolveRoleEndpoint(connection.host, connection.user, connection.sshPort, {
    ...options,
    sshExecutable,
    lookups,
  })
  let jump
  if (connection.jumpHost) {
    jump = await resolveRoleEndpoint(
      connection.jumpHost,
      connection.jumpUser,
      Number(connection.jumpPort) || 22,
      { ...options, sshExecutable, lookups },
    )
  }
  return { ...target, jump, sshAvailable: Boolean(sshExecutable) }
}

/** Join values so each known-host name is tried once. */
function uniqueSpecs(values) {
  return [...new Set((values ?? []).filter(Boolean))]
}

/**
 * Names an entry is known by.
 *
 * For a resolved target/jump entry these are the effective names only. The raw
 * probe spec still carries the saved alias at its default port, which is a
 * different endpoint; including it would turn an old entry for that endpoint
 * into a false "changed key" conflict.
 */
export function knownHostSpecsForEntry(entry, connection, endpoint) {
  if (entry?.knownHostSpecs?.length) return uniqueSpecs(entry.knownHostSpecs)
  if (entry?.role === 'target' && endpoint?.knownHostSpecs?.length) return uniqueSpecs(endpoint.knownHostSpecs)
  if (entry?.role === 'jump' && endpoint?.jump?.knownHostSpecs?.length) return uniqueSpecs(endpoint.jump.knownHostSpecs)
  if (entry?.hostSpec) return uniqueSpecs([entry.hostSpec])
  if (entry?.host) return uniqueSpecs([hostSpec(entry.host, endpoint?.port ?? connection?.sshPort)])
  return []
}

/**
 * Mark a probe entry as the target, the jump host, or another offered name and
 * attach the known-host names it must be evaluated/written under.
 */
export function annotateProbeEntries(entries, connection, endpoint) {
  const roleNames = (role) => {
    if (!role) return new Set()
    return new Set(
      [role.alias, role.host, ...(role.keyHosts ?? [])]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase().replace(/\.$/, '')),
    )
  }
  const targetNames = roleNames(endpoint)
  const jumpNames = roleNames(endpoint?.jump)
  for (const entry of entries ?? []) {
    const names = new Set(
      [entry.host, hostOfSpec(entry.hostSpec)]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase().replace(/\.$/, '')),
    )
    let role = 'target'
    if (endpoint?.jump && [...names].some((name) => jumpNames.has(name)) && ![...names].some((name) => targetNames.has(name))) {
      role = 'jump'
    } else if (![...names].some((name) => targetNames.has(name))) {
      role = 'other'
    }
    entry.role = role
    const roleEndpoint = role === 'jump' ? endpoint?.jump : role === 'target' ? endpoint : undefined
    if (roleEndpoint) {
      // Evaluation and trust must use the names the real backend looks up.
      // The raw probe spec keeps the saved alias/default port and must not be
      // written as a second, wrong known_hosts entry.
      entry.knownHostSpecs = uniqueSpecs(roleEndpoint.knownHostSpecs ?? [])
    } else {
      const raw = entry.hostSpec
        ? [entry.hostSpec]
        : entry.host
          ? [hostSpec(entry.host, Number(connection?.sshPort) || 22)]
          : []
      entry.knownHostSpecs = uniqueSpecs(raw)
    }
    if (roleEndpoint?.host) entry.resolvedHost = roleEndpoint.host
    if (roleEndpoint?.port) entry.resolvedPort = roleEndpoint.port
  }
  return entries
}

export function fingerprintOfKey(keyType, keyBlob) {
  const bytes = Buffer.from(String(keyBlob), 'base64')
  const digest = createHash('sha256').update(bytes).digest('base64').replace(/=+$/g, '')
  return `SHA256:${digest}`
}

function parseKeyLine(line, fallbackHost) {
  const text = line.trim()
  if (!text || text.startsWith('#') || text.startsWith('@')) return undefined
  const parts = text.split(/\s+/)
  if (parts.length < 3) return undefined
  const hosts = parts[0]
  const keyType = parts[1]
  const keyBlob = parts[2]
  if (!/^(ssh-|ecdsa-|sk-)/.test(keyType) || !keyBlob) return undefined
  const host = hosts.split(',')[0] || fallbackHost
  return {
    host,
    hostSpec: hosts,
    type: keyType,
    key: keyBlob,
    fingerprint: fingerprintOfKey(keyType, keyBlob),
    bits: keyType.startsWith('ssh-rsa') ? undefined : undefined,
  }
}

export function parseKeyScanOutput(stdout, fallbackHost) {
  const entries = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const entry = parseKeyLine(line, fallbackHost)
    if (entry) entries.push(entry)
  }
  return dedupeEntries(entries)
}

export function parseKnownHostsText(text) {
  const entries = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const entry = parseKeyLine(line, '')
    if (entry) entries.push(entry)
  }
  return dedupeEntries(entries)
}

function dedupeEntries(entries) {
  const seen = new Set()
  const output = []
  for (const entry of entries) {
    const key = `${entry.hostSpec}|${entry.type}|${entry.key}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(entry)
  }
  return output
}

async function probeWithKeyscan(connection, endpoint) {
  const executable = await findExecutable('ssh-keyscan')
  if (!executable) return { ok: false, entries: [], error: 'ssh-keyscan is not on PATH' }
  // keyscan ignores ~/.ssh/config, so scan the resolved HostName/Port: the
  // saved alias/default port can point at a different server entirely.
  const port = endpoint.port
  const errors = []
  for (const extra of [[], ['-t', 'ed25519,ecdsa,rsa']]) {
    const args = ['-T', '8', '-p', String(port), ...extra, endpoint.host]
    const result = await runProcess(executable, args, {
      env: bridgeChildEnv(),
      timeoutMs: 14_000,
      maxOutput: 120_000,
    })
    const entries = parseKeyScanOutput(result.stdout, connection.host)
    if (entries.length) return { ok: true, entries, source: 'ssh-keyscan', detail: result.stderr.trim().slice(-1000) }
    errors.push((result.stderr || result.stdout).trim().slice(-600))
  }
  return { ok: false, entries: [], error: errors.filter(Boolean).join(' | ') || 'ssh-keyscan returned no keys' }
}

async function probeWithSsh(connection, dataDir, options = {}, endpoint = endpointFromLookup(connection)) {
  const executable = await findExecutable('ssh')
  if (!executable) return { ok: false, entries: [], error: 'ssh is not on PATH' }
  const port = endpoint.port
  const tmpDir = path.join(dataDir, 'tmp')
  await ensureDir(tmpDir)
  const stamp = `${process.pid}-${Date.now()}`
  const userKnownHosts = path.join(tmpDir, `known_hosts-${stamp}`)
  const globalKnownHosts = path.join(tmpDir, `global_known_hosts-${stamp}`)
  await fsp.writeFile(userKnownHosts, '', 'utf8')
  await fsp.writeFile(globalKnownHosts, '', 'utf8')
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'HashKnownHosts=no',
    '-o', `UserKnownHostsFile=${userKnownHosts}`,
    '-o', `GlobalKnownHostsFile=${globalKnownHosts}`,
    '-o', 'GSSAPIAuthentication=no',
    '-p', String(port),
  ]
  if (options?.sshConfigPath) args.push('-F', options.sshConfigPath)
  if (connection.jumpHost) {
    const jump = endpoint.jump
    const jumpPort = Number(jump?.port) || Number(connection.jumpPort) || 22
    const jumpTarget = jumpPort === 22 ? connection.jumpHost : `${connection.jumpHost}:${jumpPort}`
    args.push('-J', connection.jumpUser ? `${connection.jumpUser}@${jumpTarget}` : jumpTarget)
  }
  if (connection.identityFile) args.push('-i', connection.identityFile)
  // Keep the saved name on the command line: OpenSSH looks the host key up by
  // that name (and writes it to the temporary known_hosts that way), while
  // HostName/Port/HostKeyAlias from the included ssh_config still apply.
  args.push(endpoint.user ? `${endpoint.user}@${connection.host}` : connection.host, 'true')
  try {
    const result = await runProcess(executable, args, {
      env: bridgeChildEnv(),
      timeoutMs: 22_000,
      maxOutput: 120_000,
    })
    const text = await readTail(userKnownHosts, 120_000)
    const entries = parseKnownHostsText(text)
    if (entries.length) return { ok: true, entries, source: 'ssh-probe', detail: result.stderr.trim().slice(-1000) }
    return {
      ok: false,
      entries: [],
      error: (result.stderr || result.stdout || 'ssh probe returned no host key').trim().slice(-1200),
    }
  } finally {
    await fsp.rm(userKnownHosts, { force: true }).catch(() => {})
    await fsp.rm(globalKnownHosts, { force: true }).catch(() => {})
  }
}

async function probeWithParamiko(connection, options, endpoint = endpointFromLookup(connection)) {
  if (!options?.python) return { ok: false, entries: [], error: 'paramiko probe unavailable' }
  const script = options.pluginDir
    ? path.join(options.pluginDir, 'runtime', 'vb_hostkey_probe.py')
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'vb_hostkey_probe.py')
  const port = endpoint.port
  const args = [script, '--host', endpoint.host, '--port', String(port), '--timeout', '10']
  if (connection.jumpHost) {
    const jump = endpoint.jump
    args.push(
      '--jump-host', jump?.host || connection.jumpHost,
      '--jump-port', String(Number(jump?.port) || Number(connection.jumpPort) || 22),
    )
    if (connection.jumpUser) args.push('--jump-user', connection.jumpUser)
  }
  const result = await runProcess(options.python, args, {
    env: bridgeChildEnv(),
    timeoutMs: 25_000,
    maxOutput: 60_000,
  })
  let parsed
  try {
    parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '')
  } catch {
    parsed = undefined
  }
  if (!parsed?.ok) {
    return { ok: false, entries: [], error: parsed?.error ?? (result.stderr || result.stdout).trim().slice(-800) }
  }
  const entries = parsed.entries?.length
    ? parsed.entries.map((entry) => ({
        host: entry.host ?? connection.host,
        hostSpec: entry.hostSpec ?? hostSpec(entry.host ?? connection.host, entry.port ?? port),
        type: entry.type,
        key: entry.key,
        fingerprint: entry.fingerprint,
      }))
    : [
        {
          host: connection.host,
          hostSpec: hostSpec(connection.host, port),
          type: parsed.type,
          key: parsed.key,
          fingerprint: parsed.fingerprint,
        },
      ]
  return {
    ok: true,
    entries,
    source: 'paramiko',
    detail: parsed.error,
  }
}

export async function probeHostKeys(connection, options = {}) {
  if (!connection || isLoopbackHost(connection.host)) {
    return { ok: true, local: true, entries: [], source: 'local', error: undefined }
  }
  const endpoint = options.endpoint ?? (await resolveSshEndpoint(connection, options))
  const port = endpoint.port
  const annotate = (probe) => {
    if (probe.ok && probe.entries?.length) annotateProbeEntries(probe.entries, connection, endpoint)
    return probe
  }
  if (options.backend === 'paramiko') {
    // A Paramiko probe must not launch a visible ssh.exe. The upstream
    // Paramiko backend already resolves HostName/Port with a hidden `ssh -G`;
    // this probe reuses that resolution and only dials through Paramiko.
    const probe = annotate(
      await probeWithParamiko(connection, options, endpoint).catch((error) => ({
        ok: false,
        entries: [],
        source: 'paramiko',
        error: String(error),
      })),
    )
    return probe.ok && probe.entries.length
      ? { ...probe, host: connection.host, port, backend: 'paramiko', endpoint }
      : {
          ok: false,
          local: false,
          entries: [],
          source: 'paramiko',
          backend: 'paramiko',
          host: connection.host,
          port,
          endpoint,
          error: String(probe.error ?? 'Paramiko could not read a host key').slice(0, 2400),
        }
  }
  const first = annotate(await probeWithKeyscan(connection, endpoint).catch((error) => ({ ok: false, entries: [], error: String(error) })))
  if (first.ok && first.entries.length) {
    return { ...first, host: connection.host, port, endpoint }
  }
  const second = annotate(
    await probeWithSsh(
      connection,
      options.dataDir ?? path.join(os.homedir(), '.dsh', 'virtuoso-bridge'),
      options,
      endpoint,
    ).catch((error) => ({ ok: false, entries: [], error: String(error) })),
  )
  if (second.ok && second.entries.length) {
    return { ...second, host: connection.host, port, endpoint, keyscanError: first.error }
  }
  const third = annotate(
    await probeWithParamiko(connection, options, endpoint).catch((error) => ({ ok: false, entries: [], error: String(error) })),
  )
  if (third.ok && third.entries.length) {
    return { ...third, host: connection.host, port, endpoint, keyscanError: first.error, sshError: second.error }
  }
  return {
    ok: false,
    local: false,
    entries: [],
    host: connection.host,
    port,
    endpoint,
    error: [first.error, second.error, third.error].filter(Boolean).join(' | ').slice(0, 2400),
  }
}

async function lookupKnownHosts(hostspec, options) {
  const file = options.knownHostsPath ?? knownHostsPath()
  const text = await fsp.readFile(file, 'utf8').catch(() => '')
  const parsed = parseKnownHostsText(text).filter((entry) => {
    const hosts = entry.hostSpec.split(',')
    return hosts.some((host) => host === hostspec || host === `[${hostspec}]` || hostspec === `[${host}]`)
  })
  if (parsed.length) return parsed
  const sshKeygen = await findExecutable('ssh-keygen')
  if (!sshKeygen) return []
  const result = await runProcess(sshKeygen, ['-F', hostspec, '-f', file], {
    env: bridgeChildEnv(),
    timeoutMs: 8_000,
    maxOutput: 80_000,
  })
  if (result.ok || result.stdout.trim()) {
    // ssh-keygen -F already resolved the host, including hashed entries;
    // its output carries the hashed host field, so do not re-filter it.
    return parseKnownHostsText(result.stdout)
  }
  return []
}

async function lookupKnownHostsSpecs(specs, options) {
  const seen = new Set()
  const output = []
  for (const spec of specs) {
    for (const entry of await lookupKnownHosts(spec, options)) {
      const key = `${entry.type}|${entry.key}`
      if (seen.has(key)) continue
      seen.add(key)
      output.push(entry)
    }
  }
  return output
}

export async function evaluateHostKeys(entries, connection, options = {}) {
  const known = []
  const unknown = []
  const conflicts = []
  const endpoint = options.endpoint
  for (const entry of entries) {
    // Look the offered key up under every name this backend may use: the
    // saved alias (OpenSSH), the resolved HostName (Paramiko) and an explicit
    // HostKeyAlias. Comparing only the raw saved spec reported a key that is
    // already trusted as unknown whenever ssh_config remapped the host.
    const specs = knownHostSpecsForEntry(entry, connection, endpoint)
    const existing = await lookupKnownHostsSpecs(specs, options)
    // A server normally offers several host key types (ed25519, ecdsa, rsa).
    // known_hosts normally holds only some of them, so compare against the
    // entries of the same type: an absent type is "unknown" (never confirmed)
    // and only a different key of a type we already stored is a conflict.
    // Treating the other types as a conflict made a host with a trusted
    // ed25519 key look as if its identity had changed merely because it also
    // offered an RSA key that was never trusted.
    const sameType = existing.filter((item) => item.type === entry.type)
    if (!sameType.length) {
      unknown.push(entry)
      continue
    }
    if (sameType.some((item) => item.key === entry.key)) {
      known.push(entry)
    } else {
      conflicts.push({ incoming: entry, existing: sameType })
    }
  }
  return { known, unknown, conflicts }
}

/**
 * Render the generated OpenSSH config for one connection.
 *
 * ``HostKeyAlgorithms`` pinning is only meaningful for the OpenSSH backend.
 * The Paramiko backend resolves this file through ``ssh -G`` and applies its
 * own ``RejectPolicy`` against known_hosts; it rejects the canonical
 * ``StrictHostKeyChecking=true`` that OpenSSH prints for ``yes``, and it does
 * not consume ``HostKeyAlgorithms`` at all. Writing a pinned block for a
 * Paramiko connection therefore makes every start fail with
 * "Paramiko backend requires recorded host keys". Keep Paramiko's config
 * plain (and, as before, only generate one for an identity or custom port).
 */
export function buildSshConfig({
  connection,
  hosts,
  sshPort,
  include = '',
  hostKeyAlgorithms = [],
} = {}) {
  const backend = String(connection?.sshBackend ?? '').trim().toLowerCase()
  const pinned = backend === 'paramiko' ? [] : [...new Set(hostKeyAlgorithms.filter(Boolean))]
  const cleanHosts = [...new Set((hosts ?? []).filter(Boolean))]
  const lines = []
  if (pinned.length) {
    // Before the user's config is included: ssh keeps the first value it
    // obtains, so the pin wins over a `Host *` line in ~/.ssh/config.
    for (const host of cleanHosts) {
      lines.push(
        `Host ${host}\n`,
        `  HostKeyAlgorithms ${pinned.join(',')}\n`,
        '  StrictHostKeyChecking yes\n',
      )
    }
  } else {
    // Historical precedence for ordinary configs: the user's ~/.ssh/config is
    // included first and wins for overlapping connection fields (port, user,
    // identity, proxy, aliases).
    lines.push(include)
  }
  for (const host of cleanHosts) {
    lines.push(
      `Host ${host}\n`,
      `  Port ${sshPort}\n`,
      connection?.identityFile ? `  IdentityFile "${connection.identityFile.replace(/\\/g, '/')}"\n` : '',
      connection?.user ? `  User ${connection.user}\n` : '',
      connection?.identityFile ? '  IdentitiesOnly yes\n' : '',
    )
  }
  if (pinned.length) {
    // Include last only when pinning: Port/User/IdentityFile keep the old
    // user-config precedence, while the key-type pin above is authoritative.
    lines.push(include)
  }
  return { text: lines.join(''), pinned: pinned.length > 0, algorithms: pinned }
}

/**
 * OpenSSH ``HostKeyAlgorithms`` names for the trusted known_hosts key types.
 *
 * A known_hosts entry keeps the key type (``ssh-rsa``), while an RSA handshake
 * negotiates one of its signature variants (``rsa-sha2-512`` and friends).
 * Pinning the generated SSH config to the types the user already trusts means
 * an extra or changed key type that the server also offers can never be the
 * one negotiated, so proceeding with a host that has one trusted type is safe.
 */
export function hostKeyAlgorithmsForTypes(types, options = {}) {
  const algorithms = []
  for (const raw of types ?? []) {
    const type = String(raw ?? '').trim()
    if (!type) continue
    if (type === 'ssh-rsa') {
      algorithms.push('rsa-sha2-512', 'rsa-sha2-256')
      if (!options.excludeSha1Rsa) algorithms.push('ssh-rsa')
    } else if (/^(ssh-ed25519|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/.test(type)) {
      algorithms.push(type)
    }
  }
  return [...new Set(algorithms)]
}

async function missingKnownHostSpecs(entry, options) {
  const specs = uniqueSpecs(
    (entry.knownHostSpecs ?? []).length
      ? entry.knownHostSpecs
      : [entry.hostSpec || hostSpec(entry.host, options.port || 22)],
  )
  const missing = []
  for (const spec of specs) {
    const existing = await lookupKnownHosts(spec, options)
    if (!existing.some((item) => item.type === entry.type && item.key === entry.key)) missing.push(spec)
  }
  return missing
}

async function appendKnownHost(entry, options, onlySpecs) {
  const file = options.knownHostsPath ?? knownHostsPath()
  await ensureDir(path.dirname(file))
  try {
    await fsp.chmod(path.dirname(file), 0o700)
  } catch {
    // Windows ACLs are not POSIX modes.
  }
  const existing = await fsp.readFile(file, 'utf8').catch(() => '')
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  // A remapped host has one key under two names: the saved alias (OpenSSH's
  // lookup name) and the resolved HostName (Paramiko's). Write the same, proven
  // key under each so either backend can verify this host afterwards.
  const specs = uniqueSpecs(
    onlySpecs?.length
      ? onlySpecs
      : (entry.knownHostSpecs ?? []).length
        ? entry.knownHostSpecs
        : [entry.hostSpec || hostSpec(entry.host, options.port || 22)],
  )
  if (!specs.length) return
  const lines = specs.map((spec) => `${spec} ${entry.type} ${entry.key}`).join('\n')
  await fsp.appendFile(file, `${prefix}${lines}\n`, 'utf8')
  try {
    await fsp.chmod(file, 0o600)
  } catch {
    // ignore
  }
}

export async function trustHostKey(connection, fingerprint, options = {}) {
  if (!fingerprint) throw new Error('fingerprint is required')
  const probe = options.probe ?? (await probeHostKeys(connection, options))
  if (!probe.ok || !probe.entries.length) {
    throw new Error(`could not read the host key: ${probe.error ?? 'no key offered'}`)
  }
  const entry = probe.entries.find((item) => item.fingerprint === fingerprint)
  if (!entry) {
    throw new Error(`the host did not offer a key with fingerprint ${fingerprint}; offered: ${probe.entries.map((item) => item.fingerprint).join(', ')}`)
  }
  // The agent supplies the fingerprint it showed the user, but only a key this
  // fresh probe actually offered is ever written: the probe result is the
  // authority, never the tool argument.
  const evaluation = await evaluateHostKeys(probe.entries, connection, {
    ...options,
    endpoint: options.endpoint ?? probe.endpoint,
  })
  const conflict = evaluation.conflicts.find((item) => item.incoming.fingerprint === fingerprint)
  if (conflict) {
    return {
      trusted: false,
      conflict: true,
      entry,
      existing: conflict.existing,
      message: 'the host key changed; remove the old known_hosts entry manually before trusting the new key',
    }
  }
  if (evaluation.known.some((item) => item.fingerprint === fingerprint)) {
    // The key is trusted under at least one name. A remapped host may also be
    // looked up under the other name (for example OpenSSH's saved alias vs the
    // Paramiko HostName); fill those missing entries so both backends agree.
    const missing = await missingKnownHostSpecs(entry, options)
    if (missing.length) {
      await appendKnownHost(entry, options, missing)
      return { trusted: true, already: true, added: missing, entry, knownHosts: options.knownHostsPath ?? knownHostsPath() }
    }
    return { trusted: true, already: true, entry }
  }
  await appendKnownHost(entry, options)
  return { trusted: true, already: false, entry, knownHosts: options.knownHostsPath ?? knownHostsPath() }
}
