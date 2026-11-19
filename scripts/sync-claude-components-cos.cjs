const fs = require('node:fs/promises')
const https = require('node:https')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { checkFailure, observedProcessFailure, safeSyncFailure } = require('./cos-sync-utils.cjs')

// Claude Desktop 自己要从官网下两样东西，国内下不动（加速 10-30 已下线）：Cowork 工作区（每个平台约 1.3 GB）
// 和 Mac 上的 Claude Code 程序包（2.1.326 约 120 MB）。yoyo 11-03「如果能用这个方式就不要加速了」：这里把它们原样搬进
// 星芒的腾讯云存储桶，客户端（0.2.25 起）从桶里下好放进 Claude 自己的文件夹。11-19 他要先把桶搬起来，所以同步
// 先单独合进来，客户端那部分随 0.2.25 跟上。
//
// 搬什么：每一部分下一份最新的 Claude 安装包，从它的 app.asar 里读出那一版要的工作区和 Claude Code 版本、Mac 程序包
// 的校验值。Windows 和 Mac 不同步换版（11-19 Windows 商店版是 5.11492.5、工作区 072b…，Mac 是 6.6395.1、工作区
// 3781…），所以 Windows 工作区那两部分读 Windows 商店版 x64（星芒在 Windows 上装的就是它），Mac 工作区和 Mac 程序
// 那三部分读 Mac 的通用版 zip，各搬自己那边真在用的那一版。清单解析和桶里的位置都用客户端同一套编译好的代码
// （dist-electron/ 里的 claude-desktop-component-manifest.js、claude-desktop-component-keys.js），所以作业先编译
// 主进程，客户端算出来的位置和这里传的永远是同一个。
//
// Trust: the expected size and SHA-256 of every file come from Claude's own app.asar, and the
// bytes come only from downloads.claude.ai's two component paths, with redirects refused. A
// file is uploaded only when it matches the manifest exactly, under a key that names its
// checksum, and nothing is ever overwritten. The installers themselves are not signature-checked
// here: they only say which official files to copy, and every customer machine checks each
// file against the app.asar of the Claude it actually has installed before placing it, so a
// wrong object in the bucket is a wasted download, never a placed file. Nothing downloaded
// is executed. The one redirect followed outside cos-sync-utils is the fixed Mac "latest zip"
// entry on api.anthropic.com: only its headers are read, and its Location must name a
// universal zip under downloads.claude.ai/releases/ exactly.

const official = require('./sync-claude-official-cos.cjs')

