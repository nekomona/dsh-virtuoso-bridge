import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CIW_MAX_LINES,
  ciwLineCount,
  ciwSummary,
  formatCiwBlock,
} from '../lib/ciw-output.js'
import { registerTools } from '../lib/tools.js'

/** The payload measured on the live runtime and quoted in the design. */
const measured = {
  logPath: '/home/username/CDS.log.1',
  pid: 63102,
  lines: [
    '*WARNING* (DB-270212): dbOpenCellViewByType: ...',
    'CDF: An error occurred when evaluating callback.',
  ],
  levels: ['warning', 'output'],
  warnings: 1,
  errors: 1,
  output: 1,
  otherLines: 41,
  truncated: false,
  scannedBytes: 1234,
}

test('the measured payload renders the compact design block', () => {
  assert.equal(
    formatCiwBlock(measured),
    '--- CIW: 1 warning, 1 error, 1 output line (41 other lines) ---\n' +
      '*WARNING* (DB-270212): dbOpenCellViewByType: ...\n' +
      'CDF: An error occurred when evaluating callback.',
  )
})

test('nothing worth showing renders as an empty string', () => {
  const emptyPayloads = [
    undefined,
    null,
    {},
    [],
    'CIW text',
    42,
    { lines: [] },
    { lines: 'not-an-array' },
    { lines: [null, {}, 42, ''] },
    { warnings: 0, errors: 0, output: 0, otherLines: 12 },
    { warnings: 'none', errors: -2, output: NaN, truncated: true },
  ]
  for (const payload of emptyPayloads) assert.equal(formatCiwBlock(payload), '', JSON.stringify(payload))
})

test('counts are pluralised and other CIW lines are parenthesised', () => {
  assert.equal(ciwSummary({ warnings: 2, otherLines: 1 }), '--- CIW: 2 warnings (1 other line) ---')
  assert.equal(ciwSummary({ errors: 3, otherLines: 0 }), '--- CIW: 3 errors ---')
  assert.equal(ciwSummary({ warnings: 1, output: 2 }), '--- CIW: 1 warning, 2 output lines ---')
  assert.equal(ciwSummary({ lines: ['a', 'b'] }), '--- CIW: 2 lines ---')
})

test('captured lines are rendered and count-only payloads keep the header', () => {
  assert.equal(formatCiwBlock({ lines: ['plain printf text'] }), '--- CIW: 1 line ---\nplain printf text')
  assert.equal(formatCiwBlock({ warnings: 2, errors: 1, lines: [] }), '--- CIW: 2 warnings, 1 error ---')
  assert.ok(!formatCiwBlock(measured).endsWith('\n'))
})

test('a truncated capture ends the block with a short cut note', () => {
  assert.equal(
    formatCiwBlock({ ...measured, truncated: true }),
    '--- CIW: 1 warning, 1 error, 1 output line (41 other lines) ---\n' +
      '*WARNING* (DB-270212): dbOpenCellViewByType: ...\n' +
      'CDF: An error occurred when evaluating callback.\n' +
      '... (cut to fit)',
  )
  assert.equal(formatCiwBlock({ warnings: 1, truncated: true }), '--- CIW: 1 warning ---\n... (cut to fit)')
})

test('the log path is opt-in and stays inside the summary line', () => {
  const block = formatCiwBlock(measured, { logPath: true })
  const rows = block.split('\n')
  assert.equal(
    rows[0],
    '--- CIW: 1 warning, 1 error, 1 output line (41 other lines) | /home/username/CDS.log.1 ---',
  )
  assert.deepEqual(rows.slice(1), measured.lines)
  assert.equal(formatCiwBlock(measured), formatCiwBlock(measured, { logPath: false }))
  // No rendered lines means no path either, even when it is requested.
  assert.equal(ciwSummary({ warnings: 1, logPath: '/tmp/CDS.log.1' }, { logPath: true }), '--- CIW: 1 warning ---')
})

test('rendering caps lines and characters and reports what was dropped', () => {
  const lines = Array.from({ length: 50 }, (_, index) => 'warn ' + index)
  const rows = formatCiwBlock({ warnings: 50, lines }, { maxLines: 3 }).split('\n')
  assert.deepEqual(rows, [
    '--- CIW: 50 warnings ---',
    'warn 0',
    'warn 1',
    'warn 2',
    '... (47 more lines)',
  ])

  const charRows = formatCiwBlock({ lines: ['a'.repeat(100), 'b'.repeat(100)] }, { maxChars: 120 }).split('\n')
  assert.deepEqual(charRows, ['--- CIW: 2 lines ---', 'a'.repeat(100), '... (1 more line)'])
})

