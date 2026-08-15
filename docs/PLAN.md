# dsh-studio · 项目方案

> 项目名：**dsh-studio**
> 日期：2026-08-15
> 状态：**M0-① 已完成，M1 进行中**（Windows 全链路实测通过，见 §9.1；mac / Linux 待验）
> 上一版文档：`D:\GR\dsh-desktop-方案.md`（结论为「并入 CCHub」，本文档已推翻该结论，见 §2）

---

## 0. 一句话

做一个 **Rust / Tauri 2 的 DeepSeek Harness 桌面端**，独立开源仓库，
差异化不是「Rust 更快」，而是 **全平台原生桌面集成（含 Linux）+ 服务不掉线**。

底层能力（Node runtime 分发、子进程监管、Job Object 回收）抽成独立 crate，供 CCHub 复用。

---

## 1. 命名

| 项 | 值 |
|---|---|
| 仓库名 | `dsh-studio` |
| 目录 | `D:\GR\dsh-studio` |
| repo description | `DeepSeek Harness 原生桌面端 · 支持 Linux/macOS/Windows · Rust + Tauri` |

### 取名依据

**1. 描述性命名 > 品牌化命名（有数据支撑）**

本生态内拿到星的项目几乎全是直白描述型：

| 项目 | 命名风格 | Star |
|---|---|---|
| deepseek-harness-**desktop** | 描述 | 1,952 |
| dsh-**web-ui** | 描述 | 1,951 |
| **awesome**-dsh-plugin | 描述 | 1,142 |
| dsh-**TUI** | 描述 | 904 |
| DSH-**better-sidebar** | 描述 | 783 |
| dsh-**vision-toolkit** | 描述 | 333 |
| dsh-**deep-whale** | 品牌化 | 602 |

唯一品牌化的 `deep-whale` 是鲸鱼娘皮肤包，靠图片传播，名字不承担发现功能——与本项目情形不同。

**发现渠道是 GitHub 搜索 + awesome 榜 + Trending**，用户搜的是 `dsh desktop`、`deepseek harness linux`。品牌名需要营销渠道去教用户认，而本项目是零受众挑战者，没有该渠道。

**2. 选 `studio` 的理由**

- 中文圈对该词有认知锚点（Cherry Studio 50k 星先例）
- 读感是「完整产品」而非「某个壳」，与竞品的 `-desktop` 形成定位差
- 容量足够——将来加插件市场、手机远程控制也装得下
- `dsh-` 前缀保留，搜索红利不丢

**3. 落选项**

| 候选 | 落选原因 |
|---|---|
| `dsh-deck` | `deck` 在科技语境已被 Steam Deck / pitch deck 占据语义；中文用户费解 |
| `dsh-desktop` | 与竞品 `deepseek-harness-desktop` 过近，易被视为克隆 |
| `dsh-native` | 差异化最强但语义偏抽象 |

> ⚠️ **真正决定星数的是 repo description 那一行，不是仓库名。**
> description 中「**支持 Linux**」五个字比名字值钱——竞品没有（见 §4 issue #9）。

---

## 2. 决策记录

### 2.1 路径选择

上一版文档结论是 **A（并入 CCHub，不新开仓库）**。本次决策改为 **C**。

| | A. 并入 CCHub | B. 纯独立仓库 | **C. 独立仓库 + 共享 crate** |
|---|---|---|---|
| 吃这波 DSH 生态的星 | ❌ | ✅ | ✅ |
| 官方发桌面包后 | 抗打击 | 价值大幅缩水 | 缩水，但 crate 沉淀留下 |
| 上游破坏性变更 | 低耦合 | 低耦合（只要不 fork） | 低耦合 |
| 成本 | 最低 | 最高 | 中 |

**选 C 的理由：** A 优化的是「项目能活多久」，本项目的目标是「能不能吃到窗口期」。C 是唯一两头都占的——独立仓库拿星，底层 crate 归 CCHub 沉淀，官方哪天发包也不是净亏。

### 2.2 推翻上一版「技术上超越是伪命题」的判断

