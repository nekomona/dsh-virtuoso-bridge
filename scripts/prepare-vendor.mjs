#!/usr/bin/env node
/**
 * prepare-vendor.mjs — verify the pinned `virtuoso-bridge-lite/` submodule before packaging.
 *
 * `npm pack` and `npm publish` run this as the `prepack` script. It guarantees
 * that the tarball contains the upstream source the plugin installs in bundled
 * mode, and that the checkout really is the commit recorded in
 * `virtuoso-bridge-lite.pin.json`.
 *
 * Usage:
 *   node scripts/prepare-vendor.mjs                 # materialize the submodule if needed, then verify
 *   node scripts/prepare-vendor.mjs --verify-only   # never mutate anything; verify an existing checkout
 *   node scripts/prepare-vendor.mjs --quiet         # only print warnings and errors
 *
 * Exit codes:
 *   0  everything verified
 *   1  verification failure (wrong commit, missing packaged files, ...)
 *   2  usage or I/O error (bad arguments, unreadable/invalid virtuoso-bridge-lite.pin.json, git missing)
 *
 * Node.js >= 20, no dependencies. Works on Windows and Linux.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT_OK = 0
const EXIT_VERIFY = 1
const EXIT_USAGE = 2

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const PIN_FILE = join(REPO_ROOT, 'virtuoso-bridge-lite.pin.json')

/** Paths that must exist for the npm tarball to be usable in bundled mode. */
const PACKAGED_FILES = [
  'virtuoso-bridge-lite/pyproject.toml',
  'virtuoso-bridge-lite/README.md',
  'virtuoso-bridge-lite/AGENTS.md',
  'virtuoso-bridge-lite/LICENSE',
  'virtuoso-bridge-lite/mcp_server.py',
  'virtuoso-bridge-lite.pin.json',
]

/** Trees that must exist and be non-empty. */
const PACKAGED_TREES = ['virtuoso-bridge-lite/src', 'virtuoso-bridge-lite/skills']

const USAGE = `usage: node scripts/prepare-vendor.mjs [--verify-only] [--quiet]

  --verify-only   verify an existing checkout; never run git submodule update
  --quiet         suppress the success summary
`

/** Print one or more lines to stderr and exit with the given code. */
function fail(code, lines) {
  for (const line of lines) console.error(`prepare-vendor: ${line}`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { verifyOnly: false, quiet: false }
  for (const arg of argv) {
    if (arg === '--verify-only') options.verifyOnly = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      process.exit(EXIT_OK)
    } else {
      fail(EXIT_USAGE, [`unknown argument: ${arg}`, USAGE.trimEnd()])
    }
  }
  return options
}

function readPin() {
  let raw
  try {
    raw = readFileSync(PIN_FILE, 'utf8')
  } catch (error) {
    fail(EXIT_USAGE, [
      `cannot read ${relative(REPO_ROOT, PIN_FILE)} (${error.code || error.message}).`,
      'Restore virtuoso-bridge-lite.pin.json at the repository root, then re-run:',
      '  node scripts/prepare-vendor.mjs',
    ])
  }

  let pin
  try {
    pin = JSON.parse(raw)
  } catch (error) {
    fail(EXIT_USAGE, [
      `virtuoso-bridge-lite.pin.json is not valid JSON: ${error.message}`,
      'Fix or restore virtuoso-bridge-lite.pin.json, then re-run.',
    ])
  }

  const problems = []
  if (typeof pin.name !== 'string' || pin.name === '') problems.push('name')
  if (typeof pin.version !== 'string' || pin.version === '') problems.push('version')
  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(pin.commit)) problems.push('commit (40 hex characters)')
  if (typeof pin.commitDate !== 'string' || pin.commitDate === '') problems.push('commitDate')
  if (typeof pin.repository !== 'string' || pin.repository === '') problems.push('repository')
  if (pin.submodulePath !== 'virtuoso-bridge-lite') problems.push("submodulePath (must be 'virtuoso-bridge-lite')")
  if (problems.length > 0) {
    fail(EXIT_VERIFY, [
      `virtuoso-bridge-lite.pin.json is invalid; missing or malformed: ${problems.join(', ')}.`,
      'Fix virtuoso-bridge-lite.pin.json, then re-run.',
    ])
  }
  return pin
}

