// 代码扫描（.github/workflows/codeql.yml）跑完以后，把 CodeQL 写出的 SARIF 列成人看得懂的清单：
// 每一条的严重程度、规则、文件和行号、一句说明，打进作业日志，也写进运行摘要页。
//
// 结果本来在仓库 Security 标签页的 Code scanning 里，但那一页只有仓库管理员看得全，线程的令牌
// 读 code-scanning 接口一律 403（2026-10-28 实测），读得到的只有作业日志。所以这里只做一件事：
// 把扫描结果原样搬到大家都能读到的地方。它不判断该不该挡、不改退出码；SARIF 读不出来才报错，
// 那说明扫描本身出了问题。
const fs = require('node:fs')
const path = require('node:path')

// 日志和摘要页最多列这么多条，再多就只给总数：第一次扫全仓可能有几百条，摘要页有 1 MiB 上限。
const LISTED_RESULTS_LIMIT = 200

// 安全类规则带 security-severity（0～10 分），Code scanning 页面按它分「严重 / 高 / 中 / 低」，
// 这里用同一套分界，两边对得上。不带分数的是一般代码问题，按 error / warning / note 分。
const SECURITY_LEVELS = [
  { min: 9, label: '严重' },
  { min: 7, label: '高' },
  { min: 4, label: '中' },
  { min: 0.1, label: '低' },
]
const PROBLEM_LEVELS = { error: '错误', warning: '警告', note: '提示', recommendation: '提示' }
const LEVEL_ORDER = ['严重', '高', '中', '低', '错误', '警告', '提示']

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// CodeQL 把规则放在 tool.driver.rules，也放在各个查询包（tool.extensions[].rules）里；结果用
// rule.toolComponent.index 指明是哪一个。按 id 收齐，两种写法都认得。
function collectRules(run) {
  const rules = new Map()
  const components = [run.tool?.driver, ...(Array.isArray(run.tool?.extensions) ? run.tool.extensions : [])]
  for (const component of components) {
    if (!isRecord(component) || !Array.isArray(component.rules)) continue
    for (const rule of component.rules) {
      if (isRecord(rule) && typeof rule.id === 'string' && !rules.has(rule.id)) rules.set(rule.id, rule)
    }
  }
  return rules
}

function resolveLevel(rule, result) {
  const score = Number.parseFloat(rule?.properties?.['security-severity'])
  if (Number.isFinite(score)) {
    const level = SECURITY_LEVELS.find((entry) => score >= entry.min)
    if (level) return level.label
  }
  const problem = rule?.properties?.['problem.severity'] || result.level || rule?.defaultConfiguration?.level
  return PROBLEM_LEVELS[problem] || '提示'
}

