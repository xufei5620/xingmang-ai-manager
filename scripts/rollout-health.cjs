#!/usr/bin/env node
// 放量体检（商业级差距报告 G02 第 2 步）：正在分批放量时，拿新版本和其余版本的每天打卡比一比，出一句
// 「建议放开 / 建议停住 / 再等等」。只在 GitHub Actions 的 rollout-health 工作流里跑，怎么用见
// docs/RELEASING.md「分批放量」。
//
// 做法照谷歌 SRE 的金丝雀：同一段时间里，拿到新版的那一小批（金丝雀）和还在旧版的其余电脑（对照）
// 比出错率，新版明显更差就停下交给人判断。数据是每天打卡（electron/usage-stats.ts，0.2.23 起），从
// update-feed-stats.cjs 借查询和解码；打卡不带电脑编号，一天一条就是一台电脑。
//
// 为什么每天中午跑、不跟早上 6:17 的版本统计一起：打卡按 UTC 分天、一天只发一次。新版装上的那天，电脑
// 早上多半已经用旧版发过当天那条了，新版这一天出的错要到第二天北京时间 8 点以后打开时才发出来。早上 6:17
// 正好赶在这之前，几乎看不到新版的打卡；中午时上午开过机的电脑都发过了。
//
// 只给建议，不动线上：放开、停住都要产品所有者在 service-status 那里批一次。
//
// 仓库公开，运行页谁都能看，所以和版本统计一样只写每 100 台·天几次和「样本够不够」，不写台数。
const fs = require('node:fs')
const { compareReleaseVersions } = require('./update-release-utils.cjs')
const { StatusInputError, parseCurrentStatus, parsePublishedDates } = require('./service-status.cjs')
const { StatsError, collectUsageSince } = require('./update-feed-stats.cjs')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
// 发出去不满这么久不建议放开：上面说的打卡要隔天才到，满 20 小时才覆盖到第二天上午开机的那一批。
const MIN_OBSERVATION_HOURS = 20
// 样本一直攒不够（客户少、放量比例小）时，满两天、又没看出问题就照样建议放开，只是写明只能粗看：
// 一直等下去，分批就成了不发。
const LONG_OBSERVATION_HOURS = 44
// 新版的打卡加起来不到这么多台·天时只算「样本少」；对照组也要这么多才拿来比。和版本统计的 SMALL_SAMPLE 一致。
const MIN_MACHINE_DAYS = 20
// 放量挂了很久没放开时只看最近这几天，Cloudflare 也只留这么久左右。
const MAX_WINDOW_DAYS = 7
// 新版比对照差到两倍以上、每 100 台·天多出 2 次以上、新版自己出过至少 3 次，才算明显变差：
// 单台电脑反复出错、或者一两次的波动，不该让一整版停下。
const RELATIVE_FACTOR = 2
const MIN_RATE_GAP = 2
const MIN_EVENTS = 3
// 没有可比的对照时（0.2.23 是第一版打卡的，它的上一版不发）只拦明摆着坏掉的：
// 每 10 台电脑一天就有 1 次闪退。
const CRASH_CEILING = 10
// 下好了新版、试着装过还停在旧版的，占「试过的」两成以上算装不上。
const INSTALL_FAILURE_SHARE = 0.2

function countOf(items, codes) {
  return items.reduce((sum, item) => sum + (codes.includes(item.code) ? item.count : 0), 0)
}

function totalOf(items) {
  return items.reduce((sum, item) => sum + item.count, 0)
}

// 比的几样都是新版本身出不出问题。「星芒更新出错」不比：对照组那边正在往新版升，升不上去算在它头上，
// 两边不对等；升新版升不上去单独看下面的 installFailures。
const METRICS = [
  { id: 'crash', label: '意外退出（闪退）', count: (record) => countOf(record.hangs, ['e']) },
  { id: 'freeze', label: '卡住（窗口没响应、整个界面卡 2 秒以上）', count: (record) => countOf(record.hangs, ['w', 's']) },
  { id: 'payment', label: '付款页没打开', count: (record) => countOf(record.hangs, ['pf']) },
  { id: 'tools', label: '装工具失败', count: (record) => totalOf(record.installs) },
]
const SCOPES = [['all', '合计'], ['windows', 'Windows'], ['mac', 'Mac'], ['linux', 'Linux']]