const SOURCE_HOST = 'downloads.claude.ai'
// Inside the manager prefix docs/cos-sync-policy.json already authorizes. The client part adds
// this folder to validateDesktopBucketUrl when it lands.
const PREFIX = 'xingmang/offline/claude-components'
const CONTENT_TYPE = 'application/zstd'
const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const USER_AGENT = 'xingmang-claude-components-cos-sync/1'
const MSIX_REQUEST_URL = official.SOURCES['windows-x64'].requestUrl
const MSIX_ASAR_ENTRY = 'app/resources/app.asar'
// claude.ai 那个 Mac 入口在 GitHub 的机器上被人机验证挡着（11-19 探测 44558371619 拿到空跳转），api.anthropic.com
// 上同一个入口直接 307 到 downloads.claude.ai 的通用版 zip（约 400 MB），zip 里就有 app.asar。
const MAC_ZIP_REQUEST_URL = 'https://api.anthropic.com/api/desktop/darwin/universal/zip/latest/redirect'
const MAC_ZIP_LOCATION = /^https:\/\/downloads\.claude\.ai\/releases\/darwin\/universal\/\d{1,4}\.\d{1,6}\.\d{1,6}\/Claude-[0-9a-f]{40}\.zip$/
const MAC_ASAR_ENTRY = 'Claude.app/Contents/Resources/app.asar'
const INSTALLERS = Object.freeze({
  windows: Object.freeze({ fileName: 'Claude-x64.msix', asarEntry: MSIX_ASAR_ENTRY }),
  macos: Object.freeze({ fileName: 'Claude-universal.zip', asarEntry: MAC_ASAR_ENTRY }),
})
const INSTALLER_IDS = Object.freeze(Object.keys(INSTALLERS))
const MAX_ASAR_BYTES = 1024 * 1024 * 1024
// cos-sync-utils 单个文件的上限；4.4212.0 到 6.6395.1 最大的 rootfs 压缩后都在 1.36 GB 上下。
const MAX_COMPONENT_BYTES = 2 * 1024 * 1024 * 1024
// GitHub 的机器往上海的桶分块传约 190~300 KB/s（#1082 和 11-01 Codex 桌面端那次），1.36 GB 要一个半小时上下，
// 网断一阵还要等着重试；单个文件给四个小时，作业 330 分钟兜底。
const MULTIPART_DEADLINE_MS = 240 * 60 * 1000
const WORK_PREFIX = 'xingmang-claude-components-cos-'
// 每部分读哪个安装包：Windows 和 Mac 的 Claude 不同步出版（11-19 Windows MSIX 是 5.11492.5、Mac 是 6.6395.1，
// 两边清单里的工作区版本也不一样），客户 Windows 上装的是 MSIX、Mac 上装的是通用版 zip，各部分只搬自己那边真在用的那一版。
const PARTS = Object.freeze({
  'vm-win32-x64': Object.freeze({ kind: 'vm', platformKey: 'win32', architecture: 'x64', installers: Object.freeze(['windows']) }),
  'vm-win32-arm64': Object.freeze({ kind: 'vm', platformKey: 'win32', architecture: 'arm64', installers: Object.freeze(['windows']) }),
  'vm-unix-x64': Object.freeze({ kind: 'vm', platformKey: 'unix', architecture: 'x64', installers: Object.freeze(['macos']) }),
  'vm-unix-arm64': Object.freeze({ kind: 'vm', platformKey: 'unix', architecture: 'arm64', installers: Object.freeze(['macos']) }),
  'code-mac': Object.freeze({ kind: 'code', architectures: Object.freeze(['arm64', 'x64']), installers: Object.freeze(['macos']) }),
})
const PART_IDS = Object.freeze(Object.keys(PARTS))
const SHA_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/
const VM_SOURCE_PATH = /^\/vms\/linux\/(?:x64|arm64)\/[0-9a-f]{40}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.zst$/
const CODE_SOURCE_PATH = /^\/claude-code-releases\/\d{1,4}\.\d{1,4}\.\d{1,6}\/darwin-(?:arm64|x64)\/claude\.app\.tar\.zst$/
const stageFailures = new WeakMap()

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isComponentSize(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_COMPONENT_BYTES
}

function parsePart(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PARTS, value)) throw checkFailure('platform-invalid', `要同步的部分无效；支持 ${PART_IDS.join('、')}`)
  return value
}

function parsePartArgument(argv, env = process.env) {
  if (argv.length > 1 || argv.some(function (arg) { return !arg.startsWith('--part=') })) throw checkFailure('platform-invalid', '用法：sync-claude-components-cos.cjs --part=<部分>，或设 CLAUDE_COMPONENTS_PART')
  return parsePart(argv[0] ? argv[0].slice('--part='.length) : env.CLAUDE_COMPONENTS_PART)
}

/** 官网那份的地址：工作区按虚拟机架构放（Claude 自己拼的也是这个），Mac 程序包按 Claude Code 版本和平台放。 */
function componentSourceUrl(item) {
  if (item.kind === 'vm') return `https://${SOURCE_HOST}/vms/linux/${item.architecture}/${item.sha}/${item.name}.zst`
  return `https://${SOURCE_HOST}/claude-code-releases/${item.version}/${item.platform}/claude.app.tar.zst`
}

function validateComponentSourceUrl(value) {
  let url
  try { url = new URL(value) } catch { throw checkFailure('source-url-rejected', 'Claude 组件下载地址格式无效') }
  if (url.protocol !== 'https:' || url.hostname !== SOURCE_HOST || url.port || url.username || url.password || url.search || url.hash
    || url.pathname.includes('..') || !(VM_SOURCE_PATH.test(url.pathname) || CODE_SOURCE_PATH.test(url.pathname))) {
    throw checkFailure('source-url-rejected', 'Claude 组件下载地址不在官网固定的两个组件目录里')
  }
  return url
}

function assertObjectKey(key) {
  if (typeof key !== 'string' || !key.startsWith(`${PREFIX}/`) || key.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)
    || key.split('/').some(function (segment) { return !segment || segment === '.' || segment === '..' })) {
    throw checkFailure('cos-object-mismatch', '算出来的桶内位置不在 Claude 组件目录里')
  }
  return key
}

