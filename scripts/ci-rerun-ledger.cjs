#!/usr/bin/env node
// CI 重跑记账（docs/CI-RERUN-LEDGER.md）：读账、核对账的写法、按关键字查账。
//
//   npm run ci:rerun-ledger -- <用例名里的几个字>
//
// 查账时把 origin/main 上的账和工作区的账合起来看：别的 PR 刚记的那一行只在 main 上，
// 本 PR 正要记的那一行只在工作区。只读，不改文件、不联网。
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const LEDGER_PATH = 'docs/CI-RERUN-LEDGER.md'
const LEDGER_HEADING = '## 账'
const COLUMNS = ['日期', '用例或步骤', '作业', '指纹', '运行', 'PR', '处理']
const REPEAT_WINDOW_DAYS = 14
const ROOT_CAUSE_PREFIX = '查根因：'
const DAY_MS = 24 * 60 * 60 * 1000

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function dayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  // Reject dates the calendar does not have (2026-02-30 rolls over otherwise).
  if (new Date(time).toISOString().slice(0, 10) !== date) return null
  return time / DAY_MS
}

// The same failure has to be recognised however the next person types it:
// case, spacing and code quotes are not part of a test name.
function normalizeKey(text) {
  return text.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function parseLedger(markdown) {
  const rows = []
  const errors = []
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === LEDGER_HEADING)
  if (start === -1) return { rows, errors: [`找不到「${LEDGER_HEADING}」这一节`] }
  let header = null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^#{1,2} /.test(line)) break
    if (!line.trim().startsWith('|')) continue
    const cells = splitRow(line)
    const where = `第 ${index + 1} 行`
    if (!header) {
      header = cells
      if (cells.join('|') !== COLUMNS.join('|')) errors.push(`${where}：表头要是「${COLUMNS.join(' | ')}」`)
      continue
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    if (cells.length !== COLUMNS.length) {
      errors.push(`${where}：要 ${COLUMNS.length} 列，这一行有 ${cells.length} 列（格子里别写竖线）`)
      continue
    }
    const [date, key, job, fingerprint, runId, pr, action] = cells
    const row = { line: index + 1, date, key, job, fingerprint, runId, pr, action, day: dayNumber(date) }
    if (row.day === null) errors.push(`${where}：日期要写成 YYYY-MM-DD 的真实日期`)
    if (!key) errors.push(`${where}：「用例或步骤」空着`)
    if (!job) errors.push(`${where}：「作业」空着`)
    if (!fingerprint) errors.push(`${where}：「指纹」空着`)
    if (!/^\d{6,}$/.test(runId)) errors.push(`${where}：「运行」写运行号（一串数字）`)
    if (!/^(#\d+|main)$/.test(pr)) errors.push(`${where}：「PR」写 #1234 或 main`)
    if (!action) errors.push(`${where}：「处理」空着`)
    const previous = rows.at(-1)
    if (previous && row.day !== null && previous.day !== null && row.day < previous.day) {
      errors.push(`${where}：日期比上一行早，账只往末尾按先后加`)
    }
    rows.push(row)
  }
  if (!header) errors.push(`「${LEDGER_HEADING}」下面没有表`)
  errors.push(...repeatErrors(rows))
  return { rows, errors }
}

// The rule yoyo set on 2026-11-17: the second rerun-to-pass of the same check
// within two weeks is not allowed to be waved through again.
function repeatErrors(rows) {
  const errors = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.day === null) continue
    const earlier = earlierWithinWindow(rows.slice(0, index), row.key, row.day)
    if (earlier && !row.action.startsWith(ROOT_CAUSE_PREFIX)) {
      errors.push(`第 ${row.line} 行：${earlier.date}（第 ${earlier.line} 行）已经记过同一条，两周内第二次，「处理」要以「${ROOT_CAUSE_PREFIX}」开头，不能再重跑放过`)
    }
  }
  return errors
}

