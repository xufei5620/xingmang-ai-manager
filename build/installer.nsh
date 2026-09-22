# electron-builder 的 NSIS 自定义脚本。本文件被插在生成脚本的最前面，
# 所以这里只能定义宏和 !define，真正的代码都在宏里，由模板在合适的位置插入。
#
# 这里一共做四件事，每一件都对应一个客户机上真实发生过的问题：
#
#   1. customInstall：安装收尾时补齐缺失的快捷方式（见下面那段长注释）。
#   2. customHeader 里的目录页守卫：不许把程序装进别人的非空目录。
#   3. customRemoveFiles：卸载时只删本程序自己装进去的东西。
#   4. customUnInstall：删文件之前先还原加速改过的系统代理、删掉开机项。
#
# 2 和 3 是一对。老版本允许用户把安装目录选成任意已有目录（比如 D:\下载），
# 而卸载时执行的是 electron-builder 默认的 `RMDir /r $INSTDIR`——整个目录连
# 同用户自己的文件一起删掉。现在两头都堵：装的时候不让选非空目录，卸的时候
# 按安装清单逐条删，删完只用不带 /r 的 RMDir 收尾，目录里还剩别的东西就留着。

# 安装清单写在注册表里，不写成安装目录下的文件——清单文件自己又会成为
# "目录里多出来的一样东西"，而且卸载时还得处理它自己的编码和残留。
!define XINGMANG_INSTALLED_ENTRIES_KEY "${INSTALL_REGISTRY_KEY}\InstalledEntries"

# 与 electron/uninstall-cleanup-entry.ts 的 uninstallCleanupArgument 是同一个值，
# scripts/windows-installer-uninstall-cleanup.test.cjs 钉住两边一致。
!define XINGMANG_UNINSTALL_CLEANUP_ARGUMENT "--xingmang-uninstall-cleanup"

!ifndef BUILD_UNINSTALLER
  !ifdef allowToChangeInstallationDirectory
    # MUI 只认在 !insertmacro MUI_PAGE_DIRECTORY 之前定义的这个回调，而本文件
    # 正好被插在整个脚本最前面，所以这是唯一能定义它的位置。
    #
    # 目录页之前一旦多出别的 MUI 页面（例如将来往 build/ 里放了许可证文件，
    # electron-builder 就会插一个许可证页），这个 define 会被那个页面吃掉，
    # xingmangVerifyInstallDirectory 就变成没人引用的函数——electron-builder
    # 调 makensis 时带着 -WX，未引用的函数是警告、警告即错误，Windows 打包会
    # 当场红。也就是说守卫失效不会是静默的。
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE xingmangVerifyInstallDirectory
  !endif
