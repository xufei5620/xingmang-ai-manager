const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const script = path.resolve(__dirname, 'copy-canvas-assets.mjs')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-copy-canvas-'))
}

function run(directory, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: directory,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

test('copies the in-repository canvas build into dist-canvas', () => {
  const directory = fixture()
  try {
    const source = path.join(directory, 'canvas-v2', 'dist')
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(source, 'index.html'), '<script src="./assets/app.js"></script>', 'utf8')
    fs.writeFileSync(path.join(source, 'assets', 'app.js'), 'document.body.dataset.ready = "true"', 'utf8')

    const result = run(directory)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      fs.readFileSync(path.join(directory, 'dist-canvas', 'assets', 'app.js'), 'utf8'),
      'document.body.dataset.ready = "true"',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('fails when the canvas build is missing instead of shipping a broken entry', () => {
  const directory = fixture()
  try {
    const result = run(directory)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /copy-canvas-assets/)
    assert.equal(fs.existsSync(path.join(directory, 'dist-canvas')), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
