const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { safeSyncFailure } = require('./cos-sync-utils.cjs')
const {
  LICENSE_ROOT, LICENSE_CONTENT_TYPE, MAX_LICENSE_BYTES, LICENSE_SETS,
  licenseKey, readLicenseFiles, validateLicense, assertCompleteLicense, publishLicense,
} = require('./cos-license-files.cjs')

// The vendored texts are byte-for-byte what upstream ships (scripts/cos-licenses/README.md says
// where each came from). Changing one means re-checking upstream and updating its digest here.
const PINNED = Object.freeze({
  'grok-cli/LICENSE.txt': 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  'grok-cli/THIRD_PARTY_NOTICES.md': 'e8785a6098a7ee780cd2db35745b8e53061cfb1b6da19147a308579466ea4e50',
  'opencode-desktop/LICENSE.txt': '625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b',
})
const PREFIX = 'xingmang/offline/grok'

function publicUrl(key) {
  return `https://mock-bucket.cos.ap-shanghai.myqcloud.com/${key}`
}

function record(fileName, sha256 = 'a'.repeat(64)) {
  const key = licenseKey(PREFIX, sha256, fileName)
  return { fileName, key, url: publicUrl(key), bytes: 1024, sha256, contentType: LICENSE_CONTENT_TYPE, cosEtag: '"etag"' }
}

function isIndexInvalid(error) {
  return safeSyncFailure(error).code === 'cos-index-invalid'
}

function createStore() {
  const store = {
    objects: new Map(),
    publications: [],
    inspect: async function (key) { return store.objects.get(key) || null },
    publicUrl,
    publishFile: async function (key, filePath, input) {
      store.publications.push({ key, filePath, ...input })
      const result = { key, bytes: input.expectedBytes, sha256: input.expectedSha256, contentType: input.contentType, etag: `"cos-${input.expectedSha256.slice(0, 8)}"` }
      store.objects.set(key, result)
      return result
    },
  }
  return store
}

async function stage(name, context, operation) {
  return operation(function () {})
}

