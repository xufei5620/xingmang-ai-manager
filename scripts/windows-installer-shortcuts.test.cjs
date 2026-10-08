const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const buildResourcesDirectory = path.join(root, 'build')
const customIncludeName = 'installer.nsh'
const customIncludePath = path.join(buildResourcesDirectory, customIncludeName)

// 同 macos-build-config.test.cjs：子进程读配置，且构建模式变量由用例说了算，
// 否则发布门禁自己带着 XINGMANG_UNSIGNED_RELEASE=1 跑 npm test 时配置会先抛错。
function loadNsisConfig() {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({ nsis: config.nsis, win: config.win }))
  `], { cwd: root, encoding: 'utf8', env: environment })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function readCustomInclude() {
  return fs.readFileSync(customIncludePath, 'utf8')
}

test('the Windows installer creates a desktop shortcut and a start menu entry by default', () => {
  const { nsis, win } = loadNsisConfig()
  assert.deepEqual(win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(nsis.createDesktopShortcut, true)
  assert.equal(nsis.createStartMenuShortcut, true)
  assert.equal(nsis.shortcutName, '星芒AI管理工具')
  // 关了这两项就是"默认不建快捷方式"，正是 2026-09-20 客户反馈的那个问题。
  assert.notEqual(nsis.createDesktopShortcut, false)
  assert.notEqual(nsis.createStartMenuShortcut, false)
})

test('the install-time fallback script is wired into the installer', () => {
  const { nsis } = loadNsisConfig()
  // electron-builder 用 buildResources 目录（build/）解析这个名字。名字或位置
  // 对不上时它不会报错，只是安默默不带兜底脚本，所以两头都要钉。
  assert.equal(nsis.include, customIncludeName)
  assert.ok(fs.existsSync(customIncludePath), `missing build/${customIncludeName}`)
  assert.match(readCustomInclude(), /^!macro customInstall$/m)
})

test('the fallback only creates a shortcut that is missing, never a second one', () => {
  const contents = readCustomInclude()
  const creationLines = contents.split('\n').filter((line) => line.trim().startsWith('CreateShortCut '))
  assert.ok(creationLines.length > 0, 'the fallback script contains no CreateShortCut at all')
  // 所有 CreateShortCut 都只写在这一个宏里，而它开头就是"文件不存在才建"。
  const guardedMacro = contents.slice(
    contents.indexOf('!macro xingmangCreateShortcutIfMissing'),
    contents.indexOf('!macroend', contents.indexOf('!macro xingmangCreateShortcutIfMissing')),
  )
  assert.match(guardedMacro, /\$\{IfNot\} \$\{FileExists\} "\$\{LinkPath\}"/)
  for (const line of creationLines) {
    assert.ok(guardedMacro.includes(line.trim()), `CreateShortCut outside the existence guard: ${line.trim()}`)
  }
})

test('the fallback never deletes a shortcut the user already has', () => {
  const contents = readCustomInclude()
  // 升级安装时把用户自己挪过位置或改过名字的图标删掉，比不建还糟。
  // 断言只看 customInstall 这一段：同一个文件里的卸载部分本来就要删文件
  // （见 windows-installer-install-directory.test.cjs），那是另一回事。
  const body = contents.slice(
    contents.indexOf('!macro customInstall'),
    contents.indexOf('!macroend', contents.indexOf('!macro customInstall')),
  )
  for (const forbidden of [/^\s*Delete\s/m, /^\s*RMDir\s/m, /UninstShortcut/]) {
    assert.doesNotMatch(body, forbidden)
  }
})

test('an updater-driven silent install never resurrects a deleted shortcut', () => {
  const contents = readCustomInclude()
  const body = contents.slice(contents.indexOf('!macro customInstall'))
  assert.match(body, /\$\{IfNot\} \$\{isUpdated\}/)
  // --no-desktop-shortcut 与 createDesktopShortcut:false 这两条上游开关也要照旧生效。
  assert.match(body, /!ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT/)
  assert.match(body, /\$\{IfNot\} \$\{isNoDesktopShortcut\}/)
  assert.match(body, /!ifndef DO_NOT_CREATE_START_MENU_SHORTCUT/)
})

test('every switch to the current-user shell context is restored', () => {
  const contents = readCustomInclude()
  const body = contents.slice(contents.indexOf('!macro customInstall'))
  // SetShellVarContext current 会连 $SMPROGRAMS / $APPDATA 一起改掉，漏一次
  // 还原，后面的宏就会写到错的地方。
  const switches = body.match(/SetShellVarContext current/g) || []
  const restores = body.match(/!insertmacro xingmangRestoreShellVarContext/g) || []
  assert.equal(restores.length, switches.length)
  assert.ok(switches.length > 0)
})

// customInstall 切到当前用户后补建的那几个路径（含 MENU_FILENAME 分支），以及顺手建的文件夹。
function fallbackCurrentUserWrites(contents) {
  const start = contents.indexOf('!macro customInstall')
  const body = contents.slice(start, contents.indexOf('!macroend', start))
  const links = []
  const directories = []
  for (const branch of body.matchAll(/SetShellVarContext current\n([\s\S]*?)!insertmacro xingmangRestoreShellVarContext/g)) {
    for (const match of branch[1].matchAll(/!insertmacro xingmangCreateShortcutIfMissing "([^"]+)"/g)) links.push(match[1])
    for (const match of branch[1].matchAll(/^\s*CreateDirectory "([^"]+)"$/gm)) directories.push(match[1])
  }
  return { links, directories }
}

// 取一个函数的正文，去掉注释行，断言只看指令。
function functionCode(contents, name) {
  const match = contents.match(new RegExp(`^\\s*Function ${escapeRegExp(name)}$([\\s\\S]*?)^\\s*FunctionEnd$`, 'm'))
  assert.ok(match, `build/installer.nsh must define ${name}`)
  return match[1].split('\n').filter((line) => !/^\s*[#;]/.test(line)).join('\n')
}

// 卸载时删补建图标的那个函数。
function fallbackRemovalCode(contents) {
  return functionCode(contents, 'un.xingmangRemoveFallbackShortcuts')
}

// 每个补建图标的删除都经这个宏：先 UninstShortcut，再交给核对句柄的那个函数。
function removedShortcuts(code) {
  return [...code.matchAll(/^\s*!insertmacro xingmangRemoveFallbackShortcut "([^"]+)"$/gm)].map((match) => match[1])
}

// 从 marker 起取到与它配对的 !endif，中间嵌套的 !ifdef / !ifndef 跳过去。
function preprocessorBlock(code, marker) {
  const start = code.indexOf(marker)
  assert.notEqual(start, -1, `missing ${marker}`)
  const rest = code.slice(start + marker.length)
  let depth = 1
  for (const match of rest.matchAll(/^\s*!(ifdef|ifndef|if|endif)\b/gm)) {
    depth += match[1] === 'endif' ? -1 : 1
    if (depth === 0) return rest.slice(0, match.index)
  }
  assert.fail(`${marker} is never closed`)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('a real uninstall removes exactly the shortcuts the fallback put in the current user profile', () => {
  const contents = readCustomInclude()
  const { links, directories } = fallbackCurrentUserWrites(contents)
  assert.ok(links.length > 0, 'customInstall no longer falls back to the current user')
  const code = fallbackRemovalCode(contents)
  // 模板卸载时只删 setLinkVars 在「所有用户」上下文里算出的那两个，customInstall 补建在
  // 当前用户那里的它不管：卸完留着点不开的图标，之后重装到别的文件夹也补不上。
  // 两边逐条对上，补建的路径改了，这里不跟着改就红；也不许多删别的。
  assert.deepEqual([...removedShortcuts(code)].sort(), [...links].sort())
  // 不直接 Delete：删除只走核对过句柄的那条路（见下面那条用例）。
  assert.doesNotMatch(code, /^\s*Delete\s/m)
  // 补建时顺手建的文件夹只用不带 /r 的 RMDir 收：里面还有别的东西就留着。
  const removedDirectories = [...code.matchAll(/^\s*RMDir "([^"]+)"$/gm)].map((match) => match[1])
  assert.deepEqual([...removedDirectories].sort(), [...directories].sort())
  for (const line of code.split('\n').filter((candidate) => /^\s*(?:RMDir|!insertmacro xingmangRemoveFallbackShortcut)\s/.test(candidate))) {
    assert.doesNotMatch(line, /[*?]|\/r\b/i, line.trim())
  }
})

test('the fallback shortcuts are removed only on a real uninstall, as the template would', () => {
  const contents = readCustomInclude()
  // 升级时新版以 --updated 跑旧版卸载程序，新版自己也不补图标；这时删了，图标就真没了。
  const unInstall = contents.match(/^!macro customUnInstall$([\s\S]*?)^!macroend$/m)
  assert.ok(unInstall, 'build/installer.nsh must define customUnInstall')
  const guarded = unInstall[1].match(/\$\{IfNot\} \$\{isUpdated\}([\s\S]*?)\$\{EndIf\}/)
  assert.ok(guarded)
  assert.match(guarded[1], /^\s*Call un\.xingmangRemoveFallbackShortcuts$/m)
  assert.equal(contents.match(/Call un\.xingmangRemoveFallbackShortcuts\b/g).length, 1)

  const code = fallbackRemovalCode(contents)
  // 按当前用户安装时，模板删的本来就是当前用户那两个；带 --keep-shortcuts 时跟模板一样不删。
  assert.match(code, /^\s*\$\{If\} \$installMode != "all"\s+\$\{OrIf\} \$\{isKeepShortcuts\}\s+Return\s+\$\{EndIf\}/)
  // DO_NOT_CREATE_* 关掉的那一类模板不建也不删，这里同样跳过。每一条删除都在对应的开关里。
  const desktop = preprocessorBlock(code, '!ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT')
  const startMenu = preprocessorBlock(code, '!ifndef DO_NOT_CREATE_START_MENU_SHORTCUT')
  const removals = (text) => removedShortcuts(text)
  assert.ok(removals(desktop).length > 0 && removals(desktop).every((link) => link.startsWith('$DESKTOP\\')))
  assert.ok(removals(startMenu).length > 0 && removals(startMenu).every((link) => link.startsWith('$SMPROGRAMS\\')))
  assert.equal(removals(desktop).length + removals(startMenu).length, removals(code).length)

  // un. 函数只能进卸载程序那一遍：放到外面，安装程序那一遍会报「函数没被调用」，
  // 而 makensis 带着 -WX，警告即错误。
  const header = contents.match(/^!macro customHeader$([\s\S]*?)^!macroend$/m)
  assert.ok(header && header[1].includes('!ifdef BUILD_UNINSTALLER'))
  const uninstallerOnly = header[1].slice(header[1].indexOf('!ifdef BUILD_UNINSTALLER'))
  assert.match(uninstallerOnly, /^\s*Function un\.xingmangRemoveFallbackShortcuts$/m)
})

test('the uninstall-time switch to the current-user shell context is restored on every path', () => {
  const code = fallbackRemovalCode(readCustomInclude())
  // 切到 current 之后 $SMPROGRAMS 和 SHELL_CONTEXT 跟着变；不切回去，后面模板删公共
  // 图标、customRemoveFiles 读安装清单就都找错地方。
  assert.equal((code.match(/SetShellVarContext current/g) || []).length, 1)
  assert.equal((code.match(/!insertmacro xingmangRestoreShellVarContext/g) || []).length, 1)
  // 唯一的 Return 在切换之前；切过去以后一路走到函数末尾的还原。
  const switchAt = code.indexOf('SetShellVarContext current')
  assert.ok(code.lastIndexOf('Return') < switchAt)
  assert.doesNotMatch(code.slice(switchAt), /\bReturn\b|\bAbort\b|\bQuit\b|\bGoto\b/)
  assert.match(code, /!insertmacro xingmangRestoreShellVarContext\s*$/)
})

test('the elevated uninstaller deletes a fallback shortcut only through a handle it has checked', () => {
  const contents = readCustomInclude()
  // 卸载程序是提权跑的，图标却在用户自己能改的地方。用户这边的程序把桌面换成联接，
  // 或者在这个名字上放一个符号链接，Delete 就会替它删掉别处的文件。
  const macro = contents.match(/^!macro xingmangRemoveFallbackShortcut LinkPath$([\s\S]*?)^!macroend$/m)
  assert.ok(macro, 'build/installer.nsh must define xingmangRemoveFallbackShortcut')
  assert.match(macro[1], /^\s*WinShell::UninstShortcut "\$\{LinkPath\}"\s+Push "\$\{LinkPath\}"\s+Call un\.xingmangDeleteFallbackShortcut\s*$/)

  const code = functionCode(contents, 'un.xingmangDeleteFallbackShortcut')
  // No path-based file operation at all: the one deletion goes through the handle.
  assert.doesNotMatch(code, /^\s*(?:Delete|RMDir|Rename|CopyFiles|Exec|ExecWait|ExecShell|nsExec::\w+|WinShell::\w+)\s/m)
  assert.doesNotMatch(code, /\b(?:Return|Goto|Abort|Quit)\b/)

  const open = code.match(/System::Call 'kernel32::CreateFileW\(w R0, i (0x[0-9a-f]+), i \d+, p 0, i (\d+), i (0x[0-9a-f]+), p 0\) p \.R1'/i)
  assert.ok(open, 'the shortcut is opened with CreateFileW into $R1')
  const [access, disposition, flags] = [Number(open[1]), Number(open[2]), Number(open[3])]
  assert.ok(access & 0x10000, 'DELETE access, so the checked handle itself can delete')
  assert.equal(disposition, 3, 'OPEN_EXISTING never creates anything')
  assert.ok(flags & 0x200000, 'FILE_FLAG_OPEN_REPARSE_POINT opens a link in the last segment instead of following it')
  assert.equal(flags & 0x2000000, 0, 'without FILE_FLAG_BACKUP_SEMANTICS a folder cannot be opened at all')
  assert.equal((code.match(/kernel32::CreateFileW/g) || []).length, 1)

  // 打开的必须就是这个路径上的文件：路径里哪一段被联接、符号链接转到别处，系统给的
  // 最终路径就和要删的对不上。
  assert.match(code, /System::Call 'kernel32::GetFinalPathNameByHandleW\(p R1, w \.R2, i \$\{NSIS_MAX_STRLEN\}, i 0\) i \.R3'/)
  assert.match(code, /StrCpy \$R4 "\\\\\?\\UNC\\\$R4"/)
  assert.match(code, /StrCpy \$R4 "\\\\\?\\\$R0"/)
  assert.match(code, /\$\{If\} \$R3 > 0\s+\$\{AndIf\} \$R3 < \$\{NSIS_MAX_STRLEN\}\s+\$\{AndIf\} \$R2 == \$R4/)
  // 文件夹不删；符号链接、联接这类指向别处的重解析点（name surrogate）不删。
  assert.match(code, /kernel32::GetFileInformationByHandleEx\(p R1, i 9, p R2, i 8\) i \.R3'\s+System::Call '\*\$R2\(i \.R4, i \.R5\)'\s+System::Free \$R2/)
  assert.match(code, /IntOp \$R3 \$R4 & 0x10\s+\$\{If\} \$R3 <> 0\s+StrCpy \$R6 "0"/)
  assert.match(code, /IntOp \$R3 \$R4 & 0x400\s+IntOp \$R5 \$R5 & 0x20000000\s+\$\{If\} \$R3 <> 0\s+\$\{AndIf\} \$R5 <> 0\s+StrCpy \$R6 "0"/)

  // The only deletion: FileDispositionInfo on that same handle, after every check.
  assert.equal((code.match(/SetFileInformationByHandle/g) || []).length, 1)
  assert.match(code, /\$\{If\} \$R6 == "1"\s+System::Call 'kernel32::SetFileInformationByHandle\(p R1, i 4, \*i 1, i 4\) i'\s+\$\{EndIf\}/)
  const deleteAt = code.indexOf('SetFileInformationByHandle')
  assert.ok(code.indexOf('StrCpy $R6 "0"') < code.indexOf('kernel32::CreateFileW'))
  assert.equal((code.match(/StrCpy \$R6 "1"/g) || []).length, 1)
  for (const step of ['${AndIf} $R2 == $R4', 'StrCpy $R6 "1"', 'IntOp $R3 $R4 & 0x10', 'IntOp $R5 $R5 & 0x20000000']) {
    const at = code.indexOf(step)
    assert.ok(at !== -1 && at < deleteAt, `${step} must come before the deletion`)
  }
  // 打开了就关上：删除在句柄关掉那一刻才生效，关句柄也是那一支的最后一句。
  assert.equal((code.match(/kernel32::CloseHandle/g) || []).length, 1)
  assert.match(code, /\$\{If\} \$R1 <> -1\s/)
  assert.match(code, /System::Call 'kernel32::CloseHandle\(p R1\)'\s+\$\{EndIf\}\s+Pop \$R6/)

  // $R0–$R6 模板的卸载区段也在用，用完原样还回去；入参经 Exch 取走。
  assert.match(code, /^\s*Exch \$R0\s+Push \$R1\s+Push \$R2\s+Push \$R3\s+Push \$R4\s+Push \$R5\s+Push \$R6\s/)
  assert.match(code, /Pop \$R6\s+Pop \$R5\s+Pop \$R4\s+Pop \$R3\s+Pop \$R2\s+Pop \$R1\s+Pop \$R0\s*$/)

  // 只进卸载程序那一遍；两种图标都不建时没人调用它，makensis -WX 下没人调用的函数就是编译错误。
  const header = contents.match(/^!macro customHeader$([\s\S]*?)^!macroend$/m)
  const uninstallerOnly = header[1].slice(header[1].indexOf('!ifdef BUILD_UNINSTALLER'))
  assert.match(uninstallerOnly, /^\s*!ifdef DO_NOT_CREATE_DESKTOP_SHORTCUT & DO_NOT_CREATE_START_MENU_SHORTCUT\n(?:\s*#[^\n]*\n)*\s*!else\n(?:\s*#[^\n]*\n)*\s*Function un\.xingmangDeleteFallbackShortcut$/m)
})
