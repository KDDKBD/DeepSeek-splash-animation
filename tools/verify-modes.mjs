/**
 * Offline check of the Host half's playback modes.
 *
 * Drives the real `apply()` through a stub context and the real route handlers, so the
 * listing, the mode resolution, the rotation cursor and the media service are exercised
 * as the browser half reaches them — no DSH process, no browser, no restart.
 *
 *   node tools/verify-modes.mjs
 *
 * Exit code 0 means every check passed. The only files it touches are the ones it creates
 * under a fresh temporary DSH home, which it removes on the way out.
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createHome, mountFixtureHost } from './harness.mjs'

/** Isolated DSH home, so the run cannot touch the real one. */
const home = createHome()
// The Host half is mounted from a fixture copy of the package: the checks below decide what
// that directory holds, so they read the same on any checkout — including a published repo
// whose `assets` carries only the bundled default video.
const { request, indexRows, packageDir, assetsDir } = await mountFixtureHost(home)
/** The rotation cursor and the media routes read the fixture package's own module state. */
const { listAssets } = await import(pathToFileURL(join(packageDir, 'index.js')).href)

const results = []
/**
 * Record one check.
 * @param name - what is being asserted.
 * @param ok - whether it held.
 * @param detail - what was seen, printed on failure.
 */
function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

const CONFIG = '/dsh-splash-animation/config.json'
const BOOT = `${CONFIG}?advance=1`
const ASSETS = '/dsh-splash-animation/assets'
const SAVE = '/dsh-splash-animation/config'
const MEDIA = '/dsh-splash-animation/asset'

const save = (request, body) => request('POST', SAVE, JSON.stringify(body))

// --- the listing -------------------------------------------------------------------

const listing = await request('GET', ASSETS)
const listed = listing.json()
const names = listed.items.map((item) => item.name)
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const sorted = (list) => [...list].sort((left, right) => NAME_ORDER.compare(left, right))
check('assets route answers 200 JSON', listing.statusCode === 200, listing.statusCode)
check('listing holds the fixture videos', JSON.stringify(names) === JSON.stringify(sorted(['1.mp4', '2.mp4', '3.mp4', 'default.mp4'])), names)
check('listing is name-ordered', JSON.stringify(names) === JSON.stringify(sorted(names)), names)
check('listing reports the directory', listed.dir === assetsDir, listed.dir)
check('listing carries sizes', listed.items.every((item) => typeof item.bytes === 'number' && item.bytes > 0), listed.items.map((item) => item.bytes))
check('listing carries asset references', listed.items.every((item) => item.reference === `asset:${item.name}`), listed.items.map((item) => item.reference))
check('listing starts in the default mode', listed.mode === 'fixed', listed.mode)
check('assets route rejects POST', (await request('POST', ASSETS)).statusCode === 405, 'expected 405')
check('listAssets matches the route', listAssets().length === names.length, listAssets().length)

// --- fixed mode (the pre-existing behaviour) ---------------------------------------

const fresh = await request('GET', CONFIG)
const freshBody = fresh.json()
check('fresh install plays the bundled video', freshBody.media.name === 'default.mp4' && freshBody.source === 'bundled', freshBody.media)
check('fresh install reports mode fixed', freshBody.settings.mode === 'fixed', freshBody.settings.mode)
check('fresh install prefills the bundled path', freshBody.effectiveSrc === join(assetsDir, 'default.mp4'), freshBody.effectiveSrc)
check('wire version is 5', freshBody.version === 5, freshBody.version)
check('index cover is injected while media plays', indexRows().some((row) => row.kind === 'style' && String(row.text).includes('dsh-splash-animation-cover')), indexRows().map((row) => row.kind))

const second = names[1]
const third = names[2]
const fixedSave = (await save(request, { src: `asset:${second}` })).json()
check('fixed mode honours the chosen asset', fixedSave.media.name === second && fixedSave.source === 'chosen', fixedSave.media)
check('a mode-less save keeps the mode', fixedSave.settings.mode === 'fixed', fixedSave.settings.mode)

const served = await request('GET', `${MEDIA}/${encodeURIComponent(second)}`)
check('media route serves the chosen file', served.statusCode === 200 && served.body().length === statSync(join(assetsDir, second)).size, served.statusCode)
check('media route reports the video type', String(served.headerTable['Content-Type']).startsWith('video/mp4'), served.headerTable['Content-Type'])
check('media route refuses another file', (await request('GET', `${MEDIA}/${encodeURIComponent(third)}`)).statusCode === 404, 'expected 404')

