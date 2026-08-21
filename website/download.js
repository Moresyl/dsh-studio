/*
 * Fills in the download links from whatever the newest release actually is.
 *
 * The page ships with every link already pointing at the releases page and
 * every size reading as an estimate, so it is complete and correct before this
 * file runs at all. That matters more than it sounds: the GitHub API allows
 * sixty unauthenticated calls an hour per address, and a visitor behind a large
 * NAT can arrive having already spent them. Everything here is an upgrade on a
 * working page, never a prerequisite for one.
 */

const REPO = 'Moresyl/dsh-studio'
const API = `https://api.github.com/repos/${REPO}/releases/latest`

/* Assets are matched on the tail of the filename rather than parsed, because the
   version sits in the middle of every one of them and the tail is the part the
   bundler decides. `.sig` files fall out for free: they end in `.sig`. */
const SUFFIXES = {
  'win-nsis': '_x64-setup.exe',
  'win-msi': '_x64_en-US.msi',
  'win-portable': '_x64-portable.exe',
  'mac-arm': '_aarch64.dmg',
  'mac-intel': '_x64.dmg',
  'mac-universal': '_universal.dmg',
  'linux-appimage': '_amd64.AppImage',
  'linux-deb': '_amd64.deb',
  'linux-rpm': '-1.x86_64.rpm',
  'win-full': 'full-x86_64-pc-windows-msvc.exe',
  'mac-arm-full': 'full-aarch64-apple-darwin.dmg',
  'mac-intel-full': 'full-x86_64-apple-darwin.dmg',
  'linux-full': 'full-x86_64-unknown-linux-gnu.AppImage',
}

/* Which download the big button offers, per detected platform. */
const PREFERRED = {
  windows: 'win-nsis',
  'mac-arm': 'mac-arm',
  'mac-intel': 'mac-intel',
  linux: 'linux-appimage',
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/* ---------- platform ---------- */

/*
 * Which machine is this. The answer is only ever used to reorder and highlight —
 * every download stays visible and reachable, so a wrong guess costs a visitor
 * one extra glance rather than the wrong installer.
 */
function detect() {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Android/i.test(ua)) return null // A phone. Neither answer would be right.
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux'
  if (!/Mac OS X|Macintosh|iPhone|iPad/i.test(ua)) return null
  return /iPhone|iPad/i.test(ua) ? null : appleSilicon() ? 'mac-arm' : 'mac-intel'
}

/*
 * Apple ships no honest signal for this: every browser on an ARM Mac still
 * reports the platform as MacIntel, for the sake of scripts written in 2010. The
 * GPU string is the one place the truth leaks out — Apple's own silicon renders
 * as "Apple M1" or similar, while a 2019 Intel machine names an AMD or Intel
 * part. Undetectable falls to Apple Silicon, which every Mac sold since 2020 is.
 */
function appleSilicon() {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''
    if (/AMD|Radeon|Intel|NVIDIA/i.test(renderer)) return false
  } catch {
    // A blocked or unavailable WebGL context says nothing either way, and the
    // default below is the safe answer.
  }
  return true
}

/* ---------- release ---------- */

/*
 * Cached for the session so that reading the page in one language and then the
 * other costs one call rather than two. sessionStorage rather than local: a
 * visitor who comes back tomorrow should see tomorrow's release.
 */
async function release() {
  const cached = sessionStorage.getItem('dsh:release')
  if (cached) {
    try {
      return JSON.parse(cached)
    } catch {
      sessionStorage.removeItem('dsh:release')
    }
  }

  const response = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`GitHub API replied ${response.status}`)
  const { tag_name, published_at, assets } = await response.json()

  const files = {}
  for (const [id, suffix] of Object.entries(SUFFIXES)) {
    const asset = assets.find((a) => a.name.endsWith(suffix))
    if (asset) files[id] = { url: asset.browser_download_url, size: asset.size, name: asset.name }
  }
  const checksums = assets.find((a) => a.name === 'SHA256SUMS.txt')

  const data = {
    tag: tag_name,
    published: published_at,
    files,
    checksums: checksums?.browser_download_url,
  }
  sessionStorage.setItem('dsh:release', JSON.stringify(data))
  return data
}

/* ---------- the page ---------- */

