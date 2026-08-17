import type { DownloadEvent } from '@tauri-apps/plugin-updater'

const RELEASES = 'https://github.com/Moresyl/dsh-studio/releases'
const CHECK_TIMEOUT_MS = 15_000

export interface Release {
  /** The published version, without a leading `v`. */
  version: string
  url: string
  /** Markdown supplied by the signed updater manifest. */
  notes: string
  published: string
}

export interface DownloadProgress {
  downloaded: number
  total: number | null
}

/** Ask the signed manifest whether this build has a successor. */
export async function checkForUpdate(): Promise<Release | null> {
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check({ timeout: CHECK_TIMEOUT_MS })
  if (!update) return null

  try {
    const version = update.version.trim().replace(/^v/, '')
    return {
      version,
      url: `${RELEASES}/tag/v${version}`,
      notes: update.body?.trim() ?? '',
      published: update.date ?? '',
    }
  } finally {
    await update.close()
  }
}

/** Download, verify, install, and relaunch into the published build. */
export async function installUpdate(
  onProgress: (progress: DownloadProgress) => void,
): Promise<boolean> {
  const [{ check }, { relaunch }] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ])
  const update = await check({ timeout: CHECK_TIMEOUT_MS })
  if (!update) return false

  let downloaded = 0
  let total: number | null = null
  const report = (event: DownloadEvent) => {
    if (event.event === 'Started') {
      downloaded = 0
      total = event.data.contentLength ?? null
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
    } else if (total !== null) {
      downloaded = total
    }
    onProgress({ downloaded, total })
  }

  try {
    await update.downloadAndInstall(report)
    await relaunch()
    return true
  } finally {
    await update.close()
  }
}

/** Pick the locale-specific block and turn its small Markdown subset into UI text. */
export function notesForDisplay(notes: string, language = navigator.language): string {
  const localized = localizedBlock(notes, language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  return localized
    .replace(/<!--[^]*?-->/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .trim()
}

function localizedBlock(notes: string, locale: 'en' | 'zh'): string {
  const marker = `<!-- dsh-notes:${locale} -->`
  const start = notes.indexOf(marker)
  if (start < 0) return notes
  const bodyStart = start + marker.length
  const next = notes.indexOf('<!-- dsh-notes:', bodyStart)
  return notes.slice(bodyStart, next < 0 ? undefined : next)
}
