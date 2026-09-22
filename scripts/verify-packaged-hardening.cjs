const fs = require('node:fs')
const path = require('node:path')
const { extractFile } = require('@electron/asar')
const { EXPECTED_FUSES, assertElectronFuseHardening } = require('./electron-fuse-hardening.cjs')

function packagedSource(asarPath, relativePath, label) {
  try {
    return extractFile(asarPath, relativePath).toString('utf8')
  } catch (error) {
    throw new Error(`无法读取打包后的${label}：${error instanceof Error ? error.message : String(error)}`)
  }
}

function inspectPackagedLaunchBoundary(asarPath) {
  const serviceSource = packagedSource(
    asarPath,
    'dist-electron/system-service.js',
    ' CLI 启动服务',
  )
  const windowsLaunchSource = packagedSource(
    asarPath,
    'dist-electron/windows-elevation.js',
    ' Windows 启动模块',
  )

  // CLI windows must use an absolute machine PowerShell path without requesting
  // a second UAC boundary. Windows Terminal and bare powershell.exe launchers are
  // retained as explicit negative gates because both shipped in older builds.
  if (/(?:new-tab|new-window).*?wt|\bwt\.exe\b/i.test(`${serviceSource}\n${windowsLaunchSource}`)) {
    throw new Error('打包产物仍包含旧的裸 powershell.exe/Windows Terminal CLI 启动链，请重新编译')
  }
  if (/launchElevatedCliPowerShell|-Verb\s+RunAs/i.test(`${serviceSource}\n${windowsLaunchSource}`)) {
    throw new Error('打包产物仍包含 CLI 管理员提权启动链，请重新编译')
  }
  const requiredServiceMarkers = ['launchCliPowerShell']
  const requiredLaunchMarkers = [
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
    'pwsh.exe',
    '系统 PowerShell 路径必须是绝对路径',
  ]
  if (
    requiredServiceMarkers.some((marker) => !serviceSource.includes(marker))
    || requiredLaunchMarkers.some((marker) => !windowsLaunchSource.includes(marker))
  ) {
    throw new Error('打包产物缺少绝对 PowerShell 路径解析或普通用户 CLI 启动边界')
  }
}

/**
 * 更新装完第一次启动时显示的「这一版改了什么」来自包内这份文件
 * （scripts/bundle-release-notes.cjs）。文件缺了、版本对不上，客户端只会安静地
 * 不显示，没有任何报错，所以要在出包这一步拦住。notes 为 null 是允许的：日常测试包
 * 的 release-notes.md 顶节不是这一版。
 */
function inspectPackagedReleaseNotes(asarPath) {
  const source = packagedSource(asarPath, 'dist-electron/release-notes.json', '随包更新说明')
  const packageSource = packagedSource(asarPath, 'package.json', ' package.json')
  let bundled
  let version
  try {
    bundled = JSON.parse(source)
    version = JSON.parse(packageSource).version
  } catch {
    throw new Error('打包后的随包更新说明或 package.json 不是有效的 JSON')
  }
  if (!bundled || typeof bundled !== 'object' || bundled.version !== version) {
    throw new Error(`打包后的随包更新说明版本与应用版本 ${version} 不一致，请重新编译`)
  }
  const notes = bundled.notes
  if (notes !== null && (!Array.isArray(notes) || notes.length === 0 || notes.some((item) => typeof item !== 'string' || !item))) {
    throw new Error('打包后的随包更新说明格式无效')
  }
  return { version, count: notes === null ? 0 : notes.length }
}

/**
 * Electron falls back to its bundled welcome page whenever it cannot load the
 * application archive, and that page can create windows and spawn a browser
 * stack of its own. The onlyLoadAppFromAsar fuse is supposed to remove that
 * fallback, but leaving the archive in the artifact keeps a second entry point
 * around that nothing in this repository ever wants loaded -- including in a
 * helper process, where a stray window is the first thing a user sees.
 */
function assertNoDefaultAppFallback(resourcesDirectory) {
  const fallback = path.join(resourcesDirectory, 'default_app.asar')
  if (fs.existsSync(fallback)) {
    throw new Error(`打包产物仍保留 Electron 默认应用 ${fallback}，请检查打包配置`)
  }
}

async function main() {
  const unpackedDirectory = path.resolve(process.argv[2] || 'release/win-unpacked')
  const executable = path.join(unpackedDirectory, '星芒AI管理工具.exe')
  const resourcesDirectory = path.join(unpackedDirectory, 'resources')
  const asar = path.join(resourcesDirectory, 'app.asar')

  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error(`找不到打包后的主程序：${executable}`)
  }
  if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) {
    throw new Error(`找不到应用归档：${asar}`)
  }

  assertNoDefaultAppFallback(resourcesDirectory)
  inspectPackagedLaunchBoundary(asar)
  const releaseNotes = inspectPackagedReleaseNotes(asar)

  const fuseCount = await assertElectronFuseHardening(executable, '打包主程序')

  console.log(`Electron 加固校验通过：${path.basename(executable)}，${fuseCount} 项 fuse、app.asar、无默认应用回落与普通用户 CLI 启动边界均符合要求；随包更新说明 ${releaseNotes.version}（${releaseNotes.count} 条）`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`发布加固校验失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { EXPECTED_FUSES, assertNoDefaultAppFallback, inspectPackagedLaunchBoundary, inspectPackagedReleaseNotes, main }
