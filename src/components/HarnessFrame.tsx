/**
 * The harness UI, hosted inside this window rather than replacing it.
 *
 * The obvious implementation is to point the whole WebView at the harness once
 * it is serving. On Windows and Linux that is a trap: the window is built
 * undecorated because the shell draws its own title bar, so navigating away
 * takes the title bar with it and leaves a window that cannot be moved,
 * minimised or closed. Framing it keeps the chrome ours no matter what the
 * harness page does.
 *
 * The managed integration plugin owns the small, documented theme-token bridge
 * inside Harness. This shell still never reaches into its DOM.
 *
 * Theme is the one thing that crosses in both directions. Harness has an
 * Appearance setting of its own, so the window's choice is sent down and a choice
 * made in Harness's row is sent back up — see `src/lib/theme-bridge.ts` for why
 * they are one setting with two doors.
 */
import { useCallback, useEffect, useRef } from 'react'

import { serveDesktop } from '@/lib/bridge'
import { serveImagePreview } from '@/lib/attachment-preview'
import { ownAsync } from '@/lib/lifecycle'
import { readPreferenceRequest, themeMessage } from '@/lib/theme-bridge'
import { reportFailure } from '@/state/failure'
import { useTheme } from '@/state/theme'

/** Capabilities the harness UI needs that a frame does not grant by default. */
const PERMISSIONS = 'clipboard-read; clipboard-write'

interface HarnessFrameProps {
  /** Origin the harness is currently serving on. */
  origin: string
  /** Keep the frame loaded but out of the way. */
  hidden: boolean
}

export function HarnessFrame({ origin, hidden }: HarnessFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const theme = useTheme((state) => state.theme)
  const sendTheme = useCallback(() => {
    const dark =
      theme === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
        : theme === 'dark'
    frame.current?.contentWindow?.postMessage(themeMessage(theme, dark), new URL(origin).origin)
  }, [origin, theme])

  useEffect(() => {
    const onReady = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (event.origin !== new URL(origin).origin) return
      if (event.data?.type === 'dsh-studio:theme-ready') {
        sendTheme()
        return
      }
      // The choice was made at Harness's door. Adopting it here is what sends it
      // back down, so the page hears its own answer as a no-op; the comparison is
      // what stops that echo from being announced to every other window again.
      const requested = readPreferenceRequest(event.data)
      const { theme: current, choose } = useTheme.getState()
      if (requested !== null && requested !== current) choose(requested)
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    window.addEventListener('message', onReady)
    if (theme === 'system') media?.addEventListener('change', sendTheme)
    sendTheme()
    return () => {
      window.removeEventListener('message', onReady)
      media?.removeEventListener('change', sendTheme)
    }
  }, [origin, sendTheme, theme])

  // The desktop is offered to this frame for exactly as long as the frame is
  // the thing serving on that origin — see `src/lib/bridge.ts`. Not tied to
  // `hidden`, because a session left running behind the control panel is still
  // a session, and a plugin that finishes while it is out of sight is the one
  // with the most reason to send a notification.
  useEffect(() => {
    return ownAsync(serveDesktop(origin), reportFailure)
  }, [origin])

  useEffect(() => {
    const peer = frame.current?.contentWindow
    if (peer) return serveImagePreview(peer, new URL(origin).origin)
  }, [origin])

  return (
    <iframe
      ref={frame}
      onLoad={sendTheme}
      // Hidden rather than unmounted: an agent session is long-lived work, and
      // stepping into the control panel must not throw it away. `display: none`
      // leaves the document loaded and its state intact.
      className={hidden ? 'hidden' : 'block h-full w-full border-0 bg-canvas'}
      src={origin}
      title="DeepSeek Harness"
      allow={PERMISSIONS}
    />
  )
}
