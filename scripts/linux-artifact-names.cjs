// Linux 发布产物文件名的唯一真相源。deb 校验、更新清单校验、发布与回滚都读这里，
// 不要再各写一份字面量。
//
// electron-builder names the deb `${name}_${version}_${arch}.deb` with Debian's
// architecture spelling (amd64, not x64), and electron-updater looks for one
// manifest per architecture: process.arch x64 reads latest-linux.yml, arm64
// reads latest-linux-arm64.yml (app-builder-lib updateInfoBuilder
// getArchPrefixForUpdateFile, electron-updater Provider.getChannelFilePrefix).
// A manifest that lists the other architecture's deb would hand every customer
// on this one a package dpkg refuses to install.
const PACKAGE_NAME = 'xingmang-ai-manager'
const ARCHITECTURES = Object.freeze(['x64', 'arm64'])
const DEB_ARCHITECTURES = Object.freeze({ x64: 'amd64', arm64: 'arm64' })
const UPDATE_MANIFESTS = Object.freeze({ x64: 'latest-linux.yml', arm64: 'latest-linux-arm64.yml' })
const UNPACKED_DIRECTORIES = Object.freeze({ x64: 'linux-unpacked', arm64: 'linux-arm64-unpacked' })

function assertArchitecture(arch) {
  if (!ARCHITECTURES.includes(arch)) throw new Error(`Linux 架构只接受 ${ARCHITECTURES.join(' 或 ')}，收到：${arch}`)
  return arch
}

// The control file's Version field: Debian orders "~" before everything, so a
// prerelease sorts below its release (electron-builder's getSanitizedVersion).
function debianVersion(version) {
  return String(version).replace(/-/g, '~')
}

// The file name keeps the raw version: FpmTarget expands
// `${name}_${version}_${arch}.${ext}` from appInfo.version, and only the control
// field goes through getSanitizedVersion. latest-linux*.yml carries the same
// name, so guessing "~" here would refuse every correct prerelease build.
function debFileName(version, arch) {
  return `${PACKAGE_NAME}_${version}_${DEB_ARCHITECTURES[assertArchitecture(arch)]}.deb`
}

function updateManifestName(arch) {
  return UPDATE_MANIFESTS[assertArchitecture(arch)]
}

function unpackedDirectoryName(arch) {
  return UNPACKED_DIRECTORIES[assertArchitecture(arch)]
}

/** Which architecture a Linux manifest belongs to, or null for any other name. */
function manifestArchitecture(name) {
  return ARCHITECTURES.find((arch) => UPDATE_MANIFESTS[arch] === name) ?? null
}

module.exports = {
  ARCHITECTURES,
  DEB_ARCHITECTURES,
  PACKAGE_NAME,
  assertArchitecture,
  debFileName,
  debianVersion,
  manifestArchitecture,
  unpackedDirectoryName,
  updateManifestName,
}
