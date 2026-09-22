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
  assert.match(body, /\$\{IfNot\} \$\{isUpdated\}\s+Call un\.xingmangUninstallCleanup\s+\$\{EndIf\}/)
  // electron-builder runs customUnInstall after CHECK_APP_RUNNING has stopped the
  // app and before customRemoveFiles; the cleanup needs the exe still on disk.
  assert.ok(include.indexOf('!macro customUnInstall') < include.indexOf('!macro customRemoveFiles'))
  assert.doesNotMatch(macroBody('customRemoveFiles'), /xingmangUninstallCleanup/)
})

test('the cleanup starts the installed exe by absolute path, waits for it and never aborts the uninstall', () => {
  const body = functionBody('un.xingmangUninstallCleanup')
  assert.match(body, /ExecWait '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" \$\{XINGMANG_UNINSTALL_CLEANUP_ARGUMENT\}' \$R0/)
  // No shell and no PATH lookup (I1, I14): the only program started is the one
  // this uninstaller installed, with a fixed argument.
  assert.doesNotMatch(body, /cmd\.exe|powershell|ExecShell|nsExec/i)
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
