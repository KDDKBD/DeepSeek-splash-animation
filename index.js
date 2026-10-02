/**
 * dsh-splash-animation — Host half.
 *
 * Responsibilities the browser half cannot have:
 *   1. storing the chosen video path (a browser cannot read a local file path,
 *      so the choice has to live on the Host and be made through a native
 *      dialog the Host opens),
 *   2. resolving that path to a real file and serving its bytes over the DSH web
 *      transport with HTTP Range, so a video streams progressively instead of
 *      being buffered whole,
 *   3. publishing the effective settings so the browser half needs no build step
 *      and no second copy of the configuration,
 *   4. opening the native file picker on request from the settings page.
 *
 * Two configuration sources, later wins:
 *   - the row `config` in the profile's `cordis.patch.yml` (advanced settings),
 *   - `$DSH_HOME/dsh-splash-animation/config.json`, written by the settings page.
 *
 * Zero runtime dependencies, deliberately: a plugin installed with `link:`
 * resolves its imports from its own real directory, so a dependency that only
 * ships inside the DSH installation fails with ERR_MODULE_NOT_FOUND and takes
 * the whole profile down with it.
 *
 * @module dsh-splash-animation
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of this package's directory; the picker script resolves from here. */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('./', import.meta.url)))

/** Route namespace. Absolute, so the same string works over HTTP and over the Electron IPC bridge. */
const ROUTE_BASE = '/dsh-splash-animation'
const CONFIG_ROUTE = `${ROUTE_BASE}/config.json`
const MEDIA_ROUTE = `${ROUTE_BASE}/asset`
const SAVE_ROUTE = `${ROUTE_BASE}/config`
const PICK_ROUTE = `${ROUTE_BASE}/pick`

/** Directory inside the DSH home that holds this plugin's own state. */
const STATE_DIRNAME = 'dsh-splash-animation'

/**
 * The bundled default video, shipped inside the package.
 *
 * Used while `src` has never been chosen, so a fresh install plays something
 * without any configuration. It is resolved from the package directory rather
 * than the DSH home, which makes it work the same for a `link:` install, an npm
 * install and a tarball install — "relative path" support is really "rebase onto
 * wherever the package was installed", and that is what `import.meta.url` gives.
 */
const BUNDLED_MEDIA = join(PACKAGE_DIR, 'assets', 'default.mp4')

/**
 * The media that should play, honouring the three-state `src` rule.
 *
 * Order of precedence:
 *   1. `src === ''` — the user cleared it. Never play; no default may override an
 *      explicit decision.
 *   2. `src` is a path — validate and use it (a broken path reports a problem and
 *      does not silently fall back to the bundled video, because substituting a
 *      different video than the one asked for is worse than playing nothing).
 *   3. `src === undefined` — never chosen, so the bundled default applies if the
 *      package ships one; otherwise do not engage.
 * @param src - the effective `src` value.
 * @param dshHome - absolute DSH home directory.
 * @returns a descriptor with `configured`, plus `source` describing which rule won.
 */
export function resolveEffectiveMedia(src, dshHome) {
  if (typeof src === 'string') {
    const trimmed = src.trim()
    if (trimmed === '') return { configured: false, source: 'cleared' }
    return { ...resolveMedia(trimmed, dshHome), source: 'chosen' }
  }
  if (!existsSync(BUNDLED_MEDIA)) return { configured: false, source: 'unset' }
  const bundled = resolveMedia(BUNDLED_MEDIA, dshHome)
  // A packaged file that will not resolve is a packaging fault, not a user error;
  // report it as "not engaging" so DSH still boots cleanly.
  if (bundled.configured !== true) return { configured: false, source: 'unset' }
  return { ...bundled, source: 'bundled' }
}

/**
 * Accepted media formats: extension (no dot, lower case) → MIME type.
 *
 * `.mov` and `.mkv` are containers, not codecs, so whether a given file plays
 * depends on the codec inside it; the browser half probes `canPlayType` at
 * runtime rather than guessing here. `SUPPORTED-FORMATS.md` records the matrix.
 */
