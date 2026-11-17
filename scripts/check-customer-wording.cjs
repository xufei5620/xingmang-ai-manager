'use strict'
// 客户看得到的字里有没有不该出现的词（2026-11-17，对照官方「验证」文章的建议第 8 条）。
//
// yoyo 定过的口径：界面文案不出现技术词（PATH、npm、TOML、环境变量这类）；界面上不出现站点名和
// Sub2API，用「当前账号」当主语；「Key」叫「密钥」。这些以前只靠各页面测试里零散的
// `not.toMatch(...)` 各管各的，没有一道全局的检查，新页面、新报错里漏进去没人发现。
//
// **先只报不拦**：这条命令永远以 0 退出，CI 里把结果写进作业摘要。误报调干净了，再另写一道
// `verify-*.test.cjs` 进 `npm test` 拦下（`scanCustomerWording` 导出就是为了那一步）。
//
// 用 TypeScript 读源码而不是 grep：同一个 `npm` 可能是包名常量、日志、正则里比对的报错原文，
// 只有会上屏的那几种算数——JSX 里的字、带中文的字符串、标题和读屏标签这类属性的值。
// 识别不了的写法宁可漏报：这是提醒，不是安全边界。

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '..')

const technicalRule = '界面不出现技术词（PATH、npm、TOML、环境变量这类）'
const siteRule = '界面不出现站点名和 Sub2API，用「当前账号」当主语'

const bannedWords = [
  { word: 'PATH', pattern: /\bPATH\b/, rule: technicalRule },
  { word: 'npm', pattern: /\bnpm\b/i, rule: technicalRule },
  // `config.toml` 这种文件名也算：露给客户的同样是技术词。
  { word: 'TOML', pattern: /\btoml\b/i, rule: technicalRule },
  { word: '环境变量', pattern: /环境变量/, rule: technicalRule },
  { word: 'Sub2API', pattern: /sub2api/i, rule: siteRule },
  // 另一个账号后台的名字，和 Sub2API 同一类。
  { word: 'new-api', pattern: /\bnew-?api\b/i, rule: siteRule },
  { word: '站点域名', pattern: /solov/i, rule: siteRule },
  { word: '站点', pattern: /站点/, rule: siteRule },
  // 前后不能紧挨英文字母：apiKey、Keychain、hotkey 这类标识符和别的词不算。
  { word: 'Key', pattern: /(?<![A-Za-z])key(?![A-Za-z])/i, rule: '「Key」叫「密钥」' },
]

const scannedAreas = [
  { area: '界面', root: 'src/renderer-v2' },
  // 主进程的中文提示大多会经出错提示传到界面，但有的只在被攻击、文件损坏时才出现，
  // 静态看不出会不会上屏，所以单列一段。
  { area: '主进程', root: 'electron' },
]

// 名单上的每一条都写明为什么放过；文字改了对不上时测试会红，提醒把这条删掉。
const allowlist = [
  {
    file: 'src/renderer-v2/registry/tutorials.ts',
    text: '「token quota is not enough」「API key 额度已用完」',
    reason: '原样引用工具报出来的错，客户要拿屏幕上的字来对',
  },
  {
    file: 'src/renderer-v2/features/tools/account-bootstrap.ts',
    text: 'Key 自动配置（',
    reason: '写进运行日志给客服看的那一行（AccountBootstrapLogLine），不上屏',
  },
  {
    file: 'electron/cli-verified-versions.ts',
    text: '当前 npm latest',
    reason: '推荐版本名单里给开发看的 note，客户看到的是 userNote',
  },
  {
    // 不写 text = 整个文件。
    file: 'electron/ipc-channel-policy.ts',
    reason: '每条通道的 label 只进运行日志（ipc.ts 记「某某失败：原因」那一行），不上屏',
  },
]

// 只有纯英文的值才靠名字判断会不会上屏；带中文的字符串一律算。
const visibleJsxAttributes = new Set(['title', 'alt', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext'])
const visibleNameSuffix = /(?:label|title|description|hint|message|detail|summary|tooltip|caption|heading|body|lead|placeholder)$/i
const hiddenJsxAttributes = new Set(['className', 'class', 'style', 'data-testid', 'testId', 'key', 'id', 'href', 'src', 'htmlFor', 'role', 'type', 'name', 'value', 'lang', 'rel', 'target'])
// 只进运行日志、不上屏的调用。
const logCallees = new Set(['log', 'reportRendererError'])
// 拿来比对、查找、替换的字，是别人的输出或内部状态，不是我们写给客户看的。
const matchingMethods = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'test', 'search', 'split', 'replace', 'replaceAll'])
// 只拿来搜索、不显示的字（教程、设置项、页签的搜索词）。
const hiddenProperties = new Set(['keywords'])
const comparisonOperators = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])
const cjk = /\p{Script=Han}/u
// 拼正则用的字（`'(?:API\\s*Key|密钥)'` 再交给 new RegExp），是拿来认别人报错的。
// `\s*`、`\d+` 这种带量词的才算，`C:\System32` 这种路径不算。
const regexSource = /\(\?[:=!<]|\\[sdwSDW][*+?{]/

function isScannedFile(relativePath) {
  if (!/\.tsx?$/.test(relativePath) || /\.d\.ts$/.test(relativePath)) return false
  if (/\.test\.tsx?$/.test(relativePath)) return false
  const parts = relativePath.split('/')
  const base = parts[parts.length - 1]
  if (parts.includes('testing') || parts.includes('fixtures')) return false
  return !/fixture|test-support|^gallery/i.test(base)
}

function filesUnder(directory, collected = []) {
  if (!fs.existsSync(directory)) return collected
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') filesUnder(candidate, collected)
    } else collected.push(candidate)
  }
  return collected
}

