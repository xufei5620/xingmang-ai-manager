#!/usr/bin/env node
// 发版时的分批放量（商业级差距报告 G02 第 1 步）：publish-release 触发时选「上传以后先推给多少」，
// 发布作业在换更新清单之前把它写进 service-status.json。
//
// 原来放量是另一条工作流（service-status），要人记着在触发发版之前先跑一次；0.2.20、0.2.21 都忘了，
// 等于全量发（10-27 遗漏盘点第 1 条）。现在比例是发版本身的一项输入，默认两成，写入和换清单在同一个
// 作业里、按先后两步走，顺序由工作流保证，不靠人记。
//
// 晚几秒写、不提前几小时写也够：0.2.19 起客户端每次检查更新都先重读一遍状态文件再读清单
// （electron/updater.ts 的 check），写完、核对客户读得到以后才换清单，换完以后来检查的都先看到放量。
//
// 这个脚本有两处用：
// - release-tag 作业（批准之前、不装依赖）用 describe 把这次选的比例写到运行页面上，批的人两次批准
//   之前都看得到；
// - publish 作业用 plan 算出要不要改状态文件、改成什么，真要改时写出新文件，交给工作流上传。
const fs = require('node:fs')
const path = require('node:path')
// update-release-utils.cjs 顶层不引第三方包（yaml 到 parseLatestMetadata 真用时才加载），release-tag 作业只跑
// describe、不装依赖也能 require 这个脚本。
const { UPDATE_MANIFEST_NAMES, compareReleaseVersions, parseLatestMetadata } = require('./update-release-utils.cjs')
const { StatusInputError, applyStatusChanges, describeStatus, parseCurrentStatus } = require('./service-status.cjs')

const PLAIN_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/
// 每份清单是哪个平台的，写法与 service-status.cjs 的平台表一致（只对这几种安装包分批时用）。
const MANIFEST_PLATFORMS = {
  'latest.yml': 'windows',
  'latest-mac.yml': 'mac',
  'latest-linux.yml': 'linux',
  'latest-linux-arm64.yml': 'linux',
}

class RolloutInputError extends Error {}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 工作流的选项写成「20: 先推给两成电脑（平时都选这个）」，冒号前面是百分比。也收只写数字的
 * （从接口触发时）。0 是「先不自动推」，100 是全部放开。
 */
function parseRolloutChoice(value) {
  const raw = String(value ?? '').trim()
  const match = /^(\d{1,3})\s*%?(?:\s*[:：].*)?$/s.exec(raw)
  const percent = match ? Number(match[1]) : Number.NaN
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RolloutInputError(`「上传以后先推给多少」要选一个 0 到 100 的比例：${raw || '（空）'}`)
  }
  return percent
}

function plainVersion(value) {
  const version = String(value ?? '').trim().replace(/^v/i, '')
  if (!PLAIN_VERSION.test(version)) throw new RolloutInputError(`版本号要写成 0.2.23 这样：${value}`)
  return version
}

function describePercent(percent) {
  if (percent >= 100) return '全部放开，所有自动检查更新的电脑都会拿到'
  if (percent === 0) return '先不自动推，只给自己点「检查更新」的人'
  return `先自动推给 ${percent}% 的电脑，哪几台是固定的；自己点「检查更新」的不受限`
}

/**
 * release-tag 作业写到运行页面上的一段。批的人第一次批准（Mac 出包）和第二次批准（上传）之前都看得到。
 * 选了 100 另给一条黄色提示：那是快修通道里客户正卡着才用的，平时选了等于跳过分批。
 */
function describeRolloutChoice(version, percent) {
  const lines = [
    '### 上传以后先推给多少',
    '',
    `- ${plainVersion(version)}：${describePercent(percent)}。`,
  ]
  let warning = null
  if (percent >= 100) {
    warning = '这次选了「100：全部放开」：上传一完成，所有自动检查更新的电脑都会拿到这一版，没有先放两成观察这一步。只有快修通道里客户正卡着、要强制更新的才这样发（docs/RELEASING.md「热修版本」）；不是的话，取消这次运行，重新触发时选 20。'
  } else {
    lines.push('- 发布作业在换更新清单之前写好，第二天中午 rollout-health 会给出「放开还是停住」的建议；放开要再跑一次 service-status，「分批放量」填 `none`。')
  }
  if (warning) lines.push('', `> ⚠️ ${warning}`)
  return { lines, warning }
}

function readLiveVersions(directory) {
  const live = new Map()
  if (!directory) return live
  for (const name of UPDATE_MANIFEST_NAMES) {
    const file = path.join(directory, name)
    if (!fs.existsSync(file)) continue
    live.set(name, String(parseLatestMetadata(fs.readFileSync(file, 'utf8'), name).version).trim().replace(/^v/i, ''))
  }
  return live
}

function publishingManifests(directory) {
  const names = UPDATE_MANIFEST_NAMES.filter((name) => fs.existsSync(path.join(directory, name)))
  if (names.length === 0) throw new RolloutInputError('产物里没有任何更新清单，不知道这次发哪些平台，线上什么都没改')
  return names
}

function rolloutOf(status) {
  const rollout = status.rollout
  if (!isRecord(rollout) || typeof rollout.version !== 'string' || typeof rollout.percent !== 'number') return null
  return rollout
}

function sameVersion(left, right) {
  try {
    return compareReleaseVersions(String(left).trim().replace(/^v/i, ''), right) === 0
  } catch {
    return false
  }
}

