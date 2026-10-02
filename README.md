# dsh-splash-animation

A **custom opening animation** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it plays a video while DSH starts, then dissolves over 0.3 seconds to reveal the interface.

A default video ships with the plugin, so it **works as soon as you install it**. You can swap in your own from Settings.

![The splash playing full-frame, with the skip control at the bottom right](assets/screenshot-splash.png)

## Install

```bash
dsh plugin --profile web add github:KDDKBD/DeepSeek-splash-animation
```

Restart DSH afterwards. `--profile web` is the profile DSH Desktop uses.

To pin a version:

```bash
dsh plugin --profile web add github:KDDKBD/DeepSeek-splash-animation#v0.4.0
```

You can also install from the UI: sidebar → **Plugins** → install bundle, with the address above.

Uninstall:

```bash
dsh plugin --profile web remove dsh-splash-animation
```

> This plugin is **not published to npm**, so `add dsh-splash-animation` fails. Use the GitHub address above.
> The GitHub route requires `git` to be installed.

## Usage

After installing and restarting, the splash plays the bundled video.

To use your own: open **Settings → Plugins → Splash animation**, click **Choose file…** and pick a video, then **Save**. You can also paste a path into the field.

To turn it off completely: click **Clear** on the same page.

## Behaviour

| State | What happens |
|---|---|
| Never configured | Plays the bundled video |
| A path is set | Plays that video. An invalid path plays **nothing** (it does not fall back to the bundled video) and the settings page says why |
| Cleared | Plays **nothing**; DSH starts exactly as if the plugin were not installed |

The video holds on its last frame, then fades out. The fade is 0.3 seconds by default.

## Configuration

Override any field in the profile's `cordis.patch.yml` (on Windows usually `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`):

```yaml
- id: dsh-splash-animation
  config:
    fit: cover        # fill the frame, cropping the excess
    muted: false      # with audio
    fadeOutMs: 600    # dissolve over 0.6 s
    skip: click       # click anywhere to skip
```

| Field | Default | Meaning |
|---|---|---|
| `src` | empty | Video path. Empty uses the bundled video; clearing it disables playback |
| `fadeOutMs` | `300` | How long the dissolve takes once the video has played out |
| `fadeInMs` | `320` | Fade-in duration when it appears |
| `skip` | `button` | `button` (corner) / `click` (anywhere) / `auto` (on a timer) / `never` |
| `skipAfterMs` | `1200` | With `skip: auto` only |
| `muted` | `true` | Muted by default, because Chromium blocks unmuted autoplay |
| `volume` | `0.6` | Volume, 0–1 |
| `fit` | `contain` | `contain` (letterboxed) / `cover` (filled, cropped) / `fill` (stretched) |
| `background` | `#000000` | Backdrop colour |
| `playbackRate` | `1` | Playback speed, 0.1–4 |
| `duration` | `0` | Maximum playback in ms; `0` plays to the end |
| `maxReplays` | `0` | Replays after the first play |
| `holdAfterEndMs` | `0` | Pause between the last frame and the dissolve |
| `waitForAppMs` | `2500` | Animated images only: they have no end event, so they exit on a timer |

An invalid value falls back to its default rather than failing startup.

## Supported formats

Video, rendered as `<video>`: `mp4`, `m4v`, `webm`, `mov`, `mkv`, `ogv`, `ogm`, `mpg`, `mpeg`, `ts`

Animated and still images, rendered as `<img>`: `gif`, `apng`, `webp`, `avif`, `png`, `jpg`, `jpeg`, `svg`, `bmp`, `ico`

**`webm` (VP9) and `mp4` (H.264) are the safe choices** — both play everywhere.

`mov` and `mkv` are only containers, so whether one plays depends on the codec inside; ProRes or DNxHD will not decode. To transcode:

```bash
ffmpeg -i input.mov -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an opening.mp4
ffmpeg -i input.mov -c:v libvpx-vp9 -crf 32 -b:v 0 -an opening.webm
```

`-movflags +faststart` moves the index to the front of the file, so playback can start before the whole file has downloaded.

## Troubleshooting

**A video is selected but nothing plays**
Check that the settings page says it will play, and that `src` in `%APPDATA%\dsh-desktop\harness\dsh-splash-animation\config.json` is the path you expect. After changing settings, reload the page — no restart needed.

**Picture but no sound**
Chromium only allows audio before user interaction if the media is muted, and a splash runs before any interaction. The plugin retries muted automatically, so you get the picture without sound.

**The DSH whale still appears at startup**
That is the Electron main window loading its own startup screen before the harness starts; a plugin cannot replace it. This plugin covers the part after it.

**Choose file… seems to do nothing**
The dialog opens on the machine running DSH. If you are driving the UI from another machine you will not see it — paste the path instead.

## License

MIT, covering the plugin code.

`assets/default.mp4` is example artwork and is not covered by that licence. If you redistribute or fork this, confirm the rights for any media you ship; replacing that file is all it takes to use your own.
