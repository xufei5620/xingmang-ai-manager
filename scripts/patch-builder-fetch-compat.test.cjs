const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const test = require('node:test')
const { BUILDER_VERSION, GET_VERSION, ORIGINAL_SOURCE_SHA256, buildPatchedSource, recoverOriginalSource, applyBuilderFetchCompatibility } = require('./patch-builder-fetch-compat.cjs')

const project = path.join(__dirname, '..')
const installedTarget = path.join(project, 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js')
const helperReference = path.relative(path.dirname(installedTarget), path.join(project, 'scripts', 'builder-fetch-compat.cjs')).split(path.sep).join('/')

async function originalSource() {
  const source = await fs.readFile(installedTarget, 'utf8')
  return createHash('sha256').update(source).digest('hex') === ORIGINAL_SOURCE_SHA256 ? source : recoverOriginalSource(source, helperReference)
}

async function fixture(t) {
  const temporaryBase = await fs.realpath(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(temporaryBase, 'xingmang-builder-fetch-test-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), temporaryBase)
    assert.ok(path.basename(directory).startsWith('xingmang-builder-fetch-test-'))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const library = path.join(directory, 'node_modules', 'app-builder-lib')
  const target = path.join(library, 'out', 'util', 'electronGet.js')
  const getRoot = path.join(directory, 'node_modules', '@electron', 'get')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.mkdir(getRoot, { recursive: true })
  await fs.mkdir(path.join(directory, 'scripts'))
  await fs.writeFile(path.join(library, 'package.json'), JSON.stringify({ name: 'app-builder-lib', version: BUILDER_VERSION }))
  await fs.writeFile(path.join(getRoot, 'package.json'), JSON.stringify({ name: '@electron/get', version: GET_VERSION, main: 'index.js' }))
  await fs.writeFile(path.join(getRoot, 'index.js'), 'module.exports = {}\n')
  await fs.writeFile(path.join(directory, 'scripts', 'builder-fetch-compat.cjs'), 'module.exports = {}\n')
  const original = await originalSource()
  await fs.writeFile(target, original)
  return { directory, library, target, getRoot, original }
}

test('backports fetch compatibility without changing source, checksum, cache or extraction decisions', async () => {
  const original = await originalSource()
  const patched = buildPatchedSource(original, helperReference)
  assert.match(patched, /await xingmangFetch\.initializeProxyOnce\(get\)/)
  assert.equal(patched.split('xingmangFetch.buildAttemptConfig(').length - 1, 3)
  assert.match(patched, /xingmangFetch\.shouldRetryDownloadError\(e, callerSignals\)/)
  assert.doesNotMatch(patched, /agent: .*buildGotProxyAgent/)
  assert.doesNotMatch(patched, /rejectUnauthorized: false/)
  assert.match(patched, /构建下载必须验证 TLS 证书/)
  assert.equal(recoverOriginalSource(patched, helperReference), original)
  assert.throws(() => buildPatchedSource(original + '\n// unknown upstream change\n', helperReference), /SHA-256/)
})

test('the installed retry callback stops caller cancellation before its builder HttpError branch', async () => {
  const patched = buildPatchedSource(await originalSource(), helperReference)
  const start = patched.indexOf('shouldRetry: (e) => {') + 'shouldRetry: '.length
  const end = patched.indexOf('\n                },', start)
  assert.ok(start > 0 && end > start)
  const helper = require('./builder-fetch-compat.cjs')
  class HttpError extends Error {
    isServerError() { return true }
  }
  const callbackFor = new Function('config', 'downloadOptions', 'xingmangFetch', 'builder_util_runtime_1', `return (${patched.slice(start, end)}\n                })`)
  const reason = new DOMException('caller total deadline', 'TimeoutError')
  for (const slot of ['config', 'configOptions', 'downloadOptions']) {
    const controller = new AbortController()
    const config = { signal: slot === 'config' ? controller.signal : undefined, downloadOptions: { signal: slot === 'configOptions' ? controller.signal : undefined } }
    const options = { signal: slot === 'downloadOptions' ? controller.signal : undefined }
    const callback = callbackFor(config, options, helper, { HttpError })
    controller.abort(reason)
    assert.equal(callback(reason), false)
    assert.equal(callback(new HttpError('503')), false)
  }
  const active = callbackFor({ signal: new AbortController().signal }, {}, helper, { HttpError })
  assert.equal(active(new DOMException('attempt expired', 'TimeoutError')), true)
  assert.equal(active(new HttpError('503')), true)
})

test('applies once atomically and independently recognizes the exact already-patched bytes', async (t) => {
  const f = await fixture(t)
  const applied = await applyBuilderFetchCompatibility({ projectRoot: f.directory })
  assert.deepEqual(applied, { skipped: false, changed: true, version: BUILDER_VERSION })
  const result = await applyBuilderFetchCompatibility({ projectRoot: f.directory })
  assert.equal(result.changed, false)
  const entries = await fs.readdir(path.dirname(f.target))
  assert.deepEqual(entries, ['electronGet.js'])
})

test('rejects unknown builder versions and changed source bytes before any replacement', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.library, 'package.json'), JSON.stringify({ version: '26.15.4' }))
  await assert.rejects(applyBuilderFetchCompatibility({ projectRoot: f.directory }), /版本/)
  assert.equal(await fs.readFile(f.target, 'utf8'), f.original)
  await fs.writeFile(path.join(f.library, 'package.json'), JSON.stringify({ version: BUILDER_VERSION }))
  const changed = f.original + '\n// altered source\n'
  await fs.writeFile(f.target, changed)
  await assert.rejects(applyBuilderFetchCompatibility({ projectRoot: f.directory }))
  assert.equal(await fs.readFile(f.target, 'utf8'), changed)
})

test('rejects a stale nested downloader even if the root package version is correct', async (t) => {
  const f = await fixture(t)
  const nested = path.join(f.library, 'node_modules', '@electron', 'get')
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(path.join(nested, 'package.json'), JSON.stringify({ name: '@electron/get', version: '3.1.0', main: 'index.js' }))
  await fs.writeFile(path.join(nested, 'index.js'), 'module.exports = {}\n')
  await assert.rejects(applyBuilderFetchCompatibility({ projectRoot: f.directory }), /共享/)
  assert.equal(await fs.readFile(f.target, 'utf8'), f.original)
})

test('rejects hard-linked build modules without modifying either name', async (t) => {
  const f = await fixture(t)
  const linked = path.join(f.directory, 'other.js')
  await fs.link(f.target, linked)
  await assert.rejects(applyBuilderFetchCompatibility({ projectRoot: f.directory }), /文件/)
  assert.equal(await fs.readFile(linked, 'utf8'), f.original)
})

test('production-only installs can skip absent build dependencies', async (t) => {
  const temporaryBase = await fs.realpath(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(temporaryBase, 'xingmang-builder-fetch-test-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), temporaryBase)
    assert.ok(path.basename(directory).startsWith('xingmang-builder-fetch-test-'))
    await fs.rm(directory, { recursive: true, force: true })
  })
  assert.deepEqual(await applyBuilderFetchCompatibility({ projectRoot: directory }), { skipped: true })
})
