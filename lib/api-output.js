/**
 * Compact, budget-aware rendering for `virtuoso_bridge_api`.
 *
 * The Python sidecar describes the whole bridge tree in one payload. For the
 * current API that is roughly half a megabyte: every method of every target,
 * each with a full docstring and a parameter table. Rendering that verbatim
 * blew the inline tool budget, so the reply was cut off in the middle of the
 * JSON and an agent could not discover any method at all.
 *
 * This module answers at three zoom levels instead — index, one target, one
 * method — keeps every answer inside a fixed character budget, and writes the
 * complete payload to the large-result cache when even a zoomed answer does
 * not fit, so nothing is ever silently dropped.
 */
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Inline budget for one tool answer, in characters. */
export const API_INLINE_CHARS = 14_000

/**
 * Reserved room for the line that explains a cut. A note saying *what* was
 * dropped is part of the answer, so it is budgeted separately and can never be
 * squeezed out by the listing it describes.
 */
const NOTE_CHARS = 220

/** Smallest limit a caller can force; below this only the header would fit. */
const MIN_LIMIT = 400

const SUMMARY_CHARS = 140
const DOC_CHARS = 3_000
const MAX_INDEX_ENTRIES = 600
const NAME_WIDTH = 34
const CLASS_WIDTH = 26

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function targetsOf(payload) {
  return asObject(payload?.targets)
}

function classesOf(payload) {
  return asObject(payload?.classes)
}

function methodsOf(node) {
  return Array.isArray(node?.methods) ? node.methods : []
}

function propertiesOf(node) {
  return Array.isArray(node?.properties) ? node.properties : []
}

function nameOf(entry) {
  return String(entry?.name ?? '').trim()
}

function firstLine(text) {
  return String(text ?? '')
    .trim()
    .split(/\r?\n/, 1)[0]
    .trim()
}

