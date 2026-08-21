import { getDshStudio, hasDshStudioCapability } from '@moresyl/dsh-studio-sdk'

/** Mount an optional Desktop adapter without changing ordinary Harness use. */
export async function mountDesktopExample(scope = window) {
  const desktop = getDshStudio(scope)
  if (!desktop) return () => {}

  const offer = await desktop.hello()
  if (!hasDshStudioCapability(offer, 'workspace')) return () => {}

  return desktop.workspace.onDrop((path) => {
    // Production plugins normally pass this path to their upstream Harness
    // workspace service. The SDK deliberately does not expose raw filesystem IO.
    scope.dispatchEvent(new CustomEvent('example:workspace-drop', { detail: path }))
  })
}