/**
 * 算这次发布要把状态文件里的分批放量改成什么，返回 { input, message }。input 是交给 service-status.cjs
 * 的「分批放量」写法（「0.2.23 20」「none」「0.2.23 20@linux」），null 表示状态文件不用动。
 *
 * - 这次要发的清单线上全都已经是这个版本：同一次发布被重跑（Re-run failed jobs）。放量照线上不动：
 *   这期间可能已经有人填过 0 停住，重跑一次收尾不能又把它放回两成。
 * - 这个版本哪个平台都还没发出去：照这次选的写。线上要是已经有这一版的放量（以前的做法是发布之前先跑
 *   service-status，或者上一次触发写了、没发出去就取消了），也换成这次选的：批的人看着这次的选项批的。
 *   选 100 就清掉放量（线上本来没有就不动）。
 * - 别的平台已经发出去了、这次补发一个平台：线上有这一版的放量，就照它走、不改（可能正停着）；没有
 *   （已经全部放开了），就只对这次新发的平台分批，已经全放的平台不受影响。
 */
function planReleaseRollout({ version, percent, current = {}, publishing, live }) {
  const target = plainVersion(version)
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RolloutInputError(`放量比例要在 0 到 100 之间：${percent}`)
  if (!Array.isArray(publishing) || publishing.length === 0) throw new RolloutInputError('不知道这次发哪些平台，线上什么都没改')
  const isLive = (name) => live.has(name) && sameVersion(live.get(name), target)
  const existing = rolloutOf(current)
  const existingForTarget = existing && sameVersion(existing.version, target) ? existing : null
  const currentLine = describeStatus(current).find((line) => line.startsWith('分批放量'))
  if (publishing.every(isLive)) {
    return { input: null, message: `这次要发的清单线上已经都是 ${target}（同一次发布重跑），分批放量照线上不动。现在线上的${currentLine}` }
  }
  if (!UPDATE_MANIFEST_NAMES.some(isLive)) {
    if (percent < 100) return { input: `${target} ${percent}`, message: `分批放量写成「${target} ${percent}」：${describePercent(percent)}` }
    if (!existing) return { input: null, message: '这次选了全部放开，线上本来就没有分批放量，状态文件不用改' }
    return { input: 'none', message: `这次选了全部放开，清掉线上原来的${currentLine}` }
  }
  if (existingForTarget) {
    return { input: null, message: `${target} 已经有平台发出去了，这次补发的平台照线上的放量走，不改。现在线上的${currentLine}` }
  }
  if (percent >= 100) return { input: null, message: `${target} 已经有平台发出去、也已经全部放开了，这次补发的平台照样全部放开，状态文件不用改` }
  const platforms = [...new Set(publishing.filter((name) => !isLive(name)).map((name) => MANIFEST_PLATFORMS[name]))]
  return {
    input: `${target} ${percent}@${platforms.join('|')}`,
    message: `${target} 已经有平台发出去、全部放开了；分批放量只管这次新发的 ${platforms.join('、')}，写成「${target} ${percent}@${platforms.join('|')}」，已经发出去的平台不受影响`,
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    if (!flag.startsWith('--') || rest[index + 1] === undefined) throw new RolloutInputError(`参数不对：${flag}`)
    options[flag.slice(2)] = rest[index + 1]
  }
  return { command, options }
}

function main(argv) {
  const { command, options } = parseArguments(argv)
  if (command === 'describe') {
    const { lines, warning } = describeRolloutChoice(options.version, parseRolloutChoice(options.rollout))
    if (warning) console.log(`::warning::${warning}`)
    if (options.summary) fs.appendFileSync(options.summary, `${lines.join('\n')}\n`)
    else console.log(lines.join('\n'))
    return
  }
  if (command === 'plan') {
    if (!options.version || !options.artifacts || !options.current || !options.output) {
      throw new RolloutInputError('用法：release-rollout.cjs plan --version <版本> --rollout <比例> --artifacts <产物目录> --live <线上清单目录> --current <状态文件> --output <新状态文件> [--summary <file>]')
    }
    // 工作流只在线上返回 404 时删掉这个文件；文件在就必须读得懂，读不懂就停在换清单之前。
    const currentText = fs.existsSync(options.current) ? fs.readFileSync(options.current, 'utf8') : null
    const current = parseCurrentStatus(currentText)
    const plan = planReleaseRollout({
      version: options.version,
      percent: parseRolloutChoice(options.rollout),
      current,
      publishing: publishingManifests(options.artifacts),
      live: readLiveVersions(options.live),
    })
    console.log(plan.message)
    if (options.summary) fs.appendFileSync(options.summary, `### 分批放量\n\n${plan.message}\n`)
    if (plan.input === null) return
    const next = applyStatusChanges(current, { rollout: plan.input })
    fs.writeFileSync(options.output, `${JSON.stringify(next, null, 2)}\n`)
    for (const line of describeStatus(next)) console.log(line)
    return
  }
  throw new RolloutInputError('用法：release-rollout.cjs describe|plan …')
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const known = error instanceof RolloutInputError || error instanceof StatusInputError || error?.name === 'ReleaseValidationError'
    console.error(`::error::${known ? error.message : '算分批放量时脚本自身出错，线上什么都没改，看上面的日志'}`)
    if (!known) console.error(error)
    process.exit(1)
  }
}

module.exports = { RolloutInputError, describeRolloutChoice, parseRolloutChoice, planReleaseRollout }
