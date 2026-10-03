/**
 * Verify the Host half's HTTP routes by driving them in-process.
 *
 * The routes are plain `(req, res)` handlers, so they can be exercised directly:
 * this checks the behaviours that decide what the user gets — the engage gate,
 * what the settings page can save, and how a picked path round-trips — without
 * needing a running DSH or a human clicking a modal dialog. `apply()` accepts a
 * `picker` test seam precisely so the pick route's response handling is covered.
 *
 * Transport-level conformance (Range, ETag, 416, confinement, real auth) is
 * covered separately by `tools/verify-http.mjs` against a live server.
 *
 *   node tools/verify-routes.mjs
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Writable } from 'node:stream'
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

/**
 * Mount the plugin against a fake host and return its routes.
 *
 * @param options - `home` (DSH home), `config` (row config), `picker` (dialog stub).
 * @returns the captured routes plus a request helper, and the plugin context.
 */
function mount(options = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'splash-routes-'))
  const mediaDir = join(home, 'media')
  mkdirSync(mediaDir, { recursive: true })

  const videoPath = join(mediaDir, 'opening.mp4')
  if (!existsSync(videoPath)) writeFileSync(videoPath, Buffer.alloc(4096, 9))

  const routes = []
  const warnings = []
  /** Handlers registered through `ctx.on`, keyed by event name. */
  const listeners = new Map()
  const scoped = {
    get: () => undefined,
    effect: (run) => {
      run()
      return () => {}
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
    },
    inject: (_services, run) => run(scoped),
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  }

  // `apply` and every route handler read the DSH home from the environment at
  // call time (deliberately: it is what lets a saved setting take effect on the
  // next page load without a restart). The scratch home therefore stays installed
  // for the rest of the run; the last mount wins, and each block's requests are
  // issued before the next mount replaces it.
  process.env.DSH_HOME = home
  const applied = host.apply(ctx, options.config ?? {}, { picker: options.picker })
  return { home, mediaDir, videoPath, routes, warnings, listeners, applied }
}

/**
 * Fire the index-injection event and return the rows the plugin contributed.
 * @param listeners - the captured `ctx.on` handlers.
 * @returns the rows pushed into the injection table.
 */
function indexInjections(listeners) {
  const table = []
  for (const handler of listeners.get('webserver/index-inject') ?? []) handler(table)
  return table
}

/**
 * Call one captured route with a synthetic request.
 * @param route - a registered route.
 * @param request - `{ method, url, body, headers }`.
 * @returns the status, headers, and parsed or raw body.
 */
async function call(route, request = {}) {
  const req = {
    method: request.method ?? 'GET',
    url: request.url ?? route.path,
    headers: request.headers ?? {},
    on(event, run) {
      if (event === 'data' && request.body !== undefined) run(Buffer.from(request.body))
      if (event === 'end') run()
      return this
    },
    destroy() {},
  }

  const captured = { status: undefined, headers: {}, chunks: [], destroyed: false }
  // A real Writable, not a hand-rolled object: the media route pipes a file
  // stream into the response, so the fake has to satisfy the Writable contract
  // for the piped bytes to arrive — and using the real one means the pipe itself
  // is under test rather than mocked away.
  const sink = new Writable({
    write(chunk, _encoding, done) {
      captured.chunks.push(Buffer.from(chunk))
      done()
    },
  })
  const res = Object.assign(sink, {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
      return this
    },
    setHeader(name, value) {
      captured.headers[name] = value
    },
    end(chunk, encoding, done) {
      if (chunk !== undefined && chunk !== null) captured.chunks.push(Buffer.from(chunk))
      captured.ended = true
      return Writable.prototype.end.call(this, undefined, encoding, done)
    },
    destroy(error) {
      captured.destroyed = true
      return Writable.prototype.destroy.call(this, error)
    },
  })

  await route.handler(req, res)
  // `pipe` finishes asynchronously; wait for the sink to drain so the captured
  // bytes are complete before they are asserted on.
  if (!sink.writableFinished) {
    await new Promise((resolveDrain) => {
      sink.once('finish', resolveDrain)
      sink.once('close', resolveDrain)
      setTimeout(resolveDrain, 500)
    })
  }

  const body = Buffer.concat(captured.chunks)
  const text = body.toString('utf8')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: captured.status, headers: captured.headers, body, text, json, destroyed: captured.destroyed }
}

