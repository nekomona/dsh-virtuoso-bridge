/**
 * Where a script job's Python source comes from: inline `code` or a file.
 *
 * The script tool lets an agent author a batch script with the ordinary harness
 * file tools and then run it by `path`. Relative paths mean the Session working
 * directory, so `path: "batch.py"` names the same file the agent wrote there,
 * and the read -> edit -> rerun loop works without pasting the body again.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** A larger body is data, not a script; keep the job copies predictable. */
export const MAX_SCRIPT_BYTES = 1_000_000

/** Resolve a script path against `cwd`; absolute paths pass through unchanged. */
export function resolveScriptPath(filePath, cwd = process.cwd()) {
  const text = String(filePath ?? '').trim()
  if (!text) throw new Error('script path is empty')
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(cwd || process.cwd(), text)
}

function readFailure(error, resolved) {
  const code = error?.code
  if (code === 'ENOENT') return new Error(`script file not found: ${resolved}`)
  if (code === 'EISDIR') return new Error(`script path is a directory: ${resolved}`)
  if (code === 'EACCES' || code === 'EPERM') return new Error(`script file is not readable: ${resolved}`)
  return new Error(`cannot read script file ${resolved}: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Read one script source. `code` and `filePath` are mutually exclusive; a run
 * needs exactly one of them, and a file is validated before the body is copied
 * into the job directory. Returns `{code, source}` where `source` records the
 * origin for job metadata (the dashboard and runtime panel show it).
 */
export async function readScriptSource(options = {}) {
  const inline = typeof options.code === 'string' ? options.code : ''
  const filePath = typeof options.filePath === 'string' ? options.filePath.trim() : ''
  if (filePath && inline.trim()) throw new Error('pass either code or path to a script run, not both')
  if (!filePath) {
    if (!inline.trim()) throw new Error('script code is empty')
    return { code: inline, source: { kind: 'inline' } }
  }
  const resolved = resolveScriptPath(filePath, options.cwd)
  const stat = options.stat ?? ((target) => fsp.stat(target))
  const readText = options.readFile ?? ((target) => fsp.readFile(target, 'utf8'))
  let info
  try {
    info = await stat(resolved)
  } catch (error) {
    throw readFailure(error, resolved)
  }
  if (typeof info?.isFile === 'function' && !info.isFile()) {
    throw new Error(`script path is not a regular file: ${resolved}`)
  }
  if (Number(info?.size) > MAX_SCRIPT_BYTES) {
    throw new Error(`script file is too large (${info.size} bytes; limit ${MAX_SCRIPT_BYTES}): ${resolved}`)
  }
  let code
  try {
    code = await readText(resolved)
  } catch (error) {
    throw readFailure(error, resolved)
  }
  if (!String(code).trim()) throw new Error(`script file is empty: ${resolved}`)
  return { code, source: { kind: 'file', path: resolved } }
}

/** One short label for job metadata and the runtime panel. */
export function describeScriptSource(source) {
  if (!source) return 'inline'
  if (source.kind !== 'file') return 'inline'
  return path.basename(String(source.path ?? 'script.py'))
}
