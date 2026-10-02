/**
 * Contract verifier for the Host/browser boundary.
 *
 * The two halves of a DSH client plugin are shipped as separate files and can
 * drift silently: the Host publishes a settings object, the browser half merges
 * it over its own defaults, and a field that exists on one side only is a bug
 * neither unit test would catch. This script loads BOTH halves — the browser
 * half under a stubbed `window.__ModuleLoader__`, which is exactly how the DSH
 * client module system consumes it — and asserts the boundary:
 *
 *   1. the Host module imports and exports the documented surface,
 *   2. `normalizeConfig` always returns exactly the documented keys,
 *   3. the browser half registers a factory whose id matches the package name,
 *   4. it injects `slots` and registers into `shell.overlay` (not `root`, whose
 *      sole occupant is the application frame),
 *   5. the factory's fallback defaults cover no field the Host does not publish,
 *   6. the manifest's `dsh.client` declaration matches what the files provide.
 *
 *   node tools/verify-contract.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))
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

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))

console.log('manifest')
check(manifest.type === 'module', 'package is ESM')
check(manifest.main === './index.js', 'main points at the Host half', String(manifest.main))
check(
  manifest.dsh !== undefined && manifest.dsh.bundle !== undefined && manifest.dsh.bundle.patch === './cordis.patch.yml',
  'declares a bundle patch',
)
check(manifest.dsh !== undefined && manifest.dsh.client !== undefined, 'declares a client half')
check(manifest.dsh?.client?.platform === 'web', 'client half targets the web platform', String(manifest.dsh?.client?.platform))
check(manifest.exports?.['.'] === './index.js', 'exports the Host half at the package root')
check(manifest.exports?.['./client'] === './client.js', 'exports the browser half at ./client')
check(
  manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0,
  'the package has no runtime dependencies, so a link: install cannot fail resolution',
  JSON.stringify(manifest.dependencies ?? {}),
)
check(Array.isArray(manifest.files) && manifest.files.includes('assets'), 'publishes the assets directory')
check(
  typeof manifest.icon === 'string' && manifest.icon.startsWith('./'),
  'declares a relative icon for the plugin manager card',
  String(manifest.icon),
)
check(
  Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'),
  'carries the dsh-plugin keyword, which the listing rules require as a repo topic too',
)
check(
  manifest.meta !== undefined && manifest.meta.title !== undefined && manifest.meta.description !== undefined,
  'declares meta.title and meta.description for the plugin card',
)

console.log('\nmarketplace listing requirements')
// Every asset the listing declares or the README embeds must be relative, must
// stay inside the package, and must be in the published `files` allowlist — an
// image that is not published renders as a broken link on the listing page.
{
  const screenshotsFile = join(PACKAGE_DIR, 'screenshots.json')
  check(existsSync(screenshotsFile), 'declares screenshots.json next to package.json')
  if (existsSync(screenshotsFile)) {
    const parsed = JSON.parse(readFileSync(screenshotsFile, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed.screenshots
    check(Array.isArray(list), 'screenshots.json is an array or an object with a screenshots field')
    if (Array.isArray(list)) {
      check(list.length >= 1 && list.length <= 8, 'lists between 1 and 8 screenshots', String(list.length))
      for (const entry of list) {
        const clean = typeof entry === 'string'
          && !entry.startsWith('/')
          && !entry.startsWith('http')
          && !entry.split('/').includes('..')
        check(clean, `screenshot path is a relative in-package path: ${entry}`)
        check(existsSync(join(PACKAGE_DIR, String(entry))), `screenshot file exists: ${entry}`)
        check(
          manifest.files.some((pattern) => String(entry).startsWith(`${pattern}/`)),
          `screenshot is inside a published directory: ${entry}`,
        )
      }
    }
  }

  // The icon has a hard size ceiling in the plugin manager.
  const iconPath = join(PACKAGE_DIR, String(manifest.icon ?? '').replace(/^\.\//, ''))
  if (existsSync(iconPath)) {
    const size = statSync(iconPath).size
    check(size <= 256 * 1024, 'icon is within the 256 KiB limit', `${size} bytes`)
  } else {
    check(false, 'the declared icon file exists', String(manifest.icon))
  }

  // Images the README embeds are what a storefront falls back to when no
  // screenshots are declared, so a broken path here is a broken listing.
  for (const readme of ['README.md']) {
    const file = join(PACKAGE_DIR, readme)
    const source = readFileSync(file, 'utf8')
    const embeds = [...source.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim())
    check(embeds.length >= 1, `${readme} embeds at least one image, for the storefront fallback`, String(embeds.length))
    for (const embed of embeds) {
      check(!embed.startsWith('http'), `${readme}: embedded image is repository-relative: ${embed}`)
      check(existsSync(join(PACKAGE_DIR, embed)), `${readme}: embedded image exists: ${embed}`)
    }
  }

  // Files the Host half reads at RUNTIME by path must survive `npm publish`.
  //
  // `files` is an allowlist, so a helper script outside it produces an install
  // that is subtly worse than the developer's: the native file dialog silently
  // degrades to the text field. That is exactly what happened with
  // `tools/pick-media-file.ps1`, so the references are scanned for rather than
  // remembered by hand.
  const hostSource = readFileSync(join(PACKAGE_DIR, 'index.js'), 'utf8')
  const runtimeRefs = [...hostSource.matchAll(/join\(PACKAGE_DIR,\s*'([^']+)',\s*'([^']+)'\)/g)]
    .map((match) => `${match[1]}/${match[2]}`)
  check(runtimeRefs.length > 0, 'the Host half reads at least one bundled file by path', JSON.stringify(runtimeRefs))
  for (const reference of runtimeRefs) {
    check(
      manifest.files.some((pattern) => reference === pattern || reference.startsWith(`${pattern}/`)),
      `a runtime file is inside the publish allowlist: ${reference}`,
    )
    check(existsSync(join(PACKAGE_DIR, reference)), `a runtime file exists in the repository: ${reference}`)
  }
}

const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
check(patch.includes(`id: ${manifest.name}`), 'the patch inserts a row with the package id')
check(patch.includes(`name: ${manifest.name}`), 'the patch row resolves the package by name')

console.log('\nHost half')
const host = await import(pathToFileURL(join(PACKAGE_DIR, 'index.js')).href)
check(typeof host.apply === 'function', 'exports apply()')
check(typeof host.normalizeConfig === 'function', 'exports normalizeConfig()')
check(host.DEFAULTS !== undefined, 'exports DEFAULTS')

const documentedKeys = Object.keys(host.DEFAULTS).sort()
check(documentedKeys.length === 14, '14 documented settings', String(documentedKeys.length))
check(
  !documentedKeys.includes('enabled'),
  'there is no enabled flag: the gate is whether a video is configured',
)
check(host.DEFAULTS.fadeOutMs === 300, 'the dissolve default is the documented 0.3 s', String(host.DEFAULTS.fadeOutMs))
check(host.DEFAULTS.holdAfterEndMs === 0, 'with no gap between the last frame and the dissolve')
check(
  JSON.stringify(Object.keys(host.normalizeConfig({})).sort()) === JSON.stringify(documentedKeys),
  'normalizeConfig() fills exactly the documented keys',
)
check(
  JSON.stringify(Object.keys(host.normalizeConfig({ src: 'x', skip: 'bogus', volume: 'loud' })).sort()) === JSON.stringify(documentedKeys),
  'normalizeConfig() keeps exactly the documented keys for junk input',
)
check(host.normalizeConfig({ skip: 'bogus' }).skip === 'button', 'an unknown enum value falls back to the default')
check(host.normalizeConfig({ volume: 99 }).volume === 1, 'an out-of-range number is clamped')
check(host.normalizeConfig({ volume: 'loud' }).volume === 0.6, 'a non-number falls back to the default')
check(host.normalizeConfig({ background: 'red' }).background === '#000000', 'an invalid colour falls back to the default')
check(host.normalizeConfig(null).duration === 0, 'a null config normalizes instead of throwing')
check(host.normalizeConfig({ maxReplays: 2.6 }).maxReplays === 3, 'counts are rounded')

console.log('\nbrowser half')
const clientSource = readFileSync(join(PACKAGE_DIR, 'client.js'), 'utf8')
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
globalThis.document = {
  createElement() {
    return { canPlayType: () => 'maybe' }
  },
}
// Node 24 exposes `navigator` as a getter-only global, so it has to be replaced
// through a property definition rather than assigned.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
await import(pathToFileURL(join(PACKAGE_DIR, 'client.js')).href)

check(registration !== undefined, 'the file registers itself through window.__ModuleLoader__.load')
check(registration?.id === manifest.name, 'the registration id equals the package name', String(registration?.id))
check(typeof registration?.factory === 'function', 'the registration carries a factory')

/** Captured from inside the factory so the module face can be inspected. */
let face
const require = (specifier) => {
  if (specifier === 'react') {
    return {
      createElement: (type, props, children) => ({ type, props, children }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial }),
      useCallback: (fn) => fn,
    }
  }
  throw new Error(`the browser half required an undeclared module: ${specifier}`)
}
face = registration.factory(require)
check(typeof face === 'object' && face !== null, 'the factory returns a module face')
check(Array.isArray(face.inject) && face.inject.includes('slots'), 'the module injects the slots service', JSON.stringify(face.inject))
check(typeof face.apply === 'function', 'the module exposes apply(ctx)')

