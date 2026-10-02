/**
 * Check that the READMEs only advertise installation routes that actually work.
 *
 * This exists because the documentation once recommended
 * `dsh plugin --profile web add <bare name>` as "from npm (recommended)" while the
 * package had never been published: the registry answers 404, so the first step a
 * new user follows fails. Documentation that promises an install path is a claim
 * about the world, so it is checked against the world.
 *
 * The check is deliberately shape-based rather than semantic:
 *   - the bare package name is an npm install; it is only valid if the registry
 *     serves the package,
 *   - a `github:` spec is a git install; it is valid as long as the repository is
 *     reachable,
 *   - any bare-name install line must be visibly marked as not-yet-available when
 *     the registry has no package.
 *
 *   node tools/verify-install-docs.mjs [--offline]
 *
 * `--offline` skips the network entirely and only checks that a bare-name install
 * is marked as unavailable, which is the safe assumption when the registry cannot
 * be reached.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const offline = process.argv.includes('--offline')

const results = []
/**
 * Record one assertion.
 * @param ok - whether it held.
 * @param label - the assertion as it reads when passing.
 * @param detail - context printed either way.
 */
function check(ok, label, detail) {
  results.push({ ok, label, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  [${detail}]`}`)
}

/** @returns the repository `owner/repo` from the manifest, or `undefined`. */
function repositorySlug() {
  const url = manifest.repository?.url ?? ''
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/.exec(url)
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

const slug = repositorySlug()
console.log(`package  : ${manifest.name}@${manifest.version}`)
console.log(`repository: ${slug ?? '(unparseable)'}\n`)

console.log('registry availability')
let published = false
if (offline) {
  console.log('  skip  --offline: assuming the package is NOT published')
} else {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`, { method: 'GET' })
    published = response.status === 200
    check(
      response.status === 200 || response.status === 404,
      'the registry answered (200 published, 404 not)',
      String(response.status),
    )
    console.log(`  info  registry says: ${published ? 'PUBLISHED' : 'NOT PUBLISHED'}`)
  } catch (error) {
    console.log(`  warn  registry unreachable (${error.message}); assuming NOT PUBLISHED`)
  }
}

console.log('\ninstallation claims in the READMEs')
/** Phrases that mark a command as explicitly not-yet-usable. */
const UNAVAILABLE_MARKERS = /尚未|不要用|会失败|不存在|未发布|not published|do not use|fails|no such package|becomes valid/i

for (const file of ['README.md', 'README.zh.md']) {
  const lines = readFileSync(join(PACKAGE_DIR, file), 'utf8').split(/\r?\n/)

  // A bare-name install: `... add <name>` with no spec prefix and nothing glued on.
  const escaped = manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bare = lines
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => new RegExp(`add\\s+${escaped}(?![\\w@./#-])`).test(entry.line))

  if (published) {
    // Published: the documentation should tell people they can use npm.
    check(bare.length > 0, `${file}: advertises the npm install now that the package is published`, `${bare.length}`)
  } else {
    // Not published: the command fails, so if it appears at all it must be marked.
    for (const entry of bare) {
      const neighbourhood = lines.slice(Math.max(0, entry.index - 4), entry.index + 4).join('\n')
      check(
        UNAVAILABLE_MARKERS.test(neighbourhood),
        `${file}:${entry.index}: the npm install command is marked as not yet available`,
        entry.line.trim(),
      )
    }
  }

  // A git install must name the real repository.
  const gitInstalls = lines
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => entry.line.includes('github:'))
  check(gitInstalls.length > 0, `${file}: advertises a GitHub install route`, `${gitInstalls.length} occurrence(s)`)
  for (const entry of gitInstalls) {
    const spec = /github:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/.exec(entry.line)
    if (spec === null) continue
    check(
      slug !== undefined && spec[1].toLowerCase() === slug.toLowerCase(),
      `${file}:${entry.index}: the GitHub spec names the real repository`,
      `${spec[1]} vs ${slug ?? '(none)'}`,
    )
  }
}

console.log('')
const failed = results.filter((result) => !result.ok)
if (failed.length === 0) {
  console.log(`PASS — ${results.length}/${results.length} assertions`)
  process.exit(0)
}
console.log(`FAILED — ${failed.length} of ${results.length}:`)
for (const failure of failed) console.log(`  - ${failure.label}${failure.detail === undefined ? '' : `  [${failure.detail}]`}`)
process.exit(1)
