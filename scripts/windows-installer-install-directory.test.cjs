const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const customIncludePath = path.join(root, 'build', 'installer.nsh')

// 同 windows-installer-shortcuts.test.cjs：子进程读配置，构建模式变量由用例说了算。
function loadNsisConfig() {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({ nsis: config.nsis }))
  `], { cwd: root, encoding: 'utf8', env: environment })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function readCustomInclude() {
  return fs.readFileSync(customIncludePath, 'utf8')
}

// 取一个 !macro / Function 的函数体，用来把断言限定在它里面。
function bodyOf(contents, header, terminator) {
  const start = contents.indexOf(header)
  assert.notEqual(start, -1, `missing ${header}`)
  const end = contents.indexOf(terminator, start)
  assert.notEqual(end, -1, `missing ${terminator} after ${header}`)
  return contents.slice(start, end)
}

test('the directory page leave callback is wired up at the top level of the script', () => {
  const contents = readCustomInclude()
  // MUI 只认插入 MUI_PAGE_DIRECTORY 之前定义的这个回调。本文件被 electron-builder
  // 插在生成脚本最前面，所以这行必须留在顶层——挪进任何一个宏里都晚了。
  const define = /^\s*!define MUI_PAGE_CUSTOMFUNCTION_LEAVE xingmangVerifyInstallDirectory$/m
  assert.match(contents, define)
  const definePosition = contents.search(define)
  const firstMacro = contents.indexOf('!macro ')
  assert.ok(definePosition < firstMacro, 'the leave callback define must come before the first macro')
})

test('browsing to another drive or folder appends the default folder name', () => {
  const contents = readCustomInclude()
  // NSIS 只在编译期有 InstallDir 时，才会把它最后一段接到「浏览」选中的目录后面。
  // electron-builder 的模板不写这一句，选 D 盘就只剩「D:\」，NSIS 不许装在盘根，
  // 「安装」按钮变灰。结尾不能带反斜杠，否则 NSIS 会关掉自动追加。
  const installDir = /^\s*InstallDir "\$PROGRAMFILES64\\\$\{APP_FILENAME\}"$/m
  assert.match(contents, installDir)
  // 只该出现一次，且只进安装程序、只在目录可改时编译。
  assert.equal(contents.match(/^\s*InstallDir /gm).length, 1)
  const position = contents.search(installDir)
  const guard = contents.lastIndexOf('!ifdef allowToChangeInstallationDirectory', position)
  assert.ok(guard !== -1 && contents.lastIndexOf('!ifndef BUILD_UNINSTALLER', guard) !== -1)
  assert.ok(contents.indexOf('!endif', guard) > position, 'InstallDir must stay inside the guard')
  assert.ok(position < contents.indexOf('!macro '), 'InstallDir must be at the top level of the script')
})

test('the directory page refuses a non-empty directory that is not a previous install', () => {
  const body = bodyOf(readCustomInclude(), 'Function xingmangVerifyInstallDirectory', 'FunctionEnd')
  // 升级覆盖必须照常可行：目录里有本程序的主 exe 或卸载程序就直接放行。
  assert.match(body, /\$\{If\} \$\{FileExists\} "\$R0\\\$\{APP_EXECUTABLE_FILENAME\}"/)
  assert.match(body, /\$\{OrIf\} \$\{FileExists\} "\$R0\\\$\{UNINSTALL_FILENAME\}"/)
  // electron-builder 的 instFilesPre 在这个回调之后才补产品名子目录，所以这里
  // 得先按同一条规则算出真正会被写入的目录，否则选 D:\Downloads 会被误拒。
  assert.match(body, /\$\{StrContains\} \$R1 "\$\{APP_FILENAME\}" \$INSTDIR/)
  assert.match(body, /StrCpy \$R0 "\$INSTDIR\\\$\{APP_FILENAME\}"/)
  // 目录非空时用中文提示并停在当前页（Abort 在 leave 回调里就是"别往下走"）。
  const messageBox = body.match(/MessageBox [^\n]*\n/)
  assert.ok(messageBox, 'the guard shows no message box')
  assert.match(messageBox[0], /[\u4e00-\u9fff]/, 'the message to the user must be in Chinese')
  assert.match(body, /^\s*Abort$/m)
})

test('the guard survives as a build failure rather than silently going missing', () => {
  const { nsis } = loadNsisConfig()
  // 两个前提：目录可改（否则守卫整段不编译，也就没必要），以及 makensis 仍然
  // 带着 -WX 跑。有了 -WX，万一目录页之前多出一个 MUI 页面把 LEAVE 的 define
  // 吃掉，xingmangVerifyInstallDirectory 就成了未引用函数，打包当场红。
  assert.equal(nsis.allowToChangeInstallationDirectory, true)
  assert.notEqual(nsis.warningsAsErrors, false)
})

test('the uninstaller replaces the default whole-directory recursive delete', () => {
  const contents = readCustomInclude()
  // 不定义 customRemoveFiles，electron-builder 默认执行 `RMDir /r $INSTDIR`，
  // 把用户自己放在安装目录里的文件一起删掉。
  assert.match(contents, /^!macro customRemoveFiles$/m)
  const body = bodyOf(contents, '!macro customRemoveFiles', '!macroend')
  assert.match(body, /Call un\.xingmangRemoveInstalledFiles/)
})

test('the uninstaller only removes the entries recorded at install time', () => {
  const contents = readCustomInclude()
  const install = bodyOf(contents, 'Function xingmangRecordInstalledEntries', 'FunctionEnd')
  // 清单写进注册表，Count 最后写：写不全就当成没有清单。
  assert.match(install, /WriteRegStr SHELL_CONTEXT "\$\{XINGMANG_INSTALLED_ENTRIES_KEY\}" "\$R2" "\$R4"/)
  const countWrite = install.indexOf('WriteRegDWORD')
  const entryWrite = install.indexOf('WriteRegStr')
  assert.ok(entryWrite !== -1 && countWrite > entryWrite, 'Count must be written after the entries')

  const customInstall = bodyOf(contents, '!macro customInstall', '!macroend')
  assert.match(customInstall, /Call xingmangRecordInstalledEntries/)

  const remove = bodyOf(contents, 'Function un.xingmangRemoveInstalledFiles', 'FunctionEnd')
  assert.match(remove, /ReadRegDWORD \$R4 SHELL_CONTEXT "\$\{XINGMANG_INSTALLED_ENTRIES_KEY\}" "Count"/)
  // 收尾只用不带 /r 的 RMDir：目录里还剩着不是我们装的东西就留着。
  assert.match(remove, /^\s*RMDir "\$INSTDIR"$/m)
})

test('the whole install directory is only wiped on the no-manifest fallback path', () => {
  const remove = bodyOf(readCustomInclude(), 'Function un.xingmangRemoveInstalledFiles', 'FunctionEnd')
  const wipes = remove.split('\n').filter((line) => /^\s*RMDir \/r \$INSTDIR\s*$/.test(line))
  // 老安装程序没留清单，只能沿用旧做法——但有且只有那一处，且必须在读不到
  // 清单的分支里，后面紧跟着 Return。
  assert.equal(wipes.length, 1, 'expected exactly one legacy whole-directory delete')
  const fallback = remove.slice(
    remove.indexOf('ReadRegDWORD'),
    remove.indexOf('RMDir /r $INSTDIR') + 'RMDir /r $INSTDIR'.length,
  )
  assert.match(fallback, /\$\{If\} \$\{Errors\}/)
  assert.match(remove.slice(remove.indexOf('RMDir /r $INSTDIR')), /^\s*Return$/m)
})

test('the installed entries registry key hangs off the install registry key', () => {
  const contents = readCustomInclude()
  // 挂在 ${INSTALL_REGISTRY_KEY} 下面，卸载收尾的 DeleteRegKey 会连它一起删掉。
  assert.match(
    contents,
    /^!define XINGMANG_INSTALLED_ENTRIES_KEY "\$\{INSTALL_REGISTRY_KEY\}\\InstalledEntries"$/m,
  )
})

// 装到 Program Files 以外时把安装目录收紧（Codex 逆向报告第 3 条）：自选目录默认继承盘根的
// 「已验证的用户可修改」，以管理员身份跑的升级、卸载又会执行里面的文件。
test('a custom install directory gets the permissions of a Program Files program folder', () => {
  const contents = readCustomInclude()
  const define = contents.match(/^!define XINGMANG_INSTALL_DIRECTORY_SDDL "([^"]+)"$/m)
  assert.ok(define, 'missing XINGMANG_INSTALL_DIRECTORY_SDDL')
  // 属主 Administrators 组；不再继承上级目录；只有 SYSTEM 和 Administrators 能改，
  // Users 和两个应用包组只读和运行（0x1200a9），全都往子目录和文件继承。少一条、多一条
  // 能写的，都会让这一步要么白做、要么把程序弄坏，所以整串钉死。
  assert.equal(define[1], 'O:BAD:PAI'
    + '(A;OICI;FA;;;SY)'
    + '(A;OICI;FA;;;BA)'
    + '(A;OICI;0x1200a9;;;BU)'
    + '(A;OICI;0x1200a9;;;AC)'
    + '(A;OICI;0x1200a9;;;S-1-15-2-2)')
})

test('locking the install directory goes through one verified handle and never follows a link', () => {
  const body = bodyOf(readCustomInclude(), 'Function xingmangLockInstallDirectory', 'FunctionEnd')
  // 打开时：FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT，不跟链接；共享方式
  // 只给读、写（3），拿着句柄期间目录不能被删、改名、换成联接。
  const open = body.match(/System::Call 'kernel32::CreateFileW\(w R0, i (0x[0-9A-Fa-f]+), i (\d+), p 0, i 3, i (0x[0-9A-Fa-f]+), p 0\) p \.R1'/)
  assert.ok(open, 'the directory is not opened with CreateFileW into R1')
  // READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES，没有 DELETE。
  assert.equal(Number(open[1]), 0x20000 | 0x40000 | 0x80000 | 0x80)
  assert.equal(Number(open[2]) & 4, 0, 'others may delete or rename the directory while it is being locked')
  assert.equal(Number(open[3]), 0x02000000 | 0x00200000)
  // 打开的必须就是这个路径上的那一个：最终路径一字不差，自己是文件夹、不是重解析点。
  assert.match(body, /GetFinalPathNameByHandleW\(p R1, w \.R2, i \$\{NSIS_MAX_STRLEN\}, i 0\)/)
  assert.match(body, /\$\{AndIf\} \$R2 == "\\\\\?\\\$R0"/)
  assert.match(body, /GetFileInformationByHandleEx\(p R1, i 9, p R2, i 8\)/)
  assert.match(body, /IntOp \$R5 \$R4 & 0x10\n/)
  assert.match(body, /IntOp \$R4 \$R4 & 0x400\n/)
  assert.match(body, /\$\{AndIf\} \$R4 = 0\n/)
  // 改权限也经同一个句柄：属主、DACL，且不再继承（PROTECTED_DACL）。
  const set = body.match(/advapi32::SetSecurityInfo\(p R1, i 1, i (0x[0-9A-Fa-f]+), p R4, p 0, p R5, p 0\)/)
  assert.ok(set, 'the permissions are not set through the verified handle')
  // OWNER_SECURITY_INFORMATION + DACL_SECURITY_INFORMATION + PROTECTED_DACL_SECURITY_INFORMATION。
  assert.equal(Number(set[1]), 0x1 + 0x4 + 0x80000000)
  assert.match(body, /StrCpy \$R6 "\$\{XINGMANG_INSTALL_DIRECTORY_SDDL\}"\n\s*System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW\(w R6, i 1, \*p \.R2, p 0\)/)
  assert.match(body, /kernel32::LocalFree\(p R2\)/)
  assert.match(body, /kernel32::CloseHandle\(p R1\)/)
  // 不按名字改，也不起外部程序（icacls、cmd、PowerShell）：按名字就又要跟链接走一遍（I14）。
  for (const forbidden of [/SetNamedSecurityInfo/, /SetFileSecurity/, /icacls/i, /\bExec(Wait|Shell)?\b/, /nsExec/, /powershell/i]) {
    assert.doesNotMatch(body, forbidden)
  }
})

test('locking leaves Program Files and network locations alone', () => {
  const body = bodyOf(readCustomInclude(), 'Function xingmangLockInstallDirectory', 'FunctionEnd')
  // 只认「盘符:\」开头的路径：\\服务器\共享 上的 Administrators、Users 是服务器自己的组。
  assert.match(body, /StrCpy \$R1 \$R0 2 1\n\s*\$\{If\} \$R1 == ":\\"/)
  // Program Files 下面本来就只有管理员能改，默认位置的客户什么都不变。
  assert.match(body, /\$\{If\} \$R2 != "\$PROGRAMFILES64\\"\n\s*\$\{AndIf\} \$R3 != "\$PROGRAMFILES32\\"/)
  const open = body.indexOf('kernel32::CreateFileW')
  assert.ok(body.indexOf('$PROGRAMFILES64') < open && body.indexOf(':\\"') < open)
})

// 每一处调用都得包在 !ifdef INSTALL_MODE_PER_ALL_USERS 里：只给当前用户装的安装程序不提权，
// 收紧以后它自己就再也升级不了。
function assertPerMachineOnly(contents, index, what) {
  const guard = contents.lastIndexOf('!ifdef INSTALL_MODE_PER_ALL_USERS', index)
  assert.notEqual(guard, -1, `${what} is not behind !ifdef INSTALL_MODE_PER_ALL_USERS`)
  const between = contents.slice(guard, index)
  const opened = (between.match(/^\s*!if(n?def)?\b/gm) ?? []).length
  const closed = (between.match(/^\s*!endif\b/gm) ?? []).length
  assert.ok(opened > closed, `${what} is not behind !ifdef INSTALL_MODE_PER_ALL_USERS`)
}

test('the install directory is locked before the old uninstaller runs and before any file is extracted', () => {
  const contents = readCustomInclude()
  const call = /Push (\$INSTDIR|\$R0)\n\s*Call xingmangLockInstallDirectory\n/

  // 升级、静默安装：.onInit 里 $INSTDIR 已经定了，模板随后才执行旧卸载程序、解压。
  const init = bodyOf(contents, '!macro customInit', '!macroend')
  assert.match(init, /Push \$INSTDIR\n\s*Call xingmangLockInstallDirectory\n/)
  assert.ok(init.indexOf('xingmangLockInstallDirectory') > init.lastIndexOf('Quit'), 'lock only after the system checks pass')

  // 有界面的安装：目录页一定下来就建好、收紧，升级覆盖那条提前返回的分支也一样。
  const verify = bodyOf(contents, 'Function xingmangVerifyInstallDirectory', 'FunctionEnd')
  const upgrade = verify.slice(verify.indexOf('${FileExists} "$R0\\${APP_EXECUTABLE_FILENAME}"'), verify.indexOf('Return'))
  assert.match(upgrade, /Push \$R0\n\s*Call xingmangLockInstallDirectory\n/)
  const fresh = verify.slice(verify.lastIndexOf('Abort'))
  assert.match(fresh, /CreateDirectory "\$R0"\n\s*Push \$R0\n\s*Call xingmangLockInstallDirectory\n/)

  // 收尾再来一次，兜住 $INSTDIR 在那之后又被模板改过的情况。
  const install = bodyOf(contents, '!macro customInstall', '!macroend')
  assert.match(install, /Push \$INSTDIR\n\s*Call xingmangLockInstallDirectory\n/)

  let index = contents.search(call)
  let calls = 0
  while (index !== -1) {
    assertPerMachineOnly(contents, index, 'a call to xingmangLockInstallDirectory')
    calls += 1
    const next = contents.slice(index + 1).search(call)
    index = next === -1 ? -1 : index + 1 + next
  }
  assert.equal(calls, 4)
})

test('the lock is compiled into the per-machine installer only, never into the uninstaller', () => {
  const contents = readCustomInclude()
  const definition = contents.indexOf('Function xingmangLockInstallDirectory')
  assert.notEqual(definition, -1)
  assertPerMachineOnly(contents, definition, 'xingmangLockInstallDirectory')
  // 跟 xingmangRecordInstalledEntries 同在 customHeader 的安装程序那一半里。
  const header = bodyOf(contents, '!macro customHeader', '!macroend')
  const installerHalf = header.slice(header.indexOf('!ifndef BUILD_UNINSTALLER'), header.indexOf('!ifdef BUILD_UNINSTALLER'))
  assert.ok(installerHalf.includes('Function xingmangLockInstallDirectory'))
  // 前提是本来就只出按整台电脑装的安装程序。
  const { nsis } = loadNsisConfig()
  assert.equal(nsis.perMachine, true)
})

// 升级时模板先跑旧版本的卸载程序，它挪不开某一项就以 2 放弃，模板只弹一句英文就退出
// （客户截图：「Failed to uninstall old application files. Please try running the installer again.: 2」）。
test('entries the manifest names but the install no longer has are dropped before the old uninstaller runs', () => {
  const contents = readCustomInclude()
  const init = bodyOf(contents, '!macro customInit', '!macroend')
  // .onInit 里、模板执行旧卸载程序之前；系统版本不够时已经 Quit，轮不到这里。
  assert.match(init, /^\s*Call xingmangForgetMissingInstalledEntries$/m)
  assert.ok(init.indexOf('xingmangForgetMissingInstalledEntries') > init.lastIndexOf('Quit'))

  const forget = bodyOf(contents, 'Function xingmangForgetMissingInstalledEntries', 'FunctionEnd')
  // 看的是旧卸载程序将要拿到的那个目录。
  assert.match(forget, /ReadRegStr \$R0 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/)
  assert.match(forget, /ReadRegDWORD \$R1 SHELL_CONTEXT "\$\{XINGMANG_INSTALLED_ENTRIES_KEY\}" "Count"/)
  assert.match(forget, /\$\{AndIfNot\} \$\{FileExists\} "\$R0\\\$R3"\n\s*DeleteRegValue SHELL_CONTEXT "\$\{XINGMANG_INSTALLED_ENTRIES_KEY\}" "\$R2"/)
  // 只删记录，不碰文件；Count 不动，卸载程序读到空项本来就跳过。
  for (const forbidden of [/\bDelete\b(?!RegValue)/, /\bRMDir\b/, /\bRename\b/, /\bExec/, /WriteReg/, /DeleteRegKey/]) {
    assert.doesNotMatch(forget, forbidden)
  }
  const remove = bodyOf(contents, 'Function un.xingmangRemoveInstalledFiles', 'FunctionEnd')
  assert.match(remove, /\$\{If\} \$\{Errors\}\n\s*\$\{OrIf\} \$R6 == ""\n\s*Goto xingmangRemoveNext/)
  // $R0～$R3 原样还给 .onInit。
  assert.match(forget, /^Function xingmangForgetMissingInstalledEntries\n\s*Push \$R0\n\s*Push \$R1\n\s*Push \$R2\n\s*Push \$R3\n/)
  assert.match(forget, /Pop \$R3\n\s*Pop \$R2\n\s*Pop \$R1\n\s*Pop \$R0\n\s*$/)
})

test('the uninstaller counts an entry that is already gone as moved aside', () => {
  const move = bodyOf(readCustomInclude(), 'Function un.xingmangMoveAside', 'FunctionEnd')
  // 先看在不在，不在就是 0；否则 Rename 一个不存在的文件必然失败，被当成「挪不动」。
  assert.match(move, /\$\{IfNot\} \$\{FileExists\} "\$INSTDIR\$R0"\n\s*StrCpy \$R1 0\n\s*\$\{ElseIf\} \$\{FileExists\} "\$INSTDIR\$R0\\\*\.\*"/)
  assert.ok(move.indexOf('${IfNot} ${FileExists}') < move.indexOf('Rename'))
})

test('an old uninstaller that gives up gets a Chinese retry dialog instead of the template\'s English one', () => {
  const contents = readCustomInclude()
  // 定义了 customUnInstallCheck，模板 handleUninstallResult 里那句英文 MessageBox 就整段跳过。
  const check = bodyOf(contents, '!macro customUnInstallCheck', '!macroend')
  assert.match(check, /^\s*Call xingmangHandleOldUninstallResult$/m)
  const position = contents.indexOf('!macro customUnInstallCheck')
  const before = contents.slice(0, position)
  assert.equal((before.match(/^\s*!if(n?def)?\b/gm) ?? []).length, (before.match(/^\s*!endif\b/gm) ?? []).length,
    'customUnInstallCheck must be a top-level macro')

  const handle = bodyOf(contents, 'Function xingmangHandleOldUninstallResult', 'FunctionEnd')
  // 旧卸载程序根本没起来：跟模板一样照常装下去，先于看退出码。
  const launchFailed = handle.indexOf('${If} ${Errors}')
  assert.notEqual(launchFailed, -1)
  assert.ok(launchFailed < handle.indexOf('${If} $R0 == 0'))
  assert.match(handle.slice(launchFailed, handle.indexOf('${EndIf}', launchFailed)), /^\s*Return$/m)

  const box = handle.match(/MessageBox ([^ ]+) "([^"]+)" (.*)\n/)
  assert.ok(box, 'no message box')
  assert.match(box[1], /^MB_RETRYCANCEL\|/)
  assert.doesNotMatch(box[2], /[A-Za-z]{4,}/, 'the dialog speaks English')
  assert.match(box[2], /重试/)
  // 不带 /SD：更新器拉起的静默升级里，这个框是客户唯一能看到的东西。
  assert.equal(box[3], 'IDRETRY xingmangOldUninstallRetry')
  // 取消：跟模板一样以 2 退出。
  const cancel = handle.slice(handle.indexOf(box[0]) + box[0].length, handle.indexOf('xingmangOldUninstallRetry:'))
  assert.match(cancel, /^\s*SetErrorLevel 2\n\s*Quit\n\s*$/)
})

test('retrying force-closes the app by absolute path, leaves its terminal windows alone and runs the old uninstaller again', () => {
  const handle = bodyOf(readCustomInclude(), 'Function xingmangHandleOldUninstallResult', 'FunctionEnd')
  const retry = handle.slice(handle.indexOf('xingmangOldUninstallRetry:'))
  const kill = retry.match(/nsExec::Exec `([^`]+)`/)
  assert.ok(kill, 'the retry does not close the app')
  // 系统目录里的绝对路径，不查 PATH（I14）；参数全是编译期常量（I1）。
  assert.equal(kill[1], '"$SYSDIR\\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"')
  // /T 会连星芒打开的命令行窗口一起关掉，那是客户正在用的。
  assert.doesNotMatch(kill[1], /\/T\b/)
  assert.match(retry, /Push "SHELL_CONTEXT"\n\s*Call uninstallOldVersion\n\s*Goto xingmangOldUninstallCheck\n/)
  // 走回开头再看一遍结果：没起来照常装、成功就往下装、又失败再问。
  assert.ok(handle.indexOf('xingmangOldUninstallCheck:') < handle.indexOf('${If} ${Errors}'))
})

test('the upgrade helpers live in the installer half only', () => {
  const contents = readCustomInclude()
  const header = bodyOf(contents, '!macro customHeader', '!macroend')
  const installerHalf = header.slice(header.indexOf('!ifndef BUILD_UNINSTALLER'), header.indexOf('!ifdef BUILD_UNINSTALLER'))
  // 模板只在安装程序里带 installUtil.nsh（uninstallOldVersion、handleUninstallResult 在那里）；
  // 放进卸载程序那一半就是没人调用的函数，-WX 下打包当场失败。
  assert.ok(installerHalf.includes('Function xingmangForgetMissingInstalledEntries'))
  assert.ok(installerHalf.includes('Function xingmangHandleOldUninstallResult'))
})
