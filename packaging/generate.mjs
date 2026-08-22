#!/usr/bin/env node
/*
 * Rewrites every package-manager manifest in this directory from a published
 * release.
 *
 *   node packaging/generate.mjs            # the newest release
 *   node packaging/generate.mjs v0.4.0     # a particular one
 *
 * Five registries want the same three facts — a version, a URL and a SHA-256 —
 * in five shapes, and every one of them silently installs the wrong thing if a
 * digest is stale. Writing them by hand is how a bucket ends up pointing at
 * last month's build, so nothing here is meant to be edited: change this script
 * and re-run it.
 *
 * Digests come from the release's own SHA256SUMS.txt when it has one, because
 * that file is written by the workflow that produced the binaries. When it does
 * not — a release cut before that job existed — the assets are downloaded and
 * hashed here instead, which is slower but gives the same answer.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeUpdaterManifest } from './updater-manifest.mjs'

const OWNER = 'Moresyl'
const REPO = 'dsh-studio'
const IDENTIFIER = 'io.github.moresyl.dshstudio'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SHORT_DESCRIPTION = 'Native desktop shell for DeepSeek Harness.'
const DESCRIPTION =
  'A desktop app that installs DeepSeek Harness, keeps it running, and reclaims every process it started when the window closes. The harness is bound to loopback on a port assigned by the kernel.'

/* The assets each manifest needs, keyed by the tail of the filename — the part
   the bundler decides, as opposed to the version in the middle of it. */
const WANTED = {
  windowsSetup: '_x64-setup.exe',
  macArm: '_aarch64.dmg',
  macIntel: '_x64.dmg',
  linuxDeb: '_amd64.deb',
}

/* ---------- release ---------- */

async function github(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/${path}`
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        // Raises the rate limit from 60 an hour to 5000 when a token happens to be
        // in the environment, which it is on a runner. Not required locally.
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    },
    `GitHub API ${path}`,
  )
  return response.json()
}

async function fetchWithRetry(url, options = {}, label = url, attempt = 1) {
  try {
    const response = await fetch(url, { redirect: 'follow', ...options })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response
  } catch (cause) {
    if (attempt >= 4) throw new Error(`${label} could not be read: ${cause.message}`, { cause })
    console.log(`  retrying ${label} (${attempt}/3): ${cause.message}`)
    await new Promise((resume) => setTimeout(resume, attempt * 1500))
    return fetchWithRetry(url, options, label, attempt + 1)
  }
}

/*
 * Retried, and retried from the beginning: a digest has to cover the whole file,
 * so a connection that drops halfway through means starting over rather than
 * resuming. Four megabytes of installer from a release CDN is enough to hit a
 * reset now and then, and there is no partial answer worth keeping.
 */
async function sha256(url, attempt = 1) {
  const hash = createHash('sha256')
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // Streamed rather than buffered: nothing here needs to be resident at once.
    for await (const chunk of response.body) hash.update(chunk)
  } catch (cause) {
    if (attempt >= 4) throw new Error(`Could not hash ${url}: ${cause.message}`, { cause })
    console.log(`  retrying (${attempt}/3): ${cause.message}`)
    await new Promise((resume) => setTimeout(resume, attempt * 1500))
    return sha256(url, attempt + 1)
  }
  return hash.digest('hex')
}

async function resolve(tag) {
  const release = await github(tag ? `releases/tags/${tag}` : 'releases/latest')
  const version = release.tag_name.replace(/^v/, '')

  const updaterAsset = release.assets.find((asset) => asset.name === 'latest.json')
  if (!updaterAsset) throw new Error(`Release ${release.tag_name} has no latest.json`)
  const updaterResponse = await fetchWithRetry(updaterAsset.browser_download_url, {}, 'latest.json')
  const updaterManifest = normalizeUpdaterManifest(await updaterResponse.text(), version)

  /* SHA256SUMS.txt, when present, is one small download instead of four large
     ones — and it is the digest the build itself recorded. */
  const sums = new Map()
  const sumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS.txt')
  if (sumsAsset) {
    const text = await (
      await fetchWithRetry(sumsAsset.browser_download_url, {}, 'SHA256SUMS.txt')
    ).text()
    for (const line of text.split('\n')) {
      const match = line.match(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/)
      if (match) sums.set(match[2], match[1])
    }
    console.log(`Read ${sums.size} digests from SHA256SUMS.txt`)
  } else {
    console.log('This release has no SHA256SUMS.txt; hashing the assets directly.')
  }

  const files = {}
  for (const [key, suffix] of Object.entries(WANTED)) {
    const asset = release.assets.find((a) => a.name.endsWith(suffix))
    if (!asset) throw new Error(`Release ${release.tag_name} has no asset ending in ${suffix}`)
    files[key] = {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      sha256: sums.get(asset.name) ?? (await sha256(asset.browser_download_url)),
    }
    console.log(`  ${asset.name}  ${files[key].sha256.slice(0, 16)}…`)
  }

  /* Arch requires the licence text in the package, and MIT in particular cannot
     be referenced from /usr/share/licenses/common because every copy of it
     carries its own copyright line. Read from the tag, not from main, so the
     text matches the binaries. */
  const licenseUrl = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${release.tag_name}/LICENSE`
  files.license = { url: licenseUrl, sha256: await sha256(licenseUrl) }

  return {
    tag: release.tag_name,
    version,
    // The date only, in the form winget and AppStream both want.
    date: release.published_at.slice(0, 10),
    files,
    updaterManifest,
  }
}

