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
  move the service — a separate listener proxies to it, and it holds to five
  rules: it is off until switched on; it binds one chosen address rather than
  `0.0.0.0`; it forwards nothing without a credential this session minted; the
  code a QR symbol carries is good for one device and two minutes, after which
  it buys nothing; and every credential lives in memory for the life of the
  session, never reaching disk or a log. Forgetting a device revokes its
  credential and ends what that device already had open. A way to make the
  gateway forward without a valid credential, to spend a pairing code twice or
  after it lapsed, to keep being served after being forgotten, to reach the
  listener from an address it did not bind, to recover a credential from
  anything it leaves behind, or to keep it open after the harness stops, is a
  vulnerability in this project.
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
- A pairing link that was given away while it was still good. It is single-use
  and lasts two minutes, but inside that window whoever redeems it walks away
  with a credential of their own — so passing it on is a decision, not a defect.
  Forget the device to take that credential back.
- Plugins you chose to install. They run inside the harness with everything the
  harness has; the marketplace reports what a package declares, and installing
  it is still trusting its author.
- Anything requiring an attacker who already has code execution as your user.
  At that point they can run `dsh` themselves.

[upstream]: https://github.com/deepseek-ai/deepseek-harness

## Why the LAN listener speaks plain HTTP

The gateway is not encrypted, and that is a decision rather than an omission.

Any certificate this project could ship would be self-signed, and it would have
to cover an IP address that changes with the network and a port the kernel
picks fresh every session. No browser trusts that, so every pairing would open
with a full-page interstitial and a button meaning "proceed anyway" — every
time, because the origin is never the same twice and the exception the user
grants never sticks. Teaching someone to click through certificate warnings on
their own network is worth more to an attacker than that encryption is worth to
them.

So the gap is closed from the other side: a pairing code that is single-use and
short-lived, a credential per device rather than one shared secret, and
revocation that reaches connections already open. Someone watching the same
Wi-Fi cannot replay a code after it has been spent, and a device that should
not have paired can be removed without disturbing the ones that should.

What remains uncovered is confidentiality against an attacker already on your
network. If you need that, put the traffic inside something that does it
properly — a VPN, or an SSH tunnel to this machine — and leave remote access
switched off.

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

远程访问同样在范围内。它不会挪动服务，而是另起一个监听去代理，并守五条规矩：
默认关闭、只绑定选定的那一个地址而不是 `0.0.0.0`、
没有本次会话现铸的密钥就不转发任何字节、
二维码里的配对码只能配一台设备且两分钟后作废、
所有密钥都只活在内存里且从不落盘也不进日志。
移除一台设备会吊销它那把密钥，并顺手掐断它已经建立的连接。
能让它在没有有效密钥时转发、能把一个配对码用第二次或在失效后再用、
能让被移除的设备继续得到服务、能从它没绑定的地址够到它、
能从它留下的任何东西里还原出密钥，或者能让它在 harness 停掉之后仍然开着——
这些都是本项目的漏洞。

DeepSeek Harness 本身的漏洞不在范围内——它是原样从 npm 安装的，
请到[上游项目][upstream]报告。agent 能执行命令、能改文件，这是它的设计意图，
不是漏洞；外壳的职责是管住「谁够得着它」，而不是给它做沙箱。
配对链接在有效期内被交出去也不算漏洞：它一次性、只活两分钟，
但在这两分钟里，兑换它的人会拿到一把属于自己的密钥——
它之后去了哪里是一个决定，不是一个缺陷，在设备列表里移除那台设备即可收回。
你自己选择安装的插件同理：
它们在 harness 里跑，拥有 harness 的一切；
市场会如实报出一个包声明了什么，但装下去仍然等于信任它的作者。

局域网这一段是明文 HTTP，这是决定而不是遗漏。
本项目能自带的证书只可能是自签的，而它要覆盖的是一个随网络变化的 IP
和一个每次会话由内核现分配的端口——浏览器不会信任这种证书，
于是每一次配对都得先过一整页「仍要继续」的警告，而且每一次都要过，
因为源地址从不重复，用户点下的例外也就从不生效。
把「点掉证书警告」训练成习惯，对攻击者的价值高于这层加密对用户的价值。
所以这道缺口是从另一侧补的：配对码一次性且短命、每台设备各持一把密钥、
吊销能打断已经建立的连接。
真正没被覆盖的是「攻击者已经在你的网络里」时的机密性；
如果你需要这一层，请把流量放进本来就做这件事的东西里——
VPN，或者到本机的 SSH 隧道——并让远程访问保持关闭。

另外：目前 macOS 版本**未签名未公证**，Windows 版本**未签名**，
所以系统无法替你验证安装包确实来自本项目且未被篡改。
在签名到位之前，请只从本仓库的 [Releases][releases] 下载。