!endif

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !ifdef allowToChangeInstallationDirectory
      # 目录页点"下一步"时校验。返回即放行，Abort 则停在当前页让用户重选。
      Function xingmangVerifyInstallDirectory
        # electron-builder 自己的 instFilesPre 会给不含产品名的目录再补一层
        # 子目录，而它在这个回调之后才跑。所以这里必须按同一条规则先算出真正
        # 会被写入的目录，否则用户选 D:\Downloads 会被误判成"装进非空目录"。
        StrCpy $R0 $INSTDIR
        ${StrContains} $R1 "${APP_FILENAME}" $INSTDIR
        ${If} $R1 == ""
          StrCpy $R0 "$INSTDIR\${APP_FILENAME}"
        ${EndIf}

        # 本程序自己的旧版本：升级覆盖必须照常可行，所以先认安装标记。
        ${If} ${FileExists} "$R0\${APP_EXECUTABLE_FILENAME}"
        ${OrIf} ${FileExists} "$R0\${UNINSTALL_FILENAME}"
          Return
        ${EndIf}

        # 目录不存在时 FindFirst 直接返回空，等同于空目录，不必先判存在。
        StrCpy $R2 "0"
        FindFirst $R3 $R4 "$R0\*.*"
        xingmangScanLoop:
          StrCmp $R4 "" xingmangScanDone
          StrCmp $R4 "." xingmangScanNext
          StrCmp $R4 ".." xingmangScanNext
          StrCpy $R2 "1"
          Goto xingmangScanDone
        xingmangScanNext:
          FindNext $R3 $R4
          Goto xingmangScanLoop
        xingmangScanDone:
        FindClose $R3

        ${If} $R2 == "1"
          MessageBox MB_OK|MB_ICONEXCLAMATION "这个目录里已经有别的文件：$\r$\n$R0$\r$\n$\r$\n卸载时可能连它们一起删掉，所以不能装在这里。请换一个空目录，或者选它的上一级目录，让安装程序自己新建一个。"
          Abort
        ${EndIf}
      FunctionEnd
    !endif

    # 安装收尾时把安装目录的顶层条目记成清单，卸载时只删这些。
    Function xingmangRecordInstalledEntries
      DeleteRegKey SHELL_CONTEXT "${XINGMANG_INSTALLED_ENTRIES_KEY}"
      StrCpy $R2 0
      StrCpy $R5 "ok"
      FindFirst $R3 $R4 "$INSTDIR\*.*"
      xingmangRecordLoop:
        StrCmp $R4 "" xingmangRecordDone
        StrCmp $R4 "." xingmangRecordNext
        StrCmp $R4 ".." xingmangRecordNext
        ClearErrors
        WriteRegStr SHELL_CONTEXT "${XINGMANG_INSTALLED_ENTRIES_KEY}" "$R2" "$R4"
        ${If} ${Errors}
          StrCpy $R5 "failed"
          Goto xingmangRecordDone
        ${EndIf}
        IntOp $R2 $R2 + 1
      xingmangRecordNext:
        FindNext $R3 $R4
        Goto xingmangRecordLoop
      xingmangRecordDone:
      FindClose $R3
      # Count 最后写：写不全就干脆不写，卸载程序会当成"没有清单"按旧办法处理。
      ${If} $R5 == "ok"
        WriteRegDWORD SHELL_CONTEXT "${XINGMANG_INSTALLED_ENTRIES_KEY}" "Count" $R2
      ${EndIf}
    FunctionEnd
  !endif

  !ifdef BUILD_UNINSTALLER
    # 把一个顶层条目挪进 $PLUGINSDIR\old-install（升级路径专用）。
    # 入栈 "\条目名"，出栈 0 表示成功，否则是挪不动的那个文件的完整路径。
    Function un.xingmangMoveAside
      Exch $R0
      Push $R1
      ${If} ${FileExists} "$INSTDIR$R0\*.*"
        # 目录不能整个改名：里面只要有一个文件被占用就会失败，所以按上游
        # 的办法逐个文件改名（正在运行的 exe/dll 是允许改名的）。
        CreateDirectory "$PLUGINSDIR\old-install$R0"
        Push "$R0"
        Call un.atomicRMDir
        Pop $R1
      ${Else}
        ClearErrors
        Rename "$INSTDIR$R0" "$PLUGINSDIR\old-install$R0"
        ${If} ${Errors}
          StrCpy $R1 "$INSTDIR$R0"
        ${Else}
          StrCpy $R1 0
        ${EndIf}
        # 卸载程序挪不动自己不算失败，和上游一致。
        ${If} $R0 == "\${UNINSTALL_FILENAME}"
          StrCpy $R1 0
        ${EndIf}
      ${EndIf}
      StrCpy $R0 $R1
      Pop $R1
      Exch $R0
    FunctionEnd

    # 开着加速时卸载：卸载程序会先把本程序连同加速辅助进程一起强行结束
    # （electron-builder 的 CHECK_APP_RUNNING 对安装目录下的进程 Stop-Process），
    # 辅助进程来不及把系统代理改回去，系统代理就一直指着本机一个没人监听的端口，
    # 整台电脑上不了网；开机项也会一直指着一个删掉了的 exe。
    #
    # 这两件事都交给程序自己做：它认得自己的恢复记录，只在系统代理仍是加速写进去
    # 的那一份时才还原，用户或别的软件后来改过的代理原样不动。这里只负责在删文件
    # 之前把它拉起来、等它结束。exe 在安装目录里，是这次卸载自己装的那一个，不查
    # PATH；参数是固定字面量，没有任何外部输入拼进命令行。
    #
    # 失败只记在详情里，不拦卸载：让用户卡在一个卸不掉的软件上，比留一条开机项更糟。
    Function un.xingmangUninstallCleanup
      ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        Return
      ${EndIf}
      Push $R0
      DetailPrint "Restoring system proxy and removing login item."
      ClearErrors
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${XINGMANG_UNINSTALL_CLEANUP_ARGUMENT}' $R0
      ${If} ${Errors}
        DetailPrint "Uninstall cleanup could not start."
      ${ElseIf} $R0 != 0
        DetailPrint "Uninstall cleanup finished with code $R0."
      ${EndIf}
      Pop $R0
    FunctionEnd

    Function un.xingmangRemoveInstalledFiles
      ClearErrors
      ReadRegDWORD $R4 SHELL_CONTEXT "${XINGMANG_INSTALLED_ENTRIES_KEY}" "Count"
      ${If} ${Errors}
      ${OrIf} $R4 < 1
        # 装这一份的是不写清单的老安装程序（或者当时清单没写成），没有别的
        # 依据可用，只能沿用 electron-builder 的老做法。
        ${If} ${isUpdated}
          CreateDirectory "$PLUGINSDIR\old-install"
          Push ""
          Call un.atomicRMDir
          Pop $R0
          ${If} $R0 != 0
            DetailPrint "File is busy, aborting: $R0"
            Push ""
            Call un.restoreFiles
            Pop $R0
            Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
          ${EndIf}
        ${EndIf}
        SetOutPath $TEMP
        RMDir /r $INSTDIR
        Return
      ${EndIf}

      ${If} ${isUpdated}
        CreateDirectory "$PLUGINSDIR\old-install"
      ${EndIf}

      # 先离开安装目录，否则它被当前进程占着删不掉。
      SetOutPath $TEMP

      StrCpy $R5 0
      xingmangRemoveLoop:
        ${If} $R5 >= $R4
          Goto xingmangRemoveDone
        ${EndIf}
        ClearErrors
        ReadRegStr $R6 SHELL_CONTEXT "${XINGMANG_INSTALLED_ENTRIES_KEY}" "$R5"
        ${If} ${Errors}
        ${OrIf} $R6 == ""
          Goto xingmangRemoveNext
        ${EndIf}
        ${If} ${isUpdated}
          Push "\$R6"
          Call un.xingmangMoveAside
          Pop $R7
          ${If} $R7 != 0
            DetailPrint "File is busy, aborting: $R7"
            Push ""
            Call un.restoreFiles
            Pop $R7
            Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
          ${EndIf}
        ${Else}
          ${If} ${FileExists} "$INSTDIR\$R6\*.*"
            # 子目录（resources、locales）整个是我们装的，可以递归删。
            RMDir /r "$INSTDIR\$R6"
          ${Else}
            Delete "$INSTDIR\$R6"
          ${EndIf}
        ${EndIf}
      xingmangRemoveNext:
        IntOp $R5 $R5 + 1
        Goto xingmangRemoveLoop
      xingmangRemoveDone:

      # 不带 /r：目录里还剩着不是我们装的东西就原样留着。
      RMDir "$INSTDIR"
    FunctionEnd
  !endif
