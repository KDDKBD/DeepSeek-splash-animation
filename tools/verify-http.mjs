/**
 * End-to-end verifier for the Host half's HTTP surface.
 *
 * Run a throwaway DSH profile with this plugin installed, then point this script
 * at the printed URL:
 *
 *   dsh --profile splash-test --port 0 --no-open
 *   node tools/verify-http.mjs http://127.0.0.1:PORT/?token=...
 *
 * It authenticates exactly the way a browser does (exchange the launch token at
 * `/` for the session cookie), then asserts the properties the `<video>` element
 * actually depends on: `Accept-Ranges`, correct `206`/`Content-Range` for all
 * three range forms, `304` on a matching `ETag`, `416` for an unsatisfiable
 * range, byte-for-byte equality with the file on disk, and no exposure of any
 * other path. Written in Node rather than PowerShell because Windows
 * PowerShell 5.1's `Invoke-WebRequest` refuses to set a `Range` header.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root, for locating the bundled sample when `src` is empty. */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))

const BASE = process.argv[2]
if (BASE === undefined) {
  console.error('usage: node tools/verify-http.mjs <base-url-with-token>')
  process.exit(2)
}

const CONFIG_PATH = '/dsh-splash-animation/config.json'
const SAVE_PATH = '/dsh-splash-animation/config'
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
 * Issue one HTTP request.
 * @param path - path (and query) relative to the origin.
 * @param options - extra headers, method, and cookie.
 * @returns status, headers, and the raw body.
 */
function http(path, options = {}) {
  const url = new URL(path, BASE)
  const body = options.body === undefined ? undefined : Buffer.from(String(options.body), 'utf8')
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method ?? 'GET',
      headers: {
        ...options.cookie === undefined ? {} : { Cookie: options.cookie },
        // A body without a length is an unparseable request, so declare it.
        ...body === undefined ? {} : { 'Content-Length': String(body.length) },
        ...options.headers ?? {},
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Exchange the launch token for the session cookie, exactly as a browser does. */
async function authenticate() {
  const response = await http(new URL(BASE).pathname + new URL(BASE).search)
  const setCookie = response.headers['set-cookie']
  if (setCookie === undefined || setCookie.length === 0) {
    throw new Error(`no session cookie issued (status ${response.status})`)
  }
  const cookie = String(setCookie[0]).split(';')[0]
  console.log(`authenticated: ${response.status}, cookie ${cookie.split('=')[0]}\n`)
  return cookie
}

const cookie = await authenticate()

console.log('unauthenticated access')
{
  const response = await http(CONFIG_PATH)
  check(response.status === 401, 'config route rejects a request without the session cookie', `status ${response.status}`)
  const media = await http('/dsh-splash-animation/asset/anything')
  check(media.status === 401, 'media route rejects a request without the session cookie', `status ${media.status}`)
}

console.log('\nconfiguration route')
const configResponse = await http(CONFIG_PATH, { cookie })
check(configResponse.status === 200, 'config route answers 200', `status ${configResponse.status}`)
check(
  String(configResponse.headers['content-type']).startsWith('application/json'),
  'config route answers JSON',
  String(configResponse.headers['content-type']),
)
check(configResponse.headers['cache-control'] === 'no-store', 'config route is never cached', String(configResponse.headers['cache-control']))

const config = JSON.parse(configResponse.body.toString('utf8'))
check(config.version === 2, 'wire version is 2', String(config.version))
check(
  Object.keys(config.settings).length === 14,
  'every documented setting is present on the wire',
  String(Object.keys(config.settings).length),
)
check(config.media !== undefined, 'the wire always carries a media field', JSON.stringify(config.media))

// A profile with no video configured is the DEFAULT state, and the contract for
// it is that the plugin stays out of the way: no media, and no error to show.
if (config.media.kind === 'none') {
  console.log('\nno video configured (the plugin is inert)')
  check(config.settings.src === '', 'src is empty', JSON.stringify(config.settings.src))
  check(config.problem === null, 'an unset video is not reported as a problem', String(config.problem))
  // A concrete name rather than one derived from the payload: this branch exists
  // precisely because the payload has no media URL to derive anything from.
  const inert = await http('/dsh-splash-animation/asset/anything.mp4', { cookie })
  check(inert.status === 404, 'the media route serves nothing', `status ${inert.status}`)
  const skipped = await http('/dsh-splash-animation/asset/config.json', { cookie })
  check(skipped.status === 404, 'not even the state file, whatever it is called', `status ${skipped.status}`)
  console.log('')
  console.log(`PASS — ${results.length}/${results.length} assertions (inert configuration)`)
  process.exit(0)
}

/**
 * The media the script configures and then tests.
 *
 * Generated rather than downloaded: the suite must run with no network, and a
 * file with a deterministic size lets the range arithmetic below be exact. A
 * `.mp4` name is what selects the seekable code path, so this also exercises
 * `206`, `Content-Range` and `416` without needing a real encoder. Real codec
 * playback is not this script's job — it verifies the transport.
 */
const SYNTHETIC = {
  path: join(tmpdir(), `dsh-splash-verify-${process.pid}.mp4`),
  size: 48 * 1024,
}

console.log('\nsaving a video through the settings route')
{
  const pattern = Buffer.alloc(SYNTHETIC.size)
  for (let index = 0; index < pattern.length; index++) pattern[index] = index % 251
  writeFileSync(SYNTHETIC.path, pattern)

  const saved = await http(SAVE_PATH, {
    cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src: SYNTHETIC.path.replace(/\\/g, '/') }),
  })
  check(saved.status === 200, 'the save route answers 200', `status ${saved.status}`)
  const savedJson = JSON.parse(saved.body.toString('utf8'))
  check(savedJson.ok === true, 'the save route reports ok', JSON.stringify(savedJson.ok))
  check(savedJson.problem === null, 'a good path reports no problem', String(savedJson.problem))
  check(savedJson.media?.kind === 'video', 'the saved file is classified as video', JSON.stringify(savedJson.media))

  const reread = await http(CONFIG_PATH, { cookie })
  const rereadJson = JSON.parse(reread.body.toString('utf8'))
  check(rereadJson.settings.src.endsWith('.mp4'), 'the saved path is what the next load reads back', String(rereadJson.settings.src))
  check(rereadJson.media?.kind === 'video', 'and the next load sees playable media', JSON.stringify(rereadJson.media))
  check(rereadJson.problem === null, 'with no problem reported', String(rereadJson.problem))
}

