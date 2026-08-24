# Mirrors

Every download link on the site points at GitHub Releases. That is the only place
DSH Studio is published from, and every checksum in this repository describes a
file served from there.

From parts of the world — mainland China most of all — GitHub's release CDN is
slow or unreachable, and a 78 MB AppImage over a connection that resets is not a
download anyone completes. A mirror fixes that. It also moves the file through a
machine nobody here controls, so this page is mostly about the one step that makes
that safe.

## Verify what a mirror gave you

A mirror can serve you anything. The only thing that makes it trustworthy is that
the bytes hash to what the build produced, and the hashes are published by the
release workflow, not by the mirror.

Releases carry a `SHA256SUMS.txt` next to the binaries. Download it from
**github.com**, not from the mirror — otherwise a mirror that changed the binary
can hand you a matching checksum and you have verified nothing.

```sh
# Linux, macOS
sha256sum -c SHA256SUMS.txt --ignore-missing
```

```powershell
# Windows. Wildcarded because the filenames carry a version:
# DSH.Studio_0.4.0_x64-setup.exe
Get-FileHash .\DSH.Studio_*_x64-setup.exe -Algorithm SHA256
```

```powershell
# ...then compare it against the line for that file:
Select-String -Path .\SHA256SUMS.txt -Pattern 'x64-setup\.exe'
```

v0.4.0 has no `SHA256SUMS.txt`: the job that writes it was added to the release
workflow after that release was cut. For v0.4.0 the digests in this directory's
manifests are the record — they were taken from the published assets — and every
release after it has the file.

A mismatch is not a corrupted download to retry. Delete the file and get it from
GitHub.

The updater checks its own mandatory Tauri signature in addition to the
checksum. Windows Authenticode and Apple Developer ID signing/notarization are
separate protections and exist only on a release whose platform credentials were
configured and whose release verification proved them. Do not infer an OS
publisher signature from the file extension. `.deb`, `.rpm` and `.AppImage` have
no platform publisher-signature contract here, so the published checksum is the
download-integrity guarantee for those assets.

## Package managers need no mirror

Scoop, winget, Homebrew and AUR all carry the SHA-256 in the manifest and refuse
an install that does not match it — see the manifests in this directory. If a
package manager works for you at all, it is the better route: the verification is
not something you have to remember to do.

## Adding one

There is no mirror list in this repository yet, and no third-party GitHub proxy is
recommended here — those services appear and vanish, and endorsing one would put
this project's name behind a host it does not run.

If you maintain a mirror and want it listed, open a pull request that adds it
below with:

- **The URL pattern**, using `{tag}` and `{file}` — for example
  `https://mirror.example.org/dsh-studio/{tag}/{file}`.
- **Who runs it**, and where to report that it is broken.
- **How it syncs**, and how far behind a release it can be.
- **Confirmation that it mirrors bytes unchanged**, so the published checksums
  still apply. A mirror that repacks or re-signs anything is not a mirror.

Listing is not an endorsement, and the verification step above still applies.
The one thing that will get an entry removed without discussion is serving a file
whose hash does not match the release.

<!-- Mirror list goes here. Empty on purpose: see above. -->
