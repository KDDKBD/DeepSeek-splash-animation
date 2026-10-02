/**
 * Render the listing screenshots for this plugin.
 *
 * The screenshots are produced by loading a real page in a real browser
 * (headless Edge/Chrome) and capturing it, rather than by drawing a mock-up: the
 * overlay geometry, the skip button and the theme tokens are the same values the
 * plugin's `client.js` renders.
 *
 * The artwork is a frame extracted from the bundled video by
 * `tools/make-poster.mjs`. Run that first: this script deliberately refuses to
 * invent artwork of its own, because a synthetic poster that does not match what
 * the plugin actually plays is a misleading listing image.
 *
 * What the screenshots therefore do NOT prove is that DSH itself mounted the
 * overlay; they are a faithful render of the plugin's own layer, and `README.zh.md`
 * says so where it matters.
 *
 * Two shots are produced:
 *   assets/screenshot-splash.png  the splash over a stand-in app frame
 *   assets/screenshot-fade.png    mid-dissolve, the app already showing through
 *
 * Usage: node tools/make-screenshots.mjs [viewportWidth viewportHeight]
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))
const OUT_DIR = join(PACKAGE_DIR, 'assets')
const WIDTH = Number(process.argv[2] ?? 1280)
const HEIGHT = Number(process.argv[3] ?? 800)

/** Candidate browsers, in preference order; the first that exists is used. */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
]

/**
 * Values copied from `client.js` so the render cannot drift from the real layer.
 *
 * Kept as a literal block rather than imported because `client.js` is a browser
 * module whose factory has to be materialized with a fake `require`; duplicating
 * four numbers with a pointer back to their source is the smaller liability, and
 * `tools/verify-contract.mjs` fails if the settings those numbers come from
 * disappear.
 */
const OVERLAY = {
  background: '#000000',
  skipRight: '22px',
  skipBottom: '20px',
  skipPadding: '7px 14px',
  skipRadius: '999px',
  skipFontSize: '13px',
  skipOpacity: 0.72,
  maxWidth: 'min(560px, 82vw)',
}

/**
 * DSH theme tokens, copied from the shipped `ui-primitives` stylesheets.
 *
 * A stand-in frame is drawn with the host's own tokens instead of invented
 * colours so the screenshot shows the real contrast between the splash and the
 * application underneath it.
 */
const THEME = {
  '--dsw-alias-bg-base': '#f8f8f6',
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#f1f2f4',
  '--dsw-alias-border-l1': '#e3e4e8',
  '--dsw-alias-border-l2': '#d3d5da',
  '--dsw-alias-label-primary': '#17181a',
  '--dsw-alias-label-secondary': '#5c6068',
  '--dsw-alias-label-tertiary': '#8b8f97',
  '--dsw-alias-brand-primary': '#4d6bfe',
}

/**
 * Read a local file as a data URI.
 *
 * The screenshots are rendered from `file://`, where a sibling `<img src>` is
 * subject to the file-origin policy; a data URI removes that variable entirely.
 * @param file - absolute path.
 * @param mime - the media type to declare.
 * @returns the data URI.
 */
function dataUri(file, mime) {
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`
}

/**
 * The page shell shared by every shot.
 * @param body - markup for the shot.
 * @param overlay - the splash layer markup, or an empty string.
 * @returns a complete HTML document.
 */
function page(body, overlay) {
  const tokens = Object.entries(THEME).map(([name, value]) => `${name}: ${value};`).join(' ')
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  :root { ${tokens} color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    -webkit-font-smoothing: antialiased;
  }
</style></head>
<body>
${body}
${overlay}
</body></html>`
}

/** A stand-in DSH frame: sidebar, conversation column and details rail. */
function appFrame() {
  const rows = [
    ['会话', true],
    ['开屏动画插件调研', false],
    ['PPT 生成流水线', false],
    ['Rance 世界沙盒设定集', false],
    ['沙盒经济模型校准', false],
  ]
  const sidebar = rows.map(([label, active]) => `
    <div style="padding:7px 10px;border-radius:7px;font-size:13px;
      background:${active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent'};
      color:${active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'}">${label}</div>`).join('')

  const messages = [
    ['user', '帮我把开屏动画做成插件，要能装到插件市场。'],
    ['assistant', '已经做好了：宿主半注册两条路由，浏览器半注册进 shell.overlay。'],
    ['user', '格式支持覆盖到哪些？'],
    ['assistant', 'webm、mp4、mov、mkv、ogv 走 video；gif、apng、webp、avif 走 img。'],
  ].map(([role, text]) => `
    <div style="display:flex;gap:10px;align-items:flex-start">
      <div style="width:24px;height:24px;border-radius:50%;flex:none;
        background:${role === 'user' ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-brand-primary)'}"></div>
      <div style="flex:1">
        <div style="font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px">${role === 'user' ? '你' : 'DSH'}</div>
        <div style="font-size:13.5px;line-height:1.65;color:var(--dsw-alias-label-primary)">${text}</div>
      </div>
    </div>`).join('')

  return `
  <div style="display:grid;grid-template-columns:224px 1fr 300px;height:${HEIGHT}px">
    <aside style="border-right:1px solid var(--dsw-alias-border-l1);padding:12px 10px;display:flex;flex-direction:column;gap:3px">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px 14px">
        <div style="width:20px;height:20px;border-radius:6px;background:var(--dsw-alias-brand-primary)"></div>
        <div style="font-size:13px;font-weight:650">DSH Harness</div>
      </div>
      ${sidebar}
    </aside>
    <main style="display:flex;flex-direction:column;min-width:0">
      <header style="height:46px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;padding:0 16px;gap:8px">
        <div style="font-size:13px;font-weight:600">开屏动画插件调研</div>
        <div style="font-size:11px;color:var(--dsw-alias-label-tertiary)">web profile</div>
      </header>
      <div style="flex:1;padding:18px 22px;display:flex;flex-direction:column;gap:16px">${messages}</div>
      <div style="margin:0 22px 18px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;
        font-size:13px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)">
        输入消息，或按 / 查看命令…
      </div>
    </main>
    <aside style="border-left:1px solid var(--dsw-alias-border-l1);padding:14px">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)">详情</div>
      <div style="margin-top:10px;font-size:12.5px;line-height:1.8;color:var(--dsw-alias-label-secondary)">
        插件 <b style="color:var(--dsw-alias-label-primary)">dsh-splash-animation</b><br>
        槽位 shell.overlay<br>
        路由 /dsh-splash-animation/*
      </div>
    </aside>
  </div>`
}

