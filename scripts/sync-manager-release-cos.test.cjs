const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { gzipSync } = require('node:zlib')
const YAML = require('yaml')
const { createCosStore } = require('./cos-sync-utils.cjs')
const { safeManagerSyncFailure } = require('./cos-manager-sync-diagnostics.cjs')
const {
  LATEST_KEY,
  buildAllowedArtifacts,
  buildManagerIndex,
  buildManagerReleasePlan,
  parseArguments,
  syncManagerRelease,
  validateManagerIndex,
} = require('./sync-manager-release-cos.cjs')

const PUBLIC_BASE = 'https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/'
const VERSION = '0.2.13'

function digest(buffer, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(buffer).digest(encoding)
}

function blockmap() {
  return gzipSync(JSON.stringify({ version: '2', files: [{
    name: 'file', offset: 0, sizes: [1], checksums: ['YQ=='],
  }] }))
}

function fixture(t, { platforms = ['windows'], version = VERSION, payload = 'release payload' } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xingmang-manager-cos-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const descriptors = [...buildAllowedArtifacts(version).values()].filter((file) => platforms.includes(file.platform))
  for (const file of descriptors.filter((entry) => entry.kind !== 'manifest')) {
    const content = file.kind === 'blockmap' ? blockmap() : Buffer.from(`${payload}:${file.fileName}`)
    fs.writeFileSync(path.join(directory, file.fileName), content)
  }
  for (const file of descriptors.filter((entry) => entry.kind === 'manifest')) {
    const payloads = descriptors.filter((candidate) => (
      candidate.platform === file.platform
      && (file.platform === 'macos' ? candidate.kind === 'update'
        : candidate.kind === 'installer' && candidate.architecture === file.architecture)
    ))
    const files = payloads.map((entry) => {
      const bytes = fs.readFileSync(path.join(directory, entry.fileName))
      return { url: entry.fileName, size: bytes.length, sha512: digest(bytes, 'sha512', 'base64') }
    })
    fs.writeFileSync(path.join(directory, file.fileName), YAML.stringify({
      version,
      files,
      path: files[0].url,
      sha512: files[0].sha512,
    }))
  }
  return { directory, version }
}

function memoryStore({ previous = null, secondRead = undefined, thirdRead = undefined,
  failKey = null, corruptResult = false, failCandidate = false, failPointerAfterWrite = false } = {}) {
  const events = []
  let pointer = previous
  let reads = 0
  return {
    events,
    pointer() { return pointer },
    async readJson(key) {
      assert.equal(key, LATEST_KEY)
      reads += 1
      if (reads === 2 && secondRead !== undefined) pointer = secondRead
      if (reads === 3 && thirdRead !== undefined) pointer = thirdRead
      return pointer
    },
    async publishFile(key, filePath, options) {
      events.push({ kind: 'file', key, options })
      if (key === failKey) throw new Error('mock upload failure')
      const buffer = fs.readFileSync(filePath)
      return {
        key,
        url: `${PUBLIC_BASE}${key.split('/').map(encodeURIComponent).join('/')}`,
        bytes: buffer.length,
        sha256: corruptResult ? '0'.repeat(64) : digest(buffer, 'sha256'),
        contentType: options.contentType,
      }
    },
    async publishJson(key, value, options) {
      events.push({ kind: 'json', key, value, options })
      if (key === failKey) throw new Error('mock index upload failure')
      if (failCandidate && key !== LATEST_KEY) throw new Error('mock candidate readback failure')
      if (key === LATEST_KEY) pointer = value
      if (key === LATEST_KEY && failPointerAfterWrite) throw new Error('mock pointer result unknown')
      return { key, url: `${PUBLIC_BASE}${key}` }
    },
  }
}

async function indexFor(options) {
  const plan = await buildManagerReleasePlan(options.directory, options.version)
  return buildManagerIndex(plan, null, PUBLIC_BASE)
}

function optionsFor(local, store) {
  return { ...local, store, config: { publicBaseUrl: PUBLIC_BASE } }
}