/** Registration calls captured from the stubbed slots service. */
const registered = []
const injected = []
/**
 * The payload the stubbed transport answers with, mutated per scenario.
 *
 * Both transports are stubbed: `apply` decides whether to mount the overlay from
 * a SYNCHRONOUS `XMLHttpRequest` (an `await` there would hand control back to the
 * event loop and let the application paint a frame before the splash appeared),
 * while the overlay component itself and the settings page use `fetch`.
 */
let wire = { version: 3, settings: {}, media: { kind: 'none' }, problem: null }

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => wire,
})

/** Records whether the synchronous read was actually synchronous. */
let syncReadsWhileApplying = 0
let applying = false
globalThis.XMLHttpRequest = class {
  open() {}
  send() {
    if (applying) syncReadsWhileApplying += 1
    this.status = 200
    this.responseText = JSON.stringify(wire)
  }
}

const ctx = {
  slots: {
    inject(slot, run) {
      injected.push(slot)
      run()
    },
    register(options) {
      registered.push(options)
    },
  },
}
applying = true
face.apply(ctx)
applying = false

check(injected.includes('settings.plugins.tab'), 'it always injects the settings tab, so a video can be chosen', JSON.stringify(injected))
check(
  registered.some((options) => options.name === 'settings.plugins.tab'),
  'it registers the settings page',
)
check(
  registered.find((options) => options.name === 'settings.plugins.tab')?.id === manifest.name,
  'the settings entry id is the package name',
)
check(
  typeof registered.find((options) => options.name === 'settings.plugins.tab')?.label === 'function',
  'the settings tab label is a thunk, so it follows the active locale',
)

