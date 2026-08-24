# DSH Studio plugin interoperability contract

[简体中文](plugin-interoperability.zh-CN.md)

Status: **supported for DSH Studio 0.7.x**. The wire protocol is version 3, the
catalog schema is 1.0.0, and the SDK package follows the application version.
Normative words such as MUST, MUST NOT and SHOULD are used intentionally.

This contract keeps three different extension surfaces separate:

1. A **Harness Host plugin** runs local code under Harness and uses upstream
   Cordis services. Studio additionally offers read-only Host Protocol 1 for
   generation identity and bounded Profile discovery. It does not expose raw
   native, command-runner, package-manager, or Profile-mutation authority.
2. A **Harness Web Client plugin** runs in the supervised loopback page. It MAY
   feature-detect Protocol 3 through `@moresyl/dsh-studio-sdk`.
3. A **Studio-managed integration** is shipped and qualified with the pinned
   runtime. It is not a third-party privilege boundary and MUST fail closed when
   the expected upstream seam changes.

## Manifest and compatibility

A package offered through the Studio market MUST have a valid npm identity and
an exact published version. A Harness plugin SHOULD declare:

```json
{
  "peerDependencies": {
    "@deepseek-ai/dsh": "^0.1.0-rc.8"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

The market rejects malformed/incompatible peer ranges, deprecated releases,
missing SHA-512 registry integrity, and install-time lifecycle scripts. A
catalog MUST NOT weaken those rules. Standard catalogs use the published
[`catalog-1.0.0` JSON Schema](schemas/catalog-1.0.0.schema.json), but passing the
schema is only discovery validation; the two-phase native review remains the
installation authority.

## Capabilities and events

Plugins MUST call `hello()` and inspect `capabilities` before depending on an
optional desktop feature. Presence of `window.dshStudio` alone identifies a
compatible host only when `protocol === 3`; the SDK enforces that check.

Protocol 3 has two pushed event families:

- `onLink(handler)` delivers one parsed `dsh://` link. A link waiting at startup
  is consumed by the first `hello()` response.
- `workspace.onDrop(handler)` delivers one admitted native directory path to the
  qualified top-level Harness client. It is not a filesystem read permission.

Every subscription returns a disposer. A plugin MUST dispose listeners with its
own UI lifecycle and MUST feature-detect again after Harness navigation or
restart.

### Read-only Host Protocol 1

Host plugins MAY feature-detect `dshStudioHost` with
`getDshStudioHost(ctx)`. The service is immutable and scoped to one Cordis
generation. Its `profiles.current` identity cannot change in place, while
`profiles.list()` re-reads at most 128 safe, non-symlink Profile directories and
at most 256 KiB from each manifest. A malformed manifest is represented by the
stable `unreadable-manifest` state without exposing parser or filesystem
details.

The service advertises only `profiles.read` and `runtime.read`. Its explicit
restrictions keep arbitrary commands, native handles, package mutation, and
Profile mutation disabled. Retained references fail after their owning Cordis
fiber is disposed. Plugins MUST keep an ordinary Harness fallback and MUST NOT
infer authority from `DSH_DESKTOP` or other process environment values.

## Presentation, invocation and transport

The public presentation surface is `window.dshStudio`; there is no raw preload,
Tauri command or shell bridge. A plugin UI invokes methods using the frozen SDK
contract. Studio transports requests with `postMessage`, but message shapes are
an implementation detail and MUST NOT be constructed directly.

Studio accepts a call only when the sender is a descendant frame of the current
Studio window and the sender origin exactly equals the currently supervised
loopback Harness origin. A restart changes the origin and invalidates pending
calls. Native pickers are user-owned and may wait indefinitely; other calls have
a bounded deadline.

## Providers and composition

Third-party packages remain ordinary Harness plugins. They MUST use upstream
Host routes, RPC, services and slots for agent, session, model, tool and
workspace behavior. Desktop support SHOULD be an optional adapter:

```js
import { getDshStudio } from '@moresyl/dsh-studio-sdk'

export function mountDesktopAdapter(scope = window) {
  const desktop = getDshStudio(scope)
  if (!desktop) return () => {}
  return desktop.onLink((link) => {
    scope.dispatchEvent(new CustomEvent('plugin:desktop-link', { detail: link }))
  })
}
```

A cross-environment plugin MUST retain its ordinary Harness path when Studio is
absent. It MUST NOT guess a Profile, discover a private CLI, or interpret
`workspace.onDrop` as permission to open arbitrary files.

## Provenance, mutation and diagnostics

Catalog discovery, npm resolution and Profile mutation are separate phases.
Market install requires a visible review and a profile-bound, single-use,
two-minute token. Commit revalidates source membership, canonical repository
identity, exact npm metadata, compatibility, deprecation, lifecycle scripts and
SHA-512 integrity. Concurrent package mutations are rejected.

After success, Studio writes a receipt containing the exact source, provider,
package, version and integrity. A managed label is valid only while disk state
still matches that receipt. Profile control files have a durable before-image;
startup recovery reports an interrupted mutation instead of silently deleting a
user profile.

Diagnostics MUST redact secrets and bound every collection. Studio's diagnostic
archive includes public-safe runtime state, recent rotated logs and crash
evidence; it remains local until the user explicitly shares it. Plugins SHOULD
log stable error codes and non-secret facts rather than environment dumps,
tokens, registry headers or full prompt content.

## Versioning and compatibility promise

- Protocol additions that preserve all existing meanings MAY ship under
  Protocol 3. Removing a method, changing a result meaning or widening trust
  requires a protocol bump.
- Catalog Schema 1.0.0 ignores unsupported metadata. A new required field or new
  install authority requires a new schema version.
- SDK releases follow Studio versions and only describe a matching public
  protocol. Plugins SHOULD express the SDK as a development dependency when it
  is used only for types and feature detection.
- The managed runtime contract is exact. Unknown upstream graph or client-seam
  changes enter Repair instead of being accepted optimistically.

## Compatibility checklist

- Test ordinary browser/Harness absence and incompatible protocol versions.
- Test disposal after navigation and repeated mount/unmount.
- Test empty, malformed and boundary values for every public call.
- Test Profile switching as a restart boundary, not an in-place mutation.
- Test expired/replayed install reviews and interrupted mutation recovery.
- Test Windows paths and Linux/macOS case/normalization differences.
- Never require LAN remote access: it is off by default and is a separate,
  authenticated gateway while Harness remains loopback-only.
