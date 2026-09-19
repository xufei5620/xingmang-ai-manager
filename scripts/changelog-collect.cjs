const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

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

function readFragments(root) {
  const directory = path.join(root, fragmentDirectory)
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.md') && !reservedFragmentNames.has(name))
    .sort()
    .map((name) => ({
      name,
      entries: parseFragment(name, fs.readFileSync(path.join(directory, name), 'utf8')),
    }))
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

function checkChanges(root) {
  const fragments = readFragments(root)
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (eventPath && fs.existsSync(eventPath)) {
    assertNoDirectUnreleasedEdit(root, JSON.parse(fs.readFileSync(eventPath, 'utf8')), process.env.GITHUB_EVENT_NAME)
  }
  return fragments
}

if (require.main === module) {
  // Both npm scripts run from the repository root; resolving from cwd is what
  // lets the tests exercise this entry point against a fixture tree.
  const root = process.cwd()
  const checkOnly = process.argv.slice(2).includes('--check')
  try {
    if (checkOnly) {
      const fragments = checkChanges(root)
      console.log(fragments.length === 0
        ? '变更分片校验通过：本次没有分片'
        : `变更分片校验通过：${fragments.length} 个分片（${fragments.map((fragment) => fragment.name).join('、')}）`)
    } else {
      const result = collectChanges(root)
      if (result.fragments.length === 0) {
        console.log(`${fragmentDirectory} 下没有待汇总的分片`)
      } else {
        for (const { file, count } of result.written) console.log(`已汇入 ${file}：${count} 条`)
        console.log(`已删除 ${result.fragments.length} 个分片：${result.fragments.join('、')}`)
      }
    }
  } catch (error) {
    console.error(`变更分片处理失败：${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  appendToUnreleasedSection,
  assertNoDirectUnreleasedEdit,
  changedFileStatuses,
  checkChanges,
  collectChanges,
  parseFragment,
  readFragments,
  readUnreleasedSection,
  sections,
}
