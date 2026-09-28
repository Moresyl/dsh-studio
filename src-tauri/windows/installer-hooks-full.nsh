!macro NSIS_HOOK_PREINSTALL
  ; Full installers replace both versioned resource trees. A Lite updater uses
  ; the other hook, so it deliberately preserves an existing offline payload.
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\offline"
  ; Older Full builds put these generated archives under runtime-cache.
  ; Remove only that owned legacy subtree, then its parent if it is empty.
  RMDir /r "$INSTDIR\runtime-cache\offline"
  RMDir "$INSTDIR\runtime-cache"
!macroend