function clip(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/** `1 method`, `2 methods` — counts are read by agents, so keep them literal. */
function count(value, word, plural) {
  return `${value} ${value === 1 ? word : (plural ?? `${word}s`)}`
}

/** `34 methods, 11 properties` for one described node. */
function countsOf(node) {
  const properties = propertiesOf(node).length
  return `${count(methodsOf(node).length, 'method')}${properties ? `, ${count(properties, 'property', 'properties')}` : ''}`
}

/** Honours an explicit limit; anything unusable falls back to the default. */
function normaliseLimit(value) {
  const limit = Number(value)
  return Number.isFinite(limit) && limit >= MIN_LIMIT ? Math.floor(limit) : API_INLINE_CHARS
}

/** Keeps the lines that fit the budget, in order. */
function fillLines(candidates, budget) {
  const lines = []
  let used = 0
  for (const candidate of candidates) {
    const line = String(candidate)
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  return lines
}

function usedChars(lines) {
  return lines.reduce((total, line) => total + line.length + 1, 0)
}

/** Wraps a short label/value list so names stay on readable lines. */
function wrapLines(label, values) {
  if (!values.length) return []
  const lines = []
  let line = `${label} (${values.length}): ${values[0]}`
  for (const value of values.slice(1)) {
    if (`${line}, ${value}`.length <= 150) {
      line = `${line}, ${value}`
      continue
    }
    lines.push(line)
    line = `  ${value}`
  }
  lines.push(line)
  return lines
}

function summaryOf(entry) {
  const text = firstLine(entry?.summary) || firstLine(entry?.doc)
  return clip(text, SUMMARY_CHARS)
}

function formatDefault(value) {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/** A method signature the way the sidecar reported it, rebuilt if missing. */
function signatureOf(method) {
  const reported = typeof method?.signature === 'string' ? method.signature.trim() : ''
  if (reported) return reported
  const params = Array.isArray(method?.params) ? method.params : []
  const text = params
    .map((param) => (param?.required ? String(param.name) : `${param?.name}=${formatDefault(param?.default)}`))
    .join(', ')
  return `(${text})`
}

/** Hard cap, so no rendered answer can exceed the budget it was given. */
function clamp(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const note = `\n... (${value.length - limit} more chars)`
  return `${value.slice(0, Math.max(0, limit - note.length))}${note}`
}

function describeIndex(payload, limit) {
  const targets = targetsOf(payload)
  const classes = classesOf(payload)
  const targetPaths = Object.keys(targets).sort()
  const classNames = Object.keys(classes).sort()
  if (!targetPaths.length && !classNames.length) {
    throw new Error('describe returned no targets; the bridge API tree is empty')
  }
  const head = [`virtuoso-bridge API${payload?.runtime ? ` — runtime ${payload.runtime}` : ''}`, '', `targets (${targetPaths.length}):`]
  const tail = [
    '',
    firstLine(payload?.hint) ||
      'Describe one target for its method signatures; add method=<name> for one method with full documentation.',
    '  action=describe target=<path>            list methods with signatures',
    '  action=describe target=<path> method=<m> full documentation for one method',
  ]
  // The header and the hints are fixed; only the rows compete for the rest.
  let remaining = limit - `${head.join('\n')}\n${tail.join('\n')}`.length - NOTE_CHARS
  const classCandidates = classNames.slice(0, MAX_INDEX_ENTRIES).map((className) => {
    const node = asObject(classes[className])
    return `  ${`class:${className}`.padEnd(NAME_WIDTH)}  ${String(node.class ?? className).padEnd(CLASS_WIDTH)}  ${countsOf(node)}`
  })
  // Classes are documentation aids; targets are what an agent starts from.
  const fittedClasses = fillLines(classCandidates, Math.max(0, Math.min(remaining >> 2, 600)))
  remaining -= usedChars(fittedClasses)
  const rowCandidates = targetPaths.slice(0, MAX_INDEX_ENTRIES).map((targetPath) => {
    const node = asObject(targets[targetPath])
    const error = typeof node.$error === 'string' ? node.$error : ''
    return `  ${targetPath.padEnd(NAME_WIDTH)}  ${(error ? 'error' : String(node.class ?? '?')).padEnd(CLASS_WIDTH)}  ${
      error ? `unavailable — ${clip(error, 120)}` : countsOf(node)
    }`
  })
  const fittedRows = fillLines(rowCandidates, remaining)
  const complete = fittedRows.length === targetPaths.length && fittedClasses.length === classNames.length
  const notes = []
  if (fittedClasses.length < classNames.length) {
    notes.push(`  ... (${classNames.length - fittedClasses.length} more classes)`)
  }
  if (fittedRows.length < targetPaths.length) {
    notes.push(`  ... (${targetPaths.length - fittedRows.length} more targets; describe target=<path> for one)`)
  }
  const lines = [
    ...head,
    ...fittedRows,
    ...(classNames.length ? ['', `classes (${classNames.length}):`, ...fittedClasses] : []),
    ...notes,
    ...tail,
  ]
  return { text: clamp(lines.join('\n'), limit), complete }
}

/** Locates a described node across the three payload shapes the sidecar returns. */
function locate(payload, target) {
  const requested = String(target ?? '').trim()
  if (!requested) return undefined
  const object = asObject(payload?.object)
  if (Object.keys(object).length) return { kind: 'object', node: object, path: String(object.path ?? requested) }
  const describedClass = asObject(payload?.class)
  if (Object.keys(describedClass).length) return { kind: 'class', node: describedClass, path: requested }
  const targets = targetsOf(payload)
  if (targets[requested]) return { kind: 'object', node: asObject(targets[requested]), path: requested }
  const className = requested.replace(/^class:/, '')
  const classes = classesOf(payload)
  if (classes[className]) return { kind: 'class', node: asObject(classes[className]), path: `class:${className}` }
  return undefined
}

function availableTargets(payload) {
  const names = Object.keys(targetsOf(payload)).sort()
  for (const className of Object.keys(classesOf(payload)).sort()) names.push(`class:${className}`)
  return names
}

function unknownTarget(payload, target) {
  const available = availableTargets(payload)
  const message = available.length
    ? `unknown target ${JSON.stringify(String(target))}. Available: ${available.join(', ')}`
    : `unknown target ${JSON.stringify(String(target))}; describe without a target lists the available targets`
  const error = new Error(message)
  error.code = 'UNKNOWN_TARGET'
  return error
}

function methodNamesOf(node) {
  return methodsOf(node).map(nameOf).filter(Boolean)
}

/** One method rendered on one line: `name(sig) -> ret — summary`. */
function methodLine(method) {
  const summary = summaryOf(method)
  const head = `${nameOf(method) || '?'}${signatureOf(method)}`
  return summary ? `${head} — ${summary}` : head
}

function describeTarget(payload, target, limit) {
  const located = locate(payload, target)
  if (!located) throw unknownTarget(payload, target)
  const node = located.node
  const methods = methodsOf(node)
  const properties = propertiesOf(node).map(nameOf).filter(Boolean)
  const children = Object.keys(asObject(node.children)).sort()
  const head = [`${located.path} — ${String(node.class ?? located.path)}${node.module ? ` (${node.module})` : ''}`]
  const summary = firstLine(node.summary)
  if (summary) head.push('', `  ${clip(summary, 240)}`)
  const tail = ['', 'add method=<name> for one method with full documentation']
  let remaining = limit - `${head.join('\n')}\n${tail.join('\n')}`.length - NOTE_CHARS
  const methodCandidates = methods.map((method) => `  ${methodLine(method)}`)
  // Properties and child targets are short; hold a slice back for them.
  const fittedMethods = fillLines(methodCandidates, Math.max(0, remaining - 320))
  remaining -= usedChars(fittedMethods)
  const propertyLines = wrapLines('properties', properties)
  const childLines = wrapLines('children', children)
  const fittedProperties = fillLines(propertyLines, Math.max(0, remaining >> 1))
  remaining -= usedChars(fittedProperties)
  const fittedChildren = fillLines(childLines, Math.max(0, remaining))
  const complete =
    fittedMethods.length === methodCandidates.length &&
    fittedProperties.length === propertyLines.length &&
    fittedChildren.length === childLines.length
  const notes = []
  if (fittedMethods.length < methodCandidates.length) {
    notes.push(
      `  ... (${methodCandidates.length - fittedMethods.length} more methods; describe target=<path> method=<name> for one)`,
    )
  }
  if (fittedProperties.length < propertyLines.length || fittedChildren.length < childLines.length) {
    notes.push('  ... (listing cut to fit the answer budget)')
  }
  const lines = [
    ...head,
    ...(methods.length ? ['', `methods (${methods.length}):`, ...fittedMethods] : []),
    ...(properties.length ? ['', ...fittedProperties] : []),
    ...(children.length ? ['', ...fittedChildren] : []),
    ...notes,
    ...tail,
  ]
  return { text: clamp(lines.join('\n'), limit), complete }
}

function parameterTable(method) {
  const params = Array.isArray(method?.params) ? method.params : []
  if (!params.length) return []
  const width = Math.min(Math.max(...params.map((param) => String(param?.name ?? '').length)), 26)
  const lines = [`params (${params.length}):`]
  for (const param of params) {
    const bits = []
    if (param?.annotation) bits.push(String(param.annotation))
    bits.push(param?.required ? 'required' : `default ${formatDefault(param?.default)}`)
    if (param?.kind && param.kind !== 'POSITIONAL_OR_KEYWORD') bits.push(String(param.kind).toLowerCase())
    lines.push(`  ${String(param?.name ?? '?').padEnd(width)}  ${bits.join(' · ')}`)
  }
  return lines
}

function describeMethod(payload, target, methodName, limit) {
  const located = locate(payload, target)
  if (!located) throw unknownTarget(payload, target)
  const methods = methodsOf(located.node)
  const method = methods.find((entry) => nameOf(entry) === String(methodName).trim())
  if (!method) {
    const names = methodNamesOf(located.node)
    throw new Error(`target ${JSON.stringify(located.path)} has no method ${JSON.stringify(String(methodName).trim())}. Methods: ${names.join(', ')}`)
  }
  const head = [`${located.path}.${nameOf(method)}${signatureOf(method)}`]
  const summary = firstLine(method.summary)
  const doc = String(method.doc ?? '').trim()
  // The docstring normally opens with the summary; print it once.
  if (summary && !doc.startsWith(summary)) head.push('', `  ${clip(summary, 240)}`)
  let remaining = limit - head.join('\n').length - NOTE_CHARS
  const docLines = doc
    ? ['', ...clip(doc, DOC_CHARS).split(/\r?\n/).map((line) => (line ? `  ${line}` : ''))]
    : []
  const table = parameterTable(method)
  const tableLines = table.length ? ['', ...table] : []
  const fittedDoc = fillLines(docLines, Math.max(0, remaining))
  remaining -= usedChars(fittedDoc)
  const fittedTable = fillLines(tableLines, Math.max(0, remaining))
  const docCut = fittedDoc.length < docLines.length
  const tableCut = fittedTable.length < tableLines.length
  const notes = []
  if (docCut) notes.push('  ... (docstring cut to fit the answer budget)')
  if (tableCut) notes.push('  ... (parameter table cut to fit the answer budget; see target=<path> for the signature)')
  return {
    text: clamp([...head, ...fittedDoc, ...fittedTable, ...notes].join('\n'), limit),
    complete: !docCut && !tableCut,
  }
}

/** `method=<name>` without a target: report which targets define it. */
function describeMethodSearch(payload, methodName, limit) {
  const wanted = String(methodName).trim()
  const matches = []
  for (const [targetPath, node] of Object.entries(targetsOf(payload))) {
    if (methodNamesOf(node).includes(wanted)) matches.push(targetPath)
  }
  for (const [className, node] of Object.entries(classesOf(payload))) {
    if (methodNamesOf(node).includes(wanted)) matches.push(`class:${className}`)
  }
  if (!matches.length) {
    throw new Error(`no target defines a method named ${JSON.stringify(wanted)}; describe without a target lists the available targets`)
  }
  const head = [`targets with method ${wanted} (${matches.length}):`]
  const tail = ['', `narrow with target=<path> method=${wanted}`]
  const candidates = matches.slice(0, MAX_INDEX_ENTRIES).map((match) => `  ${match}`)
  const fitted = fillLines(candidates, limit - `${head.join('\n')}\n${tail.join('\n')}`.length - NOTE_CHARS)
  const notes = fitted.length < matches.length ? [`  ... (${matches.length - fitted.length} more targets)`] : []
  return {
    text: clamp([...head, ...fitted, ...notes, ...tail].join('\n'), limit),
    complete: fitted.length === matches.length,
  }
}

/**
 * Renders an `action=describe` payload.
 *
 * @param {object} payload sidecar describe result (index, object or class shape)
 * @param {{target?: string, method?: string, limit?: number}} options
 * @returns {{text: string, complete: boolean}}
 */
export function formatDescription(payload, options = {}) {
  const limit = normaliseLimit(options.limit)
  const target = options.target
  const method = options.method
  if (method) {
    if (!target) return describeMethodSearch(payload, method, limit)
    return describeMethod(payload, target, method, limit)
  }
  if (target) return describeTarget(payload, target, limit)
  return describeIndex(payload, limit)
}

/** Pretty-prints any structured value within the budget. */
export function formatJsonResult(value, options = {}) {
  const limit = normaliseLimit(options.limit)
  let json
  try {
    json = JSON.stringify(value, null, 2)
  } catch {
    json = String(value)
  }
  if (json.length <= limit) return { text: json, complete: true }
  const note = `\n... (preview of a ${json.length.toLocaleString()}-char result)`
  return { text: `${json.slice(0, Math.max(0, limit - note.length))}${note}`, complete: false }
}

function safeName(value) {
  return String(value ?? 'result')
    .replace(/[^\dA-Za-z._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'result'
}

function stamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
    randomBytes(2).toString('hex'),
  ].join('-')
}

/** Stable, greppable file name for one spilled answer. */
export function resultFileName(action, args = {}, now = new Date()) {
  const parts = [String(action ?? 'result')]
  if (args?.target) parts.push(String(args.target))
  if (args?.method) parts.push(String(args.method))
  return safeName(`api-${parts.join('-')}-${stamp(now)}`)
}

/** Writes the complete result to the large-result cache (created on demand). */
export async function spillResult(text, options = {}) {
  const dir = String(options.dir ?? '').trim()
  if (!dir) throw new Error('no directory is configured for large results')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${safeName(options.name)}.json`)
  await fsp.writeFile(file, String(text ?? ''), 'utf8')
  return { path: file, chars: String(text ?? '').length }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Composes the preview and the spill footer inside the caller's budget.
 *
 * The footer is the only route to the complete result, so it is kept whole and
 * the preview is what shrinks. Only a budget too small to hold the footer at
 * all is truncated, and then it still keeps as much of the path as possible.
 */
function composeAnswer(bodyText, footer, limit) {
  const separator = '\n\n'
  const full = `${bodyText}${separator}${footer}`
  if (full.length <= limit) return full
  if (footer.length + 40 >= limit) return clamp(`... ${footer}`, limit)
  const room = limit - separator.length - footer.length
  const cut = '\n... '
  const preview =
    bodyText.length <= room ? bodyText : `${bodyText.slice(0, Math.max(0, room - cut.length))}${cut}`
  return `${preview}${separator}${footer}`
}

/**
 * Turns a bridge API result into the tool answer: compact text first, and a
 * spilled file plus its path when the answer does not fit.
 *
 * @returns {Promise<{text: string, overflow?: {path: string, chars: number}}>}
 */
export async function presentApiResult(options = {}) {
  const limit = normaliseLimit(options.limit)
  const action = options.action === 'describe' ? 'describe' : 'call'
  const args = asObject(options.args)
  const rendered =
    action === 'describe'
      ? formatDescription(options.value, { target: args.target, method: args.method, limit })
      : formatJsonResult(options.value, { limit })
  if (rendered.complete) return { text: clamp(rendered.text, limit) }
  let full
  try {
    full = JSON.stringify(options.value, null, 2)
  } catch {
    full = String(options.value)
  }
  try {
    const spilled = await spillResult(full, {
      dir: options.resultsDir,
      name: options.name || resultFileName(action, args, options.now),
    })
    const footer =
      `... (answer cut to the ${limit.toLocaleString()}-char budget; the complete ` +
      `${spilled.chars.toLocaleString()}-char result is in ${spilled.path}` +
      `\nRead that file, or narrow the request with target=<path> / method=<name> so the answer fits.)`
    return {
      text: composeAnswer(rendered.text, footer, limit),
      overflow: { path: spilled.path, chars: spilled.chars },
    }
  } catch (error) {
    // The caller still needs to know why the full result is unavailable, so the
    // explanation keeps its room and the preview is what gets shortened.
    const footer =
      `... (answer cut to the ${limit.toLocaleString()}-char budget and the complete result could not be written: ${messageOf(error)})`
    return { text: composeAnswer(rendered.text, footer, limit) }
  }
}
