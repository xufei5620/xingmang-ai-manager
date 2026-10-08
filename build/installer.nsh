# electron-builder 的 NSIS 自定义脚本。本文件被插在生成脚本的最前面，
# 所以这里只能定义宏和 !define，真正的代码都在宏里，由模板在合适的位置插入。
#
# 这里一共做七件事，每一件都对应一个客户机上会真实发生的问题：
#
#   1. customInstall：安装收尾时补齐缺失的快捷方式（见下面那段长注释）。
#   2. customHeader 里的目录页守卫：不许把程序装进别人的非空目录。
#   3. customRemoveFiles：卸载时只删本程序自己装进去的东西。
#   4. customInit：系统太旧（Windows 10 以下）时一开始就说明并退出。
#   5. customUnInstall：删文件之前先还原加速改过的系统代理、删掉开机项，再删掉第 1 件事
#      补建在当前用户桌面和开始菜单里的图标。
#   6. customUnWelcomePage：卸载欢迎页上的「同时清除登录记录和聊天记录」勾选框（默认不勾）。
#   7. 装到 Program Files 以外时，把安装目录改成只有管理员能改（见 XINGMANG_INSTALL_DIRECTORY_SDDL）。
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
# 与 uninstall-cleanup-entry.ts 的 uninstallClearLoginArgument 是同一个值，同样由那份
# 测试钉住。卸载页勾了「同时清除登录记录和聊天记录」时跟在上面那个参数后面传给程序；静默卸载
# 没有页面可勾，在卸载程序自己的命令行上带同一个参数，效果等于勾上。
!define XINGMANG_CLEAR_LOGIN_ARGUMENT "--xingmang-clear-login"

# 装到 Program Files 以外时给安装目录设的权限。
#
# 自选目录（比如 D:\星芒AI管理工具）默认继承盘根的权限，Windows 给 D 盘这类非系统盘的
# 默认权限是「已验证的用户」可修改，也就是本机任何账户、当前用户下跑的任何普通程序都能
# 换掉里面的文件。而以管理员身份运行的几个进程会去执行这个目录里的文件：升级时新安装程序
# 先跑旧的卸载程序，卸载时卸载程序跑主程序做清理，更新时 resources\elevate.exe 负责弹
# UAC。所以这不只是「程序能被改」，而是谁都能借客户下一次更新或卸载拿到管理员权限。
#
# 改成跟 Program Files 下的程序目录一样：属主是 Administrators 组（O:BA），不再继承上级
# 目录（P），SYSTEM 和 Administrators 完全控制，Users 和两个应用包组（AC 与
# S-1-15-2-2，Program Files 也给它们）只能读和运行，子目录和文件都继承（OICI）。程序运行
# 本来就不往安装目录里写东西，装在 Program Files 时也是这样跑的。
!define XINGMANG_INSTALL_DIRECTORY_SDDL "O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;AC)(A;OICI;0x1200a9;;;S-1-15-2-2)"

!ifdef BUILD_UNINSTALLER
  # "1" 表示要清。没赋过值的变量是空串，所以不勾、静默卸载不带参数、升级时跑的
  # 旧卸载程序，都是保留登录，跟加这个勾选框以前一样。
  Var xingmangClearLogin
  Var xingmangClearLoginCheckbox
