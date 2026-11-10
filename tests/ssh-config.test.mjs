import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSshConfig } from '../lib/ssh.js'

const base = {
  hosts: ['host.example'],
  sshPort: 22,
  include: 'Include "/home/username/.ssh/config"\n',
}

test('OpenSSH config pins the trusted key types ahead of the user config', () => {
  const config = buildSshConfig({
    ...base,
    connection: { host: 'host.example', user: 'designer', sshBackend: 'openssh' },
    hostKeyAlgorithms: ['ssh-ed25519', 'ecdsa-sha2-nistp256'],
  })
  assert.equal(config.pinned, true)
  assert.match(config.text, /HostKeyAlgorithms ecdsa-sha2-nistp256,ssh-ed25519|HostKeyAlgorithms ssh-ed25519,ecdsa-sha2-nistp256/)
  assert.match(config.text, /StrictHostKeyChecking yes/)
  assert.ok(config.text.indexOf('HostKeyAlgorithms') < config.text.indexOf('Include'))
})

test('Paramiko config never carries OpenSSH host-key pinning options', () => {
  const config = buildSshConfig({
    ...base,
    connection: { host: 'host.example', user: 'designer', sshBackend: 'paramiko' },
    hostKeyAlgorithms: ['ssh-ed25519'],
  })
  assert.equal(config.pinned, false)
  assert.equal(config.algorithms.length, 0)
  assert.doesNotMatch(config.text, /StrictHostKeyChecking/)
  assert.doesNotMatch(config.text, /HostKeyAlgorithms/)
  assert.match(config.text, /^Include ".*\.ssh\/config"/)
  assert.match(config.text, /Host host\.example/)
})

test('a resolved ssh_config port is written so the generated config reaches the same endpoint', () => {
  const config = buildSshConfig({
    ...base,
    connection: { host: 'lab', user: 'designer', sshBackend: 'openssh' },
    sshPort: 2222,
    hostKeyAlgorithms: ['ssh-ed25519'],
  })
  assert.match(config.text, /Port 2222/)
  assert.doesNotMatch(config.text, /Port 22\n/)
})

test('the default backend keeps the OpenSSH pin', () => {
  const config = buildSshConfig({
    ...base,
    connection: { host: 'host.example', user: 'designer', sshBackend: '' },
    hostKeyAlgorithms: ['ssh-ed25519'],
  })
  assert.equal(config.pinned, true)
  assert.match(config.text, /StrictHostKeyChecking yes/)
})
