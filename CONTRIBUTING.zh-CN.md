# 参与 DSH Studio

谢谢你点进来。这是个小项目，但有几条立场很硬的规矩；
把它们写在这里，是为了让一个 PR 不必等到 review 时才发现它们。

[English](CONTRIBUTING.md)

## 搭环境

你需要 **Node.js 22.19+**、**pnpm 10**，以及**稳定版 Rust 工具链**。
Windows 上还需要 MSVC 生成工具；Linux 上需要 WebKitGTK 的开发包：

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

然后：

```sh
pnpm install
pnpm tauri dev
```

第一次 Rust 编译要几分钟，之后是增量的。
前端改动热更新；Rust 改动会自动重编并重启窗口。

> 只跑 `pnpm dev` 启动的仅仅是 Vite。它在浏览器里打开的那个页面没有 Tauri API，
> 界面会立刻报错。请始终用 `pnpm tauri dev`。

开发服务器固定绑定 1420 端口，且不会退让到别的端口，
因为 `src-tauri/tauri.conf.json` 里的 `devUrl` 是一个写死的 URL，Rust 端跟不了。
如果端口被占，先查清楚是被谁占的——很多时候是另一个 Tauri 项目，
因为 1420 是模板默认值。

## 提 PR 之前

这四条都跑一遍。CI 会在 Linux、Windows、macOS 上跑同样的一套，
而 CI 红了是唯一会机械性卡住 review 的事：

```sh
pnpm lint                                          # ESLint，零警告
pnpm exec tsc --noEmit                             # 严格模式 TypeScript
pnpm test                                          # store 与 i18n 行为
cargo test --manifest-path src-tauri/Cargo.toml --workspace
```

格式没得商量，但也不需要你操心——
跑一下 `pnpm format` 和 `cargo fmt --all` 就行。

## 家规

**注释解释「为什么」，不是「是什么」。**
复述下一行在做什么的注释是噪音，而且早晚会过期；
记录某处为何反常的注释，是整个文件里最有价值的文字。
如果一行代码看着像错的但其实不是，把原因写下来。

**不许用「压制」代替「修复」。**
不要 `@ts-ignore`，不要 `as any`，不要 `.skip` 掉测试，不要空的 `catch`，
也不要靠加 sleep 把一个竞态睡到不复现。
如果确实必须压制，理由要写在 PR 里，而不是藏在 diff 里。

**两种语言，一次都不能少。**
`src/lib/i18n.ts` 里中文词典的类型是从英文推导出来的，
所以漏一条翻译是编译错误，而不是过很久才被人发现的一个空标签。两边都要加。

**回环地址不是一个配置项。**
服务绑定 `127.0.0.1`，端口由内核分配。这两件事都不可配置；
想让其中任何一个变成可配置的 PR，得先把安全上的道理讲清楚——
harness 是能执行 shell 命令的。

**不要把上游 fork 进这个仓库。**
这里没有 vendor 任何 harness 的代码，也没有打补丁——这是整个架构押的注。
要扩展 harness 界面，应该走它自己的客户端插件系统。

## 提交信息

本仓库的提交是 `类型: 简短描述` —— 类型、冒号、一句中文短描述：

```
功能: 托盘常驻、关闭到托盘与全新应用图标
修复: Node 版本目录解析出同一版本时按路径定序
重构: 界面改为桌面软件形态，端口读数移入底部状态栏
构建: 补上缺失的 Prettier 配置并统一格式
```

在用的类型：`功能` `修复` `重构` `构建` `测试` `文档` `ci`。

如果中文不是你会写的语言，用英文完全可以——
一句你真正说得出口的清楚描述，胜过一句机器翻译。形式保持一致即可：
`fix: `、`feat: ` 等等。

正文留给推理过程。改了什么 diff 里看得见，为什么改看不见。

## 代码在哪

```
src/                       React 19 + Tailwind 4 外壳界面
src-tauri/src/harness/     supervisor、就绪行解析、健康探测、安装
src-tauri/src/tray.rs      托盘图标与菜单
src-tauri/crates/
  node-runtime/            在本机找出一个可用的 Node
  proc-guard/              杀进程树，而且是真的杀干净
```

`node-runtime` 和 `proc-guard` 不知道 Tauri 的存在，也不知道这个应用的存在，
并且应该一直如此。如果对它们的改动需要伸手去够某个「本应用特有」的东西，
那说明这个改动该待在它们上面那一层。

## 报告问题

请附上你的操作系统与版本、Node 是怎么装的、以及当时服务是否在运行。
如果外壳打印了日志，输出面板里的文字是可以选中的，请一并复制进来。

任何「关掉窗口之后还有进程残留」的现象，都值得单独提一个 issue，
并尽量说清楚当时在跑什么。

涉及安全的问题，请看 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 许可

提交贡献即表示你同意你的贡献以 [MIT License](LICENSE) 授权，
与项目其余部分一致。
