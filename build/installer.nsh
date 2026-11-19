; Adds "Wipe out" to the right-click menu of folders on install (unless the user
; turned it off in Wipeout's settings) and always removes it on uninstall.

!macro customInstall
  ReadRegStr $0 HKCU "Software\Wipeout" "ContextMenuDisabled"
  StrCmp $0 "1" skipMenu
    WriteRegStr HKCU "Software\Classes\Directory\shell\Wipeout" "" "Wipe out"
    WriteRegStr HKCU "Software\Classes\Directory\shell\Wipeout" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
    WriteRegStr HKCU "Software\Classes\Directory\shell\Wipeout\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  skipMenu:
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Wipeout"
  ; Keep the user's on/off choice across reinstalls and updates; only a full
  ; uninstall (not an update) removes it.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Wipeout"
  ${endIf}
!macroend
