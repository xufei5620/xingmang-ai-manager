const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

// 双击画布项目文件（.xingcanvas）在星芒里打开（D92）。Windows 这半是 electron-builder 的
// win.fileAssociations 加 build/installer.nsh 里重写的「打开」命令；真装真卸的核对在
// scripts/windows-file-association-smoke.ps1（windows-uninstall-smoke.yml）。

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const customIncludePath = path.join(root, 'build', 'installer.nsh')
const installSectionPath = require.resolve('app-builder-lib/templates/nsis/installSection.nsh')
const nsisTargetPath = require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js')

// 同 macos-build-config.test.cjs：子进程读配置，且构建模式变量由用例说了算。
function loadConfig() {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({ fileAssociations: config.fileAssociations ?? null, win: config.win }))
  `], { cwd: root, encoding: 'utf8', env: environment })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function readCustomInclude() {
  return fs.readFileSync(customIncludePath, 'utf8')
}

function definedProgId() {
  const match = /^!define XINGMANG_CANVAS_PROGID "([^"]+)"$/m.exec(readCustomInclude())
  assert.ok(match, 'build/installer.nsh defines XINGMANG_CANVAS_PROGID')
  return match[1]
}

function macroBody(source, name) {
  const match = new RegExp(`^!macro ${name}\\n([\\s\\S]*?)^!macroend$`, 'm').exec(source)
  assert.ok(match, `build/installer.nsh defines ${name}`)
  return match[1]
}

test('the Windows installer associates canvas project files with the app under an ASCII ProgID', () => {
  const { fileAssociations, win } = loadConfig()
  // Per platform, so the ProgID never becomes the Finder kind on a Mac.
  assert.equal(fileAssociations, null)
  assert.deepEqual(win.fileAssociations, [{ ext: 'xingcanvas', name: 'XingMangAI.CanvasProject', description: '星芒画布项目' }])
  // A ProgID is a registry key name: no spaces, a dotted program.component name, at most 39 characters.
  assert.match(win.fileAssociations[0].name, /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/)
  assert.ok(win.fileAssociations[0].name.length <= 39)
})

test('installer.nsh rewrites the open command of the same ProgID electron-builder registers', () => {
  const { win } = loadConfig()
  assert.equal(definedProgId(), win.fileAssociations[0].name)
})

test('the open command quotes the program path on every install, upgrades included', () => {
  const body = macroBody(readCustomInclude(), 'customInstall')
  const write = 'WriteRegStr SHELL_CONTEXT "Software\\Classes\\${XINGMANG_CANVAS_PROGID}\\shell\\open\\command" "" \'"$appExe" "%1"\''
  const removeEnglishVerb = 'DeleteRegValue SHELL_CONTEXT "Software\\Classes\\${XINGMANG_CANVAS_PROGID}\\shell\\open" ""'
  assert.ok(body.includes(write), 'customInstall writes the quoted open command')
  assert.ok(body.includes(removeEnglishVerb), 'customInstall drops the template\'s English verb text')
  // The updater's --updated install runs the old uninstaller, which removes the
  // association, and the template writes the unquoted command back; skipping
  // the rewrite on that path would leave every upgraded machine unquoted.
  const updatedBranch = /\$\{IfNot\} \$\{isUpdated\}[\s\S]*?\n {2}\$\{EndIf\}\n/.exec(body)
  assert.ok(updatedBranch, 'customInstall still has its first-install-only branch')
  assert.ok(!updatedBranch[0].includes(write), 'the rewrite is not limited to first installs')
})

test('the template registers the association before customInstall and still writes the path unquoted', () => {
  // The rewrite only sticks because the template's registerFileAssociations runs
  // first. If an electron-builder update moves it after customInstall, the
  // unquoted command comes back; if it starts quoting the path itself, the
  // rewrite above can go.
  const installSection = fs.readFileSync(installSectionPath, 'utf8')
  const register = installSection.indexOf('!insertmacro registerFileAssociations')
  const custom = installSection.indexOf('!insertmacro customInstall')
  assert.ok(register >= 0 && custom >= 0, 'both macros are inserted in the install section')
  assert.ok(register < custom, 'registerFileAssociations runs before customInstall')
  assert.ok(
    fs.readFileSync(nsisTargetPath, 'utf8').includes('const command = \'"$appExe $\\\\"%1$\\\\""\';'),
    'electron-builder still writes the program path unquoted',
  )
})
