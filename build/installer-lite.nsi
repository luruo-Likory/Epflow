; EpFlow 轻量安装器（不使用任何 NSIS 插件，避免 $PLUGINSDIR 临时文件问题）
Unicode true
!include "MUI2.nsh"

!define APP_NAME "EpFlow"
!define APP_VERSION "1.1.2"
!define APP_EXE "EpFlow.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\EpFlow"

Name "${APP_NAME}"
OutFile "..\release\EpFlow-1.1.2-Setup-lite.exe"
InstallDir "$LOCALAPPDATA\Programs\EpFlow"
RequestExecutionLevel user
SetCompressor /SOLID zlib
SetCompressorDictSize 32
BrandingText "EpFlow 番剧流程规范化"

VIProductVersion "1.1.2.0"
VIAddVersionKey "ProductName" "EpFlow"
VIAddVersionKey "FileDescription" "EpFlow 安装程序（轻量版）"
VIAddVersionKey "FileVersion" "1.1.2"
VIAddVersionKey "ProductVersion" "1.1.2"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 EpFlow"

!define MUI_ICON "..\build\icon.ico"
!define MUI_UNICON "..\build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "运行 EpFlow"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "EpFlow" SecMain
  SetOutPath "$INSTDIR"
  File /r /x "Uninstall EpFlow.exe" "..\release\win-unpacked\*.*"

  CreateDirectory "$SMPROGRAMS\EpFlow"
  CreateShortCut "$SMPROGRAMS\EpFlow\EpFlow.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut "$SMPROGRAMS\EpFlow\卸载 EpFlow.lnk" "$INSTDIR\Uninstall EpFlow.exe"
  CreateShortCut "$DESKTOP\EpFlow.lnk" "$INSTDIR\${APP_EXE}"

  WriteUninstaller "$INSTDIR\Uninstall EpFlow.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "EpFlow 番剧流程规范化"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall EpFlow.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall EpFlow.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 210000
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\EpFlow.lnk"
  RMDir /r "$SMPROGRAMS\EpFlow"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