const ranged = await request('GET', `${MEDIA}/${encodeURIComponent(second)}`, undefined, { range: 'bytes=0-99' })
check('range request answers 206', ranged.statusCode === 206 && ranged.body().length === 100, ranged.statusCode)
check('range request reports the span', ranged.headerTable['Content-Range'] === `bytes 0-99/${statSync(join(assetsDir, second)).size}`, ranged.headerTable['Content-Range'])

// --- cycle mode --------------------------------------------------------------------

const cycleSave = (await save(request, { mode: 'cycle' })).json()
check('cycle save reports the mode', cycleSave.settings.mode === 'cycle', cycleSave.settings.mode)
check('cycle save keeps the configured path', typeof cycleSave.settings.src === 'string', cycleSave.settings.src)
check('cycle save previews the first file', cycleSave.media.name === names[0] && cycleSave.source === 'cycle', cycleSave.media)

const walked = []
for (let step = 0; step < names.length + 1; step += 1) walked.push((await request('GET', BOOT)).json().media.name)
check('cycle walks the listing in order and wraps', JSON.stringify(walked) === JSON.stringify([...names, names[0]]), walked)

const peeked = (await request('GET', CONFIG)).json()
check('a plain read does not advance', peeked.media.name === names[0], peeked.media.name)
check('a plain read reports the same file twice', (await request('GET', CONFIG)).json().media.name === names[0], 'expected stability')

const servedInCycle = await request('GET', `${MEDIA}/${encodeURIComponent(names[0])}`)
check('media route follows the cycle pick', servedInCycle.statusCode === 200, servedInCycle.statusCode)
const notPlaying = names.find((name) => name !== names[0])
check('media route refuses the file that is not playing', (await request('GET', `${MEDIA}/${encodeURIComponent(notPlaying)}`)).statusCode === 404, 'expected 404')

check('cycle play is covered by the boot style', indexRows().some((row) => row.kind === 'script' && String(row.text).includes('dsh-splash-animation-guard')), indexRows().map((row) => row.kind))

// --- random mode -------------------------------------------------------------------

const randomSave = (await save(request, { mode: 'random' })).json()
check('random save reports the mode', randomSave.settings.mode === 'random', randomSave.settings.mode)
check('random save previews a listed file', names.includes(randomSave.media.name), randomSave.media.name)

const picks = []
for (let step = 0; step < 6; step += 1) picks.push((await request('GET', BOOT)).json().media.name)
check('random picks only listed files', picks.every((name) => names.includes(name)), picks)
check('random does not repeat the previous pick', picks.every((name, index) => index === 0 || name !== picks[index - 1]), picks)

// --- clearing outranks every mode --------------------------------------------------

const cleared = (await save(request, { src: '' })).json()
check('clearing stops playback', cleared.media.kind === 'none' && cleared.source === 'cleared', cleared)
check('clearing survives an advance', (await request('GET', BOOT)).json().media.kind === 'none', 'expected no media')
check('clearing keeps the chosen mode', (await request('GET', CONFIG)).json().settings.mode === 'random', 'expected random')
check('clearing removes the boot cover', !indexRows().some((row) => row.kind === 'style'), indexRows().map((row) => row.kind))

const clearedFixed = (await save(request, { mode: 'fixed' })).json()
check('clearing outranks fixed too', clearedFixed.media.kind === 'none', clearedFixed)

// --- custom paths keep working -----------------------------------------------------

const custom = (await save(request, { src: join(assetsDir, names[2]), mode: 'fixed' })).json()
check('a custom path still plays', custom.media.name === names[2] && custom.source === 'chosen', custom.media)
check('a custom path is served', (await request('GET', `${MEDIA}/${encodeURIComponent(names[2])}`)).statusCode === 200, 'expected 200')
check('a missing custom path reports the problem', (await save(request, { src: join(home, 'nope.mp4') })).json().problem === 'missing-file', 'expected missing-file')

// --- off mode: silenced without losing the setup ------------------------------------

const offSave = (await save(request, { mode: 'off', src: `asset:${names[1]}` })).json()
check('off save reports the mode', offSave.settings.mode === 'off', offSave.settings.mode)
check('off plays nothing even with a chosen file', offSave.media.kind === 'none' && offSave.source === 'off', offSave.media)
check('off keeps the configured path', offSave.settings.src === `asset:${names[1]}`, offSave.settings.src)
check('off survives an advance', (await request('GET', BOOT)).json().media.kind === 'none', 'expected no media')
check('off removes the boot cover', !indexRows().some((row) => row.kind === 'style'), indexRows().map((row) => row.kind))
check('off is reported by the listing', (await request('GET', ASSETS)).json().mode === 'off', 'expected off')