/** 编译好的客户端模块里取这几样；名字改了或目录换了就停，免得同步按另一套位置传。 */
function componentsFromModules(manifest, keys) {
  const components = {
    readManifest: manifest?.readClaudeDesktopComponentManifest,
    workspaceObjectKey: keys?.claudeDesktopWorkspaceObjectKey,
    resolveMacPin: keys?.resolveClaudeCodeMacPin,
    macObjectKey: keys?.claudeCodeMacObjectKey,
    prefix: keys?.claudeDesktopComponentsBucketPrefix,
  }
  if (['readManifest', 'workspaceObjectKey', 'resolveMacPin', 'macObjectKey'].some(function (name) { return typeof components[name] !== 'function' }) || components.prefix !== PREFIX) {
    throw checkFailure('inspector-unavailable', '编译好的主进程里找不到 Claude 组件清单的读法，或桶内目录变了')
  }
  return Object.freeze(components)
}

function loadComponents(root = path.join(__dirname, '..')) {
  let modules
  try {
    modules = ['claude-desktop-component-manifest.js', 'claude-desktop-component-keys.js']
      .map(function (name) { return require(path.join(root, 'dist-electron', name)) })
  } catch {
    throw checkFailure('inspector-unavailable', '没有编译好的主进程代码，先跑 tsc -p tsconfig.electron.json')
  }
  return componentsFromModules(...modules)
}

function vmItems(spec, manifest, components) {
  const vm = manifest?.vm
  if (!isRecord(vm) || typeof vm.sha !== 'string' || !SHA_PATTERN.test(vm.sha) || !isRecord(vm.files)) throw checkFailure('metadata-invalid', 'Claude 安装包里读不到工作区清单')
  const files = vm.files[spec.platformKey]?.[spec.architecture]
  if (!Array.isArray(files) || files.length === 0) throw checkFailure('metadata-invalid', '工作区清单里没有这个平台的文件')
  const names = new Set()
  return files.map(function (file) {
    if (!isRecord(file) || typeof file.name !== 'string' || !FILE_NAME_PATTERN.test(file.name) || file.name.includes('..') || names.has(file.name)
      || typeof file.checksum !== 'string' || !SHA256_PATTERN.test(file.checksum) || !isComponentSize(file.size)) throw checkFailure('metadata-invalid', '工作区清单里有一项文件名、校验值或大小不对')
    names.add(file.name)
    const item = { kind: 'vm', architecture: spec.architecture, sha: vm.sha, name: file.name }
    return {
      label: `${file.name}.zst`,
      key: assertObjectKey(components.workspaceObjectKey(vm.sha, spec.platformKey, spec.architecture, file)),
      sourceUrl: validateComponentSourceUrl(componentSourceUrl(item)).href,
      bytes: file.size,
      sha256: file.checksum,
    }
  })
}

function codeItems(spec, manifest, components) {
  if (!isRecord(manifest?.code)) throw checkFailure('metadata-invalid', 'Claude 安装包里读不到 Claude Code 清单')
  const items = []
  for (const architecture of spec.architectures) {
    const pin = components.resolveMacPin(manifest, architecture)
    if (!pin) continue
    if (typeof pin.version !== 'string' || !VERSION_PATTERN.test(pin.version) || (pin.platform !== 'darwin-arm64' && pin.platform !== 'darwin-x64')
      || typeof pin.checksum !== 'string' || !SHA256_PATTERN.test(pin.checksum) || !isComponentSize(pin.size)) throw checkFailure('metadata-invalid', 'Claude Code 清单里的 Mac 程序包版本、校验值或大小不对')
    items.push({
      label: `${pin.platform}/claude.app.tar.zst`,
      key: assertObjectKey(components.macObjectKey(pin)),
      sourceUrl: validateComponentSourceUrl(componentSourceUrl({ kind: 'code', version: pin.version, platform: pin.platform })).href,
      bytes: pin.size,
      sha256: pin.checksum,
    })
  }
  if (items.length !== spec.architectures.length) throw checkFailure('metadata-invalid', 'Claude Code 清单里缺 Mac 程序包')
  return items
}

/**
 * 这一部分要搬哪些文件：桶里的位置、官网的地址、大小和校验值，全部来自清单。传几份清单（Windows、Mac 两个安装包）
 * 就搬几份要的并集，按桶里的位置去重：同一个位置名字里带着校验值，内容必然相同。
 */
