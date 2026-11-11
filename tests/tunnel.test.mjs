import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTunnelArgs,
  canBind,
  classifyTunnelFailure,
  pickLocalPort,
  SshTunnel,
} from '../lib/tunnel.js'

const baseConnection = {
  host: 'daemon-host',
  user: 'designer',
  daemonHost: 'daemon-host',
  jumpHost: 'jump-host',
  jumpUser: 'jumper',
  identityFile: 'C:/keys/id_ed25519',
}

test('the tunnel command mirrors the upstream forward', () => {
  const built = buildTunnelArgs({
    connection: baseConnection,
    sshConfigPath: 'C:/plugin/ssh/config-x',
    localPort: 64100,
    remotePort: 65116,
    connectTimeoutSec: 25,
  })
  assert.equal(built.command, 'ssh')
  assert.equal(built.host, 'daemon-host')
  assert.equal(built.user, 'designer')
  const joined = built.args.join(' ')
  assert.match(joined, /-o BatchMode=yes/)
  assert.match(joined, /-o ConnectTimeout=25/)
  assert.match(joined, /-o ControlMaster=no/)
  assert.match(joined, /-o ExitOnForwardFailure=yes/)
  assert.match(joined, /-o ServerAliveInterval=30/)
  assert.match(joined, /-F C:\/plugin\/ssh\/config-x/)
  assert.match(joined, /-i C:\/keys\/id_ed25519/)
  assert.match(joined, /-J jumper@jump-host/)
  assert.match(joined, /-N -L 64100:127\.0\.0\.1:65116/)
  assert.equal(built.args.at(-1), 'designer@daemon-host')
})

test('the tunnel targets the daemon host, not the GUI host', () => {
  const built = buildTunnelArgs({
    connection: { host: 'gui-host', daemonHost: 'daemon-host', user: 'designer' },
    localPort: 64000,
    remotePort: 65000,
  })
  assert.equal(built.host, 'daemon-host')
  assert.equal(built.args.at(-1), 'designer@daemon-host')
})

test('OpenSSH failures are classified for the runtime error message', () => {
  assert.equal(
    classifyTunnelFailure('debug1: Authentications that can continue: publickey\nPermission denied (publickey).'),
    'SSH authentication failed (permission denied)',
  )
  assert.match(classifyTunnelFailure('Host key verification failed.'), /host-key verification/)
  assert.match(classifyTunnelFailure('bind: Address already in use'), /port is already in use/)
  assert.equal(classifyTunnelFailure('debug1: Reading configuration data'), undefined)
})

test('a free local port is allocated without dialling anything', async () => {
  const port = await pickLocalPort()
  assert.ok(port > 0 && port < 65536)
  assert.equal(await canBind(port), true)
})

function fakeSsh(source) {
  return { command: process.execPath, args: ['-e', source] }
}

const readySource = `
  process.stderr.write('debug1: Local connections to LOCALHOST:64001 forwarded to remote address 127.0.0.1:65116\\n')
  process.stderr.write('debug1: Local forwarding listening on 127.0.0.1 port 64001.\\n')
  process.stderr.write('debug1: Authentication succeeded (publickey).\\n')
  process.stderr.write('debug1: Entering interactive session.\\n')
  setInterval(() => {}, 1000)
`

test('a running forward is tracked from child events, not from the port', async () => {
  const { command, args } = fakeSsh(readySource)
  const tunnel = new SshTunnel({ command, args, label: 'test tunnel' })
  tunnel.localPort = 64001
  tunnel.remotePort = 65116
  await tunnel.start({ timeoutMs: 5_000 })
  try {
    assert.equal(tunnel.state, 'up')
    assert.equal(tunnel.alive, true)
    assert.ok(tunnel.pid > 0)
    const snapshot = tunnel.snapshot()
    assert.equal(snapshot.state, 'up')
    assert.equal(snapshot.localPort, 64001)
    assert.equal(snapshot.remotePort, 65116)
    assert.equal(snapshot.alive, true)
  } finally {
    await tunnel.stop({ timeoutMs: 3_000 })
  }
  assert.equal(tunnel.state, 'down')
  assert.equal(tunnel.alive, false)
})

test('a forward that exits during startup rejects with the classified cause', async () => {
  const { command, args } = fakeSsh(`
    process.stderr.write('debug1: Authenticating to daemon-host:22 as designer\\n')
    process.stderr.write('Permission denied (publickey).\\n')
    process.exit(255)
  `)
  const tunnel = new SshTunnel({ command, args, label: 'broken tunnel' })
  await assert.rejects(
    tunnel.start({ timeoutMs: 5_000 }),
    (error) => {
      assert.match(error.message, /authentication failed/)
      assert.equal(error.code, 'TUNNEL_EXITED')
      assert.match(error.stderrTail, /Permission denied/)
      return true
    },
  )
  assert.equal(tunnel.state, 'down')
})

test('an unexpected exit is reported as an event with the exit code and cause', async () => {
  const { command, args } = fakeSsh(readySource)
  const tunnel = new SshTunnel({ command, args, label: 'drop tunnel' })
  tunnel.localPort = 64001
  tunnel.remotePort = 65116
  await tunnel.start({ timeoutMs: 5_000 })
  const exited = new Promise((resolve) => tunnel.once('exit', resolve))
  tunnel.child.kill()
  const snapshot = await exited
  assert.equal(snapshot.state, 'down')
  assert.equal(snapshot.alive, false)
  assert.ok(snapshot.exitCode !== null || snapshot.exitSignal !== null)
})