test('the vendored license texts are the reviewed upstream bytes, in the order the pointer lists them', async () => {
  assert.deepEqual(Object.keys(LICENSE_SETS).sort(), ['grok-cli', 'opencode-desktop'])
  assert.deepEqual(LICENSE_SETS['grok-cli'], { spdx: 'Apache-2.0', files: ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md'] })
  assert.deepEqual(LICENSE_SETS['opencode-desktop'], { spdx: 'MIT', files: ['LICENSE.txt'] })
  for (const product of Object.keys(LICENSE_SETS)) {
    const files = await readLicenseFiles(product)
    assert.deepEqual(files.map(function (file) { return file.fileName }), LICENSE_SETS[product].files)
    for (const file of files) {
      const bytes = await fs.readFile(file.filePath)
      assert.equal(file.filePath, path.join(LICENSE_ROOT, product, file.fileName))
      assert.equal(file.bytes, bytes.length)
      assert.ok(file.bytes > 0 && file.bytes <= MAX_LICENSE_BYTES)
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(file.sha256, PINNED[`${product}/${file.fileName}`], `${product}/${file.fileName} differs from the reviewed upstream copy`)
      // .gitattributes stores text as LF everywhere, so the Windows and Mac runners hash the same bytes.
      assert.equal(bytes.includes(13), false)
    }
  }
  const grok = await fs.readFile(path.join(LICENSE_ROOT, 'grok-cli', 'LICENSE.txt'), 'utf8')
  assert.match(grok, /Apache License\s+Version 2\.0, January 2004/)
  // grok.exe embeds ripgrep and carries code ported from Codex and OpenCode: their notices travel with it.
  const notices = await fs.readFile(path.join(LICENSE_ROOT, 'grok-cli', 'THIRD_PARTY_NOTICES.md'), 'utf8')
  for (const marker of ['Copyright 2025 OpenAI', 'Copyright (c) 2025 opencode', 'Copyright (c) 2015 Andrew Gallant']) assert.ok(notices.includes(marker), marker)
  const opencode = await fs.readFile(path.join(LICENSE_ROOT, 'opencode-desktop', 'LICENSE.txt'), 'utf8')
  assert.match(opencode, /^MIT License\n\nCopyright \(c\) 2025 opencode\n/)
})

test('a missing, empty or unregistered text stops the sync with its own code', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-license-files-'))
  try {
    await assert.rejects(readLicenseFiles('opencode-desktop', directory), function (error) {
      assert.match(error.message, /LICENSE\.txt 读不出来/)
      return safeSyncFailure(error).code === 'license-unreadable'
    })
    await fs.mkdir(path.join(directory, 'opencode-desktop'))
    await fs.writeFile(path.join(directory, 'opencode-desktop', 'LICENSE.txt'), '')
    await assert.rejects(readLicenseFiles('opencode-desktop', directory), function (error) { return /是空的/.test(error.message) && safeSyncFailure(error).code === 'license-unreadable' })
    await fs.writeFile(path.join(directory, 'opencode-desktop', 'LICENSE.txt'), Buffer.alloc(MAX_LICENSE_BYTES + 1, 0x61))
    await assert.rejects(readLicenseFiles('opencode-desktop', directory), function (error) { return safeSyncFailure(error).code === 'license-unreadable' })
    for (const product of ['claude-desktop', '__proto__', 'toString']) {
      await assert.rejects(readLicenseFiles(product, directory), function (error) { return safeSyncFailure(error).code === 'license-unreadable' })
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('a pointer\'s license record must name texts of this prefix and bucket, under their digest', () => {
  const good = { spdx: 'Apache-2.0', files: [record('LICENSE.txt'), record('THIRD_PARTY_NOTICES.md', 'b'.repeat(64))] }
  const options = { prefix: PREFIX, publicUrl, message: 'bad license' }
  assert.equal(validateLicense(undefined, options), null)
  assert.equal(validateLicense(good, options), good)
  // A text registered later or dropped since is uploaded again, not a reason to stop the sync.
  assert.ok(validateLicense({ spdx: 'Apache-2.0', files: [record('NOTICE')] }, options))
  for (const mutate of [
    (value) => null,
    (value) => 'Apache-2.0',
    (value) => ({ ...value, spdx: 'Apache 2.0' }),
    (value) => ({ ...value, files: [] }),
    (value) => ({ ...value, files: Array.from({ length: 9 }, (_, index) => record(`NOTICE-${index}`)) }),
    (value) => ({ ...value, files: [value.files[0], value.files[0]] }),
    (value) => ({ ...value, files: [{ ...value.files[0], fileName: '../LICENSE.txt' }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], key: 'xingmang/offline/opencode/licenses/sha256-' + 'a'.repeat(64) + '/LICENSE.txt' }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], sha256: 'A'.repeat(64) }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], url: `https://other-bucket.cos.ap-shanghai.myqcloud.com/${value.files[0].key}` }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], bytes: MAX_LICENSE_BYTES + 1 }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], bytes: '1024' }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], contentType: 'text/plain' }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], cosEtag: '' }] }),
  ]) {
    assert.throws(() => validateLicense(mutate(good), options), (error) => error.message === 'bad license' && isIndexInvalid(error))
  }

  assert.doesNotThrow(() => assertCompleteLicense(good, 'grok-cli'))
  for (const value of [
    undefined,
    { ...good, spdx: 'MIT' },
    { ...good, files: [good.files[0]] },
    { ...good, files: [good.files[1], good.files[0]] },
  ]) assert.throws(() => assertCompleteLicense(value, 'grok-cli'), isIndexInvalid)
})

test('texts already in the bucket are reused, and a fresh upload is held to its readback and HEAD', async () => {
  const files = await readLicenseFiles('grok-cli')
  const store = createStore()
  const first = await publishLicense({ stage, store, prefix: PREFIX, product: 'grok-cli', files })
  assert.equal(store.publications.length, 2)
  for (const publication of store.publications) {
    assert.equal(publication.contentType, LICENSE_CONTENT_TYPE)
    assert.equal(publication.cacheControl, 'public, max-age=31536000, immutable')
  }
  assert.deepEqual(first.files.map(function (file) { return file.key }), files.map(function (file) { return licenseKey(PREFIX, file.sha256, file.fileName) }))
  assert.doesNotThrow(() => validateLicense(first, { prefix: PREFIX, publicUrl, message: 'bad' }))

  // Only the media type is compared, however COS spells the charset back.
  for (const [key, object] of store.objects) store.objects.set(key, { ...object, contentType: 'text/plain;charset=UTF-8' })
  const again = await publishLicense({ stage, store, prefix: PREFIX, product: 'grok-cli', files, previous: first })
  assert.equal(store.publications.length, 2)
  assert.equal(JSON.stringify(again), JSON.stringify(first))

  const head = createStore()
  head.inspect = async function (key) { return { ...head.objects.get(key), etag: '"someone-else"' } }
  await assert.rejects(publishLicense({ stage, store: head, prefix: PREFIX, product: 'grok-cli', files }), function (error) {
    return /HEAD/.test(error.message) && safeSyncFailure(error).code === 'cos-object-mismatch'
  })
  const readback = createStore()
  readback.publishFile = async function (key, filePath, input) { return { key, bytes: input.expectedBytes, sha256: 'f'.repeat(64), etag: '"x"' } }
  await assert.rejects(publishLicense({ stage, store: readback, prefix: PREFIX, product: 'grok-cli', files }), function (error) {
    return safeSyncFailure(error).code === 'cos-object-mismatch'
  })
})
