/**
 * Render a side-by-side comparison of the `fit` modes, for documentation.
 *
 * The panels are 16:9 media inside a slightly taller box, which is the shape where
 * the difference is unmistakable:
 *   contain — whole image visible, black bands top and bottom
 *   cover   — fills the box by scaling up and cropping the sides, never stretching
 *   fill    — fills the box by stretching the image
 *
 * The panels use a fixed box size rather than the browser window, because Chrome's
 * `--window-size` includes window chrome and the resulting viewport is not the
 * requested size — an earlier version of this tool derived its crop from that
 * assumption and produced two byte-identical "comparisons", proving nothing.
 *
 *   node tools/compare-fit.mjs <output.png>
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

const output = resolve(process.argv[2] ?? join(PACKAGE_DIR, '..', 'fit-compare.png'))

const poster = join(PACKAGE_DIR, 'assets', 'poster.png')
if (!existsSync(poster)) {
  console.error('assets/poster.png is missing; run `npm run poster` first')
  process.exit(2)
}

const browser = BROWSERS.find((candidate) => existsSync(candidate))
if (browser === undefined) {
  console.error('no Chromium-based browser found')
  process.exit(2)
}

const mediaUri = `data:image/png;base64,${readFileSync(poster).toString('base64')}`

/** Fixed geometry: three 360x480 boxes, a gap, and a caption band. */
const PANEL = { width: 360, height: 480 }
const GAP = 12
const MARGIN = 16
const CAPTION = 34
const totalWidth = MARGIN * 2 + PANEL.width * 3 + GAP * 2
const totalHeight = MARGIN * 2 + CAPTION + PANEL.height

const panel = (fit, note) => `
  <figure>
    <div class="box"><img src="${mediaUri}" style="object-fit:${fit}" alt=""></div>
    <figcaption><b>${fit}</b> — ${note}</figcaption>
  </figure>`

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  html, body { margin: 0; background: #101014; color: #e6e6e6;
    font: 14px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .page { width: ${totalWidth}px; height: ${totalHeight}px; box-sizing: border-box;
    padding: ${MARGIN}px; display: flex; gap: ${GAP}px; align-items: flex-start; }
  figure { margin: 0; width: ${PANEL.width}px; }
  .box { width: ${PANEL.width}px; height: ${PANEL.height}px; background: #000;
    outline: 1px solid #3a3a44; overflow: hidden; }
  .box img { width: 100%; height: 100%; display: block; }
  figcaption { padding-top: 8px; font-size: 12px; color: #9aa0aa; }
  figcaption b { color: #e6e6e6; }
</style></head>
<body><div class="page">
${panel('contain', '完整显示，上下留黑边')}
${panel('cover', '铺满裁切（默认），不拉伸')}
${panel('fill', '铺满但画面被拉伸')}
</div></body></html>`

const scratch = join(process.env.TEMP ?? process.env.TMP ?? PACKAGE_DIR, 'dsh-fit-compare')
mkdirSync(scratch, { recursive: true })
const htmlPath = join(scratch, 'compare.html')
writeFileSync(htmlPath, html, 'utf8')

// The requested window is larger than the page; the page fixes its own size, so
// the capture keeps the layout regardless of the viewport.
rmSync(output, { force: true })
await run(browser, [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--no-first-run',
  '--no-default-browser-check',
  `--window-size=${totalWidth},${totalHeight}`,
  `--screenshot=${output}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`,
], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: '' }))

if (!existsSync(output)) {
  console.error('no PNG was written')
  process.exit(1)
}

const png = readFileSync(output)
console.log(`browser : ${browser}`)
console.log(`artwork : ${poster}`)
console.log(`wrote   : ${output}`)
console.log(`size    : ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`)