/** @returns the route registered at `path`. */
function routeAt(routes, path) {
  const route = routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path} (have ${routes.map((r) => r.path).join(', ')})`)
  return route
}

const CONFIG = '/dsh-splash-animation/config.json'
const SAVE = '/dsh-splash-animation/config'
const PICK = '/dsh-splash-animation/pick'
const MEDIA = '/dsh-splash-animation/asset'

console.log('route registration')
{
  const { routes } = mount()
  const paths = routes.map((route) => route.path).sort()
  check(routes.length === 4, 'registers four routes', String(routes.length))
  check(paths.includes(CONFIG) && paths.includes(SAVE) && paths.includes(PICK) && paths.includes(MEDIA), 'all four paths are the documented ones', paths.join(' '))
  check(routes.filter((route) => route.kind === 'prefix').length === 1, 'exactly one prefix route, so a sibling namespace cannot be swallowed')
  check(routeAt(routes, MEDIA).kind === 'prefix', 'the media route is the prefix route')
}

console.log('\nthe engage gate: never configured')
{
  const { routes, home } = mount()
  const config = await call(routeAt(routes, CONFIG))
  check(config.status === 200, 'the config route still answers', String(config.status))
  check(config.json?.version === 4, 'the wire version is 4', String(config.json?.version))
  check(config.json?.problem === null, 'never configured is not an error, so problem stays null', String(config.json?.problem))
  check(config.json?.settings?.src === undefined, 'src stays undefined, which is the "never chosen" state', JSON.stringify(config.json?.settings?.src))

  // The three-state rule: an unset src engages only if the package ships a default.
  const source = config.json?.source
  check(source === 'bundled' || source === 'unset', 'the source is bundled or unset, never "cleared"', String(source))
  if (source === 'bundled') {
    check(config.json.media.kind === 'video', 'with a bundled default it reports playable media', JSON.stringify(config.json.media))
    check(config.json.effectiveSrc === config.json.media.name || String(config.json.effectiveSrc).endsWith('default.mp4'), 'and the settings page is told which file to prefill', String(config.json.effectiveSrc))
    check(config.json.chosen === false, 'while the user has still chosen nothing', String(config.json.chosen))

    // The bundled file is served just like a chosen one.
    const bundled = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/default.mp4` })
    check(bundled.status === 200, 'the bundled default is served by the media route', String(bundled.status))
    check(bundled.headers['Content-Type'] === 'video/mp4', 'with its real MIME type', String(bundled.headers['Content-Type']))
  } else {
    const media = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/default.mp4` })
    check(media.status === 404, 'with no bundled default the media route serves nothing', String(media.status))
  }

  // Whatever the default is, only the configured name is ever served.
  const other = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/anything.mp4` })
  check(other.status === 404, 'a name that is not the active media is refused', String(other.status))
  check(!existsSync(join(home, 'dsh-splash-animation', 'config.json')), 'mounting writes no state file')
}

console.log('\nclearing: an explicit decision that outranks the default')
{
  const { routes, home, videoPath } = mount()
  const save = routeAt(routes, SAVE)
  await call(save, { method: 'POST', body: JSON.stringify({ src: videoPath }) })
  const cleared = await call(save, { method: 'POST', body: JSON.stringify({ src: '' }) })

  check(cleared.json?.source === 'cleared', 'clearing is labelled as an explicit decision', String(cleared.json?.source))
  check(cleared.json?.media?.kind === 'none', 'a cleared src plays nothing, even with a bundled default present', JSON.stringify(cleared.json?.media))
  check(cleared.json?.effectiveSrc === '', 'and the settings page is told to show an empty field', JSON.stringify(cleared.json?.effectiveSrc))

  const config = await call(routeAt(routes, CONFIG))
  check(config.json?.source === 'cleared', 'the next page load still reports cleared', String(config.json?.source))
  check(config.json?.media?.kind === 'none', 'so the default is not substituted back in', JSON.stringify(config.json?.media))
}

