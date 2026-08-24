# Plugin and catalog development

[简体中文](plugin-development.zh-CN.md)

## Plugin packages

A market-installable plugin is a valid npm package that publishes a Harness
profile patch and declares its compatible `@deepseek-ai/dsh` range in
`peerDependencies`. Studio resolves one exact published version before it can
change a profile. Exact SemVer prereleases such as `1.2.3-rc.1` are supported;
ranges, tags and build metadata are not exact catalog identities. It rejects an
incompatible or malformed peer range, a publisher deprecation, missing SHA-512
registry integrity, and any package that declares `preinstall`, `install`,
`postinstall`, or `prepare`.

Catalogs are discovery inputs, not package authorities. They cannot ask Studio
to execute a command, grant build permission, accept a range or tag, install a
Git source, or pass package-manager arguments. A non-npm catalog item must also
publish a canonical HTTPS repository backlink that matches the npm manifest.

Tests should cover empty profiles, duplicate install, remove/toggle, both
peer-range edges, lifecycle-script rejection, stale previews, interrupted
mutation recovery, and Windows paths. Never publish credentials in the package,
logs, catalog metadata, or example configuration.

## Standard catalog Schema 1.0.0

A custom catalog is a credential-free HTTPS JSON endpoint on port 443.
Responses are limited to 2 MiB and 10,000 items. Redirects must keep the
registered origin. Private, loopback and special-use addresses, control
characters and DNS answers that fail the public-address check are rejected.

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
      "repository": { "url": "https://github.com/example/dsh-plugin" },
      "media": {
        "icon": { "url": "https://catalog.example/icons/dsh-plugin.png" }
      }
    }
  ]
}
```

Only the fields above participate in discovery. Install commands, scripts,
paths, Git specs and permission hints are ignored. `latestVersion` is only a
suggestion and must be an exact SemVer, including an optional prerelease:
preview and commit both re-resolve
`package.name@latestVersion` through the configured npm registry.

### Restricted media

An icon is optional and never affects whether the item appears. Standard
catalog icons must be same-origin with the registered endpoint. Reviewed
adapters may declare a small explicit host set. Studio resolves every host to a
public address without using an ambient proxy, follows at most two approved
redirects, accepts only PNG, JPEG or WebP, and limits input to 2 MiB, 4096 pixels
on either side and 16 million pixels in total. It then decodes and re-encodes a
metadata-free 96-pixel PNG data URL. The renderer never receives the remote URL.

## Two-phase market installation

1. Preview resolves the exact npm manifest and displays compatibility,
   lifecycle hooks, deprecation, repository backlink and SHA-512 integrity.
2. A successful preview returns a profile-bound, single-use token that expires
   after two minutes.
3. Commit consumes that token once, re-reads the active source and exact npm
   manifest, and repeats every trust check before starting the package command.
4. Studio serializes profile mutations, snapshots the profile control files,
   records the exact source/version/integrity receipt after success, and restores
   the before-image after interruption or failure.

A successful preview is therefore not a permanent approval. Source changes,
profile changes, expiry, replay, catalog removal, repository drift or registry
drift all stop the commit and require a new review.

## Desktop service contract — Protocol 3

Pages served by the active loopback Harness origin can feature-detect the frozen
`window.dshStudio` object. A browser tab does not receive it. The current
capability surface is:

| Service     | Supported operations                                |
| ----------- | --------------------------------------------------- |
| Root        | `hello`, `notify`, native `pick`, `badge`, `onLink` |
| `profiles`  | `list`, `select`                                    |
| `plugins`   | exact-version `install`, `remove`                   |
| `workspace` | native admission `validate`, folder-drop `onDrop`   |

```js
const desktop = window.dshStudio
if (!desktop || desktop.protocol !== 3) return

const roster = await desktop.profiles.list()
const selection = await desktop.profiles.select('web')
// selection.restartRequired is true; the running Harness is never killed silently.

const chosen = await desktop.pick({ mode: 'directory' })
if (chosen.path) {
  const admission = await desktop.workspace.validate(chosen.path)
  if (!admission.allowed) throw new Error(admission.reason)
}

const stopDrop = desktop.workspace.onDrop((path) => {
  // The managed Harness client uses this signal to create/open a real workspace.
  console.log(path)
})

await desktop.plugins.install({
  name: '@example/dsh-plugin',
  version: '1.2.3',
  displayName: 'Example plugin',
})
await desktop.plugins.remove('@example/dsh-plugin')
stopDrop()
```

Profile selection persists the next profile but deliberately does not terminate
live sessions. The caller must explain and initiate a restart as an explicit
user action. Third-party plugins should normally use upstream Harness workspace
services; `workspace.onDrop` is a narrow native signal used by the qualified
managed client integration, not a general filesystem grant.

The bridge accepts requests only from a descendant frame of this Studio window
whose origin exactly matches the currently supervised loopback Harness. It does
not expose raw Tauri IPC, shell execution, arbitrary pnpm arguments or arbitrary
filesystem access. Calls other than a user-owned native picker have a bounded
deadline, and a Harness restart establishes a new origin and trust boundary.

## Upstream compatibility

Studio does not maintain a source fork or reimplement Harness. The managed
runtime is pinned to an execution-qualified upstream release and carries one
small Studio integration bundle. During installation, the exact locked browser
picker seam is transformed deterministically so that native directory selection
and folder drops reach the upstream workspace service. The runtime contract
checks both the upstream graph and the expected transformed seam. If a future
upstream release moves that seam, Studio enters **Repair** instead of modifying
unknown code silently.
