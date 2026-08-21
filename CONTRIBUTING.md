# Contributing to DSH Studio

Thanks for looking. This is a small project with a small number of firm
opinions, and this file is where they are written down so a pull request does
not have to discover them in review.

[简体中文](CONTRIBUTING.zh-CN.md)

## Getting set up

You need **Node.js 22.19+**, **pnpm 10**, and a **stable Rust toolchain**. On
Windows that also means the MSVC build tools; on Linux, the WebKitGTK
development packages:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
pnpm install
pnpm tauri dev
```

The first Rust build takes a few minutes. After that it is incremental. Front
end changes hot-reload; Rust changes rebuild and relaunch the window.

> `pnpm dev` on its own starts only Vite. The page it opens in a browser has no
> Tauri APIs, so the UI will fail immediately. Always use `pnpm tauri dev`.

The dev server binds port 1420 and will not fall back to another one, because
`devUrl` in `src-tauri/tauri.conf.json` is a fixed URL that the Rust side cannot
follow. If the port is taken, find out by what — it is often another Tauri
project, since 1420 is the template default.

## Before you open a pull request

Run all four. CI runs the same set on Linux, Windows and macOS, and a red CI is
the only thing that will hold a review up mechanically:

```sh
pnpm lint                                          # ESLint, zero warnings
pnpm exec tsc --noEmit                             # strict TypeScript
pnpm test                                          # store and i18n behaviour
cargo test --manifest-path src-tauri/Cargo.toml --workspace
```

Formatting is not negotiable but it is also not your problem — run
`pnpm format` and `cargo fmt --all` and move on.

## House rules

**Comments explain _why_, not _what_.** A comment that restates the line below
it is noise that will go stale. A comment that records the reason a thing is
unusual is the most valuable text in the file. If a line looks wrong and is
not, say why it isn't.

**No suppression in place of a fix.** No `@ts-ignore`, no `as any`, no
`.skip`ped test, no empty `catch`, no sleeping until a race stops reproducing.
If something needs suppressing, the reason belongs in the pull request, not
hidden in the diff.

**Both languages, always.** `src/lib/i18n.ts` derives the type of the Chinese
dictionary from the English one, so a missing translation is a build error
rather than a blank label someone finds later. Add both.

**Loopback is not a setting.** The service binds `127.0.0.1` and takes its port
from the kernel. Neither is configurable, and a pull request making either one
configurable needs to argue the security case first: the harness can run shell
commands.

**Don't fork upstream into this repo.** Nothing from the harness is vendored or
patched here — that is the whole architectural bet. Extensions to the harness UI
should go through its own client-plugin system.

## Commit messages

Commits here are `类型: 简短描述` — a type, a colon, and a short description in
Chinese:

```
功能: 托盘常驻、关闭到托盘与全新应用图标
修复: Node 版本目录解析出同一版本时按路径定序
重构: 界面改为桌面软件形态，端口读数移入底部状态栏
构建: 补上缺失的 Prettier 配置并统一格式
```

Types in use: `功能` `修复` `重构` `构建` `测试` `文档` `ci`.

If Chinese is not a language you write, English is fine — a clear message in a
language you actually speak beats a mechanical translation. Use the same shape:
`fix: `, `feat: `, and so on.

The body is for the reasoning. What changed is visible in the diff; why it
changed is not.

## Where things live

```
src/                       React 19 + Tailwind 4 shell UI
src-tauri/src/harness/     supervisor, readiness parsing, health probe, install
src-tauri/src/tray.rs      tray icon and its menu
src-tauri/crates/
  node-runtime/            find a usable Node on this machine
  proc-guard/              kill a process tree and mean it
```

`node-runtime` and `proc-guard` know nothing about Tauri or about this app, and
should stay that way. If a change to either one needs to reach for something
app-specific, that is a sign the change belongs above them instead.

## Reporting bugs

Please include your OS and version, how you installed Node, and whether the
service was running at the time. If the shell logged anything, the output pane
is selectable — copy it in.

Anything that leaves a process behind after the window closes is worth a report
on its own, with as much detail as you can get about what was running.

For anything with security implications, see [SECURITY.md](SECURITY.md) rather
than opening a public issue.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE), the same as the rest of the project.
