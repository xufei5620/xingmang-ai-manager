// 门禁删行提醒：PR 删掉或改掉门禁里的行、少了测试用例或断言时，在作业摘要里列出来。只提醒，不挡合并。
//
// 为什么要它（2026-11-17，对照 Claude Code 团队讲「验证」的那篇文章，建议第 5 条）：PR 上跑的
// quality 工作流、scripts/verify-* 门禁、提权子进程的禁用变量表，用的都是 PR 分支里那一份，改动
// 本身就能把裁判改掉。CODEOWNERS 会点 yoyo 的名，可分支保护没开「必须代码所有者审」，自动合并不等
// 他。项目规矩是「放宽任何安全校验要 yoyo 亲手打字同意」，这道检查让机器替他盯着。
//
// 裁判从 main 读：.github/workflows/removed-guards.yml 用 pull_request_target 触发，GitHub 从 PR 的
// 目标分支取工作流文件，检出的也是目标分支，所以下面的名单和这份脚本都是 main 上的那一份。PR 里改
// 它们只影响合进 main 以后的 PR。PR 的提交只当数据读：fetch 进来，用 git diff / git show 读文字，
// 不执行其中任何一行，作业也不读任何 secret，令牌只有读权限（removed-guards.test.cjs 钉住）。
//
// 只记不拦：先跑两周（到 2026-12-01）看误报多不多，再定要不要改成拦，改成拦要 yoyo 点头。作业平常
// 永远是绿的；只有它自己没跑成（拿不到 PR 的提交之类）才红，那说明提醒失灵了，要人去看。
//
// 看三样：
//   1. 门禁文件（GUARDS）里删掉或改掉的行。门禁里的禁止表、断言、必过作业，删一行就少挡一样。
//      白名单正相反，加一行才是放宽；可往白名单加一行是这些文件平常的改法，报了只会刷屏，这一版
//      不看。空行、纯注释行不算；同一个文件里删了又原样加回来的（挪了位置、改了缩进）不算。
//   2. 测试文件里少了的用例（it / test）和断言（expect / assert），按每个文件改动前后的个数比：换个
//      写法不报，删掉、注释掉、几条并成一条才报。新加的 .skip( / .only( / .todo( 也报。
//   3. package.json 里 npm test、typecheck 这几条命令跑的东西少了哪些（挪到另一条命令里的不算）。
//
// 本机跑：node scripts/report-removed-guards.cjs origin/main HEAD，摘要打到屏幕上。
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const MAX_BUFFER = 64 * 1024 * 1024
// 摘要页一步最多 1 MiB；一份文件列这么多行就够人判断了，再多只给个数。
const LISTED_LINES_PER_FILE = 40
const LISTED_LINE_LENGTH = 240
// GitHub 一步最多显示 10 条 warning 标注，多出来的它自己丢掉；第 10 条留给「还有几处」。
const ANNOTATION_LIMIT = 9
const COMMIT = /^[0-9a-f]{40}$/i

const GUARDS = [
  {
    id: 'quality',
    title: '必过检查：quality 工作流跑哪些作业、quality-gate 等哪些',
    paths: ['.github/workflows/quality.yml'],
  },
  {
    id: 'self',
    title: '这道提醒自己：名单、脚本和工作流',
    paths: ['.github/workflows/removed-guards.yml', 'scripts/report-removed-guards.cjs'],
  },
  {
    id: 'verify',
    title: '边界门禁 scripts/verify-*.test.cjs（画布边界、渲染层边界、代码风格等）',
    pattern: /^scripts\/verify-[^/]+\.test\.cjs$/,
  },
  {
    id: 'trusted-env',
    title: '提权子进程的禁用变量表 trustedCommandEnvironment（AGENTS.md I2、T4：只许收紧）',
    paths: ['electron/command-runner.ts'],
    // 文件别处天天在改，只有这个函数是 T4 说的那几张表和用它们的地方。
    region: { start: /^export function trustedCommandEnvironment\(/, end: /^\}/ },
  },
  {
    id: 'ipc-policy',
    title: '每条通道在日志里记什么、要不要等账号（AGENTS.md I3、I13）',
    paths: ['electron/ipc-channel-policy.ts'],
  },
  {
    id: 'change-scope',
    title: '哪些改动跑哪些检查（scripts/ci-change-scope.cjs）',
    paths: ['scripts/ci-change-scope.cjs'],
  },
  {
    id: 'secret-scan',
    title: '密钥扫描（scripts/scan-new-commits-for-secrets.cjs）',
    paths: ['scripts/scan-new-commits-for-secrets.cjs'],
  },
  {
    id: 'codeowners',
    title: '改哪些文件要点 yoyo 的名（.github/CODEOWNERS）',
    paths: ['.github/CODEOWNERS'],
  },
  {
    id: 'selfcheck',
    title: '四道自查和 vitest 收哪些测试文件',
    paths: ['scripts/self-check.cjs', 'vitest.config.ts'],
  },
]

