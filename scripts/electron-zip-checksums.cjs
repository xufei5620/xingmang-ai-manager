// electron-builder 打包时要拿 Electron 官方压缩包，交给 @electron/get 下载并核对。
// 不给它校验表时，@electron/get 每次都现场去 GitHub 拉 SHASUMS256.txt 来对，而且
// 这个文件按设计从不进缓存（@electron/get 的 index.js：「Never use the cache for
// loading checksums, load them fresh every time」）：压缩包已经在缓存里也照拉不误，
// 拉失败还会当成「缓存里的包对不上」，把整个压缩包重下一遍。GitHub 一回 504，打包就红
// （深查 CI-1：11-09 #1581 的 macos-test、10-26 的 windows-package 和 linux-package）。
//
// 所以改用 node_modules/electron 自带的 checksums.json。它随 electron 的 npm 包装进来，
// 那个包的 SHA-512 钉在 package-lock.json 里、npm ci 逐字节核对；装测试用的 Electron
// 二进制（electron/install.js）默认用的也是它。校验没有关：每个压缩包照样按 SHA-256
// 核对，对不上照样拒收，只是对照表从「和压缩包同一个服务器上现拉的一份」换成了
// 「锁文件钉死的一份」。
const fs = require('node:fs')
const path = require('node:path')

// 正式包和 CI 出的包覆盖的全部平台与架构。少了哪一个，说明 Electron 包换了发法，
// 宁可在加载打包配置时就报错，也不要打到一半才发现那个架构没有对照。
const packagedTargets = Object.freeze([
  ['win32', 'x64'],
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
])

// checksums.json 约 7 KB；上限只是不让一个异常文件被整个读进来。
const maxJsonBytes = 256 * 1024

function readBoundedJson(file, description) {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > maxJsonBytes) throw new Error(`${description}不是正常大小的文件，不能用来核对打包下载的 Electron 压缩包`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function buildElectronZipChecksums(version, checksums) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
    throw new Error('Electron 版本号不可识别，不能确定打包要核对哪些压缩包')
  }
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)) {
    throw new Error('Electron 包里的 checksums.json 格式不对，不能用来核对打包下载的压缩包')
  }
  const entries = Object.entries(checksums)
  // @electron/get 会把这张表逐行写成一份 SHASUMS256.txt 再交给 sumchecker，所以文件名
  // 里不许有换行、空格或路径分隔符，摘要必须是完整的 SHA-256。
  if (entries.length === 0 || entries.some(([name, hash]) => !/^[0-9A-Za-z._-]+$/.test(name) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('Electron 包里的 checksums.json 格式不对，不能用来核对打包下载的压缩包')
  }
  for (const [platform, arch] of packagedTargets) {
    const name = `electron-v${version}-${platform}-${arch}.zip`
    if (!Object.hasOwn(checksums, name)) {
      throw new Error(`Electron 包里的 checksums.json 没有 ${name}，不能用来核对打包下载的压缩包`)
    }
  }
  return Object.freeze(Object.fromEntries(entries))
}

function resolveLockedElectronZipChecksums({ projectRoot = path.join(__dirname, '..') } = {}) {
  const packageDirectory = path.dirname(require.resolve('electron/package.json', { paths: [projectRoot] }))
  const { version } = readBoundedJson(path.join(packageDirectory, 'package.json'), 'Electron 包的 package.json ')
  const checksums = readBoundedJson(path.join(packageDirectory, 'checksums.json'), 'Electron 包的 checksums.json ')
  return buildElectronZipChecksums(version, checksums)
}

module.exports = { buildElectronZipChecksums, packagedTargets, resolveLockedElectronZipChecksums }
