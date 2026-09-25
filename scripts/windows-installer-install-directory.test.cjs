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