class RolloutHealthError extends Error {}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeVersion(value) {
  return typeof value === 'string' ? value.trim().replace(/^v/i, '') : ''
}

function compareVersions(left, right) {
  try {
    return compareReleaseVersions(left, right)
  } catch {
    return null
  }
}

/**
 * 线上状态文件里正在进行的分批放量；没有、版本号读不懂、或者已经是 100（等于全放）时是 null。
 * 只管某几种安装包的（「@linux」这类）照样体检，平台表只拿来写在结论里。
 */
function readActiveRollout(status) {
  const rollout = isRecord(status) ? status.rollout : null
  if (!isRecord(rollout) || typeof rollout.percent !== 'number' || !Number.isFinite(rollout.percent)) return null
  const version = normalizeVersion(rollout.version)
  // 自己跟自己比不出 0 就是读不懂的版本号。
  if (compareVersions(version, version) !== 0 || rollout.percent >= 100) return null
  const platforms = Array.isArray(rollout.platforms) ? rollout.platforms.filter((name) => typeof name === 'string') : []
  return { version, percent: Math.max(0, rollout.percent), ...(platforms.length ? { platforms } : {}) }
}

function sumWeights(records) {
  return records.reduce((sum, record) => sum + record.weight, 0)
}

function measure(records, metric) {
  const machineDays = sumWeights(records)
  const events = records.reduce((sum, record) => sum + metric.count(record) * record.weight, 0)
  return { machineDays, events, rate: machineDays > 0 ? events * 100 / machineDays : null }
}

/**
 * 对照组电脑里，下好了新版、试着装过还停在旧版的（打卡里「新版装上没有」是 ff~新版本号）占「试过的」多少。
 * 试过的 = 这些 + 已经在新版上打卡的。新装的客户也算进后者，只会让比例偏低一点。对照组都不打卡
 * （上一版早于 0.2.23）时看不出，是 null。
 */
function measureInstallFailures(newRecords, baselineRecords, version) {
  const failed = sumWeights(baselineRecords.filter((record) => record.update.state === 'ff' && record.update.version === version))
  const tried = failed + sumWeights(newRecords)
  if (sumWeights(baselineRecords) === 0) return { failed, tried, share: null }
  return { failed, tried, share: tried > 0 ? failed / tried : null }
}

function formatRate(value) {
  return value === null ? '-' : value.toFixed(1)
}

function formatHours(hours) {
  return hours < 1 ? '不到 1' : String(Math.floor(hours))
}

/**
 * 体检本身，纯函数。records 是 update-feed-stats.cjs 的 summarizeUsage 认出来的打卡（带 weight）；
 * releasedAt 是新版发出去的时刻（毫秒），approximate 表示只知道出包时间、实际发出去可能更晚。
 * 返回 { verdict, rollout, headline, reasons, notes, table }，verdict 是 open / stop / wait / unknown。
 */