/**
 * The bundled source is pinned to an exact commit. A `branch` entry in
 * .gitmodules is the one thing that lets `git submodule update --remote` follow
 * a moving upstream branch, so a release must never carry one.
 */
function verifyNoBranchTracking() {
  let text
  try {
    text = readFileSync(join(REPO_ROOT, '.gitmodules'), 'utf8')
  } catch (error) {
    fail(EXIT_VERIFY, [
      'cannot read .gitmodules, so the submodule pin cannot be checked.',
      'Restore .gitmodules from the repository, then re-run.',
    ])
  }
  const section = /\[submodule\s+"virtuoso-bridge-lite"\]([\s\S]*?)(?=\n\[|$)/.exec(text)
  if (!section) {
    fail(EXIT_VERIFY, [
      '.gitmodules has no [submodule "virtuoso-bridge-lite"] section.',
      'Restore .gitmodules, then re-run:',
      '  git submodule update --init virtuoso-bridge-lite',
    ])
  }
  const body = section[1]
  const pathLine = /^\s*path\s*=\s*(.+)$/m.exec(body)
  if (!pathLine || pathLine[1].trim() !== 'virtuoso-bridge-lite') {
    fail(EXIT_VERIFY, [
      '.gitmodules must set path = virtuoso-bridge-lite for this submodule.',
      `found: ${pathLine ? pathLine[1].trim() : '(no path entry)'}`,
    ])
  }
  if (/^\s*branch\s*=/m.test(body)) {
    fail(EXIT_VERIFY, [
      '.gitmodules configures a branch for virtuoso-bridge-lite, which is what',
      'lets `git submodule update --remote` follow a moving upstream branch.',
      'The bundled source must stay pinned to the exact commit recorded in',
      'virtuoso-bridge-lite.pin.json. Remove the branch entry, then re-run:',
      '  git submodule update --init virtuoso-bridge-lite',
    ])
  }
}

function countFiles(dir) {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) count += countFiles(absolute)
    else if (entry.isFile()) count += 1
  }
  return count
}

function verifyPackagedPaths() {
  const missing = []
  let fileCount = 0

  for (const relPath of PACKAGED_FILES) {
    const absolute = join(REPO_ROOT, ...relPath.split('/'))
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      missing.push(relPath)
      continue
    }
    fileCount += 1
  }

  for (const relPath of PACKAGED_TREES) {
    const absolute = join(REPO_ROOT, ...relPath.split('/'))
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      missing.push(`${relPath}/`)
      continue
    }
    const count = countFiles(absolute)
    if (count === 0) missing.push(`${relPath}/ (directory is empty)`)
    else fileCount += count
  }

  if (missing.length > 0) {
    fail(EXIT_VERIFY, [
      'the npm tarball would be incomplete; missing packaged paths:',
      ...missing.map((entry) => `  ${entry}`),
      'Check out the pinned submodule, then re-run:',
      '  git submodule update --init virtuoso-bridge-lite',
    ])
  }
  return fileCount
}

function git(args, cwd, { inherit = false } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
}

