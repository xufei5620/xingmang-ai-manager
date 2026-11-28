const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const asarModule = require('@electron/asar')
const { EXPECTED_FUSES, assertElectronFuseHardening } = require('./electron-fuse-hardening.cjs')
const { OUTPUT_DIRECTORY_NAME: IMAGE_UPSCALE_RUNTIME_DIRECTORY, RUNTIME_FILES: IMAGE_UPSCALE_RUNTIME_FILES } = require('./stage-image-upscale-runtime.cjs')
const { assertPackagedThirdPartyNotices } = require('./third-party-notices.cjs')

const { extractFile, statFile } = asarModule

// #1070 第 2、3 步把整份 system-service.js 拆成了门面、共用上下文、九个业务簇和三个共用的叶子模块。
// 拆之前下面那两条「旧启动链不许回来」读的是整份 system-service.js，所以拆出来的每一份都要查（#1333）。
// 这里点名的缺了就当场失败，改了名不会让门禁悄悄少查一份。
const SYSTEM_SERVICE_FILES = [
  'system-service.js',
  'system-service-context.js',
  'cli-install-service.js',
  'cli-uninstall-service.js',
  'runtime-install-service.js',
  'system-scan-service.js',
  'external-client-route-service.js',
  'tool-route-follow-service.js',
  'official-credential-service.js',
  'config-save-service.js',
  'npm-registry.js',
  'npm-command-failure.js',
  'cli-native-package.js',
]