// The whole point of the mode: one click back restores exactly what was configured.
const backOn = (await save(request, { mode: 'fixed' })).json()
check('switching back on plays the kept file', backOn.media.name === names[1] && backOn.source === 'chosen', backOn.media)

// A listing full of videos must not defeat it either — the mode outranks the directory.
const offWithListing = (await save(request, { mode: 'off' })).json()
check('off outranks a non-empty listing', offWithListing.media.kind === 'none' && offWithListing.source === 'off', offWithListing.media)

const offCycle = (await save(request, { mode: 'cycle' })).json()
check('off is left by any other mode', offCycle.media.name === names[0] && offCycle.source === 'cycle', offCycle.media)

// Back to the fixed mode the sections below read a `src` problem under, still holding the
// path that `off` preserved.
const restored = (await save(request, { mode: 'fixed' })).json()
check('leaving off restores the configured file', restored.media.name === names[1] && restored.source === 'chosen', restored.media)

// --- rejected input ----------------------------------------------------------------

check('an unknown mode is refused', (await save(request, { mode: 'shuffle' })).statusCode === 400, 'expected 400')
check('an empty body is refused', (await save(request, {})).statusCode === 400, 'expected 400')
check('a bad body is refused', (await request('POST', SAVE, 'not json')).statusCode === 400, 'expected 400')
check('GET on the save route is refused', (await request('GET', SAVE)).statusCode === 405, 'expected 405')

const traversal = (await save(request, { src: 'asset:../../../index.js' })).json()
check('an asset reference cannot escape the directory', traversal.problem === 'missing-file', traversal)
check('an escaped reference serves nothing', (await request('GET', `${MEDIA}/index.js`)).statusCode === 404, 'expected 404')

const absoluteEscape = (await save(request, { src: join(packageDir, 'index.js') })).json()
check('a non-media absolute path is refused as a format', absoluteEscape.problem === 'unsupported-format', absoluteEscape)

// --- mode round trip ---------------------------------------------------------------

const backToCycle = (await save(request, { mode: 'cycle', src: `asset:${names[0]}` })).json()
check('returning to cycle restarts at the first file', backToCycle.media.name === names[0], backToCycle.media.name)
check('the saved path is remembered', backToCycle.settings.src === `asset:${names[0]}`, backToCycle.settings.src)

// The mode save parks the rotation before its first entry, so the next launch plays that
// entry and the one after moves on — a switch never skips a file.
const firstLaunch = (await request('GET', BOOT)).json().media.name
const secondLaunch = (await request('GET', BOOT)).json().media.name
check('the first launch after switching plays the first file', firstLaunch === names[0], firstLaunch)
check('the next launch moves on', secondLaunch === names[1], secondLaunch)

const state = JSON.parse(readFileSync(join(home, 'dsh-splash-animation', 'config.json'), 'utf8'))
check('the state file holds src, mode and pick', state.src === `asset:${names[0]}` && state.mode === 'cycle' && state.pick === names[1], state)
check('the fixture package ships a default video', existsSync(join(assetsDir, 'default.mp4')), assetsDir)

// --- the mode can also come from the profile's cordis.patch.yml ---------------------

const configuredHome = createHome()
const configured = await mountFixtureHost(configuredHome, { mode: 'cycle' })
const fromYaml = configured.requestSync('GET', CONFIG).json()
check('a mode set in the profile row engages', fromYaml.settings.mode === 'cycle' && fromYaml.media.name === names[0], fromYaml.media)
check('a profile row keeps the settings page in charge', fromYaml.source === 'cycle', fromYaml.source)

const invalidHome = createHome()
const invalid = await mountFixtureHost(invalidHome, { mode: 'shuffle' })
check('an unknown mode in the profile row falls back', invalid.requestSync('GET', CONFIG).json().settings.mode === 'fixed', 'expected fixed')

const offHome = createHome()
const offConfigured = await mountFixtureHost(offHome, { mode: 'off' })
const offFromYaml = offConfigured.requestSync('GET', CONFIG).json()
check('a profile row can silence the splash', offFromYaml.settings.mode === 'off' && offFromYaml.media.kind === 'none', offFromYaml.media)
rmSync(offHome, { recursive: true, force: true })
rmSync(configuredHome, { recursive: true, force: true })
rmSync(invalidHome, { recursive: true, force: true })

// --- report ------------------------------------------------------------------------

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  if (!result.ok) console.log(`FAIL  ${result.name}\n      saw: ${JSON.stringify(result.detail)}`)
}
console.log(`${results.length - failed.length}/${results.length} checks passed`)
rmSync(home, { recursive: true, force: true })
rmSync(packageDir, { recursive: true, force: true })
if (failed.length > 0) process.exitCode = 1