test('publication diagnostics identify the platform and distinguish a file failure from an uncertain latest write', async (t) => {
  const local = fixture(t)
  const fileStore = memoryStore({ failKey: `xingmang/releases/${VERSION}/XingMang-AI-Manager-${VERSION}-Setup.exe` })
  const diagnostics = []
  await assert.rejects(syncManagerRelease({ ...optionsFor(local, fileStore), onDiagnostic: event => diagnostics.push(event) }), error => {
    const value = safeManagerSyncFailure(error)
    assert.equal(value.stage, 'cos-publish-file')
    assert.equal(value.platform, 'windows')
    assert.equal(value.architecture, 'x64')
    assert.equal(value.latestState, 'not-written-by-this-run')
    return true
  })
  assert.equal(fileStore.pointer(), null)
  const pointerStore = memoryStore({ failPointerAfterWrite: true })
  await assert.rejects(syncManagerRelease({ ...optionsFor(local, pointerStore), onDiagnostic: event => diagnostics.push(event) }), error => {
    const value = safeManagerSyncFailure(error)
    assert.equal(value.stage, 'cos-publish-latest')
    assert.equal(value.latestState, 'write-unconfirmed')
    return true
  })
  assert.equal(pointerStore.pointer().version, VERSION)
  assert.equal(pointerStore.events.filter(event => event.key === LATEST_KEY).length, 1)
  assert.doesNotMatch(JSON.stringify(diagnostics), /https:|filePath|mock upload|mock pointer/)
})

test('the complete release is verified and synchronized before the absolute latest index', async (t) => {
  const local = fixture(t, { platforms: ['windows', 'macos', 'linux'] })
  const store = memoryStore()
  const index = await syncManagerRelease(optionsFor(local, store))
  assert.equal(index.files.length, 14)
  assert.equal(index.version, VERSION)
  assert.equal(index.product, 'xingmang-ai-manager')
  assert.equal(store.events.at(-1).key, LATEST_KEY)
  assert.equal(store.events.at(-1).kind, 'json')
  assert.deepEqual(store.events.at(-1).options, { overwrite: true, cacheControl: 'no-cache' })
  const firstManifest = store.events.findIndex((event) => event.key.endsWith('.yml'))
  assert.equal(firstManifest, 10)
  assert.ok(store.events.slice(firstManifest, -2).every((event) => event.key.endsWith('.yml')))
  assert.match(store.events.at(-2).key, /^xingmang\/releases\/0\.2\.13\/indexes\/[a-f0-9]{64}\.json$/)
  assert.deepEqual(store.events.at(-2).value, index)
  assert.equal(store.events.at(-2).options.overwrite, undefined)
  for (const entry of index.files) {
    assert.equal(entry.key, `xingmang/releases/${VERSION}/${entry.fileName}`)
    assert.equal(entry.url, `${PUBLIC_BASE}${entry.key}`)
    assert.equal(entry.sha256, digest(fs.readFileSync(path.join(local.directory, entry.fileName)), 'sha256'))
    assert.ok(entry.size > 0)
    assert.equal(store.events.find((event) => event.key === entry.key).options.contentType, entry.type)
  }
  const manifest = YAML.parse(fs.readFileSync(path.join(local.directory, 'latest-mac.yml'), 'utf8'))
  for (const file of manifest.files) {
    assert.ok(index.files.some((entry) => entry.url === new URL(file.url, `${PUBLIC_BASE}xingmang/releases/${VERSION}/latest-mac.yml`).href))
  }
})

test('a same-version platform supplement preserves every previously published platform', async (t) => {
  const windows = fixture(t)
  const previous = await indexFor(windows)
  const macos = fixture(t, { platforms: ['macos'] })
  const store = memoryStore({ previous })
  const index = await syncManagerRelease(optionsFor(macos, store))
  assert.equal(index.files.length, 10)
  for (const entry of previous.files) assert.deepEqual(index.files.find((file) => file.fileName === entry.fileName), entry)
  assert.equal(store.events.filter((event) => event.kind === 'file').length, 7)
})

test('an upgrade retains downloads for other platforms still on their previous version', async (t) => {
  const old = fixture(t, { platforms: ['windows', 'macos'] })
  const previous = await indexFor(old)
  const next = fixture(t, { version: '0.2.14' })
  const store = memoryStore({ previous })
  const index = await syncManagerRelease(optionsFor(next, store))
  assert.equal(index.version, '0.2.14')
  assert.equal(index.files.length, 10)
  assert.ok(index.files.filter((file) => file.platform === 'macos').every((file) => file.version === VERSION))
  assert.ok(index.files.filter((file) => file.platform === 'windows').every((file) => file.version === '0.2.14'))
  validateManagerIndex(index, PUBLIC_BASE)
})

