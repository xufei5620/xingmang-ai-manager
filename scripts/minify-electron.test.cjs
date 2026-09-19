const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { listJavaScriptFiles, minifyElectronDirectory } = require('./minify-electron.cjs')

const SOURCES = {
  'main.js': 'const value   =   1\nmodule.exports = { value }\n',
  'nested/service.js': 'function   compute( ) {\n  return   2\n}\nmodule.exports = { compute }\n',
  'nested/broken.js': 'const invalid = (\n',
  'asset.json': '{"keep":true}\n',
}

function fixtureDirectory(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-minify-test-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(SOURCES)) {
    const target = path.join(directory, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }
  return directory
}

function healthyFiles(directory) {
  return [path.join(directory, 'main.js'), path.join(directory, 'nested/service.js')]
}

test('only JavaScript files are collected, including nested ones', async (t) => {
  const directory = fixtureDirectory(t)
  const files = await listJavaScriptFiles(directory)
  assert.deepEqual(
    files.map((file) => path.relative(directory, file).split(path.sep).join('/')).sort(),
    ['main.js', 'nested/broken.js', 'nested/service.js'],
  )
})

test('every collected file is minified and the untouched assets are left alone', async (t) => {
  const directory = fixtureDirectory(t)
  const count = await minifyElectronDirectory(directory, { files: healthyFiles(directory) })

  assert.equal(count, 2)
  for (const name of ['main.js', 'nested/service.js']) {
    const minified = fs.readFileSync(path.join(directory, name), 'utf8')
    assert.equal(minified.endsWith('\n'), true, name)
    assert.equal(/\n\s+/.test(minified.trimEnd()), false, name)
    assert.ok(minified.length < SOURCES[name].length, name)
  }
  assert.match(fs.readFileSync(path.join(directory, 'nested/service.js'), 'utf8'), /return 2/)
  assert.equal(fs.readFileSync(path.join(directory, 'asset.json'), 'utf8'), SOURCES['asset.json'])
})

test('P-31: a failure partway through leaves every file exactly as it was', async (t) => {
  const directory = fixtureDirectory(t)
  const files = [...healthyFiles(directory), path.join(directory, 'nested/broken.js')]

  await assert.rejects(() => minifyElectronDirectory(directory, { files }))

  for (const [name, content] of Object.entries(SOURCES)) {
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), content, name)
  }
})

test('P-31: nothing is written until the last file has been minified', async (t) => {
  const directory = fixtureDirectory(t)
  const files = healthyFiles(directory)
  let transforms = 0

  await minifyElectronDirectory(directory, {
    files,
    transform: async (source, options) => {
      transforms += 1
      // The first file is only written back once the second one has been
      // transformed too, which is the whole point of the two-phase pass.
      for (const file of files) {
        assert.equal(fs.readFileSync(file, 'utf8'), SOURCES[path.relative(directory, file).split(path.sep).join('/')])
      }
      return { code: `// ${options.sourcefile}\n${source.trim()}` }
    },
  })

  assert.equal(transforms, 2)
  assert.match(fs.readFileSync(files[0], 'utf8'), /^\/\/ main\.js\n/)
})

test('an empty directory is an error rather than a silent success', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-minify-empty-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  await assert.rejects(() => minifyElectronDirectory(directory), /没有可压缩/)
})
