import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const STYLE_ID = '@nekomona/dsh-virtuoso-bridge/client.css'

/** A document stub that only supports what the plugin's style injection uses. */
function createDocumentStub() {
  const head = { children: new Set() }
  const document = {
    head,
    createElement(tag) {
      const element = { tagName: tag, dataset: {}, textContent: '', removed: false }
      element.remove = () => {
        element.removed = true
        head.children.delete(element)
      }
      return element
    },
    querySelector(selector) {
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (!match) return null
      for (const element of head.children) {
        if (element.dataset?.pluginCss === match[1] && !element.removed) return element
      }
      return null
    },
  }
  head.appendChild = (element) => head.children.add(element)
  return document
}

/** Loads client.js the way the Harness module loader does, returning the plugin definition. */
function loadPluginDefinition(document) {
  let definition
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const require = () => react
  new Function('window', 'document', 'require', CLIENT_SOURCE)(window, document, require)
  return definition.factory(require)
}

/** Runs the plugin's apply() with just enough of the Cordis context. */
function applyPlugin(plugin, document) {
  const disposers = []
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    slots: {
      inject(name, provide) {
        provide()
        return () => {}
      },
      register() {
        return () => {}
      },
    },
    sidebarRightTabs: { register: () => {} },
    sidebarRight: {},
    layout: {},
    get: () => undefined,
  }
  plugin.apply(ctx)
  return disposers
}

test('the plugin stylesheet is injected into document.head at apply time', () => {
  const document = createDocumentStub()
  const plugin = loadPluginDefinition(document)
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout', 'sidebarRight', 'sidebarRightTabs'])

  applyPlugin(plugin, document)

  const injected = [...document.head.children].filter((element) => element.textContent.includes('.vb-open{'))
  assert.equal(injected.length, 1, 'one stylesheet carries the composer opener styles')
  assert.equal(injected[0].dataset.pluginCss, STYLE_ID)
  // The composer opener sits in the input row and is styled independently of any panel.
  assert.match(injected[0].textContent, /\.vb-open\{[^}]*width:30px/)
  assert.match(injected[0].textContent, /\.vb-open\{[^}]*flex:none/)
})

test('applying the plugin twice keeps a single stylesheet', () => {
  const document = createDocumentStub()
  const plugin = loadPluginDefinition(document)
  applyPlugin(plugin, document)
  applyPlugin(plugin, document)
  const injected = [...document.head.children].filter((element) => element.textContent.includes('.vb-open{'))
  assert.equal(injected.length, 1)
})

test('no panel owns the stylesheet element', () => {
  // Regression guard: the composer opener renders with no panel mounted, so CSS
  // rendered inside a panel tree disappears while the sidebar is collapsed.
  assert.doesNotMatch(CLIENT_SOURCE, /styleElement/)
})