function calleeName(call) {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

function isConsoleCall(call) {
  const callee = call.expression
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console'
}

function propertyName(node, source) {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNoSubstitutionTemplateLiteral(node.name)) return node.name.text
  return node.name.getText(source)
}

// 字面量往上走过这些「传声筒」写法时，意思不变：`a ? '甲' : '乙'`、`'甲' + x`、`['甲']`。
function isPassThrough(node) {
  return ts.isParenthesizedExpression(node) || ts.isConditionalExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTemplateSpan(node) || ts.isArrayLiteralExpression(node)
    || (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
}

function isFunctionBoundary(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isSourceFile(node)
}

function isInsideLogCall(node) {
  for (let current = node.parent; current && !isFunctionBoundary(current); current = current.parent) {
    if (ts.isCallExpression(current) && (logCallees.has(calleeName(current)) || isConsoleCall(current))) return true
  }
  return false
}

function isInsideType(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false
  }
  return false
}

// 字面量最近的「意义所在」：跳过传声筒写法之后挂在哪儿。
function owner(node) {
  let child = node
  let current = node.parent
  while (current && isPassThrough(current)) {
    child = current
    current = current.parent
  }
  return { child, parent: current }
}

function hiddenOrVisibleByPlace(node, source) {
  const { child, parent } = owner(node)
  if (!parent) return 'unknown'
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return 'hidden'
  if (ts.isCaseClause(parent) || ts.isElementAccessExpression(parent) || ts.isComputedPropertyName(parent)) return 'hidden'
  if (ts.isBinaryExpression(parent) && comparisonOperators.has(parent.operatorToken.kind)) return 'hidden'
  if (ts.isCallExpression(parent) && parent.arguments.includes(child)) {
    if (parent.expression.kind === ts.SyntaxKind.ImportKeyword || calleeName(parent) === 'require') return 'hidden'
    if (ts.isPropertyAccessExpression(parent.expression) && matchingMethods.has(parent.expression.name.text)) return 'hidden'
  }
  if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'RegExp') return 'hidden'
  if (ts.isPropertyAssignment(parent)) {
    if (parent.name === child) return 'hidden'
    const name = propertyName(parent, source)
    if (hiddenProperties.has(name)) return 'hidden'
    if (visibleNameSuffix.test(name)) return 'visible'
  }
  // `<span>{'npm'}</span>`：花括号里直接写的字和 JSX 里的字一样上屏。
  if (ts.isJsxExpression(parent) && parent.parent && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))) return 'visible'
  const attribute = ts.isJsxAttribute(parent) ? parent : ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent) ? parent.parent : null
  if (attribute) {
    const name = attribute.name.getText(source)
    if (hiddenJsxAttributes.has(name)) return 'hidden'
    if (visibleJsxAttributes.has(name) || visibleNameSuffix.test(name)) return 'visible'
  }
  return 'unknown'
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return node.head.text + node.templateSpans.map((span) => '…' + span.literal.text).join('')
}

/**
 * 一个源文件里会上屏的字：JSX 里的字一律算；字符串带中文的算；纯英文的只有挂在标题、
 * 读屏标签、`label`/`message` 这类名字上才算。日志、比对、搜索词、类型里的字不算。
 */
