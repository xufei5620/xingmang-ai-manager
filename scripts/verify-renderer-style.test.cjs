const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '..')

// R-B5: AGENTS.md §6 记录的格式约定此前只靠人肉遵守，仓库没有 linter，于是两棵渲染树
// 的风格已经分叉——审查时实测「行尾分号 legacy 0 / v2 300 多处」「顶层箭头函数 legacy 0 /
// v2 十几处」，新 agent 读完 §6 写出的代码在两棵树里都不对。这个门禁把 §6 里能机械判定的
// 三条钉住，并把 v2 那套带分号的写法**限定在它已经存在的目录里**，不让它继续外溢。
//
// 用 TypeScript AST 而不是 grep：`;` 会出现在字符串、注释、正则和 `for (;;)` 里，也会作为
// 同一行两条语句之间的必需分隔符出现（`{ setDialog('login'); return }`）——那些都不是
// §6 说的「行尾分号」。只有语句结尾的 `;` 恰好是该行最后一个非空字符时才算。
//
// 画布（`canvas-v2/`）不在扫描范围内：它按项目约定暂时整体不动（含风格），单独一条口径。
const scannedRoots = ['src', 'electron']

// v2 的组件层与注册表是照 ui-spec 原型抄下来的，通篇带分号；那是既成事实，全量重排会
// 摧毁 git blame（AGENTS.md §7 明令不做），所以这里承认它、但把它框住：只有这几处可以
// 带行尾分号，v2 的其余目录和整个主进程、legacy 树一律不许。
const semicolonDialect = [
  'src/renderer-v2/ui/',
  'src/renderer-v2/registry/',
  'src/renderer-v2/gallery.tsx',
  'src/renderer-v2/gallery-entry.tsx',
]

function sourceFiles(directory, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) sourceFiles(candidate, collected)
    else if (/\.tsx?$/.test(entry.name)) collected.push(candidate)
  }
  return collected
}

function moduleId(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll('\\', '/')
}

function parse(absolutePath) {
  const text = fs.readFileSync(absolutePath, 'utf8')
  const kind = absolutePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return { text, source: ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true, kind) }
}

function isTestFile(id) {
  return /\.test\.tsx?$/.test(id)
}

function lineEndingSemicolons({ text, source }) {
  const lines = text.split(/\r?\n/)
  const hits = new Set()
  function visit(node) {
    const end = node.getEnd()
    if (text[end - 1] === ';') {
      const position = source.getLineAndCharacterOfPosition(end - 1)
      const rest = (lines[position.line] ?? '').slice(position.character + 1).trim()
      // 行尾只剩注释也算行尾：`const a = 1; // 说明` 与 `const a = 1;` 是同一种写法。
      if (rest === '' || rest.startsWith('//')) hits.add(position.line + 1)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return [...hits].sort((left, right) => left - right)
}

// 只看 `const`：`let` 声明的箭头函数是可重新赋值的插槽（测试夹具里的 releaseXxx 就靠它
// 把 Promise 的 resolve 暴露出来），换成 function 声明表达不了。
function topLevelConstFunctions({ source }) {
  const found = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (!initializer) continue
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue
      found.push(`${declaration.name.getText(source)}（第 ${source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1} 行）`)
    }
  }
  return found
}

