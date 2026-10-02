/**
 * Render a frame of a video to a PNG, using a real browser as the decoder.
 *
 * There is no ffmpeg on this machine, but every Electron/Chromium build carries an
 * H.264 decoder, so a headless browser can seek a video and have its frame
 * captured. The capture uses `--screenshot` rather than `--dump-dom`: the DOM dump
 * runs on a virtual clock that never lets the decoder finish, while the screenshot
 * path waits for a real rendered frame.
 *
 * The video element is therefore the artwork — sized to the viewport and cropped —
 * so the screenshot *is* the frame, with no canvas round trip.
 *
 * Usage:
 *   node tools/make-poster.mjs <video> <output.png> [--at <seconds> | --last]
 *   node tools/make-poster.mjs <video> <output.png> --size 1920x1080
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))

/** Candidate browsers, in preference order. */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

const [, , videoArg, outputArg, ...rest] = process.argv
if (videoArg === undefined || outputArg === undefined) {
  console.error('usage: node tools/make-poster.mjs <video> <output.png> [--at <seconds> | --last] [--size WxH]')
  process.exit(2)
}

const video = resolve(videoArg)
const output = resolve(outputArg)
if (!existsSync(video)) {
  console.error(`video not found: ${video}`)
  process.exit(2)
}

const atIndex = rest.indexOf('--at')
/** Seek target in seconds, or `null` for "just inside the final frame". */
const seekAt = atIndex === -1 ? null : Number(rest[atIndex + 1])
if (atIndex !== -1 && !Number.isFinite(seekAt)) {
  console.error('--at needs a number of seconds')
  process.exit(2)
}

const sizeIndex = rest.indexOf('--size')
const size = sizeIndex === -1 ? '1920x1080' : String(rest[sizeIndex + 1])
if (!/^\d+x\d+$/.test(size)) {
  console.error('--size needs WxH, e.g. 1920x1080')
  process.exit(2)
}
const [width, height] = size.split('x').map(Number)

const browser = BROWSERS.find((candidate) => candidate !== '' && existsSync(candidate))
if (browser === undefined) {
  console.error('no Chromium-based browser found to decode with')
  process.exit(2)
}
console.log(`browser: ${browser}`)
console.log(`video  : ${video}`)

/**
 * The page: seek, hold the frame, and let the screenshot capture the element.
 *
 * `document.title` carries the outcome so the caller can report it from the
 * gathered diagnostics rather than guessing whether the seek worked.
 */
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>pending</title>
<style>
  html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
  /* The element is the artwork: filling the viewport, cropped like the plugin's
     own cover fit, so the poster matches what the splash actually shows. */
  video { width: ${width}px; height: ${height}px; object-fit: cover; display: block; }
</style></head>
<body>
<video id="v" src="${pathToFileURL(video).href}" muted playsinline preload="auto"></video>
<script>
  const v = document.getElementById('v')
  const seekAt = ${seekAt === null ? 'null' : String(seekAt)}

  function targetTime() {
    if (seekAt !== null) return seekAt
    const d = v.duration
    if (!Number.isFinite(d) || d <= 0) return 0
    // Just inside the final frame: seeking exactly to the end can land past the
    // last sample and composite nothing.
    return Math.max(0, d - Math.max(0.05, 1 / 30))
  }

  v.addEventListener('error', () => {
    document.title = 'video-error-' + (v.error ? v.error.code : '?')
  })
  v.addEventListener('loadedmetadata', () => {
    document.title = 'metadata-' + v.videoWidth + 'x' + v.videoHeight + '-d' + v.duration.toFixed(3)
    v.currentTime = targetTime()
  })
  v.addEventListener('seeked', () => {
    document.title = 'seeked-' + v.currentTime.toFixed(3)
  })
  v.load()
</script>
</body></html>`

const scratch = join(process.env.TEMP ?? process.env.TMP ?? PACKAGE_DIR, 'dsh-poster')
mkdirSync(scratch, { recursive: true })
const htmlPath = join(scratch, 'poster.html')
writeFileSync(htmlPath, html, 'utf8')

// A generous deadline: decoding a multi-megabyte H.264 head takes a moment.
const deadline = 60000

rmSync(output, { force: true })
const started = Date.now()
const result = await run(browser, [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--no-first-run',
  '--no-default-browser-check',
  `--window-size=${width},${height}`,
  `--timeout=${deadline}`,
  `--screenshot=${output}`,
  pathToFileURL(htmlPath).href,
], { maxBuffer: 32 * 1024 * 1024, timeout: deadline + 15000 }).catch((error) => ({ stdout: '', stderr: String(error) }))

console.log(`elapsed: ${Date.now() - started} ms`)
const diagnostics = `${result.stdout ?? ''}${result.stderr ?? ''}`
const title = /<title>([^<]*)<\/title>/.exec(diagnostics)
if (title !== null) console.log(`page   : ${title[1]}`)
for (const line of diagnostics.split(/\r?\n/)) {
  if (/error|fail|refus|denied/i.test(line) && line.trim() !== '') console.log(`  ! ${line.trim().slice(0, 160)}`)
}

if (!existsSync(output)) {
  console.error('no PNG was written')
  process.exit(1)
}

console.log(`wrote  : ${output}`)
