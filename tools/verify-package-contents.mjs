/**
 * Work out exactly which files `npm publish` would ship, from the manifest alone.
 *
 * `npm pack --dry-run` needs an npm that the DSH-bundled Node does not carry, and
 * a package that ships a file the Host reads at runtime but omits it from `files`
 * installs subtly worse than the developer's copy. This models npm's rule — the
 * `files` allowlist, always plus the manifest, README and LICENSE — and reports
 * what a consumer receives.
 *
 *   node tools/verify-package-contents.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))

/** Always included by npm, allowlist or not. */
const ALWAYS = ['package.json', 'README.md', 'LICENSE']

/** Recursively list files under `dir`, relative to the package root. */
function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      found.push(...walk(full))
    } else {
      found.push(relative(PACKAGE_DIR, full).split(sep).join('/'))
    }
  }
  return found
}

const all = walk(PACKAGE_DIR)
const allow = manifest.files ?? []
const shipped = all.filter((file) => {
  if (ALWAYS.includes(file)) return true
  return allow.some((pattern) => file === pattern || file.startsWith(`${pattern}/`))
}).sort()

const omitted = all.filter((file) => !shipped.includes(file)).sort()

console.log(`package: ${manifest.name}@${manifest.version}`)
console.log(`repository files: ${all.length}   shipped: ${shipped.length}   omitted: ${omitted.length}\n`)

console.log('SHIPPED')
let total = 0
for (const file of shipped) {
  const size = statSync(join(PACKAGE_DIR, file)).size
  total += size
  console.log(`  ${String(size).padStart(9)}  ${file}`)
}
console.log(`  ${String(total).padStart(9)}  TOTAL (${(total / 1024).toFixed(0)} KiB)`)

console.log('\nOMITTED (repository-only)')
for (const file of omitted) console.log(`  ${file}`)

// Anything the Host reads at runtime has to be in the shipped set, or a consumer
// gets a worse install than the developer's.
const hostSource = readFileSync(join(PACKAGE_DIR, 'index.js'), 'utf8')
const refs = [...hostSource.matchAll(/join\(PACKAGE_DIR,\s*'([^']+)',\s*'([^']+)'\)/g)]
  .map((match) => `${match[1]}/${match[2]}`)

console.log('\nRUNTIME FILE REFERENCES')
let bad = 0
for (const ref of refs) {
  const ok = shipped.includes(ref)
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${ref}`)
}

// Every image the README embeds is listing artwork, so it must ship or the
// storefront shows a broken image. The icon is read by the plugin manager
// straight from the manifest.
console.log('\nLISTING ASSETS')
{
  const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8')
  const embeds = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim())
  for (const asset of [manifest.icon, ...embeds]) {
    const rel = String(asset).replace(/^\.\//, '')
    const ok = shipped.includes(rel)
    if (!ok) bad += 1
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${rel}`)
  }
}

// A placeholder repository URL is worse than a missing one: the marketplace
// pairs an npm package back to its repository through this field, and a wrong
// value either fails to link or links to somebody else's namespace. `--allow-placeholders`
// exists so the check can run before the repository name is known.
console.log('\nREPOSITORY IDENTITY')
{
  const urls = [manifest.repository?.url, manifest.bugs?.url, manifest.homepage]
    .filter((value) => typeof value === 'string')
  const placeholders = urls.filter((url) => /CHANGE-ME|example\.com|<owner>|<repo>|your-name/i.test(url))
  const allow = process.argv.includes('--allow-placeholders')
  if (placeholders.length === 0) {
    console.log(`  ok   repository URLs look real (${urls.length} checked)`)
    console.log(`       ${manifest.repository?.url ?? '(none)'}`)
  } else if (allow) {
    console.log(`  warn ${placeholders.length} placeholder repository URL(s) — allowed by flag, must be replaced before publishing`)
    for (const url of placeholders) console.log(`       ${url}`)
  } else {
    bad += 1
    console.log(`  FAIL ${placeholders.length} placeholder repository URL(s)`)
    for (const url of placeholders) console.log(`       ${url}`)
    console.log('       replace them, or pass --allow-placeholders to skip this check')
  }
}

console.log('')
if (bad === 0) {
  console.log('PASS — every runtime and listing file is published')
  process.exit(0)
}
console.log(`FAILED — ${bad} problem(s)`)
process.exit(1)
