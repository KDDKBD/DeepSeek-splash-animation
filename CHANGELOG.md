# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.1] - 2025-10-02

文档与元数据只保留中文。

### 变更（破坏性）

- **README 只保留中文一份。** 删除英文版 `README.md`，把 `README.zh.md` 改名为 `README.md` 作为默认。此前两个文件内容重复，维护时要改两遍。
- **删除 `locale/en.json`。** 插件管理页的标题与描述只提供中文。
- `package.json` 的 `files` 与各验证脚本中的文件清单同步移除 `README.zh.md`、`locale/en.json`。

### 保留未动

- **代码注释与提交信息仍是英文**：前者是开源项目的通行惯例、多数工具链按其预期配置，改中文会引入大量改动而不影响使用者；后者是 `git log` 的互操作格式。这不属于「英文支持」——使用者读到的一切（README、设置页、错误提示）都是中文。
- **插件界面文案保留中英两套**（按 `navigator.language` 选择）。这不是对外文档的英文版，而是运行时为了在英文系统上不显示中文；删掉它会让英文系统用户看到中文界面。

## [0.4.0] - 2025-10-02

内置一个默认视频，并区分「没选过」与「主动清空」。

### 变更（破坏性）

- **自带默认视频，装好即可用。** 新增 `assets/default.mp4`（内置示例视频）。**从没设置过**路径时，插件播这段内置视频——不再需要先手动配置才有开屏动画。
- **`src` 的语义从两态变成三态。** `src` 缺失（从没选过）与 `src` 为空字符串（主动清空）现在是**不同**的状态：
  - 缺失 → 用内置默认视频；
  - 是某个路径 → 播那个；路径坏了就**不播**，且不会悄悄回退到内置视频（给你换了另一个片子比不播更糟）；
  - 空字符串 → **绝对不播**，显式决定不被默认值覆盖。
  - `normalizeConfig()` 因此保留 `src: undefined` 而不折叠成 `''`；新增 `resolveEffectiveMedia()` 承载这条规则并返回 `source: 'bundled' | 'chosen' | 'cleared' | 'unset'`。
- 线上协议版本从 3 升到 4：`config.json` 与保存响应新增 `source`、`effectiveSrc`、`chosen` 三个字段。
- 设置页路径框改为**预填「当前实际生效的路径」**（没配过时即内置视频的路径），并显示「正在使用内置视频」的状态与说明——空框配着一行「会播放」会自相矛盾。

### 移除

- 删除示例动图 `assets/opening.gif` 及其生成器 `tools/make-demo-media.mjs`、验证器 `tools/verify-demo-media.mjs`。示例图改用真实视频的尾帧：新增 `tools/make-poster.mjs`，用**真实浏览器**作解码器（本机没有 ffmpeg；Chromium 自带 H.264 解码器）抽帧；`--dump-dom` 配合虚拟时钟拿不到解码完成的帧，所以走 `--screenshot` 并让 `<video>` 元素本身作为画面。
- 截图从三张（`screenshot-cover/overlay/fade`）收敛为两张（`screenshot-splash/fade`）+ 一张真实尾帧 `poster.png`。

### 修复

- 截图工具在 `assets/poster.png` 缺失时**明确报错**，而不是自己画一张示意图——把与插件实际播放内容不一致的图当上架图是误导。

### 许可说明

MIT 覆盖的是**插件代码**，不覆盖 `assets/default.mp4`。二次分发或 fork 本包的人需要为自己携带的素材负责；替换该文件即可换成自己的素材，设置项的存在正是为了让插件不依赖它。

## [0.3.1] - 2025-10-02

修两个用户实测到的问题：**播到一半就被切断**，以及**视频出现前闪一下应用界面**。

### 修复

- **视频被提前切断（严重）。** 兜底定时器在挂载时就被武装，那时 `element.duration` 还是 `NaN`，于是退回 `waitForAppMs`（默认 2500ms）——实测一个 **8.065 秒**的视频在 2.5 秒时就被渐隐掉了。现在该定时器只在**拿到真实时长之后**才武装，且余量是「时长 + 5 秒」，仅用于抢救「报了时长但从不触发 `ended`」的媒体；完全报不出时长时用 120 秒的远距离兜底。**再也不会用猜的时长覆盖真实时长。**
  - 顺带修回被改丢的 `duration` 截断语义：显式设置比视频短的 `duration` 时按它精确切断（没有额外余量）。
  - 该算术抽成纯函数 `fadeDelayFor()` 并暴露给诊断面，契约断言逐分支锁住（含回归：`NaN` / `0` / `undefined` 都必须给出远距离兜底而不是短猜测）。