!macroend

# 卸载区段里，这个宏在 CHECK_APP_RUNNING 已经结束掉程序之后、删文件之前执行。
# 升级安装也会以 --updated 跑一遍旧版的卸载程序：那时不能删开机项（用户的开关
# 会被悄悄关掉），也不必动代理（新版启动时会自己恢复），所以只在真正卸载时做。
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Call un.xingmangUninstallCleanup
  ${EndIf}
!macroend

# electron-builder 默认的"删除已安装文件"这一步是 `RMDir /r $INSTDIR`。
# 定义了这个宏就整段替换掉它。
!macro customRemoveFiles
  Call un.xingmangRemoveInstalledFiles
!macroend

# ---------------------------------------------------------------------------
# 安装完成后的兜底：确保桌面和开始菜单里确实有一个能点的快捷方式。
#
# Why this exists. electron-builder 自己的 addDesktopLink /
# addStartMenuLink 有两条会一声不吭跳过的路径，客户机上都撞得到：
#
#   1. 由应用内更新器拉起的安装带着 --updated，keepShortcuts 会变成 "true"，
#      整个建快捷方式的分支直接不执行。这本意是"用户删掉的别给他复活"，代价
#      是第一次安装没建成的机器，之后升多少次版桌面都一直是空的。
#   2. perMachine 安装时 SHELL_CONTEXT 指向公共桌面 C:\Users\Public\Desktop。
#      这一次 CreateShortCut 失败（组策略禁止写公共桌面、或者国内客户机上常见
#      的安全软件拦截安装程序建图标），安装程序不检查返回值，界面照样显示
#      安装成功，用户桌面上什么都没有。
#
# 所以这里只做加法：缺了才补，补不上公共桌面就退回执行安装的这个用户自己的
# 桌面。已经存在的快捷方式一律不碰，升级安装因此既不会多出第二个图标，也不会
# 把用户自己挪过位置或改过名字的那一个删掉。更新器拉起的静默安装不走这里，
# 用户主动删掉的图标不会被复活。
#
# 这段脚本在提权的安装进程里执行，所以只允许出现 CreateShortCut 与路径判断，
# 不读注册表以外的外部输入，也永远不删除任何文件。

