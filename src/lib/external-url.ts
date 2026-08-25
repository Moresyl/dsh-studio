import { openUrl } from '@tauri-apps/plugin-opener'

const WEB_ONLY =
  'Only HTTP or HTTPS links can be opened. / 为保护本机安全，只允许打开 HTTP 或 HTTPS 网页链接。'
const NO_CREDENTIALS =
  'Links containing embedded credentials cannot be opened. / 不允许打开包含嵌入式账号或密码的链接。'

/**
 * Turn catalog, terminal, and application links into an unambiguous web URL.
 *
 * The OS opener supports file paths and custom schemes as well as web pages.
 * That is useful at its native boundary but too broad for remotely supplied
 * plugin metadata or terminal output, so every renderer call passes here first.
 */
export function normalizeExternalUrl(raw: string): string {
  let value = raw.trim()
  if (/^git\+https?:\/\//i.test(value)) value = value.slice(4)
  value = value.replace(/\.git$/i, '')

  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(WEB_ONLY)

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(WEB_ONLY)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(WEB_ONLY)
  if (parsed.username || parsed.password) throw new Error(NO_CREDENTIALS)
  return parsed.href
}

/** Open a validated web link in the user's browser. */
export async function openExternalUrl(raw: string): Promise<void> {
  await openUrl(normalizeExternalUrl(raw))
}
