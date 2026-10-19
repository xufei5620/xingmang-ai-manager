#!/usr/bin/env node
// 生成更新目录上的 service-status.json（客户端读法见 electron/service-status.ts，
// 格式与操作步骤见 docs/SERVICE-STATUS.md）。
//
// 这个脚本只在 GitHub Actions 的 service-status 工作流里跑：先取回线上现有的
// 那一份，只改这次填了的字段，其余原样保留，再把结果交给工作流上传。「留空 =
// 不改」是有意的：发布者只想关掉维护时，不该顺手把别的开关一起抹掉。
const fs = require('node:fs')
// 只用它的版本比较；它顶层只引 node 自带模块和两份同目录脚本，preview 那段不装依赖也能跑。
const { compareReleaseVersions } = require('./update-release-utils.cjs')

const MAX_MESSAGE_LENGTH = 200
const MAX_STATUS_BYTES = 16 * 1024
// 分组对照的几样用途与客户端 electron/managed-cli-groups.ts 的 accountGroupRoles 一致；
// 名字的上限与 isManagedCliGroupName、每样最多几个与 service-status.ts 的读法一致。
const ACCOUNT_GROUP_ROLES = ['claude', 'codex', 'grok', 'image']
const ACCOUNT_GROUP_LABELS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', image: '画图' }
const MAX_GROUP_NAME_LENGTH = 128
const MAX_GROUP_CANDIDATES = 8
// 型号表的工具与写法与客户端 electron/cli-model-defaults.ts（isCliModelName）、每样最多几个与
// service-status.ts 的 readCliModels 一致。Gemini CLI 已下线，不收。
const CLI_MODEL_TOOLS = ['claude', 'codex', 'grok']
const CLI_MODEL_TOOL_LABELS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' }
const CLI_MODEL_FIELDS = ['default', 'previous', 'retired']
const CLI_MODEL_NAME = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/
const MAX_PREVIOUS_CLI_MODELS = 8
const MAX_RETIRED_CLI_MODELS = 32
// #1114：最低版本指着出来还不满一天的包时提醒批准的人。0.2.19 发出去 12 分钟就被设成最低版本。
const FRESH_RELEASE_MS = 24 * 60 * 60 * 1000
// 撤回、放量、最低版本只对哪几种安装包生效（#1155 第 5 条），写法与客户端 electron/service-status.ts 的
// releasePlatformPattern 一致：平台，或平台-架构。
const RELEASE_PLATFORM = /^(windows|mac|linux)(?:-(x64|arm64))?$/
const RELEASE_PLATFORM_LABELS = {
  windows: 'Windows',
  'windows-x64': 'Windows x64 版',
  'windows-arm64': 'Windows arm64 版',
  mac: 'Mac',
  'mac-x64': 'Mac Intel 版',
  'mac-arm64': 'Mac M 系列芯片版',
  linux: 'Linux',
  'linux-x64': 'Linux x64 版',
  'linux-arm64': 'Linux arm64 版',
}
// 第一个认平台的客户端版本：更早的不认，带平台的条目在它们那里照旧对所有平台生效。
const PLATFORM_AWARE_CLIENT = '0.2.20'

class StatusInputError extends Error {}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 线上那一份确实不存在（第一次发、被删了，工作流拿到 404 后传 null）就从空白开始。
 * 存在但读出来是空白、不是 JSON 或不是对象，一律报错停下（#500）：那多半是缓存或
 * 路由临时回了一张 HTML 页面，而线上真正的文件里可能还有撤回名单与分批放量。
 * 当成空白重建再传上去，只改一个维护开关也会把它们一起抹掉。
 */
function parseCurrentStatus(text) {
  if (text === null || text === undefined) return {}
  const unreadable = '线上的状态文件读回来不是有效的 JSON 对象（可能是缓存或路由回了网页）。为免抹掉撤回名单和分批放量，这次不改；过几分钟重跑，还不行就去 Cloudflare 后台看看这个文件'
  if (typeof text !== 'string' || !text.trim()) throw new StatusInputError(unreadable)
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new StatusInputError(unreadable)
  }
  if (!isRecord(parsed)) throw new StatusInputError(unreadable)
  return parsed
}

