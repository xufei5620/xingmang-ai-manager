const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { readBoundedRegularFile } = require('./cos-sync-utils.cjs')

const BUILDER_VERSION = '26.15.3'
const GET_VERSION = '5.0.0'
const ORIGINAL_SOURCE_SHA256 = '3452ca5b9a2f29dd6460f0cc9937be2dc1bbbf36809f410649a015b35a607b48'
const MAX_SOURCE_BYTES = 1024 * 1024
// electron-builder 自带的下载重试是 3 次、间隔 2、4、6 秒，一共只等约 12 秒；GitHub 的
// 504 常常连着几十秒到几分钟，打包就红（深查 CI-1：11-09 Mac、Linux 打包各连红两次，
// 红在 Electron 压缩包、校验文件和 fpm 上）。放宽到 5 次、
// 间隔 10、30、50、70、90 秒，一共约 4 分钟，跟测试前装 Electron 那一步
// （ci-ensure-electron-binary.cjs）的等法同一个量级。只多等，不多放：哪些错误值得重试
// 仍由 builder-fetch-compat.cjs 的 shouldRetryDownloadError 决定，每次下载照样核对校验和。
const DOWNLOAD_RETRY = Object.freeze({ retries: 5, interval: 10000, backoff: 20000 })

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function replacementPlan(helperReference) {
  return [
    {
      original: '                shouldRetry: (e) => {\n                    var _a;\n',
      replacement: '                shouldRetry: (e) => {\n                    var _a;\n                    const callerSignals = [config.signal, config.downloadOptions?.signal, downloadOptions.signal];\n                    if (callerSignals.some(signal => signal?.aborted)) return false;\n',
      count: 1,
    },
    {
      original: 'const get = require("@electron/get");',
      replacement: `const get = require("@electron/get");\nconst xingmangFetch = require(${JSON.stringify(helperReference)});`,
      count: 1,
    },
    {
      original: '    const configWithProgress = { ...config, downloadOptions };\n    try {',
      replacement: '    const configWithProgress = { ...config, downloadOptions };\n    try {\n        await xingmangFetch.initializeProxyOnce(get);',
      count: 1,
    },
    {
      original: '                builder_util_1.log.warn({ option: "electronDownload.strictSSL" }, "strictSSL is false — TLS certificate validation is DISABLED for Electron downloads. Only use this option in a trusted, isolated build environment.");',
      replacement: '                throw new Error("构建下载必须验证 TLS 证书，不能关闭 strictSSL");',
      count: 1,
    },
    {
      original: '                ...(strictSSL === false ? { downloadOptions: { https: { rejectUnauthorized: false } } } : {}),',
      replacement: '                ...(strictSSL === false ? { downloadOptions: { https: { rejectUnauthorized: true } } } : {}),',
      count: 1,
    },
    {
      original: '        agent: (_b = (_a = config.downloadOptions) === null || _a === void 0 ? void 0 : _a.agent) !== null && _b !== void 0 ? _b : (0, builder_util_1.buildGotProxyAgent)(),\n',
      replacement: '',
      count: 1,
    },
    {
      original: 'get.downloadArtifact(configWithProgress)',
      replacement: 'get.downloadArtifact(xingmangFetch.buildAttemptConfig(configWithProgress, downloadOptions))',
      count: 2,
    },
    {
      original: 'get.downloadArtifact({ ...configWithProgress, cacheMode: get_1.ElectronDownloadCacheMode.WriteOnly })',
      replacement: 'get.downloadArtifact(xingmangFetch.buildAttemptConfig({ ...configWithProgress, cacheMode: get_1.ElectronDownloadCacheMode.WriteOnly }, downloadOptions))',
      count: 1,
    },
    {
      original: '                    if (typeof ((_a = e === null || e === void 0 ? void 0 : e.response) === null || _a === void 0 ? void 0 : _a.statusCode) === "number") {\n                        return e.response.statusCode >= 500;\n                    }\n                    return typeof (e === null || e === void 0 ? void 0 : e.code) === "string" && ["ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EPIPE", "ENOENT"].includes(e.code);',
      replacement: '                    return xingmangFetch.shouldRetryDownloadError(e, callerSignals);',
      count: 1,
    },
    {
      original: '                retries: 3,\n                interval: 2000,\n                backoff: 2000,\n',
      replacement: `                retries: ${DOWNLOAD_RETRY.retries},\n                interval: ${DOWNLOAD_RETRY.interval},\n                backoff: ${DOWNLOAD_RETRY.backoff},\n`,
      count: 1,
      // Added after the first release of this plan; see recoverOriginalSource.
      widensRetry: true,
    },
  ]
}

function replaceExactly(source, entry) {
  if (source.split(entry.original).length - 1 !== entry.count) {
    throw new Error('打包器下载兼容补丁的源码锚点不匹配，未修改未知版本')
  }
  return source.split(entry.original).join(entry.replacement)
}

function buildPatchedSource(original, helperReference) {
  if (typeof original !== 'string' || Buffer.byteLength(original) > MAX_SOURCE_BYTES || digest(original) !== ORIGINAL_SOURCE_SHA256) {
    throw new Error('打包器下载模块的原始 SHA-256 不匹配，未修改未知源码')
  }
  return replacementPlan(helperReference).reduce(replaceExactly, original)
}

