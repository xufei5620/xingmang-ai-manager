// 把发布用的两个 DMG 从 zlib（UDZO）转成 LZMA（ULMO）压缩：同样的内容，Apple 芯片那份从约
// 136 MB 降到约 95~103 MB，Intel 那份从约 143 MB 降到约 105~115 MB（拆 0.2.24 正式包估的）。
// 只动客户第一次手动下载的 DMG；自动更新走 ZIP，跟这一步无关。
//
// Why a separate step instead of `dmg.format`: electron-builder 26.15.3 only
// accepts UDRW/UDRO/UDCO/UDZO/UDBZ/ULFO there (ULMO arrives in 26.18.0), and
// upgrading it means redoing scripts/patch-builder-fetch-compat.cjs, which is
// pinned byte for byte to the 26.15.3 source. hdiutil itself has converted to
// ULMO since macOS 10.15, and the app requires macOS 13, so every customer can
// open the result.
//
// Today's DMGs carry no code signature of their own (only the app inside is
// signed, and verify-macos-free-artifacts.cjs inspects exactly that after
// mounting), so the conversion has no container signature to lose. It runs
// after the chip-name rename and before verification, so the verifier mounts
// and inspects the converted image, not the one electron-builder wrote.
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { ARCHITECTURES, releaseArtifactNames } = require('./macos-artifact-names.cjs')

const HDIUTIL_PATH = '/usr/bin/hdiutil'
const TARGET_FORMAT = 'ULMO'
// Converting a ~330 MB image to LZMA takes a minute or two on a CI runner; the
// limit only stops a wedged hdiutil from holding the release job forever.
const HDIUTIL_TIMEOUT_MS = 20 * 60 * 1000
const MAX_IMAGE_INFO_BYTES = 4 * 1024 * 1024

function defaultRunHdiutil(args, env) {
  const result = spawnSync(HDIUTIL_PATH, args, {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_IMAGE_INFO_BYTES,
    shell: false,
    timeout: HDIUTIL_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error) throw new Error(`无法启动 hdiutil ${args[0]}：${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`hdiutil ${args[0]} 失败：${result.stderr?.trim() || '未知错误'}`)
  }
  return result.stdout || ''
}

function assertPlainDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    throw new Error('DMG 所在目录必须是有效路径')
  }
  let stats
  try {
    stats = fs.lstatSync(directory)
  } catch {
    throw new Error('DMG 所在目录不存在')
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('DMG 所在目录必须是普通目录，不能是链接或文件')
  return path.resolve(directory)
}

function plainFileSize(filePath, label) {
  let stats
  try {
    stats = fs.lstatSync(filePath)
  } catch {
    throw new Error(`缺少${label}`)
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
    throw new Error(`${label}必须是非空普通文件，不能是链接`)
  }
  return stats.size
}

/** Reads the image format out of `hdiutil imageinfo -plist`; null when it is absent. */
function parseImageFormat(plist) {
  const match = /<key>Format<\/key>\s*<string>([^<]*)<\/string>/.exec(String(plist || ''))
  return match ? match[1].trim() : null
}

/**
 * Converts both release DMGs in `outputDirectory` to ULMO in place. Each image
 * is converted next to itself under a temporary name, checked, and only then
 * renamed over the original, so a failure leaves electron-builder's image
 * untouched (and a leftover temporary .dmg would still fail the verifier's
 * exact inventory check).
 */
async function compressMacosDmgArtifacts(options = {}) {
  const outputDirectory = assertPlainDirectory(options.outputDirectory)
  const runHdiutil = options.runHdiutil || ((args) => defaultRunHdiutil(args, options.env || process.env))
  const log = options.log || ((line) => process.stdout.write(`${line}\n`))
  const results = []
  for (const architecture of ARCHITECTURES) {
    const name = releaseArtifactNames(options.version, architecture).dmg
    const source = path.join(outputDirectory, name)
    const before = plainFileSize(source, `${architecture} 安装包 ${name}`)
    const temporary = path.join(outputDirectory, `.${name.slice(0, -'.dmg'.length)}.${randomBytes(6).toString('hex')}.dmg`)
    try {
      await runHdiutil(['convert', source, '-format', TARGET_FORMAT, '-o', temporary])
      const after = plainFileSize(temporary, `转换后的安装包 ${name}`)
      const format = parseImageFormat(await runHdiutil(['imageinfo', '-plist', temporary]))
      if (format !== TARGET_FORMAT) {
        throw new Error(`安装包 ${name} 转换后的格式是 ${format || '未知'}，不是 ${TARGET_FORMAT}`)
      }
      fs.renameSync(temporary, source)
      results.push({ architecture, name, before, after })
      log(`${name}：${before} → ${after} 字节（${TARGET_FORMAT}）`)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  return results
}

module.exports = {
  TARGET_FORMAT,
  compressMacosDmgArtifacts,
  parseImageFormat,
}
