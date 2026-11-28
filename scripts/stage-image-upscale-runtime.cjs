// 「变清晰」的运行库：从开发依赖 onnxruntime-web 里只挑后台线程用得到的几个文件，放进 dist-image-upscale/，
// 随 app.asar 一起打包（electron-builder.config.cjs 的 files）。
//
// 为什么不把 onnxruntime-web 写成生产依赖：electron-builder 会把整个包（150 MB，十几种用不上的 WASM 和
// 打包变体）连同它的依赖（protobufjs 还会带上 @types/node）原样塞进安装包。后台线程实际只读五样东西，
// 2026-11-27 在 Electron 45 里逐个追过：ort.node.min.js、它 require 的 onnxruntime-common（只用 dist/cjs，连同那里标明 CommonJS 的 package.json）、
// 它 import() 的 ort-wasm-simd-threaded.mjs 和那个 .wasm。少一样，第一次点「变清晰」就失败，
// 所以这里每样都核在不在、不是空的。
//
// 文件原样拷，不压缩不改名：ort.node.min.js 和 .mjs 开头带着微软的版权和 MIT 声明，安装包里的
// THIRD-PARTY-NOTICES.txt 另有完整许可（scripts/third-party-notices.cjs 的 onnxruntime 那一条）。
const fs = require('node:fs')
const path = require('node:path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const OUTPUT_DIRECTORY_NAME = 'dist-image-upscale'

const RUNTIME_FILES = {
  'onnxruntime-web': ['package.json', 'dist/ort.node.min.js', 'dist/ort-wasm-simd-threaded.mjs', 'dist/ort-wasm-simd-threaded.wasm'],
  // dist/cjs/package.json says "type": "commonjs"; without it Node reads those files as ES modules,
  // because the package root says "type": "module", and require() fails before the model loads.
  'onnxruntime-common': ['package.json', 'dist/cjs/package.json', { directory: 'dist/cjs', extension: '.js' }],
}

function packageDirectory(projectRoot, name) {
  const directory = path.join(projectRoot, 'node_modules', name)
  if (!fs.statSync(path.join(directory, 'package.json'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${name} 没装好，请先 npm ci`)
  }
  return directory
}

function listRuntimeFiles(projectRoot, name) {
  const directory = packageDirectory(projectRoot, name)
  const files = []
  for (const entry of RUNTIME_FILES[name]) {
    if (typeof entry === 'string') {
      files.push(entry)
      continue
    }
    const names = fs.readdirSync(path.join(directory, entry.directory)).filter((file) => file.endsWith(entry.extension)).sort()
    if (names.length === 0) throw new Error(`${name} 的 ${entry.directory} 里没有 ${entry.extension} 文件`)
    files.push(...names.map((file) => `${entry.directory}/${file}`))
  }
  return { directory, files }
}

function stageImageUpscaleRuntime(projectRoot = PROJECT_ROOT) {
  const output = path.join(projectRoot, OUTPUT_DIRECTORY_NAME)
  fs.rmSync(output, { recursive: true, force: true })
  const versions = {}
  let bytes = 0
  for (const name of Object.keys(RUNTIME_FILES)) {
    const { directory, files } = listRuntimeFiles(projectRoot, name)
    versions[name] = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version
    for (const file of files) {
      const source = path.join(directory, ...file.split('/'))
      const stat = fs.lstatSync(source, { throwIfNoEntry: false })
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) throw new Error(`${name} 缺少运行库文件 ${file}`)
      const target = path.join(output, 'node_modules', name, ...file.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      bytes += stat.size
    }
  }
  if (versions['onnxruntime-web'] !== versions['onnxruntime-common']) {
    throw new Error(`onnxruntime-web ${versions['onnxruntime-web']} 与 onnxruntime-common ${versions['onnxruntime-common']} 版本不一致`)
  }
  return { output, versions, bytes }
}

if (require.main === module) {
  try {
    const result = stageImageUpscaleRuntime()
    console.log(`[image-upscale] 已放好本机放大运行库 onnxruntime-web ${result.versions['onnxruntime-web']}（${(result.bytes / 1024 / 1024).toFixed(1)} MB）`)
  } catch (error) {
    console.error(`[image-upscale] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { OUTPUT_DIRECTORY_NAME, RUNTIME_FILES, stageImageUpscaleRuntime }
