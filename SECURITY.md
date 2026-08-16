# Security Policy

## Supported versions

DSH Studio is pre-1.0. Only the latest release gets fixes; there are no
maintained older branches.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅        |
| Anything older | ❌        |

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private reporting — [Security → Report a vulnerability][advisory]
on this repository. That creates a private advisory only the maintainers can
see.

Useful things to include: what an attacker would need in order to reach the
issue, what they gain, and the platform and version you saw it on. A proof of
concept helps, but a clear description of the mechanism is worth more than a
working exploit.

You should get a first response within a week. If a fix is warranted, the
advisory will be published alongside the release that carries it, and you will
be credited unless you would rather not be.

[advisory]: https://github.com/Moresyl/dsh-studio/security/advisories/new

## What this project is responsible for

DSH Studio launches and supervises a local service. It is a shell around
software it does not own, so the boundary is worth stating plainly.

**In scope — the shell's own behaviour:**

- The service's network exposure. It is bound to `127.0.0.1` with a
  kernel-assigned port, and neither is configurable. Anything that widens that
  binding is a vulnerability in this project.
- The remote access gateway. Reaching the harness from another device does not
  move the service — a separate listener proxies to it, and it holds to four
  rules: it is off until switched on, it binds one chosen address rather than
  `0.0.0.0`, it forwards nothing without the token minted for that session, and
  that token lives in memory for the life of the session and is never written to
  disk or into a log. A way to make it forward without a valid token, to reach
  it from an address it did not bind, to recover the token from anything it
  leaves behind, or to keep it open after the harness stops, is a vulnerability
  in this project.
- The frontend capability surface in `src-tauri/capabilities/default.json` and
  the CSP in `src-tauri/tauri.conf.json`. The harness is loaded in a frame from
  its own origin and must not be able to reach Tauri commands.
- Subprocess handling. The install path invokes `npm-cli.js` through the
  detected Node binary directly and never through a shell; anything that
  reintroduces shell interpolation of a path is a bug in this project.
- Process reclamation. A process that survives the shell is a correctness bug
  and, depending on what it is, a security one.
- The release pipeline and what ends up inside the installers.

**Out of scope:**

- Vulnerabilities in DeepSeek Harness itself. It is installed from npm,
  unmodified, and belongs to [its own project][upstream]. Report those there.
- The agent's designed ability to run commands and edit files. That is what the
  harness is for; the shell's job is to control who can reach it, not to sandbox
  what it does.
- A pairing link that was given away. Whoever holds it holds the session, which
  is why the app offers to copy it rather than display it — but where it goes
  after that is a decision, not a defect. Close remote access to invalidate it.
- Plugins you chose to install. They run inside the harness with everything the
  harness has; the marketplace reports what a package declares, and installing
  it is still trusting its author.
- Anything requiring an attacker who already has code execution as your user.
  At that point they can run `dsh` themselves.

[upstream]: https://github.com/deepseek-ai/deepseek-harness

## A note on unsigned builds

macOS builds are currently **not signed or notarized**, and Windows builds are
**not signed** either. This means the operating system cannot verify for you
that an installer came from this project and was not tampered with in transit.

Until signing is in place, download only from the [Releases page][releases] on
this repository, and treat installers from anywhere else as untrusted.

[releases]: https://github.com/Moresyl/dsh-studio/releases

---

## 中文摘要

**请不要用公开 issue 报告安全问题**，改用 GitHub 的私密报告入口：
本仓库的 [Security → Report a vulnerability][advisory]。一周内会有首次回复。

范围上说清楚一点：本项目负责的是**外壳自身的行为**——
服务只绑定回环地址且端口由内核分配（两者都不可配置）、
前端能力面与 CSP（harness 在 frame 里加载，不得够到 Tauri 命令）、
子进程调用不经过 shell、进程树能被彻底回收，以及发布流水线产出的内容。

远程访问同样在范围内。它不会挪动服务，而是另起一个监听去代理，并守四条规矩：
默认关闭、只绑定选定的那一个地址而不是 `0.0.0.0`、
没有本次会话现铸的令牌就不转发任何字节、
令牌只活在内存里且从不落盘也不进日志。
能让它在没有有效令牌时转发、能从它没绑定的地址够到它、
能从它留下的任何东西里还原出令牌，或者能让它在 harness 停掉之后仍然开着——
这些都是本项目的漏洞。

DeepSeek Harness 本身的漏洞不在范围内——它是原样从 npm 安装的，
请到[上游项目][upstream]报告。agent 能执行命令、能改文件，这是它的设计意图，
不是漏洞；外壳的职责是管住「谁够得着它」，而不是给它做沙箱。
配对链接被交出去也不算漏洞：拿到它的人就等于拿到了这次会话，
所以应用只提供「复制」而不把它显示出来——但它之后去了哪里是一个决定，不是一个缺陷，
关掉远程访问即可让它作废。你自己选择安装的插件同理：
它们在 harness 里跑，拥有 harness 的一切；
市场会如实报出一个包声明了什么，但装下去仍然等于信任它的作者。

另外：目前 macOS 版本**未签名未公证**，Windows 版本**未签名**，
所以系统无法替你验证安装包确实来自本项目且未被篡改。
在签名到位之前，请只从本仓库的 [Releases][releases] 下载。