// The gate: with no video configured the plugin must not touch the frame at all.
check(
  !injected.includes('shell.overlay'),
  'with no video configured it does not inject the overlay slot',
  JSON.stringify(injected),
)
check(
  registered.every((options) => options.name !== 'shell.overlay'),
  'and registers no overlay entry',
)
check(registered.every((options) => options.name !== 'root'), 'it never registers into the single-slot root')

/**
 * The overlay must be queued inside the same task as `apply`.
 *
 * The gate used to be decided from an awaited fetch, which let the shell paint the
 * application interface for a frame before the splash covered it.
 */
check(syncReadsWhileApplying === 1, 'the engage decision is read synchronously while applying', String(syncReadsWhileApplying))

/** Re-run apply against a configured video and capture what changes. */
wire = {
  version: 3,
  settings: { src: 'C:/videos/opening.mp4' },
  media: { url: '/dsh-splash-animation/asset/opening.mp4', name: 'opening.mp4', kind: 'video', mime: 'video/mp4', extension: 'mp4', bytes: 1024 },
  problem: null,
}
{
  const injectedAgain = []
  const registeredAgain = []
  face.apply({
    slots: {
      inject(slot, run) {
        injectedAgain.push(slot)
        run()
      },
      register(options) {
        registeredAgain.push(options)
      },
    },
  })
  check(injectedAgain.includes('shell.overlay'), 'with a video configured it injects the overlay slot', JSON.stringify(injectedAgain))
  const overlay = registeredAgain.find((options) => options.name === 'shell.overlay')
  check(overlay !== undefined, 'and registers the overlay entry')
  check(overlay?.id === manifest.name, 'the overlay entry id is the package name, so a re-registration replaces it')
  check(typeof overlay?.order === 'number', 'the overlay entry declares an order', String(overlay?.order))
}

