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
function loadWindowsConfig() {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({ nsis: config.nsis, win: config.win }))
  `], { cwd: root, encoding: 'utf8', env: environment })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function customInitBody() {
  const contents = fs.readFileSync(customIncludePath, 'utf8')
  const start = contents.search(/^!macro customInit$/m)
  assert.notEqual(start, -1, 'build/installer.nsh defines no customInit')
  const end = contents.indexOf('!macroend', start)
  assert.notEqual(end, -1, 'customInit is never closed')
  return { contents, start, body: contents.slice(start, end) }
}

test('the installer refuses Windows 7, 8 and 8.1 before anything is written', () => {
  const { body } = customInitBody()
  // Electron 23 起不支持 Windows 10 以下；模板自己只拦到 Vista。
  assert.match(body, /\$\{IfNot\} \$\{AtLeastWin10\}/)
  const refusal = body.slice(body.indexOf('${AtLeastWin10}'), body.indexOf('${EndIf}'))
  const messageBox = refusal.match(/MessageBox [^\n]*\n/)
  assert.ok(messageBox, 'the old-system refusal shows no message box')
  assert.match(messageBox[0], /星芒AI管理工具需要 Windows 10 或更新的系统/)
  // 静默安装（/S）时不弹框挂住，直接按"确定"走。
  assert.match(messageBox[0], /\/SD IDOK\s*$/)
  assert.match(refusal, /^\s*Quit$/m)
})

test('the installer refuses Windows 10 on ARM64, which cannot emulate the x64 build', () => {
  const { body } = customInitBody()
  assert.match(body, /\$\{If\} \$\{IsNativeARM64\}\n\s*\$\{AndIfNot\} \$\{AtLeastBuild\} 22000/)
  const refusal = body.slice(body.indexOf('${IsNativeARM64}'))
  const messageBox = refusal.match(/MessageBox [^\n]*\n/)
  assert.ok(messageBox, 'the ARM64 refusal shows no message box')
  assert.match(messageBox[0], /Windows 11/)
  assert.match(messageBox[0], /\/SD IDOK\s*$/)
  assert.match(refusal, /^\s*Quit$/m)

  // 这条守卫成立的前提是只出 x64 包。哪天加了 arm64 目标，ARM 版 Windows 10
  // 就该装原生包而不是被拦下，届时要回来改这里。
  const { win } = loadWindowsConfig()
  assert.deepEqual(win.target, [{ target: 'nsis', arch: ['x64'] }])
})

test('the version guard is a top-level macro, not hidden behind an uninstaller branch', () => {
  const { contents, start } = customInitBody()
  // electron-builder 只在安装程序的 .onInit 里 insertmacro customInit；宏定义本身
  // 必须在顶层，包进 !ifdef BUILD_UNINSTALLER 之类的分支里就不会被编进安装程序。
  const before = contents.slice(0, start)
  const opened = (before.match(/^\s*!if(n?def)?\b/gm) ?? []).length
  const closed = (before.match(/^\s*!endif\b/gm) ?? []).length
  assert.equal(opened, closed, 'customInit sits inside an unclosed !if block')
})

test('the installer is still compiled with warnings as errors', () => {
  const { nsis } = loadWindowsConfig()
  // -WX 让宏里拼错的指令、未定义的 LogicLib 条件在打包时直接失败，而不是编出
  // 一个悄悄跳过检查的安装程序。
  assert.notEqual(nsis.warningsAsErrors, false)
  assert.equal(nsis.include, 'installer.nsh')
})
