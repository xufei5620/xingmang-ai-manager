# 安装完成后的兜底：确保桌面和开始菜单里确实有一个能点的快捷方式。
#
# Why this file exists. electron-builder 自己的 addDesktopLink /
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
!macroend
