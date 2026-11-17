#!/usr/bin/env node
/**
 * Validate the static bilingual documentation site in site/.
 *
 * The site is hand-written HTML on purpose: there is no build step, no Markdown
 * renderer and no dependency install in the Pages workflow. This script is the
 * safety net a build step would normally provide:
 *
 *  - every relative href/src resolves to a real file below site/;
 *  - every #fragment resolves to a real id on the target page;
 *  - every page has one <h1>, a description, the shared stylesheet and the
 *    shared navigation with exactly one current page link;
 *  - English and Chinese pages pair up through meta[name="language-current"],
 *    meta[name="language-alternate"] and the language switch, reciprocally;
 *  - every class used in HTML is defined in site/assets/site.css;
 *  - every <h2 id> / <h3 id> on a chapter page appears in its table of contents;
 *  - no inline styles, no <style> blocks and no leftover TODOs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const siteDir = join(root, 'site')
const cssFile = join(siteDir, 'assets', 'site.css')
const PAGES = [
  'index.html',
  'getting-started.html',
  'connections.html',
  'agent-tools.html',
  'workflows.html',
  'runtime.html',
  'troubleshooting.html',
]

const failures = []
const fail = (page, message) => failures.push(page + ': ' + message)

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function attributes(html, name) {
  const values = []
  const pattern = new RegExp('\\b' + name + '="([^"]*)"', 'g')
  let match
  while ((match = pattern.exec(html)) !== null) values.push(match[1])
  return values
}

function baseName(page) {
  return page.replace(/\.zh-CN\.html$/, '.html')
}

function variant(page, language) {
  const base = baseName(page)
  return language === 'zh' ? base.replace(/\.html$/, '.zh-CN.html') : base
}

const files = walk(siteDir).map((file) => relative(siteDir, file).split(sep).join('/'))
const htmlPages = files.filter((file) => file.endsWith('.html'))
const expectedPages = PAGES.concat(PAGES.map((page) => variant(page, 'zh')))

if (!htmlPages.includes('index.html')) fail('site', 'missing index.html')
for (const page of expectedPages) {
  if (!htmlPages.includes(page)) fail('site', 'missing page ' + page)
}

const css = readFileSync(cssFile, 'utf8')
const definedClasses = new Set()
for (const match of css.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) definedClasses.add(match[1])
const dynamicClasses = new Set(['is-open', 'is-active', 'copied'])
const sourceText = new Map()

for (const page of htmlPages) {
  const html = readFileSync(join(siteDir, page), 'utf8')
  sourceText.set(page, html)
  const ids = new Set(attributes(html, 'id'))
  const langAttribute = attributes(html, 'lang')[0] || ''
  const language = langAttribute.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const isChinese = language === 'zh'
  const alternate = variant(page, language === 'zh' ? 'en' : 'zh')

  if (isChinese && langAttribute !== 'zh-CN') fail(page, 'expected lang="zh-CN", found "' + langAttribute + '"')
  if (!isChinese && langAttribute !== 'en') fail(page, 'expected lang="en", found "' + langAttribute + '"')

  // Language pairing metadata.
  const currentMeta = /<meta name="language-current" content="([^"]+)"/.exec(html)
  if (!currentMeta) fail(page, 'missing meta[name="language-current"]')
  else if (currentMeta[1] !== language) fail(page, 'language-current is "' + currentMeta[1] + '", expected "' + language + '"')
  const alternateMeta = /<meta name="language-alternate" content="([^"]+)"/.exec(html)
  if (!alternateMeta) fail(page, 'missing meta[name="language-alternate"]')
  else if (alternateMeta[1] !== alternate) {
    fail(page, 'language-alternate is "' + alternateMeta[1] + '", expected "' + alternate + '"')
  }
  if (!htmlPages.includes(alternate)) {
    fail(page, 'alternate page ' + alternate + ' does not exist')
  } else if (alternateMeta && alternateMeta[1] === alternate) {
    const alternateHtml = sourceText.get(alternate) ?? readFileSync(join(siteDir, alternate), 'utf8')
    const back = /<meta name="language-alternate" content="([^"]+)"/.exec(alternateHtml)
    if (!back || back[1] !== page) fail(page, 'alternate page ' + alternate + ' does not point back')
  }
  if (!html.includes('src="assets/language.js"')) fail(page, 'missing the shared language script')

  const h1Count = (html.match(/<h1\b/g) || []).length
  if (h1Count !== 1) fail(page, 'expected exactly one <h1>, found ' + h1Count)
  const descriptionLength = isChinese ? 24 : 40
  const description = /<meta name="description" content="([^"]+)"/.exec(html)
  if (!description) fail(page, 'missing meta description')
  else if (description[1].length < descriptionLength) fail(page, 'meta description is too short')
  if (!/<title>[^<]+<\/title>/.test(html)) fail(page, 'missing <title>')
  if (!html.includes('href="assets/site.css"')) fail(page, 'missing the shared stylesheet')
  if (!html.includes('src="assets/site.js"')) fail(page, 'missing the shared script')
  if (!/<link rel="icon"[^>]*href="assets\/(logo|icon)\.svg"/.test(html)) {
    fail(page, 'missing the favicon')
  }
  if (/<style\b/.test(html)) fail(page, 'inline <style> blocks are not allowed')
  if (/\bstyle="/.test(html)) fail(page, 'inline style attributes are not allowed')
  if (/TODO|FIXME|lorem ipsum|待补充/i.test(html)) fail(page, 'leftover placeholder text')

  // Shared navigation: page links + language switch.
  const navBlock = /<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)
  if (!navBlock) {
    fail(page, 'missing the shared site navigation')
  } else {
    const nav = navBlock[1]
    const switchBlock = /<span class="language-switch"[^>]*>([\s\S]*?)<\/span>/.exec(nav)
    if (!switchBlock) {
      fail(page, 'navigation is missing the language switch')
    } else {
      const choices = [...switchBlock[1].matchAll(/<a\b[^>]*data-language-choice="([a-z]+)"[^>]*>/g)].map((m) => m[1])
      if (choices.sort().join(',') !== 'en,zh') fail(page, 'language switch must offer exactly en and zh')
      const marked = [...switchBlock[1].matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0])
      if (marked.length !== 1) {
        fail(page, 'language switch needs exactly one aria-current="page" link')
      } else if (!new RegExp('data-language-choice="' + language + '"').test(marked[0])) {
        fail(page, 'language switch marks the wrong language as current')
      }
      for (const choice of ['en', 'zh']) {
        const link = new RegExp('<a\\b[^>]*data-language-choice="' + choice + '"[^>]*>').exec(switchBlock[1])
        if (!link) continue
        const href = /href="([^"]+)"/.exec(link[0])
        if (!href) fail(page, 'language switch ' + choice + ' link has no href')
        const expectedHref = variant(page, choice)
        if (href && href[1] !== expectedHref) {
          fail(page, 'language switch ' + choice + ' points at ' + href[1] + ', expected ' + expectedHref)
        }
        if (choice !== language) {
          if (!/hreflang="zh-CN"/.test(link[0]) && choice === 'zh') fail(page, 'Chinese switch link needs hreflang="zh-CN"')
          if (!/hreflang="en"/.test(link[0]) && choice === 'en') fail(page, 'English switch link needs hreflang="en"')
        }
      }
    }
    const pageNav = nav.replace(/<span class="language-switch"[\s\S]*?<\/span>/, '')
    const marked = [...pageNav.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0])
    if (marked.length !== 1) {
      fail(page, 'expected exactly one aria-current="page" page link, found ' + marked.length)
    } else {
      const href = /href="([^"]+)"/.exec(marked[0])
      if (!href || href[1] !== page) fail(page, 'aria-current is not on the link for ' + page)
    }
    for (const target of PAGES) {
      const expected = variant(target, language)
      if (!new RegExp('href="' + expected.replace(/\./g, '\\.') + '"').test(pageNav)) {
        fail(page, 'navigation is missing ' + expected)
      }
    }
  }

  const classTokens = new Set()
  for (const value of attributes(html, 'class')) {
    for (const token of value.split(/\s+/)) if (token) classTokens.add(token)
  }
  for (const token of classTokens) {
    if (!definedClasses.has(token) && !dynamicClasses.has(token)) {
      fail(page, 'class "' + token + '" is not defined in assets/site.css')
    }
  }

  for (const raw of attributes(html, 'href').concat(attributes(html, 'src'))) {
    const target = raw.trim()
    if (!target || target.startsWith('http://') || target.startsWith('https://')) continue
    if (target.startsWith('mailto:') || target.startsWith('data:')) continue
    if (target.startsWith('#')) {
      const id = decodeURIComponent(target.slice(1))
      if (id && !ids.has(id)) fail(page, 'fragment "' + target + '" has no matching id')
      continue
    }
    const parts = target.split('#')
    const normalized = posix.normalize(parts[0])
    if (normalized.startsWith('..')) {
      fail(page, 'link escapes site/: ' + target)
      continue
    }
    if (!files.includes(normalized)) {
      fail(page, 'broken internal link: ' + target)
      continue
    }
    if (parts[1]) {
      const targetText = sourceText.get(normalized) ?? readFileSync(join(siteDir, normalized), 'utf8')
      if (!new Set(attributes(targetText, 'id')).has(decodeURIComponent(parts[1]))) {
        fail(page, 'link ' + target + ' points at a missing id')
      }
    }
  }

  const toc = /<aside class="doc-toc"[\s\S]*?<\/aside>/.exec(html)
  if (toc) {
    const tocIds = [...toc[0].matchAll(/href="#([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))
    for (const tocId of tocIds) {
      if (!ids.has(tocId)) fail(page, 'table of contents points at a missing id "' + tocId + '"')
    }
    for (const match of html.matchAll(/<h([23])\b[^>]*\bid="([^"]+)"/g)) {
      if (!tocIds.includes(match[2])) fail(page, 'h' + match[1] + ' "' + match[2] + '" is missing from the table of contents')
    }
  } else if (page !== 'index.html' && page !== 'index.zh-CN.html') {
    fail(page, 'chapter page has no table of contents')
  }
}

for (const asset of ['assets/site.css', 'assets/site.js', 'assets/language.js', 'assets/icon.svg', '.nojekyll']) {
  if (!files.includes(asset)) fail('site', 'missing ' + asset)
}

if (failures.length) {
  console.error('Site check failed with ' + failures.length + ' problem(s):')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}

console.log('Site check passed: ' + htmlPages.length + ' pages, ' + files.length + ' files.')
