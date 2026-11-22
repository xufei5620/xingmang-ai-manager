const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
// The update page's cap and the way it counts entries live with the build step
// that enforces them, so the check below can never count differently.
const { MAX_ITEMS: maxUserItems, splitReleaseNoteItems } = require('./bundle-release-notes.cjs')

const fragmentDirectory = 'changes/unreleased'
// README.md documents the format and TEMPLATE.md.example keeps the directory in
// git once a release has collected every real fragment away.
const reservedFragmentNames = new Set(['README.md'])

// release-notes.md has no Markdown headings at all: a version is a bare line and
// everything else is a bullet, so "not a bullet and not indented" is what starts
// a new section there. CHANGELOG.md has a quoted header block above its first
// version, which is why that file needs the stricter `## ` test.
function isReleaseNotesHeading(line) {
  return line.trim() !== '' && !line.startsWith('- ') && !line.startsWith(' ')
}

function isChangelogHeading(line) {
  return line.startsWith('## ')
}

const sections = [
  {
    key: 'user',
    heading: '## 用户',
    file: 'release-notes.md',
    unreleasedHeading: '未发布',
    isHeading: isReleaseNotesHeading,
  },
  {
    key: 'developer',
    heading: '## 开发',
    file: 'CHANGELOG.md',
    unreleasedHeading: '## Unreleased',
    isHeading: isChangelogHeading,
  },
]

function splitLines(source) {
  return source.replace(/\r\n/g, '\n').split('\n')
}

function parseFragment(name, source) {
  const entries = { user: [], developer: [] }
  const declared = new Set()
  let current = null

  for (const [index, rawLine] of splitLines(source).entries()) {
    const line = rawLine.trimEnd()
    const position = `${fragmentDirectory}/${name}:${index + 1}`
    if (line === '') continue

    if (line.startsWith('#')) {
      const section = sections.find((entry) => entry.heading === line)
      if (!section) {
        throw new Error(`${position} 不认识的小节标题「${line}」，只能是「## 用户」或「## 开发」`)
      }
      if (declared.has(section.key)) {
        throw new Error(`${position} 小节「${line}」重复了，每个小节只能写一次`)
      }
      declared.add(section.key)
      current = section.key
      continue
    }

    if (current === null) {
      throw new Error(`${position} 内容必须写在「## 用户」或「## 开发」小节下面`)
    }
    if (line.startsWith('- ')) {
      entries[current].push(line)
      continue
    }
    if (/^ {2}\S/.test(line) && entries[current].length > 0) {
      entries[current].push(line)
      continue
    }
    throw new Error(`${position} 每个非空行都要以「- 」开头，一条写不下时续行缩进两个空格`)
  }

  if (entries.user.length === 0 && entries.developer.length === 0) {
    throw new Error(`${fragmentDirectory}/${name} 是空的，至少要填「## 用户」或「## 开发」其中一节`)
  }
  return entries
}

// ui-spec/CHANGELOG.md logs interface changes, one line each, newest first.
// Every UI pull request used to add its line at the top of that file, so with a
// dozen in flight each merge left the others conflicting on that spot, and a
// conflicting pull request gets no CI and its auto-merge stalls without a word
// (#2091 hit it once, #2097 three times, 2026-11-22). The line now goes in a
// file of its own here, and collect moves them into the log by date.
const uiSpecFragmentDirectory = 'ui-spec/changes'
const uiSpecChangelogFile = 'ui-spec/CHANGELOG.md'
const reservedUiSpecFragmentNames = new Set(['README.md'])
// The log's own format line: 日期 · 版本 · 层级 · 改了什么 · 为什么 · 影响的页面.
// Only the date is machine-read, to order the collected lines.
const uiSpecEntryPattern = /^- (\d{4})-(\d{2})-(\d{2}) · \S/

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
}