// 说明里的 [用户传进来的值](1) 指向 SARIF 里的另一个位置，日志里看不了，只留文字。表格里的竖线
// 和换行会把一行拆坏。
function plainMessage(text) {
  return String(text || '')
    .replace(/\[([^\]]*)\]\(\d+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function describeLocation(result) {
  const location = result.locations?.[0]?.physicalLocation
  const file = location?.artifactLocation?.uri
  if (typeof file !== 'string' || !file) return '（没有位置）'
  const line = location.region?.startLine
  return Number.isSafeInteger(line) && line > 0 ? `${file}:${line}` : file
}

function summarizeSarif(sarif) {
  if (!isRecord(sarif) || !Array.isArray(sarif.runs)) throw new Error('不是 SARIF：缺少 runs。')
  const findings = []
  for (const run of sarif.runs) {
    if (!isRecord(run)) continue
    const rules = collectRules(run)
    for (const result of Array.isArray(run.results) ? run.results : []) {
      if (!isRecord(result)) continue
      // 标了 suppressions 的结果 Code scanning 不当告警，这里也不列。
      if (Array.isArray(result.suppressions) && result.suppressions.length > 0) continue
      const ruleId = result.ruleId || result.rule?.id || '（未知规则）'
      const rule = rules.get(ruleId)
      findings.push({
        level: resolveLevel(rule, result),
        ruleId,
        location: describeLocation(result),
        message: plainMessage(result.message?.text) || plainMessage(rule?.shortDescription?.text),
      })
    }
  }
  findings.sort((left, right) => LEVEL_ORDER.indexOf(left.level) - LEVEL_ORDER.indexOf(right.level)
    || left.ruleId.localeCompare(right.ruleId)
    || left.location.localeCompare(right.location))
  return findings
}

function countByLevel(findings) {
  const counts = new Map()
  for (const finding of findings) counts.set(finding.level, (counts.get(finding.level) || 0) + 1)
  return LEVEL_ORDER.filter((level) => counts.has(level)).map((level) => `${level} ${counts.get(level)}`)
}

function escapeCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

function formatLog(name, findings) {
  if (findings.length === 0) return `代码扫描（${name}）：没有发现问题\n`
  const lines = [`代码扫描（${name}）：发现 ${findings.length} 条（${countByLevel(findings).join('，')}）`]
  for (const finding of findings.slice(0, LISTED_RESULTS_LIMIT)) {
    lines.push(`  [${finding.level}] ${finding.ruleId}  ${finding.location}  ${finding.message}`)
  }
  if (findings.length > LISTED_RESULTS_LIMIT) lines.push(`  ……另外 ${findings.length - LISTED_RESULTS_LIMIT} 条没有列出，见仓库 Security 标签页`)
  return `${lines.join('\n')}\n`
}

function formatMarkdown(name, findings) {
  if (findings.length === 0) return `### 代码扫描（${name}）：没有发现问题\n\n`
  const lines = [
    `### 代码扫描（${name}）：发现 ${findings.length} 条`,
    '',
    `${countByLevel(findings).join('，')}。现在只报不挡，不影响合并和发版。`,
    '',
    '| 严重程度 | 规则 | 位置 | 说明 |',
    '| --- | --- | --- | --- |',
  ]
  for (const finding of findings.slice(0, LISTED_RESULTS_LIMIT)) {
    lines.push(`| ${finding.level} | \`${escapeCell(finding.ruleId)}\` | \`${escapeCell(finding.location)}\` | ${escapeCell(finding.message)} |`)
  }
  if (findings.length > LISTED_RESULTS_LIMIT) {
    lines.push('', `另外 ${findings.length - LISTED_RESULTS_LIMIT} 条没有列出，见仓库 Security 标签页的 Code scanning。`)
  }
  return `${lines.join('\n')}\n\n`
}

function listSarifFiles(directory) {
  let entries
  try {
    entries = fs.readdirSync(directory)
  } catch (error) {
    throw new Error(`读不了扫描结果目录 ${directory}：${error.message}`)
  }
  const files = entries.filter((name) => name.endsWith('.sarif')).sort()
  if (files.length === 0) throw new Error(`扫描结果目录 ${directory} 里没有 .sarif 文件，扫描多半没跑完。`)
  return files.map((name) => path.join(directory, name))
}

function main(argv = process.argv.slice(2), env = process.env, write = (text) => process.stdout.write(text)) {
  if (argv.length !== 1 || !argv[0]) throw new Error('用法：node scripts/codeql-summary.cjs <SARIF 目录>')
  for (const file of listSarifFiles(argv[0])) {
    let sarif
    try {
      sarif = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`读不懂 ${path.basename(file)}：${error.message}`)
    }
    const name = path.basename(file, '.sarif')
    const findings = summarizeSarif(sarif)
    write(formatLog(name, findings))
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, formatMarkdown(name, findings))
  }
}

module.exports = { LISTED_RESULTS_LIMIT, summarizeSarif, formatLog, formatMarkdown, listSarifFiles, main }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`整理代码扫描结果失败：${error.message}\n`)
    process.exitCode = 1
  }
}