// canvas-v2/ 是 xingmang-canvas 内核的同步副本（AGENTS.md T13），那边的测试增减随内核 tag 来，
// 由那边的 CI 管，在这里报只会每次同步都刷一遍。
const TEST_FILE = /(?:^|\/)[^/]+\.test\.(?:ts|tsx|cjs|mjs|js)$/
const E2E_SUITE = /^e2e\/.+\.mjs$|(?:^|\/)(?:browser-check|app-check)\.mjs$/
const SKIPPED_TEST_ROOTS = /^(?:canvas-v2|node_modules)\//

// 前面不能是标识符字符或点：`pattern.test(x)`、`t.assert.equal(` 不算，`it.runIf(...)(` 只算一次。
const TEST_CASE = /(?<![\w.$])(?:it|test)(?:\.\w+)*\s*\(/g
const ASSERTION = /(?<![\w.$])(?:expect|assert)(?:\.\w+)*\s*\(/g
const SKIP_MARKER = /\.(?:skip|only|todo)\s*\(/g

const WATCHED_SCRIPT = /^(?:test(?::.*)?|typecheck|check:v2|selfcheck)$/

function git(repository, args, run = execFileSync) {
  return run('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
}

function guardFor(file) {
  return GUARDS.find((guard) => (guard.paths || []).includes(file) || (guard.pattern && guard.pattern.test(file))) || null
}

function isTestFile(file) {
  return !SKIPPED_TEST_ROOTS.test(file) && (TEST_FILE.test(file) || E2E_SUITE.test(file))
}

function parseNameStatus(text) {
  const fields = String(text).split('\0')
  const entries = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (!status) continue
    if (/^[RC]/.test(status)) {
      entries.push({ status: status[0], oldPath: fields[index], newPath: fields[index + 1] })
      index += 2
    } else {
      const file = fields[index++]
      entries.push({ status: status[0], oldPath: status[0] === 'A' ? null : file, newPath: status[0] === 'D' ? null : file })
    }
  }
  return entries
}

// -U0 的补丁，一次只喂一份文件。第一个 @@ 之前是文件头；之后以 - 开头的一律是删掉的行，哪怕
// 它本身长得像 `--- a/x`。
function parseHunks(patch) {
  const hunks = []
  let current = null
  for (const line of String(patch).split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[3]), removed: [], added: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('-')) current.removed.push({ line: current.oldStart + current.removed.length, text: line.slice(1) })
    else if (line.startsWith('+')) current.added.push(line.slice(1))
  }
  return hunks
}

function commentPrefixes(file) {
  if (/\.ya?ml$/.test(file) || /(?:^|\/)CODEOWNERS$/.test(file)) return ['#']
  if (/\.(?:[cm]?js|tsx?)$/.test(file)) return ['//', '/*', '*']
  return []
}

function countsAsGuardLine(file, text) {
  const trimmed = text.trim()
  if (!trimmed) return false
  return !commentPrefixes(file).some((prefix) => trimmed.startsWith(prefix))
}

// 区间按改动前那一版算。找不到起点（函数改了名、挪了文件）就整份文件都当门禁看：宁可多报，
// 不能让保护悄悄没了。
function resolveRegion(region, baseText) {
  if (!region) return null
  const lines = String(baseText).split('\n')
  const start = lines.findIndex((line) => region.start.test(line))
  if (start < 0) return { missing: true }
  const end = lines.findIndex((line, index) => index > start && region.end.test(line))
  return { from: start + 1, to: end < 0 ? lines.length : end + 1 }
}

function inRegion(region, line) {
  return !region || region.missing || (line >= region.from && line <= region.to)
}

// 同一份文件里删掉又原样加回来的行（去掉首尾空白比）是挪了位置，不算删。
function removedGuardLines(file, hunks, region) {
  const added = new Map()
  for (const hunk of hunks) {
    for (const text of hunk.added) {
      const key = text.trim()
      added.set(key, (added.get(key) || 0) + 1)
    }
  }
  const kept = []
  for (const hunk of hunks) {
    const removed = hunk.removed.filter((entry) => {
      if (!inRegion(region, entry.line) || !countsAsGuardLine(file, entry.text)) return false
      const key = entry.text.trim()
      const left = added.get(key) || 0
      if (left > 0) {
        added.set(key, left - 1)
        return false
      }
      return true
    })
    if (removed.length) kept.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, removed, added: hunk.added })
  }
  return kept
}