test('a single overlong line is shortened, not dropped', () => {
  const rows = formatCiwBlock({ lines: ['x'.repeat(600)] }).split('\n')
  assert.equal(rows[1], 'x'.repeat(500) + '...')
})

test('CRLF and ANSI colour escapes are cleaned out of captured lines', () => {
  const block = formatCiwBlock({
    warnings: 1,
    lines: ['*WARNING*: bad\r', '\u001b[31mCDF: failed\u001b[0m'],
  })
  assert.deepEqual(block.split('\n'), ['--- CIW: 1 warning ---', '*WARNING*: bad', 'CDF: failed'])
})

test('non-string lines are ignored and odd payloads never throw', () => {
  const payloads = [
    { warnings: Symbol('w'), lines: [Symbol('line')] },
    { lines: [{}], logPath: { path: '/tmp/CDS.log' } },
    { warnings: NaN, errors: Infinity, output: -3, otherLines: '4', lines: ['kept'] },
    { lines: { 0: 'not an array' } },
    { truncated: 'yes', lines: ['kept'] },
    { get lines() { throw new Error('boom') } },
  ]
  for (const payload of payloads) {
    assert.doesNotThrow(() => formatCiwBlock(payload))
    assert.equal(typeof formatCiwBlock(payload), 'string')
  }
  assert.equal(formatCiwBlock({ warnings: 1, lines: [null, 42, {}, 'kept'] }).split('\n')[1], 'kept')
  assert.equal(
    ciwSummary({ warnings: NaN, errors: Infinity, output: -3, otherLines: '4', lines: ['kept'] }),
    '--- CIW: 1 line (4 other lines) ---',
  )
})

test('ciwLineCount counts only usable text lines', () => {
  assert.equal(ciwLineCount(measured), 2)
  assert.equal(ciwLineCount({ lines: ['a', 1, 'b', null] }), 2)
  assert.equal(ciwLineCount(null), 0)
  assert.equal(ciwLineCount({ lines: [''] }), 0)
})

test('the default line cap matches the exported constant', () => {
  const lines = Array.from({ length: CIW_MAX_LINES + 2 }, (_, index) => 'line ' + index)
  const rows = formatCiwBlock({ lines }).split('\n')
  assert.equal(rows.length, CIW_MAX_LINES + 2)
  assert.equal(rows.at(-1), '... (2 more lines)')
})

/** Registers the real tools against a stub context; returns the named tool. */
function toolHarness(manager) {
  const registrations = []
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
  }
  registerTools({ ctx, manager, log: () => {} })
  return (name) => registrations.find((definition) => definition.name === name)
}

test('the api call answer strips the raw ciw payload and appends the block last', async () => {
  const tool = toolHarness({
    ready: Promise.resolve(),
    setup: {},
    async callApi() {
      return {
        runtime: 'rt_1',
        target: 'client',
        method: 'execute_skill',
        elapsedSeconds: 0.1,
        truncated: false,
        result: { status: 'success', output: 'nil', warnings: [] },
        ciw: measured,
      }
    },
  })('virtuoso_bridge_api')
  assert.ok(tool, 'the api tool is registered')
  const output = await tool.execute({ action: 'call', method: 'execute_skill', args: ['warn("x")'] }, {})
  assert.equal(output.ok, true)
  assert.ok(!output.text.includes('"logPath"'), 'the raw CIW field must not bloat the JSON answer')
  assert.ok(output.text.includes('"result"'), 'the call result itself is still rendered')
  assert.ok(output.text.endsWith(formatCiwBlock(measured)), 'the compact block is appended last')
})

test('only settled script jobs show the CIW block', async () => {
  let job = { state: 'running', id: 'job-1', ciw: measured }
  const tool = toolHarness({
    ready: Promise.resolve(),
    setup: {},
    async runScript() {
      return job
    },
    getScript() {
      return job
    },
  })('virtuoso_bridge_script')
  assert.ok(tool, 'the script tool is registered')

  const running = await tool.execute({ action: 'run', description: 'probe', code: 'result = 1' }, {})
  assert.match(running, /^Running/)
  assert.ok(!running.includes('--- CIW:'), 'a running job has no settled CIW result')

  job = { state: 'succeeded', id: 'job-1', result: { ok: true }, ciw: measured }
  const settled = await tool.execute({ action: 'status', description: 'status', job: 'job-1' }, {})
  assert.match(settled, /^Success/)
  assert.ok(settled.endsWith(formatCiwBlock(measured)), 'the settled job carries the block')
})