function assessRolloutHealth({ rollout, releasedAt, approximate = false, records, now }) {
  const version = rollout.version
  const hours = (now.getTime() - releasedAt) / HOUR_MS
  const newRecords = records.filter((record) => record.app === version)
  const baselineRecords = records.filter((record) => record.app !== null && compareVersions(record.app, version) === -1)
  const scopes = SCOPES.filter(([id]) => id === 'all' || newRecords.some((record) => record.platform === id))
  const reasons = []
  const table = []
  let comparable = false
  for (const [id, label] of scopes) {
    const scopeNew = id === 'all' ? newRecords : newRecords.filter((record) => record.platform === id)
    const scopeBase = id === 'all' ? baselineRecords : baselineRecords.filter((record) => record.platform === id)
    const newDays = sumWeights(scopeNew)
    const baseDays = sumWeights(scopeBase)
    const enoughNew = newDays >= MIN_MACHINE_DAYS
    const enoughBase = baseDays >= MIN_MACHINE_DAYS
    if (id === 'all' && enoughBase) comparable = true
    const where = id === 'all' ? '' : `${label} 上`
    const rows = []
    for (const metric of METRICS) {
      const fresh = measure(scopeNew, metric)
      const base = measure(scopeBase, metric)
      rows.push({ id: metric.id, label: metric.label, fresh: fresh.rate, base: base.rate })
      if (!enoughNew || fresh.events < MIN_EVENTS) continue
      if (enoughBase) {
        if (fresh.rate >= base.rate * RELATIVE_FACTOR && fresh.rate - base.rate >= MIN_RATE_GAP) {
          reasons.push(`${where}${metric.label}：新版每 100 台·天 ${formatRate(fresh.rate)} 次，还在旧版的 ${formatRate(base.rate)} 次`)
        }
      } else if (metric.id === 'crash' && fresh.rate >= CRASH_CEILING) {
        reasons.push(`${where}${metric.label}：新版每 100 台·天 ${formatRate(fresh.rate)} 次，平均每 10 台电脑一天就闪退一次以上`)
      }
    }
    const install = measureInstallFailures(scopeNew, scopeBase, version)
    if (install.share !== null && install.tried >= MIN_MACHINE_DAYS && install.failed >= MIN_EVENTS && install.share >= INSTALL_FAILURE_SHARE) {
      reasons.push(`${where}升新版没装上：下好了新版、试着装过的电脑里 ${(install.share * 100).toFixed(0)}% 还停在旧版`)
    }
    table.push({ id, label, enoughNew, enoughBase, rows, installShare: install.share })
  }
  const newDays = sumWeights(newRecords)
  const notes = []
  if (approximate) notes.push('查不到 GitHub 上这一版的发布时间，「发出去多久」按更新清单里的出包时间算，实际发出去可能更晚。')
  if (!comparable) notes.push('没有可比的对照：还在旧版的电脑打卡太少，或者它们的版本早于 0.2.23、本来就不打卡（0.2.23 自己放量时就是这样）。这次只看了新版自己有没有明摆着坏掉。')
  if (rollout.percent === 0) notes.push('现在是停住的（只给自己点「检查更新」的人），新版的样本会比平时少。')
  let verdict
  let headline
  if (reasons.length) {
    verdict = 'stop'
    headline = `建议停住 ${version}：${reasons.join('；')}。`
  } else if (newDays === 0 && hours >= LONG_OBSERVATION_HOURS) {
    verdict = 'unknown'
    headline = `看不出 ${version} 稳不稳：发出去 ${formatHours(hours)} 小时，新版一条打卡都没收到。照老办法看客服群和反馈报告再定。`
  } else if (hours < MIN_OBSERVATION_HOURS) {
    verdict = 'wait'
    headline = `再等等，${version} 先不放开：发出去才 ${formatHours(hours)} 小时，新版装上那天的问题要第二天上午才报上来，满 ${MIN_OBSERVATION_HOURS} 小时再看。`
  } else if (newDays < MIN_MACHINE_DAYS && hours < LONG_OBSERVATION_HOURS) {
    verdict = 'wait'
    headline = `再等等，${version} 先不放开：发出去 ${formatHours(hours)} 小时，新版的打卡还不到 ${MIN_MACHINE_DAYS} 台·天，看不准。`
  } else {
    verdict = 'open'
    headline = `建议放开 ${version}：发出去 ${formatHours(hours)} 小时，${comparable ? '和还在旧版的电脑比' : '只看新版自己'}，闪退、卡住、付款页、装工具都没有明显变差${newDays < MIN_MACHINE_DAYS ? '（样本少，只能粗看）' : ''}。`
  }
  return { verdict, rollout, hours, headline, reasons, notes, table }
}

const NEXT_STEPS = {
  open: (version) => `要放开就跑一次 **service-status**，「分批放量」填 \`none\`，批一次（docs/RELEASING.md「分批放量」）。不急的话也可以再看一天，${version} 照现在的比例继续推。`,
  stop: (version) => `先跑一次 **service-status**，「分批放量」填 \`${version} 0\` 停住：自动检查一个都不推，已经装上的不受影响。再照 docs/RELEASING.md 第 8 节看要不要撤回或退回。`,
  wait: () => '不用动，明天中午这一次会再看。',
  unknown: () => '看看每天打卡是不是整个没收到（update-feed-stats 最后一节）：都没有的话是打卡出了问题，不是这一版的问题。',
}
const VERDICT_TITLES = { open: '建议放开', stop: '建议停住', wait: '再等等', unknown: '看不出' }

