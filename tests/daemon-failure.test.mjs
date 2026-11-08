import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyDaemonFailure } from '../lib/manager.js'

test('a missing daemon reported as an identity failure is classified as no listener', () => {
  const message =
    'RuntimeError: Virtuoso daemon identity check failed: could not determine the Unix user of the daemon behind ' +
    'the tunnel (Socket error: [WinError 10053] An established connection was aborted by the software in your host machine); ' +
    'refusing a possibly foreign Virtuoso session.'
  assert.equal(classifyDaemonFailure(message, { state: 'no-listener' }), 'unreachable')
  assert.equal(classifyDaemonFailure(message, undefined), 'unreachable')
})

test('legacy daemon and protocol mismatches are version mismatches', () => {
  assert.equal(classifyDaemonFailure('anything', { state: 'legacy' }), 'version-mismatch')
  assert.equal(
    classifyDaemonFailure('bridge protocol version mismatch: daemon speaks 0, client speaks 1', undefined),
    'version-mismatch',
  )
  assert.equal(
    classifyDaemonFailure('daemon did not answer the bridge capability handshake — it predates bridge token auth', undefined),
    'version-mismatch',
  )
})

test('token auth failures stay distinct from compatibility failures', () => {
  assert.equal(classifyDaemonFailure('anything', { state: 'auth' }), 'auth-failed')
  assert.equal(classifyDaemonFailure('AuthError: protocol version mismatch (daemon speaks v1)', undefined), 'auth-failed')
})

test('unrelated failures are not guessed', () => {
  assert.equal(classifyDaemonFailure('the plugin venv is unusable: missing package', undefined), undefined)
})
