// 构建工具：把 release-notes.md 顶上那一版的改动写成包内的一个小 JSON。
//
// 为什么要随包带：更新说明原来只在「发现新版本」那一刻由更新清单带下来，用户点了
// 「重启并安装」、软件重新打开之后反而什么都看不到。装完的第一次启动要能说出
// 「已更新到 x.y.z，这版改了这些」，而那时不该再依赖网络，所以这份内容必须在包里。
//
// 写进 dist-electron/：electron-builder 的 files 本来就整目录收它（进 app.asar），
// 主进程只读不写，不需要 extraResources 那种放在 asar 外面的副本。
//
// 顶节不是 package.json 的版本（日常 CI 测试包、还没做版本收口的构建）时写 notes: null，
// 不让构建失败：正式发版由发布前置检查（P-14）与 extract-release-notes.cjs 各拦一道，
// 这里宁可「这一版没有随包说明」，也不能把上一版的改动当成这一版显示给用户。
const fs = require('node:fs')
const path = require('node:path')
const { extractReleaseNotes } = require('./extract-release-notes.cjs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'dist-electron', 'release-notes.json')
// 主进程读取时同样有上限（electron/installed-release.ts），这里先截住，免得构建出一个
// 运行时会整份丢弃的文件而没人发现。
const MAX_ITEMS = 60
const MAX_ITEM_LENGTH = 1000

function isAsciiWordCharacter(character) {
  return /[A-Za-z0-9]/.test(character || '')
}

// 续行在源文件里只是为了折行，拼回去时中文之间不该多出空格，英文单词之间则要补一个。
function joinWrappedLine(previous, next) {
  if (!previous) return next
  const needsSpace = isAsciiWordCharacter(previous[previous.length - 1]) && isAsciiWordCharacter(next[0])
  return `${previous}${needsSpace ? ' ' : ''}${next}`
}

// 更新页按纯文本显示，Markdown 的反引号原样出现只会让人看不懂，换成中文引号。
function plainText(item) {
  return item.replace(/`([^`\n]+)`/g, '「$1」').replace(/\s+/g, ' ').trim()
}

function splitReleaseNoteItems(body) {
  const items = []
  for (const rawLine of String(body).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (rawLine.startsWith('- ')) {
      items.push(line.slice(2).trim())
    } else if (items.length > 0) {
      items[items.length - 1] = joinWrappedLine(items[items.length - 1], line)
    } else {
      items.push(line)
    }
  }
  return items
    .map(plainText)
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((item) => (item.length > MAX_ITEM_LENGTH ? `${item.slice(0, MAX_ITEM_LENGTH - 1)}…` : item))
}

function buildBundledReleaseNotes(source, version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) throw new Error('版本号格式无效。')
  // extractReleaseNotes 只认版本号那样的行，会越过顶上的「未发布」去取下面那一版；
  // 这里要求文件第一行就是这一版（与发布前置检查 P-14 同一条规矩）。
  const firstLine = String(source).split(/\r?\n/).find((line) => line.trim() !== '')
  if (firstLine?.trim() !== version) return { version, notes: null }
  let body
  try {
    body = extractReleaseNotes(source, version)
  } catch {
    return { version, notes: null }
  }
  const notes = splitReleaseNoteItems(body)
  return { version, notes: notes.length > 0 ? notes : null }
}

function parseArguments(argv) {
  if (argv.length === 0) return { outputPath: DEFAULT_OUTPUT }
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1] || argv[1].startsWith('--')) {
    throw new Error('参数无效：只接受 --output <文件路径>。')
  }
  return { outputPath: path.resolve(argv[1]) }
}

function main(argv = process.argv.slice(2)) {
  const { outputPath } = parseArguments(argv)
  const version = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'release-notes.md'), 'utf8')
  const bundled = buildBundledReleaseNotes(source, version)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(bundled, null, 2)}\n`, 'utf8')
  const summary = bundled.notes ? `${bundled.notes.length} 条` : '顶节不是这一版，未带说明'
  process.stdout.write(`已写入 ${version} 的随包更新说明（${summary}）：${path.relative(PROJECT_ROOT, outputPath)}\n`)
}

module.exports = { buildBundledReleaseNotes, splitReleaseNoteItems, parseArguments, main, MAX_ITEMS, MAX_ITEM_LENGTH }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`写入随包更新说明失败：${error.message}\n`)
    process.exitCode = 1
  }
}
