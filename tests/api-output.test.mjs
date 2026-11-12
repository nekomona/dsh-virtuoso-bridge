/**
 * Regression tests for the compact `virtuoso_bridge_api` renderer.
 *
 * The bug this suite pins down: `action=describe` with no target used to return
 * the whole Python API tree as JSON (~508,000 chars), the tool answer was cut
 * mid-JSON at the inline budget, and an agent could discover no target or
 * method at all. `lib/api-output.js` now answers at three zoom levels (index,
 * one target, one method), keeps every answer in budget, and spills the
 * complete payload to the results cache when even a zoomed answer is too big.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  API_INLINE_CHARS,
  formatDescription,
  formatJsonResult,
  presentApiResult,
  resultFileName,
  spillResult,
} from '../lib/api-output.js'
import { renderText } from '../lib/tools.js'

/** Marker used to prove that a long docstring never leaks into a listing. */
const SENTINEL = 'SENTINEL_DOCSTRING_9f3a'

/** Real target paths reported by the sidecar's `describe` action. */
const TARGET_PATHS = [
  'client',
  'client.dialogs',
  'client.layout',
  'client.library',
  'client.maestro',
  'client.requests',
  'client.schematic',
  'client.sos',
  'client.symbol',
  'spectre',
]

async function tmpResults(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-api-output-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

function docFor(name, lines = 30) {
  const body = Array.from(
    { length: lines },
    (_, index) => `Documentation line ${index + 1} for ${name} that must stay out of a compact listing.`,
  ).join('\n')
  return `${SENTINEL} long documentation for ${name}.\n${body}`
}

/** One method the way the sidecar reports it: signature, summary, doc, params. */
function makeMethod(name, { docLines = 30 } = {}) {
  return {
    name,
    signature: '(self, path: str, *, timeout: float = 30.0, retries: int = 3)',
    summary: `summary for ${name} on one line`,
    doc: docFor(name, docLines),
    params: [
      { name: 'path', kind: 'POSITIONAL_OR_KEYWORD', required: true, default: null, annotation: 'str' },
      { name: 'timeout', kind: 'POSITIONAL_OR_KEYWORD', required: false, default: 30, annotation: 'float' },
      { name: 'retries', kind: 'KEYWORD_ONLY', required: false, default: 3, annotation: 'int' },
    ],
  }
}

/** One described object node, mirroring `runtime/vb_sidecar.py`. */
function makeNode(targetPath, methodCount) {
  const leaf = targetPath.split('.').pop()
  return {
    path: targetPath,
    class: 'VirtuosoClient',
    module: 'virtuoso_bridge.client',
    summary: `${targetPath} bridge target`,
    methods: Array.from({ length: methodCount }, (_, index) =>
      makeMethod(`${leaf}_op_${String(index).padStart(2, '0')}`),
    ),
    properties: [
      { name: 'conn', type: 'property', summary: 'connection handle' },
      { name: 'cfg', type: 'property', summary: 'effective configuration' },
      { name: 'state', type: 'property', summary: 'runtime state' },
    ],
    children: {
      layout: { path: `${targetPath}.layout`, class: 'LayoutClient' },
      library: { path: `${targetPath}.library`, class: 'LibraryClient' },
      schematic: { path: `${targetPath}.schematic`, class: 'SchematicClient' },
    },
  }
}

/** One described class node, mirroring `_describe_class` in the sidecar. */
function makeClassNode(name, methodCount) {
  return {
    class: name,
    module: 'virtuoso_bridge',
    summary: `${name} class documentation`,
    constructor: makeMethod('__init__'),
    methods: Array.from({ length: methodCount }, (_, index) =>
      makeMethod(`${name}_cm_${String(index).padStart(2, '0')}`),
    ),
    properties: [{ name: 'conn', type: 'property', summary: 'connection handle' }],
  }
}

/** The shape `manager.describeApi` returns for `action=describe` without target. */
function makeIndexPayload({ methodCount = 24 } = {}) {
  const targets = {}
  for (const targetPath of TARGET_PATHS) targets[targetPath] = makeNode(targetPath, methodCount)
  return {
    runtime: 'rt_abc123',
    targets,
    classes: {
      SpectreSimulator: makeClassNode('SpectreSimulator', 1),
      SSHClient: makeClassNode('SSHClient', 4),
      VirtuosoClient: makeClassNode('VirtuosoClient', 6),
    },
    hint: "Call with target='client.schematic' etc. Paths may be dotted; target='class:VirtuosoClient' describes a class.",
  }
}

/** A small payload with hand-picked method names, for zoom-level assertions. */
function makeSmallPayload() {
  return {
    runtime: 'rt_1',
    targets: {
      client: {
        ...makeNode('client', 2),
        methods: [makeMethod('open_window'), makeMethod('close_window')],
      },
      spectre: {
        ...makeNode('spectre', 1),
        methods: [makeMethod('simulate')],
      },
    },
    classes: {
      VirtuosoClient: {
        ...makeClassNode('VirtuosoClient', 1),
        methods: [makeMethod('connect')],
      },
    },
  }
}

test('API_INLINE_CHARS is the documented inline budget', () => {
  assert.equal(API_INLINE_CHARS, 14_000)
})

test('index lists every target with class and method count, and stays tiny', (t) => {
  const payload = makeIndexPayload()
  const { text, complete } = formatDescription(payload)
  t.diagnostic(`default index: ${text.length} chars (complete=${complete})`)

  assert.equal(complete, true)
  assert.ok(text.length <= API_INLINE_CHARS)
  assert.match(text, /^virtuoso-bridge API/)
  assert.match(text, /targets \(10\):/)

  for (const targetPath of TARGET_PATHS) {
    assert.ok(text.includes(targetPath), `index must list target ${targetPath}`)
  }
  // Every row carries the class and the method count ("24 methods", or a
  // singular "1 method" after the count helper).
  assert.match(text, /client\s+VirtuosoClient\s+24 method/)
  assert.match(text, /classes \(3\):/)
  assert.ok(text.includes('class:VirtuosoClient'))
  assert.ok(text.includes('class:SSHClient'))
  // The index points at the next zoom levels instead of dumping the tree.
  assert.match(text, /target=<path>/)
  assert.match(text, /method=/)
  assert.ok(!text.includes(SENTINEL), 'the index must not carry docstrings')
})

test('index keeps a target whose node is an import error', () => {
  const payload = {
    runtime: 'rt_1',
    targets: {
      broken: { $error: 'ImportError: boom' },
      client: makeNode('client', 2),
    },
    classes: {},
  }
  const { text, complete } = formatDescription(payload)
  assert.equal(complete, true)
  assert.ok(text.includes('broken'), 'the error row must still name its path')
  assert.ok(text.includes('ImportError: boom'))
  assert.match(text, /unavailable/)

  // Describing such a node must not crash either.
  const target = formatDescription(payload, { target: 'broken' })
  assert.equal(target.complete, true)
  assert.ok(target.text.includes('broken'))
})

test('an empty API tree throws a clear error', () => {
  assert.throws(() => formatDescription({}), /describe returned no targets; the bridge API tree is empty/)
  assert.throws(() => formatDescription(null), /describe returned no targets; the bridge API tree is empty/)
  assert.throws(() => formatDescription({ targets: {}, classes: {} }), /bridge API tree is empty/)
})

test('target listing renders one-line signatures, properties and children — never docstrings', (t) => {
  const payload = makeIndexPayload({ methodCount: 24 })
  const { text, complete } = formatDescription(payload, { target: 'client.schematic' })
  t.diagnostic(`target listing (24 methods): ${text.length} chars (complete=${complete})`)

  assert.equal(complete, true)
  assert.ok(text.length <= API_INLINE_CHARS)
  assert.ok(text.startsWith('client.schematic'))
  assert.match(text, /methods \(24\):/)
  assert.ok(text.includes('schematic_op_00(self, path: str, *, timeout: float = 30.0, retries: int = 3)'))
  assert.ok(text.includes('summary for schematic_op_00 on one line'))
  assert.match(text, /properties \(3\):/)
  assert.ok(text.includes('conn') && text.includes('cfg') && text.includes('state'))
  assert.match(text, /children \(3\):/)
  assert.ok(text.includes('schematic') && text.includes('layout') && text.includes('library'))
  assert.ok(!text.includes(SENTINEL), 'a target listing must not contain a full docstring')
  assert.match(text, /method=<name>/)
})

test('target listing reports the methods it had to drop when the budget is small', (t) => {
  const payload = makeIndexPayload({ methodCount: 24 })
  const { text, complete } = formatDescription(payload, { target: 'client', limit: 1_200 })
  t.diagnostic(`budgeted target listing (limit 1200): ${text.length} chars (complete=${complete})`)

  assert.equal(complete, false)
  assert.ok(text.length <= 1_200)
  assert.match(text, /\.\.\. \(\d+ more methods/)
  assert.ok(!text.includes(SENTINEL), 'a budgeted listing must not fall back to docstrings')
})

test('target + method documents exactly that one method with its parameter table', (t) => {
  const payload = makeSmallPayload()
  const method = makeMethod('open_window')
  payload.targets.client.methods = [method, makeMethod('close_window')]
  const { text, complete } = formatDescription(payload, { target: 'client', method: 'open_window' })
  t.diagnostic(`method documentation: ${text.length} chars (complete=${complete})`)

  assert.equal(complete, true)
  assert.ok(text.length <= API_INLINE_CHARS)
  assert.ok(text.startsWith('client.open_window(self, path: str'))
  assert.ok(text.includes(SENTINEL), 'the method view is where the docstring belongs')
  assert.match(text, /params \(3\):/)
  for (const param of method.params) {
    assert.ok(text.includes(param.name), `parameter table must name ${param.name}`)
  }
  assert.match(text, /required/)
  assert.match(text, /default 30/)
  assert.ok(!text.includes('close_window'), 'the method view must not list sibling methods')
  assert.ok(!text.includes('summary for close_window'))
})

test('method without a target lists the defining targets, or throws', () => {
  const payload = makeSmallPayload()

  const search = formatDescription(payload, { method: 'open_window' })
  assert.equal(search.complete, true)
  assert.match(search.text, /targets with method open_window \(\d+\):/)
  assert.ok(search.text.includes('client'))
  assert.ok(search.text.includes('method=open_window'))

  const classOnly = formatDescription(payload, { method: 'connect' })
  assert.ok(classOnly.text.includes('class:VirtuosoClient'), 'a class-defined method is reported as class:<Name>')

  assert.throws(
    () => formatDescription(payload, { method: 'nope' }),
    /no target defines a method named "nope"/,
  )
})

test('unknown target throws with the available names, including class:<Name>', () => {
  const payload = makeSmallPayload()
  let error
  try {
    formatDescription(payload, { target: 'client.nope' })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'UNKNOWN_TARGET')
  assert.match(error.message, /^unknown target "client\.nope"\. Available: /)
  assert.ok(error.message.includes('client'), 'the message lists target paths')
  assert.ok(error.message.includes('spectre'))
  assert.ok(error.message.includes('class:VirtuosoClient'), 'the message lists class:<Name> entries')
})

test('unknown method on a known target names the target and lists its methods', () => {
  const payload = makeSmallPayload()
  assert.throws(
    () => formatDescription(payload, { target: 'client', method: 'nope' }),
    (error) => {
      assert.match(error.message, /target "client" has no method "nope"/)
      assert.match(error.message, /Methods: /)
      assert.ok(error.message.includes('open_window'))
      assert.ok(error.message.includes('close_window'))
      return true
    },
  )
})

test('every zoom level respects its character budget', () => {
  const payload = makeIndexPayload({ methodCount: 24 })
  const cases = [
    ['index', {}],
    ['target', { target: 'client' }],
    ['method', { target: 'client', method: 'client_op_00' }],
    ['method search', { method: 'client_op_00' }],
  ]
  for (const limit of [1_000, 1_200, 2_000, 5_000, API_INLINE_CHARS]) {
    for (const [label, options] of cases) {
      const { text } = formatDescription(payload, { ...options, limit })
      assert.ok(text.length <= limit, `${label} at limit ${limit} returned ${text.length} chars`)
    }
  }
  // An unusable requested limit falls back to the documented default rather
  // than producing a stub that cannot even name the target.
  const floored = formatDescription(payload, { target: 'client', limit: 10 })
  assert.equal(floored.text, formatDescription(payload, { target: 'client' }).text)
  assert.ok(floored.text.length <= API_INLINE_CHARS)
})

test('every incomplete answer says what it had to drop', () => {
  // A docstring longer than the budget.
  const methodPayload = makeSmallPayload()
  methodPayload.targets.client.methods = [makeMethod('open_window'), makeMethod('close_window')]
  const cutMethod = formatDescription(methodPayload, { target: 'client', method: 'open_window', limit: 1_000 })
  assert.equal(cutMethod.complete, false)
  assert.ok(cutMethod.text.length <= 1_000)
  assert.match(cutMethod.text, /\.\.\. \(.*cut to fit the answer budget/)

  // More targets than the index or a method search can list.
  const manyTargets = { runtime: 'rt_1', targets: {}, classes: {} }
  for (let index = 0; index < 300; index += 1) {
    manyTargets.targets[`target_${index}`] = {
      path: `target_${index}`,
      class: 'VirtuosoClient',
      methods: [{ name: 'shared', signature: '()', summary: 'shared summary' }],
      properties: [],
      children: {},
    }
  }

  const cutIndex = formatDescription(manyTargets, { limit: 1_000 })
  assert.equal(cutIndex.complete, false)
  assert.ok(cutIndex.text.length <= 1_000)
  assert.match(cutIndex.text, /\.\.\. \(\d+ more targets/)

  const cutSearch = formatDescription(manyTargets, { method: 'shared', limit: 1_000 })
  assert.equal(cutSearch.complete, false)
  assert.ok(cutSearch.text.length <= 1_000)
  assert.match(cutSearch.text, /\.\.\. \(\d+ more targets\)/)
})

test('formatJsonResult prints exact JSON when it fits and previews when it does not', (t) => {
  const small = { a: [1, 2], b: { c: 'd' } }
  const fits = formatJsonResult(small)
  assert.equal(fits.complete, true)
  assert.equal(fits.text, JSON.stringify(small, null, 2))

  const big = { rows: Array.from({ length: 2_000 }, (_, index) => ({ index, name: `row-${index}` })) }
  const cut = formatJsonResult(big, { limit: 5_000 })
  t.diagnostic(`call result preview: ${cut.text.length} chars for ${JSON.stringify(big, null, 2).length}-char JSON`)
  assert.equal(cut.complete, false)
  assert.ok(cut.text.length <= 5_000)
  assert.match(cut.text, /preview of a [\d,]+-char result/)
})

test('spillResult creates the results directory and writes the complete text', async (t) => {
  const root = await tmpResults(t)
  const dir = path.join(root, 'results', 'nested')
  const text = `${'x'.repeat(1_234)}\n`
  const name = 'api-describe-client-20240102-030405-abcd'

  const spilled = await spillResult(text, { dir, name })
  assert.equal(spilled.chars, text.length, 'chars must equal the text length, not the byte count')
  assert.equal(spilled.path, path.join(dir, `${name}.json`))
  assert.equal(await fs.readFile(spilled.path, 'utf8'), text)
  assert.ok((await fs.stat(dir)).isDirectory(), 'spillResult creates a missing directory')

  const unnamed = await spillResult('hello', { dir })
  assert.equal(path.basename(unnamed.path), 'result.json')

  const unsafe = await spillResult('hello', { dir, name: 'a/b:c' })
  assert.equal(path.dirname(unsafe.path), dir)
  assert.equal(path.basename(unsafe.path), 'a-b-c.json')
  assert.ok(!path.basename(unsafe.path).includes(':'))

  await assert.rejects(() => spillResult('hello'), /no directory is configured for large results/)
})

test('resultFileName is a greppable, sanitised name', () => {
  // Built from UTC components rather than an ISO string: the public-release
  // guard scans source and prose for machine timestamps, and a test fixture is
  // not a reason to keep one in the tree.
  const now = new Date(Date.UTC(2024, 0, 2, 3, 4, 5))

  const describeName = resultFileName('describe', { target: 'client' }, now)
  assert.match(describeName, /^api-describe-client-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/)
  assert.ok(describeName.startsWith('api-describe-client-20240102-030405-'))

  const callName = resultFileName('call', { target: 'client', method: 'rows' }, now)
  assert.match(callName, /^api-call-client-rows-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/)

  // `class:VirtuosoClient` must not leak a `:` or a path separator.
  const classRequested = resultFileName('describe', { target: 'class:VirtuosoClient' }, now)
  assert.match(classRequested, /^api-describe-class-VirtuosoClient-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/)
  assert.ok(!classRequested.includes(':'))
  assert.ok(!classRequested.includes('/'))
  assert.ok(!classRequested.includes('\\'))
})

test('presentApiResult returns the compact answer unchanged when it fits', async (t) => {
  const root = await tmpResults(t)
  const payload = makeSmallPayload()
  const rendered = formatDescription(payload)

  const result = await presentApiResult({ action: 'describe', args: {}, value: payload, resultsDir: root })
  assert.equal(result.overflow, undefined)
  assert.equal(result.text, rendered.text)

  const call = await presentApiResult({ action: 'call', args: { target: 'client', method: 'rows' }, value: { rows: [1, 2, 3] }, resultsDir: root })
  assert.equal(call.overflow, undefined)
  assert.equal(call.text, JSON.stringify({ rows: [1, 2, 3] }, null, 2))
})

test('presentApiResult spills the complete payload when a describe answer does not fit', async (t) => {
  const root = await tmpResults(t)
  const payload = makeIndexPayload({ methodCount: 24 })

  const result = await presentApiResult({
    action: 'describe',
    args: { target: 'client' },
    value: payload,
    resultsDir: root,
    limit: 1_200,
  })

  assert.ok(result.overflow, 'a cut answer must report an overflow')
  assert.equal(result.overflow.chars, JSON.stringify(payload, null, 2).length)
  assert.match(result.text, /answer cut to the 1,200-char budget/)
  assert.ok(result.text.includes(result.overflow.path), 'the footer must name the spill path')
  assert.ok(result.text.endsWith('so the answer fits.)'))
  assert.ok(result.text.length <= 1_200, `answer + footer of ${result.text.length} chars must stay in budget`)
  assert.match(path.basename(result.overflow.path), /^api-describe-client-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}\.json$/)
  assert.equal(await fs.readFile(result.overflow.path, 'utf8'), JSON.stringify(payload, null, 2))
})

test('presentApiResult spills a large call result and keeps the footer inside the reserved room', async (t) => {
  const root = await tmpResults(t)
  const value = { ok: true, rows: Array.from({ length: 2_000 }, (_, index) => ({ index, name: `row-${index}` })) }
  const full = JSON.stringify(value, null, 2)

  for (const limit of [1_000, API_INLINE_CHARS]) {
    const result = await presentApiResult({
      action: 'call',
      args: { target: 'client', method: 'rows' },
      value,
      resultsDir: root,
      limit,
    })
    t.diagnostic(`call limit ${limit}: answer ${result.text.length} chars, spilled ${result.overflow?.chars} chars`)

    assert.ok(result.overflow, 'a cut call answer must report an overflow')
    assert.equal(result.overflow.chars, full.length)
    assert.ok(result.text.includes(result.overflow.path))
    // The footer is the only route to the spilled file, so the composed answer
    // (preview + footer) must stay inside the caller's budget at every limit.
    assert.ok(
      result.text.length <= limit,
      `answer + footer of ${result.text.length} chars must stay within the ${limit}-char budget`,
    )
    assert.equal(await fs.readFile(result.overflow.path, 'utf8'), full)
  }
})

test('presentApiResult keeps answer + footer inside the smallest valid budgets', async (t) => {
  const root = await tmpResults(t)
  const value = { ok: true, rows: Array.from({ length: 2_000 }, (_, index) => ({ index, name: `row-${index}` })) }
  const full = JSON.stringify(value, null, 2)
  const describePayload = makeIndexPayload({ methodCount: 24 })

  for (const limit of [400, 500]) {
    const call = await presentApiResult({
      action: 'call',
      args: { target: 'client', method: 'rows' },
      value,
      resultsDir: root,
      limit,
    })
    t.diagnostic(`call limit ${limit}: answer ${call.text.length} chars, spilled ${call.overflow?.chars} chars`)
    assert.ok(call.overflow, `limit ${limit} still spills a 2,000-row result`)
    assert.ok(call.text.length <= limit, `${call.text.length} chars exceed the ${limit}-char budget`)
    assert.ok(call.text.includes(call.overflow.path), 'the footer must still name the spill path')
    assert.equal(await fs.readFile(call.overflow.path, 'utf8'), full)

    const describe = await presentApiResult({
      action: 'describe',
      args: { target: 'client' },
      value: describePayload,
      resultsDir: root,
      limit,
    })
    t.diagnostic(`describe limit ${limit}: answer ${describe.text.length} chars`)
    assert.ok(describe.overflow, `limit ${limit} still spills a 24-method listing`)
    assert.ok(describe.text.length <= limit, `${describe.text.length} chars exceed the ${limit}-char budget`)
    assert.ok(describe.text.includes(describe.overflow.path), 'the footer must still name the spill path')
    assert.equal(await fs.readFile(describe.overflow.path, 'utf8'), JSON.stringify(describePayload, null, 2))
  }
})

test('presentApiResult still resolves when the results directory cannot be written', async (t) => {
  const root = await tmpResults(t)
  const value = { rows: Array.from({ length: 500 }, (_, index) => ({ index })) }

  const blocker = path.join(root, 'blocker')
  await fs.writeFile(blocker, 'not a directory', 'utf8')

  const unwritable = await presentApiResult({
    action: 'call',
    args: {},
    value,
    resultsDir: path.join(blocker, 'results'),
    limit: 1_000,
  })
  assert.equal(unwritable.overflow, undefined)
  assert.match(unwritable.text, /could not be written/)

  const missing = await presentApiResult({ action: 'call', args: {}, value, resultsDir: '', limit: 1_000 })
  assert.equal(missing.overflow, undefined)
  assert.match(missing.text, /could not be written/)
})

test('renderText returns value.text verbatim and keeps the FAILED: rendering', () => {
  assert.equal(renderText({}, { ok: true, text: 'X' }), 'X')
  assert.equal(renderText({}, { ok: false, error: { message: 'boom' } }), 'FAILED: boom')
})

test('regression: a >100k sidecar payload renders a complete index within 8k chars', async (t) => {
  const root = await tmpResults(t)
  const payload = makeIndexPayload({ methodCount: 24 })
  const payloadChars = JSON.stringify(payload).length
  t.diagnostic(`sidecar payload JSON: ${payloadChars} chars`)
  assert.ok(payloadChars > 100_000, `the regression payload must exceed 100k chars, got ${payloadChars}`)

  const index = formatDescription(payload)
  t.diagnostic(`default index: ${index.text.length} chars (complete=${index.complete})`)
  assert.equal(index.complete, true, 'the default index must be complete')
  assert.ok(index.text.length <= 8_000, `index of ${index.text.length} chars must stay under 8k`)
  assert.ok(!index.text.includes(SENTINEL))

  for (const targetPath of TARGET_PATHS) {
    assert.ok(index.text.includes(targetPath), `index must list target ${targetPath}`)
  }
  for (const count of ['24 method', '6 method', '4 method', '1 method']) {
    assert.ok(index.text.includes(count), `index must carry the method count "${count}"`)
  }

  const listing = formatDescription(payload, { target: 'client' })
  t.diagnostic(`target listing: ${listing.text.length} chars (complete=${listing.complete})`)
  assert.equal(listing.complete, true)
  assert.ok(listing.text.length <= API_INLINE_CHARS)
  assert.ok(!listing.text.includes(SENTINEL), 'a distinctive docstring must not reach the target listing')

  const present = await presentApiResult({ action: 'describe', args: {}, value: payload, resultsDir: root })
  t.diagnostic(`presentApiResult index: ${present.text.length} chars, overflow=${Boolean(present.overflow)}`)
  assert.equal(present.overflow, undefined, 'the default index fits, so nothing is spilled')
  assert.equal(present.text, index.text)
})