test('older versions and changed same-version bytes are rejected before any upload', async (t) => {
  const old = fixture(t)
  const newer = fixture(t, { version: '0.2.14' })
  const newerStore = memoryStore({ previous: await indexFor(newer) })
  await assert.rejects(syncManagerRelease(optionsFor(old, newerStore)), /不能回退/)
  assert.equal(newerStore.events.length, 0)
  const changed = fixture(t, { payload: 'different build' })
  const sameStore = memoryStore({ previous: await indexFor(old) })
  await assert.rejects(syncManagerRelease(optionsFor(changed, sameStore)), /不能替换内容/)
  assert.equal(sameStore.events.length, 0)
})

test('missing payloads and a single Linux architecture fail before publication', async (t) => {
  const windows = fixture(t)
  fs.unlinkSync(path.join(windows.directory, `XingMang-AI-Manager-${VERSION}-Setup.exe.blockmap`))
  const store = memoryStore()
  await assert.rejects(syncManagerRelease(optionsFor(windows, store)), /产物不完整/)
  assert.equal(store.events.length, 0)
  const linux = fixture(t, { platforms: ['linux'] })
  fs.unlinkSync(path.join(linux.directory, 'latest-linux-arm64.yml'))
  await assert.rejects(buildManagerReleasePlan(linux.directory, VERSION), /latest-linux-arm64/)
})

test('unexpected filenames, version mismatches and nested directories cannot be uploaded', async (t) => {
  const local = fixture(t)
  fs.writeFileSync(path.join(local.directory, 'credentials.json'), '{}')
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION), /不允许同步/)
  fs.unlinkSync(path.join(local.directory, 'credentials.json'))
  fs.mkdirSync(path.join(local.directory, 'nested'))
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION), /不允许同步/)
  fs.rmdirSync(path.join(local.directory, 'nested'))
  await assert.rejects(buildManagerReleasePlan(local.directory, '0.2.14'), /不允许同步/)
})

test('manifest hashes, sizes, versions and file paths must match the local release exactly', async (t) => {
  const local = fixture(t)
  const manifestPath = path.join(local.directory, 'latest.yml')
  const original = fs.readFileSync(manifestPath, 'utf8')
  for (const mutation of [
    (value) => { value.files[0].size += 1 },
    (value) => { value.files[0].sha512 = digest(Buffer.from('tampered'), 'sha512', 'base64'); value.sha512 = value.files[0].sha512 },
    (value) => { value.version = '0.2.14' },
    (value) => { value.files[0].url = '../outside.exe'; value.path = '../outside.exe' },
  ]) {
    const value = YAML.parse(original)
    mutation(value)
    fs.writeFileSync(manifestPath, YAML.stringify(value))
    await assert.rejects(buildManagerReleasePlan(local.directory, VERSION), /不匹配|版本|路径/)
  }
})

test('invalid blockmaps and oversized metadata are rejected', async (t) => {
  const local = fixture(t)
  const filePath = path.join(local.directory, `XingMang-AI-Manager-${VERSION}-Setup.exe.blockmap`)
  fs.writeFileSync(filePath, 'not gzip')
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION), /blockmap/)
  fs.writeFileSync(filePath, blockmap())
  fs.writeFileSync(path.join(local.directory, 'latest.yml'), 'x'.repeat(1024 * 1024 + 1))
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION))
})

test('installer-only import is explicit and the normal publish mode still requires a complete release', async (t) => {
  const local = fixture(t, { platforms: ['windows', 'macos', 'linux'] })
  for (const file of buildAllowedArtifacts(VERSION).values()) {
    if (file.kind !== 'installer') fs.unlinkSync(path.join(local.directory, file.fileName))
  }
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION), /产物不完整/)
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION, { installersOnly: 'true' }), /模式无效/)
  const plan = await buildManagerReleasePlan(local.directory, VERSION, { installersOnly: true })
  assert.equal(plan.files.length, 5)
  assert.ok(plan.files.every((file) => file.kind === 'installer'))
  const store = memoryStore()
  const index = await syncManagerRelease({ ...optionsFor(local, store), installersOnly: true })
  assert.equal(index.files.length, 5)
  assert.equal(store.events.filter((event) => event.kind === 'file').length, 5)
  assert.equal(store.events.at(-1).key, LATEST_KEY)
})