function anyAssertions({ source }) {
  const found = []
  function visit(node) {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && node.type.kind === ts.SyntaxKind.AnyKeyword) {
      found.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

const files = scannedRoots
  .flatMap((root) => sourceFiles(path.join(projectRoot, root)))
  .map((absolutePath) => ({ id: moduleId(absolutePath), absolutePath }))
  .sort((left, right) => left.id.localeCompare(right.id))

test('renderer style gate sees both renderer trees and the main process', () => {
  assert.ok(files.some((file) => file.id.startsWith('src/renderer-v2/')), 'renderer-v2 的源码应当在扫描范围内')
  assert.ok(files.some((file) => file.id.startsWith('src/components/')), 'legacy 渲染层的源码应当在扫描范围内')
  assert.ok(files.some((file) => file.id.startsWith('electron/')), '主进程的源码应当在扫描范围内')
})

test('keeps line-ending semicolons inside the v2 component layer that already uses them', () => {
  const offenders = []
  for (const file of files) {
    if (semicolonDialect.some((prefix) => file.id === prefix || file.id.startsWith(prefix))) continue
    const hits = lineEndingSemicolons(parse(file.absolutePath))
    if (hits.length) offenders.push(`${file.id}: 第 ${hits.join('、')} 行`)
  }
  assert.deepEqual(offenders, [], `这些文件出现了行尾分号，AGENTS.md §6 要求这里不加；带分号的写法只保留在 ${semicolonDialect.join('、')}：\n${offenders.join('\n')}`)
})

test('declares module-level functions with the function keyword outside tests', () => {
  const offenders = []
  for (const file of files) {
    // 测试文件里 `const fixture = () => ({ ... })` 是既有的夹具写法（主进程侧二十余处），
    // 不在 §6 的约束范围内。
    if (isTestFile(file.id)) continue
    const found = topLevelConstFunctions(parse(file.absolutePath))
    if (found.length) offenders.push(`${file.id}: ${found.join('、')}`)
  }
  assert.deepEqual(offenders, [], `模块顶层要用 function 声明而不是 const 箭头函数（AGENTS.md §6）：\n${offenders.join('\n')}`)
})

test('keeps the typing escape hatches out of both trees', () => {
  const assertions = []
  const suppressions = []
  for (const file of files) {
    const parsed = parse(file.absolutePath)
    for (const line of anyAssertions(parsed)) assertions.push(`${file.id}: 第 ${line} 行`)
    for (const [index, line] of parsed.text.split(/\r?\n/).entries()) {
      if (/@ts-ignore|eslint-disable/.test(line)) suppressions.push(`${file.id}: 第 ${index + 1} 行`)
      // @ts-expect-error 只允许出现在测试里，用来钉住「这个调用本该编译不过」。
      if (!isTestFile(file.id) && /@ts-expect-error/.test(line)) suppressions.push(`${file.id}: 第 ${index + 1} 行`)
    }
  }
  assert.deepEqual(assertions, [], `不许用 as any（AGENTS.md §6）：\n${assertions.join('\n')}`)
  assert.deepEqual(suppressions, [], `不许用 @ts-ignore / eslint-disable，@ts-expect-error 只能出现在测试里（AGENTS.md §6）：\n${suppressions.join('\n')}`)
})

// 门禁自身要能失败：三个探测器都用合成源码正反各验一次，免得某天 AST 遍历写错了，
// 这个文件变成一个永远为绿的空壳。
test('the detectors actually fire on the shapes they are meant to catch', () => {
  function synthetic(code, extension = '.ts') {
    const file = path.join(projectRoot, `__style-gate-fixture${extension}`)
    const kind = extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    return { text: code, source: ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind) }
  }
  assert.deepEqual(lineEndingSemicolons(synthetic('const a = 1;\nconst b = 2\n')), [1])
  assert.deepEqual(lineEndingSemicolons(synthetic('type A = { b: string }\nexport const c = 3 // 说明\n')), [])
  // 同一行里分隔两条语句的分号、正则与字符串里的分号都不算行尾分号。
  assert.deepEqual(lineEndingSemicolons(synthetic('function f() { g(); return 1 }\nconst h = /a;/\nconst i = "x;"\n')), [])
  assert.deepEqual(topLevelConstFunctions(synthetic('const a = () => 1\n')), ['a（第 1 行）'])
  assert.deepEqual(topLevelConstFunctions(synthetic('let a = () => 1\nfunction b() { return 2 }\nconst c = [() => 3]\n')), [])
  assert.deepEqual(anyAssertions(synthetic('const a = 1 as any\n')), [1])
  assert.deepEqual(anyAssertions(synthetic('const a = 1 as unknown as string\n')), [])
})