console.log('\nsaving a path from the settings page')
{
  const { routes, home, videoPath } = mount()
  const save = await call(routeAt(routes, SAVE), { method: 'POST', body: JSON.stringify({ src: videoPath }) })
  check(save.status === 200, 'save answers 200', String(save.status))
  check(save.json?.ok === true, 'save reports ok', JSON.stringify(save.json?.ok))
  check(save.json?.media?.kind === 'video', 'the response describes the media', JSON.stringify(save.json?.media))
  check(save.json?.problem === null, 'a good path reports no problem', String(save.json?.problem))

  const stateFile = join(home, 'dsh-splash-animation', 'config.json')
  check(existsSync(stateFile), 'the state file is written')
  check(JSON.parse(readFileSync(stateFile, 'utf8')).src === videoPath, 'the stored src is the chosen path')

  // The whole point of persisting: the next page load must see it without a restart.
  const config = await call(routeAt(routes, CONFIG))
  check(config.json?.media?.kind === 'video', 'the very next config read reports the video', JSON.stringify(config.json?.media))
  check(typeof config.json?.media?.url === 'string' && config.json.media.url.startsWith(MEDIA), 'the media URL points at the asset route', String(config.json?.media?.url))
  check(config.json?.settings?.src === videoPath, 'the effective settings carry the stored path')
}

console.log('\nsaving rejects junk without corrupting state')
{
  const { routes, home, videoPath } = mount()
  const save = routeAt(routes, SAVE)
  await call(save, { method: 'POST', body: JSON.stringify({ src: videoPath }) })

  const wrongMethod = await call(save, { method: 'GET' })
  check(wrongMethod.status === 405, 'a GET on the save route is refused', String(wrongMethod.status))
  check(wrongMethod.headers.Allow === 'POST', '405 advertises POST', String(wrongMethod.headers.Allow))

  const noBody = await call(save, { method: 'POST' })
  check(noBody.status === 400, 'a malformed body is refused', String(noBody.status))
  check(noBody.json?.ok === false, 'the refusal is structured', JSON.stringify(noBody.json))

  const wrongType = await call(save, { method: 'POST', body: JSON.stringify({ src: 42 }) })
  check(wrongType.status === 400, 'a non-string src is refused', String(wrongType.status))

  const stateFile = join(home, 'dsh-splash-animation', 'config.json')
  check(JSON.parse(readFileSync(stateFile, 'utf8')).src === videoPath, 'the rejected requests left the stored path intact')
}