function reversePlan(source, plan) {
  let recovered = source
  for (const entry of [...plan].reverse()) {
    if (!entry.replacement) continue
    recovered = replaceExactly(recovered, { original: entry.replacement, replacement: entry.original, count: entry.count })
  }
  // The removed default got agent has one fixed insertion position in the
  // original source. Only the full original hash may authorize this recovery.
  const removed = plan.find(entry => !entry.replacement)
  const marker = '        ...config.downloadOptions,\n'
  return replaceExactly(recovered, { original: marker, replacement: marker + removed.original, count: 1 })
}

function recoverOriginalSource(source, helperReference) {
  const current = replacementPlan(helperReference)
  // An existing node_modules may still carry the plan from before the retry
  // window was widened; `npm install` over it must move it to the current plan
  // rather than refuse. Each candidate is only a way to undo known edits: the
  // result is accepted solely when it hashes to the verified original source.
  const candidates = [current, current.filter(entry => !entry.widensRetry)]
  for (const plan of candidates) {
    let recovered
    try { recovered = reversePlan(source, plan) } catch { continue }
    if (digest(recovered) === ORIGINAL_SOURCE_SHA256) return recovered
  }
  throw new Error('打包器兼容补丁不是本项目已核实的版本，未重复修改')
}

async function applyBuilderFetchCompatibility(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'))
  const libraryRoot = path.join(projectRoot, 'node_modules', 'app-builder-lib')
  const manifestPath = path.join(libraryRoot, 'package.json')
  let manifest
  try { manifest = JSON.parse((await readBoundedRegularFile(manifestPath, { maxBytes: 128 * 1024 })).toString('utf8')) } catch (error) {
    if (!await fs.access(libraryRoot).then(() => true, () => false)) return { skipped: true }
    throw error
  }
  if (manifest.version !== BUILDER_VERSION) throw new Error('打包器版本不符合已核实的兼容补丁，必须先更新补丁证据')
  const getRoot = path.join(projectRoot, 'node_modules', '@electron', 'get')
  const getManifest = JSON.parse((await readBoundedRegularFile(path.join(getRoot, 'package.json'), { maxBytes: 128 * 1024 })).toString('utf8'))
  if (getManifest.version !== GET_VERSION) throw new Error('Electron 下载库版本不符合已核实的构建依赖修复')
  const resolvedGet = require.resolve('@electron/get', { paths: [libraryRoot] })
  if (!resolvedGet.startsWith(getRoot + path.sep)) throw new Error('打包器没有解析到已锁定的共享 Electron 下载库')
  const target = path.join(libraryRoot, 'out', 'util', 'electronGet.js')
  const helper = path.join(projectRoot, 'scripts', 'builder-fetch-compat.cjs')
  await readBoundedRegularFile(helper, { maxBytes: MAX_SOURCE_BYTES })
  const reference = path.relative(path.dirname(target), helper).split(path.sep).join('/')
  const sourceBytes = await readBoundedRegularFile(target, { maxBytes: MAX_SOURCE_BYTES })
  const source = sourceBytes.toString('utf8')
  const original = digest(source) === ORIGINAL_SOURCE_SHA256 ? source : recoverOriginalSource(source, reference)
  const patched = buildPatchedSource(original, reference)
  if (source === patched) return { skipped: false, changed: false, version: BUILDER_VERSION }
  const before = await fs.lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('打包器模块不是单链接普通文件')
  const temporary = target + `.xingmang-${randomUUID()}`
  try {
    await fs.writeFile(temporary, patched, { flag: 'wx', mode: before.mode & 0o777 })
    const current = await fs.lstat(target)
    // The bytes on disk must still be the ones verified above: the original
    // source, or a known plan whose exact reversal hashes to it. Until the
    // retry window was widened only the original could reach this point, so
    // comparing with the original hash said the same thing.
    if (current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink() || current.nlink !== 1
      || digest(await readBoundedRegularFile(target, { maxBytes: MAX_SOURCE_BYTES })) !== digest(sourceBytes)) throw new Error('打包器模块在兼容补丁核对期间变化，未替换')
    await fs.rename(temporary, target)
  } finally { await fs.unlink(temporary).catch(() => {}) }
  return { skipped: false, changed: true, version: BUILDER_VERSION }
}

if (require.main === module) {
  applyBuilderFetchCompatibility().then(result => {
    console.log(result.skipped ? '未安装开发构建依赖，跳过打包器下载兼容补丁' : `打包器 ${result.version} 原生 fetch 下载兼容补丁${result.changed ? '已应用' : '已核对'}`)
  }).catch(error => {
    console.error(error instanceof Error ? error.message : '打包器下载兼容补丁失败')
    process.exitCode = 1
  })
}

module.exports = { BUILDER_VERSION, DOWNLOAD_RETRY, GET_VERSION, ORIGINAL_SOURCE_SHA256, buildPatchedSource, recoverOriginalSource, applyBuilderFetchCompatibility }
