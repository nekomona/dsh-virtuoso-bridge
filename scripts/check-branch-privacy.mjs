#!/usr/bin/env node
/**
 * check-branch-privacy.mjs — fail when the commits on this branch put private
 * infrastructure data into a commit message or a committed change.
 *
 * What is checked
 *   - every commit message in the selected range (subject and body);
 *   - every added line in the range's diff, plus added file paths;
 *   - optionally, the uncommitted changes (`--worktree`).
 *
 * What is considered private
 *   - values derived from the local plugin settings (~/.dsh/virtuoso-bridge/*):
 *     server/connection names, hosts, and SSH users;
 *   - the current account name and home directory;
 *   - additional comma-separated names from `VB_PRIVATE_NAMES`;
 *   - generic private shapes: non-loopback IPv4, Unix/Windows home paths,
 *     non-example e-mail addresses, private keys and quoted credentials.
 *
 * The git author/committer identity is deliberately not scanned: the repository
 * owner's git user is an accepted exception. Documented placeholders
 * (`*.example`, `/home/username`, `C:\Users\me`, loopback addresses) are
 * allowed; matched values are never echoed, because CI logs are public too.
 *
 * Usage
 *   node scripts/check-branch-privacy.mjs [--base <ref-or-sha>] [--worktree]
 *
 * The range defaults to the merge base of HEAD and origin/main (or main),
 * falling back to HEAD^..HEAD. Exit codes: 0 clean, 1 hits, 2 scan failure.
 *
 * Node.js >= 20, no dependencies.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GENERIC_RULES,
  maskDocumentedPlaceholders,
  readLocalGuardAccounts,
  tokenPattern,
} from './lib/private-rules.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const ZERO_SHA = /^0{40}$/

const COMMON_PLACEHOLDER_NAMES = new Set([
  'admin',
  'designer',
  'example',
  'host',
  'localhost',
  'me',
  'root',
  'user',
  'username',
])

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (allowFailure) return undefined
    const detail = error?.stderr ? String(error.stderr).trim() : error?.message || String(error)
    console.error(`check-branch-privacy: git ${args.join(' ')} failed: ${detail}`)
    process.exit(2)
  }
}

function resolveRange(baseArg) {
  let base = String(baseArg || '').trim()
  if (base && ZERO_SHA.test(base)) base = ''
  if (!base) {
    for (const ref of ['origin/main', 'main']) {
      if (git(['rev-parse', '--verify', '--quiet', ref], { allowFailure: true })) {
        base = ref
        break
      }
    }
  }
  let start
  if (base && git(['rev-parse', '--verify', '--quiet', base], { allowFailure: true })) {
    start = git(['merge-base', 'HEAD', base], { allowFailure: true })?.trim() || base
  }
  if (!start) {
    start = git(['rev-parse', '--verify', '--quiet', 'HEAD^'], { allowFailure: true })?.trim()
    if (!start) {
      // First commit in the repository: compare against git's empty tree.
      start = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    }
  }
  if (!start) {
    console.error('check-branch-privacy: cannot determine a base commit to compare against.')
    process.exit(2)
  }
  return { range: `${start}..HEAD`, base: start }
}

// ---------------------------------------------------------------------------
// private values derived from this machine (never printed, never committed)
// ---------------------------------------------------------------------------

function pluginSettingsFiles() {
  const files = new Set()
  const configured = String(process.env.VB_PLUGIN_DATA_DIR || '').trim()
  if (configured) {
    const candidate = join(configured, 'settings.json')
    if (existsSync(candidate)) files.add(candidate)
  }
  const root = join(os.homedir(), '.dsh', 'virtuoso-bridge')
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, 'settings.json')
      if (existsSync(candidate)) files.add(candidate)
    }
  } catch {
    // No local settings: CI runs with VB_PRIVATE_NAMES instead.
  }
  return [...files]
}

function derivePrivateTokens() {
  const tokens = new Map() // lowercase value -> category
  const add = (value, category, minimumLength = 3) => {
    const text = String(value ?? '').trim()
    if (text.length < minimumLength) return
    const lower = text.toLowerCase()
    if (COMMON_PLACEHOLDER_NAMES.has(lower)) return
    if (/^127(?:\.\d{1,3}){3}$/.test(lower) || lower === 'localhost' || lower === '::1') return
    if (lower === '/home/username' || lower === 'c:\\users\\me' || lower === 'c:/users/me') return
    if (!tokens.has(lower)) tokens.set(lower, category)
  }

  const home = os.homedir()
  add(home, 'home-dir', 4)
  add(os.userInfo().username, 'user-name', 3)

  for (const file of pluginSettingsFiles()) {
    let settings
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const connection of settings?.connections ?? []) {
      for (const key of ['name', 'host', 'jumpHost', 'daemonHost', 'deployHost', 'guiHost', 'spectreHost']) {
        add(connection?.[key], 'server-name', 4)
        const value = String(connection?.[key] ?? '').trim()
        // A long DNS name is usually referenced in commits by its first label.
        if (value.includes('.') && !/^\d+(?:\.\d+){3}$/.test(value)) {
          add(value.split('.')[0], 'server-name', 4)
        }
      }
      for (const key of ['user', 'jumpUser']) {
        add(connection?.[key], 'user-name', 3)
      }
      for (const key of ['remoteWorkDir', 'remoteScratchRoot', 'identityFile']) {
        const value = String(connection?.[key] ?? '')
        if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('~/')) {
          add(value, 'home-dir', 4)
        }
      }
    }
    const pythonPath = String(settings?.pythonPath ?? '')
    if (pythonPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pythonPath)) add(pythonPath, 'home-dir', 4)
  }

  for (const value of String(process.env.VB_PRIVATE_NAMES || '').split(',')) {
    add(value, 'private-name', 3)
  }

  // The local, gitignored account list feeds both guards.
  for (const value of readLocalGuardAccounts()) {
    add(value, 'private-name', 3)
  }
  return tokens
}

// ---------------------------------------------------------------------------

function scanLine(line, context, privateTokens, hits) {
  const masked = maskDocumentedPlaceholders(line)
  for (const [token, category] of privateTokens) {
    if (tokenPattern(token).test(masked)) {
      hits.push({ ...context, rule: category })
      return
    }
  }
  for (const rule of GENERIC_RULES) {
    let matched = false
    rule.pattern.lastIndex = 0
    for (const match of masked.matchAll(rule.pattern)) {
      if (!rule.allow(match[0])) {
        matched = true
        break
      }
    }
    if (matched) {
      hits.push({ ...context, rule: rule.id })
      return
    }
  }
}

// ---------------------------------------------------------------------------
// scanners
// ---------------------------------------------------------------------------

function listCommits(range) {
  // Only %B (subject + body). %an/%ae/%cn/%ce are intentionally not read: the
  // repository owner's git user is an accepted exception.
  const output = git(['log', '--format=%x1e%H%x1f%B%x1f', range])
  const commits = []
  for (const record of output.split('\x1e')) {
    if (!record.trim()) continue
    const [sha, body = ''] = record.split('\x1f')
    commits.push({ sha, body })
  }
  return commits
}

function scanCommitMessages(commits, privateTokens, hits) {
  for (const commit of commits) {
    const lines = commit.body.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      scanLine(line, { scope: 'commit-message', commit: commit.sha.slice(0, 12), line: index + 1 }, privateTokens, hits)
    }
  }
}

function scanDiffText(diff, privateTokens, hits, counters) {
  let file = '(unknown file)'
  let newLine = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '')
      counters.files.add(file)
      // A private value in the path is as public as one in the content.
      scanLine(file, { scope: 'file-path', file }, privateTokens, hits)
      continue
    }
    if (line.startsWith('@@')) {
      const match = /\+(\d+)(?:,\d+)?/.exec(line)
      newLine = match ? Number(match[1]) : 0
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      counters.lines += 1
      scanLine(line.slice(1), { scope: 'file', file, line: newLine }, privateTokens, hits)
      newLine += 1
      continue
    }
    if (!line.startsWith('-') && !line.startsWith('\\')) newLine += 1
  }
}

function scanRangeDiff(range, privateTokens, hits, counters) {
  const diff = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', range])
  scanDiffText(diff, privateTokens, hits, counters)
}

function scanCommitDiffs(commits, privateTokens, hits, counters) {
  // A value added in one commit and removed in a later one never appears in
  // the range's final diff, but it is still published in history. Scan every
  // commit's own added lines, not only the net change.
  for (const commit of commits) {
    const diff = git([
      'show',
      '--format=',
      '--no-commit-id',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      commit.sha,
      '--',
    ])
    scanDiffText(diff, privateTokens, hits, counters)
  }
}

function scanWorkingTree(privateTokens, hits, counters) {
  const diff = git(['diff', 'HEAD', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv'])
  scanDiffText(diff, privateTokens, hits, counters)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const file of untracked) {
    if (file === 'node_modules' || file.startsWith('node_modules/')) continue
    scanLine(file, { scope: 'file-path', file }, privateTokens, hits)
    const absolute = join(REPO_ROOT, ...file.split('/'))
    let info
    try {
      info = statSync(absolute)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > 2 * 1024 * 1024) continue
    let buffer
    try {
      buffer = readFileSync(absolute)
    } catch {
      continue
    }
    if (buffer.includes(0)) continue
    counters.files.add(file)
    for (const [index, line] of buffer.toString('utf8').split(/\r?\n/).entries()) {
      counters.lines += 1
      scanLine(line, { scope: 'untracked-file', file, line: index + 1 }, privateTokens, hits)
    }
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { base: '', worktree: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base') {
      options.base = argv[index + 1] ?? ''
      index += 1
    } else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length)
    else if (arg === '--worktree') options.worktree = true
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/check-branch-privacy.mjs [--base <ref-or-sha>] [--worktree]')
      process.exit(0)
    } else {
      console.error(`check-branch-privacy: unknown argument ${arg}`)
      process.exit(2)
    }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const { range } = resolveRange(options.base)
  const privateTokens = derivePrivateTokens()
  const hits = []
  const counters = { files: new Set(), lines: 0 }

  const commits = listCommits(range)
  scanCommitMessages(commits, privateTokens, hits)
  scanCommitDiffs(commits, privateTokens, hits, counters)
  scanRangeDiff(range, privateTokens, hits, counters)
  if (options.worktree) scanWorkingTree(privateTokens, hits, counters)

  if (hits.length > 0) {
    for (const hit of hits.slice(0, 200)) {
      const location = hit.scope === 'commit-message'
        ? `commit ${hit.commit} message line ${hit.line}`
        : `${hit.file}:${hit.line}`
      console.log(`${location}: [${hit.rule}] private value must not be committed`)
    }
    if (hits.length > 200) console.log(`... and ${hits.length - 200} more hit(s)`)
    console.error(
      `check-branch-privacy: FAILED — ${hits.length} hit(s) in ${commits.length} commit message(s), ` +
        `${counters.lines} added line(s) of ${counters.files.size} file(s) in ${range}. ` +
        'Server names, account names and home directories are forbidden in commit messages and committed files; ' +
        'the git author/committer identity alone is exempt. Matched values are redacted on purpose.',
    )
    process.exit(1)
  }

  const tokenNote = privateTokens.size
    ? `${privateTokens.size} local private value(s)`
    : 'no local settings-derived values (CI should supply VB_PRIVATE_NAMES)'
  console.log(
    `check-branch-privacy: clean — ${commits.length} commit message(s), ${counters.lines} added line(s) in ` +
      `${counters.files.size} file(s), ${range}; guarded by ${tokenNote}.`,
  )
  process.exit(0)
}

main()