function packagedSource(asarPath, relativePath, label) {
  try {
    return extractFile(asarPath, relativePath).toString('utf8')
  } catch (error) {
    throw new Error(`无法读取打包后的${label}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 点名的那几份，加上 dist-electron 顶层所有 *-service.js：以后再拆出来的服务文件不用记得回来改这张单子。
 * 打开 CLI 窗口的那一份另外单独读，这里不重复。
 */
function packagedServiceFileNames(asarPath) {
  let directory
  try {
    directory = statFile(asarPath, 'dist-electron')
  } catch (error) {
    throw new Error(`无法读取打包后的主进程目录：${error instanceof Error ? error.message : String(error)}`)
  }
  const discovered = Object.keys(directory.files ?? {}).filter((name) => name.endsWith('-service.js'))
  return [...new Set([...SYSTEM_SERVICE_FILES, ...discovered])]
    .filter((name) => name !== 'provider-launch-service.js')
    .sort()
}

function inspectPackagedLaunchBoundary(asarPath) {
  // #1070 第 3 步把打开 CLI 窗口那一段从 system-service.js 搬进了 provider-launch-service.js，
  // 用哪个 PowerShell 启动函数由 system-service-context.js 接上；门面和其余拆出去的每一份仍一起查，
  // 旧启动链不许在任何一份里回来。
  const serviceSource = packagedSource(
    asarPath,
    'dist-electron/provider-launch-service.js',
    ' CLI 启动服务',
  )
  const otherServiceSources = packagedServiceFileNames(asarPath)
    .map((name) => packagedSource(asarPath, `dist-electron/${name}`, `系统服务（${name}）`))
  const windowsLaunchSource = packagedSource(
    asarPath,
    'dist-electron/windows-elevation.js',
    ' Windows 启动模块',
  )
  const scannedSource = [serviceSource, ...otherServiceSources, windowsLaunchSource].join('\n')

  // CLI windows must use an absolute machine PowerShell path without requesting
  // a second UAC boundary. Windows Terminal and bare powershell.exe launchers are
  // retained as explicit negative gates because both shipped in older builds.
  if (/(?:new-tab|new-window).*?wt|\bwt\.exe\b/i.test(scannedSource)) {
    throw new Error('打包产物仍包含旧的裸 powershell.exe/Windows Terminal CLI 启动链，请重新编译')
  }
  if (/launchElevatedCliPowerShell|-Verb\s+RunAs/i.test(scannedSource)) {
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

const IMAGE_UPSCALE_MANIFEST = path.resolve(__dirname, '..', 'bundled-catalog', 'image-upscale', 'manifest.json')

function readImageUpscaleManifest(manifestPath = IMAGE_UPSCALE_MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (typeof manifest?.onnx?.file !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.onnx.sha256 || '')) {
    throw new Error('bundled-catalog/image-upscale/manifest.json 里缺模型文件名或 sha256')
  }
  return manifest
}

// @electron/asar splits in-archive paths on path.sep, so on Windows a nested
// "a/b/c" is looked up as one directory named "a/b" and never found. Messages
// keep the forward-slash spelling; only the lookup gets the platform's.
function archiveEntry(relativePath) {
  return relativePath.split('/').join(path.sep)
}

function packagedBytes(asarPath, relativePath, label) {
  let bytes
  try {
    bytes = extractFile(asarPath, archiveEntry(relativePath))
  } catch (error) {
    throw new Error(`打包产物缺少${label} ${relativePath}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (bytes.byteLength === 0) throw new Error(`打包产物里的${label} ${relativePath} 是空的`)
  return bytes
}

/**
 * 「变清晰」要的模型和 onnxruntime 运行库都在 app.asar 里。运行库放在 dist-image-upscale 的
 * 嵌套 node_modules 下，electron-builder 哪天改了对嵌套 node_modules 的取舍，或者 files 那两行
 * 被删掉，编译照样过、客户第一次点「变清晰」才失败，所以出包后逐个核对。
 */
function inspectPackagedImageUpscale(asarPath, manifest = readImageUpscaleManifest()) {
  const model = packagedBytes(asarPath, `bundled-catalog/image-upscale/${manifest.onnx.file}`, '本机放大模型')
  if (createHash('sha256').update(model).digest('hex') !== manifest.onnx.sha256) {
    throw new Error('打包产物里的本机放大模型与 bundled-catalog/image-upscale/manifest.json 记的 sha256 不一致')
  }
  let count = 0
  for (const [name, entries] of Object.entries(IMAGE_UPSCALE_RUNTIME_FILES)) {
    const root = `${IMAGE_UPSCALE_RUNTIME_DIRECTORY}/node_modules/${name}`
    for (const entry of entries) {
      if (typeof entry === 'string') {
        packagedBytes(asarPath, `${root}/${entry}`, '本机放大运行库文件')
        count += 1
        continue
      }
      let directory
      try {
        directory = statFile(asarPath, archiveEntry(`${root}/${entry.directory}`))
      } catch {
        directory = null
      }
      const names = Object.keys(directory?.files ?? {}).filter((file) => file.endsWith(entry.extension))
      if (names.length === 0) throw new Error(`打包产物缺少本机放大运行库目录 ${root}/${entry.directory}`)
      for (const file of names) packagedBytes(asarPath, `${root}/${entry.directory}/${file}`, '本机放大运行库文件')
      count += names.length
    }
  }
  return { modelBytes: model.byteLength, runtimeFiles: count }
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

// Windows 自己的更新由这份脚本以管理员身份复制、核对、安装（S01，electron/windows-update-handoff.ts）。
// 它走 win.extraResources，少了或者跟仓库里那份不一样，electron-builder 都不报错，更新却装不上或装错。
const UPDATE_HANDOFF_SCRIPT = path.join('update-handoff', 'verified-install.ps1')
const UPDATE_HANDOFF_SOURCE = path.resolve(__dirname, '..', 'build', UPDATE_HANDOFF_SCRIPT)

function assertWindowsUpdateHandoffScript(resourcesDirectory, sourcePath = UPDATE_HANDOFF_SOURCE) {
  const packaged = path.join(resourcesDirectory, UPDATE_HANDOFF_SCRIPT)
  let stats = null
  try {
    stats = fs.lstatSync(packaged)
  } catch {
    stats = null
  }
  if (!stats || !stats.isFile()) {
    throw new Error(`打包产物缺少更新安装脚本 ${packaged}，请检查 electron-builder.config.cjs 的 win.extraResources`)
  }
  if (!fs.readFileSync(packaged).equals(fs.readFileSync(sourcePath))) {
    throw new Error(`打包产物里的更新安装脚本与仓库里的 ${sourcePath} 不一致`)
  }
}

// One unpacked directory holds exactly one platform's main executable: the
// Windows one keeps the Chinese product name, the Linux one is the ASCII
// linux.executableName (electron-builder.config.cjs). Both carry the same fuse
// wire, so the same checks apply once the right file is found.
const PACKAGED_EXECUTABLE_NAMES = ['星芒AI管理工具.exe', 'xingmang-ai-manager']

function resolvePackagedExecutable(unpackedDirectory) {
  const found = PACKAGED_EXECUTABLE_NAMES
    .map((name) => path.join(unpackedDirectory, name))
    .filter((candidate) => {
      try {
        return fs.lstatSync(candidate).isFile()
      } catch {
        return false
      }
    })
  if (found.length === 0) {
    throw new Error(`找不到打包后的主程序：${unpackedDirectory} 里没有 ${PACKAGED_EXECUTABLE_NAMES.join(' 或 ')}`)
  }
  if (found.length > 1) {
    throw new Error(`${unpackedDirectory} 里同时有多个平台的主程序，无法确认要校验哪一个`)
  }
  return found[0]
}

async function main() {
  const unpackedDirectory = path.resolve(process.argv[2] || 'release/win-unpacked')
  const executable = resolvePackagedExecutable(unpackedDirectory)
  const resourcesDirectory = path.join(unpackedDirectory, 'resources')
  const asar = path.join(resourcesDirectory, 'app.asar')

  if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) {
    throw new Error(`找不到应用归档：${asar}`)
  }

  assertNoDefaultAppFallback(resourcesDirectory)
  if (path.extname(executable).toLowerCase() === '.exe') assertWindowsUpdateHandoffScript(resourcesDirectory)
  inspectPackagedLaunchBoundary(asar)
  const releaseNotes = inspectPackagedReleaseNotes(asar)
  const imageUpscale = inspectPackagedImageUpscale(asar)
  // Windows、Linux 的 Electron 与 Chromium 许可文件由 electron-builder 留在安装目录根上，
  // 第三方许可清单在 resources 里（D97）。
  const notices = assertPackagedThirdPartyNotices({
    resourcesDirectory,
    electronLicenseDirectory: unpackedDirectory,
    asarPath: asar,
    asarModule,
  })

  const fuseCount = await assertElectronFuseHardening(executable, '打包主程序')

  console.log(`Electron 加固校验通过：${path.basename(executable)}，${fuseCount} 项 fuse、app.asar、无默认应用回落与普通用户 CLI 启动边界均符合要求；随包更新说明 ${releaseNotes.version}（${releaseNotes.count} 条）；第三方许可清单 ${notices.listedCount} 项；本机放大模型与 ${imageUpscale.runtimeFiles} 个运行库文件`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`发布加固校验失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { EXPECTED_FUSES, SYSTEM_SERVICE_FILES, assertNoDefaultAppFallback, assertWindowsUpdateHandoffScript, inspectPackagedImageUpscale, inspectPackagedLaunchBoundary, inspectPackagedReleaseNotes, main, readImageUpscaleManifest, resolvePackagedExecutable }
