#!/usr/bin/env node
// 生成更新目录上的 service-status.json（客户端读法见 electron/service-status.ts，
// 格式与操作步骤见 docs/SERVICE-STATUS.md）。
//
// 这个脚本只在 GitHub Actions 的 service-status 工作流里跑：先取回线上现有的
// 那一份，只改这次填了的字段，其余原样保留，再把结果交给工作流上传。「留空 =
// 不改」是有意的：发布者只想关掉维护时，不该顺手把别的开关一起抹掉。
const fs = require('node:fs')

const MAX_MESSAGE_LENGTH = 200
const MAX_STATUS_BYTES = 16 * 1024

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

/**
 * 撤回名单只加不减：一个版本撤回之后，还停在它上面的人随时可能来检查更新，名单
 * 上少了它，那些人就退不回去了。真要移除写「-0.2.10」，清空写 none。
 */
function applyBadVersions(current, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return current
  if (raw.toLowerCase() === 'none') return []
  const versions = new Set(Array.isArray(current) ? current.filter((entry) => typeof entry === 'string') : [])
  for (const token of raw.split(/[\s,，]+/).filter(Boolean)) {
    if (token.startsWith('-')) versions.delete(plainVersion(token.slice(1)))
    else versions.add(plainVersion(token))
  }
  return [...versions]
}

/** 「0.2.11 20」或「0.2.11 20%」= 0.2.11 先给两成电脑；none = 取消分批，全部放开。 */
function applyRollout(current, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return current
  if (raw.toLowerCase() === 'none') return undefined
  const match = raw.match(/^v?(\S+)\s+(\d{1,3})\s*%?$/)
  if (!match) throw new StatusInputError(`分批放量要写成「0.2.11 20」（版本号 空格 百分比）：${raw}`)
  const percent = Number(match[2])
  if (percent > 100) throw new StatusInputError(`百分比最多 100：${raw}`)
  return { version: plainVersion(match[1]), percent }
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
  const badVersions = applyBadVersions(next.badVersions, changes['bad-versions'])
  if (badVersions === undefined || (Array.isArray(badVersions) && badVersions.length === 0)) delete next.badVersions
  else next.badVersions = badVersions
  const rollout = applyRollout(next.rollout, changes.rollout)
  if (rollout === undefined) delete next.rollout
  else next.rollout = rollout
  next.updatedAt = now.toISOString()
  const text = `${JSON.stringify(next, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_STATUS_BYTES) throw new StatusInputError('状态文件超过 16 KB，客户端会拒绝读取')
  return next
}

function describeStatus(status) {
  const lines = []
  const maintenance = isRecord(status.maintenance) && status.maintenance.active === true ? status.maintenance : null
  lines.push(maintenance ? `维护：打开${maintenance.message ? `，说明「${maintenance.message}」` : ''}${maintenance.until ? `，${maintenance.until} 自动结束` : ''}` : '维护：关闭')
  lines.push(Array.isArray(status.badVersions) && status.badVersions.length ? `撤回的版本：${status.badVersions.join('、')}` : '撤回的版本：无')
  lines.push(isRecord(status.rollout) ? `分批放量：${status.rollout.version} 先给 ${status.rollout.percent}% 的电脑` : '分批放量：无（新版本全部放开）')
  return lines
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
  if (!options.current || !options.output) throw new StatusInputError('用法：service-status.cjs --current <file> --output <file> [--maintenance on|off|keep] [--message …] [--until …] [--bad-versions …] [--rollout …]')
  // 工作流只在线上返回 404 时删掉这个文件；文件在就必须读得懂。
  const currentText = fs.existsSync(options.current) ? fs.readFileSync(options.current, 'utf8') : null
  const next = applyStatusChanges(parseCurrentStatus(currentText), options)
  fs.writeFileSync(options.output, `${JSON.stringify(next, null, 2)}\n`)
  for (const line of describeStatus(next)) console.log(line)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = { StatusInputError, applyBadVersions, applyRollout, applyStatusChanges, describeStatus, normalizeMessage, normalizeUntil, parseCurrentStatus }