function paint(data) {
  for (const el of document.querySelectorAll('[data-version]')) el.textContent = data.tag

  if (data.published) {
    const when = new Date(data.published).toLocaleDateString(document.documentElement.lang, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    for (const el of document.querySelectorAll('[data-published]')) el.textContent = when
    // Kept out of the markup until there is a date to put in it, rather than
    // shipping a sentence that reads "released recently" when the API is blocked.
    for (const el of document.querySelectorAll('[data-published-wrap]')) el.hidden = false
  }

  if (data.checksums) {
    for (const el of document.querySelectorAll('[data-checksums]')) el.href = data.checksums
  }

  for (const link of document.querySelectorAll('[data-file]')) {
    const file = data.files[link.dataset.file]
    // Left alone rather than hidden when a build is missing from a release: the
    // link still reaches the releases page, which is the honest destination.
    if (!file) continue
    link.href = file.url
    link.removeAttribute('aria-disabled')
    const size = link.querySelector('.size')
    if (size) size.textContent = mib(file.size)
  }
}

/*
 * The installer this visitor is being sold. Two jobs: point the hero button at a
 * real file, and put the platform they are on at the top of the table — where
 * everything else stays visible below it, because plenty of people download for
 * a machine other than the one they are reading on.
 */
function focus(platform, data) {
  const wanted = PREFERRED[platform]
  const file = data?.files?.[wanted]

  const hero = document.querySelector('[data-hero-download]')
  if (hero && wanted) {
    hero.dataset.file = wanted
    if (file) {
      hero.href = file.url
      const note = hero.querySelector('.note')
      if (note) note.textContent = mib(file.size)
    }
  }

  // The headline size claim, replaced with the figure for the build this visitor
  // would actually get. Worth doing precisely because the answer is not the same
  // everywhere: an AppImage carries its own WebKitGTK and is twenty times the
  // size of the installer that uses the system's.
  if (file) {
    for (const el of document.querySelectorAll('[data-installer-size]'))
      el.textContent = mib(file.size)
  }

  const group = platform.startsWith('mac') ? 'mac' : platform
  const row = document.querySelector(`[data-platform="${group}"]`)
  if (!row) return
  row.parentElement.prepend(row)

  const badge = document.querySelector(`[data-platform="${group}"] [data-detected]`)
  if (badge) badge.hidden = false
}

/*
 * The command block, and the tabs that fill it. Per-platform because there is no
 * one command that installs this everywhere, and showing a visitor a command
 * their shell does not have is worse than showing none.
 *
 * The prompt sigil is drawn here rather than written into the markup so that it
 * survives a tab switch — and, more to the point, so that it is never part of
 * what the copy button puts on the clipboard. A pasted `$` is a failed command.
 */
function renderCommand(output, command) {
  output.dataset.raw = command
  output.replaceChildren(
    ...command.split('\n').flatMap((line, index) => {
      const sigil = document.createElement('span')
      sigil.className = 'sigil'
      sigil.textContent = '$ '
      const parts = index === 0 ? [sigil] : [document.createTextNode('\n'), sigil]
      return [...parts, document.createTextNode(line)]
    }),
  )
}

function commandTabs() {
  const tabs = [...document.querySelectorAll('[data-command]')]
  const output = document.querySelector('[data-command-output]')
  if (!tabs.length || !output) return

  const select = (tab, focusIt) => {
    for (const other of tabs) {
      const chosen = other === tab
      other.setAttribute('aria-selected', String(chosen))
      // Roving tabindex: one stop for the whole group, so Tab moves past the
      // tabs rather than through five of them, and the arrows move within.
      other.tabIndex = chosen ? 0 : -1
    }
    renderCommand(output, tab.dataset.command)
    if (focusIt) tab.focus()
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab))
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: tabs.length - 1 - index }[
        event.key
      ]
      if (step === undefined) return
      event.preventDefault()
      select(tabs[(index + step + tabs.length) % tabs.length], true)
    })
  }

  // Rendered once up front from whichever tab the markup marks as selected, so
  // the block reads the same before any click as after one.
  select(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0])
  return select
}

function copyButton() {
  const button = document.querySelector('[data-copy]')
  const source = document.querySelector('[data-command-output]')
  if (!button || !source) return

  const idle = button.textContent
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source.dataset.raw || source.textContent.trim())
      button.textContent = button.dataset.copied || 'Copied'
    } catch {
      // Denied permission, or a page not served over https. Selecting the text
      // leaves the visitor one keystroke from the same result.
      getSelection()?.selectAllChildren(source)
      button.textContent = button.dataset.copyFailed || 'Press Ctrl+C'
    }
    setTimeout(() => {
      button.textContent = idle
    }, 1600)
  })
}

async function main() {
  const platform = detect()
  const selectTab = commandTabs()
  copyButton()

  // Chosen before the network is touched, so the visitor's own platform is
  // showing while the sizes are still arriving.
  if (selectTab && platform) {
    const group = platform.startsWith('mac') ? 'mac' : platform
    const tab = document.querySelector(`[data-command][data-for="${group}"]`)
    if (tab) selectTab(tab)
  }

  let data = null
  try {
    data = await release()
    paint(data)
  } catch (error) {
    // Reported once, quietly. The static page is the fallback, and it works.
    console.warn('Could not read the latest release; showing the shipped defaults.', error)
    const notice = document.querySelector('[data-api-notice]')
    if (notice) notice.hidden = false
  }

  if (platform) focus(platform, data)
}

main()
