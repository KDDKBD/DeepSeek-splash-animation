# dsh-splash-animation

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一段**自定义开屏动画**：启动时播放你指定的视频，播完后 0.3 秒渐隐，露出 DSH 界面。

插件自带一段默认视频，**装上就能用**；设置页会列出插件 `assets/` 目录里的视频，可以设成**固定**播一个、**循环**按顺序换着播、**随机**每次挑一个，或者**关闭**——完全不播（开会、投屏、公共场合用），视频列表和路径都会保留，切回上面三种即刻恢复。

![开屏动画：视频铺满画面，右下角是跳过按钮](assets/screenshot-splash.png)

## 推荐安装法

**因为这插件是大肥鱼写的，我也不懂。所以我只推荐直接告诉大肥鱼让她自己安装，以下是提示词**

```
帮我安装插件 https://github.com/KDDKBD/DeepSeek-splash-animation
安装 spec 用 github:KDDKBD/DeepSeek-splash-animation（pnpm 的 git 形式）。

优先用 plugin_manager 工具：action=install_bundle，target 填上面的 spec。

如果你的工具列表里没有 plugin_manager（源码版 dsh web 的默认 profile 就没挂这个包），
就手动装，别猜路径：
1. profile 目录是 <home>/profiles/<profile 名>，<home> 取 resolveDshHome() 的结果
   （默认 $DSH_HOME，未设置时为 ~/.dsh）；如果那个目录不存在，先把实际位置告诉我，
   不要自己编一个；
2. 在该目录的 package.json 里加依赖 "dsh-splash-animation":
   "github:KDDKBD/DeepSeek-splash-animation"，并把 "dsh-splash-animation"
   加进 dsh.profile.bundles；
3. 在该目录里用 DSH 自带的 pnpm 执行 install；
4. 装完告诉我需要重启 DSH，以及设置页在哪儿。
```

