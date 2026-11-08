#!/usr/bin/env node
/**
 * check-no-private-data.mjs — fail when tracked files look like they contain
 * personal or machine-specific data that must not ship in a public repository.
 *
 * Scope: every file reported by `git ls-files -z` from the repository root.
 * `vendor/` is skipped because it is a pinned upstream snapshot reviewed by
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
 *   - `vendor.pin.json`'s `commit` and `commitDate`
 *                                     upstream provenance values, intentionally
 *                                     published; timestamps are also not flagged
 *                                     in any `.json` data file
 *
 * Anything else that matches a rule is reported; add an exception here only
 * after confirming the value is a documented placeholder, never a real value.
 */
const EXAMPLE_EMAIL_DOMAINS = /@(?:example\.(?:com|org|net))$/i
/** The SSH remote user for github.com is a public service account, not a person. */
const GITHUB_SSH_REMOTE_USER = /^git@github\.com$/i
const UNIX_HOME_PLACEHOLDERS = new Set(['/home/username'])
const WINDOWS_PROFILE_PLACEHOLDERS = new Set(['me'])

/** Read the pin once so the timestamp rule can allow its provenance values. */
function readPinProvenance() {
  try {
    const pin = JSON.parse(readFileSync(join(REPO_ROOT, 'vendor.pin.json'), 'utf8'))
    return { commit: pin.commit, commitDate: pin.commitDate }
  } catch {
    return { commit: undefined, commitDate: undefined }
  }
}
const PIN_PROVENANCE = readPinProvenance()

const rules = [
  {
    id: 'email',
    // Any address-shaped token; example.* domains are documentation placeholders.
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: (match) => EXAMPLE_EMAIL_DOMAINS.test(match) || GITHUB_SSH_REMOTE_USER.test(match),
  },
  {
    id: 'ipv4',
    // Dotted quad. Loopback stays allowed; everything else may name a real host.
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    allow: (match) => {
      const octets = match.split('.').map(Number)
      if (octets.some((octet) => octet > 255)) return true // not an IPv4 literal
      return octets[0] === 127 // 127.0.0.0/8 loopback
    },
  },
  {
    id: 'home-path',
    // Absolute Unix home/mount paths name a real account or machine.
    pattern: /\/(?:home|Users|mnt)\/[A-Za-z0-9._-]+/g,
    allow: (match) => UNIX_HOME_PLACEHOLDERS.has(match),
  },
  {
    id: 'windows-profile',
    // Windows user-profile paths; only the documented `C:\Users\me` placeholder.
    pattern: /C:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)/gi,
    allow: (match, groups) => WINDOWS_PROFILE_PLACEHOLDERS.has((groups[1] || '').toLowerCase()),
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    allow: () => false,
  },
  {
    id: 'ssh-public-key',
    pattern: /\bssh-(?:rsa|ed25519)\s+AAAA[A-Za-z0-9+/=]{8,}/g,
    allow: () => false,
  },
  {
    id: 'credential-assignment',
    // `password = "..."`, `api_key: '...'`, `token: "..."` — a quoted secret value.
    pattern: /\b(?:password|passphrase|api[_-]?key|token)\b\s*[:=]\s*(["'])([^"'\n]{1,})\1/gi,
    allow: () => false,
  },
  {
    id: 'iso-timestamp',
    // Machine timestamps in prose/source; JSON data may legitimately carry them.
    pattern: /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    allow: (match, groups, file) =>
      file.endsWith('.json') ||
      (file === 'vendor.pin.json' &&
        (match === PIN_PROVENANCE.commitDate || match === PIN_PROVENANCE.commit)),
  },
]

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
    // `vendor` is a submodule gitlink; `vendor/**` is the upstream snapshot.
    if (file === 'vendor' || file.startsWith('vendor/')) {
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
      for (const rule of rules) {
        const matches = [...line.matchAll(rule.pattern)]
        for (const match of matches) {
          if (rule.allow(match[0], match, file)) continue
          hits.push({ file, line: index + 1, rule: rule.id, text: match[0].trim() })
        }
      }
    }
  }

  if (hits.length > 0) {
    for (const hit of hits) {
      console.log(`${hit.file}:${hit.line}: [${hit.rule}] ${hit.text}`)
    }
    console.error(
      `check-no-private-data: FAILED — ${hits.length} hit(s) in ${new Set(hits.map((hit) => hit.file)).size} file(s). ` +
        'Remove or replace private values; only documented placeholders listed at the top of this script may remain.',
    )
    process.exit(1)
  }

  console.log(
    `check-no-private-data: clean — ${scanned} tracked text file(s) scanned` +
      ` (${skippedBinary} binary skipped, ${skippedUntrackedScope} vendor/script path(s) excluded).`,
  )
  process.exit(0)
}

main()