function parseUiSpecFragment(name, source) {
  const entries = []
  for (const [index, rawLine] of splitLines(source).entries()) {
    const line = rawLine.trimEnd()
    const position = `${uiSpecFragmentDirectory}/${name}:${index + 1}`
    if (line === '') continue

    if (line.startsWith('- ')) {
      const match = uiSpecEntryPattern.exec(line)
      if (!match) {
        throw new Error(`${position} 每条要以「- 日期 · 」开头，跟 ${uiSpecChangelogFile} 里的格式一样，例如「- 2026-11-22 · v4.0 · 受控 · 改了什么 · 为什么 · 影响的页面」`)
      }
      if (!isValidCalendarDate(match[1], match[2], match[3])) {
        throw new Error(`${position} 日期「${match[1]}-${match[2]}-${match[3]}」不存在`)
      }
      entries.push({ date: `${match[1]}-${match[2]}-${match[3]}`, lines: [line] })
      continue
    }
    if (/^ {2}\S/.test(line) && entries.length > 0) {
      entries[entries.length - 1].lines.push(line)
      continue
    }
    throw new Error(`${position} 每个非空行都要以「- 日期 · 」开头（不写小节标题），一条写不下时续行缩进两个空格`)
  }

  if (entries.length === 0) {
    throw new Error(`${uiSpecFragmentDirectory}/${name} 是空的，至少写一条「- 日期 · …」`)
  }
  return entries
}

function pendingUiSpecFragmentNames(root) {
  const directory = path.join(root, uiSpecFragmentDirectory)
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.md') && !reservedUiSpecFragmentNames.has(name))
    .sort()
}

function readUiSpecFragments(root) {
  return pendingUiSpecFragmentNames(root).map((name) => ({
    name,
    entries: parseUiSpecFragment(name, fs.readFileSync(path.join(root, uiSpecFragmentDirectory, name), 'utf8')),
  }))
}

// Newest date first, as the log reads. Lines that share a date keep the order
// of their file names and, inside one file, the order they were written in:
// the sort is stable.
function orderUiSpecEntries(fragments) {
  return fragments
    .flatMap((fragment) => fragment.entries)
    .sort((left, right) => (left.date === right.date ? 0 : left.date < right.date ? 1 : -1))
}

// Every collected line is newer than the ones already in the log, so they go
// above its first entry and below the title and format lines.
function insertUiSpecEntries(source, entries) {
  if (entries.length === 0) return source
  const added = entries.flatMap((entry) => entry.lines)
  const lines = splitLines(source)
  const first = lines.findIndex((line) => line.startsWith('- '))
  if (first !== -1) {
    lines.splice(first, 0, ...added)
    return lines.join('\n')
  }
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end -= 1
  return [...lines.slice(0, end), '', ...added, ''].join('\n')
}

function countUiSpecEntries(source) {
  return splitLines(source).filter((line) => line.startsWith('- ')).length
}

function collectUiSpecChanges(root, fragments = readUiSpecFragments(root)) {
  if (fragments.length === 0) return { fragments: [], count: 0 }
  const entries = orderUiSpecEntries(fragments)
  const file = path.join(root, uiSpecChangelogFile)
  fs.writeFileSync(file, insertUiSpecEntries(fs.readFileSync(file, 'utf8'), entries), 'utf8')
  for (const fragment of fragments) {
    fs.rmSync(path.join(root, uiSpecFragmentDirectory, fragment.name))
  }
  return { fragments: fragments.map((fragment) => fragment.name), count: entries.length }
}

// When the product owner signs off a version's customer notes as a whole
// (0.2.24: six lines, word for word, 2026-11-18), the notes live in this one
// fragment and every other fragment may carry only a developer half. Without
// this gate the next PR that follows the usual recipe quietly adds a line to
// notes that were approved as they stand. Collect removes this fragment along
// with the rest, so the freeze ends with the release that ships it.
const finalUserNotesFragment = 'final-user-notes.md'

function assertUserNotesNotFinalized(fragments) {
  if (!fragments.some((fragment) => fragment.name === finalUserNotesFragment)) return
  const extra = fragments.filter((fragment) => fragment.name !== finalUserNotesFragment && fragment.entries.user.length > 0)
  if (extra.length === 0) return
  throw new Error(
    `这一版给客户看的更新说明已经定稿，整份写在 ${fragmentDirectory}/${finalUserNotesFragment}，别的分片只能写「## 开发」。`
    + `请删掉这几个分片里的「## 用户」：${extra.map((fragment) => fragment.name).join('、')}。`
    + `客户那份真要加一句，先把逐字的新句子给产品所有者看，同意了再改 ${finalUserNotesFragment} 那一个文件。`,
  )
}