const FORMATS = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  ogm: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  gif: 'image/gif',
  apng: 'image/apng',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

/** Extensions that are animation-by-themselves and therefore render as `<img>` rather than `<video>`. */
const IMAGE_KIND = new Set(['gif', 'apng', 'webp', 'avif', 'png', 'jpg', 'jpeg', 'svg', 'bmp', 'ico'])

/** Containers worth answering a `Range` request against. */
const SEEKABLE = new Set(['video/mp4', 'video/webm', 'video/x-matroska', 'video/ogg', 'video/quicktime', 'video/mp2t'])

/** Largest media file this plugin will serve; guards against a mis-typed path. */
const MAX_MEDIA_BYTES = 4096 * 1024 * 1024

/** Upper bound on a stored path, so a malformed request cannot fill the state file. */
const MAX_SRC_LENGTH = 4096

/** How long the native picker may stay open before the Host gives up on it. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Documented defaults.
 *
 * Plain object rather than a schema: this package must resolve with zero
 * dependencies (see the module doc). Every field is coerced by
 * {@link normalizeConfig}, so a bad value degrades one setting instead of
 * refusing to boot.
 */
export const DEFAULTS = {
  src: undefined,
  duration: 0,
  skip: 'button',
  skipAfterMs: 1200,
  muted: true,
  volume: 0.6,
  fit: 'contain',
  background: '#000000',
  fadeInMs: 320,
  /**
   * How long the overlay takes to dissolve once the video has finished playing.
   *
   * The video plays in full; only then does the overlay fade, revealing the
   * interface underneath. `holdAfterEndMs` is the gap between the two.
   */
  fadeOutMs: 300,
  playbackRate: 1,
  waitForAppMs: 2500,
  holdAfterEndMs: 0,
  maxReplays: 0,
}

/** `skip` values the player implements. */
const SKIP_MODES = new Set(['button', 'click', 'auto', 'never'])
/** `fit` values, mapped onto CSS `object-fit`. */
const FIT_MODES = new Set(['contain', 'cover', 'fill'])

/**
 * Accept `value` as a finite number inside `[min, max]`, else `fallback`.
 * @param value - the configured value.
 * @param fallback - the default.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the accepted number.
 */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/**
 * Accept a value from a closed set, else `fallback`.
 * @param value - the configured value.
 * @param allowed - the accepted values.
 * @param fallback - the default.
 * @returns the accepted value.
 */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/**
 * Coerce a raw configuration into the effective settings.
 * @param raw - merged configuration object.
 * @returns the effective configuration with every field present and valid.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const background = typeof input.background === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.background)
    ? input.background
    : DEFAULTS.background
  return {
    // `undefined` is preserved, and it means "never chosen" — which is what lets a
    // bundled default apply. An empty string means "clear", i.e. never play.
    src: typeof input.src === 'string' ? input.src.slice(0, MAX_SRC_LENGTH) : undefined,
    duration: clampNumber(input.duration, DEFAULTS.duration, 0, 600000),
    skip: oneOf(input.skip, SKIP_MODES, DEFAULTS.skip),
    skipAfterMs: clampNumber(input.skipAfterMs, DEFAULTS.skipAfterMs, 0, 60000),
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULTS.muted,
    volume: clampNumber(input.volume, DEFAULTS.volume, 0, 1),
    fit: oneOf(input.fit, FIT_MODES, DEFAULTS.fit),
    background,
    fadeInMs: clampNumber(input.fadeInMs, DEFAULTS.fadeInMs, 0, 10000),
    fadeOutMs: clampNumber(input.fadeOutMs, DEFAULTS.fadeOutMs, 0, 10000),
    playbackRate: clampNumber(input.playbackRate, DEFAULTS.playbackRate, 0.1, 4),
    waitForAppMs: clampNumber(input.waitForAppMs, DEFAULTS.waitForAppMs, 0, 60000),
    holdAfterEndMs: clampNumber(input.holdAfterEndMs, DEFAULTS.holdAfterEndMs, 0, 60000),
    maxReplays: Math.round(clampNumber(input.maxReplays, DEFAULTS.maxReplays, 0, 100)),
  }
}

/** @returns the lower-case extension of `file`, without the dot. */
function extensionOf(file) {
  return extname(file).replace(/^\./, '').toLowerCase()
}