// 注释掉一条测试也是少了一条，所以先去掉注释再数。不认字符串里的 // 和 /*：
// 前后两版用的是同一种数法，误差在两边一样。
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1')
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length
}

function testCounts(source) {
  const code = stripComments(source)
  return { cases: countMatches(code, TEST_CASE), assertions: countMatches(code, ASSERTION), skips: countMatches(code, SKIP_MARKER) }
}

function scriptTokens(packageText) {
  let scripts
  try {
    scripts = JSON.parse(packageText).scripts
  } catch {
    return null
  }
  const tokens = new Set()
  if (!scripts || typeof scripts !== 'object') return tokens
  for (const [name, command] of Object.entries(scripts)) {
    if (!WATCHED_SCRIPT.test(name) || typeof command !== 'string') continue
    tokens.add(`<${name}>`)
    for (const token of command.split(/\s+/)) if (token) tokens.add(token)
  }
  return tokens
}

function showFile(repository, revision, file, run) {
  return git(repository, ['show', `${revision}:${file}`], run)
}

function buildReport({ repository, from, head, run = execFileSync }) {
  const entries = parseNameStatus(git(repository, ['diff', '--no-color', '--no-ext-diff', '--name-status', '-z', '-M', from, head, '--'], run))
  const guards = []
  const tests = []
  let scripts = null

  for (const entry of entries) {
    const guard = entry.oldPath ? guardFor(entry.oldPath) : null
    if (guard) {
      const baseText = showFile(repository, from, entry.oldPath, run)
      if (!entry.newPath) {
        const lines = baseText.split('\n').filter((text) => countsAsGuardLine(entry.oldPath, text)).length
        guards.push({ guard, oldPath: entry.oldPath, newPath: null, deletedFile: true, lines, hunks: [] })
      } else {
        const region = resolveRegion(guard.region, baseText)
        const patch = git(repository, ['diff', '--no-color', '--no-ext-diff', '-U0', `${from}:${entry.oldPath}`, `${head}:${entry.newPath}`], run)
        const hunks = removedGuardLines(entry.oldPath, parseHunks(patch), region)
        if (hunks.length) guards.push({ guard, oldPath: entry.oldPath, newPath: entry.newPath, deletedFile: false, regionMissing: Boolean(region?.missing), hunks })
      }
    }

    const oldIsTest = entry.oldPath && isTestFile(entry.oldPath)
    const newIsTest = entry.newPath && isTestFile(entry.newPath)
    if (oldIsTest || newIsTest) {
      const before = oldIsTest ? testCounts(showFile(repository, from, entry.oldPath, run)) : { cases: 0, assertions: 0, skips: 0 }
      const after = newIsTest ? testCounts(showFile(repository, head, entry.newPath, run)) : { cases: 0, assertions: 0, skips: 0 }
      const fewer = oldIsTest && (after.cases < before.cases || after.assertions < before.assertions)
      if (fewer || after.skips > before.skips) tests.push({ oldPath: entry.oldPath, newPath: entry.newPath, before, after })
    }

    if (entry.oldPath === 'package.json' && entry.newPath === 'package.json') {
      const before = scriptTokens(showFile(repository, from, 'package.json', run))
      const after = scriptTokens(showFile(repository, head, 'package.json', run))
      if (before && after) {
        const removed = [...before].filter((token) => !after.has(token))
        if (removed.length) scripts = { removed }
      } else if (before && !after) {
        scripts = { unreadable: true, removed: [] }
      }
    }
  }
  return { guards, tests, scripts }
}