上一版文档称竞品「壳本身两周可复制」，因此技术上无法超越。**该判断基于未审阅 issue 列表。**

实际核查竞品 14 个 open issue 后（§4），其中 8 个是桌面集成缺陷、1 个是 Linux 平台完全缺失。结论修正为：**存在实打实的差异化空间**，且 CCHub 已有现成解法（§5）。

### 2.3 明确不做

- ❌ **不 fork 上游 monorepo。** 竞品 fork 了整个 monorepo，而上游明确声明会有破坏性变更，那笔 rebase 债不接。仅依赖 CLI 契约（`dsh web` / 端口 / 配置路径）。
- ❌ 不用 Rust 重写 harness 核心。上游基于 Cordis（JS 框架），插件生态全是 npm 包，重写 = 丢掉生态 = 丢掉全部意义。
- ❌ 不做「又一个单 agent 专用壳」——定位必须落在原生集成与全平台。

---

## 3. 事实核查

> 严格区分「已实测」与「待验证」。开工前需复核——上游与竞品均处于日更状态。

### 3.1 已实测（2026-08-15，GitHub API / npm registry）

**上游 `deepseek-ai/deepseek-harness`**

| 项 | 值 |
|---|---|
| 创建时间 | 2026-08-13 |
| Star / Fork | **95,981 / 8,904** |
| 语言 / 协议 | TypeScript / MIT |
| 启动方式 | `npx @deepseek-ai/dsh web` |
| 默认服务地址 | `http://127.0.0.1:3080` |
| 架构 | Cordis 驱动，「一切皆插件」 |

> 上游 2026-08-11 提交 `docs: make Web UI the primary onboarding path`——官方正把 Web UI 提为主要入口，即在往「普通人可用」方向收。**这是最大战略风险**（§7 风险 1）。

**npm `@deepseek-ai/dsh`**

| 项 | 值 |
|---|---|
| dist-tags | `latest` = `next` = **0.1.0-rc.6** |
| 发布时间 | 2026-08-13T12:35:03Z |
| bin | `dsh` → `lib/bin.js` |
| 依赖数 | 61 |
| unpackedSize | 0.1 MB（薄包装，实体在依赖里） |
| `engines` 字段 | **无**——最低 Node 版本未声明，必须实测 |
| 历史版本数 | 6 |

**竞品 `anywhere-labs/deepseek-harness-desktop`**

| 项 | 值 |
|---|---|
| 创建时间 | 2026-08-13（与上游同日） |
| Star / Fork / Watch | **1,952 / 104 / 7** |
| Open issues | 21 |
| 语言 / 协议 | TypeScript / MIT |
| 平台 | macOS、Windows（**无 Linux**） |
| 最近推送 | 2026-08-15 |
| 官网 | deepseekdesktop.com / dshdesktop.cn |
| 社区 | Discord + 微信群 + QQ 群 |

> **版本落后信号：** npm 上游已到 `rc.6`，竞品桌面端仍为 `rc.5`（该版本号来自上一版文档，未复核）。

**生态圈地现状**（均为近日新建，说明窗口期正在进行）

| 项目 | 创建 | Star |
|---|---|---|
| deepseek-ai/deepseek-harness | 08-13 | 95,981 |
| zhu1090093659/dsh-web-ui | 08-12 | 1,951 |
| **anywhere-labs/deepseek-harness-desktop** | 08-13 | 1,952 |
| awesome-dsh-plugin | 08-13 | 1,142 |
| ccch1mneyyy/dsh-TUI | 08-13 | 904 |
| DSH-better-sidebar | 08-07 | 783 |
| Small-tailqwq/dsh-deep-whale（皮肤） | 08-13 | 602 |
| alchaincyf/deepseek-harness-orange-book（纯文档） | 08-14 | 595 |
| xiaobright/dsh-anchored-standard | 08-14 | 413 |
| Anionex/dsh-vision-toolkit | 08-13 | 333 |

> 一份纯文档一天 595 星。**窗口期估计还剩 1~2 周**，发布速度优先于功能完整度。

