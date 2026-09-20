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
  for (const forbidden of [/^\s*Delete\s/m, /^\s*RMDir\s/m, /UninstShortcut/]) {
    assert.doesNotMatch(contents, forbidden)
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
