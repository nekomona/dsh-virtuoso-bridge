#!/usr/bin/env node
/**
 * Lock the tool terminology in site/.
 *
 * "Virtuoso Bridge" is the upstream tool name: it stays English in every
 * language, and the short form "bridge" is kept untranslated too, in the
 * English mirror and in the Simplified Chinese mirror. One spelling means a
 * reader or an agent can grep for it and find every occurrence.
 *
 * This script is the enforcement: a translated spelling fails the build
 * instead of drifting quietly back into the Chinese mirror.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const siteDir = 'site'

/** Spellings that must never appear in either mirror. */
const FORBIDDEN = [
  { id: 'translated-name', pattern: /桥接|桥梁|虚拟桥|桥接器/g, note: 'the tool name was translated' },
]

const files = readdirSync(siteDir).filter((name) => name.endsWith('.html')).sort()
const failures = []

for (const file of files) {
  // Only prose can drift: strip code samples and the vendored package name.
  const prose = readFileSync(join(siteDir, file), 'utf8')
    .replace(/<pre>[\s\S]*?<\/pre>/g, ' ')
    .replace(/virtuoso-bridge/g, ' ')
  for (const rule of FORBIDDEN) {
    const hits = prose.match(rule.pattern) ?? []
    if (hits.length) failures.push(file + ': ' + rule.note + ' (' + hits.length + 'x)')
  }
}

if (failures.length) {
  console.error('Terminology check failed with ' + failures.length + ' problem(s):')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}

console.log('Terminology check passed: ' + files.length + ' pages.')