/**
 * Resolve a configured media reference to an absolute file path.
 *
 * `~` and relative paths are supported because a user pasting a path into the
 * settings box should not have to spell out an absolute Windows path.
 * @param reference - the configured `src`.
 * @param dshHome - absolute DSH home directory.
 * @returns the absolute candidate path.
 */
function toAbsolutePath(reference, dshHome) {
  if (reference.startsWith('~/') || reference.startsWith('~\\')) return join(homedir(), reference.slice(2))
  if (isAbsolute(reference)) return resolve(reference)
  return resolve(dshHome, reference)
}

/**
 * Describe the file to play, or why it cannot be played.
 *
 * Three input states, and the difference between the first two is the whole
 * point of this function's signature:
 *   - `undefined` — nothing has ever been chosen. The caller decides whether a
 *     bundled default applies; this function reports `configured: false` so an
 *     absent default degrades to "do not engage".
 *   - `''` — the user deliberately cleared it. Never engaged, and no bundled
 *     default may be substituted for it.
 *   - a path — resolved and validated.
 *
 * @param src - the effective `src` value, or `undefined` when never chosen.
 * @param dshHome - absolute DSH home directory.
 * @returns `{ configured: false }` when nothing should play, otherwise a
 *   descriptor, possibly carrying `problem`.
 */
export function resolveMedia(src, dshHome) {
  const reference = typeof src === 'string' ? src.trim() : ''
  // Cleared or absent: the plugin does not engage — no overlay, no card, no
  // placeholder. DSH behaves exactly as if the plugin were not installed.
  if (reference === '') return { configured: false }

  const path = toAbsolutePath(reference, dshHome)
  const extension = extensionOf(path)
  const mime = FORMATS[extension]

  // Existence and file-ness are checked BEFORE the extension: they are the more
  // fundamental facts, and checking the extension first makes a directory or a
  // typo'd path report "unsupported format", which sends the user to the wrong
  // problem. Only a path that really is a file can have a meaningful format.
  if (!existsSync(path)) return { configured: true, problem: 'missing-file', extension, path }

  let stats
  try {
    stats = statSync(path)
  } catch {
    return { configured: true, problem: 'unreadable-file', extension, path }
  }
  if (!stats.isFile()) return { configured: true, problem: 'not-a-file', extension, path }
  if (mime === undefined) return { configured: true, problem: 'unsupported-format', extension, path }
  if (stats.size > MAX_MEDIA_BYTES) return { configured: true, problem: 'file-too-large', extension, path }

  return {
    configured: true,
    path,
    name: path.slice(path.lastIndexOf(sep) + 1),
    extension,
    mime,
    kind: IMAGE_KIND.has(extension) ? 'image' : 'video',
    bytes: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
  }
}

/** Shared 404 body. */
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('not found')
}

/**
 * Test seam for the child-process boundary.
 *
 * `tools/verify-host.mjs` replaces the runner so the picker's encoding contract
 * can be exercised without a human choosing a file in a modal dialog. Production
 * never sets it and the default is the real implementation, so there is no second
 * behaviour to drift out of sync.
 * @type {{ runCapture: ((command: string, args: string[], ctx?: unknown) => Promise<string | undefined>) | undefined }}
 */
export const __testHooks = { runCapture: undefined }

/**
 * Open the native picker, bypassing the Electron attempt.
 *
 * Exported for `tools/verify-host.mjs`: the Windows branch is the one with an
 * encoding contract worth pinning, and routing through {@link pickMediaFile}
 * would make the result depend on whether the test runner happens to be inside
 * Electron.
 * @param initial - an existing path to start the dialog at.
 * @returns the chosen path, `''` on cancel, or `undefined` when unavailable.
 */
export function pickMediaFileForTest(initial) {
  return pickViaPowerShell({ logger: { warn: () => {} } }, initial)
}

