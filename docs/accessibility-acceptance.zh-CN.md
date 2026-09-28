# 无障碍验收

[English](accessibility-acceptance.md)

DSH Studio 把无障碍能力作为发布合同，而不是一次性的视觉检查。`pnpm verify:a11y`
会静态拒绝没有辅助名称的按钮、无法用键盘操作的 `role="button"` 控件，以及没有名称或
不具备模态语义的对话框；它还会强制检查可见焦点、减少动画和强制颜色规则，并已进入
`pnpm test:release`。

自动化能抓住结构退化，但不能证明屏幕阅读器播报质量或操作系统的实际渲染。每个候选版本
都应执行下列短矩阵，并把结果随构建证据保存：

| 范围 | 验收标准 |
| --- | --- |
| 键盘 | 不用鼠标即可到达全部命令、标签页、菜单、开关、列表项和对话框；焦点始终可见，模态焦点不会逃逸，Escape 可关闭，关闭后焦点回到触发控件。 |
| 屏幕阅读器 | 在 Windows Narrator 下核验窗口/面板标题、当前标签、开关、状态变化、错误详情、危险确认和终端标签；具备 macOS 真机后再用 VoiceOver 验收。 |
| 200% 缩放 | 操作系统文字/显示缩放为 200% 时，必要控件和错误信息不被裁切；面板可滚动、对话框可操作。 |
| 减少动画 | 开启系统减少动画后，过渡与动画立即收敛，不隐藏内容或焦点。 |
| 高对比度 | Windows 高对比度下，边界、焦点、选中/当前态、禁用态和失败控件不依赖自定义颜色也能区分。 |
| 错误恢复 | 分别触发无效终端启动、Harness 端口占用、插件预览/安装失败和更新网络失败；显式操作必须出现可选择、可复制的弹窗，后台刷新保持非模态。 |

终端还需检查键盘复制/粘贴、标签辅助名称，以及关闭一个标签后焦点能回到仍存在的控件。
xterm 的流式正文属于第三方界面；外围 DSH Studio 原生壳仍受上述合同约束。

目前没有 Apple 设备。macOS 构建和 headless 测试只能作为兼容性证据，不能声称 VoiceOver、
缩放、通知、终端或安装器流程已经通过真机验收。

## 隔离桌面回归

构建调试版 QA 应用时，使用独立的 Tauri 标识、应用名称和深链接协议。启动时指定独立的
`DSH_STUDIO_DATA_DIR`、`DSH_HOME` 和 `DSH_STUDIO_WEBVIEW_DEBUG_PORT=9223`，不要复用
日常安装的数据目录。QA 数据目录中应已安装运行时。这些脚本都会先核对实际配置路径，
再执行修改。

```powershell
node .github/scripts/desktop-regression.mjs --port=9223 --minutes=20 --qa-home=D:/qa/home --output=D:/qa/ui-results
node .github/scripts/desktop-ipc-regression.mjs D:/qa/home D:/qa/native-results 9223
node .github/scripts/desktop-terminal-regression.mjs D:/qa/home D:/qa/terminal-results 9223
node .github/scripts/desktop-runtime-regression.mjs D:/qa/home D:/qa/runtime-results 9223
node .github/scripts/desktop-preferences-regression.mjs D:/qa/home D:/qa/preference-results 9223
node .github/scripts/desktop-keyboard-regression.mjs D:/qa/home D:/qa/keyboard-results 9223
node .github/scripts/desktop-worktree-regression.mjs D:/qa/home D:/qa/worktree-results 9223
node .github/scripts/desktop-worktree-failure-regression.mjs D:/qa/home D:/qa/worktree-failure-results 9223
node .github/scripts/desktop-session-regression.mjs D:/qa/home D:/qa/session-results 9223 bounded
node .github/scripts/desktop-session-regression.mjs D:/qa/home D:/qa/session-limit-results 9223 limited
```

界面脚本检查七个壳页面、横向溢出、插件卡片语义、弹窗焦点及 Escape 恢复，以及未捕获的
WebView 异常。定时运行保留截图和 DOM/堆内存数据；这些采样本身不能证明不存在泄漏。
原生命令脚本通过真实 WebView ACL 检查配置往返导入导出、自定义智能体包、会话搜索/
导出/归档，以及真实 PTY。它创建唯一的 QA 样本，结束后清理临时配置、样本和终端；导出
文件与结果报告保留在指定输出目录。所有脚本按顺序运行，界面回归期间不要操作同一 QA 窗口。

这些检查用于补充人工矩阵，不涵盖模型服务商凭据、真实外部 SSH 账户、Narrator 或 macOS 真机。

键盘脚本要求只打开一个隔离 QA 窗口。它使用真实 CDP 按键事件，检查七个页面中可见且启用的
选择框：方向键循环、Home/End、选中项可见性、菜单窗口边界、Escape 焦点归还，以及不改变
选择的 Tab 关闭；同时检查命令面板的打开和关闭。报告记录实际选项数量，应在目录加载完成后
运行，以覆盖长分类菜单，而不只是初始占位选项。

终端脚本还会拒绝已有运行中 Shell 的 QA 窗口。它通过界面创建 5 个真实 PTY，检查布局
分组、输出保留、页面往返、异常退出记录、尺寸更新安全性和右键菜单操作目标，然后关闭
自己创建的终端。不要与其他界面脚本并行运行。布局偏好保存检查不代表应用重启恢复
已经验证；应单独重启验收，并确认不会自动创建 Shell。

运行时脚本交错执行真实启停与界面重新检测，对照原生状态和当前可用操作按钮；结束后
恢复原先的运行/停止状态，不发送模型请求。偏好脚本检查持久写入和同窗口重载，不单独
证明整个应用进程重启。工作树脚本要求先停止 Harness，保留隔离 Git 证据并恢复原工作区；
失败脚本只暂时使自身样本的 Git 目录不可用，再恢复并重试。

会话脚本创建独占本地样本，验证 4,000 条消息分页或 33 MiB 部分日志，以及导出、小窗口
和强制颜色显示，随后清理自身样本。中断的定时测试不算完整持续运行验收；修改候选版后
应重新执行完整时长。

可在同一次 CDP 连接中核对视口尺寸并捕获减少动画或强制颜色模式，避免连接关闭后覆盖失效。
以下为浏览器模拟检查，不能代替 Windows 系统设置下的人工验收：

```powershell
node .github/scripts/desktop-ui-acceptance.mjs 9223 viewport 900 620 D:/qa/contrast.png forced-colors
node .github/scripts/desktop-ui-acceptance.mjs 9223 viewport 900 620 D:/qa/motion.png reduced-motion
```
