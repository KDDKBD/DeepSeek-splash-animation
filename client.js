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
 *   GET  /dsh-splash-animation/config.json?advance=1
 *                                           the same, moving a `cycle` / `random` pick on
 *   GET  /dsh-splash-animation/assets       the package's video listing
 *   POST /dsh-splash-animation/config       store the chosen path and playback mode
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

    /**
     * Page-global marker: this page has already played its splash.
     *
     * It is set the moment the splash starts leaving the screen, so a module reload
     * that happens afterwards (client HMR, plugin re-activation) does not replay the
     * opening animation over the interface the user is already using. The marker
     * lives on the page global because a module reload recreates this module's state;
     * only an actual page load clears it.
     */
    const PLAYED_KEY = '__DSH_SPLASH_PLAYED__'

    /** @returns whether this page has already played the splash. */
    function splashPlayed() {
      try {
        return globalThis[PLAYED_KEY] === true
      } catch {
        // A frozen globalThis keeps the pre-existing per-module behavior.
        return false
      }
    }

    /** Record that this page has played the splash. */
    function markSplashPlayed() {
      try {
        globalThis[PLAYED_KEY] = true
      } catch { /* a frozen globalThis is not worth failing a boot over */ }
    }

    const BASE = '/dsh-splash-animation'
    const CONFIG_URL = `${BASE}/config.json`
    /**
     * The boot read, which is the only request that moves a `cycle` / `random` pick on.
     *
     * `payloadSync` below is called once per page load, from `apply`, so the flag lives
     * here rather than on every read of the settings: the overlay's own fetch and the
     * settings page must see the file this load already chose.
     */
    const BOOT_URL = `${CONFIG_URL}?advance=1`
    const ASSETS_URL = `${BASE}/assets`
    const SAVE_URL = `${BASE}/config`
    const PICK_URL = `${BASE}/pick`
    const OVERLAY_SLOT = 'shell.overlay'
    const TAB_SLOT = 'settings.plugins.tab'
    const ROW_ID = 'dsh-splash-animation'

    /**
     * Prefix the Host stores a listed file under.
     *
     * The settings page writes and reads the same string, so the file list and the path
     * field describe the same choice.
     */
    const ASSET_PREFIX = 'asset:'

    /** The name the package ships as its default video. */
    const BUILTIN_NAME = 'default.mp4'

    /** Playback modes in display order, with the dictionary key of each label. */
    const MODE_ORDER = ['fixed', 'cycle', 'random', 'off']
    const MODE_LABELS = { fixed: 'modeFixed', cycle: 'modeCycle', random: 'modeRandom', off: 'modeOff' }

    /** UI strings; the splash is the first thing a user sees, so it follows the OS language. */
    const TEXT = {
      zh: {
        tab: '开屏动画',
        title: '开屏动画',
        intro: '选一个视频作为开屏：固定播一个、按顺序换着播、每次随机挑一个，或者选「关闭」完全不播。播完照常进入界面。',
        modeLabel: '播放方式',
        modeFixed: '固定',
        modeCycle: '循环',
        modeRandom: '随机',
        modeOff: '关闭',
        modeHint: {
          fixed: '每次打开都播放下面列表里选中的那个。',
          cycle: '每次打开按列表顺序换下一个，播完照常进入界面。列表里选中的那个只在「固定」里用。',
          random: '每次打开从列表里随机挑一个，播完照常进入界面。列表里选中的那个只在「固定」里用。',
          off: '不播开屏动画，直接进入界面（公共场合、投屏时用）。视频列表和自定义路径都保留，随时切回上面三种即可恢复。',
        },
        libraryLabel: '视频目录',
        libraryLoading: '正在读取视频列表…',
        libraryFailed: '读不到视频列表。如果刚更新过插件，重启 DSH 后生效。',
        libraryEmpty: '这个目录里还没有视频。把 mp4 / webm 放进去，再点「刷新」。',
        libraryHint: '点一行就把它选为「固定」的播放对象。只列视频，动图仍可填路径使用。',
        refresh: '刷新',
        builtin: '内置',
        playingNow: '本次播放',
        unsaved: '有未保存的改动。',
        pathLabel: '自定义路径',
        pathPlaceholder: '例如 D:\\videos\\opening.mp4，或 ~/videos/opening.webm',
        pathHint: '列表里选中的文件按 asset:文件名 记录，插件换位置也不会失效；不填就用插件自带的视频。',
        choose: '选择文件…',
        save: '保存',
        clear: '清除',
        saved: '已保存。下次打开或刷新 DSH 时生效。',
        cleared: '已清除。插件不再介入，DSH 恢复默认启动。',
        picking: '等待文件选择…',
        pickerUnavailable: '这个宿主没有可用的文件对话框，请直接把路径填进上面的输入框。',
        current: '当前生效',
        modeSummary: '播放方式',
        modeActive: {
          cycle: '循环播放 · 每次打开换下一个',
          random: '随机播放 · 每次打开随机挑一个',
          off: '已关闭 · 不播开屏动画（视频列表与路径保留）',
        },
        none: '未设置 —— 插件不介入',
        willPlay: '下次启动播放',
        bundled: '正在使用内置视频',
        bundledHint: '这是插件自带的视频。换一个就在列表里点一行，想彻底关掉就点「清除」。',
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
        intro: 'Pick a video for the splash: always the same one, the next one in turn, a random one, or “Off” for no splash at all. Playback ends as usual and reveals the interface.',
        modeLabel: 'Playback mode',
        modeFixed: 'Fixed',
        modeCycle: 'In turn',
        modeRandom: 'Random',
        modeOff: 'Off',
        modeHint: {
          fixed: 'Every launch plays the file selected in the list below.',
          cycle: 'Every launch plays the next file in the list order, then reveals the interface. The selected file is used by “Fixed” only.',
          random: 'Every launch plays a random file from the list, then reveals the interface. The selected file is used by “Fixed” only.',
          off: 'No splash: the interface appears immediately (for a shared screen or a meeting). The video list and custom path are kept, so switching back to any of the three modes above restores playback.',
        },
        libraryLabel: 'Video directory',
        libraryLoading: 'Reading the video list…',
        libraryFailed: 'The video list could not be read. If the plugin was just updated, restart DSH for it to take effect.',
        libraryEmpty: 'No videos in this directory yet. Drop an mp4 or webm in, then press “Refresh”.',
        libraryHint: 'Click a row to make it the “Fixed” choice. Videos only; an animated image can still be used by path.',
        refresh: 'Refresh',
        builtin: 'bundled',
        playingNow: 'playing now',
        unsaved: 'There are unsaved changes.',
        pathLabel: 'Custom path',
        pathPlaceholder: 'e.g. D:\\videos\\opening.mp4, or ~/videos/opening.webm',
        pathHint: 'A file picked from the list is stored as asset:<name>, which survives the plugin moving; leave it empty to use the bundled video.',
        choose: 'Choose file…',
        save: 'Save',
        clear: 'Clear',
        saved: 'Saved. It takes effect the next time DSH opens or the page reloads.',
        cleared: 'Cleared. The plugin no longer engages and DSH boots as usual.',
        picking: 'Waiting for the file dialog…',
        pickerUnavailable: 'This host has no file dialog available; paste the path into the field above instead.',
        current: 'Currently active',
        modeSummary: 'Playback mode',
        modeActive: {
          cycle: 'In turn · a different file each launch',
          random: 'Random · a random file each launch',
          off: 'Off · no splash plays (video list and path kept)',
        },
        none: 'Not set — the plugin stays out of the way',
        willPlay: 'Plays on next launch',
        bundled: 'Using the bundled video',
        bundledHint: 'This is the video shipped with the plugin. Click a row in the list to change it, or turn the splash off entirely with “Clear”.',
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
     *
     * This is the boot read, so it carries the advance flag. It is the only request that
     * moves a `cycle` / `random` pick on, which is what makes "the next video" mean the
     * next page load rather than the next request.
     * @returns the parsed payload, or a `no media` payload.
     */
    function payloadSync() {
      try {
        const request = new XMLHttpRequest()
        request.open('GET', BOOT_URL, false)
        request.send(null)
        if (request.status !== 200) return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
        return JSON.parse(request.responseText)
      } catch {
        return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
      }
    }

    /** Defaults mirroring the Host schema, used when a field is absent from the wire. */
    const FALLBACK = {
      // Which file plays; `fixed` is the Host's own default and the pre-modes behaviour.
      mode: 'fixed',
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
        // The page has shown its splash now; a later module reload must not replay
        // it over the interface the user is already using. See `PLAYED_KEY`.
        markSplashPlayed()
        setPhase('out')
      }, [])

      /**
       * Release the video's decoder and compositor surface before the element
       * leaves the document.
       *
       * Removing a full-screen `<video>` straight out of playback makes Chromium
       * tear the media player down after the removal. With a hardware video
       * overlay (DirectComposition on Windows) the overlay plane can outlive the
       * element and reappear over the page as a full-screen flicker of the last
       * frame while the interface sits idle; refreshing the page is the only way
       * out, because nothing in the document owns the leftover plane. Pausing and
       * clearing the source first hands the teardown to the media element while
       * it is still attached, and the frames the fade effect waits for below let
       * the compositor drop the overlay before the overlay node is unmounted.
       */
      const releaseMedia = React.useCallback(() => {
        const element = videoRef.current
        if (element === null || element === undefined) return
        try {
          element.pause()
        } catch { /* an already torn-down element is released already */ }
        try {
          // Clearing the source destroys the media resource (and with it the
          // overlay plane) instead of leaving it to the element's removal.
          element.removeAttribute('src')
          element.load()
        } catch { /* same */ }
      }, [])

      /**
       * While the splash owns the screen it also owns input.
       *
       * The overlay covers the viewport, so every pointer event the user can produce
       * is aimed at it. That is not enough on its own: another plugin can claim a
       * click by POSITION rather than by target. The wallet widget installs a
       * document-level capture listener that hit-tests the pointer against its own
       * artwork and, on a hit, calls `stopPropagation()` — and its exemption list
       * names only its own `.dshwv-*` elements, so it cannot know about anybody
       * else's overlay.
       *
       * Measured on a live page, clicking this control:
       *
       *   stopPropagation() on pointerdown target=BUTTON  << onDocPointerDown
       *   stopPropagation() on pointerup   target=BUTTON  << onDocPointerUp
       *   stopPropagation() on click       target=BUTTON  << onDocClickStopper
       *
       * The splash never dismissed, and the widget played its own press sound. A
       * capture listener on `window` runs before any listener on `document`, so
       * handling the event here — and stopping it — keeps the splash's own control
       * working and keeps the other plugin's handlers out of the interaction
       * entirely, sound included.
       *
       * `stopPropagation` rather than `preventDefault`: suppressing the browser's own
       * handling of a click inside a full-screen overlay buys nothing and risks
       * breaking focus, while stopping the bubble is exactly the intent.
       *
       * The listeners MUST come off when the splash is finished, and that is not the
       * same moment as unmounting. The console's registry keeps this entry for the
       * life of the page: `phase === 'done'` makes the component render `null`, but
       * the component stays MOUNTED, so a cleanup that only runs on unmount never
       * runs at all. An earlier version of this effect did exactly that, and while
       * those two listeners stayed installed nothing on the page could be clicked —
       * every event was stopped at `window` before reaching anything.
       *
       * So the effect is gated on whether the splash still owns the screen, and that
       * gate is in the dependency list. Being wrong here is not a cosmetic bug: it
       * costs the user the whole interface.
       */
      const capturingInput = session.phase !== 'done'
      React.useEffect(() => {
        if (!capturingInput) return undefined
        // Read from `session`, not from the render-scoped `settings`, because hooks
        // must run on every render — including the first, where the payload has not
        // arrived and this is still the one-frame cover.
        const skipMode = (session.settings && session.settings.skip) || 'button'
        const onPointer = (event) => {
          event.stopPropagation()
        }
        const onClick = (event) => {
          event.stopPropagation()
          const target = event.target
          const onSkip = target !== null && target !== undefined
            && typeof target.closest === 'function'
            && target.closest('[data-dsh-splash-skip]') !== null
          if (onSkip || skipMode === 'click') dismiss()
        }
        window.addEventListener('pointerdown', onPointer, true)
        window.addEventListener('click', onClick, true)
        return () => {
          window.removeEventListener('pointerdown', onPointer, true)
          window.removeEventListener('click', onClick, true)
        }
      }, [capturingInput, session.settings, dismiss])

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
            // A disposal that skips the fade (HMR, plugin disable) must not leave
            // the media playing behind a node the document no longer shows.
            try {
              element.pause()
            } catch { /* already torn down */ }
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
        let done = false
        let frame = 0
        let guard = 0
        const finish = () => {
          if (done) return
          done = true
          setSession({ phase: 'done' })
        }
        const id = window.setTimeout(() => {
          releaseMedia()
          // Two frames: the first is composited with the media resource already
          // gone, the second unmounts after that frame reached the screen. A
          // hidden tab runs no rAF at all, so the guard keeps the dismissal on
          // time instead of leaving a transparent overlay capturing input.
          frame = window.requestAnimationFrame(() => {
            frame = window.requestAnimationFrame(finish)
          })
          guard = window.setTimeout(finish, 1000)
        }, fade)
        return () => {
          window.clearTimeout(id)
          window.clearTimeout(guard)
          if (frame !== 0) window.cancelAnimationFrame(frame)
        }
      }, [phase, session.settings, releaseMedia])

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
            // Keep the frame out of Chromium's DirectComposition hardware
            // video-overlay path. An opacity just below 1 makes the quad require
            // blending, which that path rejects; the blend is 0.1% of the frame
            // over this overlay's own background, i.e. invisible. The overlay
            // plane is the layer that can outlive a removed element on Windows
            // and flicker over the page while the interface sits idle.
            opacity: 0.999,
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
          // The marker is what the window-level capture listener looks for; it cannot
          // rely on this element's own React handler, because a click here is claimed
          // by another plugin before it can reach the button. See the effect above.
          'data-dsh-splash-skip': '',
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
     * @param options - label text, click handler, emphasis, selection and list key.
     * @returns a themed button element.
     */
    function button(options) {
      return React.createElement('button', {
        // Extracted by `createElement` rather than rendered: a caller that builds a row of
        // buttons needs the key to reach the element, not the DOM.
        key: options.key,
        type: 'button',
        onClick: options.onClick,
        disabled: options.disabled === true,
        'aria-pressed': options.active === undefined ? undefined : options.active,
        style: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: 1.5,
          borderRadius: '8px',
          padding: '5px 14px',
          cursor: options.disabled === true ? 'default' : 'pointer',
          opacity: options.disabled === true ? 0.4 : 1,
          border: options.primary === true || options.active === true
            ? '1px solid transparent'
            : '1px solid var(--dsw-alias-border-l2, #d3d5da)',
          background: options.primary === true || options.active === true
            ? 'var(--dsw-alias-label-primary, #17181a)'
            : 'transparent',
          color: options.primary === true || options.active === true
            ? 'var(--dsw-alias-bg-layer-3, #ffffff)'
            : 'var(--dsw-alias-label-secondary, #5c6068)',
        },
      }, options.label)
    }

    /**
     * The settings page: choose the video the splash plays and how it is chosen.
     *
     * A browser can neither read a local file path nor list a directory, so both come
     * from the Host: "choose" opens the native dialog, and the file list is the Host's
     * listing of the package's own media directory. The text field is not a fallback for
     * a broken path — it is the only route on a host with no dialog at all (a headless
     * server, a browser on another machine), so it is always present.
     * @returns the settings page element.
     */
    function SplashSettings() {
      const t = strings()
      const [draft, setDraft] = React.useState('')
      const [mode, setMode] = React.useState(FALLBACK.mode)
      /**
       * What the Host last confirmed, so the page can tell a draft from a saved value.
       *
       * `null` until the first answer arrives. Comparing against it is what keeps an
       * untouched path field from being saved back as an explicit choice, which would turn
       * "use the bundled video" into a path baked into the state file.
       */
      const [baseline, setBaseline] = React.useState(null)
      const [library, setLibrary] = React.useState({ status: 'loading', dir: '', items: [] })
      const [state, setState] = React.useState({ status: 'loading' })
      const [busy, setBusy] = React.useState(false)

      /**
       * Read the Host's listing of the package's media directory.
       *
       * Kept callable so the refresh control can re-run it: videos are dropped into that
       * directory while DSH runs, and the page picks them up without a reload. A failure
       * is a state of the page rather than an exception — the path field still works with
       * no listing at all.
       */
      const loadLibrary = React.useCallback(async () => {
        try {
          const response = await fetch(ASSETS_URL, { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) throw new Error(`http-${response.status}`)
          const body = await response.json()
          setLibrary({
            status: 'ready',
            dir: typeof body.dir === 'string' ? body.dir : '',
            items: Array.isArray(body.items) ? body.items : [],
          })
        } catch {
          setLibrary({ status: 'failed', dir: '', items: [] })
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        payload().then((result) => {
          if (cancelled) return
          // `effectiveSrc` is the configured choice, which for a never-configured install
          // is the bundled video the Host resolved. Showing an empty field while that
          // video plays would contradict the page's own status line, so the field follows
          // the Host's answer.
          const shown = typeof result?.effectiveSrc === 'string' && result.effectiveSrc !== ''
            ? result.effectiveSrc
            : (typeof result?.settings?.src === 'string' ? result.settings.src : '')
          const shownMode = typeof result?.settings?.mode === 'string' ? result.settings.mode : FALLBACK.mode
          setDraft(shown)
          setMode(shownMode)
          setBaseline({ src: shown, mode: shownMode })
          setState({
            status: 'ready',
            media: (result && result.media) || { kind: 'none' },
            problem: (result && result.problem) || null,
            source: (result && result.source) || null,
          })
        })
        void loadLibrary()
        return () => {
          cancelled = true
        }
      }, [loadLibrary])

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

      /**
       * Store a change and adopt the Host's answer as the new baseline.
       *
       * The response is the payload the config route serves, so the summary and the status
       * line report what the Host stored rather than what the page hoped it sent.
       * @param body - the fields to store: `src`, `mode`, or both.
       * @param notice - the line to show once it is stored.
       */
      const save = async (body, notice) => {
        setBusy(true)
        const result = await post(SAVE_URL, body)
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', problem: 'load-failed' }))
          return
        }
        const savedSrc = typeof result.effectiveSrc === 'string' ? result.effectiveSrc : ''
        const savedMode = typeof result.settings?.mode === 'string' ? result.settings.mode : FALLBACK.mode
        setDraft(savedSrc)
        setMode(savedMode)
        setBaseline({ src: savedSrc, mode: savedMode })
        setState({
          status: 'ready',
          media: result.media || { kind: 'none' },
          problem: result.problem ?? null,
          source: result.source ?? null,
          notice,
        })
      }

      const problemText = state.problem === 'picker-unavailable'
        ? t.pickerUnavailable
        : (state.problem !== null && state.problem !== undefined ? (t.problem[state.problem] ?? null) : null)
      const media = state.media || { kind: 'none' }
      const active = media.kind !== 'none'
      // The file playing now, when a mode rather than the path chose it. Marking it in the
      // list is what shows which entry a rotation is on.
      const rotating = state.source === 'cycle' || state.source === 'random'
      const playingName = active && rotating && typeof media.name === 'string' ? media.name : null
      const selectedName = draft.startsWith(ASSET_PREFIX) ? draft.slice(ASSET_PREFIX.length) : null
      const srcChanged = baseline !== null && draft !== baseline.src
      const unsaved = baseline !== null && (srcChanged || mode !== baseline.mode)
      /**
       * Store the page's draft.
       *
       * The path travels only when it differs from the Host's own answer: a mode change on
       * a never-configured install must not turn the pre-filled bundled path into an
       * explicit choice, which would stop the built-in video from being the default.
       */
      const saveDraft = () => save(srcChanged ? { src: draft, mode } : { mode }, t.saved)
      const labelStyle = { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #17181a)' }
      const hintStyle = { margin: '6px 0 0', fontSize: '12.5px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #5c6068)' }
      const tagStyle = {
        padding: '1px 7px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-2, #f1f2f4)',
        color: 'var(--dsw-alias-label-secondary, #5c6068)',
        fontSize: '11.5px',
        whiteSpace: 'nowrap',
      }
      /**
       * What "currently active" says.
       *
       * A file a mode chose is reported as that mode: "plays on next launch" would be
       * wrong for it, since the file named beside it is only this launch's pick.
       */
      const statusText = state.source === 'off'
        ? t.modeActive.off
        : !active
          ? t.none
          : state.source === 'cycle'
            ? t.modeActive.cycle
            : state.source === 'random'
              ? t.modeActive.random
              : state.source === 'bundled' ? t.bundled : t.willPlay

      const rows = []
      rows.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 14px', fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #5c6068)' },
      }, t.intro))

      rows.push(React.createElement('div', { key: 'mode' }, [
        React.createElement('div', { key: 'label', style: labelStyle }, t.modeLabel),
        React.createElement('div', { key: 'row', style: { display: 'flex', gap: '8px', marginTop: '6px' } }, MODE_ORDER.map((value) => button({
          key: value,
          label: t[MODE_LABELS[value]],
          active: mode === value,
          disabled: busy,
          onClick: () => setMode(value),
        }))),
        React.createElement('p', { key: 'hint', style: hintStyle }, t.modeHint[mode] ?? t.modeHint.fixed),
      ]))

      // The listing is the one thing the page cannot learn by itself: the browser has no
      // access to the package directory, so every row here came from the Host.
      const libraryRows = []
      if (library.status === 'loading') {
        libraryRows.push(React.createElement('p', { key: 'loading', style: hintStyle }, t.libraryLoading))
      } else if (library.status === 'failed') {
        libraryRows.push(React.createElement('p', {
          key: 'failed',
          role: 'alert',
          style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
        }, t.libraryFailed))
      } else if (library.items.length === 0) {
        libraryRows.push(React.createElement('p', { key: 'empty', style: hintStyle }, t.libraryEmpty))
      } else {
        for (const [index, item] of library.items.entries()) {
          const selected = selectedName === item.name
          libraryRows.push(React.createElement('button', {
            key: item.name,
            type: 'button',
            disabled: busy,
            onClick: () => setDraft(item.reference),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              width: '100%',
              padding: '7px 10px',
              textAlign: 'left',
              font: 'inherit',
              fontSize: '12.5px',
              borderRadius: '8px',
              cursor: 'pointer',
              border: `1px solid ${selected ? 'var(--dsw-alias-border-l2, #d3d5da)' : 'transparent'}`,
              background: selected ? 'var(--dsw-alias-bg-layer-3, #ffffff)' : 'transparent',
              color: 'var(--dsw-alias-label-primary, #17181a)',
            },
          }, [
            React.createElement('span', { key: 'mark', style: { color: 'var(--dsw-alias-label-primary, #17181a)' } }, selected ? '●' : '○'),
            // Numbered only where the order decides playback, so the numbering is the
            // rotation the user is about to get rather than decoration.
            mode === 'cycle'
              ? React.createElement('span', {
                  key: 'order',
                  'data-dsh-splash-order': String(index + 1),
                  style: { minWidth: '18px', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary, #8a8f98)', fontVariantNumeric: 'tabular-nums' },
                }, String(index + 1))
              : null,
            React.createElement('span', {
              key: 'name',
              style: { flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' },
            }, item.name),
            playingName === item.name
              ? React.createElement('span', { key: 'now', 'data-dsh-splash-now': '', style: tagStyle }, t.playingNow)
              : null,
            item.name === BUILTIN_NAME
              ? React.createElement('span', { key: 'builtin', 'data-dsh-splash-builtin': '', style: tagStyle }, t.builtin)
              : null,
            React.createElement('span', {
              key: 'size',
              style: { color: 'var(--dsw-alias-label-secondary, #5c6068)', fontVariantNumeric: 'tabular-nums' },
            }, humanBytes(item.bytes)),
          ]))
        }
      }

      rows.push(React.createElement('div', { key: 'library', style: { marginTop: '18px' } }, [
        React.createElement('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: '8px' } }, [
          React.createElement('span', { key: 'label', style: labelStyle }, t.libraryLabel),
          React.createElement('span', {
            key: 'count',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, library.status === 'ready' ? String(library.items.length) : ''),
          React.createElement('button', {
            key: 'refresh',
            type: 'button',
            disabled: busy,
            onClick: () => { void loadLibrary() },
            style: {
              marginLeft: 'auto',
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, #5c6068)',
              font: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
              textDecoration: 'underline',
            },
          }, t.refresh),
        ]),
        library.dir === ''
          ? null
          : React.createElement('div', {
              key: 'dir',
              style: {
                marginTop: '2px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '11.5px',
                color: 'var(--dsw-alias-label-secondary, #5c6068)',
                wordBreak: 'break-all',
              },
            }, library.dir),
        React.createElement('div', {
          key: 'list',
          style: {
            marginTop: '8px',
            padding: '4px',
            border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)',
            borderRadius: '10px',
            maxHeight: '280px',
            overflowY: 'auto',
          },
        }, libraryRows),
        React.createElement('p', { key: 'hint', style: hintStyle }, t.libraryHint),
      ]))

      rows.push(React.createElement('label', {
        key: 'field',
        style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '18px', fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #17181a)' },
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
              if (event.key === 'Enter') void saveDraft()
            },
            style: FIELD,
          }),
          button({ key: 'choose', label: t.choose, onClick: choose, disabled: busy }),
        ]),
        React.createElement('span', {
          key: 'hint',
          style: { fontSize: '12.5px', fontWeight: 400, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #5c6068)' },
        }, t.pathHint),
      ]))

      rows.push(React.createElement('div', {
        key: 'actions',
        style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' },
      }, [
        button({ key: 'save', label: t.save, onClick: () => void saveDraft(), disabled: busy, primary: true }),
        button({ key: 'clear', label: t.clear, onClick: () => void save({ src: '' }, t.cleared), disabled: busy || draft === '' }),
        unsaved
          ? React.createElement('span', {
              key: 'unsaved',
              style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
            }, t.unsaved)
          : null,
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
        }, `${t.current}: ${statusText}`),
        React.createElement('div', {
          key: 'mode',
          style: { marginBottom: '4px' },
        }, `${t.modeSummary}: ${t[MODE_LABELS[mode] ?? MODE_LABELS.fixed]}`),
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
            version: 4,
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
        //
        // The page-global marker, set when the splash dismisses, keeps a later module
        // reload (client HMR, plugin re-activation) from replaying the opening
        // animation over an interface the user is already using. Only a real page
        // load shows the splash again.
        const initial = payloadSync()
        const initialMedia = (initial && initial.media) || { kind: 'none' }
        const initialProblem = (initial && initial.problem) || null
        if (initialMedia.kind !== 'none' && initialProblem === null && !splashPlayed()) {
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
          // and harmless when no cover was injected at all. This also runs on a
          // re-activation that skips the replay.
          releaseCover()
        }
      },
    }
  },
})