function buildPlan(part, manifests, components) {
  const spec = PARTS[parsePart(part)]
  const list = Array.isArray(manifests) ? manifests : [manifests]
  if (list.length === 0) throw checkFailure('metadata-invalid', '没有读到任何一份 Claude 清单')
  const items = []
  const keys = new Set()
  const versions = []
  for (const manifest of list) {
    const own = spec.kind === 'vm' ? vmItems(spec, manifest, components) : codeItems(spec, manifest, components)
    const version = spec.kind === 'vm' ? manifest.vm.sha : manifest.code.version
    if (!versions.includes(version)) versions.push(version)
    for (const item of own) {
      if (!LABEL_PATTERN.test(item.label)) throw checkFailure('metadata-invalid', '组件文件名无效')
      if (keys.has(item.key)) continue
      keys.add(item.key)
      items.push(item)
    }
  }
  return {
    reference: spec.kind === 'vm' ? { vmShas: versions } : { codeVersions: versions },
    items,
  }
}

function safeComponentsSyncFailure(error) {
  const failure = stageFailures.get(error)
  if (!failure) return { stage: 'setup', failure: { code: 'operation-failed' } }
  return { ...failure.context, failure: safeSyncFailure(failure.error) }
}

function createStageRunner(progress, part) {
  function emit(value) {
    if (typeof progress === 'function') {
      try { progress(value) } catch {}
    }
  }
  return async function (stage, input, operation) {
    const started = performance.now()
    const context = { stage, part, ...input }
    function report(event, extra = {}) {
      emit({ event, ...context, elapsedMs: Math.round(performance.now() - started), ...extra })
    }
    function transfer(value) {
      const safe = {}
      if (['GET', 'HEAD', 'PUT'].includes(value?.method)) safe.method = value.method
      if (['upload-body', 'response-headers', 'response-body', 'complete'].includes(value?.phase)) safe.transferPhase = value.phase
      for (const name of ['transferredBytes', 'expectedBytes']) {
        if (Number.isSafeInteger(value?.[name]) && value[name] >= 0 && value[name] <= MAX_COMPONENT_BYTES) safe[name === 'expectedBytes' ? 'transferExpectedBytes' : name] = value[name]
      }
      report('transfer', safe)
    }
    report('stage-start')
    try {
      const result = await operation(transfer)
      report('stage-complete')
      return result
    } catch (error) {
      // Raw exceptions stay in memory; the log gets only what safeSyncFailure rebuilds.
      const wrapped = new Error(error instanceof Error ? error.message : 'Claude 组件同步阶段失败')
      stageFailures.set(wrapped, { error, context })
      report('stage-failed', { diagnostic: safeComponentsSyncFailure(wrapped) })
      throw wrapped
    }
  }
}

/** 下一个安装包、只解出 app.asar、读清单；安装包读完就删。 */
async function readInstallerManifest(id, { stage, dependencies, components, workDirectory }) {
  const installer = INSTALLERS[id]
  const context = { installer: id }
  const resource = await stage('source-resolve', context, function () { return dependencies.resolveInstaller(id) })
  const packagePath = path.join(workDirectory, installer.fileName)
  await stage('source-download-app', { ...context, expectedBytes: resource.bytes }, async function (onProgress) {
    const result = await dependencies.downloadResource({ url: resource.url, filePath: packagePath, allowedHosts: official.OFFICIAL_HOSTS, maxBytes: official.MAX_PACKAGE_BYTES,
      expectedBytes: resource.bytes, expectedEtag: resource.etag, headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT }, onProgress })
    if (!result || result.bytes !== resource.bytes) throw checkFailure('download-mismatch', 'Claude 安装包大小和官网说的不一致')
  })
  let asarPath
  try { asarPath = await stage('extract-asar', context, function () { return dependencies.extractAsar(packagePath, workDirectory, id) }) }
  finally { await dependencies.removeFile(packagePath) }
  return stage('read-manifest', context, async function () {
    try { return await components.readManifest(asarPath) } catch { throw checkFailure('package-format-invalid', 'Claude 安装包里的 app.asar 读不出来') }
  })
}

