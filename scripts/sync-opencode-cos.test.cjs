const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  FEED_URL, ASSET_HOSTS, LATEST_KEY, CONTENT_TYPE, VERIFICATION, MIN_PACKAGE_BYTES,
  packageSourceUrl, packageKey, validateHop, parseFeed, validateLatest, resolveAssetUrl, darwinOpenCodeRequirement, requestHead, inspectPackage,
  synchronizeOpenCode, createRuntimeDependencies, safeOpenCodeSyncFailure,
} = require('./sync-opencode-cos.cjs')

const ASSET = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function feed(version) {
  return {
    version,
    platforms: {
      'darwin-aarch64': { url: packageSourceUrl(version, 'macos-arm64'), signature: 'minisign' },
      'darwin-x86_64': { url: packageSourceUrl(version, 'macos-x64'), signature: 'minisign' },
      'windows-x86_64': { url: `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-desktop-windows-x64.exe` },
    },
  }
}

function assetFor(url) {
  return `${ASSET}?name=${encodeURIComponent(new URL(url).pathname.split('/').slice(-2).join('/'))}&sig=SECRET-SIGNATURE`
}

function createFixture() {
  const fixture = {
    version: '1.18.34',
    bundleVersion: null,
    redirects: new Map(),
    latest: null,
    objects: new Map(),
    publications: [],
    pointers: [],
    downloads: [],
    heads: [],
    inspections: [],
    removedFiles: [],
    removed: [],
    reads: 0,
  }
  fixture.dependencies = {
    async requestHead(url) {
      fixture.heads.push(url)
      if (fixture.redirects.has(url)) return fixture.redirects.get(url)
      return { status: 302, location: assetFor(url) }
    },
    async fetchJson(input) {
      assert.match(input.url, /latest\.json/)
      assert.deepEqual(input.allowedHosts, ASSET_HOSTS)
      return fixture.feed ? clone(fixture.feed) : feed(fixture.version)
    },
    async downloadResource(input) {
      fixture.downloads.push(clone({ ...input, onProgress: undefined }))
      const name = new URL(input.url).searchParams.get('name')
      return { bytes: MIN_PACKAGE_BYTES + 140 * 1024 * 1024 + name.length, sha256: sha256(name), etag: '"github"' }
    },
    async inspectPackage(filePath, workDirectory, machine) {
      fixture.inspections.push({ filePath, machine })
      if (fixture.inspectionError) throw new Error('codesign SECRET-PATH')
      return { version: fixture.bundleVersion || fixture.version, bundleIdentifier: 'ai.opencode.desktop', minimumSystemVersion: '12.0' }
    },
    async removeFile(filePath) { fixture.removedFiles.push(filePath) },
    async createWorkDirectory() { return path.resolve(os.tmpdir(), 'mock-opencode-cos') },
    async removeWorkDirectory(directory) { fixture.removed.push(directory) },
  }
  fixture.store = {
    async readJson(key) {
      assert.equal(key, LATEST_KEY)
      fixture.reads += 1
      return clone(fixture.readOverride ? fixture.readOverride(fixture.reads) : fixture.latest)
    },
    async inspect(key) { return clone(fixture.objects.get(key) || null) },
    publicUrl(key) { return `https://mock-bucket.cos.ap-shanghai.myqcloud.com/${key}` },
    async publishFile(key, filePath, input) {
      fixture.publications.push({ key, filePath, ...input, onProgress: undefined })
      if (fixture.publicationError) throw new Error('PRIMARY-SECRET signed URL')
      const existing = fixture.objects.get(key)
      if (existing && existing.sha256 !== input.expectedSha256) throw new Error('Mock immutable object conflict')
      const result = { key, bytes: input.expectedBytes, sha256: input.expectedSha256, contentType: input.contentType, etag: existing?.etag || `"cos-${input.expectedSha256.slice(0, 16)}"` }
      fixture.objects.set(key, result)
      return result
    },
    async publishJson(key, value, input) {
      assert.equal(key, LATEST_KEY)
      assert.equal(input.overwrite, true)
      assert.match(input.cacheControl, /no-cache/)
      fixture.pointers.push(clone(value))
      fixture.latest = clone(value)
      return { key }
    },
  }
  fixture.run = function (extra = {}) {
    return synchronizeOpenCode({ store: fixture.store, dependencies: fixture.dependencies, now: function () { return '2026-10-14T16:00:00.000Z' }, ...extra })
  }
  return fixture
}

