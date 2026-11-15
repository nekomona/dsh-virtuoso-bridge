/**
 * Rendering for the CIW diagnostics payload that the sidecar attaches to an API
 * call result or a script job outcome (`value.ciw`).
 *
 * Capture is best effort: the payload can be missing, partial or oddly shaped, so
 * nothing here throws. The block is meant to be appended to an existing tool
 * answer, so it stays compact - one summary line, the captured text, and at most
 * one short truncation note. The log path is opt-in because it is long and the
 * raw payload already carries it.
 */

/** Hard caps that keep a pathological payload from flooding a tool answer. */
export const CIW_MAX_LINES = 40
export const CIW_MAX_CHARS = 6000
const MAX_LINE_CHARS = 500
const MAX_LOG_PATH_CHARS = 300

function asCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

function positiveOption(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function plural(count, one, many) {
  return count + ' ' + (count === 1 ? one : many)
}

/** The CDS.log echo may carry CRLF and ANSI colour escapes; strip them. */
function cleanLine(value) {
  let text = String(value)
  text = text.replace(/\r/g, '')
  text = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  text = text.replace(/[ \t]+$/, '')
  if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + '...'
  return text
}

function capturedLines(ciw) {
  if (!ciw || typeof ciw !== 'object' || Array.isArray(ciw)) return []
  if (!Array.isArray(ciw.lines)) return []
  const lines = []
  for (const item of ciw.lines) {
    if (typeof item !== 'string') continue
    const text = cleanLine(item)
    if (text) lines.push(text)
  }
  return lines
}

function cleanLogPath(value) {
  if (typeof value !== 'string') return ''
  const logPath = value.trim().replace(/[\r\n]+/g, ' ')
  if (!logPath) return ''
  return logPath.length > MAX_LOG_PATH_CHARS ? logPath.slice(0, MAX_LOG_PATH_CHARS) + '...' : logPath
}

/** Number of usable CIW text lines (non-string entries are ignored). */
export function ciwLineCount(ciw) {
  try {
    return capturedLines(ciw).length
  } catch {
    return 0
  }
}

/**
 * One-line header such as
 * `--- CIW: 1 warning, 1 error, 1 output line (41 other lines) ---`.
 * Returns '' when the payload has nothing worth reporting. With
 * `options.logPath === true` the log path joins the header, but only when text
 * lines are rendered, so the block stays compact.
 */
export function ciwSummary(ciw, options = {}) {
  try {
    if (!ciw || typeof ciw !== 'object' || Array.isArray(ciw)) return ''
    const warnings = asCount(ciw.warnings)
    const errors = asCount(ciw.errors)
    const output = asCount(ciw.output)
    const otherLines = asCount(ciw.otherLines)
    const lines = capturedLines(ciw)
    const parts = []
    if (warnings) parts.push(plural(warnings, 'warning', 'warnings'))
    if (errors) parts.push(plural(errors, 'error', 'errors'))
    if (output) parts.push(plural(output, 'output line', 'output lines'))
    if (parts.length === 0) {
      if (lines.length === 0) return ''
      parts.push(plural(lines.length, 'line', 'lines'))
    }
    let summary = '--- CIW: ' + parts.join(', ')
    if (otherLines) summary += ' (' + plural(otherLines, 'other line', 'other lines') + ')'
    if (options?.logPath === true && lines.length > 0) {
      const logPath = cleanLogPath(ciw.logPath)
      if (logPath) summary += ' | ' + logPath
    }
    return summary + ' ---'
  } catch {
    return ''
  }
}

/**
 * The block to append to a tool answer, or '' when there is nothing to show.
 *
 * @param {object} ciw sidecar CIW payload
 * @param {{maxLines?: number, maxChars?: number, logPath?: boolean}} [options]
 * @returns {string}
 */
export function formatCiwBlock(ciw, options = {}) {
  try {
    const summary = ciwSummary(ciw, { logPath: options?.logPath === true })
    if (!summary) return ''
    const lines = capturedLines(ciw)
    const maxLines = positiveOption(options?.maxLines, CIW_MAX_LINES)
    const maxChars = positiveOption(options?.maxChars, CIW_MAX_CHARS)
    const body = []
    let chars = 0
    let dropped = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (body.length >= maxLines || (chars > 0 && chars + line.length + 1 > maxChars)) {
        dropped = lines.length - index
        break
      }
      body.push(line)
      chars += line.length + 1
    }
    if (dropped > 0) body.push('... (' + plural(dropped, 'more line', 'more lines') + ')')
    if (ciw?.truncated === true) body.push('... (cut to fit)')
    return [summary, ...body].join('\n')
  } catch {
    return ''
  }
}
