import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { evaluateHostKeys, fingerprintOfKey, hostKeyAlgorithmsForTypes } from '../lib/ssh.js'

const connection = { host: 'host.example', sshPort: 22, user: 'designer' }

// Real-looking base64 blobs; content only needs to differ per key.
const ed25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIEd25519keyblob'
const ecdsa = 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYblob'
const rsaOld = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQoldrsakey'
const rsaNew = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQnewrsakey'

async function withKnownHosts(lines, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-hostkey-'))
  const file = path.join(dir, 'known_hosts')
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8')
  try {
    return await fn({ knownHostsPath: file })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function entry(type, key) {
  return { type, key, fingerprint: fingerprintOfKey(type, key), hostSpec: 'host.example' }
}

test('a missing key type is unknown even when other types are trusted', async () => {
  const lines = [
    `host.example ssh-ed25519 ${ed25519}`,
    `host.example ecdsa-sha2-nistp256 ${ecdsa}`,
  ]
  await withKnownHosts(lines, async (options) => {
    const entries = [entry('ssh-ed25519', ed25519), entry('ecdsa-sha2-nistp256', ecdsa), entry('ssh-rsa', rsaNew)]
    const result = await evaluateHostKeys(entries, connection, options)
    assert.equal(result.known.length, 2)
    assert.equal(result.conflicts.length, 0, 'an untrusted extra type must not look like a changed key')
    assert.equal(result.unknown.length, 1)
    assert.equal(result.unknown[0].type, 'ssh-rsa')
  })
})

test('a different key of a stored type is a conflict', async () => {
  const lines = [`host.example ssh-rsa ${rsaOld}`]
  await withKnownHosts(lines, async (options) => {
    const entries = [entry('ssh-rsa', rsaNew)]
    const result = await evaluateHostKeys(entries, connection, options)
    assert.equal(result.known.length, 0)
    assert.equal(result.unknown.length, 0)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].incoming.key, rsaNew)
    assert.deepEqual(
      result.conflicts[0].existing.map((item) => item.key),
      [rsaOld],
    )
  })
})

test('RSA known types pin both SHA-2 signature variants', () => {
  assert.deepEqual(hostKeyAlgorithmsForTypes(['ssh-rsa']), ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'])
  assert.deepEqual(hostKeyAlgorithmsForTypes(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-ed25519']), [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
  ])
})
