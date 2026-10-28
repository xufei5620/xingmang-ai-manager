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

// G06: the same transform also hands back a map that leads to the .ts, written
// beside a copy of the minified file outside the directory that gets packaged.
function compiledWithInlineMap(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-minify-map-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ts = 'export function boom(value: number): number {\n  if (value > 1) {\n    throw new Error(\'boom\')\n  }\n  return value\n}\n'
  const map = {
    version: 3,
    file: 'boom.js',
    sources: ['../../electron/nested/boom.ts'],
    sourcesContent: [ts],
    names: [],
    // Line-for-line: each output line comes from the same line of the .ts.
    mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA',
  }
  const js = 'function boom(value) {\n  if (value > 1) {\n    throw new Error(\'boom\')\n  }\n  return value\n}\nmodule.exports = { boom }\n'
  const out = path.join(directory, 'dist-electron')
  fs.mkdirSync(path.join(out, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(out, 'nested', 'boom.js'), `${js}//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`)
  return { directory, out, maps: path.join(directory, 'dist-sourcemaps', 'dist-electron') }
}

test('G06: the map is written outside the packaged directory and points back at the .ts', async (t) => {
  const { out, maps } = compiledWithInlineMap(t)
  fs.mkdirSync(maps, { recursive: true })
  fs.writeFileSync(path.join(maps, 'stale.js.map'), '{}')

  assert.equal(await minifyElectronDirectory(out, { sourceMapDirectory: maps }), 1)

  const shipped = fs.readFileSync(path.join(out, 'nested', 'boom.js'), 'utf8')
  assert.doesNotMatch(shipped, /sourceMappingURL/)
  assert.deepEqual(fs.readdirSync(path.join(out, 'nested')), ['boom.js'])
  // Sentry pairs foo.js with foo.js.map, so the copy has to be byte for byte what ships.
  assert.equal(fs.readFileSync(path.join(maps, 'nested', 'boom.js'), 'utf8'), shipped)
  assert.equal(fs.existsSync(path.join(maps, 'stale.js.map')), false)
  const map = JSON.parse(fs.readFileSync(path.join(maps, 'nested', 'boom.js.map'), 'utf8'))
  assert.deepEqual(map.sources, ['../../electron/nested/boom.ts'])
  assert.match(map.sourcesContent[0], /throw new Error\('boom'\)/)
})

test('G06: a file tsc compiled without its inline map stops the build instead of shipping a useless map', async (t) => {
  const { out, maps } = compiledWithInlineMap(t)
  fs.writeFileSync(path.join(out, 'plain.js'), 'module.exports = 1\n')
  await assert.rejects(() => minifyElectronDirectory(out, { sourceMapDirectory: maps }), /plain\.js 没有 tsc 生成的内联 source map/)
  assert.match(fs.readFileSync(path.join(out, 'nested', 'boom.js'), 'utf8'), /sourceMappingURL=data:/)
})

test('G06: compile runs tsc with inline maps and stashes the renderer maps before anything is packaged', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const steps = packageJson.scripts['compile:runtime'].split('&&').map((step) => step.trim())
  const tsc = steps.findIndex((step) => step.startsWith('tsc -p tsconfig.electron.json'))
  assert.match(steps[tsc], /--inlineSourceMap --inlineSources/)
  assert.ok(steps.indexOf('node scripts/minify-electron.cjs') > tsc)
  assert.equal(steps.indexOf('node scripts/stash-renderer-sourcemaps.cjs'), steps.indexOf('vite build') + 1)
  // The product build must never carry the maps it just produced.
  const config = require('../electron-builder.config.cjs')
  const files = JSON.stringify(config.files ?? config.default?.files)
  assert.doesNotMatch(files, /dist-sourcemaps/)
})
