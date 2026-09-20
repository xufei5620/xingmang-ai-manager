// Release-operator tool. A macOS build that carries the private acceleration
// nodes cannot be a single electron-builder run: the resource directory is
// prepared per architecture (stage-acceleration-bundle.cjs forces one arch on
// darwin) and beforePack rejects a bundle whose manifest names another arch.
// The artifact verifier, in turn, only accepts a complete release in one
// directory — exactly two DMGs, two ZIPs, two blockmaps and one latest-mac.yml
// that references both ZIPs. This merges the two per-architecture outputs into
// that shape so the existing verification runs unchanged.
const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const { parseLatestMacMetadata } = require('./verify-macos-free-artifacts.cjs')
const { ARCHITECTURES, builderArtifactNames } = require('./macos-artifact-names.cjs')

const METADATA_FILE = 'latest-mac.yml'
const MAX_METADATA_BYTES = 1024 * 1024

// 合并发生在改名之前，所以这里看到的仍然是 electron-builder 的构建名；带芯片名
// 的发行名由 rename-macos-chip-artifacts.cjs 在合并之后统一换上。
function architectureArtifactNames(version, architecture) {
  const names = builderArtifactNames(version, architecture)
  return [names.dmg, names.zip, names.blockmap]
}

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

/**
 * Reads one per-architecture electron-builder output. Every check here answers
 * the same question: did this directory really come from a build of the
 * architecture it claims? A staging directory that carries the other
 * architecture's ZIP would otherwise merge into a release whose latest-mac.yml
 * points at two copies of the same build.
 */
function readArchitectureStage(stage, version, outputDirectory) {
  const architecture = stage?.architecture
  if (!ARCHITECTURES.includes(architecture)) throw new Error('分架构产物目录必须声明 arm64 或 x64')
  const directory = assertPlainDirectory(stage.directory, `${architecture} 分架构产物目录`)
  // The merge ends by deleting this directory, so it may only ever be one of
  // the staging directories the build created directly under the release
  // output directory — never the output directory itself or one of its parents.
  if (path.dirname(directory) !== outputDirectory) {
    throw new Error(`${architecture} 分架构产物目录必须是合并输出目录下的直接子目录`)
  }
  const names = architectureArtifactNames(version, architecture)
  const expected = new Set(names)
  for (const entry of fs.readdirSync(directory)) {
    if (!/(?:\.zip|\.dmg|\.blockmap)$/i.test(entry)) continue
    if (!expected.has(entry)) {
      throw new Error(`${architecture} 分架构产物目录包含非预期 ZIP/DMG/blockmap：${entry}`)
    }
  }
  for (const name of names) assertPlainFile(path.join(directory, name), `${architecture} 分架构产物 ${name}`)
  const metadataPath = path.join(directory, METADATA_FILE)
  const metadataStats = assertPlainFile(metadataPath, `${architecture} 分架构 ${METADATA_FILE}`)
  if (metadataStats.size > MAX_METADATA_BYTES) {
    throw new Error(`${architecture} 分架构 ${METADATA_FILE} 超过 1 MiB 限制`)
  }
  const text = fs.readFileSync(metadataPath, 'utf8')
  // Rejects a manifest that names another version, another architecture's ZIP,
  // or more than the single ZIP a one-architecture build produces.
  parseLatestMacMetadata(text, version, names)
  return { architecture, directory, names, document: YAML.parse(text, { maxAliasCount: 0, uniqueKeys: true }) }
}

/**
 * Keeps the first architecture's document as the base so every key
 * electron-builder wrote (releaseDate and whatever it adds later) survives the
 * merge, and only replaces the file list. The primary path and its digest
 * already belong to that same document, so the result stays self-consistent.
 */
function buildMergedMetadataDocument(stages) {
  return { ...stages[0].document, files: stages.map((stage) => stage.document.files[0]) }
}

function mergeMacosFreeArchitectureOutputs(options = {}) {
  const version = options.version
  const outputDirectory = assertPlainDirectory(options.outputDirectory, '合并输出目录')
  const requested = Array.isArray(options.stages) ? options.stages : []
  if (requested.length !== ARCHITECTURES.length
    || ARCHITECTURES.some((architecture, index) => requested[index]?.architecture !== architecture)) {
    throw new Error('合并 macOS 产物必须按 arm64、x64 顺序提供两个分架构产物目录')
  }
  const stages = requested.map((stage) => readArchitectureStage(stage, version, outputDirectory))
  if (stages[0].directory === stages[1].directory) {
    throw new Error('两个架构不能共用同一个分架构产物目录')
  }

  // Everything is planned before anything moves: a half-merged release
  // directory is indistinguishable from a complete one for the file names the
  // verifier looks at.
  const moves = []
  for (const stage of stages) {
    for (const name of stage.names) {
      const destination = path.join(outputDirectory, name)
      if (fs.existsSync(destination)) throw new Error(`合并输出目录已存在同名产物：${name}`)
      moves.push([path.join(stage.directory, name), destination])
    }
  }
  const metadataPath = path.join(outputDirectory, METADATA_FILE)
  if (fs.existsSync(metadataPath)) throw new Error(`合并输出目录已存在 ${METADATA_FILE}`)
  const merged = YAML.stringify(buildMergedMetadataDocument(stages), { lineWidth: 0 })

  for (const [source, destination] of moves) fs.renameSync(source, destination)
  fs.writeFileSync(metadataPath, merged, { flag: 'wx', mode: 0o644 })
  // What is left behind is the unpacked .app tree and electron-builder's own
  // effective config; neither belongs in a release directory.
  for (const stage of stages) fs.rmSync(stage.directory, { recursive: true, force: true })
  return {
    outputDirectory,
    metadataPath,
    names: stages.flatMap((stage) => stage.names),
  }
}

module.exports = {
  ARCHITECTURES,
  architectureArtifactNames,
  buildMergedMetadataDocument,
  mergeMacosFreeArchitectureOutputs,
}
