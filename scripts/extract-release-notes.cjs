// 发布工具：从 release-notes.md 里取出一个版本那一节。
//
// GitHub Release 的正文直接塞整份 release-notes.md 的话，读者看到的是从 0.1.x 起
// 的全部历史；而这份文件本身是给客户端更新页用的，按版本号分节，节与节之间没有
// 标题层级，只有"一行只有版本号"这一条边界。
//
// 只允许取第一节，也就是文件最上面那一版。release-notes.md 的首行必须等于
// package.json 的版本号（审查总表 P-14，发布前置检查会拦），所以"要发的那一版"
// 必然是第一节；取到别的节，说明版本收口那一步没做或者做错了，这时候宁可失败。
const fs = require('node:fs')
const path = require('node:path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const VERSION_HEADING = /^\d+\.\d+\.\d+$/

function extractReleaseNotes(source, version) {
  if (!VERSION_HEADING.test(String(version || ''))) throw new Error('版本号格式无效。')
  const lines = String(source).split(/\r?\n/)
  const headings = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => VERSION_HEADING.test(entry.line))
  if (headings.length === 0) throw new Error('更新说明里找不到任何版本小节。')
  if (headings[0].line !== version) {
    throw new Error(`更新说明的第一节是 ${headings[0].line}，不是要发布的 ${version}。`)
  }
  const end = headings.length > 1 ? headings[1].index : lines.length
  const body = lines.slice(headings[0].index + 1, end).join('\n').trim()
  if (!body) throw new Error(`${version} 这一节是空的。`)
  return `${body}\n`
}

// 更新清单（latest.yml、latest-mac.yml、Linux 的那几份）里的 releaseNotes 只带要发的这一版。
// 原来 electron-builder.config.cjs 用 releaseInfo.releaseNotesFile 指着整份 release-notes.md，
// electron-builder 把从 0.1.x 起的全部历史（二十多万字）原样写进清单；客户端截前 20000 字，
// 0.2.22、0.2.23 的版本页把它塞成一整段，要装的那一版后面还接着前几版，「重启并安装」被挤到
// 最底下（yoyo 2026-11-10「清单改」）。这一节不带版本号那一行：版本页的标题已经写着版本号，
// 新版界面（release-notes.ts 的 releaseNoteItems）也把没有版本行的说明当成就是这一版。
//
// 首节不是这一版时返回 null，由调用方照原来整份写进去：升级冒烟、出测试包会把版本号临时调到
// 比所有已发版本都高，首节对不上是正常的；真发版有发布前置检查拦着首行必须等于版本号（P-14），
// 走不到这一步。
function feedReleaseNotes(source, version) {
  try {
    return extractReleaseNotes(source, version).trimEnd()
  } catch {
    return null
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag !== '--version' && flag !== '--output') || options[flag] !== undefined || !value || value.startsWith('--')) {
      throw new Error('参数无效：需要 --version 和 --output。')
    }
    options[flag] = value
  }
  if (!options['--version'] || !options['--output']) throw new Error('缺少 --version 或 --output。')
  return { version: options['--version'], outputPath: options['--output'] }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'release-notes.md'), 'utf8')
  const notes = extractReleaseNotes(source, options.version)
  fs.writeFileSync(options.outputPath, notes, { mode: 0o600 })
  process.stdout.write(`已取出 ${options.version} 的更新说明（${notes.split('\n').length - 1} 行）：${options.outputPath}\n`)
}

module.exports = { extractReleaseNotes, feedReleaseNotes, parseArguments, main }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`取出更新说明失败：${error.message}\n`)
    process.exitCode = 1
  }
}