test('the feed may only name the package URL this version builds for each Mac chip', () => {
  assert.equal(parseFeed(feed('1.18.34')), '1.18.34')
  for (const mutate of [
    (value) => { value.version = 'v1.18.34' },
    (value) => { value.version = '1.18.34-beta' },
    (value) => { value.platforms['darwin-aarch64'].url = 'https://evil.invalid/opencode.app.tar.gz' },
    (value) => { value.platforms['darwin-x86_64'].url = packageSourceUrl('1.18.33', 'macos-x64') },
    (value) => { delete value.platforms['darwin-x86_64'] },
    (value) => { value.platforms = [] },
  ]) {
    const value = feed('1.18.34')
    mutate(value)
    assert.throws(() => parseFeed(value), /latest\.json/)
  }
  assert.equal(packageSourceUrl('1.18.34', 'macos-arm64'), 'https://github.com/anomalyco/opencode/releases/download/v1.18.34/opencode-desktop-mac-arm64.app.tar.gz')
  assert.equal(packageKey('macos-x64', 'b'.repeat(64)), `xingmang/offline/opencode/macos-x64/sha256-${'b'.repeat(64)}/opencode-desktop-mac-x64.app.tar.gz`)
})

test('every hop stays on this repository\'s release paths or GitHub\'s asset hosts', async () => {
  assert.equal(validateHop(FEED_URL).href, FEED_URL)
  assert.equal(validateHop(assetFor(FEED_URL)).hostname, 'release-assets.githubusercontent.com')
  assert.equal(validateHop('https://objects.githubusercontent.com/x?sig=1').hostname, 'objects.githubusercontent.com')
  for (const value of [
    'http://github.com/anomalyco/opencode/releases/latest/download/latest.json',
    'https://github.com/evil/opencode/releases/latest/download/latest.json',
    'https://github.com/anomalyco/opencode/releases/latest/download/latest.json?x=1',
    'https://github.com:8443/anomalyco/opencode/releases/latest/download/latest.json',
    'https://user@github.com/anomalyco/opencode/releases/latest/download/latest.json',
    'https://evil.invalid/opencode.tar.gz',
    'not a url',
  ]) assert.throws(() => validateHop(value))

  const fixture = createFixture()
  assert.equal(await resolveAssetUrl(FEED_URL, fixture.dependencies), assetFor(FEED_URL))
  const tag = 'https://github.com/anomalyco/opencode/releases/download/v1.18.34/latest.json'
  fixture.redirects.set(FEED_URL, { status: 302, location: '/anomalyco/opencode/releases/download/v1.18.34/latest.json' })
  assert.equal(await resolveAssetUrl(FEED_URL, fixture.dependencies), assetFor(tag))

  fixture.redirects.set(FEED_URL, { status: 302, location: 'https://evil.invalid/latest.json' })
  await assert.rejects(resolveAssetUrl(FEED_URL, fixture.dependencies), /不认识的地址/)
  fixture.redirects.set(FEED_URL, { status: 200 })
  await assert.rejects(resolveAssetUrl(FEED_URL, fixture.dependencies), /HTTP 200/)
  fixture.redirects.set(FEED_URL, { status: 302, location: FEED_URL })
  await assert.rejects(resolveAssetUrl(FEED_URL, fixture.dependencies), /循环/)
  assert.throws(() => requestHead('https://evil.invalid/x'), /不认识的地址/)
})

test('the first run uploads both verified packages under their digests, then writes the pointer last', async () => {
  const fixture = createFixture()
  const result = await fixture.run()
  assert.equal(result.changed, true)
  assert.equal(fixture.publications.length, 2)
  for (const publication of fixture.publications) {
    assert.equal(publication.contentType, CONTENT_TYPE)
    assert.match(publication.cacheControl, /immutable/)
  }
  assert.deepEqual(fixture.inspections.map(function (inspection) { return inspection.machine }), ['arm64', 'x86_64'])
  for (const download of fixture.downloads) {
    assert.deepEqual(download.allowedHosts, ASSET_HOSTS)
    assert.equal(new URL(download.url).hostname, 'release-assets.githubusercontent.com')
  }
  assert.equal(fixture.pointers.length, 1)
  const manifest = fixture.latest
  assert.equal(manifest.version, '1.18.34')
  assert.deepEqual(manifest.source, { feedUrl: FEED_URL })
  const name = 'v1.18.34/opencode-desktop-mac-arm64.app.tar.gz'
  const key = packageKey('macos-arm64', sha256(name))
  assert.deepEqual(manifest.files[0], {
    platformId: 'macos-arm64', platform: 'macos', architecture: 'arm64', kind: 'app-archive', format: 'tar.gz',
    fileName: 'opencode-desktop-mac-arm64.app.tar.gz', type: CONTENT_TYPE, verification: VERIFICATION, version: '1.18.34',
    key, url: fixture.store.publicUrl(key), size: MIN_PACKAGE_BYTES + 140 * 1024 * 1024 + name.length, sha256: sha256(name),
    sourceUrl: packageSourceUrl('1.18.34', 'macos-arm64'), cosEtag: `"cos-${sha256(name).slice(0, 16)}"`,
  })
  assert.equal(manifest.files[1].platformId, 'macos-x64')
  assert.equal(validateLatest(manifest, fixture.store.publicUrl), manifest)
  assert.doesNotMatch(JSON.stringify(manifest), /SECRET-SIGNATURE/)
  assert.equal(fixture.removed.length, 1)
  assert.equal(fixture.removedFiles.length, 2)
})