function renderTable(table) {
  const columns = table.flatMap((scope) => [[scope, 'fresh', `${scope.label} 新版`], [scope, 'base', `${scope.label} 还在旧版`]])
  const lines = [
    `| 每 100 台·天几次 | ${columns.map(([, , title]) => title).join(' | ')} |`,
    `|---|${columns.map(() => '---:').join('|')}|`,
  ]
  for (const [index, metric] of METRICS.entries()) {
    lines.push(`| ${metric.label} | ${columns.map(([scope, side]) => formatRate(scope.rows[index][side])).join(' | ')} |`)
  }
  lines.push(`| 样本 | ${columns.map(([scope, side]) => ((side === 'fresh' ? scope.enoughNew : scope.enoughBase) ? '够' : `不到 ${MIN_MACHINE_DAYS} 台·天`)).join(' | ')} |`)
  const installs = table.filter((scope) => scope.installShare !== null).map((scope) => `${scope.label} ${(scope.installShare * 100).toFixed(1)}%`)
  lines.push('', `- **升新版没装上**（下好了新版、试着装过还停在旧版的，占试过的比例）：${installs.length ? installs.join('、') : '看不出（还在旧版的电脑不打卡）'}`)
  return lines
}

/** 写到运行摘要页的一节。第一行是一句话结论，早上的日汇总和巡检照抄它。 */
function renderRolloutHealth(result, checkedAt) {
  const time = new Date(checkedAt.getTime() + 8 * HOUR_MS).toISOString().slice(5, 16).replace('T', ' ')
  if (result.verdict === 'none') return `**放量体检（北京时间 ${time}）：${result.headline}**\n`
  const lines = [
    `**放量体检（北京时间 ${time}）：${VERDICT_TITLES[result.verdict]}。** ${result.headline}`,
    '',
    `现在线上：${result.rollout.version} ${result.rollout.percent === 0 ? '先不自动推，只给自己点「检查更新」的人' : `先推给 ${result.rollout.percent}% 的电脑`}${result.rollout.platforms ? `（只管 ${result.rollout.platforms.join('、')}）` : ''}。`,
    '',
    `**下一步**：${NEXT_STEPS[result.verdict](result.rollout.version)}`,
    '',
  ]
  if (result.table.length) lines.push('### 新版和还在旧版的电脑比', '', ...renderTable(result.table), '')
  lines.push(
    '### 怎么比的',
    '',
    `- 数的是新版发出去以后的每天打卡（最多最近 ${MAX_WINDOW_DAYS} 天），新版和比它旧、还开着打卡的版本各算一份。同一段时间、同一批客户，两边差得多才算问题。`,
    `- 停住的条件：新版自己出过至少 ${MIN_EVENTS} 次、样本够，又比还在旧版的多出一倍以上、每 100 台·天多 ${MIN_RATE_GAP} 次以上；没有可比的对照时，只拦每 100 台·天闪退 ${CRASH_CEILING} 次以上的。`
      + `升新版没装上的占两成以上也停住。`,
    `- 放开的条件：发出去满 ${MIN_OBSERVATION_HOURS} 小时、新版样本够、没有上面的情况；样本一直不够的，满 ${LONG_OBSERVATION_HOURS} 小时也建议放开，写明只能粗看。`,
    '- Sentry 上新冒出来的报错没算进来：还没有读 Sentry 的令牌（商业级差距报告 G06），有了再加。',
  )
  for (const note of result.notes) lines.push(`- ${note}`)
  return `${lines.join('\n')}\n`
}

/**
 * 读不到放量、线上清单不是放量那一版时直接给结论，不用查 Cloudflare。返回 null 表示要往下查。
 * publishedDates 是线上各份清单「版本 → 出包时间」，releasedAt 是 GitHub 上这一版 Release 的发布时间（可能没有）。
 */
