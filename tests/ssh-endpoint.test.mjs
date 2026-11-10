import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyHostKeyState } from '../lib/manager.js'
import {
  annotateProbeEntries,
  endpointFromLookup,
  evaluateHostKeys,
  fingerprintOfKey,
  parseSshGOutput,
  resolveSshEndpoint,
  trustHostKey,
} from '../lib/ssh.js'

const connection = { host: 'lab', user: 'designer', sshPort: 22, sshBackend: 'openssh' }
const key = 'AAAAC3NzaC1lZDI1NTE5AAAAIEd25519keyblob'
const otherKey = 'AAAAC3NzaC1lZDI1NTE5AAAAIEd25519otherblob'

async function withKnownHosts(lines, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-endpoint-'))
  const file = path.join(dir, 'known_hosts')
  await fs.writeFile(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  try {
    return await fn({ knownHostsPath: file, dir })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function offer(host, type, blob, extra = {}) {
  return { host, hostSpec: host, type, key: blob, fingerprint: fingerprintOfKey(type, blob), ...extra }
}

test('ssh -G output is parsed without trusting later duplicates', () => {
  const lookup = parseSshGOutput('user designer\nhostname lab-host.example\nport 2222\nhostkeyalias lab-alias\nport 22\n')
  assert.equal(lookup.user, 'designer')
  assert.equal(lookup.hostname, 'lab-host.example')
  assert.equal(lookup.port, '2222')
  assert.equal(lookup.hostkeyalias, 'lab-alias')
})

test('a default sshPort yields to the ssh_config alias port', () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222', user: 'designer' })
  assert.equal(endpoint.host, 'lab-host.example')
  assert.equal(endpoint.port, 2222)
  assert.deepEqual(endpoint.knownHostSpecs, ['[lab]:2222', '[lab-host.example]:2222'])
})

test('an explicit non-default sshPort still wins over ssh_config', () => {
  const endpoint = endpointFromLookup({ ...connection, sshPort: 2200 }, { hostname: 'lab-host.example', port: '2222' })
  assert.equal(endpoint.port, 2200)
})

test('HostKeyAlias replaces both lookup names', () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222', hostkeyalias: 'lab-alias' })
  assert.deepEqual(endpoint.keyHosts, ['lab-alias'])
  assert.deepEqual(endpoint.knownHostSpecs, ['[lab-alias]:2222'])
})

test('endpoint resolution is injectable and never dials in tests', async () => {
  const endpoint = await resolveSshEndpoint(connection, {
    lookups: { lab: { hostname: 'lab-host.example', port: '2222', user: 'designer' } },
  })
  assert.equal(endpoint.host, 'lab-host.example')
  assert.equal(endpoint.port, 2222)
})

test('a loopback connection never resolves an SSH endpoint', async () => {
  const endpoint = await resolveSshEndpoint({ host: '127.0.0.1', sshPort: 22 })
  assert.equal(endpoint.local, true)
})

test('a key saved under the resolved hostname is trusted even when the alias differs', async () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222' })
  const entries = annotateProbeEntries([offer('lab', 'ssh-ed25519', key)], connection, endpoint)
  await withKnownHosts([`[lab-host.example]:2222 ssh-ed25519 ${key}`], async (options) => {
    const evaluation = await evaluateHostKeys(entries, connection, { ...options, endpoint })
    assert.equal(evaluation.known.length, 1)
    assert.equal(evaluation.unknown.length, 0)
    assert.equal(evaluation.conflicts.length, 0)
  })
})

test('a key saved under the saved alias is trusted too', async () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222' })
  const entries = annotateProbeEntries([offer('lab', 'ssh-ed25519', key)], connection, endpoint)
  await withKnownHosts([`[lab]:2222 ssh-ed25519 ${key}`], async (options) => {
    const evaluation = await evaluateHostKeys(entries, connection, { ...options, endpoint })
    assert.equal(evaluation.known.length, 1)
  })
})

test('a different key of a stored type stays a conflict under the resolved name', async () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222' })
  const entries = annotateProbeEntries([offer('lab', 'ssh-ed25519', otherKey)], connection, endpoint)
  await withKnownHosts([`[lab-host.example]:2222 ssh-ed25519 ${key}`], async (options) => {
    const evaluation = await evaluateHostKeys(entries, connection, { ...options, endpoint })
    assert.equal(evaluation.known.length, 0)
    assert.equal(evaluation.conflicts.length, 1)
  })
})