function hasFindings(report) {
  return report.guards.length > 0 || report.tests.length > 0 || Boolean(report.scripts)
}

// 摘要里出现的路径来自 PR：控制字符会拆行，竖线会拆表格，反引号会提前收掉行内代码。
function plainPath(file) {
  return String(file).replace(/[\u0000-\u001f\u007f]/g, '?')
}

function inlineCode(text) {
  const value = plainPath(text).replaceAll('|', '\\|')
  const longest = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return longest ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`
}

function codeFence(lines) {
  const longest = Math.max(0, ...lines.flatMap((line) => (line.match(/`+/g) || []).map((run) => run.length)))
  return '`'.repeat(Math.max(3, longest + 1))
}

function clip(text) {
  const value = String(text).replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, '?')
  return value.length > LISTED_LINE_LENGTH ? `${value.slice(0, LISTED_LINE_LENGTH)}…` : value
}

function guardSection(finding) {
  const name = finding.newPath && finding.newPath !== finding.oldPath
    ? `${inlineCode(finding.oldPath)} → ${inlineCode(finding.newPath)}`
    : inlineCode(finding.oldPath)
  if (finding.deletedFile) return [`- ${name}：**整份删掉了**（${finding.lines} 行，不算空行和注释）。`]
  const total = finding.hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0)
  const lines = [`- ${name}：删掉或改掉 ${total} 行${finding.regionMissing ? '（没找到要盯的那一段，整份文件都按门禁看了）' : ''}。`]
  const body = []
  let listed = 0
  for (const hunk of finding.hunks) {
    if (listed >= LISTED_LINES_PER_FILE) break
    body.push(`@@ 改动前第 ${hunk.oldStart} 行起 @@`)
    for (const entry of hunk.removed) {
      if (listed >= LISTED_LINES_PER_FILE) break
      body.push(`-${clip(entry.text)}`)
      listed += 1
    }
    for (const text of hunk.added.slice(0, LISTED_LINES_PER_FILE)) body.push(`+${clip(text)}`)
  }
  if (total > listed) body.push(`（还有 ${total - listed} 行没列出来，去 PR 的 Files changed 里看）`)
  const fence = codeFence(body)
  lines.push('', `  ${fence}diff`, ...body.map((line) => `  ${line}`), `  ${fence}`)
  return lines
}

function change(before, after) {
  return before === after ? String(after) : `${before} → ${after}`
}