- **视频出现前闪一下应用界面。** 浮层的挂载判定原本基于 `await fetch(...)`，`await` 会把控制权交回事件循环，壳就渲染了应用界面的第一帧。改为用**同步 XHR** 读配置，判定留在同一个任务内，浮层在第一帧之前完成注册。
- **视频元素挂载到能出画之间还有一个空窗**，界面会从未解码的画面上透出来。现在浮层在 `loadeddata` / `canplay` 之前一直盖一层不透明底色，视频真正可绘制时才揭开。

### 行为确认

- 播完后**暂停在最后一帧**，再开始渐隐。这是 `ended` 事件驱动的自然结果，也是用户要求的行为，这里明确记下来。

## [0.3.0] - 2025-10-02

按实际观感调整：**播完才渐隐（0.3 秒）**，并顶掉中间那段 "Loading plugins…"。

### 变更（破坏性）

- **淡出时机改回「播完之后」。** 0.2.0 让淡出在视频最后一段*之前*开始（界面在视频还没播完时就透出来）；现在改为视频**完整播完**（`ended` 事件）之后才开始渐隐。`holdAfterEndMs` 是「最后一帧到开始渐隐」之间的停顿，默认 `0` = 一播完就渐隐。
- `fadeOutMs` 默认从 500 改为 **300**，语义从「提前量」变为「渐隐持续时长」。

### 新增

- **顶掉壳自己的启动层。** DSH 启动顺序是「原生启动窗 → Web 页加载 → 壳的 `[data-dsh-boot]`（Loading plugins…）→ 我们的浮层」，中间那段会闪一个空窗。现在配了视频时，插件通过 `ctx.on('webserver/index-inject', …)` 往 `<head>` 推一条 `<style>` 规则，在首帧前把它隐藏。
  - 规则只命中 `[data-dsh-boot]:has([data-dsh-boot-spinner])`——**带加载转圈的状态**。同一个容器也用于显示插件加载**失败**，把失败一起藏掉会把可诊断的故障变成白屏。
  - 注入是**有条件的**：`src` 为空或素材不可解析时不推这条行，DSH 保持原样。
  - 处理函数在 `apply()` 里**同步注册为第一条语句**：注入行表在宿主启动时收集一次，晚于那次收集再注册就永远进不了表。
- 视频播完路径新增**兜底定时器**：从不报告时长的视频（索引损坏、罕见容器）也不会触发 `ended`，浮层会永久停留；现在额外按 `duration` 或「时长 + `waitForAppMs`」设一个远端保险，只在 `ended` 没来时生效。

### 修复

- **原生文件对话框返回的中文路径变成乱码。** 路径原本经 PowerShell 的 stdout 回传，而 Windows 控制台用系统 ANSI 代码页（中文系统上是 GBK）编码，宿主按 UTF-8 解码就得到 `????.mp4`。改为脚本写一个 **UTF-8 无 BOM 文件**、宿主读该文件，代码页彻底不在链路里。实测 `开屏动画 中文.mp4` 原样往返。
- `runCapture` 用 `out += chunk` 拼接 stdout，多字节字符跨 chunk 边界会再被切坏；改为收 buffer 后一次性解码。
- 测试台补上 `ctx.on` 桩（`index-inject` 的处理函数此前会让路由验证台崩掉）。

### 已知限制

- **原生启动窗（第一层）仍然改不了**：`resources/splash.html` 由 Electron 主进程在 harness 启动**之前**加载，插件那时还不存在。已确认这一点并写进 README。
- 动图没有 `ended` 事件，无法做到「播完渐隐」，只能用 `duration` / `waitForAppMs` 定时退出。
- `muted: false` 不保证有声音：Chromium 的自动播放策略要求用户交互或静音。
- `.mov` / `.mkv` 只是容器，能否播放取决于内部编解码器。
- 浮层是否真的渲染、渐隐是否真的发生，仍未做浏览器自动化验收。

## [0.2.0] - 2025-10-02

按实际使用预期重做交互：**在设置页选视频 → 下次启动播放 → 结尾 0.5 秒淡出**，未配置则完全不介入。

### 变更（破坏性）

- **删除了内置样例回退。** 以前 `src` 为空时会播包内自带的 GIF；现在 `src` 为空 = **插件不介入**：不注册浮层、不显示任何东西、不写任何文件。DSH 与未安装时表现一致。
- **删除了启动时的诊断卡片。** 素材出错时不再占用启动画面，改为不播、并在设置页说明原因。
- **淡出改为由视频时长驱动。** 淡出起点 = `时长 − fadeOutMs`，因此视频还在播的时候界面已经透出来；以前是播完后才淡出。`fadeOutMs` 默认从 420 改为 **500**（即「结尾 0.5 秒」）。
- `holdAfterEndMs` 默认从 600 改为 **0**：正常路径已由时长精确控制，不再需要额外停留。
- 删除 `enabled` 字段：开关语义由「是否配置了视频」承担，少一个可能与实际状态不一致的开关。
- 配置线上协议版本从 1 升到 **2**。

