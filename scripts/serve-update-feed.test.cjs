const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { isInsideDirectory, resolveServableFile } = require('./serve-update-feed.cjs')

function canCreateSymlinks() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-feed-symlink-probe-'))
  try {
    fs.symlinkSync(probe, path.join(probe, 'self'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

const symlinksSupported = canCreateSymlinks()

// fs.realpathSync and fs.promises.realpath disagree on Windows: only the
// async one expands an 8.3 short name, so a fixture rooted at the sync
// spelling (C:\Users\RUNNER~1\...) never matches what the script resolves
// (C:\Users\runneradmin\...). The fixture resolves with the same call the
// script uses so the two spellings can never diverge.
async function fixture(t) {
  const base = await fs.promises.realpath(
    fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-feed-test-')),
  )
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'release')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'latest.yml'), 'version: 0.0.0\n')
  fs.writeFileSync(path.join(outside, 'secret.yml'), 'private\n')
  return { base, root, outside }
}

test('name-level containment rejects traversal and accepts the directory itself', () => {
  const root = path.resolve('/srv/release')
  assert.equal(isInsideDirectory(root, path.join(root, 'latest.yml')), true)
  assert.equal(isInsideDirectory(root, root), true)
  assert.equal(isInsideDirectory(root, path.resolve('/srv/release-other/latest.yml')), false)
  assert.equal(isInsideDirectory(root, path.resolve('/srv/secret.yml')), false)
  assert.equal(isInsideDirectory(root, path.resolve('/srv')), false)
})

test('a plain file inside the release directory is served', async (t) => {
  const { root } = await fixture(t)
  assert.equal(await resolveServableFile(root, root, 'latest.yml'), path.join(root, 'latest.yml'))
  assert.equal(await resolveServableFile(root, root, ''), path.join(root, 'latest.yml'))
})

test('P-33: a symlink inside the release directory that resolves outside it is refused', {
  skip: symlinksSupported ? false : 'symlink creation is not permitted on this host',
}, async (t) => {
  const { root, outside } = await fixture(t)
  fs.symlinkSync(path.join(outside, 'secret.yml'), path.join(root, 'leak.yml'))
  fs.symlinkSync(outside, path.join(root, 'elsewhere'))

  // The name check alone still passes both of these, which is the defect.
  assert.equal(isInsideDirectory(root, path.join(root, 'leak.yml')), true)
  assert.equal(await resolveServableFile(root, root, 'leak.yml'), null)
  assert.equal(await resolveServableFile(root, root, 'elsewhere/secret.yml'), null)
})

test('P-33: a symlinked release directory still serves its own contents', {
  skip: symlinksSupported ? false : 'symlink creation is not permitted on this host',
}, async (t) => {
  const { base, root } = await fixture(t)
  const linkedRoot = path.join(base, 'linked-release')
  fs.symlinkSync(root, linkedRoot)
  const realRoot = await fs.promises.realpath(linkedRoot)

  assert.equal(
    await resolveServableFile(linkedRoot, realRoot, 'latest.yml'),
    path.join(root, 'latest.yml'),
  )
})

test('traversal outside the release directory is refused before the filesystem is touched', async (t) => {
  const { root } = await fixture(t)
  let realpathCalls = 0
  const realpath = async (target) => {
    realpathCalls += 1
    return target
  }

  assert.equal(await resolveServableFile(root, root, '../outside/secret.yml', realpath), null)
  assert.equal(realpathCalls, 0)
})

test('a missing file surfaces as ENOENT so the server can answer 404', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(
    () => resolveServableFile(root, root, 'missing.yml'),
    (error) => error.code === 'ENOENT',
  )
})
