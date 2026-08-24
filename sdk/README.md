# @moresyl/dsh-studio-sdk

Typed, dependency-free feature detection for DSH Studio Protocol 3. The SDK does
not create a privileged channel: it only describes and validates the narrow
`window.dshStudio` object that Studio injects into pages served by its active
loopback Harness.

```js
import { getDshStudio, hasDshStudioCapability } from '@moresyl/dsh-studio-sdk'

const desktop = getDshStudio(window)
if (desktop) {
  const offer = await desktop.hello()
  if (hasDshStudioCapability(offer, 'workspace')) {
    const chosen = await desktop.pick({ mode: 'directory' })
    if (chosen.path) console.log(await desktop.workspace.validate(chosen.path))
  }
}
```

Use `getDshStudio()` for plugins that also run in an ordinary browser or
headless Harness. Use `requireDshStudio()` only when the entire feature is
Desktop-specific. Never retain the object across a Harness navigation/restart;
feature-detect again in the new page.

The package version follows DSH Studio while the wire contract has its own
integer `protocol`. A protocol change is intentionally incompatible and must be
handled by a new SDK release. See the repository's bilingual
[plugin contract](../docs/plugin-development.md) for the trust boundary and
two-phase package policy.

## Harness Host plugins

Host plugins can feature-detect the separate, read-only Host Protocol 1. It
exposes the active generation's Studio/Harness versions and a bounded Profile
roster. It deliberately cannot start commands, access native handles, install
packages, or mutate Profiles.

```js
import { getDshStudioHost } from '@moresyl/dsh-studio-sdk'

export const inject = []

export function apply(ctx) {
  const studio = getDshStudioHost(ctx)
  if (!studio) return
  ctx.logger.info(
    `running in ${studio.studio.name} ${studio.studio.version} ` +
      `with ${studio.profiles.list().length} profiles`,
  )
}
```

Use the normal Harness services for agent, model, session, tool, and workspace
behavior. Package or Profile changes must continue through Studio's visible,
receipt-backed native flows rather than a retained Host reference.