### 3.2 CLI 契约验证结果（M0-① 已完成，2026-08-15 实测）

> 直接运行真实 `dsh` 二进制得出，非阅读竞品源码推断。

| # | 待验证项 | 结论 |
|---|---|---|
| V1 | `dsh web` 是否支持 `--port` | ✅ **支持，且 `--port 0` 由系统分配空闲端口**。§6.4 的端口冲突问题因此**整体消失** |
| V2 | 最低 Node 版本（npm 无 `engines`） | 仍无声明。我方自定下限 Node 20（`node_runtime::MINIMUM_SUPPORTED`） |
| V3 | 配置文件路径与格式 | 未验（不阻塞 M1） |
| V4 | 进程退出行为、是否留孤儿进程 | 未单独验；`proc-guard` 用 Job Object 从机制上兜住，不依赖被管进程的良好行为 |
| V5 | 是否支持 `--host` | ✅ 支持。我方固定 `127.0.0.1`，不做成设置项（agent 能执行 shell 命令） |
| V6 | 就绪信号格式 | ✅ stdout 单行 `dsh web: http://127.0.0.1:<port>`。已实现为 `harness/readiness.rs`，并校验 scheme/host/port，拒绝被子进程牵引到任意 origin |
| V7 | 竞品技术栈 | ✅ 复核属实：Electron 43.4.0 + electron-builder 26.15.3；`linux.target` 仅 `["dir"]`，坐实 issue #9 |

**两条额外发现，均影响架构决策：**

- **安装体积 255.2 MB**（node-pty 62.6 MB、sharp 18.3 MB、@google/genai 13.7 MB…）。重量在 dsh 自己的 `node_modules`，不在外壳。因此**不随包分发 dsh**，改为「像版本管理器一样按需安装/升级」：安装包 ~20 MB，dsh 永远是最新版。已实现为 `harness/install.rs`。
- **竞品的原生质感无法脱离 fork 存在。** 在已发布的 `@deepseek-ai/dsh-web-frontend` 中搜 `dsh-desktop-platform` 得到 **0 命中**——那套 chrome 只存在于竞品 fork 的 `packages/client/ui-*` 里，他们必须永久维护这个 fork。我方对策见 §3.3，不 fork、不锁版本、代码全部原创。

### 3.3 外壳与 harness 的边界（2026-08-15 实测定案）

原方案是「就绪后把 WebView 整体导航到 harness origin，再注入 CSS/JS 补 chrome」。实测推翻：

- Windows / Linux 的窗口是 `decorations(false)`（自绘标题栏）。**一旦导航走，标题栏随 React 应用一起消失，窗口无法移动、最小化、关闭**——不是体验问题，是死窗口。
- 实测 `dsh web` 的响应头：**没有 `X-Frame-Options`，没有 CSP**。用 Chrome 验证跨源 iframe 嵌套，dsh 的 Web UI 完整渲染、连接正常、控制台无报错。

**定案：harness 跑在我方壳内的 iframe 里**（`HarnessFrame.tsx`）。

| | 导航 + 注入 | iframe 承载（采用） |
|---|---|---|
| 标题栏 | 导航后丢失，需注入补回 | 永远是我们的 |
| 触碰对方 DOM | 必须 | 完全不必 |
| 上游改版 | 可能打碎注入的布局 | 无影响 |
| 会话状态 | 切回启动器即销毁 | `display:none` 保活 |

连带收益：harness 页面不再需要 Tauri IPC，`capabilities/harness.json`（给远程 origin 开窗口权限）已删除——**一个能执行任意 shell 命令的页面，不该握有我方窗口 API**。

**另一发现（留给 M2）**：harness 页面里有 `window.__DSH_BOOT__`，含一份客户端插件清单（`/plugins/<id>/client.js` + 依赖注入声明）。**dsh 本身就有插件机制**——竞品为改界面 fork 了整个 monorepo，而这里有正门。我方要做深度集成时走插件包，仍然不 fork。

---