test('installer-only import rejects updater files and retains immutable same-version validation', async (t) => {
  for (const fileName of ['latest.yml', `XingMang-AI-Manager-${VERSION}-Setup.exe.blockmap`, `XingMang-AI-Manager-${VERSION}-Intel-x64.zip`]) {
    const local = fixture(t)
    for (const file of buildAllowedArtifacts(VERSION).values()) {
      if (file.kind !== 'installer' && fs.existsSync(path.join(local.directory, file.fileName))) {
        fs.unlinkSync(path.join(local.directory, file.fileName))
      }
    }
    fs.writeFileSync(path.join(local.directory, fileName), 'must not import')
    await assert.rejects(buildManagerReleasePlan(local.directory, VERSION, { installersOnly: true }), /不允许同步/)
  }
  const original = fixture(t)
  const previous = await indexFor(original)
  const changed = fixture(t, { payload: 'changed published installer' })
  for (const file of buildAllowedArtifacts(VERSION).values()) {
    if (file.kind !== 'installer' && fs.existsSync(path.join(changed.directory, file.fileName))) {
      fs.unlinkSync(path.join(changed.directory, file.fileName))
    }
  }
  const store = memoryStore({ previous })
  await assert.rejects(syncManagerRelease({ ...optionsFor(changed, store), installersOnly: true }), /不能替换内容/)
  assert.equal(store.events.length, 0)
})

test('file changes after planning are rejected before the first COS request in either import mode', async (t) => {
  for (const installersOnly of [false, true]) {
    for (const changeSize of [false, true]) {
      const local = fixture(t)
      if (installersOnly) {
        for (const file of buildAllowedArtifacts(VERSION).values()) {
          if (file.kind !== 'installer' && fs.existsSync(path.join(local.directory, file.fileName))) {
            fs.unlinkSync(path.join(local.directory, file.fileName))
          }
        }
      }
      const installer = path.join(local.directory, `XingMang-AI-Manager-${VERSION}-Setup.exe`)
      const original = fs.readFileSync(installer)
      let networkRequests = 0
      let pointerWrites = 0
      const config = {
        bucket: 'xingmang-downloads-1342302199', region: 'ap-shanghai',
        publicBaseUrl: PUBLIC_BASE, secretId: 'TESTSECRETID', secretKey: 'TESTSECRETKEY',
      }
      const actualStore = createCosStore(config, {
        requestImpl() {
          networkRequests += 1
          throw new Error('mock COS requests must not start after file mutation')
        },
      })
      const store = {
        async readJson(key) {
          assert.equal(key, LATEST_KEY)
          // readJson follows plan construction, before publishFile hashes the
          // upload. Exercise the real store's pre-PUT check, not a mock copy.
          fs.writeFileSync(installer, Buffer.alloc(original.length + Number(changeSize), 0x42))
          return null
        },
        publishFile: actualStore.publishFile,
        async publishJson() { pointerWrites += 1 },
      }
      await assert.rejects(syncManagerRelease({ ...local, installersOnly, store, config }), /预校验结果不一致/)
      assert.equal(networkRequests, 0, 'changed bytes must never reach an immutable object PUT')
      assert.equal(pointerWrites, 0)
    }
  }
})

test('hard-linked release files are rejected before their bytes are published', async (t) => {
  const local = fixture(t)
  const source = path.join(local.directory, `XingMang-AI-Manager-${VERSION}-Setup.exe`)
  const alias = `${source}.alias`
  fs.linkSync(source, alias)
  fs.renameSync(alias, path.join(path.dirname(local.directory), `${path.basename(local.directory)}-alias`))
  const externalAlias = path.join(path.dirname(local.directory), `${path.basename(local.directory)}-alias`)
  t.after(() => fs.unlinkSync(externalAlias))
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION))
})