/* ---------- writing ---------- */

const written = []

async function emit(relative, contents) {
  const path = join(ROOT, relative)
  await mkdir(dirname(path), { recursive: true })
  // Always LF: a PKGBUILD or a shell-adjacent manifest with CRLF in it breaks on
  // the machines that consume these, and this script also runs on Windows.
  await writeFile(path, contents.replace(/\r\n/g, '\n'), 'utf8')
  written.push(relative)
}

const GENERATED = 'Generated by packaging/generate.mjs — edit that script, not this file.'

/* ---------- scoop ---------- */

/*
 * Lives at the repository root because that is where Scoop looks: `scoop bucket
 * add <name> <git url>` clones the repo and reads `bucket/` if it exists, or the
 * root otherwise. There is no way to point it at a subdirectory, so the bucket
 * cannot live under packaging/ with the others.
 *
 * Scoop has no notion of running an installer, so this drives the NSIS one
 * itself. The flags are the ones Tauri's template actually reads: `/S` and `/D`
 * are NSIS built-ins, `/NS` suppresses the shortcuts Scoop creates for itself.
 * `/D=` has to come last and must not be quoted — NSIS takes the whole rest of
 * the line as the path, which is also why a directory with a space in it is fine.
 */
function scoop({ version, files }) {
  return `${JSON.stringify(
    {
      version,
      description: SHORT_DESCRIPTION,
      homepage: `https://github.com/${OWNER}/${REPO}`,
      license: 'MIT',
      notes: [
        'DSH Studio downloads a Node.js runtime on first run if the machine has none.',
        'The harness listens on 127.0.0.1 only, on a port the kernel assigns.',
        // Not a `persist` entry: this lives outside $dir, so it already survives
        // an upgrade. Worth saying because it is a few hundred megabytes that an
        // uninstall leaves behind, and nothing else would tell you where.
        'The harness and any downloaded runtime live in %LOCALAPPDATA%\\dsh-studio, which uninstalling does not remove.',
      ],
      architecture: {
        '64bit': {
          url: `${files.windowsSetup.url}#/setup.exe`,
          hash: files.windowsSetup.sha256,
        },
      },
      installer: {
        script: [
          'Start-Process -FilePath "$dir\\setup.exe" -ArgumentList "/S /NS /D=$dir" -Wait',
          'Remove-Item -Force "$dir\\setup.exe"',
        ],
      },
      uninstaller: {
        // `_?=` is the NSIS idiom that keeps the uninstaller in place instead of
        // relaunching itself from the temp directory, which is what makes -Wait
        // mean anything. Scoop removes the directory afterwards regardless.
        script: [
          'if (Test-Path "$dir\\uninstall.exe") {',
          '  Start-Process -FilePath "$dir\\uninstall.exe" -ArgumentList "/S _?=$dir" -Wait',
          '}',
        ],
      },
      bin: 'dsh-studio.exe',
      shortcuts: [['dsh-studio.exe', 'DSH Studio']],
      checkver: {
        github: `https://github.com/${OWNER}/${REPO}`,
      },
      autoupdate: {
        architecture: {
          '64bit': {
            url: `https://github.com/${OWNER}/${REPO}/releases/download/v$version/DSH.Studio_$version_x64-setup.exe#/setup.exe`,
          },
        },
      },
    },
    null,
    2,
  )}\n`
}

/* ---------- winget ---------- */

/*
 * The NSIS installer rather than the MSI, for two reasons: it is a megabyte
 * smaller, and it installs per-user, so `winget install` needs no elevation. The
 * MSI would also mean carrying a ProductCode that changes with every build.
 */
const WINGET_SCHEMA = '1.6.0'

function wingetInstaller({ version, date, files }) {
  return `# ${GENERATED}
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${WINGET_SCHEMA}.schema.json

