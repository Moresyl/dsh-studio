# DSH Studio documentation

DSH Studio is a native desktop shell for DeepSeek Harness. Use this page to
choose the shortest path to a working installation.

## Choose a path

### I want to use Studio

- [User guide](user-guide.md) — install the runtime, create a Profile, open a terminal, and update safely.

### Something is not working

- [Troubleshooting](troubleshooting.md) — startup, plugin installation, networking, workspace, and recovery checks.
- [Support and verification matrix](support-matrix.md) — what is verified on each platform and what still needs a real device.

### I want to extend Studio

- [Plugin development](plugin-development.md) — package and validate a compatible plugin.
- [Plugin interoperability](plugin-interoperability.md) — Host Protocol 1 and safety boundaries.
- [Architecture](architecture.md) — process ownership, runtime isolation, and recovery design.
- [Roadmap](ROADMAP.md) — shipped capabilities and independently verifiable gaps.

## Five-minute first run

1. Install the package for your operating system from the [latest release](https://github.com/Moresyl/dsh-studio/releases/latest).
2. Open **Environment** and let Studio install or verify the managed Node and Harness runtime.
3. Start the Harness, then create a Profile only after the runtime health check is green.
4. If a recovery prompt appears, use **Repair** before deleting a Profile; it preserves user data where possible.

## Support contract

When reporting a problem, include the app version, operating system, selected
Profile, the first error line, the exact action that triggered it, and an
exported redacted diagnostic bundle. Never include API keys, session tokens, or
the contents of private workspaces.

[简体中文文档](index.zh-CN.md)
- [Support and verification matrix](support-matrix.md)