async function synchronizeClaudeComponents({ part, store, dependencies, components, progress, installers }) {
  installers ??= PARTS[parsePart(part)].installers
  if (!Array.isArray(installers) || installers.length === 0 || installers.some(function (id) { return !Object.hasOwn(INSTALLERS, id) })) throw checkFailure('platform-invalid', 'Claude 安装包来源无效')
  const stage = createStageRunner(progress, part)
  const workDirectory = await stage('prepare-temp', {}, function () { return dependencies.createWorkDirectory() })
  let primaryError
  try {
    // 一个安装包读不到（入口换了、官网一时不通）不挡另一个：读到的那份照样搬，搬完再报这次失败，让报警作业看得见。
    const manifests = []
    let installerError = null
    for (const id of installers) {
      try { manifests.push(await readInstallerManifest(id, { stage, dependencies, components, workDirectory })) }
      catch (error) { installerError ??= error }
    }
    if (manifests.length === 0) throw installerError
    const plan = await stage('plan', {}, async function () { return buildPlan(part, manifests, components) })
    if (typeof progress === 'function') {
      try { progress({ event: 'plan', part, ...plan.reference, files: plan.items.map(function (item) { return { file: item.label, bytes: item.bytes } }) }) } catch {}
    }
    const files = []
    for (const [index, item] of plan.items.entries()) {
      const context = { file: item.label, expectedBytes: item.bytes }
      const present = await stage('cos-check-existing', context, async function () {
        const existing = await store.inspect(item.key)
        if (!existing) return false
        // The key names the checksum and is written once; anything else under it is left alone for a person to look at.
        if (existing.bytes !== item.bytes || existing.sha256 !== item.sha256) throw checkFailure('cos-object-mismatch', '桶里已有同名文件，大小或校验值和清单对不上；没有覆盖它，请人工核对')
        return true
      })
      if (present) {
        files.push({ file: item.label, bytes: item.bytes, state: 'present' })
        continue
      }
      const filePath = path.join(workDirectory, `component-${index}.zst`)
      await stage('source-download', context, async function (onProgress) {
        const result = await dependencies.downloadResource({ url: validateComponentSourceUrl(item.sourceUrl).href, filePath, allowedHosts: [SOURCE_HOST], maxBytes: item.bytes,
          expectedBytes: item.bytes, expectedSha256: item.sha256, headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT }, onProgress })
        if (!result || result.bytes !== item.bytes || result.sha256 !== item.sha256) throw checkFailure('download-mismatch', 'Claude 组件的大小或校验值和清单对不上')
      })
      const published = await stage('cos-publish', context, async function (onProgress) {
        const result = await store.publishFile(item.key, filePath, { expectedBytes: item.bytes, expectedSha256: item.sha256, contentType: CONTENT_TYPE, cacheControl: CACHE_CONTROL, onProgress })
        if (!result || result.bytes !== item.bytes || result.sha256 !== item.sha256) throw checkFailure('cos-object-mismatch', '桶里回读的 Claude 组件和清单对不上')
        return result
      })
      await stage('cos-head', context, async function () {
        const head = await store.inspect(item.key)
        if (!head || head.bytes !== item.bytes || head.sha256 !== item.sha256 || typeof head.etag !== 'string' || head.etag !== published.etag) throw checkFailure('cos-object-mismatch', '传完以后桶里查到的 Claude 组件和回读核过的不一致')
      })
      await dependencies.removeFile(filePath)
      files.push({ file: item.label, bytes: item.bytes, state: 'uploaded' })
    }
    if (installerError) throw installerError
    return { part, ...plan.reference, files }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await stage('cleanup-temp', {}, function () { return dependencies.removeWorkDirectory(workDirectory) }) } catch (error) {
      if (!primaryError) throw error
    }
  }
}