function planRolloutHealth({ status, publishedDates, releasedAt, now }) {
  const rollout = readActiveRollout(status)
  if (!rollout) return { done: { verdict: 'none', headline: '现在没有在分批放量（新版本已经全部放开），没有要体检的。' } }
  const packagedAt = publishedDates.get(rollout.version)
  if (packagedAt === undefined) {
    return { done: { verdict: 'none', headline: `状态文件里的分批放量写的是 ${rollout.version}，线上更新清单不是这一版（还没发出去，或者已经退回），没有要体检的。` } }
  }
  const published = Number.isFinite(releasedAt) && releasedAt >= packagedAt ? releasedAt : null
  const start = published ?? packagedAt
  return {
    rollout,
    releasedAt: start,
    approximate: published === null,
    from: Math.max(start, now.getTime() - MAX_WINDOW_DAYS * DAY_MS),
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (!flag.startsWith('--') || argv[index + 1] === undefined) throw new RolloutHealthError(`参数不对：${flag}`)
    options[flag.slice(2)] = argv[index + 1]
  }
  return options
}

function readStatus(file) {
  return parseCurrentStatus(file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
}

/** 工作流要先知道放量的是哪一版，才能去 GitHub 查它的发布时间；没在放量时输出空行。 */
function rolloutVersion(file) {
  return readActiveRollout(readStatus(file))?.version ?? ''
}

async function runRolloutHealth({ status, publishedDates, releasedAt, now = new Date(), collectUsage }) {
  const plan = planRolloutHealth({ status, publishedDates, releasedAt, now })
  if (plan.done) return { verdict: plan.done.verdict, report: renderRolloutHealth(plan.done, now) }
  // 刚发出去一个小时以内，Cloudflare 里还没有新版的打卡，也省一次查询。
  if (now.getTime() - plan.releasedAt < HOUR_MS) {
    const result = assessRolloutHealth({ rollout: plan.rollout, releasedAt: plan.releasedAt, approximate: plan.approximate, records: [], now })
    return { verdict: result.verdict, report: renderRolloutHealth(result, now) }
  }
  const { usage } = await collectUsage(plan.from, now)
  if (!usage) {
    return { verdict: 'unknown', report: `**放量体检：看不出。** 这个套餐的 Cloudflare 统计不能按请求路径分，每天打卡没法数。照老办法看客服群和反馈报告再定 ${plan.rollout.version} 放不放开。\n` }
  }
  const result = assessRolloutHealth({ rollout: plan.rollout, releasedAt: plan.releasedAt, approximate: plan.approximate, records: usage.records, now })
  let report = renderRolloutHealth(result, now)
  if (usage.sampleInterval > 1) report += `- 这段时间 Cloudflare 是抽样记的（最多每 ${Math.round(usage.sampleInterval)} 次记 1 次），每条按抽样倍数折算，数字有误差。\n`
  return { verdict: result.verdict, report }
}

async function main(argv) {
  const [command, ...rest] = argv
  const options = parseArguments(rest)
  if (command === 'rollout-version') {
    console.log(rolloutVersion(options.status))
    return
  }
  if (command !== 'check') throw new RolloutHealthError('用法：rollout-health.cjs rollout-version --status <file> | check --status <file> --published-dates <…> [--released-at <ISO 时间>]')
  const { verdict, report } = await runRolloutHealth({
    status: readStatus(options.status),
    publishedDates: parsePublishedDates(options['published-dates']),
    releasedAt: Date.parse(String(options['released-at'] ?? '')),
    collectUsage: (from, now) => collectUsageSince({ token: process.env.CLOUDFLARE_ANALYTICS_TOKEN, from, now }),
  })
  // 停住的那一条另打一行黄色提示：运行页面上一眼看得到。
  if (verdict === 'stop') console.log(`::warning::${report.split('\n')[0].replace(/\*/g, '')}`)
  process.stdout.write(report)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const known = error instanceof RolloutHealthError || error instanceof StatsError || error instanceof StatusInputError
    console.error(`::error::${known ? error.message : '放量体检脚本自身出错，看上面的日志'}`)
    if (!known) console.error(error)
    process.exit(1)
  })
}

module.exports = {
  CRASH_CEILING,
  LONG_OBSERVATION_HOURS,
  MIN_MACHINE_DAYS,
  MIN_OBSERVATION_HOURS,
  RolloutHealthError,
  assessRolloutHealth,
  planRolloutHealth,
  readActiveRollout,
  renderRolloutHealth,
  rolloutVersion,
  runRolloutHealth,
}