// 与客户端一样去掉控制字符和双向文本控制符；这里再多一步：超长直接报错，而不是
// 悄悄截断——发布者该知道用户看到的不是他写的那一整句。
function normalizeMessage(value) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (Array.from(cleaned).length > MAX_MESSAGE_LENGTH) {
    throw new StatusInputError(`给用户看的话最多 ${MAX_MESSAGE_LENGTH} 个字，现在是 ${Array.from(cleaned).length} 个`)
  }
  return cleaned
}

/**
 * 「2026-09-24 23:00」按北京时间理解（发布者在国内），也收带时区的 ISO 时间。
 * 返回 UTC 的 ISO 字符串；空值返回 null。
 */
function normalizeUntil(value, now = new Date()) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const local = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/)
  const time = local
    ? Date.UTC(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]) - 8, Number(local[5]))
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? Date.parse(raw) : Number.NaN
  if (!Number.isFinite(time)) {
    throw new StatusInputError(`看不懂这个时间：${raw}。请写成 2026-09-24 23:00（北京时间）`)
  }
  if (time <= now.getTime()) throw new StatusInputError(`维护结束时间 ${raw} 已经过去了`)
  return new Date(time).toISOString()
}

const PLAIN_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/

function plainVersion(value) {
  const version = String(value ?? '').trim().replace(/^v/i, '')
  if (!PLAIN_VERSION.test(version)) throw new StatusInputError(`版本号要写成 0.2.10 这样：${value}`)
  return version
}

/** 「mac-x64|linux」这样的平台表。写错直接报错：客户端遇到认不出的会当成对所有平台生效，发布者得当场知道。 */
function releasePlatforms(value, context) {
  const names = [...new Set(String(value ?? '').split(/[|｜]/).map((entry) => entry.trim().toLowerCase()))]
  if (names.some((name) => !RELEASE_PLATFORM.test(name))) {
    throw new StatusInputError(`平台只认 windows、mac、linux，后面可以接 -x64 或 -arm64（mac-x64 是 Intel 版的 Mac 包），几种之间用 | 隔开：${context}`)
  }
  return names
}

// 线上那份里读得懂的平台表；读不懂的那一项跟客户端一样当成对所有平台生效。
function validReleasePlatforms(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  return value.every((entry) => typeof entry === 'string' && RELEASE_PLATFORM.test(entry)) ? value : null
}

/** 「0.2.12@mac-x64」拆成版本号和平台表；不带 @ 的平台表是 null（对所有平台）。 */
function splitReleasePlatforms(input) {
  const raw = String(input ?? '').trim()
  const parts = raw.split(/[@＠]/)
  if (parts.length > 2) throw new StatusInputError(`一项里只能写一个 @：${raw}`)
  return { value: parts[0].trim(), platforms: parts.length === 2 ? releasePlatforms(parts[1], raw) : null }
}

function describePlatforms(platforms) {
  return platforms.map((name) => RELEASE_PLATFORM_LABELS[name] ?? name).join('、')
}

/**
 * 撤回名单只加不减：一个版本撤回之后，还停在它上面的人随时可能来检查更新，名单
 * 上少了它，那些人就退不回去了。真要移除写「-0.2.10」，清空写 none。
 *
 * 「0.2.20@mac-x64」只撤 Intel 版的 Mac 包（#1155 第 5 条）。版本号照旧写进 badVersions，撤哪几种另记在
 * badVersionPlatforms：0.2.19 及以前的客户端只认前者，照旧整版撤回，只会撤得更多、不会漏。同一个版本再加
 * 别的平台就合起来；不带 @ 再写一次就改回对所有平台撤回。已经对所有平台撤回的版本不能直接收窄（那等于
 * 替一部分平台移出名单），要先「-0.2.20」再加。返回 { versions, platforms }，platforms 为 undefined 就是没有
 * 只撤某几种的版本。
 */