## 4. 差异化依据：竞品 14 个 open issue

**这是本项目的核心竞争依据。** 逐条核查结果：

| # | 标题 | 归类 |
|---|---|---|
| #5 | windows 11 64位电脑无法使用 | **致命** |
| #8 | macOS 启动时重复注册 token-cost-meter 导致 Host 退出 | **致命** |
| #15 | Windows 下 agent 每次执行沙箱工具命令都会弹出可见命令行窗口 | 桌面集成 |
| #9 | 希望构建 linux 平台的安装包，不想每次更新都要自己编译打包 | **平台缺失** |
| #14 | 复制按钮无反应：`navigator.clipboard.writeText` 权限被拒时未降级 `execCommand` | 桌面集成 |
| #18 | 代码块右上角复制按钮点击后无法复制 | 桌面集成 |
| #12 | 鼠标右键单击无法展开菜单 | 桌面集成 |
| #6 | 图标重叠 | 桌面集成 |
| #10 | 软件字体放大缩小方面问题 | 桌面集成 |
| #20 | RTL mixed-text rendering is broken when a sentence starts with an English word | Web 层 |
| #19 | 打开报错，无法解析皮肤包 | 功能 |
| #21 | 模型切换异常 | 功能 |
| #13 | 旧会话恢复失败：模型配置切换后 session log 出现 seq gap | 状态管理 |
| #7 | 评估将 DSH 社区插件商店接入 Desktop | 需求 |

**统计：14 个中 8 个属桌面集成/平台缺失。**

### 对位打法

| 竞品的病 | dsh-studio 的药 |
|---|---|
| #9 无 Linux 包 | **Day-1 出 deb / rpm / AppImage + arm64**，空白市场 |
| #15 弹黑窗 | `CREATE_NO_WINDOW` — CCHub 已有现成实现 |
| #5 Win11 跑不起来 | WebView2 系统自带，无 Chromium 打包坑 |
| #12 / #14 / #18 / #10 | Tauri 原生菜单 + 原生剪贴板 API，不走浏览器权限模型 |
| #8 重复注册导致退出 | Rust supervisor：单例锁 + 健康检查 + 退避重启 |
| #13 会话 seq gap | 进程/端口状态机严格建模 |

> **README 第一行不写「Rust 重写版」（无人关心），写：**
> **全平台原生桌面端 · 含 Linux · 服务永不掉线**

---

## 5. CCHub 资产盘点

来源：`D:\GR\cchub-master\cchub-master`，v1.4.1，Tauri 2。**已实测。**

### 5.1 可直接复用

| 能力 | 位置 | 状态 |
|---|---|---|
| **Windows 静默子进程**（对位竞品 #15） | `src-tauri/src/utils.rs:8,88` — `CREATE_NO_WINDOW` + `configure_background_command()` | ✅ 已上线 |
| Windows Node 定位 | `commands/autopilot/runtime.rs:545` — `try_resolve_windows_node_wrapper()` | ✅ |
| 子进程 spawn / 轮次管理 | `commands/autopilot/runtime.rs` | ✅ 可参考 |
| 健康检查 | `mcp/health.rs` | ✅ 可参考 |
| HTTP 客户端（gzip/brotli/http2/stream） | `shared/http_client.rs` | ✅ |
| GitHub Release 拉取 | `shared/github_release.rs`、`github_urls.rs` | ✅ |
| 崩溃日志 / panic hook / 原子写 | `utils.rs:98,196,234` | ✅ |
| 托盘 / 单实例 / 深链 / 自动更新 | `tauri-plugin-{tray-icon,single-instance,deep-link,updater,process,shell}` | ✅ 全套已接 |

关键代码（已上线，正是竞品 #15 所缺）：

```rust
// cchub/src-tauri/src/utils.rs:8
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// :88
pub fn configure_background_command(command: &mut std::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}
```

### 5.2 Node runtime 分发所需 crate — 已全部在依赖里

