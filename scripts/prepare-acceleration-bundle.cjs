// 出包工具：在一台干净的机器上，把一个平台的私有加速资源目录从零准备出来。
//
// 拆开看是两件事：**节点**在仓库里（bundled-acceleration/profile.yaml，产品所有者
// 2026-09-19 决定随源码提交），**内核**不在。内核是 MetaCubeX/mihomo 的公开发布
// 产物，十几 MB 一个、三个平台一套，换一次版本就再压一份进 git 历史永远删不掉；
// 而它是公开的，进不进仓库都不影响谁能拿到它。所以内核按需下载，进仓库的只有
// bundled-acceleration/cores.json 这张对账表。
//
// 这条链路的信任来自**两道哈希**，不是来自传输：
//   1. 下载回来的资产整体必须等于 cores.json 里的 assetSha256；
//   2. 解出来的内核必须等于 coreSha256 —— 这个值与发布者本机已核对过的内核一致，
//      也与已发布安装包 manifest 里记的那一个一致。
// 两道都对，才说明 runner 上这份内核和发布机上那份是同一份字节。任何一道不对就
// 直接失败，绝不"先用着"。GPL v3 许可文本同样按版本下载并对账：它必须是这一版
// 内核对应的那一份，不是随手找来的一份同名文本。
//
// 校验通过之后，真正的资源目录仍然由 stage-acceleration-bundle.cjs 生成 —— 本脚本
// 不自己拼 manifest，也不自己抄节点配置，那一套白名单投影和原子写入只有一份实现。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { gunzipSync } = require('node:zlib')
const { execFileSync } = require('node:child_process')

const { stageAccelerationBundle } = require('./stage-acceleration-bundle.cjs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CATALOG_PATH = path.join('bundled-acceleration', 'cores.json')
const MAX_ASSET_BYTES = 64 * 1024 * 1024
const MAX_CORE_BYTES = 100 * 1024 * 1024
const MAX_LICENSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 5
// GitHub 的 release 下载必然跳一次到对象存储，所以这里不能像更新源那样一律拒绝
// 重定向。放行的只有 GitHub 自己的下载域，且每一跳都必须是 https：跳到别处就说明
// 这不再是我们钉住的那个资产，哈希多半也对不上，但没必要等到那一步才拦。
const ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
])
// bsdtar，Windows 10+ 与 macOS 都自带，两边都认 zip。按绝对路径取，不查 PATH：
// 当前目录里放一个 tar.exe 就被执行是 Windows 上最经典的一条提权路径（I14）。
const TAR_PATHS = { win32: 'C:\\Windows\\System32\\tar.exe', darwin: '/usr/bin/tar' }
const TARGET_PLATFORMS = { 'win32-x64': { platform: 'win32' }, 'darwin-arm64': { platform: 'darwin', arch: 'arm64' }, 'darwin-x64': { platform: 'darwin', arch: 'x64' } }

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readCoreCatalog(projectRoot = PROJECT_ROOT) {
  const source = fs.readFileSync(path.join(projectRoot, CATALOG_PATH), 'utf8')
  let catalog
  try {
    catalog = JSON.parse(source)
  } catch {
    throw new Error('加速内核对账表格式无效。')
  }
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('加速内核对账表格式无效。')
  if (!/^v\d+\.\d+\.\d+$/.test(String(catalog.coreVersion || ''))) throw new Error('加速内核对账表缺少有效的内核版本。')
  if (catalog.sourceRef !== catalog.coreVersion) throw new Error('加速内核版本与源码版本必须一致。')
  if (catalog.sourceUrl !== 'https://github.com/MetaCubeX/mihomo') throw new Error('加速内核来源地址无效。')
  if (!catalog.license || catalog.license.path !== 'LICENSE' || !/^[a-f\d]{64}$/.test(String(catalog.license.sha256 || ''))) {
    throw new Error('加速内核对账表缺少有效的许可校验值。')
  }
  if (!catalog.targets || typeof catalog.targets !== 'object') throw new Error('加速内核对账表缺少目标清单。')
  return catalog
}

function resolveCoreTarget(catalog, target) {
  const platform = typeof target === 'string' && Object.hasOwn(TARGET_PLATFORMS, target) ? TARGET_PLATFORMS[target] : undefined
  const entry = platform && Object.hasOwn(catalog.targets, target) ? catalog.targets[target] : undefined
  if (!entry) throw new Error(`加速内核对账表没有目标 ${target}。`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(entry.asset || ''))) throw new Error('加速内核资产名无效。')
  for (const field of ['assetSha256', 'coreSha256']) {
    if (!/^[a-f\d]{64}$/.test(String(entry[field] || ''))) throw new Error(`加速内核对账表的 ${field} 无效。`)
  }
  if (entry.archive !== 'zip' && entry.archive !== 'gzip') throw new Error('加速内核压缩格式不受支持。')
  if (entry.archive === 'zip' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(entry.entry || ''))) {
    throw new Error('加速内核压缩包内文件名无效。')
  }
  const expectedCoreFile = platform.platform === 'darwin' ? 'mihomo' : 'mihomo.exe'
  if (entry.coreFile !== expectedCoreFile) throw new Error('加速内核文件名与目标平台不一致。')
  return {
    ...entry,
    ...platform,
    url: `${catalog.sourceUrl}/releases/download/${catalog.coreVersion}/${entry.asset}`,
    licenseUrl: `https://raw.githubusercontent.com/MetaCubeX/mihomo/${catalog.sourceRef}/${catalog.license.path}`,
    licenseSha256: catalog.license.sha256,
  }
}

function assertAllowedUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('加速内核下载地址无效。')
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`加速内核下载地址不在允许的来源内：${url.hostname}`)
  }
  return url
}

/** 手动跟随重定向，每一跳都重新过一次来源校验（I10）。 */
async function downloadBytes(url, maximumBytes, fetchImplementation) {
  let current = assertAllowedUrl(url)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImplementation(current.href, {
      redirect: 'manual',
      headers: { 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('加速内核下载被重定向但没有目标地址。')
      current = assertAllowedUrl(new URL(location, current).href)
      continue
    }
    if (response.status !== 200) throw new Error(`加速内核下载失败：HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('加速内核下载内容超过允许上限。')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > maximumBytes) throw new Error('加速内核下载内容超过允许上限。')
    return body
  }
  throw new Error('加速内核下载重定向次数过多。')
}

function defaultTarRunner(platform) {
  const executable = TAR_PATHS[platform]
  if (!executable) throw new Error('当前平台不支持解压 zip 格式的加速内核。')
  return (args) => {
    execFileSync(executable, args, { shell: false, stdio: 'pipe', windowsHide: true })
  }
}

function extractCore(asset, target, workingDirectory, runTar) {
  if (target.archive === 'gzip') return gunzipSync(asset, { maxOutputLength: MAX_CORE_BYTES })
  const archivePath = path.join(workingDirectory, 'core-asset.zip')
  fs.writeFileSync(archivePath, asset, { mode: 0o600 })
  runTar(['-xf', archivePath, '-C', workingDirectory, target.entry])
  const extracted = path.join(workingDirectory, target.entry)
  const stats = fs.lstatSync(extracted)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CORE_BYTES) {
    throw new Error('加速内核压缩包内容不是预期的普通文件。')
  }
  return fs.readFileSync(extracted)
}

/** 下载并对账一个目标的内核与许可，落在调用方给的临时目录里。 */
async function fetchAccelerationCore(target, workingDirectory, dependencies = {}) {
  const fetchImplementation = dependencies.fetchImplementation || fetch
  const asset = await downloadBytes(target.url, MAX_ASSET_BYTES, fetchImplementation)
  if (sha256(asset) !== target.assetSha256) {
    throw new Error('下载到的加速内核资产与对账表的 SHA256 不一致，已放弃。')
  }
  const core = extractCore(asset, target, workingDirectory, dependencies.runTar || defaultTarRunner(target.platform))
  if (sha256(core) !== target.coreSha256) {
    throw new Error('解出的加速内核与对账表的 SHA256 不一致，已放弃。')
  }
  const license = await downloadBytes(target.licenseUrl, MAX_LICENSE_BYTES, fetchImplementation)
  if (sha256(license) !== target.licenseSha256) {
    throw new Error('下载到的 Mihomo 许可文本与对账表的 SHA256 不一致，已放弃。')
  }
  const corePath = path.join(workingDirectory, target.coreFile)
  const licensePath = path.join(workingDirectory, 'LICENSE-mihomo.txt')
  fs.writeFileSync(corePath, core, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(licensePath, license, { flag: 'wx', mode: 0o600 })
  return { corePath, licensePath, coreSha256: target.coreSha256 }
}

async function prepareAccelerationBundle(options, dependencies = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT)
  const catalog = readCoreCatalog(projectRoot)
  const target = resolveCoreTarget(catalog, options.target)
  // 临时目录只放下载产物：真正的资源目录由 stage-acceleration-bundle 写，它自己
  // 要求那个目录不存在或为空，两者混在一起会被它当成"已有残留"拒掉。
  const workingDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-accel-core-')))
  try {
    const fetched = await fetchAccelerationCore(target, workingDirectory, dependencies)
    const configPath = path.join(workingDirectory, 'acceleration-config.json')
    // 不写 profilePath：省略它就是"用仓库里那份节点配置"，而 stage 会拿
    // bundled-acceleration/profile.sha256 把它对一遍。
    fs.writeFileSync(configPath, `${JSON.stringify({ version: 1, corePath: fetched.corePath, coreSha256: fetched.coreSha256 }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const staged = await (dependencies.stage || stageAccelerationBundle)({
      configPath,
      outputDirectory: options.outputDirectory,
      coreVersion: catalog.coreVersion,
      sourceRef: catalog.sourceRef,
      licensePath: fetched.licensePath,
      ...(target.platform === 'darwin' ? { platform: 'darwin', arch: target.arch } : {}),
    }, { projectRoot })
    return { ...staged, coreVersion: catalog.coreVersion, target: options.target }
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag !== '--target' && flag !== '--output') || options[flag] !== undefined || !value || value.startsWith('--')) {
      throw new Error('参数无效：需要 --target 和 --output。')
    }
    options[flag] = value
  }
  if (!options['--target'] || !options['--output']) throw new Error('缺少 --target 或 --output。')
  return { target: options['--target'], outputDirectory: options['--output'] }
}

async function main(argv = process.argv.slice(2)) {
  const result = await prepareAccelerationBundle(parseArguments(argv))
  process.stdout.write(
    `私有加速资源已就位（${result.target}，内核 ${result.coreVersion}，`
    + `${result.nodeCount} 条线路，内核与许可两道 SHA256 均已对账）：${result.outputDirectory}\n`,
  )
}

module.exports = {
  ALLOWED_HOSTS,
  MAX_ASSET_BYTES,
  assertAllowedUrl,
  fetchAccelerationCore,
  parseArguments,
  prepareAccelerationBundle,
  readCoreCatalog,
  resolveCoreTarget,
  main,
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`私有加速资源准备失败：${error.message}\n`)
    process.exitCode = 1
  })
}
