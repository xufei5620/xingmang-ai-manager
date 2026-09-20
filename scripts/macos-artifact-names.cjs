// macOS 发布产物文件名的唯一真相源。下载页、产物校验、更新清单校验和发布前的
// 改名都读这里，不要再各写一份字面量。
//
// 为什么有「构建名」和「发行名」两套：electron-builder 的 artifactName 只有
// ${arch} 这一个架构宏（app-builder-lib/out/util/macroExpander.js），没法把
// arm64 映射成用户看得懂的芯片名，而 `npm run build:mac` 之类的本机构建又可能
// 一次同时打两个架构，没法靠环境变量分别命名。所以 electron-builder 照旧打出
// 带 -arm64 / -x64 的构建名，发布链路再用 rename-macos-chip-artifacts.cjs 统一
// 换成带芯片名的发行名。
//
// The chip label is the word Apple itself shows under 「关于本机」, but the
// architecture token deliberately stays at the end of every release name:
//   * electron-updater's MacUpdater picks the update payload by testing
//     `file.url.pathname.includes("arm64")` (MacUpdater.filterFilesForArch):
//     an Apple silicon Mac takes the first file whose URL carries that
//     substring, every other Mac takes one that does not. An arm64 release
//     name without "arm64" in it - or an Intel name that happens to contain
//     it - silently hands every customer the wrong build, and the update then
//     fails at install time, far from the cause.
//   * e2e/macos-launch-smoke.mjs and the artifact verifier match the
//     architecture by the `-<arch>.zip` suffix.
const ARCHITECTURES = ['arm64', 'x64']
const CHIP_LABELS = { arm64: 'Apple-Silicon', x64: 'Intel' }
const PRODUCT_PREFIX = 'XingMang-AI-Manager'
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function assertArtifactVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error('版本号无效，无法拼出 macOS 产物文件名')
  }
  return version
}

function assertArchitecture(architecture) {
  if (!ARCHITECTURES.includes(architecture)) {
    throw new Error(`macOS 产物架构必须是 ${ARCHITECTURES.join(' 或 ')}`)
  }
  return architecture
}

/** electron-builder 直接打出来的名字，改名之前的产物都叫这个。 */
function builderArtifactBaseName(version, architecture) {
  return `${PRODUCT_PREFIX}-${assertArtifactVersion(version)}-${assertArchitecture(architecture)}`
}

/** 发给用户的名字：芯片名在前，架构后缀保留（见文件头的两条约束）。 */
function releaseArtifactBaseName(version, architecture) {
  const safeVersion = assertArtifactVersion(version)
  const safeArchitecture = assertArchitecture(architecture)
  return `${PRODUCT_PREFIX}-${safeVersion}-${CHIP_LABELS[safeArchitecture]}-${safeArchitecture}`
}

function artifactNamesForBase(baseName) {
  return { dmg: `${baseName}.dmg`, zip: `${baseName}.zip`, blockmap: `${baseName}.zip.blockmap` }
}

function builderArtifactNames(version, architecture) {
  return artifactNamesForBase(builderArtifactBaseName(version, architecture))
}

function releaseArtifactNames(version, architecture) {
  return artifactNamesForBase(releaseArtifactBaseName(version, architecture))
}

module.exports = {
  ARCHITECTURES,
  CHIP_LABELS,
  PRODUCT_PREFIX,
  assertArchitecture,
  assertArtifactVersion,
  builderArtifactBaseName,
  builderArtifactNames,
  releaseArtifactBaseName,
  releaseArtifactNames,
}