test('a jump-host entry is labelled and evaluated under the jump host name', async () => {
  const jumpConnection = { host: 'target.example', user: 'designer', sshPort: 22, jumpHost: 'jump.example', jumpUser: 'designer' }
  const endpoint = {
    ...endpointFromLookup(jumpConnection, { hostname: 'target.example', port: '22' }),
    jump: endpointFromLookup({ host: 'jump.example', user: 'designer', sshPort: 22 }, { hostname: 'jump-host.example', port: '22' }),
  }
  const entries = annotateProbeEntries(
    [offer('target.example', 'ssh-ed25519', key), offer('jump.example', 'ssh-ed25519', otherKey)],
    jumpConnection,
    endpoint,
  )
  assert.equal(entries[0].role, 'target')
  assert.equal(entries[1].role, 'jump')
  assert.deepEqual(entries[1].knownHostSpecs, ['jump.example', 'jump-host.example'])
})

test('a known target never masks an untrusted jump host', () => {
  const target = offer('lab', 'ssh-ed25519', key, { role: 'target' })
  const jump = offer('jump.example', 'ssh-ed25519', otherKey, { role: 'jump' })
  const state = classifyHostKeyState({ known: [target], unknown: [jump], entries: [target, jump] })
  assert.equal(state.needsTrust, true)
  assert.equal(state.jumpTrusted, false)
  assert.deepEqual(state.unknownToTrust.map((entry) => entry.role), ['jump'])
})

test('an untrusted extra key type does not block a host with a trusted type', () => {
  const trusted = offer('lab', 'ssh-ed25519', key, { role: 'target' })
  const extra = offer('lab', 'ssh-rsa', otherKey, { role: 'target' })
  const state = classifyHostKeyState({ known: [trusted], unknown: [extra], entries: [trusted, extra] })
  assert.equal(state.needsTrust, false)
  assert.deepEqual(state.pinTypes, ['ssh-ed25519'])
})

test('a conflicting key blocks only when that endpoint has no trusted type', () => {
  const trusted = offer('lab', 'ssh-ed25519', key, { role: 'target' })
  const changedExtra = { incoming: offer('lab', 'ssh-rsa', otherKey, { role: 'target' }), existing: [] }
  const tolerated = classifyHostKeyState({ known: [trusted], conflicts: [changedExtra], entries: [trusted, changedExtra.incoming] })
  assert.equal(tolerated.needsTrust, false)
  const blocking = classifyHostKeyState({ conflicts: [changedExtra], entries: [changedExtra.incoming] })
  assert.equal(blocking.needsTrust, true)
  assert.equal(blocking.blockingConflicts.length, 1)
})

test('trust writes the offered key under both lookup names, never the tool argument', async () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222' })
  const entry = annotateProbeEntries([offer('lab', 'ssh-ed25519', key)], connection, endpoint)[0]
  const probe = { ok: true, entries: [entry], endpoint, source: 'test' }
  await withKnownHosts([], async (options) => {
    const result = await trustHostKey(connection, entry.fingerprint, { ...options, probe, endpoint })
    assert.equal(result.trusted, true)
    const text = await fs.readFile(options.knownHostsPath, 'utf8')
    assert.match(text, /\[lab\]:2222 ssh-ed25519 /)
    assert.match(text, /\[lab-host\.example\]:2222 ssh-ed25519 /)
    assert.equal(text.split('ssh-ed25519').length - 1, 2)
  })
})

test('trust fills the second lookup name when the key is already saved under one', async () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222' })
  const entry = annotateProbeEntries([offer('lab', 'ssh-ed25519', key)], connection, endpoint)[0]
  const probe = { ok: true, entries: [entry], endpoint, source: 'test' }
  await withKnownHosts([`[lab]:2222 ssh-ed25519 ${key}`], async (options) => {
    const result = await trustHostKey(connection, entry.fingerprint, { ...options, probe, endpoint })
    assert.equal(result.trusted, true)
    assert.equal(result.already, true)
    assert.deepEqual(result.added, ['[lab-host.example]:2222'])
    const text = await fs.readFile(options.knownHostsPath, 'utf8')
    assert.match(text, /\[lab\]:2222 ssh-ed25519 /)
    assert.match(text, /\[lab-host\.example\]:2222 ssh-ed25519 /)
  })
})

test('an agent-supplied fingerprint that the host did not offer is rejected and writes nothing', async () => {
  const endpoint = endpointFromLookup(connection, { hostname: 'lab-host.example', port: '2222' })
  const entry = annotateProbeEntries([offer('lab', 'ssh-ed25519', key)], connection, endpoint)[0]
  const probe = { ok: true, entries: [entry], endpoint, source: 'test' }
  await withKnownHosts([], async (options) => {
    await assert.rejects(
      trustHostKey(connection, fingerprintOfKey('ssh-ed25519', otherKey), { ...options, probe, endpoint }),
      /did not offer a key with fingerprint/,
    )
    const text = await fs.readFile(options.knownHostsPath, 'utf8')
    assert.equal(text, '')
  })
})
