#!/usr/bin/env node
const fs = require('node:fs/promises')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { buildAllowedArtifacts, buildManagerReleasePlan, syncManagerRelease } = require('./sync-manager-release-cos.cjs')

const REPOSITORY = 'xufei5620/xingmang-ai-manager'
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`
const DOWNLOAD_HOSTS = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3
const MAX_RELEASE_JSON_BYTES = 1024 * 1024
const REQUEST_HEADERS = { 'user-agent': 'xingmang-published-cos-sync', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }

function validateTag(tag) {
  if (typeof tag !== 'string' || tag.length > 64 || !/^v0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    throw new Error('只能导入正式 v0.x.x 版本标签')
  }
  return tag
}

function releaseApiUrl(tag) {
  return tag ? `${API_ROOT}/releases/tags/${validateTag(tag)}` : `${API_ROOT}/releases/latest`
}

function validatePublishedRelease(value, requestedTag) {
  if (requestedTag) validateTag(requestedTag)
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.id) || value.id <= 0
    || value.url !== `${API_ROOT}/releases/${value.id}`
    || value.draft !== false || value.prerelease !== false
    || typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))
    || !Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 100) {
    throw new Error('GitHub Release 不是本仓已发布的正式版本')
  }
  const tag = validateTag(value.tag_name)
  if ((requestedTag && tag !== requestedTag) || value.html_url !== `https://github.com/${REPOSITORY}/releases/tag/${tag}`) {
    throw new Error('GitHub Release 仓库或标签与请求不一致')
  }
  const version = tag.slice(1)
  const allowed = buildAllowedArtifacts(version)
  const names = new Set()
  const ids = new Set()
  const assets = []
  for (const asset of value.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
      || typeof asset.name !== 'string' || asset.name.length > 255
      || !Number.isSafeInteger(asset.id) || asset.id <= 0 || names.has(asset.name) || ids.has(asset.id)) {
      throw new Error('GitHub Release 附件条目无效或重复')
    }
    names.add(asset.name)
    ids.add(asset.id)
    const descriptor = allowed.get(asset.name)
    if (!descriptor || descriptor.kind !== 'installer') {
      if (/\.(?:exe|dmg|deb)$/i.test(asset.name)) throw new Error('GitHub Release 包含不属于本版本的安装包')
      continue
    }
    const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(asset.name)}`
    if (asset.url !== `${API_ROOT}/releases/assets/${asset.id}` || asset.browser_download_url !== expectedUrl
      || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > descriptor.maxBytes
      || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
      throw new Error('GitHub 安装包来源、大小或 SHA-256 摘要无效')
    }
    assets.push({ ...descriptor, id: asset.id, url: expectedUrl, size: asset.size, sha256: asset.digest.slice(7) })
  }
  if (assets.length === 0) throw new Error('GitHub 正式版本没有可导入的星芒安装包')
  return { id: value.id, tag, version, assets }
}

function validateDownloadUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('GitHub 安装包下载地址无效') }
  if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(url.hostname)
    || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('GitHub 安装包下载地址不在 HTTPS 白名单内')
  }
  return url
}

function requestDownloadHead(url, { requestImpl = https.request, timeoutMs = 30000 } = {}) {
  validateDownloadUrl(url)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('GitHub 下载探测超时无效')
  return new Promise((resolve, reject) => {
    let request
    const timer = setTimeout(() => {
      if (request) request.destroy()
      reject(new Error('GitHub 下载探测超时'))
    }, timeoutMs)
    function fail() {
      clearTimeout(timer)
      if (request) request.destroy()
      reject(new Error('GitHub 下载探测失败，未记录服务器正文或签名地址'))
    }
    try {
      request = requestImpl(url, {
        method: 'HEAD', headers: { 'user-agent': REQUEST_HEADERS['user-agent'], 'accept-encoding': 'identity' },
        agent: false, maxHeaderSize: 16 * 1024,
      }, (response) => {
        clearTimeout(timer)
        const result = { status: response.statusCode, location: response.headers?.location }
        response.destroy()
        resolve(result)
      })
      request.on('error', fail)
      request.end()
    } catch { fail() }
  })
}

async function resolveAssetDownloadUrl(asset, options = {}) {
  let url = validateDownloadUrl(asset.url)
  if (url.hostname !== 'github.com' || url.search) throw new Error('GitHub 安装包必须从已验证的仓库附件地址开始下载')
  const inspect = options.inspectHead || requestDownloadHead
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const result = await inspect(url, options)
    if (result.status === 200) return url.href
    if (!REDIRECT_STATUSES.has(result.status) || typeof result.location !== 'string' || redirects === MAX_REDIRECTS) {
      throw new Error('GitHub 安装包下载探测失败或重定向次数超限')
    }
    const target = validateDownloadUrl(new URL(result.location, url).href)
    // Once on GitHub's asset storage, another repository URL must not become
    // a new trust anchor. No authorization headers are sent on any hop.
    if (target.hostname === 'github.com' && (target.pathname !== url.pathname || target.search)) {
      throw new Error('GitHub 安装包重定向不能切换仓库附件')
    }
    url = target
  }
  throw new Error('GitHub 安装包重定向次数超限')
}

async function syncPublishedManagerRelease(options = {}) {
  const tag = options.tag || undefined
  const utilities = options.utilities || require('./cos-sync-utils.cjs')
  const metadata = await utilities.fetchJson({
    url: releaseApiUrl(tag), allowedHosts: ['api.github.com'], headers: REQUEST_HEADERS, maxBytes: MAX_RELEASE_JSON_BYTES,
  }, { headerTimeoutMs: 30000, bodyTimeoutMs: 30000, requestImpl: options.requestImpl })
  const release = validatePublishedRelease(metadata, tag)
  const temporaryBase = await fs.realpath(options.temporaryBase || os.tmpdir())
  const directory = await fs.mkdtemp(path.join(temporaryBase, 'xingmang-published-cos-'))
  const expectedFiles = new Map(release.assets.map((asset) => [path.join(directory, asset.fileName), asset]))
  const anchoredUtilities = {
    ...utilities,
    async hashFile(filePath, limits) {
      const asset = expectedFiles.get(filePath)
      if (!asset) throw new Error('导入目录包含未获 GitHub 摘要授权的文件')
      const digest = await utilities.hashFile(filePath, limits)
      if (digest.bytes !== asset.size || digest.sha256 !== asset.sha256) {
        throw new Error('GitHub 发布安装包大小或 SHA-256 校验失败，未同步 COS')
      }
      return digest
    },
  }
  try {
    for (const asset of release.assets) {
      const url = await resolveAssetDownloadUrl(asset, options)
      const filePath = path.join(directory, asset.fileName)
      await utilities.downloadResource({
        url, allowedHosts: DOWNLOAD_HOSTS, filePath, maxBytes: asset.size,
        expectedBytes: asset.size, expectedSha256: asset.sha256,
      }, { headerTimeoutMs: 30000, bodyTimeoutMs: 15 * 60 * 1000, requestImpl: options.requestImpl })
      await anchoredUtilities.hashFile(filePath, { maxBytes: asset.maxBytes })
    }
    // Keep GitHub's digest authoritative during the publisher's second plan
    // read as well, rather than blessing bytes changed after download checks.
    await buildManagerReleasePlan(directory, release.version, { utilities: anchoredUtilities, installersOnly: true })
    const synchronize = options.sync || syncManagerRelease
    return await synchronize({
      ...options.syncOptions, directory, version: release.version, installersOnly: true, utilities: anchoredUtilities,
    })
  } finally {
    // The directory is created by this run under one canonical temp root.
    // Verify the deletion target before recursive cleanup on Windows too.
    if (path.dirname(directory) !== temporaryBase || !path.basename(directory).startsWith('xingmang-published-cos-')) {
      throw new Error('导入临时目录校验失败，未清理目录')
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function parseArguments(argv, env = process.env) {
  let tag = env.MANAGER_RELEASE_TAG || undefined
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--tag' || tag) throw new Error('用法：sync-published-manager-cos.cjs [--tag v0.x.x]')
    tag = argv[1]
  }
  if (tag) validateTag(tag)
  return { tag }
}

async function main(argv) {
  const result = await syncPublishedManagerRelease(parseArguments(argv))
  console.log(`已将 GitHub 正式版本 ${result.version} 的安装包导入 COS，未重新发布版本或修改客户端更新源`)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => {
    console.error('::error::已发布安装包导入 COS 失败，请核对正式版本、GitHub 摘要及 COS 配置后重跑；未记录凭据或签名地址')
    process.exitCode = 1
  })
}

module.exports = { REPOSITORY, parseArguments, releaseApiUrl, requestDownloadHead, resolveAssetDownloadUrl, syncPublishedManagerRelease, validatePublishedRelease, validateTag }