PackageIdentifier: ${OWNER}.DSHStudio
PackageVersion: ${version}
InstallerLocale: en-US
MinimumOSVersion: 10.0.17763.0
InstallerType: nullsoft
Scope: user
UpgradeBehavior: install
ReleaseDate: ${date}
Installers:
  - Architecture: x64
    InstallerUrl: ${files.windowsSetup.url}
    InstallerSha256: ${files.windowsSetup.sha256.toUpperCase()}
ManifestType: installer
ManifestVersion: ${WINGET_SCHEMA}
`
}

function wingetLocale({ version, tag }) {
  return `# ${GENERATED}
# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${WINGET_SCHEMA}.schema.json

PackageIdentifier: ${OWNER}.DSHStudio
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${OWNER}
PublisherUrl: https://github.com/${OWNER}
PublisherSupportUrl: https://github.com/${OWNER}/${REPO}/issues
PackageName: DSH Studio
PackageUrl: https://github.com/${OWNER}/${REPO}
# The short name, so that \`winget install dsh-studio\` resolves without anyone
# having to know the publisher prefix.
Moniker: dsh-studio
License: MIT
LicenseUrl: https://github.com/${OWNER}/${REPO}/blob/main/LICENSE
ShortDescription: ${SHORT_DESCRIPTION}
Description: ${DESCRIPTION}
Tags:
  - ai
  - deepseek
  - developer-tools
  - harness
  - tauri
ReleaseNotesUrl: https://github.com/${OWNER}/${REPO}/releases/tag/${tag}
ManifestType: defaultLocale
ManifestVersion: ${WINGET_SCHEMA}
`
}

function wingetVersion({ version }) {
  return `# ${GENERATED}
# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${WINGET_SCHEMA}.schema.json

PackageIdentifier: ${OWNER}.DSHStudio
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${WINGET_SCHEMA}
`
}

/* ---------- homebrew ---------- */

/*
 * Homebrew requires a cask to live in a repository named `homebrew-<something>`,
 * so this file cannot be tapped from here. It is kept in step anyway, so that
 * publishing the tap is a copy rather than a rewrite.
 */
function homebrew({ version, files }) {
  return `# typed: strict
# frozen_string_literal: true

# ${GENERATED}
cask "dsh-studio" do
  arch arm: "aarch64", intel: "x64"

  version "${version}"
  sha256 arm:   "${files.macArm.sha256}",
         intel: "${files.macIntel.sha256}"

  url "https://github.com/${OWNER}/${REPO}/releases/download/v#{version}/DSH.Studio_#{version}_#{arch}.dmg"
  name "DSH Studio"
  desc "${SHORT_DESCRIPTION.replace(/\.$/, '')}"
  homepage "https://github.com/${OWNER}/${REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Tauri 2 supports Catalina and later. The binaries are tagged lower than that
  # — 11.0 on arm64, 10.13 on Intel — but the tag is the linker's deployment
  # target, not a claim that the webview underneath it works, so the framework's
  # floor is the one worth declaring.
  depends_on macos: ">= :catalina"

  app "DSH Studio.app"

  # The application's own directory is named after the binary rather than the
  # bundle identifier, because it comes from the cross-platform data path and not
  # from Tauri. It holds the harness and any Node runtime the app downloaded, so
  # it is by far the largest thing to reclaim — a few hundred megabytes.
  #
  # ~/.dsh is deliberately absent. The harness owns that directory and shares it
  # with its own CLI, so removing it here would take a user's harness
  # configuration with an app they merely stopped using.
  zap trash: [
    "~/Library/Application Support/dsh-studio",
    "~/Library/Caches/${IDENTIFIER}",
    "~/Library/HTTPStorages/${IDENTIFIER}",
    "~/Library/Preferences/${IDENTIFIER}.plist",
    "~/Library/Saved Application State/${IDENTIFIER}.savedState",
    "~/Library/WebKit/${IDENTIFIER}",
  ]
end
`
}

/* ---------- aur ---------- */

/*
 * A `-bin` package built from the Debian archive rather than from source: the
 * release is already compiled for x86-64, and rebuilding it would mean pulling
 * a Rust toolchain and a node_modules onto every user's machine to arrive at the
 * same binary.
 */
function pkgbuild({ version, files }) {
  return `# ${GENERATED}