console.log('\nclearing the selection restores default behaviour')
{
  const { routes, home, videoPath } = mount()
  const save = routeAt(routes, SAVE)
  await call(save, { method: 'POST', body: JSON.stringify({ src: videoPath }) })
  const cleared = await call(save, { method: 'POST', body: JSON.stringify({ src: '' }) })
  check(cleared.json?.ok === true, 'clearing is accepted', JSON.stringify(cleared.json?.ok))
  check(cleared.json?.media?.kind === 'none', 'clearing reports no media', JSON.stringify(cleared.json?.media))
  check(JSON.parse(readFileSync(join(home, 'dsh-splash-animation', 'config.json'), 'utf8')).src === '', 'an empty src is stored as empty')

  const config = await call(routeAt(routes, CONFIG))
  check(config.json?.media?.kind === 'none', 'the config read reports no media after clearing', JSON.stringify(config.json?.media))
  const media = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/opening.mp4` })
  check(media.status === 404, 'the media route stops serving after clearing', String(media.status))
}

console.log('\nbroken paths are reported, not served')
{
  const { routes, home } = mount()
  const save = routeAt(routes, SAVE)
  const missing = await call(save, { method: 'POST', body: JSON.stringify({ src: join(home, 'nope.mp4') }) })
  check(missing.json?.problem === 'missing-file', 'a missing file is reported as such', String(missing.json?.problem))
  check(missing.json?.media?.kind === 'none', 'a broken path yields no media', JSON.stringify(missing.json?.media))

  const unsupported = join(home, 'media', 'weird.xyz')
  writeFileSync(unsupported, Buffer.alloc(8, 1))
  const bad = await call(save, { method: 'POST', body: JSON.stringify({ src: unsupported }) })
  check(bad.json?.problem === 'unsupported-format', 'an unknown extension is reported as such', String(bad.json?.problem))

  const config = await call(routeAt(routes, CONFIG))
  check(config.json?.media?.kind === 'none', 'the config read reports no playable media', JSON.stringify(config.json?.media))
  check(config.json?.problem === 'unsupported-format', 'and it reports why', String(config.json?.problem))
}

console.log('\nsuppressing the shell boot layer')
/**
 * Between the native splash window and this plugin's overlay, the shell paints its
 * own `[data-dsh-boot]` layer ("Loading plugins…"). With a video configured that
 * layer is a second, unwanted loading screen, so the plugin contributes a `<style>`
 * row that hides it — but only the version that carries a spinner, and only when
 * there is really something to play.
 */
{
  const { routes, listeners, videoPath } = mount()

  // The rule follows "is anything going to play", so a never-configured install
  // suppresses the boot layer exactly when it falls back to the bundled video.
  const configBefore = await call(routeAt(routes, CONFIG))
  const beforeSave = indexInjections(listeners)
  const expectSuppressed = configBefore.json?.media?.kind !== 'none'
  check(
    beforeSave.length === (expectSuppressed ? 1 : 0),
    expectSuppressed
      ? 'a bundled default also suppresses the shell boot layer'
      : 'with nothing to play the shell boot layer is left alone',
    `${beforeSave.length} row(s), media=${configBefore.json?.media?.kind}`,
  )

  await call(routeAt(routes, SAVE), { method: 'POST', body: JSON.stringify({ src: videoPath }) })
  const afterSave = indexInjections(listeners)
  check(afterSave.length === 1, 'a configured video contributes exactly one row', String(afterSave.length))
  const row = afterSave[0]
  check(row?.kind === 'style', 'the row is a style row, so it applies before the first paint', String(row?.kind))
  check(
    typeof row?.text === 'string' && row.text.includes('[data-dsh-boot]'),
    'the rule targets the shell boot container',
    String(row?.text),
  )
  check(
    typeof row?.text === 'string' && row.text.includes('[data-dsh-boot-spinner]'),
    'the rule is limited to the spinner state, so a plugin-load FAILURE stays visible',
    String(row?.text),
  )
  check(
    typeof row?.text === 'string' && row.text.includes('display:none'),
    'the rule actually hides it',
    String(row?.text),
  )

  /**
   * The same row also covers the application until the splash is mounted.
   *
   * Plugin client modules arrive in batches, so this one executes a second or two
   * after the page starts while anything inline in index.html has already run.
   * Suppressing the boot layer alone therefore opens a hole: loading screen gone,
   * application painted, splash not here yet. The cover has to be in the served
   * HTML, and it has to release itself when the splash mounts.
   */
  check(
    typeof row?.text === 'string' && row.text.includes('[data-dsh-splash-pin]'),
    'the same row also covers the application until the splash mounts',
    String(row?.text),
  )
  check(
    typeof row?.text === 'string' && /body:not\(:has\(> \[data-dsh-splash-pin\]\)\)\s*>\s*#root/.test(row.text),
    'the cover is scoped to #root and asks about a body-level sibling, which is where the portal lands',
    String(row?.text),
  )
  check(
    typeof row?.text === 'string' && row.text.includes('visibility:hidden'),
    'the cover hides rather than removes, so layout cannot shift under it',
    String(row?.text),
  )
  check(
    typeof row?.text === 'string' && !/[{;]\s*animation(-delay)?\s*:/.test(row.text),
    'no CSS timer releases the cover: animation-delay accumulates across reloads and would stop working silently',
    String(row?.text),
  )

  // Re-firing the event must not grow the table: the host may collect more than once.
  const twice = indexInjections(listeners)
  check(twice.length === 1, 're-collecting does not push a duplicate row', String(twice.length))
}
{
  // A broken path means nothing will play, so hiding the boot layer would leave a
  // blank screen with no explanation.
  const { routes, listeners, home } = mount()
  await call(routeAt(routes, SAVE), { method: 'POST', body: JSON.stringify({ src: join(home, 'nope.mp4') }) })
  const rows = indexInjections(listeners)
  check(rows.length === 0, 'a path that cannot play leaves the boot layer visible', JSON.stringify(rows))
}
{
  // A video supplied through the patch config counts too, since the settings file
  // is not the only source of truth.
  const { mediaDir, listeners } = mount({ config: { src: '' } })
  const videoInPatch = join(mediaDir, 'from-patch.mp4')
  writeFileSync(videoInPatch, Buffer.alloc(1024, 4))
  const { listeners: patchListeners } = mount({ config: { src: videoInPatch } })
  const rows = indexInjections(patchListeners)
  check(rows.length === 1, 'a video from the patch config also suppresses the boot layer', String(rows.length))
  check(listeners.size >= 1, 'the injection handler is registered during apply, before any await')
}

console.log('\nthe pick route')
{
  const { routes } = mount({ picker: async () => '/picked/from/dialog.mp4' })
  const picked = await call(routeAt(routes, PICK), { method: 'POST' })
  check(picked.status === 200, 'pick answers 200', String(picked.status))
  check(picked.json?.ok === true, 'pick reports ok', JSON.stringify(picked.json?.ok))
  check(picked.json?.path === '/picked/from/dialog.mp4', 'pick returns the dialog result', String(picked.json?.path))

  const wrongMethod = await call(routeAt(routes, PICK), { method: 'GET' })
  check(wrongMethod.status === 405, 'a GET on the pick route is refused', String(wrongMethod.status))
}
{
  const { routes } = mount({ picker: async () => '' })
  const cancelled = await call(routeAt(routes, PICK), { method: 'POST' })
  check(cancelled.json?.ok === true && cancelled.json?.path === '', 'a cancelled dialog reports an empty path, not an error', JSON.stringify(cancelled.json))
}
{
  // A host with no dialog at all reports it; the settings page then points at the
  // text field instead of pretending the button worked.
  const { routes } = mount({ picker: async () => undefined })
  const unavailable = await call(routeAt(routes, PICK), { method: 'POST' })
  check(unavailable.json?.ok === false, 'a host with no dialog reports failure', JSON.stringify(unavailable.json))
  check(unavailable.json?.error === 'picker-unavailable', 'and names the reason the settings page shows', String(unavailable.json?.error))
}

console.log('\nmedia serving')
{
  const { routes, home, videoPath } = mount()
  await call(routeAt(routes, SAVE), { method: 'POST', body: JSON.stringify({ src: videoPath }) })
  const onDisk = readFileSync(videoPath)

  const full = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/opening.mp4` })
  check(full.status === 200, 'the configured file is served', String(full.status))
  check(full.body.equals(onDisk), 'the served bytes match the file')
  check(full.headers['Content-Type'] === 'video/mp4', 'the MIME matches the extension', String(full.headers['Content-Type']))
  check(full.headers['Accept-Ranges'] === 'bytes', 'a seekable container advertises ranges')

  const ranged = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/opening.mp4`, headers: { range: 'bytes=0-99' } })
  check(ranged.status === 206, 'a range request answers 206', String(ranged.status))
  check(ranged.body.length === 100, 'the range length is exact', String(ranged.body.length))
  check(ranged.headers['Content-Range'] === `bytes 0-99/${onDisk.length}`, 'Content-Range is exact', String(ranged.headers['Content-Range']))

  const head = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/opening.mp4`, method: 'HEAD' })
  check(head.status === 200 && head.body.length === 0, 'HEAD answers with no body', `${head.status}/${head.body.length}`)

  const post = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/opening.mp4`, method: 'POST' })
  check(post.status === 405, 'writing to the media route is refused', String(post.status))

  const other = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/etc/passwd` })
  check(other.status === 404, 'a name other than the configured file is refused', String(other.status))

  const traversal = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/../config.json` })
  check(traversal.status === 404, 'traversal is refused', String(traversal.status))
}
{
  // The settings file itself must never be readable through the media route,
  // even though it lives in the same DSH home.
  const { routes, home, mediaDir } = mount()
  const stateDir = join(home, 'dsh-splash-animation')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ src: join(mediaDir, 'opening.mp4') }))
  const attempt = await call(routeAt(routes, MEDIA), { url: `${MEDIA}/config.json` })
  check(attempt.status === 404, 'the state file is not reachable through the media route', String(attempt.status))
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