!endif

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

    # 目录页点「浏览」选了别的盘或文件夹之后，NSIS 会把 InstallDir 最后一段
    # 自动接到选中的目录后面（Ui.c 的 install_directory_auto_append；选中的文件夹
    # 本身就叫这个名字时不再接）。electron-builder 的模板不写 InstallDir，只在
    # .onInit 里给 $INSTDIR 赋默认值，于是选 D 盘就只剩光秃秃的「D:\」——NSIS
    # 不许装在盘根，「安装」按钮直接变灰，用户不知道该怎么办。
    #
    # 这里补一句 InstallDir，只为让浏览后接上跟默认位置同一个文件夹名。默认安装
    # 位置仍由 multiUser.nsh 在 .onInit 里决定（它会覆盖这里的值），/D= 参数与
    # 升级时读注册表里的旧位置也照旧。
    InstallDir "$PROGRAMFILES64\${APP_FILENAME}"
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
          !ifdef INSTALL_MODE_PER_ALL_USERS
            Push $R0
            Call xingmangLockInstallDirectory
          !endif
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

        !ifdef INSTALL_MODE_PER_ALL_USERS
          # 目录页后面紧接着就是安装页，这里就是定下来的那一刻。现在就把目录建好、收紧，
          # 不留到模板解压时再建：那样从建好到 customInstall 之间，解压出来的文件谁都能换。
          CreateDirectory "$R0"
          Push $R0
          Call xingmangLockInstallDirectory
        !endif
      FunctionEnd
    !endif

    !ifdef INSTALL_MODE_PER_ALL_USERS
      # 把一个目录的权限改成 XINGMANG_INSTALL_DIRECTORY_SDDL（为什么见那里）。入栈目录的完整路径。
      # Program Files 下面本来就只有管理员能改，不动。
      #
      # 这一步在提权的安装程序里执行，目录却可能在别人写得进去的地方，所以照
      # un.xingmangDeleteFallbackShortcut 的办法：先不跟链接地打开它，确认打开的就是这个
      # 路径上的那个真目录（路径里没有哪一段被联接、符号链接转到别处，它自己也不是链接），
      # 再经同一个句柄改权限，核对完再换也没用。打开时不许别人同时删、改名，拿着句柄期间
      # 这个目录挪不走。哪一条不对都不改，照现在的样子装下去：没改成总比改错了地方好。
      #
      # 网络位置不改：那上面的 Administrators、Users 是服务器自己的组，改了以后这台电脑的
      # 管理员可能反倒升级不了。FAT32、exFAT 这类没有权限的盘改不了，SetSecurityInfo
      # 报错，同样照原样装下去。
      #
      # 改的时候里面已有的文件跟着换成继承来的新权限（SetSecurityInfo 自己会往下传），
      # 升级时旧版本的卸载程序、主程序在模板执行它们之前就已经换不掉了。
      Function xingmangLockInstallDirectory
        Exch $R0
        Push $R1
        Push $R2
        Push $R3
        Push $R4
        Push $R5
        Push $R6
        Push $R7
        # 只认「盘符:\」开头的本机路径。
        StrCpy $R1 $R0 2 1
        ${If} $R1 == ":\"
          StrLen $R1 "$PROGRAMFILES64\"
          StrCpy $R2 $R0 $R1
          StrLen $R1 "$PROGRAMFILES32\"
          StrCpy $R3 $R0 $R1
          ${If} $R2 != "$PROGRAMFILES64\"
          ${AndIf} $R3 != "$PROGRAMFILES32\"
            # READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES；别人可以同时读、写，
            # 不能同时删、改名；OPEN_EXISTING；FILE_FLAG_BACKUP_SEMANTICS（打开目录要它）|
            # FILE_FLAG_OPEN_REPARSE_POINT（路径最后一段是链接时打开的是链接本身）。
            System::Call 'kernel32::CreateFileW(w R0, i 0xE0080, i 3, p 0, i 3, i 0x2200000, p 0) p .R1'
            ${If} $R1 <> -1
              # 系统给的是 \\?\D:\...，要改的路径按同样的写法拼出来再比。
              System::Call 'kernel32::GetFinalPathNameByHandleW(p R1, w .R2, i ${NSIS_MAX_STRLEN}, i 0) i .R3'
              ${If} $R3 > 0
              ${AndIf} $R3 < ${NSIS_MAX_STRLEN}
              ${AndIf} $R2 == "\\?\$R0"
                # FILE_ATTRIBUTE_TAG_INFO：得是文件夹（0x10），不能是重解析点（0x400）。
                System::Call '*(i, i) p .R2'
                System::Call 'kernel32::GetFileInformationByHandleEx(p R1, i 9, p R2, i 8) i .R3'
                System::Call '*$R2(i .R4, i .R5)'
                System::Free $R2
                IntOp $R5 $R4 & 0x10
                IntOp $R4 $R4 & 0x400
                ${If} $R3 <> 0
                ${AndIf} $R5 <> 0
                ${AndIf} $R4 = 0
                  # SDDL_REVISION_1。拿到的是一整块，属主和 DACL 都指在里面，用完 LocalFree。
                  # 权限串先放进寄存器再传：里面的括号、分号不进 System::Call 的参数串。
                  StrCpy $R6 "${XINGMANG_INSTALL_DIRECTORY_SDDL}"
                  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w R6, i 1, *p .R2, p 0) i .R3'
                  ${If} $R3 <> 0
                    System::Call 'advapi32::GetSecurityDescriptorOwner(p R2, *p .R4, *i .R7) i .R3'
                    System::Call 'advapi32::GetSecurityDescriptorDacl(p R2, *i .R7, *p .R5, *i .R7) i .R6'
                    ${If} $R3 <> 0
                    ${AndIf} $R6 <> 0
                      # SE_FILE_OBJECT；OWNER | DACL | PROTECTED_DACL（不再继承上级目录）。
                      System::Call 'advapi32::SetSecurityInfo(p R1, i 1, i 0x80000005, p R4, p 0, p R5, p 0) i'
                    ${EndIf}
                    System::Call 'kernel32::LocalFree(p R2) p'
                  ${EndIf}
                ${EndIf}
              ${EndIf}
              System::Call 'kernel32::CloseHandle(p R1)'
            ${EndIf}
          ${EndIf}
        ${EndIf}
        Pop $R7
        Pop $R6
        Pop $R5
        Pop $R4
        Pop $R3
        Pop $R2
        Pop $R1
        Pop $R0
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
    #
    # 普通账号卸载时要输别的管理员的密码，这一支就以那个管理员的身份运行，看到的
    # 当前用户注册表和数据目录都是那个管理员的。程序自己会认出这种情况，什么都不清、
    # 以 32 退出（uninstall-cleanup.ts 的 otherAccount，#498）：别人的东西不该动。
    Function un.xingmangUninstallCleanup
      ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        Return
      ${EndIf}
      Push $R0
      DetailPrint "正在还原系统代理，移除开机启动项，并收回写进 AI 工具里的提醒设置。"
      ClearErrors
      ${If} $xingmangClearLogin == "1"
        DetailPrint "正在清除登录记录。"
        ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${XINGMANG_UNINSTALL_CLEANUP_ARGUMENT} ${XINGMANG_CLEAR_LOGIN_ARGUMENT}' $R0
      ${Else}
        ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${XINGMANG_UNINSTALL_CLEANUP_ARGUMENT}' $R0
      ${EndIf}
      ${If} ${Errors}
        DetailPrint "卸载清理没能启动，可以忽略，不影响卸载。"
      ${ElseIf} $R0 == 32
        DetailPrint "这次是用另一个管理员账号卸载的，原来那个账号的开机启动项、登录记录和工具里的提醒设置都没有动。"
      ${ElseIf} $R0 != 0
        # 退出码只给排查的人看，单独一行，不混进给用户读的那句。
        DetailPrint "卸载清理已完成，有几项没清掉，不影响卸载。"
        DetailPrint "（排查用代码：$R0）"
      ${EndIf}
      Pop $R0
    FunctionEnd

    !ifdef DO_NOT_CREATE_DESKTOP_SHORTCUT & DO_NOT_CREATE_START_MENU_SHORTCUT
      # 两种图标都不建就没有要删的，下面这个函数没人调用，makensis -WX 会报错。
    !else
      # 删一个补建的图标，入栈它的完整路径。
      #
      # 卸载程序是提权跑的，这两个图标却在当前用户自己就能改的地方：用户这边的程序
      # 可以把桌面、开始菜单换成联接，或者在这个名字上放一个符号链接，让提权的删除
      # 落到别的文件上。所以不用 Delete，而是先不跟链接地打开它，确认打开的就是这个
      # 路径上的那个文件（路径里没有哪一段被联接、符号链接转到别处），它不是文件夹、
      # 也不是指向别处的链接，再经同一个句柄删掉：删的就是核对过的那一个，核对完再
      # 换也没用。哪一条不对都不删，留一个点不开的图标总比删错东西好。硬链接不用管，
      # 删掉的只是这一个名字，内容在别的名字上原样还在。
      Function un.xingmangDeleteFallbackShortcut
        Exch $R0
        Push $R1
        Push $R2
        Push $R3
        Push $R4
        Push $R5
        Push $R6
        StrCpy $R6 "0"
        # DELETE | FILE_READ_ATTRIBUTES，读、写、删都允许别人同时打开，OPEN_EXISTING，
        # FILE_FLAG_OPEN_REPARSE_POINT：路径最后一段是链接时打开的是链接本身。
        System::Call 'kernel32::CreateFileW(w R0, i 0x10080, i 7, p 0, i 3, i 0x200000, p 0) p .R1'
        ${If} $R1 <> -1
          # 系统给的是 \\?\C:\... 或 \\?\UNC\服务器\共享\...，要删的路径按同样的写法拼出来再比。
          System::Call 'kernel32::GetFinalPathNameByHandleW(p R1, w .R2, i ${NSIS_MAX_STRLEN}, i 0) i .R3'
          StrCpy $R4 $R0 2
          ${If} $R4 == "\\"
            StrCpy $R4 $R0 "" 2
            StrCpy $R4 "\\?\UNC\$R4"
          ${Else}
            StrCpy $R4 "\\?\$R0"
          ${EndIf}
          ${If} $R3 > 0
          ${AndIf} $R3 < ${NSIS_MAX_STRLEN}
          ${AndIf} $R2 == $R4
            # FILE_ATTRIBUTE_TAG_INFO：属性，和重解析点的标记。
            System::Call '*(i, i) p .R2'
            System::Call 'kernel32::GetFileInformationByHandleEx(p R1, i 9, p R2, i 8) i .R3'
            System::Call '*$R2(i .R4, i .R5)'
            System::Free $R2
            ${If} $R3 <> 0
              StrCpy $R6 "1"
              # 文件夹不删。
              IntOp $R3 $R4 & 0x10
              ${If} $R3 <> 0
                StrCpy $R6 "0"
              ${EndIf}
              # 符号链接、联接这类指向别处的重解析点不删；OneDrive 占位符那类不指向别处的照删。
              IntOp $R3 $R4 & 0x400
              IntOp $R5 $R5 & 0x20000000
              ${If} $R3 <> 0
              ${AndIf} $R5 <> 0
                StrCpy $R6 "0"
              ${EndIf}
            ${EndIf}
            ${If} $R6 == "1"
              # FileDispositionInfo：句柄关掉时删除。
              System::Call 'kernel32::SetFileInformationByHandle(p R1, i 4, *i 1, i 4) i'
            ${EndIf}
          ${EndIf}
          System::Call 'kernel32::CloseHandle(p R1)'
        ${EndIf}
        Pop $R6
        Pop $R5
        Pop $R4
        Pop $R3
        Pop $R2
        Pop $R1
        Pop $R0
      FunctionEnd
    !endif

    # 公共桌面、公共开始菜单写不进去的电脑上，customInstall 把图标补建在执行安装的
    # 这个用户自己的桌面和开始菜单里。模板卸载时只删 setLinkVars 在「所有用户」
    # 上下文里算出的那两个，补建的这两个没人删：卸完留着点不开的图标；以后重装到
    # 别的文件夹，customInstall 看见同名图标还在，也不再补。
    #
    # 所以这里删的就是补建时写的那几个固定路径：图标名是编译期常量，不用通配符，
    # 不带 /r，每一个都经 un.xingmangDeleteFallbackShortcut 核对过才删。只在真卸载时
    # 调（见 customUnInstall）：升级时新版不补图标，这时删了图标就真没了。普通账号输
    # 管理员密码安装、卸载时，补建和删除都落在那个管理员自己的桌面上。
    Function un.xingmangRemoveFallbackShortcuts
      # 按当前用户安装时，模板删的本来就是当前用户那两个；带 --keep-shortcuts 时
      # 跟模板一样一个都不删。
      ${If} $installMode != "all"
      ${OrIf} ${isKeepShortcuts}
        Return
      ${EndIf}
      SetShellVarContext current
      !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
        !insertmacro xingmangRemoveFallbackShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
      !endif
      !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
        !ifdef MENU_FILENAME
          !insertmacro xingmangRemoveFallbackShortcut "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
          # 不带 /r：文件夹里还有别的东西就留着。
          RMDir "$SMPROGRAMS\${MENU_FILENAME}"
        !else
          !insertmacro xingmangRemoveFallbackShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
        !endif
      !endif
      !insertmacro xingmangRestoreShellVarContext
    FunctionEnd

    # 卸载欢迎页上加一个勾选框。欢迎页正文标签占到 175u（MUI2 Welcome.nsh：从 45u
    # 起 130u 高），整页 193u 高，勾选框放在正文下面、页面底边之内。背景跟欢迎页
    # 一样是白的，不设就会是一块灰底。
    Function un.xingmangWelcomeShow
      ${NSD_CreateCheckbox} 120u 178u 195u 12u "同时清除登录记录和聊天记录"
      Pop $xingmangClearLoginCheckbox
      SetCtlColors $xingmangClearLoginCheckbox "" "${MUI_BGCOLOR}"
      # 从后一页点「上一步」回来，照上次的选择显示。
      ${If} $xingmangClearLogin == "1"
        ${NSD_Check} $xingmangClearLoginCheckbox
      ${EndIf}
    FunctionEnd

    Function un.xingmangWelcomeLeave
      Push $R0
      ${NSD_GetState} $xingmangClearLoginCheckbox $R0
      ${If} $R0 == ${BST_CHECKED}
        StrCpy $xingmangClearLogin "1"
      ${Else}
        StrCpy $xingmangClearLogin "0"
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
            DetailPrint "（排查用代码：$R0）"
            Push ""
            Call un.restoreFiles
            Pop $R0
            Abort "星芒AI管理工具还在运行，或文件被别的程序占用。请先退出软件（包括右下角托盘里的图标），再重新安装。"
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
            DetailPrint "（排查用代码：$R7）"
            Push ""
            Call un.restoreFiles
            Pop $R7
            Abort "星芒AI管理工具还在运行，或文件被别的程序占用。请先退出软件（包括右下角托盘里的图标），再重新安装。"
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