# Maintainer: ${OWNER} <${OWNER}@users.noreply.github.com>

pkgname=dsh-studio-bin
pkgver=${version}
pkgrel=1
pkgdesc="${SHORT_DESCRIPTION.replace(/\.$/, '')}"
arch=('x86_64')
url="https://github.com/${OWNER}/${REPO}"
license=('MIT')
depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator')
optdepends=('nodejs: use the system Node.js instead of letting the app fetch one')
provides=('dsh-studio')
conflicts=('dsh-studio')
options=('!strip' '!emptydirs')
source=("\${pkgname}-\${pkgver}.deb::${files.linuxDeb.url}"
        "\${pkgname}-\${pkgver}-LICENSE::${files.license.url}")
sha256sums=('${files.linuxDeb.sha256}'
            '${files.license.sha256}')

package() {
  # bsdtar reads the outer ar archive and the inner tarball alike, and detects
  # the inner compression itself — which matters because which one the bundler
  # picks is not something this package should have to track.
  bsdtar -O -xf "\${srcdir}/\${pkgname}-\${pkgver}.deb" 'data.tar.*' |
    bsdtar -C "\${pkgdir}" -xf -

  install -Dm644 "\${srcdir}/\${pkgname}-\${pkgver}-LICENSE" \\
    "\${pkgdir}/usr/share/licenses/\${pkgname}/LICENSE"

  # The Debian payload names its desktop entry after the product, space included.
  # That is legal, but every other path in the package — the binary, the icons,
  # the entry's own Exec, Icon and StartupWMClass keys — uses the short name, so
  # the file may as well too.
  mv "\${pkgdir}/usr/share/applications/DSH Studio.desktop" \\
    "\${pkgdir}/usr/share/applications/dsh-studio.desktop"

  # The Debian payload is group-writable, which makepkg rejects outright.
  chmod -R go-w "\${pkgdir}/usr"
}
`
}

/*
 * .SRCINFO is not documentation — the AUR reads it instead of executing the
 * PKGBUILD, so a stale one shows users the wrong version. Normally written by
 * `makepkg --printsrcinfo`, which does not run on Windows; the fields below are
 * a direct transcription of the PKGBUILD above and must be regenerated with it.
 */
function srcinfo({ version, files }) {
  return `pkgbase = dsh-studio-bin
\tpkgdesc = ${SHORT_DESCRIPTION.replace(/\.$/, '')}
\tpkgver = ${version}
\tpkgrel = 1
\turl = https://github.com/${OWNER}/${REPO}
\tarch = x86_64
\tlicense = MIT
\tdepends = webkit2gtk-4.1
\tdepends = gtk3
\tdepends = libayatana-appindicator
\toptdepends = nodejs: use the system Node.js instead of letting the app fetch one
\tprovides = dsh-studio
\tconflicts = dsh-studio
\toptions = !strip
\toptions = !emptydirs
\tsource = dsh-studio-bin-${version}.deb::${files.linuxDeb.url}
\tsource = dsh-studio-bin-${version}-LICENSE::${files.license.url}
\tsha256sums = ${files.linuxDeb.sha256}
\tsha256sums = ${files.license.sha256}

pkgname = dsh-studio-bin
`
}

/* ---------- flathub ---------- */

/*
 * GNOME 49 carries the GTK 3 WebKitGTK 4.1 ABI Tauri links against. The broad
 * home permission is intentional and visible: this is an agent workspace, not
 * a document viewer, and hiding that fact behind a portal would be misleading.
 */
function flatpak({ files }) {
  return `# ${GENERATED}
app-id: ${IDENTIFIER}
runtime: org.gnome.Platform
runtime-version: '49'
sdk: org.gnome.Sdk
command: dsh-studio
separate-locales: false

# Ubuntu 22.04 ships flatpak-builder 1.2, whose automatic composer is
# unavailable inside a GNOME 49 build sandbox. AppStream is validated as a
# separate workflow gate; Flathub's current builder composes it on submission.
appstream-compose: false

finish-args:
  - --share=ipc
  - --socket=wayland
  - --socket=fallback-x11
  - --device=dri
  # The harness is fetched from the npm registry and talks to DeepSeek.
  - --share=network
  # The tray icon.
  - --talk-name=org.kde.StatusNotifierWatcher
  # The app's reason for existing is working in the user's own project
  # directories. Narrower than this and it cannot do the one thing it is for.
  - --filesystem=home