test('an unchanged release with intact objects means no download and no write; a new or damaged one is uploaded', async () => {
  const fixture = createFixture()
  await fixture.run()
  const unchanged = await fixture.run()
  assert.equal(unchanged.changed, false)
  assert.equal(fixture.downloads.length, 2)
  assert.equal(fixture.pointers.length, 1)

  const key = fixture.latest.files[1].key
  fixture.objects.set(key, { ...fixture.objects.get(key), etag: '"replaced-by-hand"' })
  const repaired = await fixture.run()
  assert.equal(repaired.changed, true)
  assert.equal(fixture.downloads.length, 4)

  fixture.version = '1.18.35'
  const next = await fixture.run()
  assert.equal(next.changed, true)
  assert.equal(fixture.latest.version, '1.18.35')
  assert.equal(fixture.pointers.length, 3)
})

test('a package the client would refuse is never uploaded and the diagnostic leaks nothing', async () => {
  const refused = createFixture()
  refused.inspectionError = true
  const events = []
  await assert.rejects(refused.run({ progress: (event) => events.push(event) }), (error) => {
    const diagnostic = safeOpenCodeSyncFailure(error)
    assert.equal(diagnostic.stage, 'verify-package')
    assert.equal(diagnostic.platformId, 'macos-arm64')
    assert.equal(diagnostic.latestState, 'not-written-by-this-run')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET/)
    return true
  })
  assert.doesNotMatch(JSON.stringify(events), /SECRET/)
  assert.equal(refused.publications.length, 0)
  assert.equal(refused.pointers.length, 0)
  assert.equal(refused.removed.length, 1)

  const mislabelled = createFixture()
  mislabelled.bundleVersion = '1.18.33'
  await assert.rejects(mislabelled.run(), (error) => {
    assert.match(error.message, /版本和 latest\.json 不一致/)
    assert.equal(safeOpenCodeSyncFailure(error).stage, 'verify-package')
    return true
  })
  assert.equal(mislabelled.publications.length, 0)

  const badFeed = createFixture()
  badFeed.feed = { version: '1.18.34', platforms: { 'darwin-aarch64': { url: 'https://evil.invalid/x.tar.gz' } } }
  await assert.rejects(badFeed.run(), (error) => safeOpenCodeSyncFailure(error).stage === 'source-feed')
  assert.equal(badFeed.downloads.length, 0)
})

test('a pointer changed by another run stops the write; a cleanup failure never hides the first error', async () => {
  const fixture = createFixture()
  fixture.readOverride = (reads) => reads === 1 ? null : { changed: true }
  await assert.rejects(fixture.run(), (error) => safeOpenCodeSyncFailure(error).stage === 'cos-recheck-latest')
  assert.equal(fixture.pointers.length, 0)

  const failing = createFixture()
  failing.publicationError = true
  failing.dependencies.removeWorkDirectory = async function () { throw new Error('CLEANUP-SECRET') }
  await assert.rejects(failing.run(), (error) => {
    const diagnostic = safeOpenCodeSyncFailure(error)
    assert.equal(diagnostic.stage, 'cos-publish-package')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET/)
    return true
  })
  assert.deepEqual(safeOpenCodeSyncFailure(new Error('SECRET')), { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } })
})

test('an existing pointer must describe this bucket and the exact object layout', async () => {
  const fixture = createFixture()
  await fixture.run()
  const good = clone(fixture.latest)
  for (const mutate of [
    (value) => { value.product = 'codex' },
    (value) => { value.source.feedUrl = 'https://evil.invalid/latest.json' },
    (value) => { value.files.pop() },
    (value) => { value.files[1] = clone(value.files[0]) },
    (value) => { value.files[0].key = 'xingmang/offline/opencode/latest.json' },
    (value) => { value.files[0].sourceUrl = 'https://evil.invalid/opencode.tar.gz' },
    (value) => { value.files[0].version = '1.18.33' },
    (value) => { value.files[0].type = 'application/zip' },
    (value) => { value.files[0].verification = 'none' },
    (value) => { value.files[0].size = 1 },
    (value) => { value.files[0].cosEtag = '' },
  ]) {
    const value = clone(good)
    mutate(value)
    assert.throws(() => validateLatest(value, fixture.store.publicUrl))
  }
  const elsewhere = createFixture()
  const moved = clone(good)
  moved.files[0].url = `https://other-bucket.cos.ap-shanghai.myqcloud.com/${moved.files[0].key}`
  elsewhere.latest = moved
  await assert.rejects(elsewhere.run(), (error) => safeOpenCodeSyncFailure(error).stage === 'cos-read-latest')
  assert.equal(elsewhere.downloads.length, 0)
})