# ---------------------------------------------------------------------------
# 系统版本守卫。
#
# electron-builder 模板自己的 check64BitAndSetRegView 只拦 Vista 及更早的系统
# 和 32 位 Windows（后者有模板自带的中文提示），而 Electron 从 23 起就不再支持
# Windows 7 / 8 / 8.1。不拦的话，这些机器能把程序完整装上，双击却打不开，也没有
# 任何提示——付费用户只会以为软件坏了。
#
# Windows 10 ARM64 同理：它只能仿真 32 位 x86，仿真不了 x64，而我们只出 x64 包。
# 32 位的 NSIS 安装程序在那上面照样跑得起来，模板的 RunningX64 也会放行
# （IsWow64Process 在 ARM64 上同样返回真）。x64 仿真从 Windows 11（build 22000）
# 才有。
#
# customInit 在模板的 .onInit 里排在 check64BitAndSetRegView、单实例检查和
# initMultiUser 之后；这三步只读注册表、建互斥量，什么都不写。这里 Quit 之后
# 安装界面不会出现，不会写任何文件或注册表。perMachine 安装的清单要求管理员
# 权限，所以 UAC 弹窗会在这句提示之前出现，这是清单层面的事，脚本管不到。
#
# AtLeastWin10 靠 GetVersionEx，未在清单里声明支持 Windows 10 时会被系统谎报成
# 8.x；makensis 默认的 ManifestSupportedOS 是 all，包含 Windows 10 的 GUID，
# electron-builder 也没有覆盖它，所以这里拿到的是真实版本。
#
# /SD IDOK：静默安装（/S）时不弹框、直接按"确定"走，免得挂住。
!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "星芒AI管理工具需要 Windows 10 或更新的系统。$\r$\n$\r$\n这台电脑的系统版本太旧，装上也打不开，所以这次没有安装任何东西。" /SD IDOK
    Quit
  ${EndIf}
  ${If} ${IsNativeARM64}
  ${AndIfNot} ${AtLeastBuild} 22000
    MessageBox MB_OK|MB_ICONSTOP "星芒AI管理工具在这台电脑上需要 Windows 11 才能运行（ARM 处理器的 Windows 10 不支持）。$\r$\n$\r$\n这次没有安装任何东西。" /SD IDOK
    Quit
  ${EndIf}
  !ifdef INSTALL_MODE_PER_ALL_USERS
    # 走到这里 $INSTDIR 已经是注册表里记的旧安装位置，或者命令行 /D= 给的位置（更新器
    # 拉起的升级、静默安装都是这两种；/D= 的目录 .onInit 一开头已经建好）。赶在模板执行
    # 旧的卸载程序、解压新文件之前把它收紧，见 xingmangLockInstallDirectory。目录不存在
    # 就什么也不做，有界面的安装在目录页定下来时再收紧。
    Push $INSTDIR
    Call xingmangLockInstallDirectory
  !endif