/** @returns the state file path inside the DSH home. */
function stateFile(dshHome) {
  return join(dshHome, STATE_DIRNAME, 'config.json')
}

/**
 * Read the settings-page state.
 *
 * A missing or malformed file is `{}` rather than an error: the plugin must
 * still boot with a corrupt state file, and the settings page then shows empty
 * fields the user can fix.
 * @param dshHome - absolute DSH home directory.
 * @returns the stored object, or an empty object.
 */
function readState(dshHome) {
  const file = stateFile(dshHome)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Replace the stored `src` atomically, so a crash mid-write cannot leave a
 * half-written state file that breaks the next boot.
 * @param dshHome - absolute DSH home directory.
 * @param src - the new path, or `''` to clear it.
 */
function writeState(dshHome, src) {
  const dir = join(dshHome, STATE_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const file = stateFile(dshHome)
  const temporary = `${file}.tmp`
  const next = { ...readState(dshHome), src }
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * Parse one `Range` request header against a known media length.
 * @param header - the raw `Range` header.
 * @param size - the total media length in bytes.
 * @returns the inclusive byte range, or `undefined` for a malformed or unsatisfiable header.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  let start
  let end
  if (rawStart === '') {
    if (rawEnd === '') return undefined
    start = Math.max(0, size - Number(rawEnd))
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return undefined
  return { start, end }
}

/**
 * Stream one resolved media file, honouring `Range` and conditional requests.
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 * @param media - a descriptor from {@link resolveMedia}.
 */
function serveMedia(req, res, media) {
  const headers = {
    'Content-Type': media.mime,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': SEEKABLE.has(media.mime) ? 'bytes' : 'none',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${media.mtimeMs.toString(36)}-${media.bytes.toString(36)}"`,
  }

  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  const seekable = SEEKABLE.has(media.mime)
  const range = seekable ? parseRange(req.headers.range, media.bytes) : undefined
  if (seekable && req.headers.range !== undefined && range === undefined) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${media.bytes}` })
    res.end()
    return
  }

  const start = range === undefined ? 0 : range.start
  const end = range === undefined ? media.bytes - 1 : range.end
  res.writeHead(range === undefined ? 200 : 206, {
    ...headers,
    'Content-Length': String(end - start + 1),
    ...range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${media.bytes}` },
  })

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = createReadStream(media.path, { start, end })
  let failed = false
  stream.on('error', () => {
    failed = true
    try {
      res.destroy()
    } catch { /* the socket may already be gone */ }
  })
  res.on('close', () => {
    if (!failed) stream.destroy()
  })
  stream.pipe(res)
}

/**
 * Read a JSON request body with a hard size ceiling.
 * @param req - the HTTP request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed body, or `undefined` when it is absent, oversized, or not JSON.
 */
function readJsonBody(req, limit) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

/**
 * Open a native file dialog and resolve the chosen path.
 *
 * Chain, most native first:
 *   1. Electron's own dialog — the DSH Desktop host runs inside Electron, so
 *      this needs no child process at all. Probed at call time because the same
 *      plugin also runs under the plain Node CLI host.
 *   2. Windows PowerShell WinForms — `powershell.exe` ships with Windows and
 *      WinForms with the .NET runtime it loads, so this needs no dependency.
 *   3. macOS `osascript`, Linux `zenity`.
 *   4. Nothing — the settings page keeps its text field, which always works.
 *
 * @param ctx - the plugin context, used for logging.
 * @param initial - an existing path to start the dialog at.
 * @returns the chosen absolute path, or `undefined` on cancel or unsupported host.
 */
async function pickMediaFile(ctx, initial) {
  const electronResult = await pickViaElectron(initial)
  if (electronResult !== undefined) return electronResult
  if (process.platform === 'win32') return pickViaPowerShell(ctx, initial)
  if (process.platform === 'darwin') return pickViaOsa(initial)
  return pickViaZenity(initial)
}

/**
 * Try Electron's native dialog.
 * @param initial - starting path.
 * @returns the path, `''` for a cancel, or `undefined` when Electron is absent.
 */