function applyBadVersions(current, input, currentPlatforms) {
  const raw = String(input ?? '').trim()
  if (!raw) return { versions: current, platforms: currentPlatforms }
  if (raw.toLowerCase() === 'none') return { versions: [], platforms: undefined }
  const versions = new Set(Array.isArray(current) ? current.filter((entry) => typeof entry === 'string') : [])
  const scoped = new Map()
  if (isRecord(currentPlatforms)) {
    for (const [version, platforms] of Object.entries(currentPlatforms)) {
      const valid = validReleasePlatforms(platforms)
      if (valid) scoped.set(version, valid)
    }
  }
  for (const token of raw.split(/[\s,，]+/).filter(Boolean)) {
    const { value, platforms } = splitReleasePlatforms(token)
    if (value.startsWith('-')) {
      if (platforms) throw new StatusInputError(`移出撤回名单时只写版本号，不带平台：${token}`)
      const version = plainVersion(value.slice(1))
      versions.delete(version)
      scoped.delete(version)
      continue
    }
    const version = plainVersion(value)
    if (!platforms) {
      versions.add(version)
      scoped.delete(version)
      continue
    }
    if (versions.has(version) && !scoped.has(version)) {
      throw new StatusInputError(`${version} 已经对所有平台撤回了。要改成只撤某几种安装包，先移出再加，写成「-${version} ${token}」`)
    }
    versions.add(version)
    scoped.set(version, [...new Set([...(scoped.get(version) ?? []), ...platforms])])
  }
  const kept = [...versions].filter((version) => scoped.has(version))
  return {
    versions: [...versions],
    platforms: kept.length ? Object.fromEntries(kept.map((version) => [version, scoped.get(version)])) : undefined,
  }
}

/**
 * 「0.2.11 20」或「0.2.11 20%」= 0.2.11 先给两成电脑；none = 取消分批，全部放开。
 * 后面接「@mac-x64」只对这几种安装包分批，别的照常全放（#1155 第 5 条）；0.2.19 及以前的客户端不认，
 * 对所有平台分批，只会推得更慢。
 */
function applyRollout(current, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return current
  if (raw.toLowerCase() === 'none') return undefined
  const { value, platforms } = splitReleasePlatforms(raw)
  const match = value.match(/^v?(\S+)\s+(\d{1,3})\s*%?$/)
  if (!match) throw new StatusInputError(`分批放量要写成「0.2.11 20」（版本号 空格 百分比）：${raw}`)
  const percent = Number(match[2])
  if (percent > 100) throw new StatusInputError(`百分比最多 100：${raw}`)
  return { version: plainVersion(match[1]), percent, ...(platforms ? { platforms } : {}) }
}

/**
 * 「0.2.12」= 低于 0.2.12 的客户端必须先更新；none = 取消。
 *
 * 最低版本会把人挡在门外，所以不许高于线上正在发的版本（两个平台各看一份更新清单）：
 * 定高了，低于它的人找不到可装的新版本。客户端遇到这种情况也会放行，这里是第一道闸。
 */
function applyMinimumVersion(current, input, publishedVersions = []) {
  const raw = String(input ?? '').trim()
  if (!raw) return current
  if (raw.toLowerCase() === 'none') return undefined
  const version = plainVersion(raw)
  const published = publishedVersions.map((entry) => plainVersion(entry))
  if (published.length === 0) throw new StatusInputError('读不到线上的更新清单，不知道现在发的是哪个版本，为免把客户挡在门外，这次不设最低版本')
  const newest = published.filter((entry) => compareReleaseVersions(version, entry) > 0)
  if (newest.length) {
    throw new StatusInputError(`最低版本 ${version} 比线上正在发的 ${published.join('、')} 还高：低于它的客户找不到可装的新版本。请先发布 ${version}，再设最低版本`)
  }
  return version
}