`src-tauri/Cargo.toml` 现有：`reqwest 0.12`(stream/gzip/brotli/http2)、`zip 8.2`、`flate2 1`、`tar 0.4`、`sha2 0.10`、`tempfile`、`dirs 6`。

### 5.3 缺口（需从零写）

| 缺口 | 说明 |
|---|---|
| **Job Object 孤儿进程回收** | 全仓 grep 无 `JobObject`。**唯一必须从零实现的硬骨头** |
| `xz2` | Linux `node-*.tar.xz` 解压，加一行依赖 |
| dsh supervisor | 本项目主体 |
| 前端 Harness 页 | 本项目主体 |

> 结论：上一版文档「一个 Rust 模块 + 一个前端页面」的估算基本准确。

---

## 6. 技术方案

### 6.1 关键前提：Rust 不能免除 Node

`dsh` 是 Node 程序。**Rust 替换的是外壳，不是 dsh 本身。** 无论壳用什么语言，目标机器上都必须有可用的 Node runtime。

体积账（对齐上一版文档的修正结论）：

| | 竞品（Electron） | dsh-studio（Tauri） |
|---|---|---|
| 壳 | ~90 MB | ~20 MB |
| Node runtime | 0（Electron 自带） | +50~90 MB（打包）/ 0（按需下载） |
| **合计** | ~90 MB | 打包 ~70~110 MB / 按需下载 **~20 MB** |

**诚实结论：**
- 走「打包 Node」→ **体积基本打平**，不构成卖点。
- 走「按需下载」→ 安装包 ~20MB，**才有卖点**。
- 内存上省掉一份常驻 Chromium（~100~150MB），但真正吃内存的是 dsh 的 Node 进程和模型请求，两边相同。**是温和优势，不该当头条。**

> **不要在 README 宣传「体积缩小 15 倍」——站不住。头条卖点是全平台 + 原生集成 + 稳定性。**

### 6.2 Node runtime 落地（全项目唯一硬问题）

**方案：C + B 混合**

```
启动
 ├─ 检测系统 Node（PATH / nvm / fnm / volta 常见路径）
 │   └─ 版本满足 → 直接用（零成本零等待）
 └─ 未找到或版本不符
     └─ 「一键准备运行环境」→ 下载托管版 Node 到应用数据目录
         └─ %LOCALAPPDATA%\dsh-studio\runtime\node-vX.Y.Z\
```

**下载实现要点：**

| 项 | 内容 |
|---|---|
| 官方源 | `https://nodejs.org/dist/v{VER}/` |
| 国内镜像 | `https://npmmirror.com/mirrors/node/v{VER}/` |
| Windows x64 | `node-v{VER}-win-x64.zip` |
| macOS arm64/x64 | `node-v{VER}-darwin-{arch}.tar.gz` |
| Linux x64 | `node-v{VER}-linux-x64.tar.xz` |
| 校验 | 拉同目录 `SHASUMS256.txt` 校验 SHA-256，**镜像源不可全信，不能省** |
| 进度 | Tauri event → 前端进度条 |
| 版本策略 | 锁定一个已验证的 Node LTS，**不跟随最新**（待 V2 确认最低版本） |

### 6.3 ⚠️ Windows 孤儿进程 — 最容易埋雷处

Windows 上父进程被杀后子进程**不会**自动终止，`tauri-plugin-shell` **不处理**，必须自行实现。

```rust
// 1. CreateJobObject
// 2. SetInformationJobObject:
//    JOBOBJECT_EXTENDED_LIMIT_INFORMATION
//      .BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// 3. AssignProcessToJobObject(job, child_handle)
// → 主进程正常退出或崩溃时，Job 句柄关闭，子进程树被内核强制回收
```

crate 候选：`windows` / `windows-sys`，或封装好的 `win32job`。
macOS / Linux：进程组（`setsid` + `killpg`），相对简单。

**必须在 M1 就做对。**

### 6.4 端口管理（已定案）

V1 有结论后这一节大幅简化：**始终 `--host 127.0.0.1 --port 0`**，由内核分配端口，从 stdout 的就绪行读回实际 origin。

