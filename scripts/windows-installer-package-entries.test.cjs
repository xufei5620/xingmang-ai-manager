const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')
const {
  PACKAGE_ENTRIES_DEFINE,
  PACKAGE_ENTRIES_INCLUDE_NAME,
  buildPackageEntriesInclude,
  writePackageEntriesInclude,
} = require('./windows-installer-package-entries.cjs')

// 安装程序只把安装包自己带的顶层条目记进清单（11-18 复核 D05）：客户自己放进安装目录的文件
// 以前被记成软件文件，下一次升级就被删掉。真装、真升级、真卸载的那一半在
// scripts/windows-upgrade-user-files-smoke.ps1（windows-uninstall-smoke.yml）。

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const executableName = '星芒AI管理工具.exe'

function makeTemporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-package-entries-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

// 照 win-unpacked 摆一份：主程序、resources、locales 和几个 Electron 自带的文件。
function makeUnpackedDirectory(t, extra = []) {
  const directory = makeTemporaryDirectory(t)
  for (const name of [executableName, 'ffmpeg.dll', 'LICENSE.electron.txt', ...extra]) {
    fs.writeFileSync(path.join(directory, name), 'x')
  }
  for (const name of ['resources', 'locales']) fs.mkdirSync(path.join(directory, name))
  return directory
}

function definedEntries(contents) {
  const match = contents.match(new RegExp(`^!define ${PACKAGE_ENTRIES_DEFINE} "\\|(.*)\\|"$`, 'm'))
  assert.ok(match, `no ${PACKAGE_ENTRIES_DEFINE} define in:\n${contents}`)
  return match[1].split('|')
}

test('the include names every top-level entry of the package once, in a fixed order, fenced by bars', () => {
  const contents = buildPackageEntriesInclude(['resources', executableName, 'ffmpeg.dll', 'resources', 'LICENSE.electron.txt'], executableName)
  // 两头都有竖线：installer.nsh 找的是「|名字|」，ffmpeg.dll.bak、resources-old 这类只多几个字的名字对不上。
  assert.deepEqual(definedEntries(contents), ['LICENSE.electron.txt', 'ffmpeg.dll', 'resources', executableName])
  assert.equal(contents.match(/^!define /gm).length, 1)
  assert.equal(buildPackageEntriesInclude([executableName, 'resources', 'ffmpeg.dll'], executableName),
    buildPackageEntriesInclude(['ffmpeg.dll', 'resources', executableName], executableName))
})

test('a name that cannot sit in an NSIS string or in the bar-separated list stops the build', () => {
  for (const name of ['a|b', 'say"hi', '$INSTDIR', 'line\nbreak', 'tab\there', '', '.', '..']) {
    assert.throws(() => buildPackageEntriesInclude([executableName, 'resources', name], executableName), /没法写进安装程序/, JSON.stringify(name))
  }
})

test('a listing without the app or its resources folder is not the package and stops the build', () => {
  // 名单空了或者列错了目录，清单就只剩卸载程序，下一次升级旧文件一个都挪不走。
  assert.throws(() => buildPackageEntriesInclude(['resources', 'ffmpeg.dll'], executableName), new RegExp(executableName))
  assert.throws(() => buildPackageEntriesInclude([executableName, 'ffmpeg.dll'], executableName), /resources/)
  assert.throws(() => buildPackageEntriesInclude([], executableName))
})

test('writing lists the unpacked folder into the build resources folder and joins every architecture', (t) => {
  const buildResourcesDir = makeTemporaryDirectory(t)
  const collected = new Set()
  const first = makeUnpackedDirectory(t, ['vk_swiftshader.dll'])
  writePackageEntriesInclude({ appOutDir: first, buildResourcesDir, executableName, collected })
  const second = makeUnpackedDirectory(t, ['only-on-arm64.dll'])
  const written = writePackageEntriesInclude({ appOutDir: second, buildResourcesDir, executableName, collected })
  const contents = fs.readFileSync(path.join(buildResourcesDir, PACKAGE_ENTRIES_INCLUDE_NAME), 'utf8')
  assert.deepEqual(definedEntries(contents), [...written].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
  for (const name of [executableName, 'resources', 'locales', 'vk_swiftshader.dll', 'only-on-arm64.dll']) {
    assert.ok(definedEntries(contents).includes(name), name)
  }
})

// 子进程读配置，构建模式变量由用例说了算（同 windows-installer-shortcuts.test.cjs），再照 electron-builder
// 的样子调一次 afterPack。
function runAfterPack(context) {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    config.afterPack(${JSON.stringify(context)}).then(
      () => process.stdout.write('done'),
      (error) => { process.stderr.write(String(error && error.message)); process.exit(1) },
    )
  `], { cwd: root, encoding: 'utf8', env: environment })
  return result
}

test('electron-builder writes the list right after packing for Windows', (t) => {
  const buildResourcesDir = makeTemporaryDirectory(t)
  const appOutDir = makeUnpackedDirectory(t)
  const result = runAfterPack({
    electronPlatformName: 'win32',
    appOutDir,
    packager: { info: { buildResourcesDir }, appInfo: { productFilename: executableName.slice(0, -'.exe'.length) } },
  })
  assert.equal(result.status, 0, result.stderr)
  const contents = fs.readFileSync(path.join(buildResourcesDir, PACKAGE_ENTRIES_INCLUDE_NAME), 'utf8')
  assert.deepEqual(definedEntries(contents), ['LICENSE.electron.txt', 'ffmpeg.dll', 'locales', 'resources', executableName])
})

test('a Windows package without its app fails the build instead of shipping an installer that records nothing', (t) => {
  const buildResourcesDir = makeTemporaryDirectory(t)
  const appOutDir = makeUnpackedDirectory(t)
  const result = runAfterPack({
    electronPlatformName: 'win32',
    appOutDir,
    packager: { info: { buildResourcesDir }, appInfo: { productFilename: 'someone-else' } },
  })
  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(path.join(buildResourcesDir, PACKAGE_ENTRIES_INCLUDE_NAME)), false)
})

test('the generated list stays out of git and is included by the installer half only', () => {
  const ignored = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')
  assert.ok(ignored.includes(`build/${PACKAGE_ENTRIES_INCLUDE_NAME}`), 'the generated list must be ignored')

  const contents = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8')
  const include = contents.indexOf(`!include "${PACKAGE_ENTRIES_INCLUDE_NAME}"`)
  assert.notEqual(include, -1, 'installer.nsh does not include the list')
  // 顶层、只进安装程序：卸载程序用不到它，打包时卸载程序那一遍编译也不该依赖它。
  assert.ok(include < contents.indexOf('!macro '), 'the list must be included at the top level')
  const guard = contents.lastIndexOf('!ifndef BUILD_UNINSTALLER', include)
  assert.notEqual(guard, -1)
  assert.equal(contents.indexOf('!endif', guard) > include, true)
  assert.equal(contents.slice(guard, include).includes('!endif'), false, 'the include must stay inside the installer-only guard')
  // 文件在、名字对，但名单是空的：同样编译失败。
  const after = contents.slice(include, contents.indexOf('!macro '))
  assert.match(after, new RegExp(`!ifndef ${PACKAGE_ENTRIES_DEFINE}\\n\\s*!error `))
  assert.match(after, new RegExp(`!if "\\$\\{${PACKAGE_ENTRIES_DEFINE}\\}" == ""\\n\\s*!error `))
})
