/**
 * dsh-splash-animation — browser half.
 *
 * Hand-written client bundle in the DSH client-module form: executing this file
 * only REGISTERS a lazy factory (`window.__ModuleLoader__.load`); every module
 * body side effect lives inside the factory closure and runs at materialization.
 * No bundler is involved, which is what keeps this package installable without a
 * build script.
 *
 * Two registrations:
 *   - `shell.overlay` — the splash itself, and ONLY when a video is configured.
 *     With no video the plugin registers nothing here, so DSH behaves exactly as
 *     if it were not installed.
 *   - `settings.plugins.tab` — the settings page that chooses the video.
 *
 * Host endpoints (absolute, so the same strings work in the browser and under
 * Electron, where the preload bridge forwards absolute-path requests):
 *   GET  /dsh-splash-animation/config.json  effective settings + media descriptor
 *   POST /dsh-splash-animation/config       store the chosen path
 *   POST /dsh-splash-animation/pick         open a native file dialog
 *   GET  /dsh-splash-animation/asset/<name> the media bytes, Range-capable
 *
 * @module dsh-splash-animation/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-splash-animation',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')

    /**
     * Mount splash nodes as direct children of `<body>`.
     *
     * A slot's own outlet wrapper is `display: contents`, so it adds no box — but
     * it does not remove the slot's ANCESTORS, and any ancestor that creates a
     * stacking context (a `transform`, a `filter`, `contain`, `isolation`, …) traps
     * a descendant's `z-index` inside it. A high `z-index` then loses to any
     * sibling stacked in the root context, however small its number: measured with
     * `position: fixed; z-index: 9999` inside `<body>` and
     * `position: fixed; z-index: 2147483000` inside a `transform`ed wrapper, the
     * 9999 element paints on top. That is exactly the reported symptom — the
     * wallet widget (9999, body-level) covered the splash, and raising the number
     * could not have fixed it.
     *
     * Portalling to `<body>` puts the splash in the root stacking context, where
     * the number finally means what it says. DSH's own `Menu` does the same.
     *
     * @param node - the element to place.
     * @returns the portal, or the node unchanged when there is no body yet.
     */
    function topLayer(node) {
      if (typeof document === 'undefined' || document.body === null) return node
      return createPortal(node, document.body)
    }

    /**
     * The stacking level every splash node uses.
     *
     * Every one of them, including the one-frame loading cover: a `position: fixed`
     * element with `z-index: auto` sits at level 0 of the root stacking context and
     * is painted over by anything positioned with a positive z-index. Other plugins
     * mount body-level overlays in the thousands, so a cover without a number is a
     * cover that does not cover. That was a real, measured defect — see the loading
     * cover below.
     */
    const TOP_Z = 2147483000

    /**
     * Markers inside the Host's rules, used to find and remove the style element.
     *
     * The Host hides `#root` from the first paint and forces a dark base colour,
     * because this module arrives a second or two after the page starts (plugin
     * client modules are fetched in batches). Without that, a light-theme machine
     * shows the shell's white `body` background, and whatever else painted early,
     * before the splash covers anything.
     *
     * The rules have to be REMOVED HERE, not released by a selector, and the
     * difference is not stylistic. An earlier version wrapped the cover in a
     * condition that asked whether a marked node was mounted, which reads as
     * self-cancelling: mount the splash and the application reappears. It also
     * re-armed — the splash unmounts when the video has faded, the marker goes with
     * it, the condition becomes true again, and the entire interface was hidden and
     * unclickable for good.
     *
     * Removing the element makes the release one-way. It happens once, and
     * afterwards the rules do not exist in the document, so nothing can bring them
     * back.
     */
    const COVER_MARKERS = ['dsh-splash-animation-cover', 'dsh-splash-animation-base']

    /** Guards the removal so it cannot run twice. */
    let coverReleased = false

    /**
     * Drop the Host's cover and its dark base colour, revealing the application.
     *
     * Both go together: the base colour is only correct while the splash owns the
     * screen, and leaving it behind would repaint the whole application black on a
     * light theme.
     *
     * Safe to call at any time and from any branch: it is a no-op once released, and
     * a no-op when the Host injected nothing at all (no media configured, or an
     * unplayable path — in both cases nothing was hidden in the first place).
     */
    function releaseCover() {
      if (coverReleased || typeof document === 'undefined') return
      coverReleased = true
      try {
        // Disarm the Host's guard first. It exists only for the case where this
        // module never runs; once the release has happened its timer has nothing
        // left to do, and leaving it armed would keep a pending task alive for the
        // rest of the session.
        const guard = globalThis.__DSH_SPLASH_COVER_GUARD__
        if (guard !== undefined && guard !== null && typeof guard.clear === 'function') guard.clear()
      } catch { /* an absent guard is the normal case when the Host injected none */ }
      try {
        const sheets = document.head ? document.head.getElementsByTagName('style') : []
        // Collected first: removing while iterating a live HTMLCollection skips
        // elements, and the base rule is the second one in the same element anyway.
        for (let i = 0; i < sheets.length; i += 1) {
          const node = sheets[i]
          const text = typeof node.textContent === 'string' ? node.textContent : ''
          if (!COVER_MARKERS.some((marker) => text.includes(marker))) continue
          if (typeof node.remove === 'function') node.remove()
          else if (node.parentNode) node.parentNode.removeChild(node)
        }
      } catch { /* revealing the application must never throw */ }
    }

    const BASE = '/dsh-splash-animation'
    const CONFIG_URL = `${BASE}/config.json`
    const SAVE_URL = `${BASE}/config`
    const PICK_URL = `${BASE}/pick`
    const OVERLAY_SLOT = 'shell.overlay'
    const TAB_SLOT = 'settings.plugins.tab'
    const ROW_ID = 'dsh-splash-animation'

    /** UI strings; the splash is the first thing a user sees, so it follows the OS language. */
    const TEXT = {
      zh: {
        tab: '开屏动画',
        title: '开屏动画',
        intro: '选一个视频或动图，下次打开 DSH 时会先播它，并在结尾淡出。没有选择时插件完全不生效。',
        pathLabel: '视频 / 动图路径',
        pathPlaceholder: '例如 D:\\videos\\opening.mp4，或 ~/videos/opening.webm',
        choose: '选择文件…',
        save: '保存',
        clear: '清除',
        saved: '已保存。下次打开或刷新 DSH 时生效。',
        cleared: '已清除。插件不再介入，DSH 恢复默认启动。',
        picking: '等待文件选择…',
        pickerUnavailable: '这个宿主没有可用的文件对话框，请直接把路径填进上面的输入框。',
        current: '当前生效',
        none: '未设置 —— 插件不介入',
        willPlay: '下次启动播放',
        bundled: '正在使用内置视频',
        bundledHint: '这是插件自带的视频。换一个就点「选择文件…」，想彻底关掉就点「清除」。',
        size: '大小',
        summary: '影片信息',
        skip: '跳过',
        problem: {
          'unsupported-format': '这个扩展名不在支持列表里。',
          'missing-file': '找不到这个文件。',
          'unreadable-file': '这个文件读不出来。',
          'not-a-file': '这个路径不是一个文件。',
          'file-too-large': '文件超过 4 GiB 上限。',
          'codec-unsupported': '容器能读，但里面的编码格式当前 Electron 不支持，转码成 H.264 或 VP9 即可。',
          'load-failed': '读不到插件配置。',
        },
      },
      en: {
        tab: 'Splash animation',
        title: 'Splash animation',
        intro: 'Pick a video or animated image. It plays the next time DSH opens and fades out at the end. With nothing selected the plugin does not engage at all.',
        pathLabel: 'Video / image path',
        pathPlaceholder: 'e.g. D:\\videos\\opening.mp4, or ~/videos/opening.webm',
        choose: 'Choose file…',
        save: 'Save',
        clear: 'Clear',
        saved: 'Saved. It takes effect the next time DSH opens or the page reloads.',
        cleared: 'Cleared. The plugin no longer engages and DSH boots as usual.',
        picking: 'Waiting for the file dialog…',
        pickerUnavailable: 'This host has no file dialog available; paste the path into the field above instead.',
        current: 'Currently active',
        none: 'Not set — the plugin stays out of the way',
        willPlay: 'Plays on next launch',
        bundled: 'Using the bundled video',
        bundledHint: 'This is the video shipped with the plugin. Pick another with “Choose file…”, or turn the splash off entirely with “Clear”.',
        size: 'Size',
        summary: 'Media',
        skip: 'Skip',
        problem: {
          'unsupported-format': 'That extension is not in the supported list.',
          'missing-file': 'That file was not found.',
          'unreadable-file': 'That file could not be read.',
          'not-a-file': 'That path is not a file.',
          'file-too-large': 'The file exceeds the 4 GiB limit.',
          'codec-unsupported': 'The container is readable but the codec inside it is not supported by this Electron build. Transcode to H.264 or VP9.',
          'load-failed': 'The plugin configuration could not be read.',
        },
      },
    }

    /** @returns the locale dictionary for the active page language. */
    function strings() {
      const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      return lang.startsWith('zh') ? TEXT.zh : TEXT.en
    }

    /**
     * Fetch the Host's effective settings.
     *
     * Deliberately NOT memoized across callers. `apply` uses this result to
     * decide whether the plugin engages at all, and the settings page writes the
     * choice; a cached answer would mean a video chosen in Settings does not take
     * effect until the page is reloaded, which is exactly the bug worth avoiding.
     *
     * A rejection is retained as a value, never thrown: this request runs during
     * boot and must not fail the boot.
     * @returns the parsed payload, or a `kind: 'none'` payload on failure.
     */
    async function payload() {
      try {
        const response = await fetch(CONFIG_URL, { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
        return await response.json()
      } catch {
        return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
      }
    }

    /**
     * Read the same payload synchronously.
     *
     * `apply` must decide whether to mount the overlay BEFORE the shell paints,
     * and an `await` hands control back to the event loop — which is how the
     * application interface got one frame of visibility before the splash
     * appeared. A synchronous XHR is the only way to keep that decision inside
     * the current task. It hits a loopback-only route serving a tiny JSON body,
     * so the stall is negligible, and this runs once per page.
     *
     * A blocked or failed request yields "do not engage": showing nothing is the
     * safe outcome, and the overlay's own fetch then reports the failure.
     * @returns the parsed payload, or a `no media` payload.
     */
    function payloadSync() {
      try {
        const request = new XMLHttpRequest()
        request.open('GET', CONFIG_URL, false)
        request.send(null)
        if (request.status !== 200) return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
        return JSON.parse(request.responseText)
      } catch {
        return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
      }
    }

    /** Defaults mirroring the Host schema, used when a field is absent from the wire. */
    const FALLBACK = {
      duration: 0,
      skip: 'button',
      skipAfterMs: 1200,
      muted: true,
      volume: 0.6,
      // Full-screen by default: scale to cover the frame and crop the overflow,
      // rather than letterboxing with black bands.
      fit: 'cover',
      background: '#000000',
      fadeInMs: 320,
      // How long the dissolve takes once the video has finished playing.
      fadeOutMs: 300,
      playbackRate: 1,
      waitForAppMs: 2500,
      holdAfterEndMs: 0,
      maxReplays: 0,
    }

    /** @returns `value` when it is a usable number, else `fallback`. */
    function num(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /**
     * Headroom added to the known length before the rescue timer may fire.
     *
     * Large on purpose: the timer exists only for a video that reports a length
     * but never fires `ended`, so firing slightly late costs nothing while firing
     * early truncates playback — the failure this constant exists to prevent.
     */
    const FALLBACK_SLACK_MS = 5000

    /** Rescue timeout when a video never reports a length at all. */
    const UNKNOWN_LENGTH_TIMEOUT_MS = 120000

    /**
     * Delay, in milliseconds, before the rescue timer may dismiss the overlay.
     *
     * Pure and exported to the test hooks because this single expression caused a
     * real defect: an earlier version armed the timer before metadata existed,
     * where `length` is `NaN`, and fell back to the readiness floor — cutting an
     * 8-second clip off at 2.5 seconds. The rule that prevents it is "never let a
     * guessed duration beat a known one", and that is what this encodes.
     * @param lengthSeconds - the media length, or `NaN`/`0` when unknown.
     * @param settings - the effective settings.
     * @returns the delay in milliseconds.
     */
    function fadeDelayFor(lengthSeconds, settings) {
      const known = typeof lengthSeconds === 'number' && Number.isFinite(lengthSeconds) && lengthSeconds > 0
      if (!known) return UNKNOWN_LENGTH_TIMEOUT_MS
      // An explicit shorter runtime is a deliberate cut, so it fires exactly on
      // time and is the primary exit rather than a rescue.
      if (settings.duration > 0 && settings.duration < lengthSeconds * 1000) return settings.duration
      return lengthSeconds * 1000 + FALLBACK_SLACK_MS
    }

    /** @returns the CSS `object-fit` keyword for the `fit` setting. */
    function objectFit(fit) {
      if (fit === 'cover') return 'cover'
      if (fit === 'fill') return 'fill'
      return 'contain'
    }

    /** @returns a human-readable byte size. */
    function humanBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * Probe which of the supported containers this build can actually decode.
     *
     * A `.mov` or `.mkv` is a container, not a codec, so a file can be readable
     * and still unplayable. Probing lets a support request answer "what works on
     * THIS machine" instead of quoting a static table.
     * @returns an ordered capability list.
     */
    function probeFormats() {
      const probes = [
        ['video/mp4; codecs="avc1.42E01E"', 'MP4 / H.264'],
        ['video/mp4; codecs="hev1.1.6.L93.B0"', 'MP4 / HEVC'],
        ['video/mp4; codecs="av01.0.05M.08"', 'MP4 / AV1'],
        ['video/webm; codecs="vp8"', 'WebM / VP8'],
        ['video/webm; codecs="vp9"', 'WebM / VP9'],
        ['video/webm; codecs="av01.0.05M.08"', 'WebM / AV1'],
        ['video/ogg; codecs="theora"', 'OGG / Theora'],
        ['video/x-matroska; codecs="avc1.42E01E"', 'MKV / H.264'],
        ['video/quicktime; codecs="avc1.42E01E"', 'MOV / H.264'],
        ['video/mp2t', 'MPEG-TS'],
        ['video/mpeg', 'MPEG-PS'],
      ]
      const element = document.createElement('video')
      return probes.map(([type, label]) => ({ label, type, support: element.canPlayType(type) || 'no' }))
    }

    /**
     * One splash overlay.
     *
     * Lifecycle: cover → fade in → play → fade out → unmount. The fade starts
     * `fadeOutMs` before the media ends, so the video is still visible while it
     * is already dissolving into the interface beneath it. Every path
     * terminates: a splash that cannot be dismissed would hide the application.
     * @returns the overlay element, or `null` in the frame after dismissal.
     */
    function SplashAnimation() {
      const [session, setSession] = React.useState({ phase: 'loading' })
      const [phase, setPhase] = React.useState('in')
      const [failed, setFailed] = React.useState(false)
      /**
       * Reveal the application, in the same commit that mounts the splash.
       *
       * `useLayoutEffect`, not `useEffect`: the Host's cover has `#root` hidden, and
       * an effect runs after the browser has painted. Removing the cover then would
       * show the application for a frame BEFORE the splash covers it — the same flash
       * this whole mechanism exists to remove. A layout effect runs after the DOM is
       * updated and before paint, so the cover comes off with the splash already
       * mounted and nothing is ever visible uncovered.
       */
      React.useLayoutEffect(() => {
        releaseCover()
      }, [])
      /**
       * Whether the video has a first frame worth showing.
       *
       * Until it does, the overlay paints an opaque cover instead of the element.
       * A `<video>` reports metadata well before it can paint, and mounting it
       * directly leaves whatever is behind visible through the not-yet-decoded
       * frame — which is how the application interface flashed for an instant
       * before the video appeared.
       */
      const [paintable, setPaintable] = React.useState(false)
      const videoRef = React.useRef(null)
      const dismissedRef = React.useRef(false)
      const t = strings()

      // Fresh settings for this mount. The decision to mount at all came from the
      // synchronous read in `apply`, so a failure here only means stale values,
      // never a missing splash.
      React.useEffect(() => {
        let cancelled = false
        payload().then((result) => {
          if (cancelled) return
          const settings = { ...FALLBACK, ...((result && result.settings) || {}) }
          setSession({ phase: 'ready', settings, media: (result && result.media) || { kind: 'none' } })
        })
        return () => {
          cancelled = true
        }
      }, [])

      /** One-way dismissal: the first caller wins, later callers are no-ops. */
      const dismiss = React.useCallback(() => {
        if (dismissedRef.current) return
        dismissedRef.current = true
        setPhase('out')
      }, [])

      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        const settings = session.settings
        const media = session.media
        const timers = []
        const after = (ms, run) => {
          const id = window.setTimeout(run, Math.max(0, ms))
          timers.push(id)
          return id
        }
        const clearAll = () => {
          for (const id of timers) window.clearTimeout(id)
        }

        // Unplayable media is never shown as a card over the application: the
        // user asked for a splash, not for a diagnostic surface at boot. DSH
        // simply appears, and the settings page reports the problem instead.
        if (session.media.kind === 'none' || failed) {
          dismiss()
          return clearAll
        }

        /** The countdown that starts the fade once the video has played out. */
        let fadeTimer

        if (media.kind === 'video') {
          const element = videoRef.current
          if (element === null || element === undefined) {
            dismiss()
            return clearAll
          }

          element.playbackRate = settings.playbackRate
          element.volume = settings.volume
          element.muted = settings.muted

          /**
           * Release the splash once the video has played out.
           *
           * The video is watched to its end; only then does the overlay dissolve
           * (`fadeOutMs`) into the interface beneath it. `holdAfterEndMs` is the
           * gap between the last frame and the start of that dissolve, so the
           * default of 0 means "dissolve the moment it ends".
           */
          const finish = () => {
            after(settings.holdAfterEndMs, dismiss)
          }

          /**
           * Backstop for media that never reports an end.
           *
           * This is armed ONLY once the length is known, and it is deliberately
           * far past the real end: its only job is to rescue a video that reports
           * a duration but never fires `ended`. Arming it before metadata exists
           * is what cut an 8-second clip off at 2.5 seconds — with no length to
           * work from, the timer fell back to the readiness floor, which is a
           * floor for animated images and has no business bounding a video.
           */
          const armFallback = () => {
            if (fadeTimer !== undefined) window.clearTimeout(fadeTimer)
            fadeTimer = after(fadeDelayFor(element.duration, settings), dismiss)
          }

          element.addEventListener('loadedmetadata', armFallback)
          element.addEventListener('durationchange', armFallback)

          const started = element.play()
          if (started !== undefined && typeof started.catch === 'function') {
            // Autoplay refused, or the codec failed after metadata. A muted retry
            // satisfies every autoplay policy; if that also fails the media itself
            // is the problem, and the splash gets out of the way.
            started.catch(() => {
              element.muted = true
              const retry = element.play()
              if (retry !== undefined && typeof retry.catch === 'function') retry.catch(() => dismiss())
            })
          }

          const onEnded = () => {
            if (settings.maxReplays > 0) {
              const replayed = Number(element.dataset.replays || '0')
              if (replayed < settings.maxReplays) {
                element.dataset.replays = String(replayed + 1)
                element.currentTime = 0
                const again = element.play()
                if (again !== undefined && typeof again.catch === 'function') again.catch(() => dismiss())
                return
              }
            }
            // The video has played in full. Cancel the backstop and dissolve.
            if (fadeTimer !== undefined) window.clearTimeout(fadeTimer)
            finish()
          }
          const onError = () => dismiss()
          /**
           * Reveal the video once it can actually paint.
           *
           * `loadeddata` means the first frame is decoded. Until this fires the
           * overlay keeps painting its opaque cover, so the application never shows
           * through the gap between mounting the element and its first frame.
           */
          const onPaintable = () => setPaintable(true)
          element.addEventListener('ended', onEnded)
          element.addEventListener('error', onError)
          element.addEventListener('loadeddata', onPaintable)
          element.addEventListener('canplay', onPaintable)

          // No `armFallback()` here on purpose: at this point `element.duration` is
          // still NaN, and arming from an unknown length is what truncated
          // playback. `loadedmetadata`/`durationchange` arm it, and a video that
          // never reports a length is covered by UNKNOWN_LENGTH_TIMEOUT_MS.

          return () => {
            clearAll()
            element.removeEventListener('loadedmetadata', armFallback)
            element.removeEventListener('durationchange', armFallback)
            element.removeEventListener('ended', onEnded)
            element.removeEventListener('error', onError)
            element.removeEventListener('loadeddata', onPaintable)
            element.removeEventListener('canplay', onPaintable)
          }
        }

        // An animated image has no `ended` event, so its length is unknowable in
        // the DOM: `duration` or the readiness floor is the only exit.
        const lifetime = settings.duration > 0 ? settings.duration : Math.max(settings.waitForAppMs, 4000)
        after(lifetime, dismiss)
        return clearAll
      }, [session, failed, dismiss])

      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        if (session.settings.skip !== 'auto') return undefined
        const id = window.setTimeout(dismiss, Math.max(0, session.settings.skipAfterMs))
        return () => window.clearTimeout(id)
      }, [session, dismiss])

      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        if (session.settings.skip === 'never' || session.settings.skip === 'auto') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            dismiss()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [session, dismiss])

      React.useEffect(() => {
        if (phase !== 'out') return undefined
        const fade = num(session.settings && session.settings.fadeOutMs, FALLBACK.fadeOutMs)
        const id = window.setTimeout(() => setSession({ phase: 'done' }), fade)
        return () => window.clearTimeout(id)
      }, [phase, session.settings])

      if (session.phase === 'done') return null

      if (session.phase === 'loading') {
        // A bare cover for one microtask, so the application is never visible
        // mid-animation. Portalled like the splash itself, and it must carry the
        // SAME z-index — this is not cosmetic.
        //
        // A `position: fixed` element with `z-index: auto` sits at level 0 of the
        // root stacking context, so anything positioned with a positive z-index
        // paints over it. Other plugins mount body-level overlays with z-index values
        // in the thousands (the wallet widget uses 9999 through 22000), and while
        // this cover lacked a z-index they were painted on top of it. Measured on a
        // live page: the cover was on screen and `elementFromPoint` at the viewport
        // centre returned the application's input box, for the two frames between
        // this cover mounting and the real overlay replacing it.
        return topLayer(React.createElement('div', {
          'aria-hidden': true,
          style: { position: 'fixed', inset: 0, zIndex: TOP_Z, background: '#000000', pointerEvents: 'auto' },
        }))
      }

      const settings = session.settings
      const media = session.media
      const fading = phase === 'out'
      const overlayStyle = {
        position: 'fixed',
        inset: 0,
        // Same level as the loading cover; see `TOP_Z`. The number is only decisive
        // once the splash sits in the root stacking context, which `topLayer` ensures.
        zIndex: TOP_Z,
        display: 'grid',
        placeItems: 'center',
        background: settings.background,
        pointerEvents: 'auto',
        opacity: fading ? 0 : 1,
        transition: `opacity ${fading ? settings.fadeOutMs : settings.fadeInMs}ms ease`,
        overflow: 'hidden',
      }

      const children = []
      if (media.kind === 'video') {
        children.push(React.createElement('video', {
          key: 'video',
          ref: videoRef,
          src: media.url,
          muted: settings.muted,
          playsInline: true,
          autoPlay: true,
          preload: 'auto',
          onError: () => setFailed(true),
          'aria-label': 'splash animation',
          style: {
            width: '100%',
            height: '100%',
            objectFit: objectFit(settings.fit),
            background: settings.background,
          },
        }))
      } else {
        children.push(React.createElement('img', {
          key: 'image',
          src: media.url,
          alt: '',
          onError: () => setFailed(true),
          style: {
            width: '100%',
            height: '100%',
            objectFit: objectFit(settings.fit),
            background: settings.background,
          },
        }))
      }

      // An opaque cover that survives until the video can paint. A `<video>` is
      // mounted before it has a decodable frame, and during that window the
      // application behind the overlay shows through — a one-frame flash of the
      // interface right before the animation starts. The cover is removed only on
      // `loadeddata`/`canplay`; a still image is paintable immediately, and the
      // cover also carries a plain video from its very first paint.
      if (media.kind === 'video' && !paintable) {
        children.push(React.createElement('div', {
          key: 'cover',
          'aria-hidden': true,
          style: { position: 'absolute', inset: 0, background: settings.background },
        }))
      }

      if (settings.skip !== 'never' && settings.skip !== 'auto') {
        children.push(React.createElement('button', {
          key: 'skip',
          type: 'button',
          onClick: (event) => {
            event.stopPropagation()
            dismiss()
          },
          style: {
            position: 'absolute',
            right: '22px',
            bottom: '20px',
            padding: '7px 14px',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22))',
            background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.42))',
            color: 'var(--dsw-alias-label-primary, #ffffff)',
            font: 'inherit',
            fontSize: '13px',
            cursor: 'pointer',
            opacity: 0.72,
          },
        }, t.skip))
      }

      return topLayer(React.createElement('div', {
        style: overlayStyle,
        onClick: settings.skip === 'click' ? dismiss : undefined,
        'data-dsh-splash-animation': '',
      }, children))
    }

    /** Shared field styling for the settings page. */
    const FIELD = {
      boxSizing: 'border-box',
      width: '100%',
      minWidth: 0,
      height: '34px',
      padding: '0 12px',
      border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-3, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #17181a)',
      font: 'inherit',
      fontSize: '13px',
    }

    /**
     * @param options - label text, click handler, and emphasis.
     * @returns a themed button element.
     */
    function button(options) {
      return React.createElement('button', {
        type: 'button',
        onClick: options.onClick,
        disabled: options.disabled === true,
        style: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: 1.5,
          borderRadius: '8px',
          padding: '5px 14px',
          cursor: options.disabled === true ? 'default' : 'pointer',
          opacity: options.disabled === true ? 0.4 : 1,
          border: options.primary === true ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2, #d3d5da)',
          background: options.primary === true ? 'var(--dsw-alias-label-primary, #17181a)' : 'transparent',
          color: options.primary === true ? 'var(--dsw-alias-bg-layer-3, #ffffff)' : 'var(--dsw-alias-label-secondary, #5c6068)',
        },
      }, options.label)
    }

    /**
     * The settings page: choose the video the splash plays.
     *
     * A browser cannot read a local file path, so "choose" posts to the Host,
     * which opens the native dialog. The text field is not a fallback for a
     * broken path — it is the only route on a host with no dialog at all (a
     * headless server, a browser on another machine), so it is always present.
     * @returns the settings page element.
     */
    function SplashSettings() {
      const t = strings()
      const [draft, setDraft] = React.useState('')
      const [state, setState] = React.useState({ status: 'loading' })
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        payload().then((result) => {
          if (cancelled) return
          // `effectiveSrc` is what is actually playing right now, which for a
          // never-configured install is the bundled video the Host resolved. Showing
          // an empty field while that video plays would contradict the page's own
          // status line, so the field follows the Host's answer.
          const shown = typeof result?.effectiveSrc === 'string' && result.effectiveSrc !== ''
            ? result.effectiveSrc
            : (typeof result?.settings?.src === 'string' ? result.settings.src : '')
          setDraft(shown)
          setState({
            status: 'ready',
            media: (result && result.media) || { kind: 'none' },
            problem: (result && result.problem) || null,
            source: (result && result.source) || null,
          })
        })
        return () => {
          cancelled = true
        }
      }, [])

      /** @returns the server's answer, or a normalized failure. */
      const post = async (url, body) => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          if (!response.ok) return { ok: false, error: `http-${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error) }
        }
      }

      const choose = async () => {
        setBusy(true)
        setState((previous) => ({ ...previous, status: 'picking' }))
        const result = await post(PICK_URL)
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', problem: result.error === 'picker-unavailable' ? 'picker-unavailable' : 'load-failed' }))
          return
        }
        // An empty path means the user cancelled the dialog: leave the field alone.
        if (typeof result.path === 'string' && result.path.trim() !== '') {
          setDraft(result.path)
          setState((previous) => ({ ...previous, status: 'ready', problem: null }))
        } else {
          setState((previous) => ({ ...previous, status: 'ready' }))
        }
      }

      const save = async (value) => {
        setBusy(true)
        const result = await post(SAVE_URL, { src: value })
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', problem: 'load-failed' }))
          return
        }
        setDraft(value)
        setState({
          status: 'ready',
          media: result.media || { kind: 'none' },
          problem: result.problem ?? null,
          notice: value === '' ? t.cleared : t.saved,
        })
      }

      const problemText = state.problem === 'picker-unavailable'
        ? t.pickerUnavailable
        : (state.problem !== null && state.problem !== undefined ? (t.problem[state.problem] ?? null) : null)
      const media = state.media || { kind: 'none' }
      const active = media.kind !== 'none'

      const rows = []
      rows.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 14px', fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #5c6068)' },
      }, t.intro))

      rows.push(React.createElement('label', {
        key: 'field',
        style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #17181a)' },
      }, [
        React.createElement('span', { key: 'label' }, t.pathLabel),
        React.createElement('div', { key: 'row', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
          React.createElement('input', {
            key: 'input',
            type: 'text',
            value: draft,
            spellCheck: false,
            placeholder: t.pathPlaceholder,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void save(draft)
            },
            style: FIELD,
          }),
          button({ label: t.choose, onClick: choose, disabled: busy }),
        ]),
      ]))

      rows.push(React.createElement('div', {
        key: 'actions',
        style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' },
      }, [
        button({ key: 'save', label: t.save, onClick: () => void save(draft), disabled: busy, primary: true }),
        button({ key: 'clear', label: t.clear, onClick: () => void save(''), disabled: busy || draft === '' }),
      ]))

      if (state.status === 'picking') {
        rows.push(React.createElement('p', {
          key: 'picking',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
        }, t.picking))
      }

      if (state.notice !== undefined) {
        rows.push(React.createElement('p', {
          key: 'notice',
          role: 'status',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-success-primary, #22c55e)' },
        }, state.notice))
      }

      if (problemText !== null) {
        rows.push(React.createElement('p', {
          key: 'problem',
          role: 'alert',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
        }, problemText))
      }

      rows.push(React.createElement('div', {
        key: 'summary',
        style: {
          marginTop: '16px',
          padding: '12px 14px',
          border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)',
          borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-2, #f1f2f4)',
          fontSize: '13px',
          lineHeight: 1.7,
          color: 'var(--dsw-alias-label-secondary, #5c6068)',
        },
      }, [
        React.createElement('div', {
          key: 'title',
          style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary, #17181a)', marginBottom: '4px' },
        }, `${t.current}: ${active ? (state.source === 'bundled' ? t.bundled : t.willPlay) : t.none}`),
        state.source === 'bundled'
          ? React.createElement('div', { key: 'bundledHint', style: { marginBottom: '4px' } }, t.bundledHint)
          : null,
        active
          ? React.createElement('div', { key: 'file', style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' } },
              `${media.name ?? ''}${media.bytes === undefined ? '' : `  ·  ${humanBytes(media.bytes)}`}`)
          : null,
      ]))

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: '720px' } }, rows)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The settings page is always registered: it is how a video gets chosen
        // in the first place.
        ctx.slots.inject(TAB_SLOT, () => ctx.slots.register(
          { name: TAB_SLOT, id: ROW_ID, order: 50, label: () => strings().tab },
          SplashSettings,
        ))

        try {
          globalThis.__DSH_SPLASH__ = {
            probeFormats,
            fadeDelayFor,
            version: 3,
          }
        } catch { /* a frozen globalThis is not worth failing a boot over */ }

        // The splash itself is registered ONLY when a video is configured, and the
        // decision is made from a SYNCHRONOUS read.
        //
        // `ctx.slots.inject(..., run)` defers `run` until the slot exists, so the
        // registration below can land after the shell has already painted. Awaiting
        // the settings fetch first guaranteed that: the application interface got a
        // frame of visibility before the overlay appeared. Reading synchronously
        // keeps the whole decision inside this task, so the overlay is queued before
        // the first paint.
        //
        // With no video this plugin adds nothing to the frame and DSH boots exactly
        // as it would without the plugin installed.
        const initial = payloadSync()
        const initialMedia = (initial && initial.media) || { kind: 'none' }
        const initialProblem = (initial && initial.problem) || null
        if (initialMedia.kind !== 'none' && initialProblem === null) {
          ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register(
            { name: OVERLAY_SLOT, id: ROW_ID, order: 900 },
            SplashAnimation,
          ))
        } else {
          // Nothing will be mounted, so nothing will take the Host's cover off. The
          // cover is only injected when the Host believes media is playable, which
          // normally agrees with the read above — but the two halves read the same
          // file at different moments, and a disagreement here would leave the
          // application hidden with no splash to replace it. Releasing is idempotent
          // and harmless when no cover was injected at all.
          releaseCover()
        }
      },
    }
  },
})
