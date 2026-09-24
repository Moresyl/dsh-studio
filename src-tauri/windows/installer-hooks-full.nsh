!macro NSIS_HOOK_PREINSTALL
  ; Full installers replace both versioned resource trees. A Lite updater uses
  ; the other hook, so it deliberately preserves an existing offline payload.
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\offline"
!macroend
