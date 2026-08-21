# Plugin and catalog development

[简体中文](plugin-development.zh-CN.md)

## Plugin packages

A plugin is a valid npm package that publishes a Harness profile patch and declares its compatible `@deepseek-ai/dsh` range in `peerDependencies`. Studio resolves an exact spec before installation and rejects incompatible or malformed ranges. Lifecycle behavior remains governed by npm/Harness; a discovery catalog cannot ask Studio to execute a command or grant build permission.

Cover empty profiles, duplicate install, remove/toggle, both peer-range edges, interrupted-mutation recovery, and Windows paths. Never publish credentials in the package, logs or catalog metadata.

## Standard catalog Schema 1.0.0

A custom catalog is a credential-free HTTPS JSON endpoint on port 443. Responses are limited to 2 MiB and 10,000 items. Cross-origin redirects, private/loopback/special-use addresses, and control characters are rejected.

```json
{
  "schemaVersion": "1.0.0",
  "items": [
    {
      "package": { "name": "@example/dsh-plugin" },
      "latestVersion": "1.2.3",
      "summary": "What the plugin adds",
      "publisher": { "name": "Example" },
      "updatedAt": "2026-08-21T00:00:00Z",
      "repository": { "url": "https://github.com/example/dsh-plugin" }
    }
  ]
}
```

Install commands, scripts, file paths, git specs and permission hints outside this contract are ignored. On install, Studio uses only `package.name@latestVersion` and performs an independent npm preflight.

## Desktop service contract

Pages served by the active loopback Harness origin can feature-detect `window.dshStudio`. Protocol 2 adds two frozen, public services alongside notifications, native pickers, badges and deep links:

```js
const roster = await window.dshStudio.profiles.list()
const selection = await window.dshStudio.profiles.select('web')
// selection.restartRequired is true; the running Harness is never killed silently.

await window.dshStudio.plugins.install({
  name: '@example/dsh-plugin',
  version: '1.2.3',
  displayName: 'Example plugin',
})
await window.dshStudio.plugins.remove('@example/dsh-plugin')
```

Plugin installs must use an exact immutable version. Studio re-resolves it through npm, checks Harness compatibility and registry integrity, verifies non-npm items are still present in the active catalog, then commits the profile mutation and market receipt in one recoverable transaction. Concurrent package operations are rejected. Profile selection persists the next profile but deliberately does not terminate live sessions; the caller must explain and initiate the restart as an explicit user action.

The bridge accepts requests only from a frame under this Studio window whose origin exactly matches the currently supervised loopback Harness. It does not expose raw Tauri IPC, shell execution, arbitrary pnpm arguments or filesystem access.