function formatMarkdown(report, { base } = {}) {
  const lines = ['## 门禁删行提醒', '']
  const source = base ? ` main 上 ${String(base).slice(0, 7)} 那一份` : ' main 上那一份'
  if (!hasFindings(report)) {
    lines.push('这个 PR 没有删门禁里的行，测试用例和断言也没有变少。', '', `（名单和脚本用的是${source}。）`, '')
    return lines.join('\n')
  }
  lines.push(
    '这个 PR 删掉或改掉了门禁里的东西，列在下面。**只是提醒，不挡合并。**',
    '',
    '- 是放宽安全校验、少跑检查、少测东西的：要 yoyo **亲手打字同意**才能合，PR 正文里写明他同意的那句话。',
    '- 只是挪位置、删重复、换写法、跟着删掉的功能一起删的：在 PR 正文里说一句为什么就行。',
    '',
    `名单和脚本用的是${source}，PR 里改它们只影响以后的 PR。`,
    '',
  )
  const byGuard = new Map()
  for (const finding of report.guards) {
    if (!byGuard.has(finding.guard.id)) byGuard.set(finding.guard.id, { guard: finding.guard, findings: [] })
    byGuard.get(finding.guard.id).findings.push(finding)
  }
  let section = 0
  for (const { guard, findings } of byGuard.values()) {
    section += 1
    lines.push(`### ${section}. ${guard.title}`, '')
    for (const finding of findings) lines.push(...guardSection(finding))
    lines.push('')
  }
  if (report.tests.length) {
    section += 1
    lines.push(`### ${section}. 测试少了用例或断言、多了跳过`, '', '| 文件 | 用例 | 断言 | 跳过（.skip / .only / .todo） |', '| --- | --- | --- | --- |')
    for (const finding of report.tests) {
      const name = !finding.newPath ? `${inlineCode(finding.oldPath)}（整份删掉）`
        : finding.oldPath && finding.oldPath !== finding.newPath ? `${inlineCode(finding.oldPath)} → ${inlineCode(finding.newPath)}`
          : inlineCode(finding.newPath)
      lines.push(`| ${name} | ${change(finding.before.cases, finding.after.cases)} | ${change(finding.before.assertions, finding.after.assertions)} | ${change(finding.before.skips, finding.after.skips)} |`)
    }
    lines.push('')
  }
  if (report.scripts) {
    section += 1
    lines.push(`### ${section}. npm test、typecheck 这几条命令跑的东西少了`, '')
    if (report.scripts.unreadable) lines.push('改动后的 package.json 读不出来（不是合法的 JSON）。', '')
    else lines.push(`少了：${report.scripts.removed.slice(0, LISTED_LINES_PER_FILE).map(inlineCode).join('、')}${report.scripts.removed.length > LISTED_LINES_PER_FILE ? ` 等 ${report.scripts.removed.length} 项` : ''}`, '', '尖括号里的是整条命令被删掉了，其余是命令里的一段（套件文件、参数）。', '')
  }
  return lines.join('\n')
}

function escapeData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function escapeProperty(value) {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

function annotation({ file, line, text }) {
  const properties = [
    file ? `file=${escapeProperty(file)}` : '',
    file && line ? `line=${line}` : '',
    `title=${escapeProperty('门禁删行提醒')}`,
  ].filter(Boolean).join(',')
  return `::warning ${properties}::${escapeData(text)}`
}

// 标注挂在改动后那一版的行上，PR 的 Files changed 里就能在原处看到。只删不加的地方，GitHub
// 给的新行号是删除点的上一行，0 表示文件开头。
function buildAnnotations(report) {
  const notes = []
  const consent = '是放宽就要 yoyo 亲手打字同意，只是挪动或换写法在 PR 正文里说一句；详见这次运行的摘要。'
  for (const finding of report.guards) {
    const total = finding.deletedFile ? finding.lines : finding.hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0)
    const what = finding.deletedFile ? `整份删掉了 ${plainPath(finding.oldPath)}` : `删掉或改掉 ${total} 行`
    const line = finding.hunks.length ? Math.max(1, finding.hunks[0].newStart) : undefined
    notes.push({ file: finding.newPath, line, text: `${finding.guard.title}：${what}。${consent}` })
  }
  for (const finding of report.tests) {
    const parts = []
    if (finding.after.cases < finding.before.cases) parts.push(`用例 ${finding.before.cases} → ${finding.after.cases}`)
    if (finding.after.assertions < finding.before.assertions) parts.push(`断言 ${finding.before.assertions} → ${finding.after.assertions}`)
    if (finding.after.skips > finding.before.skips) parts.push(`跳过 ${finding.before.skips} → ${finding.after.skips}`)
    const what = finding.newPath ? parts.join('，') : `整份删掉了 ${plainPath(finding.oldPath)}`
    notes.push({ file: finding.newPath, text: `测试变少了：${what}。${consent}` })
  }
  if (report.scripts) notes.push({ file: 'package.json', text: `npm test、typecheck 这几条命令跑的东西少了。${consent}` })
  const shown = notes.slice(0, ANNOTATION_LIMIT).map(annotation)
  if (notes.length > ANNOTATION_LIMIT) shown.push(annotation({ text: `还有 ${notes.length - ANNOTATION_LIMIT} 处没标出来，详见这次运行的摘要。` }))
  return shown
}

