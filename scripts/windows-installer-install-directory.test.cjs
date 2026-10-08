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
