/**
 * Verify the Host half's pure logic: configuration coercion and media resolution.
 *
 * These are the functions that decide whether the plugin engages at all and
 * whether a given path is playable, so they are checked directly rather than
 * through the HTTP surface — a failure here is a failure of the rule, not of the
 * transport.
 *
 *   node tools/verify-host.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))
const host = await import(pathToFileURL(join(PACKAGE_DIR, 'index.js')).href)

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

/** A scratch DSH home so nothing touches the real one. */
const home = mkdtempSync(join(tmpdir(), 'splash-home-'))

// Removed when the process ends. A check that leaves its scratch directory behind
// fills the system temp folder a little more on every run: during development this
// one alone accumulated 52 directories, and `verify-routes.mjs` accumulated 783.
process.on('exit', () => {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
})

// A real file for the "is a file" path, and a directory for the negative case.
const mediaDir = join(home, 'media')
mkdirSync(mediaDir, { recursive: true })
const realVideo = join(mediaDir, 'opening.mp4')
writeFileSync(realVideo, Buffer.alloc(2048, 7))
const realGif = join(mediaDir, 'opening.gif')
writeFileSync(realGif, Buffer.alloc(512, 3))

console.log('normalizeConfig: coercion')
{
  const keys = Object.keys(host.DEFAULTS).sort()
  check(
    JSON.stringify(Object.keys(host.normalizeConfig({})).sort()) === JSON.stringify(keys),
    'always returns exactly the documented keys',
    `${keys.length}`,
  )
  check(host.normalizeConfig({}).src === undefined, 'an absent src stays undefined, which is what lets the bundled default apply')
  check(host.normalizeConfig({ src: '' }).src === '', 'an empty src stays empty, which is the explicit "never play" signal')
  check(host.normalizeConfig(null).fadeOutMs === 300, 'a null config falls back to the defaults')
  check(host.normalizeConfig({ skip: 'nonsense' }).skip === 'button', 'an unknown enum falls back')
  check(host.normalizeConfig({ fit: 'nonsense' }).fit === 'cover', 'an unknown fit falls back to the full-bleed default')
  check(host.normalizeConfig({ fit: 'contain' }).fit === 'contain', 'and an explicit letterbox is still honoured')
  check(host.normalizeConfig({ volume: 5 }).volume === 1, 'a number above range is clamped')
  check(host.normalizeConfig({ volume: -5 }).volume === 0, 'a number below range is clamped')
  check(host.normalizeConfig({ volume: 'loud' }).volume === 0.6, 'a non-number falls back')
  check(host.normalizeConfig({ background: 'red' }).background === '#000000', 'a non-hex colour falls back')
  check(host.normalizeConfig({ background: '#abc' }).background === '#abc', 'a 3-digit hex colour is accepted')
  check(host.normalizeConfig({ maxReplays: 2.4 }).maxReplays === 2, 'counts are rounded')
  check(host.normalizeConfig({ src: 'x'.repeat(9000) }).src.length === 4096, 'an overlong src is truncated')
  check(host.normalizeConfig({ duration: 1e9 }).duration === 600000, 'duration is capped')
}

console.log('\nresolveMedia: the engage/no-engage gate')
{
  const none = host.resolveMedia('', home)
  check(none.configured === false, 'an empty src reports configured:false')
  check(none.problem === undefined, 'an empty src reports no problem, so nothing is shown')
  check(host.resolveMedia('   ', home).configured === false, 'a whitespace-only src is also not configured')
  check(host.resolveMedia(undefined, home).configured === false, 'resolveMedia itself treats undefined as "nothing to play"')
}

console.log('\nresolveEffectiveMedia: the three-state rule')
/**
 * The distinction this whole layer exists for: "never chosen" must fall back to
 * the bundled default, while "chosen then cleared" must not.
 */
{
  const unset = host.resolveEffectiveMedia(undefined, home)
  check(unset.source === 'bundled' || unset.source === 'unset', 'an unset src reports bundled or unset', unset.source)
  check(
    unset.configured === (unset.source === 'bundled'),
    'an unset src engages exactly when the package ships a default',
    `${unset.source}/${unset.configured}`,
  )

  const cleared = host.resolveEffectiveMedia('', home)
  check(cleared.configured === false, 'a cleared src never engages')
  check(cleared.source === 'cleared', 'and is distinguishable from "never chosen"', cleared.source)

  const chosen = host.resolveEffectiveMedia(realVideo, home)
  check(chosen.configured === true && chosen.source === 'chosen', 'a chosen path engages and is labelled chosen', chosen.source)

  // A broken explicit choice must NOT fall back to the bundled video: playing a
  // different clip than the one asked for is worse than playing nothing.
  const broken = host.resolveEffectiveMedia(join(mediaDir, 'gone.mp4'), home)
  check(broken.configured === true && broken.problem === 'missing-file', 'a broken chosen path reports its problem', String(broken.problem))
  check(broken.source === 'chosen', 'and is not silently replaced by the default', broken.source)
}