function earlierWithinWindow(rows, key, day) {
  const wanted = normalizeKey(key)
  return rows.findLast((row) => row.day !== null && normalizeKey(row.key) === wanted && day - row.day <= REPEAT_WINDOW_DAYS) || null
}

function beijingToday(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function findEntries(rows, words, today) {
  const todayNumber = dayNumber(today)
  const lowered = words.map((word) => normalizeKey(word)).filter(Boolean)
  const matches = rows.filter((row) => lowered.every((word) => normalizeKey(row.key).includes(word)))
  return matches.map((row) => ({ ...row, recent: row.day !== null && todayNumber - row.day <= REPEAT_WINDOW_DAYS }))
}

function mergeRows(lists) {
  const seen = new Set()
  const merged = []
  for (const row of lists.flat()) {
    const id = `${row.runId}|${normalizeKey(row.key)}`
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(row)
  }
  return merged.sort((left, right) => (left.day ?? 0) - (right.day ?? 0))
}

function readLedgers(cwd) {
  const sources = []
  try {
    const main = execFileSync('git', ['show', `origin/main:${LEDGER_PATH}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    sources.push({ name: 'origin/main', markdown: main })
  } catch {
    // Not fetched, or not on main yet: the working copy still answers.
  }
  const local = path.join(cwd, LEDGER_PATH)
  if (fs.existsSync(local)) sources.push({ name: '工作区', markdown: fs.readFileSync(local, 'utf8') })
  return sources
}

function parseArgs(argv) {
  const options = { words: [], today: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--today') {
      const value = argv[index + 1]
      if (dayNumber(value || '') === null) throw new Error('--today 后面要跟 YYYY-MM-DD')
      options.today = value
      index += 1
    } else if (arg.startsWith('-')) {
      throw new Error(`不认识的参数：${arg}`)
    } else {
      options.words.push(arg)
    }
  }
  if (options.words.length === 0) throw new Error('用法：npm run ci:rerun-ledger -- <用例名里的几个字> [--today YYYY-MM-DD]')
  return options
}

function report(entries, words, today) {
  const lines = [`账里「${words.join(' ')}」对得上 ${entries.length} 行（今天按北京时间算是 ${today}）：`]
  for (const entry of entries) {
    lines.push(`- ${entry.date}${entry.recent ? '（两周内）' : ''} ${entry.key}｜${entry.job}｜运行 ${entry.runId}｜${entry.pr}｜${entry.action}`)
  }
  const recent = entries.filter((entry) => entry.recent)
  lines.push('')
  if (recent.length > 0) {
    lines.push('两周内记过：不许再重跑。开线程查根因，在账末尾加一行，「处理」写「查根因：」加线程、issue 或 PR。')
    lines.push('先确认对上的就是同一条（整句一样）；只是名字里有这几个字的不算。')
  } else {
    lines.push('两周内没记过：可以重跑一次。先在账末尾加一行，作为一个提交推上去，这次推送就是那一次重跑。')
  }
  return { text: lines.join('\n'), recent: recent.length > 0 }
}

function run(argv, cwd = process.cwd(), now = new Date()) {
  const options = parseArgs(argv)
  const today = options.today || beijingToday(now)
  const sources = readLedgers(cwd)
  if (sources.length === 0) throw new Error(`读不到 ${LEDGER_PATH}`)
  const lists = []
  for (const source of sources) {
    const { rows, errors } = parseLedger(source.markdown)
    if (errors.length > 0) throw new Error(`${source.name} 的账写得有问题：\n${errors.join('\n')}`)
    lists.push(rows)
  }
  const entries = findEntries(mergeRows(lists), options.words, today)
  return report(entries, options.words, today)
}

if (require.main === module) {
  try {
    process.stdout.write(`${run(process.argv.slice(2)).text}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  LEDGER_PATH,
  REPEAT_WINDOW_DAYS,
  parseLedger,
  findEntries,
  mergeRows,
  beijingToday,
  normalizeKey,
  parseArgs,
  run,
}
