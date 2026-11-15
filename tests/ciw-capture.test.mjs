import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DRIVER = path.join(HERE, 'fixtures', 'ciw_capture_driver.py')

/**
 * runtime/vb_ciw.py is pure Python with no bridge imports, so the tests drive it
 * through tests/fixtures/ciw_capture_driver.py and a fake client.  The fake
 * records the capture commands and replays prepared log reads, which is enough
 * to check discovery, the warn-port flush, cursor based reads, classification
 * and the best-effort None paths without a live Virtuoso.
 */
function findPython() {
  const candidates = [process.env.VB_TEST_PYTHON, 'python3', 'python'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        timeout: 15_000,
      })
      if (probe.status === 0 && probe.stdout.trim() === '3') return candidate
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

const PYTHON = findPython()
const NO_PYTHON = PYTHON ? false : 'no python3 interpreter on PATH (set VB_TEST_PYTHON to one)'

test('runtime/vb_ciw.py capture contract', { skip: NO_PYTHON }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vb-ciw-test-'))
  try {
    const driver = path.join(dir, 'ciw_capture_driver.py')
    copyFileSync(DRIVER, driver)
    const result = spawnSync(PYTHON, [driver], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PYTHONPATH: [path.join(ROOT, 'runtime'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    })
    const detail = (result.stdout || '') + (result.stderr || '')
    assert.equal(result.status, 0, detail)
    const payload = JSON.parse(result.stdout.trim().split('\n').pop())
    assert.equal(payload.first.lines.length, 1, detail)
    assert.equal(payload.first.levels[0], 'warning', detail)
    assert.equal(payload.second.lines[0], '*WARNING* second warning', detail)
    assert.equal(payload.third, null, detail)
    assert.equal(payload.flush_failure.lines.length, 1, detail)
    assert.equal(payload.no_log, null, detail)
    assert.equal(payload.garbage, null, detail)
    assert.equal(payload.begin, true, detail)
    assert.equal(payload.begin_cursor, 120, detail)
    assert.equal(payload.after_begin.lines[0], '*WARNING* after begin', detail)
    assert.equal(payload.begin_no_log, false, detail)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
