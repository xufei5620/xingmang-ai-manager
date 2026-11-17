#!/usr/bin/env node
// 按这次改动列出 docs/RELIABILITY-CHECKLIST.md 里命中的条目（npm run checklist）。
//
// 清单默认从 origin/main 读，不读工作区那份：一个 PR 改掉清单里的条目，就能让自己
// 不命中，等于自己给自己当裁判。改清单本身时用 --local 试触发。
//
// 只读：不改文件、不联网、不起 git 以外的进程。命中多少条都退出 0，它只负责列出来；
// 清单写坏、参数不对、git 读不出来时退出 1。
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const CHECKLIST_PATH = 'docs/RELIABILITY-CHECKLIST.md'
const FIELD_TRIGGER = '触发'
const FIELD_CHECK = '查什么'
const ITEM_HEADING = /^### (R\d{2}) (.+)$/

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

// `*` stays inside one path segment and `**` crosses any number of them, the
// way GitHub's paths filters read; nothing else is special.
function globToRegExp(glob) {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`^${source}$`)
}

function backticked(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])
}

function parseTrigger(text, where, errors) {
  const rule = { files: [], excludes: [], lines: [] }
  for (const segment of text.split('，').map((part) => part.trim()).filter(Boolean)) {
    const values = backticked(segment)
    if (segment.startsWith('文件')) {
      if (values.length === 0) errors.push(`${where}：「文件」后面没有反引号括起来的文件写法`)
      for (const value of values) {
        if (value.startsWith('!')) rule.excludes.push(value.slice(1))
        else rule.files.push(value)
      }
    } else if (segment.startsWith('改动行含')) {
      if (values.length === 0) errors.push(`${where}：「改动行含」后面没有反引号括起来的正则`)
      for (const value of values) {
        try {
          rule.lines.push(new RegExp(value))
        } catch (error) {
          errors.push(`${where}：正则 ${value} 编不过：${error.message}`)
        }
      }
    } else {
      errors.push(`${where}：读不懂「${segment}」，只认「文件 …」和「改动行含 …」`)
    }
  }
  if (rule.files.length === 0 && rule.lines.length === 0) errors.push(`${where}：没有写文件也没有写改动行`)
  if (rule.files.length === 0 && rule.excludes.length > 0) errors.push(`${where}：只有排除，没有要对的文件`)
  return rule
}

function parseChecklist(markdown) {
  const items = []
  const errors = []
  let item = null
  let field = null
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const heading = ITEM_HEADING.exec(line)
    if (heading) {
      item = { id: heading[1], title: heading[2].trim(), line: index + 1, triggers: [], check: '', origin: '' }
      items.push(item)
      field = null
      continue
    }
    if (/^#{1,3} /.test(line)) {
      if (/^### /.test(line)) errors.push(`第 ${index + 1} 行：条目标题要写成「### R01 标题」`)
      item = null
      field = null
      continue
    }
    if (!item) continue
    const bullet = /^- (触发|查什么|出自)：(.*)$/.exec(line)
    if (bullet) {
      field = bullet[1]
      if (field === FIELD_TRIGGER) item.triggers.push({ text: bullet[2], line: index + 1 })
      else if (field === FIELD_CHECK) item.check = bullet[2].trim()
      else item.origin = bullet[2].trim()
      continue
    }
    // A wrapped field continues on lines indented under its bullet.
    if (field && /^\s{2,}\S/.test(line)) {
      if (field === FIELD_TRIGGER) item.triggers.at(-1).text += ` ${line.trim()}`
      else if (field === FIELD_CHECK) item.check += line.trim()
      else item.origin += line.trim()
      continue
    }
    if (line.trim() === '') {
      field = null
      continue
    }
    errors.push(`第 ${index + 1} 行（${item.id}）：条目里只认「- 触发：」「- 查什么：」「- 出自：」三种开头`)
  }
  const seen = new Set()
  for (const entry of items) {
    if (seen.has(entry.id)) errors.push(`${entry.id} 重复了`)
    seen.add(entry.id)
    if (entry.triggers.length === 0) errors.push(`${entry.id} 没有「触发」`)
    if (!entry.check) errors.push(`${entry.id} 没有「查什么」`)
    if (!entry.origin) errors.push(`${entry.id} 没有「出自」`)
    entry.rules = entry.triggers.map((trigger) => parseTrigger(trigger.text, `第 ${trigger.line} 行（${entry.id}）`, errors))
  }
  if (items.length === 0) errors.push('清单里一条都没读到')
  return { items, errors }
}

function matchesAny(globs, file) {
  return globs.some((glob) => globToRegExp(glob).test(file))
}

function ruleFiles(rule, files) {
  if (rule.files.length === 0) return files
  return files.filter((file) => matchesAny(rule.files, file) && !matchesAny(rule.excludes, file))
}

// changes: [{ file, lines() }] where lines() returns the added and removed
// lines of that file, so the diff of a file is only read when a rule asks.
function matchItem(item, changes) {
  const reasons = new Set()
  for (const rule of item.rules) {
    const candidates = changes.filter((change) => ruleFiles(rule, [change.file]).length > 0)
    for (const change of candidates) {
      if (rule.lines.length === 0) {
        reasons.add(change.file)
      } else if (change.lines().some((line) => rule.lines.some((pattern) => pattern.test(line)))) {
        reasons.add(change.file)
      }
    }
  }
  return [...reasons]
}

