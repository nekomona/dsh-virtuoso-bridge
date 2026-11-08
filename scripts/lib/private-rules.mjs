/**
 * private-rules.mjs — the single definition of "private data" for the guards.
 *
 * check-no-private-data.mjs scans the tracked files of the checked-out tree;
 * check-branch-privacy.mjs scans the commit messages and added lines of a branch
 * range. Both must agree on what counts as private, so the patterns, the
 * documented placeholders and the local account list live here once instead of
 * being copied into each script.
 *
 * Matched values are never echoed by these helpers (callers receive rule ids
 * only): CI logs are public, so a hit must not print the value it matched.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')

/**
 * Documented placeholders are allowed anywhere: a public plugin legitimately
 * shows `host.example`, `/home/username`, `C:\Users\me` and loopback addresses.
 */
const PLACEHOLDER_HOSTS = /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.(?:example(?:\.[A-Za-z]{2,})?|test|invalid)\b/gi
const PLACEHOLDER_UNIX_HOME = /\/home\/username\b/g
const PLACEHOLDER_WINDOWS_HOME = /C:[\\/]+Users[\\/]+me\b/gi
const PLACEHOLDER_LOOPBACK = /\b127(?:\.\d{1,3}){3}\b/g

export function maskDocumentedPlaceholders(line) {
  return line
    .replace(PLACEHOLDER_HOSTS, 'host.example')
    .replace(PLACEHOLDER_UNIX_HOME, '/home/username')
    .replace(PLACEHOLDER_WINDOWS_HOME, 'C:\\Users\\me')
    .replace(PLACEHOLDER_LOOPBACK, '127.0.0.1')
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-token match; `.` may appear inside a host or an address. */
export function tokenPattern(token) {
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(token)}(?![A-Za-z0-9._-])`, 'i')
}

/**
 * Generic private shapes. `allow` receives the matched text (and the match), so
 * a rule can keep the documented placeholder forms.
 */
export const GENERIC_RULES = [
  {
    id: 'private-ipv4',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    allow: (value) => {
      const octets = value.match(/\d+/g)?.map(Number) ?? []
      if (octets.length !== 4 || octets.some((octet) => octet > 255)) return true
      if (octets[0] === 127) return true
      if (octets.every((octet) => octet === 0 || octet === 255)) return true
      return false
    },
  },
  {
    id: 'unix-home-path',
    pattern: /\/(?:home|Users|mnt)\/[A-Za-z0-9._-]+/g,
    allow: (value) => value.toLowerCase() === '/home/username',
  },
  {
    id: 'windows-profile-path',
    pattern: /C:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/gi,
    allow: (value) => /^C:[\\/]+Users[\\/]+me$/i.test(value),
  },
  {
    id: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: (value) => /@(?:example\.(?:com|org|net))$/i.test(value) || /^git@github\.com$/i.test(value),
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
    // A quoted value assigned to password, passphrase, api_key or token.
    pattern: /\b(?:password|passphrase|api[_-]?key|token)\b\s*[:=]\s*(["'])([^"'\n]{1,})\1/gi,
    allow: () => false,
  },
]

/**
 * A developer's real account names must never appear in a public script. They
 * are read from the optional, gitignored `.local-guard.json` in this checkout
 * (`{ "accountNames": ["..."] }`). CI has no such file, so the rule is inert
 * there and the generic rules do all public-side checking.
 */
export function readLocalGuardAccounts() {
  try {
    const local = JSON.parse(readFileSync(join(REPO_ROOT, '.local-guard.json'), 'utf8'))
    if (!Array.isArray(local.accountNames)) return []
    return local.accountNames
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .map((name) => name.trim())
  } catch {
    return []
  }
}

/** Build the local-account rule, or nothing when no local names are configured. */
export function accountRule(names) {
  if (!names || names.length === 0) return undefined
  return {
    id: 'account-name',
    pattern: new RegExp(`\\b(?:${names.map(escapeRegExp).join('|')})\\b`, 'gi'),
    allow: () => false,
  }
}

/**
 * Rule ids matched in one line of text. `extraRules` adds scanner-specific rules
 * (for example the timestamp rule of the tracked-file guard); their `allow`
 * callback receives the file path as a third argument.
 */
export function matchRules(text, { file, extraRules = [] } = {}) {
  const masked = maskDocumentedPlaceholders(text)
  const ids = []
  for (const rule of [...GENERIC_RULES, ...extraRules]) {
    rule.pattern.lastIndex = 0
    for (const match of masked.matchAll(rule.pattern)) {
      if (!rule.allow(match[0], match, file)) {
        ids.push(rule.id)
        break
      }
    }
  }
  return ids
}
