const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

// 画布跑的是第三方前端代码（AGENTS.md I15），它能交给系统浏览器打开的，只有 electron/main.ts 里
// canvasExternalUrlAllowlist 这张表上的地址（I12 全等匹配）。换成 xingmang-canvas 内核以后（#1393），
// 表上还留着旧内核的两条第三方地址，新内核根本不链过去：画布被投毒后仍能借它们打开别人的域名，
// 域名过期被抢注就是现成的钓鱼入口（0.2.24 深查 外部链接.md L1）。
//
// 这道门禁要求表上每一条都能在同步进来的内核源码里原样找到：内核不再链过去的地址，就得从表上删掉。
// 表只许写字符串字面量，门禁才能逐条核对。

const projectRoot = path.resolve(__dirname, '..')
const mainSource = 'electron/main.ts'
const kernelRoots = ['canvas-v2/src', 'canvas-v2/shared']

function codeFiles(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...codeFiles(candidate))
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) result.push(candidate)
  }
  return result
}

function kernelSources() {
  const sources = []
  for (const root of kernelRoots) {
    const directory = path.join(projectRoot, root)
    if (!fs.existsSync(directory)) continue
    for (const file of codeFiles(directory)) sources.push(fs.readFileSync(file, 'utf8'))
  }
  return sources
}

function canvasAllowlistEntries(source) {
  const declarations = [...source.matchAll(/\bconst canvasExternalUrlAllowlist\b[^=]*=\s*\[([\s\S]*?)\]/g)]
  assert.equal(declarations.length, 1, `${mainSource} 里应当正好有一处 canvasExternalUrlAllowlist`)
  const entries = []
  // Whole-line comments go first and trailing ones last, so the `//` inside
  // an https literal is never mistaken for a comment.
  const leftover = declarations[0][1]
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/'([^'\\\n]*)'\s*,?/g, (_match, value) => {
      entries.push(value)
      return ''
    })
    .replace(/\/\/.*$/gm, '')
  assert.equal(leftover.trim(), '', 'canvasExternalUrlAllowlist 只许写字符串字面量，门禁才能逐条核对')
  return entries
}

function kernelContains(sources, value) {
  return sources.some((source) => source.includes(value))
}

test('every canvas external link is a destination the synced kernel itself contains', () => {
  const entries = canvasAllowlistEntries(fs.readFileSync(path.join(projectRoot, mainSource), 'utf8'))
  const sources = kernelSources()
  assert.ok(sources.length > 0, `没有读到 ${kernelRoots.join('、')} 里的内核源码`)
  const missing = entries.filter((entry) => !kernelContains(sources, entry))
  assert.deepEqual(missing, [], `这些地址在画布内核源码里找不到，从 canvasExternalUrlAllowlist 删掉：${missing.join('、')}`)
})

test('the canvas window is handed the canvas list, not the main window one', () => {
  const source = fs.readFileSync(path.join(projectRoot, mainSource), 'utf8')
  const controllerCalls = [...source.matchAll(/createCanvasWindowController\(\{/g)]
  assert.equal(controllerCalls.length, 1, `${mainSource} 里应当正好建一次画布窗口`)
  const afterCall = source.slice(controllerCalls[0].index)
  const option = afterCall.match(/\bexternalUrlAllowlist\b[^,\n]*/)
  assert.ok(option, '画布窗口没有拿到外链表')
  assert.equal(option[0], 'externalUrlAllowlist: canvasExternalUrlAllowlist')
})

test('the list parser refuses entries it cannot check one by one', () => {
  assert.deepEqual(
    canvasAllowlistEntries("const canvasExternalUrlAllowlist: readonly string[] = [\n  // why\n  'https://a.example/',\n  'https://b.example/', // also why\n]"),
    ['https://a.example/', 'https://b.example/'],
  )
  assert.deepEqual(canvasAllowlistEntries('const canvasExternalUrlAllowlist: readonly string[] = []'), [])
  assert.throws(
    () => canvasAllowlistEntries('const canvasExternalUrlAllowlist = [...relaySiteExternalUrls(relaySites)]'),
    /只许写字符串字面量/,
  )
  assert.throws(() => canvasAllowlistEntries('const canvasExternalUrlAllowlist = [docsUrl]'), /只许写字符串字面量/)
  assert.throws(() => canvasAllowlistEntries('const externalUrlAllowlist = []'), /正好有一处/)
})