async function pickViaElectron(initial) {
  if (process.versions.electron === undefined && process.type === undefined) return undefined
  let dialog
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    dialog = (require('electron').dialog ?? require('electron/main')?.dialog)
  } catch {
    return undefined
  }
  if (dialog === undefined || typeof dialog.showOpenDialog !== 'function') return undefined
  try {
    const result = await dialog.showOpenDialog({
      title: 'Select a video or animated image for the DSH splash',
      properties: ['openFile'],
      defaultPath: initial === '' ? undefined : initial,
      filters: [
        { name: 'All supported media', extensions: [...Object.keys(FORMATS)] },
        { name: 'Video', extensions: Object.keys(FORMATS).filter((extension) => !IMAGE_KIND.has(extension)) },
        { name: 'Animated / still image', extensions: [...IMAGE_KIND] },
      ],
    })
    if (result.canceled === true || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  } catch {
    return undefined
  }
}

/**
 * Run the bundled PowerShell picker.
 * @param ctx - the plugin context.
 * @param initial - starting path.
 * @returns the chosen path, `''` on cancel, or `undefined` when unavailable.
 */
function pickViaPowerShell(ctx, initial) {
  const script = join(PACKAGE_DIR, 'tools', 'pick-media-file.ps1')
  if (!existsSync(script)) {
    ctx.logger.warn('dsh-splash-animation: tools/pick-media-file.ps1 is missing from the installed package; the settings page keeps its text field.')
    return Promise.resolve(undefined)
  }
  const startDir = initial === '' ? '' : dirname(initial)
  const startFile = initial === '' ? '' : initial.slice(initial.lastIndexOf(sep) + 1)
  const carrier = join(tmpdir(), `dsh-splash-pick-${process.pid}-${Date.now()}.txt`)
  return (__testHooks.runCapture ?? runCapture)('powershell.exe', [
    '-NoProfile',
    // STA is required: the common file dialog is a COM object and throws on an
    // MTA thread. Windows PowerShell 5.1 already defaults to STA, but passing it
    // keeps the contract explicit and survives a `pwsh` 7 being first on PATH.
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-OutFile', carrier,
    '-InitialDirectory', startDir,
    '-InitialFile', startFile,
  ], ctx).then((output) => {
    if (output === undefined) return undefined
    // The chosen path travels through a UTF-8 FILE, not stdout: a console encodes
    // text with the system ANSI code page, so a path containing non-ASCII
    // characters arrives as mojibake when decoded as UTF-8. A file carries its own
    // encoding, which removes the code page from the path entirely. stdout is now
    // only a success signal.
    try {
      if (!existsSync(carrier)) return ''
      return readFileSync(carrier, 'utf8').replace(/^\uFEFF/, '').trim()
    } catch {
      return undefined
    } finally {
      try {
        unlinkSync(carrier)
      } catch { /* the picker may never have created it, or it is already gone */ }
    }
  })
}

/**
 * macOS fallback through AppleScript.
 * @param initial - starting path.
 * @returns the chosen path, `''` on cancel, or `undefined` on failure.
 */
function pickViaOsa(initial) {
  const prompt = 'Select a video or animated image for the DSH splash'
  const args = initial === ''
    ? ['-e', `POSIX path of (choose file with prompt "${prompt}")`]
    : ['-e', `POSIX path of (choose file with prompt "${prompt}" default location POSIX file "${initial}")`]
  return runCapture('osascript', args).then((output) => (output === undefined ? undefined : output.trim()))
}

/**
 * Linux fallback through zenity.
 * @param initial - starting path.
 * @returns the chosen path, `''` on cancel, or `undefined` when zenity is absent.
 */
function pickViaZenity(initial) {
  return runCapture('zenity', [
    '--file-selection',
    '--title=Select a video or animated image for the DSH splash',
    ...initial === '' ? [] : [`--filename=${initial}`],
  ]).then((output) => (output === undefined ? undefined : output.trim()))
}

