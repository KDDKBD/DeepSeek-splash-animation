/**
 * Shared test rig for the offline verification scripts.
 *
 * Mounts the real Host half through a stub Cordis context and drives its real route
 * handlers, so the checks exercise the code the browser reaches rather than a copy of it.
 * Nothing here ships: `package.json` publishes only `index.js`, `client.js`, `assets/`,
 * `cordis.patch.yml`, `icon.svg` and `tools/pick-media-file.ps1`.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Absolute path of the package directory under test. */
export const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))

/** The package's own media directory, which the settings page lists. */
export const ASSETS_DIR = join(PACKAGE_DIR, 'assets')

/**
 * Video names a fixture package publishes, in listing order.
 *
 * A checkout's own `assets` directory is the user's library — it holds whatever videos
 * they dropped in, and a published repository ships only the bundled default. Checks that
 * need a rotation therefore build their own package instead of reading that directory.
 */
export const FIXTURE_VIDEOS = ['1.mp4', '2.mp4', '3.mp4', 'default.mp4']

/** Size of each fixture video; large enough to read as MB in the settings page. */
const FIXTURE_BYTES = 1536 * 1024

/** Files a fixture package copies from the real one, beyond its generated assets. */
const PACKAGE_FILES = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']

/** An isolated DSH home, so a run cannot touch the real one. */
export function createHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-splash-verify-'))
}

/** A response stand-in that also accepts a piped body. */
export function createRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk)
      done()
    },
  })
  res.statusCode = 0
  res.headerTable = {}
  res.writeHead = (status, headers) => {
    res.statusCode = status
    res.headerTable = { ...(headers ?? {}) }
    return res
  }
  res.body = () => Buffer.concat(chunks)
  res.text = () => Buffer.concat(chunks).toString('utf8')
  res.json = () => JSON.parse(res.text())
  return res
}

/** A request stand-in carrying `body` when one is given. */
export function createReq(method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

/**
 * Mount the Host half against a stub context.
 *
 * `process.env.DSH_HOME` is read by `apply` at call time, so the home given here decides
 * where the state file goes for the whole run.
 * @param home - absolute DSH home directory.
 * @param rawConfig - the plugin row's `config`, as cordis.yml would carry it.
 * @returns the request dispatcher and the index-injection runner.
 */
export async function mountHost(home, rawConfig = {}) {
  return mountPackage(home, PACKAGE_DIR, rawConfig)
}

/**
 * Mount the Host half from a throwaway copy of the package whose `assets` directory holds
 * the {@link FIXTURE_VIDEOS}, so a check about the listing or the rotation never depends
 * on the media a checkout happens to keep beside the code.
 *
 * The copy is what makes the fixture real rather than mocked: `PACKAGE_DIR` is derived
 * from `import.meta.url`, so importing the copy moves the plugin's own directory — and
 * with it the directory the settings page lists — to the fixtures. Only names, extensions
 * and sizes are read, so each fixture is a sparse file rather than actual media.
 * @param home - absolute DSH home directory.
 * @param rawConfig - the plugin row's `config`, as cordis.yml would carry it.
 * @returns the mounted host, plus the fixture package's directory and its assets directory.
 */
export async function mountFixtureHost(home, rawConfig = {}) {
  const packageDir = mkdtempSync(join(tmpdir(), 'dsh-splash-package-'))
  const assetsDir = join(packageDir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  mkdirSync(join(packageDir, 'tools'), { recursive: true })
  for (const file of PACKAGE_FILES) copyFileSync(join(PACKAGE_DIR, file), join(packageDir, file))
  copyFileSync(join(PACKAGE_DIR, 'tools', 'pick-media-file.ps1'), join(packageDir, 'tools', 'pick-media-file.ps1'))
  for (const name of FIXTURE_VIDEOS) {
    const file = join(assetsDir, name)
    writeFileSync(file, '')
    truncateSync(file, FIXTURE_BYTES)
  }
  const mounted = await mountPackage(home, packageDir, rawConfig)
  return { ...mounted, packageDir, assetsDir }
}

/**
 * Mount one package directory's Host half against a stub context.
 * @param home - absolute DSH home directory.
 * @param packageDir - directory holding the `index.js` to mount.
 * @param rawConfig - the plugin row's `config`, as cordis.yml would carry it.
 * @returns the request dispatcher and the index-injection runner.
 */
async function mountPackage(home, packageDir, rawConfig) {
  process.env.DSH_HOME = home
  const { apply } = await import(pathToFileURL(join(packageDir, 'index.js')).href)

  const routes = []
  const injections = []
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
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: (event, handler) => {
      if (event === 'webserver/index-inject') injections.push(handler)
    },
    inject: (names, run) => {
      if (names.includes('webServer')) run(scoped)
    },
  }
  apply(ctx, rawConfig)

  /**
   * Find the route a URL resolves to.
   * @param url - absolute path, query included.
   * @returns the matching registration.
   */
  const routeFor = (url) => {
    const pathname = new URL(url, 'http://dsh.invalid').pathname
    const route = routes.find((candidate) => candidate.kind === 'exact'
      ? candidate.path === pathname
      : pathname === candidate.path || pathname.startsWith(`${candidate.path}/`))
    if (route === undefined) throw new Error(`no route for ${url}`)
    return route
  }

  /**
   * Dispatch one request at the real handlers.
   * @param method - HTTP method.
   * @param url - absolute path, query included.
   * @param body - optional JSON body.
   * @param headers - extra request headers.
   * @returns the finished response.
   */
  const request = async (method, url, body, headers) => {
    const res = createRes()
    const finished = new Promise((settle) => res.on('finish', settle))
    await routeFor(url).handler(createReq(method, url, body, headers), res)
    await finished
    return res
  }

  /**
   * Dispatch a request whose handler completes inside the current task, which is what the
   * browser half's synchronous boot read needs.
   * @param method - HTTP method.
   * @param url - absolute path, query included.
   * @returns the finished response.
   */
  const requestSync = (method, url) => {
    const res = createRes()
    routeFor(url).handler(createReq(method, url), res)
    return res
  }

  /** @returns the rows the index-injection listeners push. */
  const indexRows = () => {
    const table = []
    for (const handler of injections) handler(table)
    return table
  }

  return { request, requestSync, indexRows }
}