console.log('\nresolveMedia: descriptors')
{
  const video = host.resolveMedia(realVideo, home)
  check(video.configured === true && video.problem === undefined, 'an existing mp4 resolves')
  check(video.kind === 'video', 'an mp4 renders as video', video.kind)
  check(video.mime === 'video/mp4', 'an mp4 gets the video/mp4 MIME', video.mime)
  check(video.bytes === 2048, 'the size is reported', String(video.bytes))
  check(video.name === 'opening.mp4', 'the file name is reported', String(video.name))

  const image = host.resolveMedia(realGif, home)
  check(image.kind === 'image', 'a gif renders as an image', image.kind)
  check(image.mime === 'image/gif', 'a gif gets the image/gif MIME', image.mime)

  // Extension matching must be case-insensitive: Windows writes .MP4 freely.
  const upper = join(mediaDir, 'UPPER.MP4')
  writeFileSync(upper, Buffer.alloc(16, 1))
  check(host.resolveMedia(upper, home).kind === 'video', 'an uppercase extension is recognized')

  // Relative and ~ references exist so a path can be pasted without rewriting it.
  check(host.resolveMedia('media/opening.mp4', home).path === realVideo, 'a path relative to the DSH home resolves')
  check(host.resolveMedia('~/definitely-not-here.mp4', home).problem === 'missing-file', 'a ~ path is expanded and then checked')
}

console.log('\nresolveMedia: problems are reported, never thrown')
{
  check(host.resolveMedia('nope.mp4', home).problem === 'missing-file', 'a missing file reports missing-file')
  // Existence outranks format: a path that is not there has no format to judge,
  // and reporting "unsupported format" for a typo sends the user to the wrong fix.
  check(host.resolveMedia('nope.xyz', home).problem === 'missing-file', 'a missing file reports missing-file even with an unknown extension')
  check(host.resolveMedia(mediaDir, home).problem === 'not-a-file', 'a directory reports not-a-file')

  const weird = join(mediaDir, 'probe.xyz')
  writeFileSync(weird, Buffer.alloc(8, 1))
  check(host.resolveMedia(weird, home).problem === 'unsupported-format', 'an existing file with an unknown extension reports unsupported-format')
  check(host.resolveMedia(weird, home).extension === 'xyz', 'the offending extension is reported back')
  check(host.resolveMedia(weird, home).configured === true, 'a configured-but-broken src still reports configured:true')
}

console.log('\nknown extensions')
{
  const expected = [
    'mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'ogm', 'mpg', 'mpeg', 'ts',
    'gif', 'apng', 'webp', 'avif', 'png', 'jpg', 'jpeg', 'svg', 'bmp', 'ico',
  ]
  const missing = []
  for (const extension of expected) {
    const file = join(mediaDir, `probe.${extension}`)
    writeFileSync(file, Buffer.alloc(8, 1))
    if (host.resolveMedia(file, home).problem !== undefined) missing.push(extension)
  }
  check(missing.length === 0, `all ${expected.length} documented extensions resolve`, JSON.stringify(missing))
}

console.log('\nnative picker result encoding')
/**
 * The picker returns the chosen path through a UTF-8 file rather than stdout.
 *
 * A console encodes text with the system ANSI code page (GBK on a Chinese
 * Windows), so a path holding non-ASCII characters came back as mojibake once the
 * Host decoded it as UTF-8 — that is how `开屏动画.mp4` reached the settings page
 * as `????.mp4`. These assertions pin the fixed contract by standing in for the
 * child process and inspecting exactly what the Host does with the file.
 */
if (process.platform !== 'win32') {
  console.log('  skip  the PowerShell picker is Windows-only')
} else {
  /** A folder and file name that exercise multi-byte characters end to end. */
  const unicodeDir = join(home, '素材', '开屏')
  mkdirSync(unicodeDir, { recursive: true })
  const unicodeFile = join(unicodeDir, '开屏动画 中文.mp4')
  writeFileSync(unicodeFile, Buffer.alloc(64, 2))

  /** Records the argv the Host builds, so the argument contract is checked too. */
  let seenArgs
  host.__testHooks.runCapture = async (command, args) => {
    seenArgs = { command, args }
    // Emulate the picker: write the chosen path as UTF-8 with no BOM, exactly as
    // tools/pick-media-file.ps1 does.
    const carrier = args[args.indexOf('-OutFile') + 1]
    writeFileSync(carrier, unicodeFile, 'utf8')
    return ''
  }
  const chosen = await host.pickMediaFileForTest('')

  check(chosen === unicodeFile, 'a non-ASCII path survives the round trip unchanged', String(chosen))
  check(chosen !== undefined && !chosen.includes('\uFFFD'), 'and contains no replacement character', String(chosen))
  check(chosen === undefined || !chosen.startsWith('\uFEFF'), 'and carries no BOM')
  check(seenArgs?.command === 'powershell.exe', 'the picker runs powershell.exe', String(seenArgs?.command))
  check(seenArgs?.args?.includes('-STA') === true, 'STA is requested, which the file dialog requires')
  check(seenArgs?.args?.includes('-OutFile') === true, 'the carrier file is passed explicitly')

  // A cancel writes no file at all, so "nothing there" must read as an empty
  // selection rather than as a failure.
  host.__testHooks.runCapture = async () => ''
  const cancelled = await host.pickMediaFileForTest('')
  check(cancelled === '', 'a cancelled dialog reports an empty choice', JSON.stringify(cancelled))

  // A failed launch is a host problem, not a user cancel: the settings page says
  // so rather than silently doing nothing.
  host.__testHooks.runCapture = async () => undefined
  const failed = await host.pickMediaFileForTest('')
  check(failed === undefined, 'a failed launch reports unavailable, not a cancel', String(failed))

  // The real path is restored so nothing leaks into later assertions.
  host.__testHooks.runCapture = undefined
}

const failed = results.filter((result) => !result.ok)
console.log('')
if (failed.length === 0) {
  console.log(`PASS — ${results.length}/${results.length} assertions`)
  process.exit(0)
}
console.log(`FAILED — ${failed.length} of ${results.length}:`)
for (const failure of failed) console.log(`  - ${failure.label}${failure.detail === undefined ? '' : `  [${failure.detail}]`}`)
process.exit(1)
