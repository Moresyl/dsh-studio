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
 * It also keeps this shell out of the harness's DOM. Reaching in to restyle
 * someone else's application is a maintenance debt that comes due on their
 * release schedule, not ours.
 */

/** Capabilities the harness UI needs that a frame does not grant by default. */
const PERMISSIONS = 'clipboard-read; clipboard-write'

interface HarnessFrameProps {
  /** Origin the harness is currently serving on. */
  origin: string
  /** Keep the frame loaded but out of the way. */
  hidden: boolean
}

export function HarnessFrame({ origin, hidden }: HarnessFrameProps) {
  return (
    <iframe
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