/**
 * The rescue-timer arithmetic, checked through the diagnostic surface the plugin
 * exposes (`globalThis.__DSH_SPLASH__.fadeDelayFor`).
 *
 * This one expression caused a real defect: the timer was armed before metadata
 * existed, where the length is `NaN`, and fell back to the readiness floor — an
 * 8-second clip was dismissed at 2.5 seconds. The rule that prevents it is "a
 * guessed duration must never beat a known one", so every branch is pinned here.
 */
{
  const { fadeDelayFor } = globalThis.__DSH_SPLASH__ ?? {}
  check(typeof fadeDelayFor === 'function', 'the plugin exposes its fade-timer arithmetic for diagnosis')
  if (typeof fadeDelayFor === 'function') {
    const defaults = { duration: 0 }
    // A real 8.065 s clip: the timer must sit past the end, not at 2.5 s.
    const eightSeconds = fadeDelayFor(8.065, defaults)
    check(eightSeconds > 8065, 'a known length keeps the rescue timer past the end of the media', `${eightSeconds}ms`)
    check(eightSeconds >= 8065 + 1000, 'and leaves real slack, so decoding jitter cannot cut playback short', `${eightSeconds}ms`)
    check(fadeDelayFor(0.5, defaults) > 500, 'a short clip is not dismissed early either', `${fadeDelayFor(0.5, defaults)}ms`)

    // The regression itself: no length yet must NOT produce a short timer.
    check(fadeDelayFor(NaN, defaults) > 60000, 'an unknown length yields a generous rescue, never a short guess', `${fadeDelayFor(NaN, defaults)}ms`)
    check(fadeDelayFor(0, defaults) > 60000, 'a zero length is treated as unknown', `${fadeDelayFor(0, defaults)}ms`)
    check(fadeDelayFor(undefined, defaults) > 60000, 'a missing length is treated as unknown', `${fadeDelayFor(undefined, defaults)}ms`)

    // An explicit shorter runtime is a deliberate cut and must fire on time.
    check(fadeDelayFor(8.065, { duration: 3000 }) === 3000, 'an explicit shorter runtime cuts exactly on time', `${fadeDelayFor(8.065, { duration: 3000 })}ms`)
    check(fadeDelayFor(2, { duration: 5000 }) > 2000, 'an explicit runtime longer than the clip does not extend past it', `${fadeDelayFor(2, { duration: 5000 })}ms`)
  }
}

// The browser half's own defaults are the fallback for a Host that omits a
// field, so any key it invents would be dead weight and any key the Host
// publishes that it lacks would silently fall back to the Host value instead.
const clientDefaults = /const FALLBACK = \{([\s\S]*?)\n {4}\}/.exec(clientSource)
check(clientDefaults !== null, 'the browser half declares a FALLBACK table')
if (clientDefaults !== null) {
  const keys = [...clientDefaults[1].matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]).sort()
  check(keys.length > 0, 'the FALLBACK table is non-empty', String(keys.length))
  const clientOnly = keys.filter((key) => !documentedKeys.includes(key))
  check(
    clientOnly.length === 0,
    'the browser half invents no setting the Host does not publish',
    JSON.stringify(clientOnly),
  )
  // Settings the Host consumes or resolves itself and never sends as a client
  // input. Listing them explicitly is the point: a new Host-only setting has to
  // be declared here deliberately instead of silently widening the gap.
  const HOST_ONLY = ['src'] // resolved to `media.url` before it reaches the browser
  const hostOnly = documentedKeys.filter((key) => !keys.includes(key))
  const undeclared = hostOnly.filter((key) => !HOST_ONLY.includes(key))
  check(
    undeclared.length === 0,
    'every Host setting is either known to the browser half or declared Host-only',
    JSON.stringify(undeclared),
  )
  check(
    HOST_ONLY.every((key) => documentedKeys.includes(key)),
    'the Host-only list names settings the Host really has',
    JSON.stringify(HOST_ONLY.filter((key) => !documentedKeys.includes(key))),
  )
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