### 新增

- **设置页**（`settings.plugins.tab`，与「图片生成」同一个槽位）：路径输入框、「选择文件…」原生弹窗、保存、清除、当前状态与原因说明。
- **原生文件对话框**，四级降级链：Electron `dialog.showOpenDialog`（Desktop 宿主内）→ Windows PowerShell WinForms（系统自带，零依赖）→ macOS `osascript` → Linux `zenity`；全部不可用时输入框仍可用，界面明确说明没有对话框而不是假装成功。
- **设置持久化**：`$DSH_HOME/dsh-splash-animation/config.json`，原子写入（临时文件 + rename）；profile 的 `cordis.patch.yml` 仍可写高级字段，设置页的值优先。
- **保存路由与选择路由**：`POST /dsh-splash-animation/config`、`POST /dsh-splash-animation/pick`，都过 `connection` 认证栅栏；保存路由限制 16 KiB 请求体并校验字段类型。
- 配置在**每次请求时重读**，所以设置页改完刷新页面即可生效，无需重启 DSH。
- 新验证脚本：`tools/verify-host.mjs`（34 项）、`tools/verify-routes.mjs`（55 项，进程内驱动全部路由）、`tools/verify-http.mjs` 增加惰性配置分支、`tools/probe-host-runtime.mjs`、`tools/pick-media-file.ps1`、`tools/search-market-catalog.mjs`。

### 修复

- `resolveMedia()` 先查扩展名再查文件类型，导致指向目录时误报「不支持的格式」；改为先判断存在性与是否文件（更根本的事实），`unsupported-format` 只在**确实存在的文件**上给出。
- 客户端把首次配置判定的结果缓存（`payloadPromise ??=`），导致在设置页配好视频后必须**整页刷新**才生效；改为不缓存，`apply` 与设置页各自请求一次。
- 验证脚本自身：`http()` 助手没有发送 POST 请求体（保存路由恒返回 400）；GIF 惰性配置下崩在未定义变量上。两处都会让验证结果失真。

### 已知限制

- 无法定制 DSH Desktop 的**原生启动窗**（`resources/splash.html`，位于 `app.asar` 内）。
- `muted: false` 不保证有声音：Chromium 的自动播放策略要求用户交互或静音。
- `.mov` / `.mkv` 只是容器，能否播放取决于内部编解码器。
- **动图无法按剩余时长淡出**：动图既没有时长也没有结束事件，只能用 `duration` / `waitForAppMs` 定时退出，此时 `fadeOutMs` 是叠化时长而非提前量。
- 浮层是否真的渲染在屏幕上、淡出是否真的发生，未做浏览器自动化验收。

## [0.1.0] - 2025-10-02

首个版本。

### 新增

- 宿主半（`index.js`）：
  - 从 profile 的 `cordis.patch.yml` 读取配置，`normalizeConfig()` 逐字段容错（未知枚举、越界数字、非法颜色、`null` 均回落默认值，不会让 profile 启动失败）；
  - `src` 支持绝对路径、`~/` 开头、相对于 DSH home 的路径，以及留空时回落到内置样例；
  - 按扩展名映射 MIME 与渲染方式（视频 / 图片），支持 webm、mp4、m4v、mov、mkv、ogv、mpg、ts、gif、apng、webp、avif、png、jpg、svg、bmp、ico；
  - 注册两条具名路由：`/dsh-splash-animation/config.json` 与 `/dsh-splash-animation/asset/<名字>`；路由先过 `connection.requestRejection` 认证栅栏，全部注册随插件 fiber 释放；
  - 素材路由完整实现 HTTP 语义：`Accept-Ranges`、三种 Range 形式（前缀 / 开放尾 / 后缀）、`206` + 精确 `Content-Range`、`304`（ETag）、`416`、`405`、HEAD、`nosniff`、路径穿越与未知名字一律 `404`。
- 浏览器半（`client.js`）：
  - 手写的 DSH 客户端模块，无构建步骤，安装时不跑任何依赖脚本；
  - 注册到 `shell.overlay`（可叠加的框架级浮层槽位），而不是 `root` 单槽位；
  - 按 `kind` 渲染 `<video>` 或 `<img>`；动图按设计走 `<img>` 并用 `waitForAppMs` 兜底退出；
  - 退出条件：播完 + `holdAfterEndMs`、`duration`、用户跳过（按钮 / 点击 / Esc / 空格 / 回车）、`skip: auto`、素材不可用时的诊断卡；**任意一条先满足即淡出**；
  - 自动播放被策略拦截时自动静音重试（无感降级）；
  - 中英双语文案，按 `navigator.language` 选择；
  - 暴露 `__DSH_SPLASH__.probeFormats()`，用 `canPlayType` 报告本机真实解码能力。