function runSubmoduleUpdate(options) {
  if (options.verifyOnly) {
    fail(EXIT_VERIFY, [
      'virtuoso-bridge-lite/ is not checked out (virtuoso-bridge-lite/pyproject.toml is missing).',
      '--verify-only never modifies the checkout, so check the submodule out first:',
      '  git submodule update --init virtuoso-bridge-lite',
      'then re-run: node scripts/prepare-vendor.mjs --verify-only',
    ])
  }

  if (!options.quiet) {
    console.log('prepare-vendor: virtuoso-bridge-lite/ is not checked out; running: git submodule update --init virtuoso-bridge-lite')
  }
  try {
    git(['submodule', 'update', '--init', '--', 'virtuoso-bridge-lite'], REPO_ROOT, { inherit: true })
  } catch (error) {
    fail(EXIT_VERIFY, [
      '`git submodule update --init virtuoso-bridge-lite` failed.',
      error.code === 'ENOENT'
        ? 'git is not installed or not on PATH; install git and re-run.'
        : 'Check .gitmodules and your access to the pinned upstream repository, then re-run.',
      '  git submodule update --init virtuoso-bridge-lite',
    ])
  }

  if (!existsSync(join(REPO_ROOT, 'virtuoso-bridge-lite', 'pyproject.toml'))) {
    fail(EXIT_VERIFY, [
      'virtuoso-bridge-lite/ is still empty after `git submodule update --init virtuoso-bridge-lite`.',
      'Check .gitmodules and your access to the pinned upstream repository, then re-run.',
    ])
  }
}

function verifySubmoduleHead(pin) {
  const sourceDir = join(REPO_ROOT, 'virtuoso-bridge-lite')
  const gitMarker = join(sourceDir, '.git')

  if (!existsSync(gitMarker)) {
    // npm installs the package without its submodule metadata: the tarball
    // already carries the pinned files, so there is no git checkout to compare.
    return { mode: 'packaged', head: pin.commit }
  }

  let head
  try {
    head = git(['-C', sourceDir, 'rev-parse', 'HEAD'], REPO_ROOT).trim()
  } catch (error) {
    fail(EXIT_VERIFY, [
      `virtuoso-bridge-lite/.git exists but virtuoso-bridge-lite/ is not a usable git checkout (git rev-parse HEAD failed${error.code === 'ENOENT' ? ': git is not installed or not on PATH' : ''}).`,
      'Recover the submodule checkout, then re-run:',
      '  git submodule update --init virtuoso-bridge-lite',
      'Or check out the pinned commit directly:',
      `  git -C virtuoso-bridge-lite fetch origin ${pin.commit} && git -C virtuoso-bridge-lite checkout ${pin.commit}`,
    ])
  }

  if (head.toLowerCase() !== pin.commit.toLowerCase()) {
    fail(EXIT_VERIFY, [
      `virtuoso-bridge-lite/ is checked out at ${head}, but virtuoso-bridge-lite.pin.json pins ${pin.commit}.`,
      'Restore the pinned commit, then re-run:',
      `  git -C virtuoso-bridge-lite fetch origin ${pin.commit} && git -C virtuoso-bridge-lite checkout ${pin.commit}`,
    ])
  }

  return { mode: 'submodule', head }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const pin = readPin()
  verifyNoBranchTracking()

  if (!existsSync(join(REPO_ROOT, 'virtuoso-bridge-lite', 'pyproject.toml'))) runSubmoduleUpdate(options)
  const checkout = verifySubmoduleHead(pin)
  const fileCount = verifyPackagedPaths()

  if (!options.quiet) {
    const pinLabel = `${pin.name} ${pin.version}`
    if (checkout.mode === 'submodule') {
      console.log(`prepare-vendor: OK — ${pinLabel} at ${checkout.head} (virtuoso-bridge-lite/ submodule)`)
    } else {
      console.log(`prepare-vendor: OK — ${pinLabel} at ${pin.commit}`)
      console.log('prepare-vendor: virtuoso-bridge-lite/ has no submodule .git; treating this as a packaged install and verifying the packaged files only.')
    }
    console.log(`prepare-vendor: commit date ${pin.commitDate}; ${fileCount} packaged files verified.`)
  }

  process.exit(EXIT_OK)
}

try {
  main()
} catch (error) {
  // Any unexpected failure (permissions, races, unsupported filesystem) is an I/O problem.
  fail(EXIT_USAGE, [`unexpected error: ${error.stack || error.message}`])
}