!macro xingmangCreateShortcutIfMissing LinkPath
  ${IfNot} ${FileExists} "${LinkPath}"
    ClearErrors
    !ifdef APP_DESCRIPTION
      CreateShortCut "${LinkPath}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    !else
      CreateShortCut "${LinkPath}" "$appExe" "" "$appExe" 0
    !endif
    ClearErrors
  ${EndIf}
!macroend

# SetShellVarContext current 会同时改掉 $DESKTOP / $SMPROGRAMS / $APPDATA，
# 所以每次切过去都要在同一个分支里切回来，别让后面的宏看到错的上下文。
!macro xingmangRestoreShellVarContext
  ${If} $installMode == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
!macroend

!macro customInstall
  # 更新器拉起的安装（--updated）不补快捷方式：那条路径上"没有图标"最可能是
  # 用户自己删的，替他决定不合适。
  ${IfNot} ${isUpdated}
    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      ${IfNot} ${isNoDesktopShortcut}
        !insertmacro xingmangCreateShortcutIfMissing "$newDesktopLink"
        ${IfNot} ${FileExists} "$newDesktopLink"
          SetShellVarContext current
          !insertmacro xingmangCreateShortcutIfMissing "$DESKTOP\${SHORTCUT_NAME}.lnk"
          !insertmacro xingmangRestoreShellVarContext
        ${EndIf}
        System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
      ${EndIf}
    !endif

    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !insertmacro createMenuDirectory
      !insertmacro xingmangCreateShortcutIfMissing "$newStartMenuLink"
      ${IfNot} ${FileExists} "$newStartMenuLink"
        SetShellVarContext current
        !ifdef MENU_FILENAME
          CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
          ClearErrors
          !insertmacro xingmangCreateShortcutIfMissing "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
        !else
          !insertmacro xingmangCreateShortcutIfMissing "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
        !endif
        !insertmacro xingmangRestoreShellVarContext
      ${EndIf}
    !endif
  ${EndIf}

  # 升级安装也要记：清单跟着这一次实际装进去的文件走。
  Call xingmangRecordInstalledEntries
!macroend