test('symlinked artifacts cannot substitute files outside the release directory', async (t) => {
  const local = fixture(t)
  const outside = path.join(path.dirname(local.directory), `${path.basename(local.directory)}-external`)
  fs.writeFileSync(outside, 'outside')
  t.after(() => fs.unlinkSync(outside))
  const source = path.join(local.directory, `XingMang-AI-Manager-${VERSION}-Setup.exe`)
  fs.unlinkSync(source)
  try {
    fs.symlinkSync(outside, source)
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('the runner cannot create symlinks'); return }
    throw error
  }
  await assert.rejects(buildManagerReleasePlan(local.directory, VERSION))
})

test('failed uploads or mismatched public readbacks leave the previous latest pointer untouched', async (t) => {
  const local = fixture(t)
  for (const settings of [
    { failKey: `xingmang/releases/${VERSION}/latest.yml` },
    { corruptResult: true },
  ]) {
    const store = memoryStore(settings)
    await assert.rejects(syncManagerRelease(optionsFor(local, store)))
    assert.equal(store.pointer(), null)
    assert.ok(store.events.every((event) => event.kind === 'file'))
  }
})

test('a newer pointer found before the final write prevents rollback', async (t) => {
  const local = fixture(t)
  const next = fixture(t, { version: '0.2.14' })
  const index = await indexFor(next)
  const store = memoryStore({ secondRead: index })
  await assert.rejects(syncManagerRelease(optionsFor(local, store)), /不能回退/)
  assert.equal(store.pointer(), index)
  assert.ok(store.events.every((event) => event.kind === 'file'))
})

test('candidate publication failures stop before the mutable pointer and preserve its previous value', async (t) => {
  const local = fixture(t)
  const store = memoryStore({ failCandidate: true })
  await assert.rejects(syncManagerRelease(optionsFor(local, store)), /candidate/)
  assert.equal(store.pointer(), null)
  assert.ok(store.events.every((event) => event.key !== LATEST_KEY))
})

test('pointer changes during candidate verification stop the switch without overwriting other platforms', async (t) => {
  const local = fixture(t)
  const linux = fixture(t, { platforms: ['linux'] })
  const newerPointer = await indexFor(linux)
  const store = memoryStore({ thirdRead: newerPointer })
  await assert.rejects(syncManagerRelease(optionsFor(local, store)), /发生变更/)
  assert.equal(store.pointer(), newerPointer)
  assert.ok(store.events.every((event) => event.key !== LATEST_KEY))
})

test('an unknown pointer write is surfaced without a blind rollback write', async (t) => {
  const local = fixture(t)
  const store = memoryStore({ failPointerAfterWrite: true })
  await assert.rejects(syncManagerRelease(optionsFor(local, store)), /unknown/)
  assert.equal(store.events.filter((event) => event.key === LATEST_KEY).length, 1)
  assert.equal(store.pointer().version, VERSION)
})

test('the final pointer read merges a newly supplemented platform instead of discarding it', async (t) => {
  const local = fixture(t)
  const linux = fixture(t, { platforms: ['linux'] })
  const store = memoryStore({ secondRead: await indexFor(linux) })
  const index = await syncManagerRelease(optionsFor(local, store))
  assert.equal(index.files.length, 7)
  assert.equal(index.files.filter((file) => file.platform === 'linux').length, 4)
})

test('untrusted existing index URLs and digests fail closed before any upload', async (t) => {
  const local = fixture(t)
  const previous = await indexFor(local)
  for (const field of ['url', 'sha256', 'key']) {
    const altered = structuredClone(previous)
    altered.files[0][field] = field === 'url' ? 'https://evil.invalid/file' : 'invalid'
    const store = memoryStore({ previous: altered })
    await assert.rejects(syncManagerRelease(optionsFor(local, store)), /无效/)
    assert.equal(store.events.length, 0)
  }
})

test('CLI arguments reject missing, duplicate and unknown values', () => {
  assert.deepEqual(parseArguments(['--directory', 'release-artifacts', '--version', VERSION]), { directory: 'release-artifacts', version: VERSION })
  for (const args of [[], ['--version', VERSION], ['--directory', 'x', '--version'],
    ['--directory', 'x', '--directory', 'y', '--version', VERSION], ['--token', 'secret']]) {
    assert.throws(() => parseArguments(args))
  }
})
