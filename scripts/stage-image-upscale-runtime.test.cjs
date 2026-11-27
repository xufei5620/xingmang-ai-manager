const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { OUTPUT_DIRECTORY_NAME, RUNTIME_FILES, stageImageUpscaleRuntime } = require('./stage-image-upscale-runtime.cjs')

const projectRoot = path.resolve(__dirname, '..')

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-image-upscale-stage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function createFixture(t, { version = '1.31.1', commonVersion = version, omit = [], empty = [] } = {}) {
  const root = temporaryDirectory(t)
  const files = {
    'onnxruntime-web/package.json': JSON.stringify({ name: 'onnxruntime-web', version, main: 'dist/ort.node.min.js' }),
    'onnxruntime-web/dist/ort.node.min.js': 'module.exports = {}\n',
    'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs': 'export default {}\n',
    'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm': 'wasm',
    // Variants the worker never loads must stay out of the package.
    'onnxruntime-web/dist/ort.all.min.js': 'unused\n',
    'onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm': 'unused',
    'onnxruntime-common/package.json': JSON.stringify({ name: 'onnxruntime-common', version: commonVersion, type: 'module', main: 'dist/cjs/index.js' }),
    'onnxruntime-common/dist/cjs/package.json': JSON.stringify({ type: 'commonjs' }),
    'onnxruntime-common/dist/cjs/index.js': 'module.exports = {}\n',
    'onnxruntime-common/dist/cjs/tensor.js': 'module.exports = {}\n',
    'onnxruntime-common/dist/cjs/index.js.map': '{}',
    'onnxruntime-common/dist/esm/index.js': 'export {}\n',
  }
  for (const [relative, contents] of Object.entries(files)) {
    if (omit.includes(relative)) continue
    writeFile(path.join(root, 'node_modules', ...relative.split('/')), empty.includes(relative) ? '' : contents)
  }
  return root
}

function listFiles(directory, prefix = '') {
  const names = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) names.push(...listFiles(path.join(directory, entry.name), relative))
    else names.push(relative)
  }
  return names.sort()
}

test('copies only the files the worker loads, replacing whatever an earlier build left', (t) => {
  const root = createFixture(t)
  writeFile(path.join(root, OUTPUT_DIRECTORY_NAME, 'stale.txt'), 'left over')
  const result = stageImageUpscaleRuntime(root)
  assert.equal(result.output, path.join(root, OUTPUT_DIRECTORY_NAME))
  assert.deepEqual(result.versions, { 'onnxruntime-web': '1.31.1', 'onnxruntime-common': '1.31.1' })
  assert.deepEqual(listFiles(result.output), [
    'node_modules/onnxruntime-common/dist/cjs/index.js',
    'node_modules/onnxruntime-common/dist/cjs/package.json',
    'node_modules/onnxruntime-common/dist/cjs/tensor.js',
    'node_modules/onnxruntime-common/package.json',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    'node_modules/onnxruntime-web/dist/ort.node.min.js',
    'node_modules/onnxruntime-web/package.json',
  ])
  assert.equal(fs.readFileSync(path.join(result.output, 'node_modules', 'onnxruntime-web', 'dist', 'ort.node.min.js'), 'utf8'), 'module.exports = {}\n')
})

test('fails the build when a file the worker loads is missing or empty', (t) => {
  for (const relative of ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'onnxruntime-web/dist/ort.node.min.js']) {
    assert.throws(() => stageImageUpscaleRuntime(createFixture(t, { omit: [relative] })), /onnxruntime-web 缺少运行库文件/)
    assert.throws(() => stageImageUpscaleRuntime(createFixture(t, { empty: [relative] })), /onnxruntime-web 缺少运行库文件/)
  }
  assert.throws(() => stageImageUpscaleRuntime(createFixture(t, { omit: ['onnxruntime-common/dist/cjs/index.js', 'onnxruntime-common/dist/cjs/tensor.js'] })), /onnxruntime-common 的 dist\/cjs 里没有 \.js 文件/)
  assert.throws(() => stageImageUpscaleRuntime(createFixture(t, { omit: ['onnxruntime-common/package.json'] })), /onnxruntime-common 没装好/)
  assert.throws(() => stageImageUpscaleRuntime(createFixture(t, { omit: ['onnxruntime-common/dist/cjs/package.json'] })), /onnxruntime-common 缺少运行库文件 dist\/cjs\/package\.json/)
})