- 素材与工具：
  - `assets/poster.png`：320×180、24 帧的内置样例动画；
  - `tools/make-demo-media.mjs`：零依赖 GIF89a 编码器，现场生成样例；
  - `tools/verify-demo-media.mjs`：完整解码样例 GIF 的每一帧；
  - `tools/verify-contract.mjs`：覆盖 manifest、宿主导出、`normalizeConfig` 容错、浏览器半在打桩模块加载器下的注册行为，以及宿主 / 客户端两侧的配置契约；
  - `tools/verify-http.mjs`：用启动 token 换会话 cookie 后验证全部 HTTP 语义。
- 文档：插件机制与可行性调研、格式兼容矩阵、开源分发与升级方案、实际验证记录，中英双语 README。


### 新增

- 宿主半（`index.js`）：
  - 从 profile 的 `cordis.patch.yml` 读取配置，`normalizeConfig()` 逐字段容错（未知枚举、越界数字、非法颜色、`null` 均回落默认值，不会让 profile 启动失败）；
  - `src` 支持绝对路径、`~/` 开头、相对于 DSH home 的路径，以及留空时回落到内置样例；
  - 按扩展名映射 MIME 与渲染方式（视频 / 图片），支持 webm、mp4、m4v、mov、mkv、ogv、mpg、ts、gif、apng、webp、avif、png、jpg、svg、bmp、ico；
  - 注册两条具名路由：`/dsh-splash-animation/config.json` 与 `/dsh-splash-animation/asset/<名字>`；路由先过 `connection.requestRejection` 认证栅栏，全部注册随插件 fiber 释放；
  - 素材路由完整实现 HTTP 语义：`Accept-Ranges`、三种 Range 形式（前缀 / 开放尾 / 后缀）、`206` + 精确 `Content-Range`、`304`（ETag）、`416`、`405`、HEAD、`nosniff`、路径穿越与未知名字一律 `404`。
- 浏览器半（`client.js`）：
  - 手写的 DSH 客户端模块，无构建步骤，安装时不跑任何依赖脚本；
  - 注册到 `shell.overlay`（可叠加的框架级浮层槽位），而不是 `root` 单槽位；
  - 按 `kind` 渲染 `<video>` 或 `<img>`；动图按设计走 `<img>` 并用 `waitForAppMs` 兜底退出（动图没有 `ended` 事件）；
  - 退出条件：播完 + `holdAfterEndMs`、`duration`、用户跳过（按钮 / 点击 / Esc / 空格 / 回车）、`skip: auto`、素材不可用时的诊断卡；**任意一条先满足即淡出**，不存在无法退出的路径；
  - 自动播放被策略拦截时自动静音重试（无感降级）；
  - 中英双语文案，按 `navigator.language` 选择；
  - 暴露 `__DSH_SPLASH__.probeFormats()`，用 `canPlayType` 报告本机真实解码能力。
- 素材与工具：
  - `assets/poster.png`：320×180、24 帧的内置样例动画；
  - `tools/make-demo-media.mjs`：零依赖 GIF89a 编码器，现场生成样例（仓库不提交二进制来源、不依赖 ffmpeg）；
  - `tools/verify-demo-media.mjs`：完整解码样例 GIF 的每一帧（走真实块结构 + LZW 解压），40 项契约之外的结构性验证；
  - `tools/verify-contract.mjs`：40 项断言，覆盖 manifest、宿主导出、`normalizeConfig` 容错、浏览器半在打桩模块加载器下的注册行为，以及宿主 / 客户端两侧的配置契约；
  - `tools/verify-http.mjs`：46 项断言，用启动 token 换会话 cookie 后验证全部 HTTP 语义。
- 文档：插件机制与可行性调研、格式兼容矩阵、开源分发与升级方案、实际验证记录，中英双语 README。

### 已知限制

- 无法定制 DSH Desktop 的**原生启动窗**（`resources/splash.html`，位于 `app.asar` 内）；本插件负责的是 Web UI 起来之后的那段开屏动画。
- `muted: false` 不保证有声音：Chromium 的自动播放策略要求用户交互或静音，开屏发生在交互之前。插件会带声重试并静音降级。
- `.mov` / `.mkv` 只是容器，能否播放取决于内部编解码器；插件运行时探测并在失败时给出转码建议。
- 浮层是否真的渲染在屏幕上，未做浏览器自动化验收。
