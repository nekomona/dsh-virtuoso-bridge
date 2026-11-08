#!/usr/bin/env node
/**
 * prepare-vendor.mjs — verify the pinned `vendor/` submodule before packaging.
 *
 * `npm pack` and `npm publish` run this as the `prepack` script. It guarantees
 * that the tarball contains the upstream source the plugin installs in bundled
 * mode, and that the checkout really is the commit recorded in
 * `vendor.pin.json`.
 *
 * Usage:
 *   node scripts/prepare-vendor.mjs                 # materialize the submodule if needed, then verify
 *   node scripts/prepare-vendor.mjs --verify-only   # never mutate anything; verify an existing checkout
 *   node scripts/prepare-vendor.mjs --quiet         # only print warnings and errors
 *
 * Exit codes:
 *   0  everything verified
 *   1  verification failure (wrong commit, missing packaged files, ...)
 *   2  usage or I/O error (bad arguments, unreadable/invalid vendor.pin.json, git missing)
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
const PIN_FILE = join(REPO_ROOT, 'vendor.pin.json')

/** Paths that must exist for the npm tarball to be usable in bundled mode. */
const PACKAGED_FILES = [
  'vendor/pyproject.toml',
  'vendor/README.md',
  'vendor/AGENTS.md',
  'vendor/LICENSE',
  'vendor/mcp_server.py',
  'vendor.pin.json',
]

/** Trees that must exist and be non-empty. */
const PACKAGED_TREES = ['vendor/src', 'vendor/skills']

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
      'Restore vendor.pin.json at the repository root, then re-run:',
      '  node scripts/prepare-vendor.mjs',
    ])
  }

  let pin
  try {
    pin = JSON.parse(raw)
  } catch (error) {
    fail(EXIT_USAGE, [
      `vendor.pin.json is not valid JSON: ${error.message}`,
      'Fix or restore vendor.pin.json, then re-run.',
    ])
  }

  const problems = []
  if (typeof pin.name !== 'string' || pin.name === '') problems.push('name')
  if (typeof pin.version !== 'string' || pin.version === '') problems.push('version')
  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(pin.commit)) problems.push('commit (40 hex characters)')
  if (typeof pin.commitDate !== 'string' || pin.commitDate === '') problems.push('commitDate')
  if (typeof pin.repository !== 'string' || pin.repository === '') problems.push('repository')
  if (pin.submodulePath !== 'vendor') problems.push("submodulePath (must be 'vendor')")
  if (problems.length > 0) {
    fail(EXIT_VERIFY, [
      `vendor.pin.json is invalid; missing or malformed: ${problems.join(', ')}.`,
      'Fix vendor.pin.json, then re-run.',
    ])
  }
  return pin
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
      'Check out the vendor submodule, then re-run:',
      '  git submodule update --init vendor',
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
      'vendor/ is not checked out (vendor/pyproject.toml is missing).',
      '--verify-only never modifies the checkout, so check the submodule out first:',
      '  git submodule update --init vendor',
      'then re-run: node scripts/prepare-vendor.mjs --verify-only',
    ])
  }

  if (!options.quiet) {
    console.log('prepare-vendor: vendor/ is not checked out; running: git submodule update --init vendor')
  }
  try {
    git(['submodule', 'update', '--init', '--', 'vendor'], REPO_ROOT, { inherit: true })
  } catch (error) {
    fail(EXIT_VERIFY, [
      '`git submodule update --init vendor` failed.',
      error.code === 'ENOENT'
        ? 'git is not installed or not on PATH; install git and re-run.'
        : 'Check .gitmodules and your access to the pinned upstream repository, then re-run.',
      '  git submodule update --init vendor',
    ])
  }

  if (!existsSync(join(REPO_ROOT, 'vendor', 'pyproject.toml'))) {
    fail(EXIT_VERIFY, [
      'vendor/ is still empty after `git submodule update --init vendor`.',
      'Check .gitmodules and your access to the pinned upstream repository, then re-run.',
    ])
  }
}

function verifySubmoduleHead(pin) {
  const vendorDir = join(REPO_ROOT, 'vendor')
  const gitMarker = join(vendorDir, '.git')

  if (!existsSync(gitMarker)) {
    // npm installs the package without its submodule metadata: the tarball
    // already carries the pinned files, so there is no git checkout to compare.
    return { mode: 'packaged', head: pin.commit }
  }

  let head
  try {
    head = git(['-C', vendorDir, 'rev-parse', 'HEAD'], REPO_ROOT).trim()
  } catch (error) {
    fail(EXIT_VERIFY, [
      `vendor/.git exists but vendor/ is not a usable git checkout (git rev-parse HEAD failed${error.code === 'ENOENT' ? ': git is not installed or not on PATH' : ''}).`,
      'Recover the submodule checkout, then re-run:',
      '  git submodule update --init vendor',
      'Or check out the pinned commit directly:',
      `  git -C vendor fetch origin ${pin.commit} && git -C vendor checkout ${pin.commit}`,
    ])
  }

  if (head.toLowerCase() !== pin.commit.toLowerCase()) {
    fail(EXIT_VERIFY, [
      `vendor/ is checked out at ${head}, but vendor.pin.json pins ${pin.commit}.`,
      'Restore the pinned commit, then re-run:',
      `  git -C vendor fetch origin ${pin.commit} && git -C vendor checkout ${pin.commit}`,
    ])
  }

  return { mode: 'submodule', head }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const pin = readPin()

  if (!existsSync(join(REPO_ROOT, 'vendor', 'pyproject.toml'))) runSubmoduleUpdate(options)
  const checkout = verifySubmoduleHead(pin)
  const fileCount = verifyPackagedPaths()

  if (!options.quiet) {
    const pinLabel = `${pin.name} ${pin.version}`
    if (checkout.mode === 'submodule') {
      console.log(`prepare-vendor: OK — ${pinLabel} at ${checkout.head} (vendor/ submodule)`)
    } else {
      console.log(`prepare-vendor: OK — ${pinLabel} at ${pin.commit}`)
      console.log('prepare-vendor: vendor/ has no submodule .git; treating this as a packaged install and verifying the packaged files only.')
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
