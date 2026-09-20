// 发布链路的收尾改名：把 electron-builder 打出来的 -arm64 / -x64 产物换成带芯片
// 名的发行名（见 macos-artifact-names.cjs 的文件头），并同步改写 latest-mac.yml
// 里的引用。客户拿到的是两个 DMG，名字必须自己说清楚该装哪一个；arm64 / x64 这
// 两个词在「关于本机」里一个都不出现。
//
// Renaming is the last step before verification, and it is all-or-nothing on
// purpose: latest-mac.yml names its update payloads by file name, so a
// directory where only some files were renamed is a release that installs but
// can never update. Everything is therefore planned and validated first, the
// six files move afterwards, and the manifest is rewritten atomically last.
const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const {
  ARCHITECTURES,
  builderArtifactNames,
  releaseArtifactNames,
} = require('./macos-artifact-names.cjs')
const { parseLatestMacMetadata } = require('./verify-macos-free-artifacts.cjs')

const METADATA_FILE = 'latest-mac.yml'
const MAX_METADATA_BYTES = 1024 * 1024

function assertPlainDirectory(directory, label) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    throw new Error(`${label}必须是有效路径`)
  }
  let stats
  try {
    stats = fs.lstatSync(directory)
  } catch {
    throw new Error(`${label}不存在`)
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label}必须是普通目录，不能是链接或文件`)
  }
  return path.resolve(directory)
}

function assertPlainFile(filePath, label) {
  let stats
  try {
    stats = fs.lstatSync(filePath)
  } catch {
    throw new Error(`缺少${label}`)
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
    throw new Error(`${label}必须是非空普通文件，不能是链接`)
  }
  return stats
}

function buildRenamePlan(outputDirectory, version) {
  const moves = []
  const renamedNames = new Map()
  for (const architecture of ARCHITECTURES) {
    const built = builderArtifactNames(version, architecture)
    const released = releaseArtifactNames(version, architecture)
    for (const kind of ['dmg', 'zip', 'blockmap']) {
      const source = path.join(outputDirectory, built[kind])
      const destination = path.join(outputDirectory, released[kind])
      assertPlainFile(source, `${architecture} 产物 ${built[kind]}`)
      if (fs.existsSync(destination)) {
        throw new Error(`产物目录已存在同名发行文件：${released[kind]}`)
      }
      moves.push([source, destination])
      renamedNames.set(built[kind], released[kind])
    }
  }
  return { moves, renamedNames }
}

function readBuilderMetadata(metadataPath, version) {
  const stats = assertPlainFile(metadataPath, METADATA_FILE)
  if (stats.size > MAX_METADATA_BYTES) throw new Error(`${METADATA_FILE} 超过 1 MiB 限制`)
  const text = fs.readFileSync(metadataPath, 'utf8')
  const builderZipNames = ARCHITECTURES.map((architecture) => builderArtifactNames(version, architecture).zip)
  // 改名只能作用在「还没改过名的完整清单」上：版本、两个 ZIP 引用和主更新文件
  // 都要对得上，否则这个目录不是刚打完的那一份。
  parseLatestMacMetadata(text, version, builderZipNames)
  return YAML.parse(text, { maxAliasCount: 0, uniqueKeys: true })
}

/**
 * Rewrites only the file names the manifest carries. Every other key
 * electron-builder wrote (releaseDate, sizes, digests, whatever it adds later)
 * survives untouched, and a name that is not one of the six renamed artifacts
 * is an error rather than something passed through: the digests stay valid
 * exactly because the bytes did not move.
 */
function buildRenamedMetadataDocument(document, renamedNames) {
  const files = Array.isArray(document?.files) ? document.files : []
  if (files.length === 0) throw new Error(`${METADATA_FILE} 没有更新文件条目`)
  const rename = (value, label) => {
    const renamed = renamedNames.get(String(value).trim())
    if (!renamed) throw new Error(`${METADATA_FILE} 的 ${label} 不是本次构建的产物：${value}`)
    return renamed
  }
  return {
    ...document,
    files: files.map((entry, index) => ({ ...entry, url: rename(entry?.url, `files[${index}].url`) })),
    path: rename(document.path, 'path'),
  }
}

function renameMacosChipArtifacts(options = {}) {
  const version = options.version
  const outputDirectory = assertPlainDirectory(options.outputDirectory, '产物目录')
  const metadataPath = path.join(outputDirectory, METADATA_FILE)
  const document = readBuilderMetadata(metadataPath, version)
  const { moves, renamedNames } = buildRenamePlan(outputDirectory, version)
  const renamedMetadata = YAML.stringify(buildRenamedMetadataDocument(document, renamedNames), { lineWidth: 0 })

  for (const [source, destination] of moves) fs.renameSync(source, destination)
  const temporaryPath = path.join(outputDirectory, `.${METADATA_FILE}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temporaryPath, renamedMetadata, { flag: 'wx', mode: 0o644 })
  fs.renameSync(temporaryPath, metadataPath)
  return {
    outputDirectory,
    metadataPath,
    names: [...renamedNames.values()],
  }
}

function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const requestedDirectory = process.argv[2] || process.env.XINGMANG_OUTPUT_DIR || `release-free-${packageJson.version}`
  const result = renameMacosChipArtifacts({
    outputDirectory: requestedDirectory,
    version: packageJson.version,
  })
  process.stdout.write(`已按芯片名重命名 macOS 产物：${result.outputDirectory}\n${result.names.join('\n')}\n`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`macOS 产物改名失败：${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  METADATA_FILE,
  buildRenamePlan,
  buildRenamedMetadataDocument,
  renameMacosChipArtifacts,
}