- 不存在端口占用，因此**永远不需要请用户去释放 3080**
- 不做端口设置项：能执行 shell 命令的 agent 不该被绑到 loopback 以外
- 多实例：`tauri-plugin-single-instance`，第二次启动激活已有窗口（已实现）

### 6.5 模块结构

```
src-tauri/src/
├── runtime/          # ← 抽 crate，供 CCHub 复用
│   ├── detect.rs     # 系统 Node 检测（PATH / nvm / fnm / volta）
│   ├── download.rs   # 下载 / 镜像回退 / 解压 / SHA-256 校验
│   └── version.rs    # 版本管理
├── proc/             # ← 抽 crate，供 CCHub 复用
│   ├── supervisor.rs # spawn / 监控 / 退避重启 / 清理
│   ├── jobobject.rs  # Windows Job Object（新写）
│   └── procgroup.rs  # macOS/Linux 进程组
├── harness/
│   ├── mod.rs        # Tauri command 入口
│   ├── health.rs     # HTTP 健康检查轮询
│   ├── port.rs       # 端口分配
│   └── config.rs     # dsh 配置读写
└── ...
```

`runtime/` 与 `proc/` 设计为独立 crate（workspace member），这是路径 C 中「共享」的落点。

---

## 7. 风险清单

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| 1 | **官方发布自己的桌面安装包** | **高** | 上游已把 Web UI 提为主入口，信号明确。应对：尽早发布吃窗口期；底层 crate 沉淀保底 |
| 2 | 上游破坏性变更（官方明确声明会有） | **高** | 绝不 fork monorepo；只依赖 CLI 契约；版本探测 + pin |
| 3 | **WebKitGTK 渲染差异** | **中高** | Tauri 在 Linux 用 WebKitGTK，dsh Web UI 按 Chromium 调。**这是「Linux 首发」这个卖点的最大不确定性，M0 必须验** |
| 4 | Windows 孤儿进程残留 | 中 | Job Object，M1 必须做对 |
| 5 | Node 下载失败 / 被墙 | 中 | 多镜像回退 + 代理 + 手动指定本地 Node 路径兜底 |
| 6 | 追赶者劣势 | 中 | 竞品已有 Discord + 微信群 + QQ群 + 两个域名 + 已进 awesome 榜 |
| 7 | 首次启动等待 | 中 | 优先复用系统 Node；下载有明确进度反馈 |
| 8 | macOS 公证 / 签名 | 低 | CCHub 已有流程 |

---

## 8. 里程碑

> 窗口期估计仅剩 1~2 周，**发布速度优先于功能完整度**。

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **M0 · 验证**（1~2 天） | ① 实测 dsh CLI 契约，产出 V1~V6 清单 ✅<br>② **最小 Tauri 壳跑通，三平台各验一遍 UI 渲染**（风险 3）— Windows ✅，mac / Linux ⏳ | V1 有结论 ✅（`--port 0`，见 §3.2）；Linux WebKitGTK 待确认 |
| **M1 · 能跑起来**（约 1 周）**← 当前** | 系统 Node 检测 ✅ + supervisor ✅ + **Job Object** ✅ + 静默子进程 ✅ + 按需装 harness ✅ + 启动器 UI ✅ + 健康检查 ✅ + iframe 承载 ✅ ／ 托盘、Win11 Mica、原生右键 ⏳ | 有 Node 的机器上一键起 dsh 并在 WebView 里可用；对位干掉 #15/#12/#14/#18 |
| **M2 · 免装 Node**（约 1 周） | 按需下载 + 镜像回退 + SHA-256 + 进度 UI | 干净机器开箱即用（核心价值达成） |
| **M3 · 发布** | CI 六平台产物矩阵（win x64/arm64、mac intel/arm、linux deb/AppImage）、自动更新、README 双语 | **带 Linux 包首发**，对位干掉 #9 |
| **M4 · 沉淀** | `runtime/` `proc/` 抽 crate 回流 CCHub | 路径 C 闭环 |

