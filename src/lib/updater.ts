import * as ipc from '@/lib/ipc'

const RELEASES = 'https://github.com/Moresyl/dsh-studio/releases'
const UPDATE_NETWORK_HELP =
  'Could not reach the verified update feed. Check GitHub access or HTTPS_PROXY, then retry; Full / Offline installers are available from the Releases page. / 无法连接已核验更新源，请检查 GitHub 网络或 HTTPS_PROXY 后重试；也可从 Releases 页面下载 Full / Offline 安装包。'
const UPDATE_CHANGED =
  'The available release changed after you reviewed it. Review the new release notes before installing. / 可用版本在确认后发生了变化，请先查看新版本说明再安装。'

export type Release = ipc.ApplicationReleaseReview

export interface DownloadProgress {
  downloaded: number
  total: number | null
  phase?: ipc.ApplicationUpdateProgress['phase']
}

export class UpdateCancelled extends Error {
  constructor() {
    super('Application update cancelled')
  }
}

/** Checks remain read-only; a review does not download an installer. */
export const checkForUpdate = (): Promise<Release | null> => checkReviewed(null)

export async function reviewVersion(version: string): Promise<Release> {
  exactVersion(version)
  const review = await checkReviewed(version)
  if (!review) throw new Error(UPDATE_CHANGED)
  if (review.version !== version) {
    await discardReview(review)
    throw new Error(UPDATE_CHANGED)
  }
  return review
}

/** Renew an expiring receipt only if its complete native fingerprint is unchanged. */
export async function installUpdate(
  expected: Release,
  onProgress: (progress: DownloadProgress) => void,
  target: 'latest' | 'selected' = 'latest',
  onReview: (review: Release) => void = () => {},
): Promise<boolean> {
  validateReview(expected)
  if (!expected.canInstall) {
    throw new Error(
      expected.installBlock === 'rpmDowngrade'
        ? 'RPM downgrades require the system package manager. / RPM 版本回退请使用系统包管理器。'
        : 'Application installation is disabled in development builds. / 开发构建仅支持版本预览。',
    )
  }
  const current = await checkReviewed(target === 'selected' ? expected.version : null)
  if (!current) return false
  try {
    if (current.version !== expected.version || current.fingerprint !== expected.fingerprint) {
      throw new Error(UPDATE_CHANGED)
    }
    onReview(current)
    await ipc.applicationUpdateInstall(current.reviewId, (progress) => {
      const total =
        Number.isSafeInteger(progress.total) && progress.total > 0 ? progress.total : null
      const downloaded = Math.max(0, Number.isFinite(progress.downloaded) ? progress.downloaded : 0)
      onProgress({
        phase: progress.phase,
        downloaded: total === null ? downloaded : Math.min(downloaded, total),
        total,
      })
    })
    return true
  } catch (cause) {
    if (
      cause instanceof UpdateCancelled ||
      String(cause).includes('application update cancelled')
    ) {
      throw new UpdateCancelled()
    }
    throw cause
  } finally {
    await discardReview(current)
  }
}

export const cancelUpdate = (review: Release): Promise<boolean> =>
  ipc.applicationUpdateCancel(review.reviewId)

export async function discardReview(review: Release | null): Promise<void> {
  if (!review) return
  try {
    await ipc.applicationUpdateDiscard(review.reviewId)
  } catch {
    // These bounded, read-only receipts also expire natively. Cleanup must not
    // mask an installation failure or report a spurious error while exiting.
  }
}

async function checkReviewed(version: string | null): Promise<Release | null> {
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let review: Release | null = null
    try {
      review = await ipc.applicationUpdateReview(version)
      if (review) validateReview(review)
      return review
    } catch (cause) {
      if (review) await discardReview(review)
      last = cause
      if (attempt === 0) await new Promise((resolve) => globalThis.setTimeout(resolve, 350))
    }
  }
  const detail = last instanceof Error ? last.message.trim() : String(last).trim()
  throw new Error(detail ? `${UPDATE_NETWORK_HELP}\n${detail}` : UPDATE_NETWORK_HELP, {
    cause: last,
  })
}

function exactVersion(version: string): void {
  if (
    typeof version !== 'string' ||
    version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
  ) {
    throw new Error('The update feed contains an invalid version')
  }
}

function validateReview(review: Release): void {
  exactVersion(review.version)
  if (
    !/^[a-f0-9]{32}$/.test(review.reviewId) ||
    !/^[a-f0-9]{64}$/.test(review.fingerprint) ||
    review.url !== `${RELEASES}/tag/v${review.version}` ||
    typeof review.notes !== 'string' ||
    typeof review.published !== 'string' ||
    typeof review.canInstall !== 'boolean' ||
    !Number.isSafeInteger(review.bytes) ||
    review.bytes <= 0 ||
    review.bytes > 256 * 1024 * 1024
  ) {
    throw new Error('The native application update review is invalid')
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
