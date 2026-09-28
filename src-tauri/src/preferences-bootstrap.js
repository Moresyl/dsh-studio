function restoreDesktopPreferences(origin, saved, boot) {
  if (window.top !== window.self || location.origin !== origin) return
  Object.defineProperty(window, '__DSH_SAVED_PREFERENCES__', { value: saved })
  try {
    const marker = 'dsh-studio:preferences:boot'
    if (localStorage.getItem(marker) === boot) return
    // A new app process restores the current native snapshot, even if the OS
    // reused an old loopback port. Reloads and sibling windows in this process
    // must not overwrite newer live values with a window-creation snapshot.
    for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value)
    localStorage.setItem(marker, boot)
  } catch {
    // Disabled/full Web storage still leaves the native snapshot readable.
  }
}
