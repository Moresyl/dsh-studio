!macro NSIS_HOOK_PREINSTALL
  ; Vite assets use content hashes. Remove the previous owned tree so an
  ; in-place upgrade cannot leave files that the new uninstaller does not know.
  RMDir /r "$INSTDIR\dist"
!macroend
