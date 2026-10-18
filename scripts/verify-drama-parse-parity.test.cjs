const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '..')
const electronRoot = path.join(projectRoot, 'electron')
const canvasLibraryRoot = path.join(projectRoot, 'canvas-v2', 'src', 'library')

// #1140 第 4 条：漫剧解析要过两道。主进程运行剧本解析节点时，用自己那份把模型回复解析成四表，
// 再把 JSON 存成节点输出（canvas-node-executors.ts）；画布收到后用它那份重新解析一遍才弹确认框
// （canvas-v2/src/App.tsx）。主进程不 import 画布源码，所以这几份文件两边各留一份。两边的上限、
// 截断或剥字符规则一旦分叉，主进程判成功的表到画布会解析失败（只剩一句「结果无法转成四表」），
// 或者两边截出来的不一样。这里逐字钉住，改一边就得同步另一边。
//
// drama-parse-prompt.ts 的画布那份目前没有任何 import（模型提示只由主进程发），留在名单里
// 是为了让两边继续一模一样，不让人误把画布那份当成正在用的提示。
const mirroredDramaModules = ['drama-model.ts', 'drama-parse.ts', 'drama-parse-prompt.ts']

function firstDifference(electronText, canvasText) {
  const electronLines = electronText.split('\n')
  const canvasLines = canvasText.split('\n')
  const total = Math.max(electronLines.length, canvasLines.length)
  for (let index = 0; index < total; index += 1) {
    if (electronLines[index] !== canvasLines[index]) {
      return [
        `first difference at line ${index + 1}`,
        `  electron: ${JSON.stringify(electronLines[index] ?? '<end of file>')}`,
        `  canvas:   ${JSON.stringify(canvasLines[index] ?? '<end of file>')}`,
      ].join('\n')
    }
  }
  return 'texts decode the same but the bytes differ'
}

function sourceFiles(directory, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sourceFiles(candidate, collected)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      collected.push(candidate)
    }
  }
  return collected
}

function relative(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll('\\', '/')
}

test('keeps the main-process and canvas copies of the drama parser byte-identical', () => {
  for (const name of mirroredDramaModules) {
    const electronCopy = fs.readFileSync(path.join(electronRoot, name))
    const canvasCopy = fs.readFileSync(path.join(canvasLibraryRoot, name))
    assert.ok(
      electronCopy.equals(canvasCopy),
      `electron/${name} and canvas-v2/src/library/${name} must stay identical; change both together\n`
        + firstDifference(electronCopy.toString('utf8'), canvasCopy.toString('utf8')),
    )
  }
})

// 一份副本里新 import 了名单外的同目录模块，主进程那边就得再抄一份过去，而那份没人对账。
test('lets the mirrored drama modules import only each other', () => {
  const mirrored = new Set(mirroredDramaModules.map((name) => `./${name.replace(/\.ts$/, '')}`))
  for (const name of mirroredDramaModules) {
    const text = fs.readFileSync(path.join(electronRoot, name), 'utf8')
    const specifiers = ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)
    assert.deepEqual(
      specifiers.filter((specifier) => !mirrored.has(specifier)),
      [],
      `electron/${name} imports a module outside the mirrored drama set`,
    )
  }
})

// 以后再从画布抄一份进主进程时，在这里会被认出来，逼着把它加进上面的名单。
test('pins every verbatim copy shared by electron and canvas-v2', () => {
  const canvasByName = new Map()
  for (const file of sourceFiles(path.join(projectRoot, 'canvas-v2', 'src'))) {
    const name = path.basename(file)
    canvasByName.set(name, [...(canvasByName.get(name) ?? []), file])
  }
  const unpinned = []
  for (const file of sourceFiles(electronRoot)) {
    const name = path.basename(file)
    for (const canvasFile of canvasByName.get(name) ?? []) {
      if (!fs.readFileSync(file).equals(fs.readFileSync(canvasFile))) continue
      const pinned = path.dirname(file) === electronRoot
        && path.dirname(canvasFile) === canvasLibraryRoot
        && mirroredDramaModules.includes(name)
      if (!pinned) unpinned.push(`${relative(file)} = ${relative(canvasFile)}`)
    }
  }
  assert.deepEqual(unpinned, [])
})
