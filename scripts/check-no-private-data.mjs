#!/usr/bin/env node
/**
 * check-no-private-data.mjs — fail when tracked files look like they contain
 * personal or machine-specific data that must not ship in a public repository.
 *
 * Scope: every file reported by `git ls-files -z` from the repository root.
 * `virtuoso-bridge-lite/` is skipped because it is a pinned upstream snapshot reviewed by
 * its own project, and this script skips itself so its example patterns cannot
 * trip the scan.
 *
 * Usage:
 *   node scripts/check-no-private-data.mjs
 *
 * Exit codes:
 *   0  clean
 *   1  at least one tracked file matched a rule
 *   2  the scan could not run (git failure, unreadable tracked file)
 *
 * Node.js >= 20, no dependencies.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { accountRule, matchRules, readLocalGuardAccounts } from './lib/private-rules.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join('/')

/**
 * ALLOW-LIST (deliberate, documented exceptions)
 * ---------------------------------------------------------------------------
 * The rules below flag data that is private in general, but a public plugin
 * legitimately documents placeholder values. Matching text is allowed only
 * when it is one of these exact, reviewable placeholders:
 *
 *   - `127.0.0.0/8` and `127.0.0.1`   local loopback default, never a host
 *   - `::1`, `localhost`              IPv6/IPv4 loopback names (no IPv4 rule hit)
 *   - `/home/username`                documented Unix home-directory placeholder
 *   - `C:\Users\me` (and `C:/Users/me`) documented Windows profile placeholder
 *   - `C:\src\...`, `C:\path\to\...`  documented Windows path examples
 *   - `/projects/...`, `/opt/...`, `/site/...`
 *                                     documented deployment path examples
 *   - `@example.com` (and .org/.net)  documentation email placeholders
 *   - `git@github.com`                public GitHub SSH remote user, not a person
 *   - `<name>.example.com`            documentation hostname placeholders
 *   - `virtuoso-bridge-lite.pin.json`'s `commit` and `commitDate`
 *                                     upstream provenance values, intentionally
 *                                     published; timestamps are also not flagged
 *                                     in any `.json` data file
 *
 * Anything else that matches a rule is reported; add an exception here only
 * after confirming the value is a documented placeholder, never a real value.
 *
 * Separately, `.local-guard.json` may exist at the repository root with
 * `{ "accountNames": [...] }`. It is gitignored and local-only: it lets a
 * developer flag their own account names without ever committing them.
 */
/** Read the pin once so the timestamp rule can allow its provenance values. */
function readPinProvenance() {
  try {
    const pin = JSON.parse(readFileSync(join(REPO_ROOT, 'virtuoso-bridge-lite.pin.json'), 'utf8'))
    return { commit: pin.commit, commitDate: pin.commitDate }
  } catch {
    return { commit: undefined, commitDate: undefined }
  }
}
const PIN_PROVENANCE = readPinProvenance()

/** Local, gitignored account names; empty in CI, so the rule is inert there. */
const LOCAL_ACCOUNT_NAMES = readLocalGuardAccounts()

const ISO_TIMESTAMP_RULE = {
  id: 'iso-timestamp',
  // Machine timestamps in prose/source; JSON data may legitimately carry them.
  pattern: /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  allow: (match, _groups, file) =>
    file.endsWith('.json') ||
    (file === 'virtuoso-bridge-lite.pin.json' &&
      (match === PIN_PROVENANCE.commitDate || match === PIN_PROVENANCE.commit)),
}

const EXTRA_RULES = [accountRule(LOCAL_ACCOUNT_NAMES), ISO_TIMESTAMP_RULE].filter(Boolean)
function listTrackedFiles() {
  let output
  try {
    output = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    console.error(`check-no-private-data: cannot list tracked files (git ls-files -z failed: ${error.code || error.message}).`)
    console.error('Run this from a git checkout with git installed, then retry.')
    process.exit(2)
  }
  return output.split('\0').filter(Boolean)
}

function main() {
  const tracked = listTrackedFiles()
  const hits = []
  let scanned = 0
  let skippedBinary = 0
  let skippedUntrackedScope = 0

  for (const file of tracked) {
    // `virtuoso-bridge-lite` is a submodule gitlink; its tree is the pinned upstream source.
    if (file === 'virtuoso-bridge-lite' || file.startsWith('virtuoso-bridge-lite/')) {
      skippedUntrackedScope += 1
      continue
    }
    if (file === SELF) {
      skippedUntrackedScope += 1
      continue
    }

    const absolute = join(REPO_ROOT, ...file.split('/'))
    let buffer
    try {
      const info = statSync(absolute)
      if (!info.isFile()) {
        skippedUntrackedScope += 1
        continue
      }
      buffer = readFileSync(absolute)
    } catch (error) {
      console.error(`check-no-private-data: cannot read tracked file ${file} (${error.code || error.message}); the scan is incomplete.`)
      process.exit(2)
    }

    if (buffer.includes(0)) {
      skippedBinary += 1
      continue
    }

    scanned += 1
    const lines = buffer.toString('utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      for (const rule of matchRules(line, { file, extraRules: EXTRA_RULES })) {
        hits.push({ file, line: index + 1, rule })
      }
    }
  }

  if (hits.length > 0) {
    for (const hit of hits) {
      console.log(`${hit.file}:${hit.line}: [${hit.rule}]`)
    }
    console.error(
      `check-no-private-data: FAILED — ${hits.length} hit(s) in ${new Set(hits.map((hit) => hit.file)).size} file(s). ` +
        'Remove or replace private values; only documented placeholders listed in scripts/lib/private-rules.mjs may remain. Matched values are redacted.',
    )
    process.exit(1)
  }

  console.log(
    `check-no-private-data: clean — ${scanned} tracked text file(s) scanned` +
      ` (${skippedBinary} binary skipped, ${skippedUntrackedScope} virtuoso-bridge-lite/script path(s) excluded, ` +
      `${LOCAL_ACCOUNT_NAMES.length} local account term(s) loaded).`,
  )
  process.exit(0)
}

main()