function customerTextIn(sourceText, fileName) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind)
  const found = []
  function add(node, text, lineOffset = 0) {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    found.push({ line: position.line + 1 + lineOffset, text: text.replace(/\s+/g, ' ').trim() })
  }
  // 跨好几行的模板多半是整段脚本（PowerShell、shell）：英文注释和命令不算，只看带中文的那几行，
  // 行号也按那一行算。
  function addUnknown(node, text) {
    const raw = node.getText(source)
    if (!raw.includes('\n')) {
      if (cjk.test(text)) add(node, text)
      return
    }
    // 去掉字面量自己的那对引号，行号不变：第一行就从引号后面算起。
    raw.slice(1, -1).split('\n').forEach((line, index) => {
      if (cjk.test(line)) add(node, line.replace(/\$\{[^}]*\}/g, '…'), index)
    })
  }
  function visit(node) {
    if (ts.isJsxText(node)) {
      if (!node.containsOnlyTriviaWhiteSpaces && !isInsideLogCall(node)) add(node, node.text)
      return
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = literalText(node)
      if (text.trim() && !isInsideType(node) && !isInsideLogCall(node) && !regexSource.test(text)) {
        const place = hiddenOrVisibleByPlace(node, source)
        if (place === 'visible') add(node, text)
        else if (place === 'unknown') addUnknown(node, text)
      }
      // 模板里 `${...}` 的表达式可能还有自己的字面量，照样往下看。
      if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) visit(span.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function allowedBy(entry, file, text) {
  return entry.file === file && (entry.text === undefined || text.includes(entry.text))
}

function excerpt(text, pattern, width = 36) {
  const match = pattern.exec(text)
  if (!match) return text
  const start = Math.max(0, match.index - width)
  const end = Math.min(text.length, match.index + match[0].length + width)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** 扫一遍，按区域列出命中禁用词的地方；被名单放过的单独计数。 */
function scanCustomerWording({ root = projectRoot, areas = scannedAreas, words = bannedWords, allowed = allowlist } = {}) {
  const hits = []
  const allowedHits = []
  const usedAllowlist = new Set()
  for (const { area, root: areaRoot } of areas) {
    const files = filesUnder(path.join(root, areaRoot))
      .map((absolute) => path.relative(root, absolute).replaceAll('\\', '/'))
      .filter(isScannedFile)
      .sort()
    for (const file of files) {
      for (const entry of customerTextIn(fs.readFileSync(path.join(root, file), 'utf8'), file)) {
        for (const banned of words) {
          if (!banned.pattern.test(entry.text)) continue
          const allowance = allowed.find((candidate) => allowedBy(candidate, file, entry.text))
          const hit = { area, file, line: entry.line, word: banned.word, rule: banned.rule, text: excerpt(entry.text, banned.pattern) }
          if (allowance) {
            usedAllowlist.add(allowance)
            allowedHits.push(hit)
          } else hits.push(hit)
        }
      }
    }
  }
  return { hits, allowedHits, unusedAllowlist: allowed.filter((entry) => !usedAllowlist.has(entry)) }
}

function countBy(items, key) {
  const counts = new Map()
  for (const item of items) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1)
  return counts
}

function headline(result, areas = scannedAreas) {
  const perArea = countBy(result.hits, 'area')
  const parts = areas.map(({ area }) => `${area} ${perArea.get(area) ?? 0} 处`)
  return `客户看得到的字里的禁用词（只报不拦）：${parts.join('、')}；按名单放过 ${result.allowedHits.length} 处`
}

function groupedHits(hits, areas) {
  return areas.map(({ area }) => {
    const inArea = hits.filter((hit) => hit.area === area)
    const words = [...countBy(inArea, 'word').keys()]
    return { area, total: inArea.length, words: words.map((word) => ({ word, hits: inArea.filter((hit) => hit.word === word) })) }
  })
}

function formatText(result, areas = scannedAreas) {
  const lines = [headline(result, areas)]
  for (const group of groupedHits(result.hits, areas)) {
    if (!group.total) continue
    lines.push('', `${group.area}（${group.total} 处）`)
    for (const { word, hits } of group.words) {
      lines.push(`  ${word}（${hits[0].rule}）${hits.length} 处`)
      for (const hit of hits) lines.push(`    ${hit.file}:${hit.line}  ${hit.text}`)
    }
  }
  for (const entry of result.unusedAllowlist) lines.push('', `名单上这条已经对不上了，可以删掉：${entry.file}「${entry.text}」`)
  return lines.join('\n')
}

function markdownCell(text) {
  return text.replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function formatMarkdown(result, areas = scannedAreas) {
  const lines = ['### 客户看得到的字里的禁用词', '', headline(result, areas) + '。这一步只报不拦，红不了 CI。', '']
  for (const group of groupedHits(result.hits, areas)) {
    if (!group.total) continue
    const summary = group.words.map(({ word, hits }) => `${word} ${hits.length}`).join('，')
    lines.push(`<details${group.area === '界面' ? ' open' : ''}><summary>${group.area} ${group.total} 处（${summary}）</summary>`, '')
    lines.push('| 词 | 位置 | 字 |', '|---|---|---|')
    for (const { word, hits } of group.words) {
      for (const hit of hits) lines.push(`| ${markdownCell(word)} | \`${hit.file}:${hit.line}\` | ${markdownCell(hit.text)} |`)
    }
    lines.push('', '</details>', '')
  }
  return lines.join('\n')
}

function main() {
  const result = scanCustomerWording()
  console.log(formatText(result))
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) fs.appendFileSync(summaryFile, formatMarkdown(result) + '\n', 'utf8')
}

if (require.main === module) main()

module.exports = {
  allowlist,
  bannedWords,
  customerTextIn,
  formatMarkdown,
  formatText,
  headline,
  isScannedFile,
  scanCustomerWording,
  scannedAreas,
}