/**
 * The splash layer markup, mirroring the inline styles `client.js` applies.
 * @param mediaUri - data URI of the artwork.
 * @param options - `skip: false` hides the skip button; `fit` selects the CSS
 *   `object-fit`; `opacity` renders a mid-fade frame.
 * @returns the overlay markup.
 */
function overlay(mediaUri, options = {}) {
  const fit = options.fit ?? 'contain'
  const opacity = options.opacity ?? 1
  const skip = options.skip === false ? '' : `
    <button style="position:absolute;right:${OVERLAY.skipRight};bottom:${OVERLAY.skipBottom};
      padding:${OVERLAY.skipPadding};border-radius:${OVERLAY.skipRadius};
      border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22));
      background:var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.42));
      color:var(--dsw-alias-label-primary, #fff);font:inherit;font-size:${OVERLAY.skipFontSize};
      cursor:pointer;opacity:${OVERLAY.skipOpacity};backdrop-filter:blur(6px)">跳过</button>`

  const artwork = `
    <img src="${mediaUri}" alt=""
      style="width:100%;height:100%;object-fit:${fit};background:${OVERLAY.background}">`

  return `
  <div data-dsh-splash-animation style="position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;
    background:${OVERLAY.background};pointer-events:auto;opacity:${opacity};overflow:hidden">
    ${artwork}${skip}
  </div>`
}

/**
 * Capture one page to a PNG.
 * @param browser - browser executable path.
 * @param html - the document.
 * @param out - destination PNG path.
 */
async function capture(browser, html, out) {
  const scratch = join(process.env.TEMP ?? process.env.TMP ?? PACKAGE_DIR, 'dsh-splash-shot')
  mkdirSync(scratch, { recursive: true })
  const htmlPath = join(scratch, 'shot.html')
  writeFileSync(htmlPath, html, 'utf8')
  rmSync(out, { force: true })
  await run(browser, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${out}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ], { maxBuffer: 8 * 1024 * 1024 })
  if (!existsSync(out)) throw new Error(`screenshot was not written: ${out}`)
}

const browser = BROWSERS.find((candidate) => candidate !== '' && existsSync(candidate))
if (browser === undefined) {
  console.error('no Edge or Chrome found; nothing to render with')
  process.exit(2)
}
console.log(`browser: ${browser}`)

// The artwork is a real frame of the bundled video. `make-poster.mjs` produces it,
// and its absence is an error rather than a reason to draw something invented: a
// listing image that does not match what the plugin plays would be misleading.
const poster = join(OUT_DIR, 'poster.png')
if (!existsSync(poster)) {
  console.error('assets/poster.png is missing; run `node tools/make-poster.mjs assets/default.mp4 assets/poster.png --last` first')
  process.exit(2)
}
const mediaUri = dataUri(poster, 'image/png')
const { statSync } = await import('node:fs')
console.log(`artwork: ${poster} (${Math.round(statSync(poster).size / 1024)} KiB)`)

// A fixed typographic scale: the poster carries the artwork, and `cover` crops it
// to the viewport exactly as the splash does.
await capture(browser, page(appFrame(), overlay(mediaUri, { fit: 'cover' })), join(OUT_DIR, 'screenshot-splash.png'))
console.log('wrote assets/screenshot-splash.png')

// Mid-dissolve: the overlay at partial opacity with the application frame already
// visible through it, which is the behaviour the plugin exists to provide.
await capture(browser, page(appFrame(), overlay(mediaUri, { fit: 'cover', opacity: 0.35 })), join(OUT_DIR, 'screenshot-fade.png'))
console.log('wrote assets/screenshot-fade.png')