test('refuses a symbolic link in place of a runtime file', { skip: process.platform === 'win32' && 'needs SeCreateSymbolicLinkPrivilege' }, (t) => {
  const root = createFixture(t)
  const target = path.join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort.node.min.js')
  fs.rmSync(target)
  fs.symlinkSync(path.join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort.all.min.js'), target)
  assert.throws(() => stageImageUpscaleRuntime(root), /onnxruntime-web 缺少运行库文件 dist\/ort\.node\.min\.js/)
})

test('refuses onnxruntime-web and onnxruntime-common of different versions', (t) => {
  assert.throws(() => stageImageUpscaleRuntime(createFixture(t, { commonVersion: '1.30.0' })), /onnxruntime-web 1\.31\.1 与 onnxruntime-common 1\.30\.0 版本不一致/)
})

test('the installed devDependency carries every file the list names', (t) => {
  // The real package is what compile stages; a new onnxruntime-web that renames
  // its node build or WASM file must fail here, not on a customer's first click.
  // A junction needs no privilege on Windows; only the directory is linked, the
  // files read through it are the real ones.
  const output = temporaryDirectory(t)
  fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(output, 'node_modules'), 'junction')
  const result = stageImageUpscaleRuntime(output)
  assert.deepEqual(Object.keys(result.versions), Object.keys(RUNTIME_FILES))
  assert.equal(result.versions['onnxruntime-web'], require('../node_modules/onnxruntime-web/package.json').version)
  assert.ok(result.bytes > 5 * 1024 * 1024 && result.bytes < 40 * 1024 * 1024, `unexpected runtime size ${result.bytes}`)

  // Listing the files is not enough: the staged copy must load on its own and run the
  // bundled model, the way the packaged worker does. A fresh Node process resolves
  // onnxruntime-common from the staged node_modules first, so a missing or mislabelled
  // file there fails here (2026-11-27: without dist/cjs/package.json Node read the
  // CommonJS files as ES modules and the first click failed).
  const staged = path.join(result.output, 'node_modules', 'onnxruntime-web')
  const model = path.join(projectRoot, 'bundled-catalog', 'image-upscale', 'realesr-general-x4v3.onnx')
  const script = [
    'const fs = require("node:fs")',
    'const ort = require(process.argv[1])',
    'ort.env.wasm.numThreads = 1',
    'ort.InferenceSession.create(new Uint8Array(fs.readFileSync(process.argv[2])), { executionProviders: ["wasm"] })',
    '  .then((session) => { console.log(JSON.stringify({ common: require.resolve("onnxruntime-common", { paths: [process.argv[1]] }), inputs: session.inputNames })); return session.release() })',
    '  .catch((error) => { console.error(error); process.exitCode = 1 })',
  ].join('\n')
  const report = JSON.parse(execFileSync(process.execPath, ['-e', script, staged, model], { encoding: 'utf8', timeout: 60_000 }).trim())
  assert.ok(report.common.startsWith(result.output), `onnxruntime-common resolved outside the staged copy: ${report.common}`)
  assert.equal(report.inputs.length, 1)
})

test('compile stages the runtime before the third-party list is written, and packaging takes it', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const steps = packageJson.scripts['compile:runtime'].split('&&').map((step) => step.trim())
  const stage = steps.indexOf('node scripts/stage-image-upscale-runtime.cjs')
  assert.ok(stage > steps.indexOf('node scripts/clean-electron.mjs'))
  assert.ok(stage < steps.indexOf('node scripts/third-party-notices.cjs'))
  assert.equal(packageJson.dependencies?.['onnxruntime-web'], undefined, 'a production dependency would ship the whole 150 MB package')
  assert.match(packageJson.devDependencies['onnxruntime-web'], /^\^?\d+\.\d+\.\d+$/)
  const config = fs.readFileSync(path.join(projectRoot, 'electron-builder.config.cjs'), 'utf8')
  assert.ok(config.includes(`'${OUTPUT_DIRECTORY_NAME}/**/*'`))
  assert.ok(config.includes("'bundled-catalog/image-upscale/realesr-general-x4v3.onnx'"))
  assert.ok(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').split(/\r?\n/).includes(`${OUTPUT_DIRECTORY_NAME}/`))
})
