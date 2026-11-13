/**
 * The script tool and a SKILL `execute_skill` API call render through one card:
 * same disclosure layout, same description title, same code block, and the
 * Virtuoso Bridge glyph instead of a per-language badge.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerTools } from '../lib/tools.js'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const EN = {
  'script.title': 'Script',
  'script.code': 'Code',
  'script.result': 'Result',
  'script.running': 'Running...',
  'script.failed': 'Failed',
  'script.stopped': 'Stopped',
  'script.noResult': 'No result',
  'script.inspect': 'Inspect call',
  'api.title': 'Bridge call',
  'api.skill': 'SKILL code',
  'api.arguments': 'Arguments',
}

function createDocumentStub() {
  const head = { children: new Set() }
  const document = {
    head,
    createElement(tag) {
      const element = { tagName: tag, dataset: {}, textContent: '', removed: false }
      element.remove = () => head.children.delete(element)
      return element
    },
    querySelector() {
      return null
    },
  }
  head.appendChild = (element) => head.children.add(element)
  return document
}

/** A React stub: elements are plain nodes, so a view can be walked as data. */
function createReactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

function loadClient(document) {
  let definition
  const window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  const react = createReactStub()
  new Function('window', 'document', 'require', CLIENT_SOURCE)(window, document, () => react)
  return definition.factory(() => react)
}

function applyClient(plugin, document, registrations) {
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    effect(effect) {
      effect()
      return () => {}
    },
    slots: {
      inject(name, provide) {
        provide()
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    sidebarRightTabs: { register: () => () => {} },
    get: () => undefined,
  }
  plugin.apply(ctx)
}

/** Renders a node tree by calling every function component it meets. */
function walk(node, out) {
  if (node == null || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type({ ...node.props, children: node.children }), out)
    return
  }
  out.types.push(node.type)
  for (const child of node.children ?? []) walk(child, out)
}

function viewProps(block) {
  return {
    block,
    t: (key) => EN[key] ?? key,
    useDisclosure: () => ({ expanded: true, toggle() {} }),
  }
}

function renderView(component, block) {
  const out = { text: [], types: [] }
  walk(component(viewProps(block)), out)
  return { text: out.text.join('\n'), types: out.types, words: out.text }
}

function setup() {
  const document = createDocumentStub()
  const plugin = loadClient(document)
  const registrations = []
  applyClient(plugin, document, registrations)
  const view = (key) => registrations.find((entry) => entry.definition.key === key)?.component
  return { registrations, view }
}

function scriptBlock(args, result = 'Success') {
  return {
    kind: 'result',
    isError: false,
    call: { argsRaw: JSON.stringify(args) },
    content: [{ type: 'text', text: result }],
  }
}

test('the script tool and the bridge call share one code card', () => {
  const { registrations, view } = setup()
  const views = registrations.filter((entry) => entry.definition.name === 'tool.call.toolview')
  assert.deepEqual(
    views.map((entry) => entry.definition.key),
    ['virtuoso_bridge_script', 'virtuoso_bridge_api'],
  )
  assert.equal(typeof view('virtuoso_bridge_script'), 'function')
  assert.equal(typeof view('virtuoso_bridge_api'), 'function')
})

test('a script run keeps its description title and Python source', () => {
  const { view } = setup()
  const rendered = renderView(view('virtuoso_bridge_script'), scriptBlock({ description: 'probe the venv', code: 'print(1)' }))
  assert.equal(rendered.words.find((word) => word.startsWith('Script: ')), 'Script: probe the venv')
  assert.ok(rendered.words.includes('print(1)'), rendered.text)
  assert.ok(rendered.words.includes('Success'), rendered.text)
})

test('an execute_skill call shows its SKILL source in the same card', () => {
  const { view } = setup()
  const block = scriptBlock(
    { action: 'call', target: 'client', method: 'execute_skill', args: ['(getWorkingDir())'] },
    '{"ok":true}',
  )
  const rendered = renderView(view('virtuoso_bridge_api'), block)
  assert.equal(rendered.words.find((word) => word.startsWith('Bridge call: ')), 'Bridge call: execute_skill · client')
  assert.ok(rendered.words.includes('SKILL code'), rendered.text)
  assert.ok(rendered.words.includes('(getWorkingDir())'), rendered.text)
  assert.ok(rendered.words.includes('{"ok":true}'), rendered.text)
})

test('a skill call description labels the card like the script tool', () => {
  const { view } = setup()
  const block = scriptBlock({ action: 'call', target: 'client', method: 'execute_skill', description: 'read the working directory', args: ['(getWorkingDir())'] })
  const rendered = renderView(view('virtuoso_bridge_api'), block)
  assert.equal(rendered.words.find((word) => word.startsWith('Bridge call: ')), 'Bridge call: read the working directory')
})

test('a describe call renders its arguments instead of code', () => {
  const { view } = setup()
  const block = scriptBlock({ action: 'describe', target: 'client.schematic', depth: 1 })
  const rendered = renderView(view('virtuoso_bridge_api'), block)
  assert.equal(rendered.words.find((word) => word.startsWith('Bridge call: ')), 'Bridge call: describe · client.schematic')
  assert.ok(rendered.words.includes('Arguments'), rendered.text)
  assert.match(rendered.text, /"target": "client\.schematic"/)
})

test('both cards carry the Virtuoso Bridge glyph, not a language badge', () => {
  const { view } = setup()
  for (const key of ['virtuoso_bridge_script', 'virtuoso_bridge_api']) {
    const rendered = renderView(view(key), scriptBlock({ action: 'call', target: 'client', method: 'execute_skill', args: ['1+1'] }))
    assert.ok(rendered.types.includes('svg'), `${key} renders the bridge mark`)
    assert.ok(!rendered.words.includes('Py'), `${key} no longer shows a Py badge`)
  }
  assert.doesNotMatch(CLIENT_SOURCE, /vb-script-glyph' \}, 'Py'/)
})

test('the API tool takes a one-line description for the tool card', () => {
  const definitions = []
  const ctx = {
    tools: { register: (definition) => { definitions.push(definition); return () => {} } },
    on: () => () => {},
    get: () => undefined,
  }
  const manager = { ready: undefined, setup: { instructionsDir: 'docs' }, store: { snapshot: () => ({ connections: [] }) } }
  const tools = registerTools({ ctx, manager, log: () => {} })
  try {
    const api = definitions.find((definition) => definition.name === 'virtuoso_bridge_api')
    assert.ok(api, 'the API tool is registered')
    assert.equal(api.parameters.properties.description.type, 'string')
    assert.deepEqual(api.parameters.required, ['action'])
    assert.match(api.description, /optional one-line description/)
  } finally {
    tools.dispose()
  }
})