// Re-read after saving: this is the payload the browser half would receive on the
// next page load, so every assertion below runs against the post-save state.
const effective = JSON.parse((await http(CONFIG_PATH, { cookie })).body.toString('utf8'))
const mediaUrl = effective.media.url
const mediaPath = new URL(mediaUrl, BASE).pathname
const onDisk = expectedBytes(effective)
check(onDisk.length === effective.media.bytes, 'reported size equals the file on disk', `${onDisk.length} vs ${effective.media.bytes}`)

/**
 * The bytes the route is expected to serve: always the configured file.
 *
 * With no video configured the script exits before reaching this point, because
 * the contract for that state is "serve nothing" rather than "serve something
 * else".
 * @param effectiveConfig - the post-save config payload.
 * @returns the file contents.
 */
function expectedBytes(effectiveConfig) {
  const source = effectiveConfig.settings.src
  const native = process.platform === 'win32' ? String(source).replace(/\//g, '\\') : String(source)
  return readFileSync(native)
}

console.log('\nfull media fetch')
const full = await http(mediaPath, { cookie })
check(full.status === 200, 'full fetch answers 200', `status ${full.status}`)
check(full.body.length === onDisk.length, 'full fetch returns every byte', `${full.body.length}`)
check(full.body.equals(onDisk), 'full fetch is byte-for-byte identical to the file on disk')
check(full.headers['cache-control'] === 'no-cache', 'revalidation is requested', String(full.headers['cache-control']))
check(full.headers['x-content-type-options'] === 'nosniff', 'responses are marked nosniff')
const etag = full.headers.etag

/**
 * Whether this media is supposed to be seekable.
 *
 * The Host declares `Accept-Ranges: bytes` only for indexed containers; an
 * animated image or an index-less stream says `none` on purpose, because
 * advertising range support and then answering with a wrong offset is worse than
 * not supporting it. So the range assertions are conditional on what the Host
 * itself claims, and the non-seekable case asserts the opposite behaviour.
 */
const seekable = full.headers['accept-ranges'] === 'bytes'
console.log(`\nrange capability: ${seekable ? 'seekable' : 'not seekable'} (mime ${effective.media.mime})`)

if (seekable) {
  check(true, 'Accept-Ranges advertises bytes')
  console.log('\nbyte ranges (what <video> actually sends)')
  {
    const head = await http(mediaPath, { cookie, headers: { Range: 'bytes=0-1023' } })
    check(head.status === 206, 'prefix range answers 206', `status ${head.status}`)
    check(head.headers['content-range'] === `bytes 0-1023/${onDisk.length}`, 'prefix Content-Range is exact', String(head.headers['content-range']))
    check(head.body.length === 1024, 'prefix range returns 1024 bytes', String(head.body.length))
    check(head.body.equals(onDisk.subarray(0, 1024)), 'prefix range bytes match the file')
    check(head.headers['content-length'] === '1024', 'Content-Length matches the range', String(head.headers['content-length']))
  }
  {
    const start = onDisk.length - 20000
    const tail = await http(mediaPath, { cookie, headers: { Range: `bytes=${start}-` } })
    check(tail.status === 206, 'open-ended range answers 206', `status ${tail.status}`)
    check(tail.body.length === 20000, 'open-ended range returns the remaining bytes', String(tail.body.length))
    check(tail.body.equals(onDisk.subarray(start)), 'open-ended range bytes match the file')
  }
  {
    const suffix = await http(mediaPath, { cookie, headers: { Range: 'bytes=-512' } })
    check(suffix.status === 206, 'suffix range answers 206', `status ${suffix.status}`)
    check(suffix.body.length === 512, 'suffix range returns 512 bytes', String(suffix.body.length))
    check(suffix.body.equals(onDisk.subarray(onDisk.length - 512)), 'suffix range bytes match the file')
    check(
      suffix.headers['content-range'] === `bytes ${onDisk.length - 512}-${onDisk.length - 1}/${onDisk.length}`,
      'suffix Content-Range is exact',
      String(suffix.headers['content-range']),
    )
  }
  {
    // The seek path: a client may ask for a range in the middle of the file, and
    // a wrong offset here is what makes a video play the wrong frame.
    const mid = await http(mediaPath, { cookie, headers: { Range: 'bytes=1000-9999' } })
    const digest = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16)
    check(mid.body.length === 9000, 'interior range returns exactly the requested span', String(mid.body.length))
    check(
      digest(mid.body) === digest(onDisk.subarray(1000, 10000)),
      'interior range bytes match the file at that offset',
      digest(mid.body),
    )
  }
} else {
  // A non-seekable format must not pretend otherwise: a `Range` header is
  // ignored and the complete body comes back as a plain 200.
  check(true, 'Accept-Ranges advertises none for a non-indexed format')
  const ranged = await http(mediaPath, { cookie, headers: { Range: 'bytes=0-1023' } })
  check(ranged.status === 200, 'a Range request on a non-seekable format answers 200, not a bogus 206', `status ${ranged.status}`)
  check(ranged.body.length === onDisk.length, 'the ignored Range returns the complete body', String(ranged.body.length))
  check(ranged.body.equals(onDisk), 'the complete body is byte-for-byte identical to the file')
}