function groupName(role, value) {
  const name = value.trim()
  if (!name) throw new StatusInputError(`${role} 那一项里有空的分组名字（两个 | 挨着了？）`)
  if (name.length > MAX_GROUP_NAME_LENGTH) throw new StatusInputError(`分组名字最多 ${MAX_GROUP_NAME_LENGTH} 个字：${name}`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new StatusInputError(`分组名字里不能有控制字符：${name}`)
  return name
}

/**
 * 分组对照：「claude=新名字|老名字; codex=…; grok=…; image=…」。每样用途按先后列名字，客户端在
 * 这个账号能用的分组里挑排在前面的；站上改本名前把新名字写在前、老名字写在后。
 * 只改这次写到的那几样，没写到的照线上保留；「claude=none」去掉一样，整个写 none 清空。
 * 名字原样照抄，不认得的用途、写错的名字直接报错——客户端遇到会悄悄跳过，发布者得当场知道。
 */
function applyAccountGroups(current, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return current
  if (raw.toLowerCase() === 'none') return undefined
  const next = {}
  if (isRecord(current)) {
    for (const role of ACCOUNT_GROUP_ROLES) {
      if (Array.isArray(current[role])) next[role] = current[role].filter((entry) => typeof entry === 'string')
    }
  }
  for (const segment of raw.split(/[;；\n]+/).map((entry) => entry.trim()).filter(Boolean)) {
    const match = segment.match(/^([A-Za-z]+)\s*[=＝]\s*(.*)$/)
    if (!match) throw new StatusInputError(`分组对照要写成「codex=新名字|老名字」，几样之间用分号隔开：${segment}`)
    const role = match[1].toLowerCase()
    if (!ACCOUNT_GROUP_ROLES.includes(role)) {
      throw new StatusInputError(`分组对照只认 ${ACCOUNT_GROUP_ROLES.join(' / ')}：${match[1]}`)
    }
    if (match[2].trim().toLowerCase() === 'none') {
      delete next[role]
      continue
    }
    const names = [...new Set(match[2].split(/[|｜]/).map((entry) => groupName(role, entry)))]
    if (names.length > MAX_GROUP_CANDIDATES) throw new StatusInputError(`${role} 最多写 ${MAX_GROUP_CANDIDATES} 个名字`)
    next[role] = names
  }
  return Object.keys(next).length ? next : undefined
}

function cliModelName(tool, value) {
  const name = value.trim()
  if (!name) throw new StatusInputError(`${tool} 那一项里有空的型号名字（两个 | 挨着了？）`)
  if (!CLI_MODEL_NAME.test(name)) throw new StatusInputError(`型号名字只能用字母、数字和 . _ - : / @ +，最多 128 个字：${name}`)
  return name
}

/**
 * 型号表：「codex.default=gpt-7; codex.previous=gpt-6-astra; codex.retired=gpt-5.5|gpt-6-luna」。
 * default 是新配的工具用哪个型号，previous 是上一代默认（账号还没上新默认时先用它，配置还是它的打开前
 * 问一次要不要换），retired 是两个站都下架了的（开机替客户换成默认）。几个名字用 | 隔开，写到的那一样
 * 整样换掉，没写到的照线上保留；「codex.retired=none」去掉一样，「codex=none」去掉一个工具，整个写 none 清空。
 * 名字写错、彼此矛盾（默认又写进下架）直接报错——客户端遇到会悄悄跳过，发布者得当场知道。
 */
function applyCliModels(current, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return current
  if (raw.toLowerCase() === 'none') return undefined
  const next = {}
  if (isRecord(current)) {
    for (const tool of CLI_MODEL_TOOLS) {
      if (!isRecord(current[tool])) continue
      const entry = {}
      if (typeof current[tool].default === 'string') entry.default = current[tool].default
      for (const field of ['previous', 'retired']) {
        if (Array.isArray(current[tool][field])) entry[field] = current[tool][field].filter((name) => typeof name === 'string')
      }
      next[tool] = entry
    }
  }
  for (const segment of raw.split(/[;；\n]+/).map((entry) => entry.trim()).filter(Boolean)) {
    const match = segment.match(/^([A-Za-z]+)(?:\s*[.。]\s*([A-Za-z]+))?\s*[=＝]\s*(.*)$/)
    if (!match) throw new StatusInputError(`型号表要写成「codex.default=gpt-7」，几样之间用分号隔开：${segment}`)
    const tool = match[1].toLowerCase()
    if (!CLI_MODEL_TOOLS.includes(tool)) throw new StatusInputError(`型号表只认 ${CLI_MODEL_TOOLS.join(' / ')}：${match[1]}`)
    const value = match[3].trim()
    if (match[2] === undefined) {
      if (value.toLowerCase() !== 'none') throw new StatusInputError(`要写明改哪一样（${CLI_MODEL_FIELDS.join(' / ')}），例如「${tool}.default=…」：${segment}`)
      delete next[tool]
      continue
    }
    const field = match[2].toLowerCase()
    if (!CLI_MODEL_FIELDS.includes(field)) throw new StatusInputError(`型号表每个工具只有 ${CLI_MODEL_FIELDS.join(' / ')} 三样：${match[2]}`)
    const entry = next[tool] ?? {}
    next[tool] = entry
    if (value.toLowerCase() === 'none') {
      delete entry[field]
      continue
    }
    const names = [...new Set(value.split(/[|｜]/).map((name) => cliModelName(tool, name)))]
    if (field === 'default') {
      if (names.length !== 1) throw new StatusInputError(`${tool}.default 只能写一个型号：${value}`)
      entry.default = names[0]
      continue
    }
    const limit = field === 'previous' ? MAX_PREVIOUS_CLI_MODELS : MAX_RETIRED_CLI_MODELS
    if (names.length > limit) throw new StatusInputError(`${tool}.${field} 最多写 ${limit} 个型号`)
    entry[field] = names
  }
  for (const tool of Object.keys(next)) {
    const entry = next[tool]
    for (const field of ['previous', 'retired']) {
      if (Array.isArray(entry[field]) && entry[field].length === 0) delete entry[field]
    }
    if (Object.keys(entry).length === 0) {
      delete next[tool]
      continue
    }
    const retired = entry.retired ?? []
    if (entry.default && retired.includes(entry.default)) throw new StatusInputError(`${tool} 的默认型号 ${entry.default} 同时写在下架名单里，客户端会不认这个默认`)
    if (entry.default && (entry.previous ?? []).includes(entry.default)) throw new StatusInputError(`${tool} 的默认型号 ${entry.default} 不用再写进上一代`)
    const both = (entry.previous ?? []).filter((name) => retired.includes(name))
    if (both.length) throw new StatusInputError(`${tool} 的 ${both.join('、')} 既写在上一代又写在下架名单里，二选一`)
  }
  return Object.keys(next).length ? next : undefined
}

/**
 * maintenance: 'on' | 'off' | 'keep'。message / until 只在打开维护时有意义；
 * 关掉维护时整段删掉，下次打开从干净的一段开始。
 */
function applyStatusChanges(current, changes, now = new Date()) {
  const next = { ...current }
  const mode = changes.maintenance ?? 'keep'
  if (!['on', 'off', 'keep'].includes(mode)) throw new StatusInputError(`维护开关只能是 on / off / keep：${mode}`)
  if (mode === 'off') {
    delete next.maintenance
  } else if (mode === 'on') {
    const maintenance = { active: true }
    const message = normalizeMessage(changes.message)
    if (message) maintenance.message = message
    const until = normalizeUntil(changes.until, now)
    if (until) maintenance.until = until
    next.maintenance = maintenance
  } else if (String(changes.message ?? '').trim() || String(changes.until ?? '').trim()) {
    throw new StatusInputError('只有打开维护时才能填说明和结束时间')
  }
  const withdrawals = applyBadVersions(next.badVersions, changes['bad-versions'], next.badVersionPlatforms)
  const badVersions = withdrawals.versions
  if (badVersions === undefined || (Array.isArray(badVersions) && badVersions.length === 0)) delete next.badVersions
  else next.badVersions = badVersions
  if (withdrawals.platforms === undefined || !next.badVersions) delete next.badVersionPlatforms
  else next.badVersionPlatforms = withdrawals.platforms
  const rollout = applyRollout(next.rollout, changes.rollout)
  if (rollout === undefined) delete next.rollout
  else next.rollout = rollout
  const publishedVersions = String(changes['published-versions'] ?? '').split(/\s+/).filter(Boolean)
  // 「0.2.12@mac-x64」只拦 Intel 版的 Mac 包。0.2.19 及以前的客户端不认平台、对所有平台都拦，所以仍要
  // 不高于每个平台正在发的版本，被拦的人才都有新版本可装。
  const minimumInput = splitReleasePlatforms(changes['minimum-version'])
  const minimumVersion = applyMinimumVersion(next.minimumVersion, minimumInput.value, publishedVersions)
  if (minimumVersion === undefined) delete next.minimumVersion
  else next.minimumVersion = minimumVersion
  if (minimumVersion === undefined || (minimumInput.value && !minimumInput.platforms)) delete next.minimumVersionPlatforms
  else if (minimumInput.platforms) next.minimumVersionPlatforms = minimumInput.platforms
  const toolRouteRewrite = changes['tool-route-rewrite'] ?? 'keep'
  if (!['keep', 'targeted', 'merge'].includes(toolRouteRewrite)) throw new StatusInputError(`换线路改配置的方式只能是 keep / targeted / merge：${toolRouteRewrite}`)
  // 缺省就是只改地址（xm 三线路 C9）；只有切回整份重写时才写这个字段，切回来时整个删掉。
  if (toolRouteRewrite === 'targeted') delete next.toolRouteRewrite
  else if (toolRouteRewrite === 'merge') next.toolRouteRewrite = 'merge'
  const accountGroups = applyAccountGroups(next.accountGroups, changes['account-groups'])
  if (accountGroups === undefined) delete next.accountGroups
  else next.accountGroups = accountGroups
  const cliModels = applyCliModels(next.cliModels, changes['cli-models'])
  if (cliModels === undefined) delete next.cliModels
  else next.cliModels = cliModels
  next.updatedAt = now.toISOString()
  const text = `${JSON.stringify(next, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_STATUS_BYTES) throw new StatusInputError('状态文件超过 16 KB，客户端会拒绝读取')
  return next
}

// 0 是手动灰度那一档（docs/SERVICE-STATUS.md「分批放量」）：自动检查一个都不推，
// 「先给 0% 的电脑」读起来像没生效，日志里直接说清谁拿得到。
function summarizeRollout(rollout) {
  if (rollout.percent === 0) return `${rollout.version} 先不自动推，只给自己点「检查更新」的人`
  return `${rollout.version} 先给 ${rollout.percent}% 的电脑`
}

function describeRollout(rollout) {
  if (!isRecord(rollout)) return '分批放量：无（新版本全部放开）'
  const platforms = validReleasePlatforms(rollout.platforms)
  const scope = platforms ? `（只管 ${describePlatforms(platforms)}，别的全放；${PLATFORM_AWARE_CLIENT} 以前的客户端不认平台，对所有平台分批）` : ''
  return `分批放量：${summarizeRollout(rollout)}${scope}`
}

function describeBadVersions(status) {
  if (!Array.isArray(status.badVersions) || status.badVersions.length === 0) return '撤回的版本：无'
  const scoped = isRecord(status.badVersionPlatforms) ? status.badVersionPlatforms : {}
  let any = false
  const parts = status.badVersions.map((version) => {
    const platforms = Object.hasOwn(scoped, version) ? validReleasePlatforms(scoped[version]) : null
    if (!platforms) return version
    any = true
    return `${version}（只撤 ${describePlatforms(platforms)}）`
  })
  return `撤回的版本：${parts.join('、')}${any ? `（${PLATFORM_AWARE_CLIENT} 以前的客户端不认平台，照旧整版撤回）` : ''}`
}

function describeMinimumVersion(status) {
  if (typeof status.minimumVersion !== 'string') return '最低版本：无'
  const platforms = validReleasePlatforms(status.minimumVersionPlatforms)
  const scope = platforms ? `；只拦 ${describePlatforms(platforms)}，${PLATFORM_AWARE_CLIENT} 以前的客户端不认平台，对所有平台都拦` : ''
  return `最低版本：${status.minimumVersion}（更低的必须先更新，只有 0.2.11 及以后的客户端认${scope}）`
}

function describeAccountGroups(groups) {
  const roles = isRecord(groups) ? ACCOUNT_GROUP_ROLES.filter((role) => Array.isArray(groups[role]) && groups[role].length) : []
  if (roles.length === 0) return '分组对照：无（客户端按写死的名字认）'
  const parts = roles.map((role) => `${ACCOUNT_GROUP_LABELS[role]} 用「${groups[role].join('」，没有再用「')}」`)
  return `分组对照：${parts.join('；')}（只有 0.2.19 及以后的客户端认）`
}

function describeCliModels(models) {
  const tools = isRecord(models) ? CLI_MODEL_TOOLS.filter((tool) => isRecord(models[tool])) : []
  if (tools.length === 0) return '型号表：无（客户端用程序自带的）'
  const parts = tools.map((tool) => {
    const entry = models[tool]
    const fields = []
    if (typeof entry.default === 'string') fields.push(`默认 ${entry.default}`)
    if (Array.isArray(entry.previous) && entry.previous.length) fields.push(`上一代 ${entry.previous.join('、')}`)
    if (Array.isArray(entry.retired) && entry.retired.length) fields.push(`已下架 ${entry.retired.join('、')}`)
    return `${CLI_MODEL_TOOL_LABELS[tool]} ${fields.join('，')}`
  })
  return `型号表：${parts.join('；')}（没写的照程序自带的，只有 0.2.20 及以后的客户端认）`
}

function describeStatus(status) {
  const lines = []
  const maintenance = isRecord(status.maintenance) && status.maintenance.active === true ? status.maintenance : null
  lines.push(maintenance ? `维护：打开${maintenance.message ? `，说明「${maintenance.message}」` : ''}${maintenance.until ? `，${maintenance.until} 自动结束` : ''}` : '维护：关闭')
  lines.push(describeBadVersions(status))
  lines.push(describeRollout(status.rollout))
  lines.push(describeMinimumVersion(status))
  lines.push(status.toolRouteRewrite === 'merge' ? '换线路时：整份重写工具配置（老办法，只有 0.2.18 及以后的客户端认）' : '换线路时：只改工具配置里的地址')
  lines.push(describeCliModels(status.cliModels))
  lines.push(describeAccountGroups(status.accountGroups))
  return lines
}

/**
 * 工作流读更新清单时顺带交来的出包时间：「0.2.19=2026-10-16T18:40:00.000Z 0.2.19=…」，取自各平台
 * latest*.yml 的 releaseDate。同一版本有几份取最新的那份。只用来提醒，读不懂的那一项跳过、不报错。
 */
function parsePublishedDates(input) {
  const dates = new Map()
  for (const token of String(input ?? '').split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf('=')
    if (separator <= 0) continue
    const version = token.slice(0, separator).replace(/^v/i, '')
    const time = Date.parse(token.slice(separator + 1))
    if (!PLAIN_VERSION.test(version) || !Number.isFinite(time)) continue
    dates.set(version, Math.max(dates.get(version) ?? time, time))
  }
  return dates
}

/**
 * #1114：两种改法照样放行，只是多打一行醒目提示，让批准的人看清自己批的是什么。0.2.19 那次一次运行
 * 就清掉了「先给两成」、又把最低版本抬到发出去 12 分钟的版本，所有低于它的电脑当天都被强制更新。
 * 服务端先改了、旧版本已经不能用的时候这样做是对的（docs/RELEASING.md），所以不拦。
 * 只看这次真改了最低版本的运行：原样重填一遍，客户那边什么都不变。
 */
function describeStatusWarnings(current, next, changes, now = new Date()) {
  const minimum = next.minimumVersion
  if (typeof minimum !== 'string' || minimum === current.minimumVersion) return []
  const warnings = []
  const releasedAt = parsePublishedDates(changes['published-dates']).get(minimum)
  if (releasedAt !== undefined && now.getTime() - releasedAt < FRESH_RELEASE_MS) {
    const hours = Math.floor((now.getTime() - releasedAt) / (60 * 60 * 1000))
    const age = hours < 1 ? '还不到 1 小时' : `才 ${hours} 小时`
    warnings.push(`最低版本 ${minimum} 的包出来${age}（按更新清单里的出包时间算），还没在客户手里跑满一天。批下去以后，低于它的电脑（0.2.11 及以后）都会被拦着先更新，关了自动更新的也一样；这一版要是有问题，分批放量也停不住，只能撤回。服务端已经先改了、照 docs/RELEASING.md「服务端已经先改了、旧版本不能用了」那几步在测试电脑上演过的，可以批；不然先 Reject，等它跑满一天再设。`)
  }
  const removed = current.rollout
  if (isRecord(removed) && next.rollout === undefined && typeof removed.version === 'string' && typeof removed.percent === 'number' && removed.percent < 100) {
    warnings.push(`这一次把分批放量（原来是「${summarizeRollout(removed)}」）清掉、全部放开，同时又把最低版本设成 ${minimum}：新版本一次就到所有人手上，分批观察这一步等于跳过。不是非这样不可的，先 Reject，分两次跑：先放开观察，再设最低版本。`)
  }
  return warnings
}

// GitHub 的工作流命令按行解析，这几个字符要转义，否则「20%」这类内容可能被吃掉。
function escapeWorkflowCommand(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/**
 * 预览作业写进运行页面的摘要。service-status 每次都要在 release 环境点批准，而批准发生在发布作业
 * 开跑之前：只打在发布作业里的提示，批的人点下去以后才看得到。预览不碰凭据、不写线上，先跑完，
 * 批的人在同一个页面上看到「批了以后线上是什么样」和提示，再决定批不批。
 */
function buildApprovalSummary(lines, warnings) {
  const parts = ['### 批准以后，线上的状态文件会是这样', '']
  for (const line of lines) parts.push(`- ${line}`)
  parts.push('', '按现在线上那一份算的。批之前要是别的运行改过它，发布时会照改过的重算一遍。')
  if (warnings.length) {
    parts.push('', '#### ⚠️ 批之前看一眼', '')
    for (const warning of warnings) parts.push(`- ${warning}`)
  }
  return `${parts.join('\n')}\n`
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flag.startsWith('--')) throw new StatusInputError(`不认识的参数：${flag}`)
    const value = argv[index + 1]
    if (value === undefined) throw new StatusInputError(`${flag} 缺少取值`)
    options[flag.slice(2)] = value
    index += 1
  }
  return options
}

function main(argv) {
  const options = parseArguments(argv)
  if (!options.current || !options.output) throw new StatusInputError('用法：service-status.cjs --current <file> --output <file> [--maintenance on|off|keep] [--message …] [--until …] [--bad-versions …] [--rollout …] [--minimum-version …] [--published-versions …] [--published-dates …] [--tool-route-rewrite keep|targeted|merge] [--account-groups …] [--cli-models …] [--summary <file>]')
  // 工作流只在线上返回 404 时删掉这个文件；文件在就必须读得懂。
  const currentText = fs.existsSync(options.current) ? fs.readFileSync(options.current, 'utf8') : null
  const now = new Date()
  const current = parseCurrentStatus(currentText)
  const next = applyStatusChanges(current, options, now)
  fs.writeFileSync(options.output, `${JSON.stringify(next, null, 2)}\n`)
  const lines = describeStatus(next)
  for (const line of lines) console.log(line)
  const warnings = describeStatusWarnings(current, next, options, now)
  for (const warning of warnings) console.log(`::warning::${escapeWorkflowCommand(warning)}`)
  if (options.summary) fs.appendFileSync(options.summary, buildApprovalSummary(lines, warnings))
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = { StatusInputError, applyAccountGroups, applyBadVersions, applyCliModels, applyMinimumVersion, applyRollout, applyStatusChanges, buildApprovalSummary, describeStatus, describeStatusWarnings, escapeWorkflowCommand, normalizeMessage, normalizeUntil, parseCurrentStatus, parsePublishedDates }
