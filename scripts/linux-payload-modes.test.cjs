const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ensureNoGroupOrOtherWrite } = require('./linux-payload-modes.cjs')

function mode(entryPath) {
  return fs.lstatSync(entryPath).mode & 0o7777
}

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('strips group and other write from every file and directory the way Electron 45 ships them', { skip: process.platform === 'win32' }, async (t) => {
  const root = temporaryDirectory(t, 'xingmang-linux-payload-')
  const appOutDir = path.join(root, 'linux-unpacked')
  fs.mkdirSync(path.join(appOutDir, 'locales'), { recursive: true })
  fs.writeFileSync(path.join(appOutDir, 'resources.pak'), 'pak')
  fs.writeFileSync(path.join(appOutDir, 'xingmang-ai-manager'), 'elf')
  fs.writeFileSync(path.join(appOutDir, 'locales', 'zh-CN.pak'), 'pak')
  fs.writeFileSync(path.join(appOutDir, 'icudtl.dat'), 'icu')
  fs.chmodSync(path.join(appOutDir, 'resources.pak'), 0o666)
  fs.chmodSync(path.join(appOutDir, 'xingmang-ai-manager'), 0o777)
  fs.chmodSync(path.join(appOutDir, 'locales', 'zh-CN.pak'), 0o664)
  fs.chmodSync(path.join(appOutDir, 'icudtl.dat'), 0o644)
  fs.chmodSync(path.join(appOutDir, 'locales'), 0o777)

  const changed = await ensureNoGroupOrOtherWrite(appOutDir)

  assert.equal(mode(path.join(appOutDir, 'resources.pak')), 0o644)
  assert.equal(mode(path.join(appOutDir, 'xingmang-ai-manager')), 0o755)
  assert.equal(mode(path.join(appOutDir, 'locales', 'zh-CN.pak')), 0o644)
  assert.equal(mode(path.join(appOutDir, 'locales')), 0o755)
  assert.equal(mode(path.join(appOutDir, 'icudtl.dat')), 0o644)
  assert.deepEqual(changed.map((entry) => path.relative(appOutDir, entry)).sort(), [
    'locales',
    path.join('locales', 'zh-CN.pak'),
    'resources.pak',
    'xingmang-ai-manager',
  ].sort())
  assert.deepEqual(await ensureNoGroupOrOtherWrite(appOutDir), [])
})

test('leaves symlinks and whatever they point at alone', { skip: process.platform === 'win32' }, async (t) => {
  const root = temporaryDirectory(t, 'xingmang-linux-payload-link-')
  const appOutDir = path.join(root, 'linux-unpacked')
  const outside = path.join(root, 'outside.txt')
  fs.mkdirSync(appOutDir)
  fs.writeFileSync(outside, 'not ours')
  fs.chmodSync(outside, 0o666)
  fs.symlinkSync(outside, path.join(appOutDir, 'link'))

  await ensureNoGroupOrOtherWrite(appOutDir)

  assert.equal(mode(outside), 0o666)
})