function pendingFragmentNames(root) {
  const directory = path.join(root, fragmentDirectory)
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.md') && !reservedFragmentNames.has(name))
    .sort()
}

function readFragments(root) {
  return pendingFragmentNames(root).map((name) => ({
    name,
    entries: parseFragment(name, fs.readFileSync(path.join(root, fragmentDirectory, name), 'utf8')),
  }))
}

// A release collects every fragment away, so one still here when a public
// release is dispatched was merged after the collect, or missed by it. Its
// change ships in this build all the same, while the notes customers read say
// nothing and CHANGELOG.md later files it under the next version (#1086). This
// asks the same question collect does, so the two can never disagree about
// what a fragment is.
function assertAllCollected(root) {
  const pending = pendingFragmentNames(root)
  if (pending.length === 0) return
  throw new Error(
    `${fragmentDirectory} 下还有 ${pending.length} 个没汇总的分片：${pending.join('、')}。`
    + '这些改动会进这次的包，发版前先运行 npm run changelog:collect，把它们并进这一版的更新说明。',
  )
}

function sectionBounds(lines, section) {
  const start = lines.findIndex((line) => line.trimEnd() === section.unreleasedHeading)
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && !section.isHeading(lines[end])) end += 1
  // Trailing blank lines belong to the gap before the next version, not to the
  // section, so appended entries have to land above them.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return { start, end }
}

function readUnreleasedSection(source, section) {
  const lines = splitLines(source)
  const bounds = sectionBounds(lines, section)
  if (bounds === null) return []
  return lines.slice(bounds.start + 1, bounds.end).filter((line) => line.trim() !== '')
}

function appendToUnreleasedSection(source, section, entries) {
  if (entries.length === 0) return source
  const lines = splitLines(source)
  const bounds = sectionBounds(lines, section)

  if (bounds === null) {
    // The previous release renamed the heading to its version number, so the
    // section has to be recreated above the newest one.
    const firstHeading = lines.findIndex(section.isHeading)
    const insertAt = firstHeading === -1 ? lines.length : firstHeading
    const block = [section.unreleasedHeading, '', ...entries, '']
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '') block.unshift('')
    lines.splice(insertAt, 0, ...block)
    return lines.join('\n')
  }

  const block = bounds.end === bounds.start + 1 ? ['', ...entries] : entries
  lines.splice(bounds.end, 0, ...block)
  return lines.join('\n')
}

function collectChanges(root) {
  const fragments = readFragments(root)
  assertUserNotesNotFinalized(fragments)
  const written = []
  for (const section of sections) {
    const entries = fragments.flatMap((fragment) => fragment.entries[section.key])
    if (entries.length === 0) continue
    const file = path.join(root, section.file)
    fs.writeFileSync(file, appendToUnreleasedSection(fs.readFileSync(file, 'utf8'), section, entries), 'utf8')
    written.push({ file: section.file, count: entries.filter((entry) => entry.startsWith('- ')).length })
  }
  for (const fragment of fragments) {
    fs.rmSync(path.join(root, fragmentDirectory, fragment.name))
  }
  return { fragments: fragments.map((fragment) => fragment.name), written }
}

function changedFileStatuses(root, event, eventName, git = execFileSync) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before
  const head = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after
  if (![base, head].every((value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value))) return null
  if (/^0+$/.test(base)) return null
  let output
  try {
    output = git('git', ['diff', '--name-status', '-z', base, head, '--'], { cwd: root, encoding: 'utf8' })
  } catch {
    // A shallow checkout cannot reach the base commit. Skipping beats failing a
    // job over a fetch depth the gate does not control; the `changes` job checks
    // out full history precisely so this stays reachable there.
    return null
  }
  const fields = output.split('\0').filter(Boolean)
  const changes = []
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index][0]
    // Renames and copies spell out both paths; only the destination matters here.
    const width = status === 'R' || status === 'C' ? 2 : 1
    changes.push({ status, file: fields[index + width] })
    index += width
  }
  return { base, changes: changes.filter((change) => typeof change.file === 'string') }
}