/**
 * Run a child process with a timeout, capturing stdout as UTF-8.
 *
 * Chunks are collected as buffers and decoded once at the end. `out += chunk`
 * would decode each chunk separately, so a multi-byte character straddling a
 * chunk boundary becomes replacement characters — the same class of bug as
 * reading a path through a console code page.
 * @param command - the executable.
 * @param args - its arguments.
 * @param ctx - optional context for diagnostics.
 * @returns the decoded stdout, or `undefined` when the process failed, timed out, or was unavailable.
 */
function runCapture(command, args, ctx) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolveRun(undefined)
      return
    }
    const outChunks = []
    let err = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch { /* already gone */ }
      finish(undefined)
    }, PICK_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      outChunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      if (ctx !== undefined) ctx.logger.warn(`dsh-splash-animation: ${command} could not be started (${error.code ?? error.message}); the settings page keeps its text field.`)
      finish(undefined)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        if (ctx !== undefined && err.trim() !== '') ctx.logger.warn(`dsh-splash-animation: ${command} exited ${code}: ${err.trim().slice(0, 400)}`)
        // A non-zero code is an environment problem, never a user cancel; the
        // settings page reports it as such.
        return finish(undefined)
      }
      finish(Buffer.concat(outChunks).toString('utf8'))
    })
  })
}

/**
 * Mount the splash animation.
 *
 * The route table and the state file are the only mutations; every route
 * registration is disposed with the plugin fiber, so an HMR reload or a profile
 * change leaves no route behind.
 * @param ctx - the plugin context.
 * @param rawConfig - the row `config` as written in YAML.
 * @param options - test seam only: `picker` replaces the native file dialog, so
 *   the pick route's response handling can be verified without a human clicking
 *   a modal window. Production callers omit it.
 */
