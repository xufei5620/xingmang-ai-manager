const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const include = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8')
const entrySource = fs.readFileSync(path.join(root, 'electron', 'uninstall-cleanup-entry.ts'), 'utf8')
const loginLaunchSource = fs.readFileSync(path.join(root, 'electron', 'login-launch.ts'), 'utf8')
const builderConfigSource = fs.readFileSync(path.join(root, 'electron-builder.config.cjs'), 'utf8')

function macroBody(name) {
  const match = include.match(new RegExp(`^!macro ${name}$([\\s\\S]*?)^!macroend$`, 'm'))
  assert.ok(match, `build/installer.nsh must define ${name}`)
  return match[1]
}

function functionBody(name) {
  const match = include.match(new RegExp(`^\\s*Function ${name.replace('.', '\\.')}$([\\s\\S]*?)^\\s*FunctionEnd$`, 'm'))
  assert.ok(match, `build/installer.nsh must define ${name}`)
  return match[1]
}

test('the uninstaller launches the app with the same cleanup switch the entry router recognizes', () => {
  const nsis = include.match(/^!define XINGMANG_UNINSTALL_CLEANUP_ARGUMENT "([^"]+)"$/m)?.[1]
  const electron = entrySource.match(/export const uninstallCleanupArgument = '([^']+)'/)?.[1]
  assert.ok(nsis && electron)
  // 两边任何一边改了名字，卸载程序拉起的就是一次普通启动：打开窗口、抢单实例锁，
  // 代理照旧没人还原，而且什么都不会报错。
  assert.equal(nsis, electron)
})

test('the cleanup runs only on a real uninstall, before any file is removed', () => {
  const body = macroBody('customUnInstall')
  // An upgrade runs the previous uninstaller with --updated. Clearing the login
  // item there would silently switch off the user's autostart on every update.
  // The guard may hold other real-uninstall-only calls after this one (the
  // fallback shortcut removal, pinned in windows-installer-shortcuts.test.cjs).
  assert.match(body, /\$\{IfNot\} \$\{isUpdated\}\s+Call un\.xingmangUninstallCleanup\s+(?:Call un\.\w+\s+)*\$\{EndIf\}/)
  // electron-builder runs customUnInstall after CHECK_APP_RUNNING has stopped the
  // app and before customRemoveFiles; the cleanup needs the exe still on disk.
  assert.ok(include.indexOf('!macro customUnInstall') < include.indexOf('!macro customRemoveFiles'))
  assert.doesNotMatch(macroBody('customRemoveFiles'), /xingmangUninstallCleanup/)
})

test('the cleanup starts the installed exe by absolute path, waits for it and never aborts the uninstall', () => {
  const body = functionBody('un.xingmangUninstallCleanup')
  assert.match(body, /ExecWait '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" \$\{XINGMANG_UNINSTALL_CLEANUP_ARGUMENT\}\$R1' \$R0/)
  // No shell and no PATH lookup (I1, I14): the only program started is the one
  // this uninstaller installed, with fixed arguments. The optional switches in
  // $R1 are built from compile-time constants only, nothing from outside.
  assert.doesNotMatch(body, /cmd\.exe|powershell|ExecShell|nsExec/i)
  const assignments = [...body.matchAll(/StrCpy \$R1 (.*)$/gm)].map((match) => match[1])
  assert.deepEqual(assignments, ['""', '" ${XINGMANG_CLEAR_LOGIN_ARGUMENT}"', '"$R1 ${XINGMANG_CLEAR_KEYS_ARGUMENT}"'])
  assert.match(body, /Push \$R1[\s\S]*Pop \$R1/)
  assert.doesNotMatch(body, /\bAbort\b|\bQuit\b/)
  // $R0 is shared with the template's own uninstall section.
  assert.match(body, /Push \$R0[\s\S]*Pop \$R0/)
  // The function lives only in the uninstaller build; an unreferenced function
  // in the installer build is a makensis warning, and warnings are errors (-WX).
  const uninstallerOnly = include.slice(include.indexOf('!ifdef BUILD_UNINSTALLER'))
  assert.ok(uninstallerOnly.includes('Function un.xingmangUninstallCleanup'))
})