**注意 `plugin_manager` 不是哪儿都有。** 它来自 `@deepseek-ai/dsh-plugin-manager` 包，
而 `web` profile 的默认模板只有 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`——
所以从源码跑的 `dsh web` 里通常没有这个工具，DSH 会照着上面第 2 段手动装（那部分是准的，
不依赖任何工具是否存在）。DSH 桌面版内置了这个包，所以桌面版走第一条就行。

## 普通安装法

**如果上面那条走不通**，用命令行（`dsh` **不随 DSH Desktop 附带**，要先从 npm 装）：

```bash
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add github:KDDKBD/DeepSeek-splash-animation
```

**都不行就手动改配置文件**：先找到 profile 目录，默认在 `<home>/profiles/<profile 名>`
（`<home>` 是 `$DSH_HOME`，未设置时为 `~/.dsh`）。DSH 桌面版的实际位置是
`%APPDATA%\dsh-desktop\harness\profiles\web`。然后编辑该目录的 `package.json`，
把依赖加进 `dependencies`、把 `dsh-splash-animation` 加进 `dsh.profile.bundles`，
并在该目录下执行 `pnpm install`（没有全局 pnpm 就用桌面版自带的
`%APPDATA%\dsh-desktop\harness\.desktop-bin\pnpm.cmd`）。

以上方式装完都**重启 DSH** 生效。`--profile web` 只用于命令行；DSH 桌面版虽然内部也是 `web`
profile，但它自己决定，不需要你指定。

卸载：在 **设置 → 插件** 里停用或卸载，或者

```bash
dsh plugin --profile web remove dsh-splash-animation
```

> 界面里的插件市场只收录社区精选列表里的插件。如果那里搜不到本插件，用上面的方式安装即可。
> 通过 GitHub 安装需要本机装有 `git`。

## 使用

装好重启后就有开屏动画，播放的是插件自带的视频。

要换成自己的：打开 **设置 → 插件 → 开屏动画**，页面中间会列出**这个插件的 `assets/` 目录**里的所有视频（目录绝对路径就印在列表上方）。
把 mp4 / webm 丢进那个目录，点「刷新」就能看到；点一行把它选上，再点「保存」。

要暂时不播（开会、投屏）：把播放方式切成**关闭**再保存。列表和路径都留着，切回任意一种就恢复，不用重新选文件。

要彻底关掉：在同一个页面点「清除」。清除之后**任何播放方式都不再播放**，DSH 与没装插件时一致。

> 两者的区别：**关闭**是一键静音、随时切回；**清除**会丢掉已选的路径和列表选择，当作"从未配置"。

> 列表只列**视频**。`gif`、`webp` 这类动图/图片不列出来（目录里还放着插件自己的说明截图），要用心就把完整路径填进下面的「自定义路径」。

### 四种播放方式

在设置页顶部选，选完点「保存」：

| 方式 | 每次打开 DSH 时 |
|---|---|
| **固定** | 播放列表里选中的那个（没选就是插件自带的视频） |
| **循环** | 按**列表顺序**播下一个：这次 `1.mp4`，下次 `2.mp4`，到末尾回到开头 |
| **随机** | 从列表里随机挑一个，且尽量不连着两次播同一个 |
| **关闭** | 什么都不播，直接进入界面。列表、路径全部保留，切回上面三种即刻恢复 |

前三种的**播放逻辑完全一样**：播一遍 → 结尾渐隐 → 进入会话界面。方式只决定「播哪一个」，不改变怎么播；「关闭」只是不播，它的优先级最高——即使已经配好了路径或列表里有视频，也不会播。

「循环」的游标记在 `%APPDATA%\dsh-desktop\harness\dsh-splash-animation\config.json` 的 `pick` 字段里，所以**每次打开页面都会换下一个**；切换播放方式时游标归零，下次从列表第一个开始，不会跳过一个。

### 视频放哪儿

列表就读插件包自己的 `assets/` 目录：

```
<本插件目录>\assets\      ← 把视频放这里
```

设置页列表上方会印出真实路径，以那个为准。从列表里选中的文件按 `asset:文件名` 记录，将来插件换目录也不会失效。

## 行为

| 状态 | 表现 |
|---|---|
| 选了「关闭」 | **不播放**，直接进入界面；路径与列表都留着，优先级高于下面所有规则 |
| 没设置过 | 播放插件自带的视频 |
| 设置了路径 | 播放该视频。路径无效则**不播放**（不会回退到自带视频），原因显示在设置页 |
| 选了循环 / 随机 | 从 `assets/` 的视频里挑一个。目录里没有视频时退回上面两条规则 |
| 点过「清除」 | **不播放**，DSH 与未安装插件时一致；优先级高于播放方式 |

视频播完会停在最后一帧，然后渐隐消失。默认渐隐 0.3 秒。

### 启动过程

```
原生启动窗 → 黑屏（本插件已接管）→ 播放视频 → 渐隐 → 界面
```

插件来不及显示画面的那一两秒里，屏幕是**黑的**而不是先露出界面：插件在页面第一帧就把应用内容盖住，等自己的画面挂上才放开。所以启动时看不到"界面闪一下再出现动画"。

**开屏期间画面拥有输入。** 那段黑屏和视频是覆盖在整个界面上的，点击不会穿透到下面的应用；跳过之后立即恢复。

**同一页面里不会重播。** 插件被热重载（HMR）或重新启用时不会再把开屏盖到正在用的界面上；只有真正刷新页面（新的页面加载）才会再播。

### 退出方式

默认右下角有一个「跳过」按钮，按 `Esc`、空格或回车也可以提前退出。想改成点任意位置跳过、固定时长自动退出、或干脆不让退出，见下面的 `skip`。

## 配置

在 profile 的 `cordis.patch.yml` 里写覆盖项即可调整细节（Windows 上通常是 `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`）：

```yaml
- id: dsh-splash-animation
  config:
    fit: contain      # 完整显示（默认是 cover 铺满裁切）
    muted: false      # 带声音
    fadeOutMs: 600    # 渐隐时长改为 0.6 秒
    skip: click       # 点任意位置跳过
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `src` | 空 | 视频路径。空 = 使用自带视频；清空后不再播放。也可以写 `asset:文件名`，指向插件 `assets/` 目录里的文件 |
| `mode` | `fixed` | 播放方式：`fixed` 固定播一个 / `cycle` 按列表顺序每次换下一个 / `random` 每次随机挑一个 / `off` 完全不播（路径与列表保留，随时切回）。前三种只决定「播哪个」，播完照常渐隐进入界面 |
| `fadeOutMs` | `300` | 播完后渐隐的时长（毫秒） |
| `fadeInMs` | `320` | 出现时的淡入时长 |
| `skip` | `button` | 退出方式：`button` 右下角按钮 / `click` 点任意位置 / `auto` 自动 / `never` 不可退出 |
| `skipAfterMs` | `1200` | 仅 `skip: auto` 时有效 |
| `muted` | `true` | 是否静音。默认静音，因为 Chromium 会拦截带声音的自动播放 |
| `volume` | `0.6` | 音量 0–1 |
| `fit` | `cover` | `cover` 铺满裁切（默认，不拉伸，超出部分裁掉）/ `contain` 完整显示、四周留边 / `fill` 拉伸填满 |
| `background` | `#000000` | 画面底色 |
| `playbackRate` | `1` | 播放倍速 0.1–4 |
| `duration` | `0` | 最长播放毫秒数，`0` 表示播放到结束 |
| `maxReplays` | `0` | 重复播放次数 |
| `holdAfterEndMs` | `0` | 播完到开始渐隐之间的停顿 |
| `waitForAppMs` | `2500` | 仅动图使用：动图没有结束事件，只能按时间退出 |

字段填写有误只会退回默认值，不会导致启动失败。

### 画面怎么填满

默认 `fit: cover`：**按比例放大到铺满整个画面，超出的部分裁掉，不拉伸**。视频比窗口更宽就裁两侧，更高就裁上下。

