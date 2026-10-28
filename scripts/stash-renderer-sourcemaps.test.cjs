const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { stashRendererSourceMaps } = require('./stash-renderer-sourcemaps.cjs')

function fixture(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-renderer-maps-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dist = path.join(root, 'dist')
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, name)), { recursive: true })
    fs.writeFileSync(path.join(dist, name), content)
  }
  return { dist, maps: path.join(root, 'dist-sourcemaps', 'dist') }
}

function listed(directory) {
  return fs.readdirSync(directory, { recursive: true }).map((name) => name.split(path.sep).join('/')).sort()
}

test('the maps leave the packaged directory and sit beside a copy of their script', async (t) => {
  const { dist, maps } = fixture(t, {
    'index.html': '<script src="./assets/index-a.js"></script>',
    'assets/index-a.js': 'console.log(1)\n',
    'assets/index-a.js.map': '{"version":3}',
    'assets/chat-b.js': 'console.log(2)\n',
    'assets/chat-b.js.map': '{"version":3}',
    'assets/index-a.css': 'body{}',
    'assets/index-a.css.map': '{"version":3}',
  })
  fs.mkdirSync(maps, { recursive: true })
  fs.writeFileSync(path.join(maps, 'old.js.map'), '{}')

  assert.equal(await stashRendererSourceMaps(dist, maps), 2)

  assert.deepEqual(listed(dist), ['assets', 'assets/chat-b.js', 'assets/index-a.css', 'assets/index-a.js', 'index.html'])
  assert.deepEqual(listed(maps), ['assets', 'assets/chat-b.js', 'assets/chat-b.js.map', 'assets/index-a.js', 'assets/index-a.js.map'])
  assert.equal(fs.readFileSync(path.join(maps, 'assets/index-a.js'), 'utf8'), 'console.log(1)\n')
})

test('a script that still points at its map is refused, so the package never asks for a missing file', async (t) => {
  const { dist, maps } = fixture(t, {
    'assets/index-a.js': 'console.log(1)\n//# sourceMappingURL=index-a.js.map\n',
    'assets/index-a.js.map': '{"version":3}',
  })
  await assert.rejects(() => stashRendererSourceMaps(dist, maps), /index-a\.js 带着 sourceMappingURL/)
  assert.ok(fs.existsSync(path.join(dist, 'assets/index-a.js.map')))
})

test('a renderer built without maps is refused instead of uploading nothing', async (t) => {
  const { dist, maps } = fixture(t, { 'assets/index-a.js': 'console.log(1)\n' })
  await assert.rejects(() => stashRendererSourceMaps(dist, maps), /没有生成 source map/)
})

test('vite builds hidden maps for the renderer', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'vite.config.ts'), 'utf8')
  assert.match(config, /sourcemap: 'hidden'/)
})