!macroend

# electron-builder 的卸载界面第一页是 MUI_UNPAGE_WELCOME；定义了这个宏就由这里
# 插入那一页，只多挂两个回调：显示时加勾选框，离开时记下勾没勾。
!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.xingmangWelcomeShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.xingmangWelcomeLeave
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

# 在模板的 un.onInit 最后执行。静默卸载（/S）不显示欢迎页，想清登录记录只能从
# 命令行说；客服远程协助和 CI 冒烟都走这条。
!macro customUnInit
  Push $R0
  Push $R1
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "${XINGMANG_CLEAR_LOGIN_ARGUMENT}" $R1
  ${IfNot} ${Errors}
    StrCpy $xingmangClearLogin "1"
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

# 卸载时删一个补建的图标。跟模板删公共图标一样先 WinShell::UninstShortcut；删本身
# 交给 un.xingmangDeleteFallbackShortcut，为什么不直接 Delete 见那里。
!macro xingmangRemoveFallbackShortcut LinkPath
  WinShell::UninstShortcut "${LinkPath}"
  Push "${LinkPath}"
  Call un.xingmangDeleteFallbackShortcut
!macroend

# 卸载区段里，这个宏在 CHECK_APP_RUNNING 已经结束掉程序之后、删文件之前执行。
# 升级安装也会以 --updated 跑一遍旧版的卸载程序：那时不能删开机项（用户的开关
# 会被悄悄关掉），也不必动代理（新版启动时会自己恢复），补建的图标也得留着
# （新版不会再补），所以只在真正卸载时做。
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Call un.xingmangUninstallCleanup
    Call un.xingmangRemoveFallbackShortcuts
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
# 用户主动删掉的图标不会被复活。补到当前用户那里的图标，模板卸载时不管，由
# un.xingmangRemoveFallbackShortcuts 按同样的路径删掉，两边要一起改。
#
# 补图标这段脚本在提权的安装进程里执行，所以只允许出现 CreateShortCut 与路径判断，
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
  !ifdef INSTALL_MODE_PER_ALL_USERS
    # customInit 和目录页已经收紧过一次。这里再来一次，兜住 $INSTDIR 在那之后又变了的情况：
    # 更新器拉起的有界面安装跳过目录页，模板的 instFilesPre 却可能给旧位置再补一层产品名。
    Push $INSTDIR
    Call xingmangLockInstallDirectory
  !endif

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