M0-① 已出结论，M1 据此开工；M0-② 的 mac / Linux 两块仍是风险 3 的唯一敞口，须在 M3 打包前闭掉。

---

## 9. 当前环境

| 项 | 状态 |
|---|---|
| Rust | ✅ 1.97.1（stable-x86_64-pc-windows-msvc，本次已设默认工具链） |
| Cargo | ✅ 1.97.1 |
| Node | ✅ v24.0.0 |
| pnpm | ✅ 10.30.2 |
| 项目目录 | ✅ `D:\GR\dsh-studio` |
| dsh 实测 | ✅ 已完成，见 §3.2 |
| Rust 内核 | ✅ `cargo check --workspace --all-targets` 干净；`cargo test --workspace` 全绿（含 proc-guard 进程树回收 3 例、health 4 例） |
| 前端 | ✅ `pnpm build` 在 strict TS 下干净；`pnpm lint` 零警告（ESLint 9 flat config）；`pnpm test` 16/16 |
| `pnpm tauri dev` | ✅ Windows 下起窗、检测环境、装 harness、拉起 dsh、iframe 承载、停止回收 —— 全链路实测通过（§9.1） |
| 开源就绪 | ✅ README 双语 + LICENSE(MIT) + .gitignore |

### 9.1 端到端实测记录（2026-08-15，Windows 11，非交互 shell 下用 PrintWindow + PostMessage 驱动）

| 步骤 | 结果 |
|---|---|
| 启动器渲染、环境检测 | ✅ Node 24.0.0 / PATH，harness 就绪 |
| 点「启动 Harness」 | ✅ dsh 起在 `:57652`，标题栏出现端口 chip |
| harness UI 在 iframe 内 | ✅ 完整加载（内测声明 → API Key 引导） |
| 切到控制面板再切回 | ✅ 会话状态保留（弹窗未复现，证明 `display:none` 而非卸载） |
| 点「停止」 | ✅ 端口释放，`Win32_Process` 查无残余 dsh node —— **进程树回收在真机上验证成立** |

> 这套「截图 + 合成点击」的验证脚本放在 `.workflow/.scratchpad/`（已 gitignore），
> 因为 WebView2 在 wry 设置 `AdditionalBrowserArguments` 之后会忽略
> `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，CDP 端口拿不到。

---

## 10. 下一步

1. **补完 M0-②**：mac / Linux 各跑一遍 `pnpm tauri dev`，重点看 WebKitGTK 下启动器与 dsh Web UI 的渲染（风险 3）。
   —— 这是目前唯一还没闭掉的敞口，且「带 Linux 包首发」是主要卖点，必须在 M3 打包前解决。
2. **M1 剩余**：托盘图标、Win11 Mica/窗口材质、原生右键与剪贴板、dsh 版本管理与更新。
3. **M2 起点**：走 dsh 自己的客户端插件系统（`window.__DSH_BOOT__` / `/plugins/<id>/client.js`）做扩展——
   竞品为了改界面永久 fork 了整个 monorepo，我们用上游给的那扇门，不 fork（见 §3.3）。
4. CI：六平台产物矩阵 + 在 CI 上跑 `pnpm lint / test` 与 `cargo test`。

---

## 附：信息来源

| 来源 | 用途 | 核查方式 |
|---|---|---|
| GitHub API `deepseek-ai/deepseek-harness` | 上游 star / 时间 / CLI 契约 | ✅ 实测 |
| GitHub API `anywhere-labs/deepseek-harness-desktop` | 竞品指标 + **14 个 issue 全量** | ✅ 实测 |
| npm registry `@deepseek-ai/dsh` | 版本 / bin / 依赖 / engines | ✅ 实测 |
| GitHub Search API | 生态圈地现状 | ✅ 实测 |
| `D:\GR\cchub-master\cchub-master` | 自有资产盘点 | ✅ 实测 |
| `D:\GR\dsh-desktop-方案.md` | 上一版方案 | 部分结论已推翻（§2.2） |

> 核查时间：2026-08-15。竞品与上游均处于日更状态，开工前建议复核。