function pullRequestRange(event) {
  const pull = event?.pull_request
  const number = pull?.number
  const base = pull?.base?.sha
  const head = pull?.head?.sha
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('事件里没有合法的 PR 编号，这一步只在 pull_request_target 上跑。')
  if (![base, head].every((value) => typeof value === 'string' && COMMIT.test(value))) throw new Error('事件里没有合法的提交号。')
  return { number, base: base.toLowerCase(), head: head.toLowerCase() }
}

// PR 的提交只拉进来当数据读，不检出到工作区，更不执行。fork 来的 PR 也挂在目标仓库的
// refs/pull/<编号>/head 上。
function fetchPullRequest(repository, range, run = execFileSync) {
  git(repository, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${range.number}/head:refs/remotes/origin/removed-guards-head`], run)
  try {
    git(repository, ['cat-file', '-e', `${range.head}^{commit}`], run)
  } catch {
    throw new Error(`拉到的 PR 里没有提交 ${range.head.slice(0, 7)}：这次运行开始以后 PR 又换了提交，新推的那次运行会接着查。`)
  }
  let from
  try {
    from = git(repository, ['merge-base', range.base, range.head], run).trim()
  } catch {
    throw new Error(`找不到 ${range.base.slice(0, 7)} 和 ${range.head.slice(0, 7)} 的共同起点，没法算出这个 PR 改了什么。`)
  }
  if (!COMMIT.test(from)) throw new Error('算出来的共同起点不是提交号。')
  return from
}

function runInActions({ env = process.env, repository = process.cwd(), run = execFileSync, log = console.log } = {}) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const range = pullRequestRange(event)
  const from = fetchPullRequest(repository, range, run)
  const base = git(repository, ['rev-parse', 'HEAD'], run).trim()
  const report = buildReport({ repository, from, head: range.head, run })
  // 日志里只打自己写的字和处理过的路径：PR 里的原文打到标准输出，以 :: 开头的一行会被当成
  // 工作流命令。原文只进摘要页。
  for (const line of buildAnnotations(report)) log(line)
  log(hasFindings(report)
    ? `门禁删行提醒：${report.guards.length} 份门禁文件、${report.tests.length} 份测试文件有删减${report.scripts ? '，npm 测试命令少了东西' : ''}，详见摘要。`
    : '门禁删行提醒：没有删门禁里的行，测试也没有变少。')
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${formatMarkdown(report, { base })}\n`, 'utf8')
  return report
}

if (require.main === module) {
  try {
    const [from, head] = process.argv.slice(2)
    if (from && head) {
      const repository = process.cwd()
      const base = git(repository, ['merge-base', from, head]).trim()
      console.log(formatMarkdown(buildReport({ repository, from: base, head }), { base: git(repository, ['rev-parse', from]).trim() }))
    } else {
      runInActions()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  GUARDS,
  buildAnnotations,
  buildReport,
  fetchPullRequest,
  formatMarkdown,
  guardFor,
  hasFindings,
  isTestFile,
  parseHunks,
  parseNameStatus,
  pullRequestRange,
  resolveRegion,
  runInActions,
  scriptTokens,
  testCounts,
}
