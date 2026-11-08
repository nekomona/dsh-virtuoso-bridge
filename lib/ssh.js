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
import { ensureDir, findExecutable, isLoopbackHost, readTail, runProcess } from './util.js'

export function knownHostsPath() {
  return process.env.VB_KNOWN_HOSTS || path.join(os.homedir(), '.ssh', 'known_hosts')
}

export function hostSpec(host, port) {
  const text = String(host ?? '').trim()
  const value = Number(port) || 22
  if (!text) return ''
  if (text.startsWith('[')) return text
  return value === 22 ? text : `[${text}]:${value}`
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

async function probeWithKeyscan(connection) {
  const executable = await findExecutable('ssh-keyscan')
  if (!executable) return { ok: false, entries: [], error: 'ssh-keyscan is not on PATH' }
  const port = Number(connection.sshPort) || 22
  const errors = []
  for (const extra of [[], ['-t', 'ed25519,ecdsa,rsa']]) {
    const args = ['-T', '8', '-p', String(port), ...extra, connection.host]
    const result = await runProcess(executable, args, { timeoutMs: 14_000, maxOutput: 120_000 })
    const entries = parseKeyScanOutput(result.stdout, connection.host)
    if (entries.length) return { ok: true, entries, source: 'ssh-keyscan', detail: result.stderr.trim().slice(-1000) }
    errors.push((result.stderr || result.stdout).trim().slice(-600))
  }
  return { ok: false, entries: [], error: errors.filter(Boolean).join(' | ') || 'ssh-keyscan returned no keys' }
}

async function probeWithSsh(connection, dataDir, options = {}) {
  const executable = await findExecutable('ssh')
  if (!executable) return { ok: false, entries: [], error: 'ssh is not on PATH' }
  const port = Number(connection.sshPort) || 22
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
    args.push('-J', connection.jumpUser ? `${connection.jumpUser}@${connection.jumpHost}` : connection.jumpHost)
  }
  if (connection.identityFile) args.push('-i', connection.identityFile)
  args.push(connection.user ? `${connection.user}@${connection.host}` : connection.host, 'true')
  try {
    const result = await runProcess(executable, args, { timeoutMs: 22_000, maxOutput: 120_000 })
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

async function probeWithParamiko(connection, options) {
  if (!options?.python) return { ok: false, entries: [], error: 'paramiko probe unavailable' }
  const script = options.pluginDir
    ? path.join(options.pluginDir, 'runtime', 'vb_hostkey_probe.py')
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'vb_hostkey_probe.py')
  const port = Number(connection.sshPort) || 22
  const args = [script, '--host', connection.host, '--port', String(port), '--timeout', '10']
  if (connection.jumpHost) {
    args.push('--jump-host', connection.jumpHost, '--jump-port', String(Number(connection.jumpPort) || 22))
    if (connection.jumpUser) args.push('--jump-user', connection.jumpUser)
  }
  const result = await runProcess(options.python, args, { timeoutMs: 25_000, maxOutput: 60_000 })
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
  const port = Number(connection.sshPort) || 22
  if (options.backend === 'paramiko') {
    // A Paramiko session must not launch ssh.exe (even a hidden console can
    // flash on Windows). Probe only through Paramiko for this backend.
    const probe = await probeWithParamiko(connection, options).catch((error) => ({
      ok: false,
      entries: [],
      source: 'paramiko',
      error: String(error),
    }))
    return probe.ok && probe.entries.length
      ? { ...probe, host: connection.host, port, backend: 'paramiko' }
      : {
          ok: false,
          local: false,
          entries: [],
          source: 'paramiko',
          backend: 'paramiko',
          host: connection.host,
          port,
          error: String(probe.error ?? 'Paramiko could not read a host key').slice(0, 2400),
        }
  }
  const first = await probeWithKeyscan(connection).catch((error) => ({ ok: false, entries: [], error: String(error) }))
  if (first.ok && first.entries.length) {
    return { ...first, host: connection.host, port }
  }
  const second = await probeWithSsh(connection, options.dataDir ?? path.join(os.homedir(), '.dsh', 'virtuoso-bridge'), options).catch(
    (error) => ({ ok: false, entries: [], error: String(error) }),
  )
  if (second.ok && second.entries.length) {
    return { ...second, host: connection.host, port, keyscanError: first.error }
  }
  const third = await probeWithParamiko(connection, options).catch((error) => ({ ok: false, entries: [], error: String(error) }))
  if (third.ok && third.entries.length) {
    return { ...third, host: connection.host, port, keyscanError: first.error, sshError: second.error }
  }
  return {
    ok: false,
    local: false,
    entries: [],
    host: connection.host,
    port,
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
  const result = await runProcess(sshKeygen, ['-F', hostspec, '-f', file], { timeoutMs: 8_000, maxOutput: 80_000 })
  if (result.ok || result.stdout.trim()) {
    // ssh-keygen -F already resolved the host, including hashed entries;
    // its output carries the hashed host field, so do not re-filter it.
    return parseKnownHostsText(result.stdout)
  }
  return []
}

export async function evaluateHostKeys(entries, connection, options = {}) {
  const known = []
  const unknown = []
  const conflicts = []
  for (const entry of entries) {
    const spec = entry.hostSpec || hostSpec(entry.host || connection.host, connection.sshPort)
    const existing = await lookupKnownHosts(spec, options)
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

async function appendKnownHost(entry, options) {
  const file = options.knownHostsPath ?? knownHostsPath()
  await ensureDir(path.dirname(file))
  try {
    await fsp.chmod(path.dirname(file), 0o700)
  } catch {
    // Windows ACLs are not POSIX modes.
  }
  const existing = await fsp.readFile(file, 'utf8').catch(() => '')
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  const line = `${entry.hostSpec || hostSpec(entry.host, options.port || 22)} ${entry.type} ${entry.key}\n`
  await fsp.appendFile(file, `${prefix}${line}`, 'utf8')
  try {
    await fsp.chmod(file, 0o600)
  } catch {
    // ignore
  }
}

export async function trustHostKey(connection, fingerprint, options = {}) {
  if (!fingerprint) throw new Error('fingerprint is required')
  const probe = await probeHostKeys(connection, options)
  if (!probe.ok || !probe.entries.length) {
    throw new Error(`could not read the host key: ${probe.error ?? 'no key offered'}`)
  }
  const entry = probe.entries.find((item) => item.fingerprint === fingerprint)
  if (!entry) {
    throw new Error(`the host did not offer a key with fingerprint ${fingerprint}; offered: ${probe.entries.map((item) => item.fingerprint).join(', ')}`)
  }
  const evaluation = await evaluateHostKeys(probe.entries, connection, options)
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
    return { trusted: true, already: true, entry }
  }
  await appendKnownHost(entry, options)
  return { trusted: true, already: false, entry, knownHosts: options.knownHostsPath ?? knownHostsPath() }
}