test('the cleanup names the login item with the same AppUserModelId electron-builder registers', () => {
  const appId = builderConfigSource.match(/^\s*appId: '([^']+)',$/m)?.[1]
  const aumid = loginLaunchSource.match(/export const windowsAppUserModelId = '([^']+)'/)?.[1]
  assert.ok(appId && aumid)
  assert.equal(aumid, appId)
})

test('the uninstaller passes the clear-login switch the cleanup recognizes, and only when asked', () => {
  const nsis = include.match(/^!define XINGMANG_CLEAR_LOGIN_ARGUMENT "([^"]+)"$/m)?.[1]
  const electron = entrySource.match(/export const uninstallClearLoginArgument = '([^']+)'/)?.[1]
  assert.ok(nsis && electron)
  assert.equal(nsis, electron)
  const body = functionBody('un.xingmangUninstallCleanup')
  // The switch rides only on the branch the ticked box (or the silent flag) selects.
  assert.match(body, /\$\{If\} \$xingmangClearLogin == "1"\s+DetailPrint "[^"]+"\s+StrCpy \$R1 " \$\{XINGMANG_CLEAR_LOGIN_ARGUMENT\}"\s+\$\{EndIf\}/)
  assert.equal(body.match(/XINGMANG_CLEAR_LOGIN_ARGUMENT/g).length, 1)
})

// 决定单 D91：卸载页「同时删掉这台电脑上存的密钥」，默认不勾，跟清登录记录那个勾各管各的。
test('the uninstaller passes the clear-keys switch the cleanup recognizes, and only when asked', () => {
  const nsis = include.match(/^!define XINGMANG_CLEAR_KEYS_ARGUMENT "([^"]+)"$/m)?.[1]
  const electron = entrySource.match(/export const uninstallClearKeysArgument = '([^']+)'/)?.[1]
  assert.ok(nsis && electron)
  assert.equal(nsis, electron)
  const body = functionBody('un.xingmangUninstallCleanup')
  // Appended after whatever the clear-login box added, so both can ride together.
  assert.match(body, /\$\{If\} \$xingmangClearKeys == "1"\s+StrCpy \$R1 "\$R1 \$\{XINGMANG_CLEAR_KEYS_ARGUMENT\}"\s+\$\{EndIf\}/)
  assert.equal(body.match(/XINGMANG_CLEAR_KEYS_ARGUMENT/g).length, 1)
  // Both switches are settled before the one ExecWait that carries them.
  assert.ok(body.indexOf('$xingmangClearKeys == "1"') < body.indexOf('ExecWait'))
  assert.equal(body.match(/ExecWait/g).length, 1)
})

test('the uninstall welcome page carries an unticked clear-keys box below the clear-login one', () => {
  const show = functionBody('un.xingmangWelcomeShow')
  assert.match(show, /\$\{NSD_CreateCheckbox\} 120u 164u 195u 12u "同时清除登录记录和聊天记录"/)
  assert.match(show, /\$\{NSD_CreateCheckbox\} 120u 178u 195u 12u "同时删掉这台电脑上存的密钥"/)
  assert.ok(show.indexOf('同时清除登录记录和聊天记录') < show.indexOf('同时删掉这台电脑上存的密钥'))
  assert.match(show, /\$\{If\} \$xingmangClearKeys == "1"\s+\$\{NSD_Check\} \$xingmangClearKeysCheckbox\s+\$\{EndIf\}/)
  assert.match(show, /SetCtlColors \$xingmangClearKeysCheckbox "" "\$\{MUI_BGCOLOR\}"/)
  // The welcome text label (MUI2: 45u down, 130u tall) is cut to 116u before the boxes
  // go in, so it ends at 161u and never overlaps them; the page is 193u tall.
  assert.match(show, /StrCpy \$R0 \$mui\.WelcomePage\.Text/)
  assert.match(show, /IntOp \$R3 \$R3 \* 116\s+IntOp \$R3 \$R3 \/ 130/)
  assert.match(show, /user32::SetWindowPos\(p R0, p 0, i 0, i 0, i R2, i R3, i 0x16\)/)
  assert.ok(show.indexOf('SetWindowPos') < show.indexOf('NSD_CreateCheckbox'))
  for (const register of ['R0', 'R1', 'R2', 'R3']) {
    assert.ok(show.indexOf(`Push $${register}`) >= 0 && show.indexOf(`Push $${register}`) < show.indexOf(`Pop $${register}`), register)
  }
  assert.match(functionBody('un.xingmangWelcomeLeave'), /\$\{NSD_GetState\} \$xingmangClearKeysCheckbox \$R0\s+\$\{If\} \$R0 == \$\{BST_CHECKED\}\s+StrCpy \$xingmangClearKeys "1"/)
  // A silent uninstall has no page; the same switch on its own command line stands in.
  assert.match(macroBody('customUnInit'), /ClearErrors\s+\$\{GetOptions\} \$R0 "\$\{XINGMANG_CLEAR_KEYS_ARGUMENT\}" \$R1\s+\$\{IfNot\} \$\{Errors\}\s+StrCpy \$xingmangClearKeys "1"/)
})

