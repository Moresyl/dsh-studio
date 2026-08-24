# DSH Studio 使用指南

[English](user-guide.md)

## 第一次启动

希望下载最小时选择**轻量版**；首次配置必须断网完成时选择**完整离线版**。两者使用相同的应用身份和数据目录。完整离线版内置按 SHA-256 固定的 Node 与 Harness 压缩包，真正解压前仍会再校验一次。

1. 环境页会寻找 Node.js 22.19 或更高版本；没有时可由应用下载并校验官方运行时。
2. 应用把固定版本的 `@deepseek-ai/dsh` 安装到自己的数据目录，不修改全局 npm。
3. 工作区必须存在。Windows 会检查磁盘类型与文件系统：本地 NTFS/ReFS 可直接使用，网络盘、可移动盘和 FAT/exFAT 会阻止启动。
4. 选择 Profile 后启动。Harness 始终只监听 `127.0.0.1`。默认由系统分配随机端口；需要稳定
   回环来源时，可在设置中保存 1024–65535 的固定端口。Studio 会在启动 Node 前检查固定端口，
   被占用时明确报错，不会静默换端口。

## 插件

「发现」页可切换 npm、DSH 1024Store、受频率限制且经过审查的 dshfind 目录，或自定义标准目录。「来源」页还可以打开 [DSH Hub](https://dsh-hub.org/) 发现社区插件：把页面列出的 npm 包名带回 Studio 搜索，仍会经过同一套原生安全检查。DSH Hub 当前提供的是网站目录，不是 Studio 公开的目录 Schema 1.0.0 接口，因此 Studio 不会抓取其 HTML，也不会把首页当作安装权威。结果会索引缓存十分钟，并支持分类筛选、排序和每页 25 项的分页。目录只负责发现，安装前仍会从 npm 重新读取精确版本、检查包名和 Harness peer 兼容性。市场安装成功后会记录精确来源、版本与完整性；只有磁盘中的安装版本仍与回执一致时才显示「市场托管」。插件变更写入恢复日志；进程中断后，下次启动会恢复变更前状态并给出提示。

## 界面模式与桌面集成

**兼容模式**直接打开完整上游 Harness；**扩展模式**保留完整上游界面，并增加终端、会话、
插件、Profile 与工作区的紧凑原生工具栏；**高级模式**打开 Studio 完整工作台。选择会在所有
窗口间共享。内置终端的 `PATH` 会包含固定版本的 Node、Harness 与 pnpm 工具，并带上当前
Profile 和工作区。打包后的 macOS/Linux 应用只从登录 Shell 恢复允许列表中的开发环境变量，
不会导入凭据。

Harness 页面可以探测冻结的 Protocol 3 `window.dshStudio` API，调用通知、选择器、角标、深链、Profile 查询/选择、精确版本插件安装/卸载，以及原生 Workspace 准入/拖放信号。桥接层只接受当前受监管的回环 Harness 来源，不开放原始 Tauri IPC 或 Shell 执行。

Harness Host 插件还可以单独探测只读 Host Protocol 1，读取当前 Studio/Harness 版本和有界
Profile 清单。该服务不提供原生句柄、命令执行器、包修改或 Profile 修改。详见
[插件互操作合同](plugin-interoperability.zh-CN.md)。

设置中可分别控制用户轮次、后台任务成功/失败通知。工作区既可通过原生目录选择器指定，也可直接拖入文件夹。

## 日志与诊断

「关于」页可以复制适合公开粘贴的诊断摘要，也可以导出限额 50 MiB 的诊断 ZIP。ZIP 包含版本、运行时、Profile、恢复状态、近期脱敏日志、Rust/WebView 崩溃证据，以及 Windows 上由 Studio panic 写出的原生 minidump；系统已有的 Windows/macOS 崩溃报告也会在安全且未超限时收集。应用不会自动上传任何内容。二进制转储可能含进程内存片段，分享前必须检查。

如果 Studio 已无法打开窗口，可给可执行文件传入 `--export-diagnostics`。命令会在 Tauri 和 Harness 启动前退出，并打印唯一命名 ZIP 的绝对路径。例如在 Windows 便携版目录运行 `.\dsh-studio.exe --export-diagnostics`，macOS 运行 `"/Applications/DSH Studio.app/Contents/MacOS/dsh-studio" --export-diagnostics`，Linux 运行 `dsh-studio --export-diagnostics`。

持久化日志位于应用数据目录的 `logs` 子目录。单文件达到 10 MiB 会轮转，七天前的日志会删除，日志总量限制为 200 MiB；设置页可选择 Debug、Info、Warning 或 Error 阈值，实时控制台不受该阈值影响。

如果 React renderer 在 12 秒内没有完成首次提交，或启动崩溃钩子更早触发，Studio 会打开
不加载 React、Harness、Node 或网络资源的静态原生恢复窗口，可重试界面、导出脱敏诊断包
或退出。

## 更新

应用读取 GitHub Release 的 `latest.json`；主源不可达时会回退到经过验证的官方 Pages 清单。应用只安装通过内置公钥验证的更新。正式发布流水线强制要求 Tauri 更新签名。完整配置平台凭据时会额外应用 Windows Authenticode 或 macOS Developer ID 签名、公证与票据装订；凭据只配置一部分时会失败关闭。

应用内更新继续使用普通轻量版通道；从完整离线版安装到应用数据目录的运行时不会因应用更新而丢失。

Windows 另提供独立的轻量便携版；macOS 通用轻量版同时支持 Intel 与 Apple 芯片。完整离线版内置原生 Node runtime，因此继续按芯片架构分别提供。

## 远程访问

远程访问默认关闭。开启后，LAN 网关使用一次性二维码为每台设备签发独立凭据；Harness 本身仍只监听回环地址。可以随时撤销单台设备。

遇到问题请先看[故障排查](troubleshooting.zh-CN.md)，仍无法解决时导出诊断报告后提交 issue。