function safeChildEnvironment(directory) {
  return { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C' }
}

/** MSIX 和 Mac 的 zip 都是 zip：只解 app.asar 这一项到新建的空目录，解出来必须是普通文件。 */
async function extractAsar(packagePath, workDirectory, installer = 'windows', run = promisify(execFile), platform = process.platform) {
  if (platform === 'win32') throw checkFailure('inspector-unavailable', '解 Claude 安装包要在 Linux 或 macOS 上跑')
  if (!Object.hasOwn(INSTALLERS, installer)) throw checkFailure('platform-invalid', 'Claude 安装包来源无效')
  const entry = INSTALLERS[installer].asarEntry
  const directory = path.join(workDirectory, installer)
  await fs.mkdir(directory, { mode: 0o700 })
  try {
    await run('/usr/bin/unzip', ['-qq', '-n', packagePath, entry, '-d', directory], { env: safeChildEnvironment(workDirectory), timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 })
  } catch (error) {
    throw checkFailure('inspector-failed', 'Claude 安装包里解不出 app.asar', observedProcessFailure(error))
  }
  const asarPath = path.join(directory, ...entry.split('/'))
  let stats
  try { stats = await fs.lstat(asarPath) } catch { throw checkFailure('package-format-invalid', 'Claude 安装包里没有 app.asar') }
  if (!stats.isFile() || stats.nlink !== 1 || stats.size < 1024 || stats.size > MAX_ASAR_BYTES) throw checkFailure('package-format-invalid', 'Claude 安装包里的 app.asar 不是普通文件或大小不对')
  return asarPath
}

/**
 * 只读 Mac 那个固定入口的响应头（它不认 HEAD，所以用 GET，拿到头就断开、不收正文），把 Location 交回来。
 * 只认一跳 30x 到 downloads.claude.ai 的通用版 zip，别的一律停。
 */
function requestMacZipLocation(options = {}) {
  const timeoutMs = options.headerTimeoutMs ?? 30000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(new Error('Claude Mac 入口响应头超时配置无效'))
  return new Promise(function (resolve, reject) {
    let request
    let settled = false
    const timer = setTimeout(function () { fail(checkFailure('source-url-rejected', 'Claude Mac 安装包入口响应头超时')) }, timeoutMs)
    function fail(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
      if (request) request.destroy()
    }
    try {
      request = (options.requestImpl || https.request)(new URL(MAC_ZIP_REQUEST_URL), { method: 'GET', headers: { 'accept-encoding': 'identity', 'user-agent': USER_AGENT }, agent: false, maxHeaderSize: 16 * 1024 }, function (response) {
        if (settled) { response.destroy(); return }
        settled = true
        clearTimeout(timer)
        const status = response.statusCode
        const location = response.headers?.location
        response.destroy()
        if (request) request.destroy()
        if (![301, 302, 303, 307, 308].includes(status) || typeof location !== 'string' || !MAC_ZIP_LOCATION.test(location)) {
          reject(checkFailure('source-url-rejected', 'Claude Mac 安装包入口没有跳到 downloads.claude.ai 的通用版 zip'))
          return
        }
        resolve(location)
      })
      request.on('error', function () { fail(checkFailure('source-url-rejected', 'Claude Mac 安装包入口连不上')) })
      request.end()
    } catch { fail(checkFailure('source-url-rejected', 'Claude Mac 安装包入口连不上')) }
  })
}

/** 两个安装包各自的最新一版：地址、大小、ETag（下载时对 ETag，防止中途换了包）。 */
async function resolveInstaller(id, options = {}) {
  const resolveOfficial = options.resolveOfficialPackage || official.resolveOfficialPackage
  if (id === 'windows') return resolveOfficial(MSIX_REQUEST_URL)
  if (id === 'macos') return resolveOfficial(await (options.requestMacZipLocation || requestMacZipLocation)())
  throw checkFailure('platform-invalid', 'Claude 安装包来源无效')
}

function createRuntimeDependencies(common) {
  return {
    downloadResource: common.downloadResource,
    resolveInstaller: function (id) { return resolveInstaller(id) },
    extractAsar: function (packagePath, workDirectory, installer) { return extractAsar(packagePath, workDirectory, installer) },
    removeFile: function (filePath) { return fs.rm(filePath, { force: true }) },
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), WORK_PREFIX)) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith(WORK_PREFIX)) throw checkFailure('temp-path-rejected', '拒绝删除 Claude 组件同步临时目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

async function main(argv = process.argv.slice(2)) {
  const part = parsePartArgument(argv)
  const common = require('./cos-sync-utils.cjs')
  const config = common.readCosConfiguration(process.env)
  const result = await synchronizeClaudeComponents({ part, store: common.createCosStore(config, { multipartDeadlineMs: MULTIPART_DEADLINE_MS }),
    dependencies: createRuntimeDependencies(common), components: loadComponents(),
    progress: function (event) { console.log(`[claude-components-sync] ${JSON.stringify(event)}`) } })
  console.log(JSON.stringify(result))
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(`Claude 组件同步失败；安全诊断：${JSON.stringify(safeComponentsSyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = { SOURCE_HOST, PREFIX, CONTENT_TYPE, CACHE_CONTROL, MSIX_REQUEST_URL, MSIX_ASAR_ENTRY, MAC_ZIP_REQUEST_URL, MAC_ASAR_ENTRY, INSTALLERS, INSTALLER_IDS,
  MULTIPART_DEADLINE_MS, PARTS, PART_IDS, parsePart, parsePartArgument, componentSourceUrl, validateComponentSourceUrl, assertObjectKey, componentsFromModules,
  loadComponents, buildPlan, synchronizeClaudeComponents, safeComponentsSyncFailure, safeChildEnvironment, extractAsar, requestMacZipLocation, resolveInstaller,
  createRuntimeDependencies, main }
