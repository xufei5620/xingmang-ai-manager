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

module.exports = { extractReleaseNotes, parseArguments, main }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`取出更新说明失败：${error.message}\n`)
    process.exitCode = 1
  }
}
