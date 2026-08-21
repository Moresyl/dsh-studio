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
