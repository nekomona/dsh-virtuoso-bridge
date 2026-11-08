import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SettingsStore, defaultSettings } from '../lib/store.js'

async function withStore(seed, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-store-'))
  try {
    if (seed !== undefined) {
      await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(seed), 'utf8')
    }
    const store = new SettingsStore({ dataDir: dir })
    await store.load()
    await run(store, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('script worker defaults stay in the documented shape', () => {
  const defaults = defaultSettings()
  assert.equal(defaults.scriptWorker, true)
  assert.equal(defaults.scriptWorkerIdleMs, 600000)
  assert.equal(defaults.scriptWorkerMax, 4)
  // Below this idle threshold a full budget falls back to a process per script
  // instead of evicting a freshly warm worker.
  assert.equal(defaults.scriptWorkerEvictIdleMs, 60000)
})

test('a fresh store keeps the worker settings and persists them', async () => {
  await withStore(undefined, async (store, dir) => {
    const snapshot = store.snapshot()
    assert.equal(snapshot.scriptWorker, true)
    assert.equal(snapshot.scriptWorkerEvictIdleMs, 60000)
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'))
    assert.equal(persisted.scriptWorkerEvictIdleMs, 60000)
  })
})

test('configure accepts and normalizes the worker budget settings', async () => {
  await withStore(undefined, async (store) => {
    const updated = await store.update({
      scriptWorkerMax: 6,
      scriptWorkerIdleMs: 90000,
      scriptWorkerEvictIdleMs: 15000,
    })
    assert.equal(updated.scriptWorkerMax, 6)
    assert.equal(updated.scriptWorkerIdleMs, 90000)
    assert.equal(updated.scriptWorkerEvictIdleMs, 15000)
  })
})

test('invalid and out-of-range worker settings fall back or clamp on load', async () => {
  const defaults = defaultSettings()
  await withStore(
    { scriptWorkerMax: 'not-a-number', scriptWorkerIdleMs: -5 },
    async (store) => {
      const snapshot = store.snapshot()
      assert.equal(snapshot.scriptWorkerMax, defaults.scriptWorkerMax)
      assert.equal(snapshot.scriptWorkerIdleMs, defaults.scriptWorkerIdleMs)
      assert.equal(snapshot.scriptWorkerEvictIdleMs, defaults.scriptWorkerEvictIdleMs)
    },
  )
  const day = 24 * 60 * 60 * 1000
  await withStore(
    { scriptWorkerMax: 999, scriptWorkerEvictIdleMs: 10 * day },
    async (store) => {
      const snapshot = store.snapshot()
      assert.equal(snapshot.scriptWorkerMax, 32)
      assert.equal(snapshot.scriptWorkerEvictIdleMs, day)
    },
  )
})

test('scriptWorker can be switched off and 0 means an unlimited budget', async () => {
  await withStore(undefined, async (store) => {
    const updated = await store.update({ scriptWorker: false, scriptWorkerMax: 0 })
    assert.equal(updated.scriptWorker, false)
    assert.equal(updated.scriptWorkerMax, 0)
  })
})