function matchChecklist(items, changes) {
  return items
    .map((item) => ({ item, files: matchItem(item, changes) }))
    .filter((hit) => hit.files.length > 0)
}

function changedLinesFromDiff(diff) {
  return diff
    .split('\n')
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
    .map((line) => line.slice(1))
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function collectChanges(base, cwd) {
  const tracked = git(['diff', '--name-only', '-z', '--no-renames', base, '--'], cwd).split('\0').filter(Boolean)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).split('\0').filter(Boolean)
  const changes = tracked.map((file) => ({
    file,
    lines: memo(() => changedLinesFromDiff(git(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', base, '--', file], cwd))),
  }))
  for (const file of untracked) {
    changes.push({ file, lines: memo(() => readUntracked(path.join(cwd, file))) })
  }
  return changes
}

function readUntracked(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

function memo(compute) {
  let value
  let done = false
  return function cached() {
    if (!done) {
      value = compute()
      done = true
    }
    return value
  }
}

function parseArgs(argv) {
  const options = { base: 'origin/main', from: 'origin/main', local: false, markdown: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--local') options.local = true
    else if (arg === '--markdown') options.markdown = true
    else if (arg === '--base' || arg === '--from') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`${arg} 后面要跟一个提交或分支`)
      options[arg.slice(2)] = value
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`不认识的参数：${arg}`)
    }
  }
  return options
}

function readChecklist(options, cwd) {
  if (!options.local) {
    try {
      return { markdown: git(['show', `${options.from}:${CHECKLIST_PATH}`], cwd), source: options.from, fallback: false }
    } catch {
      // The very change that adds the checklist has nothing on main to read.
    }
  }
  return { markdown: fs.readFileSync(path.join(cwd, CHECKLIST_PATH), 'utf8'), source: null, fallback: !options.local }
}

function sourceLabel(source) {
  return source === null ? '工作区里' : ` ${source} 上`
}

function formatText(hits, context) {
  const lines = []
  lines.push(`按${sourceLabel(context.source)}的可靠性清单（${CHECKLIST_PATH}），核对相对 ${context.base} 改动的 ${context.fileCount} 个文件，命中 ${hits.length} 条。`)
  for (const note of context.notes) lines.push(note)
  for (const { item, files } of hits) {
    lines.push('')
    lines.push(`${item.id} ${item.title}`)
    lines.push(`  因为：${files.slice(0, 5).join('、')}${files.length > 5 ? ` 等 ${files.length} 个文件` : ''}`)
    lines.push(`  查什么：${item.check}`)
    lines.push(`  出自：${item.origin}`)
  }
  if (hits.length === 0) lines.push('一条都没命中。PR 正文「可靠性清单」一节照写「没命中」。')
  return lines.join('\n')
}

function formatMarkdown(hits, context) {
  const lines = []
  if (hits.length === 0) {
    lines.push(`没命中（清单取自${sourceLabel(context.source)}）。`)
  } else {
    lines.push(`命中 ${hits.length} 条（清单取自${sourceLabel(context.source)}）：`)
    lines.push('')
    for (const { item, files } of hits) {
      lines.push(`- **${item.id} ${item.title}**（${files.slice(0, 3).map((file) => `\`${file}\``).join('、')}${files.length > 3 ? ' 等' : ''}）：怎么查的写在这里`)
    }
  }
  for (const note of context.notes) {
    lines.push('')
    lines.push(`> ${note}`)
  }
  return lines.join('\n')
}

function run(argv, cwd = process.cwd()) {
  const options = parseArgs(argv)
  if (options.help) {
    return { code: 0, output: '用法：npm run checklist -- [--base <提交或分支>] [--from <提交或分支>] [--local] [--markdown]\n说明见 docs/RELIABILITY-CHECKLIST.md 开头。' }
  }
  let base
  try {
    base = git(['merge-base', options.base, 'HEAD'], cwd).trim()
  } catch {
    throw new Error(`找不到 ${options.base} 和当前分支的共同起点；先 git fetch origin main，或用 --base 指定`)
  }
  const checklist = readChecklist(options, cwd)
  const { items, errors } = parseChecklist(checklist.markdown)
  if (errors.length > 0) throw new Error(`清单（取自${sourceLabel(checklist.source)}）写得有问题：\n${errors.join('\n')}`)
  const changes = collectChanges(base, cwd)
  const notes = []
  if (checklist.fallback) notes.push(`${options.from} 上还没有这份清单，用的是工作区这份。`)
  if (!options.local && !checklist.fallback && changes.some((change) => change.file === CHECKLIST_PATH)) {
    notes.push('这次改动改了清单本身：上面按旧的那份核对，新加或改过的条目要单独看（--local 能按改过的那份试一遍）。')
  }
  // The checklist describes what to check; editing it is not one of the changes
  // it describes (its own text mentions every trigger word).
  const hits = matchChecklist(items, changes.filter((change) => change.file !== CHECKLIST_PATH))
  const context = { source: checklist.source, base: options.base, fileCount: changes.length, notes }
  return { code: 0, output: options.markdown ? formatMarkdown(hits, context) : formatText(hits, context), hits }
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${result.output}\n`)
    process.exitCode = result.code
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  CHECKLIST_PATH,
  globToRegExp,
  parseChecklist,
  matchChecklist,
  changedLinesFromDiff,
  collectChanges,
  parseArgs,
  run,
}