modules:
  - name: dsh-studio
    buildsystem: simple
    build-commands:
      # A .deb is an ar archive holding a tarball; flatpak-builder unpacks
      # neither, so the module does it by hand. The payload of this one is
      # usr/bin/dsh-studio, three hicolor icon sizes, and a desktop entry named
      # after the product rather than the binary — "DSH Studio.desktop".
      - ar x dsh-studio.deb
      - tar -xf data.tar.gz
      - install -Dm755 usr/bin/dsh-studio /app/bin/dsh-studio
      - 'install -Dm644 "usr/share/applications/DSH Studio.desktop" /app/share/applications/${IDENTIFIER}.desktop'
      # Flatpak resolves an icon by app-id, so both the file names and the Icon
      # key have to be the reverse-DNS name and not "dsh-studio".
      - desktop-file-edit --set-icon=${IDENTIFIER} /app/share/applications/${IDENTIFIER}.desktop
      - |
        for size in 32x32 128x128 256x256@2; do
          install -Dm644 "usr/share/icons/hicolor/$size/apps/dsh-studio.png" \\
            "/app/share/icons/hicolor/$size/apps/${IDENTIFIER}.png"
        done
      - install -Dm644 ${IDENTIFIER}.metainfo.xml /app/share/metainfo/${IDENTIFIER}.metainfo.xml
    sources:
      - type: file
        url: ${files.linuxDeb.url}
        sha256: ${files.linuxDeb.sha256}
        dest-filename: dsh-studio.deb
      - type: file
        path: ${IDENTIFIER}.metainfo.xml
`
}

/*
 * AppStream metadata. Flathub will not accept a submission without it, and it is
 * what puts a name, a summary and a screenshot in GNOME Software and Discover.
 */
function metainfo({ version, date }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${GENERATED} -->
<component type="desktop-application">
  <id>${IDENTIFIER}</id>
  <name>DSH Studio</name>
  <summary>${SHORT_DESCRIPTION.replace(/\.$/, '')}</summary>

  <metadata_license>MIT</metadata_license>
  <project_license>MIT</project_license>

  <description>
    <p>${DESCRIPTION}</p>
    <p>The shell restarts the harness with a backoff when it exits, probes it
    over HTTP every ten seconds, and recycles it after three consecutive
    misses. Child processes are placed in a process group so that closing the
    window reclaims the whole tree.</p>
    <p>It also installs a Node.js runtime on first run if the machine has none,
    and offers a plugin marketplace backed by the npm registry.</p>
  </description>

  <launchable type="desktop-id">${IDENTIFIER}.desktop</launchable>
  <categories>
    <category>Development</category>
  </categories>

  <url type="homepage">https://github.com/${OWNER}/${REPO}</url>
  <url type="bugtracker">https://github.com/${OWNER}/${REPO}/issues</url>
  <url type="vcs-browser">https://github.com/${OWNER}/${REPO}</url>

  <developer id="io.github.moresyl">
    <name>Moresyl</name>
  </developer>

  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/${OWNER}/${REPO}/main/assets/console.png</image>
      <caption>The environment checks and supervised Harness console</caption>
    </screenshot>
  </screenshots>

  <provides>
    <binary>dsh-studio</binary>
  </provides>

  <content_rating type="oars-1.1" />

  <releases>
    <release version="${version}" date="${date}">
      <url type="details">https://github.com/${OWNER}/${REPO}/releases/tag/v${version}</url>
    </release>
  </releases>
</component>
`
}

/* ---------- main ---------- */

const release = await resolve(process.argv[2])
console.log(`\nWriting manifests for ${release.tag}\n`)

await emit('bucket/dsh-studio.json', scoop(release))
await emit(`packaging/winget/${OWNER}.DSHStudio.installer.yaml`, wingetInstaller(release))
await emit(`packaging/winget/${OWNER}.DSHStudio.locale.en-US.yaml`, wingetLocale(release))
await emit(`packaging/winget/${OWNER}.DSHStudio.yaml`, wingetVersion(release))
await emit('packaging/homebrew/dsh-studio.rb', homebrew(release))
await emit('packaging/aur/PKGBUILD', pkgbuild(release))
await emit('packaging/aur/.SRCINFO', srcinfo(release))
await emit(`packaging/flathub/${IDENTIFIER}.yml`, flatpak(release))
await emit(`packaging/flathub/${IDENTIFIER}.metainfo.xml`, metainfo(release))
await emit('website/latest.json', release.updaterManifest)

for (const path of written) console.log(`  ${path}`)
console.log(`\n${written.length} files written for ${release.tag}.`)
