const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')

// Same reason as macos-build-config.test.cjs: the child must see only the build
// mode a case asks for, not whatever the shell running npm test carries.
function cleanBuildEnvironment(overrides) {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  return { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...overrides }
}

function loadLanguages(overrides = {}) {
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({
      all: config.electronLanguages,
      win: config.win.electronLanguages,
      linux: config.linux.electronLanguages,
      mac: config.mac.electronLanguages,
    }))
  `], { cwd: root, encoding: 'utf8', env: cleanBuildEnvironment(overrides) })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// What electron-builder prunes: the .pak files next to the binary on Windows
// and Linux, the .lproj directories in the framework's Resources on macOS.
function shippedLocaleDirectory() {
  if (process.platform === 'darwin') {
    return { directory: path.join(electronDist, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources'), extension: '.lproj' }
  }
  return { directory: path.join(electronDist, 'locales'), extension: '.pak' }
}

test('Windows and Linux keep Simplified and Traditional Chinese plus the en-US fallback', () => {
  for (const overrides of [{}, { XINGMANG_LINUX_PACKAGE: '1', XINGMANG_LOCAL_BUILD: '1' }]) {
    const languages = loadLanguages(overrides)
    assert.deepEqual(languages.all, ['zh-CN', 'zh-TW', 'en-US'])
    // A platform list replaces the top-level one in electron-builder, so one
    // here would quietly undo the choice above for that platform.
    assert.equal(languages.win, undefined)
    assert.equal(languages.linux, undefined)
  }
})

test('macOS keeps the same three under their lproj names, gendered placeholders included', () => {
  assert.deepEqual(loadLanguages().mac, [
    'zh_CN', 'zh_CN_FEMININE', 'zh_CN_MASCULINE', 'zh_CN_NEUTER',
    'zh_TW', 'zh_TW_FEMININE', 'zh_TW_MASCULINE', 'zh_TW_NEUTER',
    'en', 'en_FEMININE', 'en_MASCULINE', 'en_NEUTER',
  ])
})

const shipped = shippedLocaleDirectory()
test('every kept locale is one this Electron ships, and it ships others to drop', { skip: !fs.existsSync(shipped.directory) && 'the Electron binary is not installed' }, () => {
  // A misspelt name is not an error to electron-builder: the file it was meant
  // to keep is deleted along with the rest, and that system's customers lose
  // the Chinese Chromium strings without anything going red.
  const languages = loadLanguages()
  const kept = process.platform === 'darwin' ? languages.mac : languages.all
  const names = fs.readdirSync(shipped.directory)
    .filter((name) => path.extname(name) === shipped.extension)
    .map((name) => path.basename(name, shipped.extension))
  for (const name of kept) assert.ok(names.includes(name), `${name}${shipped.extension} is not in ${shipped.directory}`)
  assert.ok(names.length > kept.length)
})