test('the uninstall welcome page carries an unticked clear-login box', () => {
  const page = macroBody('customUnWelcomePage')
  // electron-builder inserts this macro in place of its own MUI_UNPAGE_WELCOME.
  assert.match(page, /!define MUI_PAGE_CUSTOMFUNCTION_SHOW un\.xingmangWelcomeShow\s+!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un\.xingmangWelcomeLeave\s+!insertmacro MUI_UNPAGE_WELCOME/)
  const show = functionBody('un.xingmangWelcomeShow')
  assert.match(show, /\$\{NSD_CreateCheckbox\} [^\n]*"同时清除登录记录和聊天记录"/)
  // Default is keep: the box is ticked only when coming back to a page already ticked.
  assert.match(show, /\$\{If\} \$xingmangClearLogin == "1"\s+\$\{NSD_Check\} \$xingmangClearLoginCheckbox\s+\$\{EndIf\}/)
  assert.match(functionBody('un.xingmangWelcomeLeave'), /\$\{NSD_GetState\} \$xingmangClearLoginCheckbox/)
  // A silent uninstall has no page; the same switch on its own command line stands in.
  assert.match(macroBody('customUnInit'), /\$\{GetOptions\} \$R0 "\$\{XINGMANG_CLEAR_LOGIN_ARGUMENT\}" \$R1\s+\$\{IfNot\} \$\{Errors\}\s+StrCpy \$xingmangClearLogin "1"/)
  // The variables exist only in the uninstaller build; an unused one elsewhere is
  // a makensis warning, and warnings are errors (-WX).
  assert.match(include, /!ifdef BUILD_UNINSTALLER\s+(?:#[^\n]*\n\s*)*Var xingmangClearLogin\s+Var xingmangClearLoginCheckbox\s+(?:#[^\n]*\n\s*)*Var xingmangClearKeys\s+Var xingmangClearKeysCheckbox\s+!endif/)
})

test('the uninstall details the user reads are Chinese and the other-account code matches the cleanup', () => {
  // DetailPrint / Abort text shows in the install and uninstall windows. Any
  // message without a CJK character is an English line a customer would read.
  const messages = [...include.matchAll(/^\s*(?:DetailPrint|Abort)\s+(["`])(.*)\1\s*$/gm)].map((match) => match[2])
  assert.ok(messages.length > 0)
  for (const message of messages) assert.match(message, /[一-鿿]/, message)

  const otherAccount = fs.readFileSync(path.join(root, 'electron', 'uninstall-cleanup.ts'), 'utf8')
    .match(/^\s*otherAccount: (\d+),$/m)?.[1]
  assert.ok(otherAccount)
  assert.match(functionBody('un.xingmangUninstallCleanup'), new RegExp(`\\$\\{ElseIf\\} \\$R0 == ${otherAccount}\\n`))
})