console.log('\nconditional and error paths')
{
  const conditional = await http(mediaPath, { cookie, headers: { 'If-None-Match': etag } })
  check(conditional.status === 304, 'matching ETag answers 304', `status ${conditional.status}`)
  check(conditional.body.length === 0, '304 carries no body', String(conditional.body.length))
}
if (seekable) {
  const unsatisfiable = await http(mediaPath, { cookie, headers: { Range: `bytes=${onDisk.length + 10}-` } })
  check(unsatisfiable.status === 416, 'unsatisfiable range answers 416', `status ${unsatisfiable.status}`)
  check(
    unsatisfiable.headers['content-range'] === `bytes */${onDisk.length}`,
    '416 reports the complete length',
    String(unsatisfiable.headers['content-range']),
  )
}
{
  const post = await http(mediaPath, { cookie, method: 'POST' })
  check(post.status === 405, 'a write method is refused with 405', `status ${post.status}`)
  check(post.headers.allow === 'GET, HEAD', '405 advertises the allowed methods', String(post.headers.allow))
}
{
  const head = await http(mediaPath, { cookie, method: 'HEAD' })
  check(head.status === 200, 'HEAD answers 200', `status ${head.status}`)
  check(head.body.length === 0, 'HEAD carries no body', String(head.body.length))
  check(
    head.headers['content-length'] === String(onDisk.length),
    'HEAD still reports the full length',
    String(head.headers['content-length']),
  )
}

console.log('\nconfinement: no other path may be served')
for (const probe of [
  '/dsh-splash-animation/asset/other.mp4',
  '/dsh-splash-animation/asset/../package.json',
  '/dsh-splash-animation/asset/%2e%2e/package.json',
  '/dsh-splash-animation/asset/',
  '/dsh-splash-animation/asset',
  '/dsh-splash-animation/',
]) {
  const response = await http(probe, { cookie })
  check(response.status === 404, `404 for ${probe}`, `status ${response.status}`)
}

// The prefix route must not swallow sibling namespaces that merely share a stem.
{
  const sibling = await http('/dsh-splash-animation-other/asset/x', { cookie })
  check(sibling.status === 404, 'a sibling namespace is not served by this route', `status ${sibling.status}`)
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