export function apply(ctx, rawConfig, options = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchConfig = normalizeConfig(rawConfig)
  const pick = options.picker ?? ((initial) => pickMediaFile(ctx, initial))

  /**
   * Effective settings: patch row, then the settings-page file on top.
   *
   * Re-read per request rather than cached at mount, so a change made in the
   * settings page is picked up by the next page load without restarting DSH.
   * @returns the merged, normalized configuration.
   */
  const settings = () => {
    const stored = readState(dshHome)
    const merged = { ...patchConfig }
    for (const [key, value] of Object.entries(stored)) {
      if (key in DEFAULTS) merged[key] = value
    }
    return normalizeConfig(merged)
  }

  // Suppress the shell's own boot layer while our splash owns the screen.
  //
  // The startup order is: the native splash window → the harness starts → the web
  // page loads → the shell paints `[data-dsh-boot]` ("Loading plugins…") → our
  // client module loads and the overlay appears. That middle step is visible as a
  // second loading screen between the native splash and the video, so it is
  // hidden for as long as our splash is going to cover the screen anyway.
  //
  // The rule targets `[data-dsh-boot]:has([data-dsh-boot-spinner])`, not the boot
  // container itself: that container also renders plugin-load FAILURES, and a
  // hidden failure report would turn a diagnosable broken plugin into a blank
  // screen. `:has()` is supported by every Electron that ships a DSH build.
  //
  // The handler is registered synchronously, before anything awaits: the injected
  // row table is collected at host startup, so a handler registered after that
  // collection never contributes. This is why it is the first statement.
  ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      const effective = settings()
      const media = resolveEffectiveMedia(effective.src, dshHome)
      // Nothing to play (or nothing playable) means the shell's own boot screen is
      // the only thing the user would see: leave it alone.
      if (media.configured !== true || media.problem !== undefined) return
      const alreadyPresent = table.some((row) => row && row.kind === 'style' && typeof row.text === 'string' && row.text.includes('dsh-splash-animation-boot'))
      if (alreadyPresent) return
      table.push({
        kind: 'style',
        text: '/* dsh-splash-animation-boot */ [data-dsh-boot]:has([data-dsh-boot-spinner]){display:none!important}',
      })
    } catch { /* a broken settings read must not break index rendering */ }
  })

  ctx.inject(['webServer'], (scoped) => {
    /** The trust fence needs the request, so each handler asks per request. */
    const rejectionFor = (req) => {
      let connection
      try {
        connection = scoped.get('connection')
      } catch {
        connection = undefined
      }
      if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
      return connection.requestRejection(req)
    }

    /** Reject anything that is not this machine's own authenticated client. */
    const guard = (req, res) => {
      const rejection = rejectionFor(req)
      if (rejection === undefined) return false
      res.writeHead(rejection)
      res.end()
      return true
    }

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        const effective = settings()
        const media = resolveEffectiveMedia(effective.src, dshHome)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify({
          version: 4,
          settings: effective,
          // `configured: false` is the signal to the browser half to stay out of
          // the way entirely — no overlay, no card, nothing.
          media: media.configured !== true
            ? { kind: 'none' }
            : media.problem === undefined
              ? {
                  url: `${MEDIA_ROUTE}/${encodeURIComponent(media.name)}`,
                  name: media.name,
                  kind: media.kind,
                  mime: media.mime,
                  extension: media.extension,
                  bytes: media.bytes,
                }
              : { kind: 'none', name: media.name, extension: media.extension },
          problem: media.problem ?? null,
          /** Which rule chose the media: `bundled`, `chosen`, `cleared` or `unset`. */
          source: media.source ?? null,
          /**
           * What the settings page should show in its path field.
           *
           * A never-chosen install still plays the bundled video, so the field is
           * prefilled with that path — the page shows what is actually playing
           * rather than an empty box that contradicts it. Saving clears the
           * `bundled` source, which is what "the user has now chosen" means.
           */
          effectiveSrc: media.configured === true
            ? (media.source === 'bundled' ? BUNDLED_MEDIA : effective.src)
            : '',
          /** True once the user has chosen (or explicitly cleared) something. */
          chosen: media.source === 'chosen' || media.source === 'cleared',
        }))
      },
    }))

    // The settings page owns the stored `src`; this route is the only writer.
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SAVE_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req, 16 * 1024)
        if (body === undefined || typeof body.src !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        const src = body.src.trim().slice(0, MAX_SRC_LENGTH)
        try {
          writeState(dshHome, src)
        } catch (error) {
          ctx.logger.warn(`dsh-splash-animation: could not write the state file (${error.code ?? error.message})`)
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'write-failed' }))
          return
        }
        // Saving — including saving an empty path — records an explicit choice, so
        // the bundled default no longer applies afterwards. That is what makes
        // "clear it and it stops playing" true.
        const media = resolveEffectiveMedia(src, dshHome)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          ok: true,
          // The same wire version as the config route: the settings page consumes
          // both responses with one parser.
          version: 4,
          settings: { ...patchConfig, ...readState(dshHome) },
          media: media.configured !== true || media.problem !== undefined
            ? { kind: 'none', name: media.name, extension: media.extension }
            : {
                url: `${MEDIA_ROUTE}/${encodeURIComponent(media.name)}`,
                name: media.name,
                kind: media.kind,
                mime: media.mime,
                extension: media.extension,
                bytes: media.bytes,
              },
          problem: media.problem ?? null,
          source: media.source ?? null,
          effectiveSrc: media.configured === true ? src : '',
          chosen: true,
        }))
      },
    }))

    // Opens a native dialog in the Host process; the browser cannot read a local
    // file path, so the pick has to happen here.
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: PICK_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const chosen = await pick(settings().src)
        // `undefined` means this host has no dialog at all; the settings page
        // then says so and points at the text field.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(chosen === undefined ? { ok: false, error: 'picker-unavailable' } : { ok: true, path: chosen }))
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: MEDIA_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const media = resolveEffectiveMedia(settings().src, dshHome)
        if (media.configured !== true || media.problem !== undefined) {
          notFound(res)
          return
        }
        let requested
        try {
          requested = decodeURIComponent(String(req.url ?? '').slice(MEDIA_ROUTE.length).replace(/^\//, '').split('?')[0])
        } catch {
          notFound(res)
          return
        }
        // Only the currently configured file is ever served.
        if (requested !== media.name) {
          notFound(res)
          return
        }
        serveMedia(req, res, media)
      },
    }))
  })
}
