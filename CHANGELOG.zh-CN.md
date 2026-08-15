# 更新日志

本项目所有值得记录的变更都写在这里。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)——但要带上 1.0 之前的那条惯例：
任何东西都还可能动。

[English](CHANGELOG.md)

## [未发布]

### 修复

- Unix 下的进程树测试在写夹具脚本时没有给可执行位，
  导致「`proc-guard` 能收掉孙子进程」这条用例在 Linux 和 macOS 上根本跑不起来。

### 文档

- 新增 `CONTRIBUTING.md`、`SECURITY.md`、本更新日志，
  以及 GitHub 的 issue 与 PR 模板，每一份都有中文版。
- README 补上了架构图、逐步拆开的启动流程、四个发布目标的安装表、
  与另一个 harness 桌面端的对比，以及常见问题。

## [0.1.1] —— 2026-08-15

### 修复

- `devDependencies` 里漏了 `@types/node`，于是 `tsc --noEmit`——
  连带 `pnpm build` 和发布流水线——在干净检出上会失败，尽管本地是通过的。
  应用的行为没有任何变化。

## [0.1.0] —— 2026-08-15

首个版本。在 Windows 11 上端到端验证通过；macOS 与 Linux 由 CI 构建，
但还没有人真正跑起来看过。

### 新增

- **Node 检测。** 用 `--version` 逐个探测机器上的每一个 Node，
  包括版本管理器装了但从没进过 `PATH` 的那些。满足最低版本要求的里面最新的胜出；
  两个目录报出同一版本时按路径定序，保证每次启动选出来的都是同一个。
- **一键安装。** `@deepseek-ai/dsh` 不在时，那一行提示本身就是按钮。
  它装进应用数据目录下的私有 prefix，直接用检测到的 Node 可执行文件调用
  `npm-cli.js`、全程不经过 shell，并把输出实时打进窗口里。
- **Supervisor。** 服务运行在 supervisor 之下，退出后按退避策略重启。
- **端口由内核分配。** 服务以 `--port 0` 启动，supervisor 再从就绪行里
  把它实际绑定到的端口读回来。既没有配置好的端口可冲突，
  也不存在「先检查端口、再绑定端口」中间的那段空隙。
- **健康探测。** 每 10 秒发一次真正的 HTTP 请求——
  因为一个卡死的服务，PID 仍然是活的，TCP 连接也仍然能成功，
  握手是内核从 listen backlog 里替它完成的。连续三次没有回应就回收重启。
- **进程树回收。** Windows 上服务被放进带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  的 Job Object，就算外壳自己被强杀，内核也会把整棵树收掉；
  Unix 上则单独建进程组、按组发信号。
- **承载 harness。** 上游界面从它自己的源加载在外壳标题栏下方的 frame 里。
  切回控制面板不会丢掉正在进行的会话，上游也没有被打补丁或 vendor 进来。
- **日志控制台。** 外壳自身的输出，可选中、可复制。
- **中英双语，** 跟随系统语言。
- **托盘图标**，带「打开 / 退出」菜单；服务运行期间关闭窗口是收进托盘，
  免得一次误关就结束了一整个会话。
- **桌面软件形态的窗口**——自绘标题栏带最小化、最大化与关闭，
  底部状态栏承载 harness 当前在做什么、服务地址、选中的 Node 与工作区。
  地址左键点击用浏览器打开、右键复制，工作区点击则在文件管理器里打开。
- **发布流水线。** 打了 tag 的版本由 CI 构建 Windows x64、Linux x64、
  macOS Apple Silicon 与 macOS Intel 四个目标。

[未发布]: https://github.com/Moresyl/dsh-studio/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Moresyl/dsh-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Moresyl/dsh-studio/releases/tag/v0.1.0
