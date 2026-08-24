import type { DownloadEvent } from '@tauri-apps/plugin-updater'

const RELEASES = 'https://github.com/Moresyl/dsh-studio/releases'
const CHECK_TIMEOUT_MS = 15_000
const UPDATE_NETWORK_HELP =
  'Could not reach the signed update feed. Check GitHub access or HTTPS_PROXY, then retry; Full / Offline installers are available from the Releases page. / 无法连接已签名更新源，请检查 GitHub 网络或 HTTPS_PROXY 后重试；也可从 Releases 页面下载 Full / Offline 安装包。'
const UPDATE_CHANGED =
  'The available release changed after you reviewed it. Review the new release notes before installing. / 可用版本在确认后发生了变化，请先查看新版本说明再安装。'
const RELAUNCH_FAILED =
  'The update was installed, but DSH Studio could not relaunch. Close and start the app again to finish updating. / 更新已安装，但 DSH Studio 无法自动重启；请关闭并重新启动应用以完成更新。'

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
  const update = await checkSignedUpdate(check)
  if (!update) return null

  try {
    const version = exactVersion(update.version)
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
  expectedVersion: string,
  onProgress: (progress: DownloadProgress) => void,
): Promise<boolean> {
  const [{ check }, { relaunch }] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ])
  const update = await checkSignedUpdate(check)
  if (!update) return false

  const actualVersion = exactVersion(update.version)
  if (actualVersion !== exactVersion(expectedVersion)) {
    await update.close()
    throw new Error(`${UPDATE_CHANGED}\nExpected ${expectedVersion}; found ${actualVersion}`)
  }

  let downloaded = 0
  let total: number | null = null
  const report = (event: DownloadEvent) => {
    if (event.event === 'Started') {
      downloaded = 0
      total = event.data.contentLength ?? null
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      if (total !== null) downloaded = Math.min(downloaded, total)
    } else if (total !== null) {
      downloaded = total
    }
    onProgress({ downloaded, total })
  }

  try {
    try {
      await update.downloadAndInstall(report)
    } catch (cause) {
      throw updaterNetworkError(cause)
    }
    try {
      await relaunch()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message.trim() : String(cause).trim()
      throw new Error(detail ? `${RELAUNCH_FAILED}\n${detail}` : RELAUNCH_FAILED, { cause })
    }
    return true
  } finally {
    await update.close()
  }
}

/** Tauri promises SemVer; validate it before using it in links or identity checks. */
function exactVersion(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The signed update feed has no valid version.')
  const version = value.trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`The signed update feed contains an invalid version: ${version || '(empty)'}`)
  }
  return version
}

async function checkSignedUpdate<T>(
  check: (options: { timeout: number }) => Promise<T>,
): Promise<T> {
  try {
    return await check({ timeout: CHECK_TIMEOUT_MS })
  } catch (cause) {
    throw updaterNetworkError(cause)
  }
}

function updaterNetworkError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message.trim() : String(cause).trim()
  return new Error(detail ? `${UPDATE_NETWORK_HELP}\n${detail}` : UPDATE_NETWORK_HELP, { cause })
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