test('the package check unpacks with bsdtar and asks codesign, Gatekeeper and lipo the client\'s questions', async () => {
  await assert.rejects(inspectPackage('/tmp/x.tar.gz', os.tmpdir(), 'arm64', async function () { throw new Error('not reached') }, 'linux'), /macOS runner/)
  assert.equal(darwinOpenCodeRequirement(), 'identifier "ai.opencode.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "5NZ4Q7NXJ4"')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-package-test-'))
  try {
    function runner({ entries = ['OpenCode.app'], info = { CFBundleIdentifier: 'ai.opencode.desktop', CFBundleExecutable: 'OpenCode', CFBundleShortVersionString: '1.18.34', LSMinimumSystemVersion: '12.0' }, archs = 'arm64', failing = null } = {}) {
      const calls = []
      async function run(executable, args, options) {
        calls.push({ executable, args, options })
        if (executable === failing) throw new Error('SECRET exit 1')
        if (executable === '/usr/bin/tar') {
          for (const entry of entries) await fs.mkdir(path.join(args[3], entry), { recursive: true })
          return { stdout: '' }
        }
        if (executable === '/usr/bin/plutil') return { stdout: JSON.stringify(info) }
        if (executable === '/usr/bin/lipo') return { stdout: `${archs}\n` }
        return { stdout: '' }
      }
      return { run, calls }
    }
    const good = runner()
    const result = await inspectPackage(path.join(directory, 'opencode.tar.gz'), directory, 'arm64', good.run, 'darwin')
    assert.deepEqual(result, { version: '1.18.34', bundleIdentifier: 'ai.opencode.desktop', minimumSystemVersion: '12.0' })
    const byExecutable = Object.fromEntries(good.calls.map(function (call) { return [call.executable, call.args] }))
    assert.deepEqual(byExecutable['/usr/bin/tar'].slice(0, 3), ['-xzf', path.join(directory, 'opencode.tar.gz'), '-C'])
    const application = path.join(directory, 'extract-arm64', 'OpenCode.app')
    assert.deepEqual(byExecutable['/usr/bin/codesign'], ['--verify', '--strict', '--deep', `-R=${darwinOpenCodeRequirement()}`, application])
    assert.deepEqual(byExecutable['/usr/sbin/spctl'], ['--assess', '--type', 'execute', application])
    assert.deepEqual(byExecutable['/usr/bin/lipo'], ['-archs', path.join(application, 'Contents', 'MacOS', 'OpenCode')])
    for (const call of good.calls) assert.equal(call.options.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
    await assert.rejects(fs.access(path.join(directory, 'extract-arm64')), { code: 'ENOENT' })

    for (const [options, message] of [
      [{ entries: ['OpenCode.app', 'Evil.app'] }, /只有 OpenCode\.app/],
      [{ entries: ['Other.app'] }, /只有 OpenCode\.app/],
      [{ info: { CFBundleIdentifier: 'com.evil.app', CFBundleExecutable: 'OpenCode' } }, /bundle id/],
      [{ info: { CFBundleIdentifier: 'ai.opencode.desktop', CFBundleExecutable: '../../bin/sh' } }, /可执行文件名/],
      [{ failing: '/usr/bin/codesign' }, /5NZ4Q7NXJ4/],
      [{ failing: '/usr/sbin/spctl' }, /Gatekeeper/],
      [{ archs: 'x86_64' }, /芯片/],
    ]) {
      const refused = runner(options)
      await assert.rejects(inspectPackage(path.join(directory, 'opencode.tar.gz'), directory, 'arm64', refused.run, 'darwin'), (error) => {
        assert.match(error.message, message)
        assert.doesNotMatch(error.message, /SECRET/)
        return true
      })
      await assert.rejects(fs.access(path.join(directory, 'extract-arm64')), { code: 'ENOENT' })
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('runtime temp directories are created under the real temp root and only they can be removed', async () => {
  const runtime = createRuntimeDependencies({})
  const directory = await runtime.createWorkDirectory()
  try {
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()))
    assert.match(path.basename(directory), /^xingmang-opencode-cos-/)
    await assert.rejects(runtime.removeWorkDirectory(path.join(directory, 'nested')), /拒绝删除/)
    await assert.rejects(runtime.removeWorkDirectory(path.join(path.dirname(directory), 'unrelated')), /拒绝删除/)
  } finally {
    await runtime.removeWorkDirectory(directory)
  }
  await assert.rejects(fs.access(directory), { code: 'ENOENT' })
})
