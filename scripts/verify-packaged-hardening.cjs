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

async function main() {
  const unpackedDirectory = path.resolve(process.argv[2] || 'release/win-unpacked')
  const executable = path.join(unpackedDirectory, '星芒AI管理工具.exe')
  const asar = path.join(unpackedDirectory, 'resources', 'app.asar')

  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error(`找不到打包后的主程序：${executable}`)
  }
  if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) {
    throw new Error(`找不到应用归档：${asar}`)
  }

  inspectPackagedLaunchBoundary(asar)

  const fuseCount = await assertElectronFuseHardening(executable, '打包主程序')

  console.log(`Electron 加固校验通过：${path.basename(executable)}，${fuseCount} 项 fuse、app.asar 与普通用户 CLI 启动边界均符合要求`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`发布加固校验失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { EXPECTED_FUSES, inspectPackagedLaunchBoundary, main }