如果素材被裁掉的部分不能少，改成 `fit: contain` 就会完整显示，代价是四周留黑边。

![三种填充方式对比：contain 上下留黑边、cover 铺满裁切、fill 拉伸](assets/fit-compare.png)

## 支持的格式

视频用 `<video>` 播放：`mp4`、`m4v`、`webm`、`mov`、`mkv`、`ogv`、`ogm`、`mpg`、`mpeg`、`ts`

动图与静态图用 `<img>` 显示：`gif`、`apng`、`webp`、`avif`、`png`、`jpg`、`jpeg`、`svg`、`bmp`、`ico`

**推荐 `webm`(VP9) 或 `mp4`(H.264)**，这两个在所有平台上都能播放。

> **Windows 上不要用 10bit HEVC 做开屏。** Chromium 会把全屏视频提升为 DirectComposition
> 硬件叠加层（10bit 走 P010 平面）。这个叠加层在双显卡笔记本、远程桌面（向日葵 / ToDesk
> 虚拟显示器）、以及 Windows MPO 合成异常时会残留：视频播完、页面闲置一段时间后，主界面
> 出现全屏闪烁的最后一帧残影，只能刷新页面恢复。插件自带的默认视频已转成 H.264 High 8bit；
> 自定义视频请照下面的命令转码（同时去掉 10bit 和 HEVC 两条风险路径）。

`mov` 和 `mkv` 只是容器，能否播放取决于内部编码：装 ProRes 或 DNxHD 就无法解码。转码命令：

```bash
ffmpeg -i input.mov -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an opening.mp4
ffmpeg -i input.mov -c:v libvpx-vp9 -crf 32 -b:v 0 -an opening.webm
```

`-movflags +faststart` 把索引移到文件开头，播放器不必下完整个文件就能起播。

## 常见问题

**播完后主界面全屏闪烁（蓝色残影），刷新页面才恢复**
这是 Windows 上 Chromium 的全屏视频叠加层缺陷（MPO / DirectComposition），不是本插件的逻辑
错误，插件只是那个"会全屏播视频"的触发者。本版本从三层规避：自带视频与素材统一转成
H.264 High 8bit（去掉 10bit P010 路径）；播放层用不透明度 0.999 让视频留在普通合成层里，
不被提升为硬件视频叠加层；渐隐结束后先暂停、清空 `<video>` 的 `src` 并等两帧，再卸载节点，
让解码器和叠加层在元素还在文档里时就释放掉。若换成自定义视频仍复现，先把它转成 H.264 8bit
（命令见「支持的格式」），再不行就是浏览器 / 显卡驱动层的问题，可临时关掉浏览器的硬件加速。
**选了视频但没有播放**
检查设置页是否显示「下次启动播放」，以及 `%APPDATA%\dsh-desktop\harness\dsh-splash-animation\config.json` 里的 `src` 是否正确。设置改动后刷新页面即可生效，不需要重启。

**有画面但没声音**
Chromium 要求用户先与页面交互才允许播放带声音的媒体，而开屏发生在交互之前。插件会自动静音重试，所以画面正常、声音没有。

**启动时还能看到 DSH 自己的小鲸鱼**
那是 Electron 主窗口在 harness 启动前加载的启动画面，插件无法替换。插件负责的是它之后的那一段。

**「选择文件…」没有反应**
对话框在运行 DSH 的机器上弹出，如果你是从另一台机器访问浏览器界面就看不到它，直接手输路径即可。

**启动时一直黑屏，过十来秒才出现界面**
说明插件的界面部分没能启动，那层遮盖由兜底机制在约 10 秒后自行撤掉——所以界面最终会回来，不会永久黑屏。常见原因是安装不完整（`client.js` 没到位）或插件在加载时被停用。重装一次即可：

```bash
dsh plugin --profile web add github:KDDKBD/DeepSeek-splash-animation
```

**跳过按钮点了没反应**
插件在开屏期间会在 `window` 捕获阶段接管输入，正常不会被别的插件抢走。若确实遇到，多半是同屏还有一个用**位置**（而不是事件目标）判定点击的插件——两边的命中区域重叠时它可能先吞掉事件。把那个插件的悬浮位置挪开即可。

**开屏动画被别的插件挡住了**
本插件把画面挂到 `<body>` 下（React portal），而不是留在槽位容器里，这样它的层级不会被槽位祖先的层叠上下文限制住。如果你在别的插件里遇到同类问题，原因通常就是这个：`shell.overlay` 的槽位包装元素本身是 `display: contents`、不产生盒子，但**它的祖先仍在**，任何带 `transform`、`filter`、`contain`、`isolation` 的祖先都会创建层叠上下文，把后代的 `z-index` 关在里面——此时数值多大都没用，只能把节点挂到 `body` 下。

## 许可

MIT，覆盖插件代码。

`assets/default.mp4` 是示例素材，不属于该授权的范围；二次分发或 fork 时请自行确认素材权利，替换该文件即可换成自己的素材。