function fileAtRevision(root, revision, file, git = execFileSync) {
  try {
    return git('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function assertNoDirectUnreleasedEdit(root, event, eventName, git = execFileSync) {
  const diff = changedFileStatuses(root, event, eventName, git)
  if (diff === null) return
  // A release collects every fragment away in the same commit that fills the two
  // unreleased sections, which is the one legitimate direct edit.
  const collecting = diff.changes.some((change) => (
    change.status === 'D' && change.file.startsWith(`${fragmentDirectory}/`)
  ))
  if (collecting) return

  for (const section of sections) {
    if (!diff.changes.some((change) => change.file === section.file)) continue
    const before = readUnreleasedSection(fileAtRevision(root, diff.base, section.file, git), section)
    const after = readUnreleasedSection(fs.readFileSync(path.join(root, section.file), 'utf8'), section)
    if (before.join('\n') === after.join('\n')) continue
    throw new Error(
      `${section.file} 的「${section.unreleasedHeading}」段被直接改动了。`
      + `并行 PR 都往这一段加行会互相冲突，请改为在 ${fragmentDirectory}/ 下加一个分片文件，写法见该目录的 README.md。`,
    )
  }
}

const commitPattern = /^[0-9a-f]{40}$/i

function uiSpecFragmentsAtRevision(root, revision, git) {
  const output = git('git', ['ls-tree', '--name-only', '-z', revision, `${uiSpecFragmentDirectory}/`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return output.split('\0')
    .filter(Boolean)
    .map((file) => path.posix.basename(file))
    .filter((name) => name.endsWith('.md') && !reservedUiSpecFragmentNames.has(name))
}

// Compares the pull request's head with the commit it forked from, the same
// two-sided view as its "Files changed" tab. The event's base SHA is the tip of
// main when the event fired, which can be well past the fork, so diffing
// against it would count every line main gained since (a collect, above all)
// as one this pull request added.
//
// Only a pull request is stopped. Ones whose CI passed before this check
// existed can still merge with a line in the old place; failing main's run over
// that would leave main red with nothing its authors could still change.
function assertNoDirectUiSpecChangelogEdit(root, event, eventName, git = execFileSync) {
  if (eventName !== 'pull_request') return
  const base = event.pull_request?.base?.sha
  const head = event.pull_request?.head?.sha
  if (![base, head].every((value) => typeof value === 'string' && commitPattern.test(value))) return
  let forkPoint
  let collected
  try {
    forkPoint = git('git', ['merge-base', base, head], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!commitPattern.test(forkPoint)) return
    const kept = new Set(uiSpecFragmentsAtRevision(root, head, git))
    // A collect deletes the fragments in the same commit that writes their
    // lines into the log, which is the one legitimate way the log grows.
    collected = uiSpecFragmentsAtRevision(root, forkPoint, git).some((name) => !kept.has(name))
  } catch {
    // Same as changedFileStatuses: an unreachable commit skips the comparison
    // rather than failing a job over a fetch depth this check does not own.
    return
  }
  if (collected) return

  const added = countUiSpecEntries(fileAtRevision(root, head, uiSpecChangelogFile, git))
    - countUiSpecEntries(fileAtRevision(root, forkPoint, uiSpecChangelogFile, git))
  if (added <= 0) return
  throw new Error(
    `${uiSpecChangelogFile} 里直接加了 ${added} 条记录。并行的界面 PR 都往这个文件最上面加行，合进去一个其余的就全冲突，`
    + '带冲突的 PR 不跑 CI、自动合并也会卡住。'
    + `请把这几行原样挪到 ${uiSpecFragmentDirectory}/ 下一个新文件里（文件名用这次改动的短名，写法见该目录的 README.md），`
    + `发版时 npm run changelog:collect 会按日期把它们汇总回 ${uiSpecChangelogFile}。`,
  )
}

// What release-notes.md's unreleased section will hold once collect runs: the
// entries already there plus every fragment's user half.
function countUserItems(root, fragments) {
  const section = sections.find((entry) => entry.key === 'user')
  const collected = readUnreleasedSection(fs.readFileSync(path.join(root, section.file), 'utf8'), section)
  const pending = fragments.flatMap((fragment) => fragment.entries.user)
  return splitReleaseNoteItems([...collected, ...pending].join('\n')).length
}

// bundle-release-notes.cjs refuses a version over the cap, but only at release
// time, after the version bump; by then a dozen merged PRs have to be squeezed
// in a hurry. 0.2.24 reached 70 user entries with every PR green, because this
// check never counted. Counting here fails the PR whose fragment tips it over,
// while its author can still merge entries.
function assertUserItemsFit(root, fragments) {
  const count = countUserItems(root, fragments)
  if (count <= maxUserItems) return count
  throw new Error(
    `给客户看的「## 用户」合起来已经 ${count} 条，装完后的更新页一版最多放 ${maxUserItems} 条，超了发版构建会报错。`
    + `请把相近的几条并成一条（可以并进别的分片已有的那一条，被并掉的分片只留「## 开发」），压到 ${maxUserItems} 条以内；`
    + '客户报过的问题（001- 开头的分片）放在最前面。',
  )
}

function checkChanges(root) {
  const fragments = readFragments(root)
  const uiSpecFragments = readUiSpecFragments(root)
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (eventPath && fs.existsSync(eventPath)) {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    assertNoDirectUnreleasedEdit(root, event, process.env.GITHUB_EVENT_NAME)
    assertNoDirectUiSpecChangelogEdit(root, event, process.env.GITHUB_EVENT_NAME)
  }
  assertUserNotesNotFinalized(fragments)
  return { fragments, uiSpecFragments, userItems: assertUserItemsFit(root, fragments) }
}

if (require.main === module) {
  // Both npm scripts run from the repository root; resolving from cwd is what
  // lets the tests exercise this entry point against a fixture tree.
  const root = process.cwd()
  const argv = process.argv.slice(2)
  try {
    if (argv.includes('--assert-collected')) {
      assertAllCollected(root)
      console.log(`${fragmentDirectory} 下的分片都已汇总`)
    } else if (argv.includes('--check')) {
      const { fragments, uiSpecFragments, userItems } = checkChanges(root)
      const userSummary = `「## 用户」合计 ${userItems} 条（一版最多 ${maxUserItems} 条）`
      console.log(fragments.length === 0
        ? `变更分片校验通过：本次没有分片，${userSummary}`
        : `变更分片校验通过：${fragments.length} 个分片，${userSummary}（${fragments.map((fragment) => fragment.name).join('、')}）`)
      console.log(`界面改动分片校验通过：${uiSpecFragmentDirectory} 下 ${uiSpecFragments.length} 个`)
    } else {
      // Parsed before anything is written, so a malformed interface fragment
      // stops the collect while release-notes.md and CHANGELOG.md are untouched.
      const uiSpecFragments = readUiSpecFragments(root)
      const result = collectChanges(root)
      if (result.fragments.length === 0) {
        console.log(`${fragmentDirectory} 下没有待汇总的分片`)
      } else {
        for (const { file, count } of result.written) console.log(`已汇入 ${file}：${count} 条`)
        console.log(`已删除 ${result.fragments.length} 个分片：${result.fragments.join('、')}`)
      }
      const uiSpec = collectUiSpecChanges(root, uiSpecFragments)
      if (uiSpec.fragments.length === 0) {
        console.log(`${uiSpecFragmentDirectory} 下没有待汇总的界面改动分片`)
      } else {
        console.log(`已汇入 ${uiSpecChangelogFile}：${uiSpec.count} 条`)
        console.log(`已删除 ${uiSpec.fragments.length} 个界面改动分片：${uiSpec.fragments.join('、')}`)
      }
    }
  } catch (error) {
    console.error(`变更分片处理失败：${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  appendToUnreleasedSection,
  assertAllCollected,
  assertNoDirectUiSpecChangelogEdit,
  assertNoDirectUnreleasedEdit,
  assertUserItemsFit,
  assertUserNotesNotFinalized,
  changedFileStatuses,
  checkChanges,
  collectChanges,
  collectUiSpecChanges,
  countUserItems,
  finalUserNotesFragment,
  insertUiSpecEntries,
  orderUiSpecEntries,
  parseFragment,
  parseUiSpecFragment,
  readFragments,
  readUiSpecFragments,
  readUnreleasedSection,
  sections,
  uiSpecChangelogFile,
  uiSpecFragmentDirectory,
}
