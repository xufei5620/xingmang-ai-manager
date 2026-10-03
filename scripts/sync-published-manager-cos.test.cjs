const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const utilities = require('./cos-sync-utils.cjs')
const { safeManagerSyncFailure } = require('./cos-manager-sync-diagnostics.cjs')
const { buildAllowedArtifacts, LATEST_KEY, syncManagerRelease } = require('./sync-manager-release-cos.cjs')
const {
  REPOSITORY, parseArguments, releaseApiUrl, requestDownloadHead, resolveAssetDownloadUrl,
  syncPublishedManagerRelease, validatePublishedRelease, validateTag,
} = require('./sync-published-manager-cos.cjs')

const VERSION = '0.2.13'
const TAG = `v${VERSION}`
const PUBLIC_BASE = 'https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function publishedRelease(platforms = ['windows', 'macos', 'linux']) {
  const contents = new Map()
  const assets = [...buildAllowedArtifacts(VERSION).values()]
    .filter((file) => file.kind === 'installer' && platforms.includes(file.platform))
    .map((file, index) => {
      const buffer = Buffer.from(`published installer ${file.fileName}`)
      contents.set(file.fileName, buffer)
      return {
        id: index + 1, name: file.fileName, state: 'uploaded', size: buffer.length,
        url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${index + 1}`,
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${TAG}/${file.fileName}`,
        digest: `sha256:${sha256(buffer)}`,
      }
    })
  return {
    contents,
    value: {
      id: 17, tag_name: TAG, draft: false, prerelease: false, published_at: '2026-10-02T05:35:27Z',
      url: `https://api.github.com/repos/${REPOSITORY}/releases/17`,
      html_url: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`, assets,
    },
  }
}

function fixture(t, release = publishedRelease()) {
  const temporaryBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-published-cos-test-')))
  t.after(() => fs.rmSync(temporaryBase, { recursive: true, force: true }))
  const calls = []
  const events = []
  let index = null
  const options = {
    tag: TAG,
    temporaryBase,
    utilities: {
      ...utilities,
      async fetchJson(input, requestOptions) {
        calls.push({ kind: 'metadata', input, requestOptions })
        return release.value
      },
      async downloadResource(input, requestOptions) {
        calls.push({ kind: 'download', input, requestOptions })
        const name = path.basename(input.filePath)
        fs.writeFileSync(input.filePath, release.contents.get(name), { flag: 'wx' })
      },
    },
    inspectHead: async (url) => {
      calls.push({ kind: 'head', url: url.href })
      return url.hostname === 'github.com'
        ? { status: 302, location: `https://release-assets.githubusercontent.com/asset/${path.basename(url.pathname)}?signature=mock` }
        : { status: 200 }
    },
    syncOptions: {
      config: { publicBaseUrl: PUBLIC_BASE },
      store: {
        async readJson(key) { assert.equal(key, LATEST_KEY); return index },
        async publishFile(key, filePath, settings) {
          const buffer = fs.readFileSync(filePath)
          events.push({ kind: 'file', key })
          return { bytes: buffer.length, sha256: sha256(buffer), contentType: settings.contentType, url: `${PUBLIC_BASE}/${key}` }
        },
        async publishJson(key, value) {
          events.push({ kind: 'json', key })
          if (key === LATEST_KEY) index = value
        },
      },
    },
  }
  return { options, release, calls, events, temporaryBase, index: () => index }
}

test('only latest or a regular v0.x.x tag can be selected without a repository override', () => {
  assert.equal(releaseApiUrl(), `https://api.github.com/repos/${REPOSITORY}/releases/latest`)
  assert.equal(releaseApiUrl(TAG), `https://api.github.com/repos/${REPOSITORY}/releases/tags/${TAG}`)
  assert.deepEqual(parseArguments([], {}), { tag: undefined })
  assert.deepEqual(parseArguments(['--tag', TAG], {}), { tag: TAG })
  assert.deepEqual(parseArguments([], { MANAGER_RELEASE_TAG: TAG }), { tag: TAG })
  for (const tag of ['v1.2.3', 'v0.2.13-beta', 'v0.02.13', '../latest', 'v0.2.13;echo secret', ' v0.2.13']) {
    assert.throws(() => validateTag(tag))
  }
  for (const argv of [['--repo', 'other/repository'], ['--tag'], ['--tag', TAG, '--tag', TAG]]) {
    assert.throws(() => parseArguments(argv, {}))
  }
  assert.throws(() => parseArguments(['--tag', TAG], { MANAGER_RELEASE_TAG: TAG }))
})

test('the release and every selected installer must belong to the requested repository and published tag', () => {
  assert.equal(validatePublishedRelease(publishedRelease().value, TAG).assets.length, 5)
  for (const mutate of [
    (value) => { value.draft = true },
    (value) => { value.prerelease = true },
    (value) => { value.url = value.url.replace(REPOSITORY, 'attacker/other') },
    (value) => { value.html_url = value.html_url.replace(REPOSITORY, 'attacker/other') },
    (value) => { value.tag_name = 'v0.2.14' },
    (value) => { value.published_at = null },
    (value) => { value.assets[0].browser_download_url = value.assets[0].browser_download_url.replace(REPOSITORY, 'attacker/other') },
    (value) => { value.assets[0].url = value.assets[0].url.replace(REPOSITORY, 'attacker/other') },
    (value) => { value.assets[0].digest = null },
    (value) => { value.assets[0].size = 1024 * 1024 * 1024 + 1 },
    (value) => { value.assets[0].state = 'new' },
    (value) => { value.assets.push(value.assets[0]) },
    (value) => { value.assets[0].name = 'unrelated.exe' },
  ]) {
    const value = publishedRelease().value
    mutate(value)
    assert.throws(() => validatePublishedRelease(value, TAG))
  }
})

test('verified GitHub installers use the existing full COS readback and candidate-index sequence', async (t) => {
  const local = fixture(t)
  const result = await syncPublishedManagerRelease(local.options)
  assert.equal(result.files.length, 5)
  assert.ok(result.files.every((file) => file.kind === 'installer' && file.version === VERSION))
  assert.equal(local.events.filter((event) => event.kind === 'file').length, 5)
  assert.match(local.events.at(-2).key, /\/indexes\/[a-f0-9]{64}\.json$/)
  assert.equal(local.events.at(-1).key, LATEST_KEY)
  assert.deepEqual(local.index(), result)
  assert.deepEqual(fs.readdirSync(local.temporaryBase), [])
  const metadata = local.calls.find((call) => call.kind === 'metadata')
  assert.equal(metadata.input.maxBytes, 1024 * 1024)
  assert.deepEqual(metadata.input.allowedHosts, ['api.github.com'])
  assert.equal(metadata.input.headers.authorization, undefined)
  assert.equal(metadata.requestOptions.bodyTimeoutMs, 30000)
  for (const call of local.calls.filter((entry) => entry.kind === 'download')) {
    const asset = local.release.value.assets.find((entry) => entry.name === path.basename(call.input.filePath))
    assert.equal(call.input.expectedSha256, asset.digest.slice(7))
    assert.equal(call.input.expectedBytes, asset.size)
    assert.equal(call.input.maxBytes, asset.size)
    assert.equal(call.requestOptions.bodyTimeoutMs, 900000)
  }
})

test('bad GitHub digests or declared sizes cannot upload any object or latest pointer', async (t) => {
  for (const mutate of [
    (release) => { release.value.assets[0].digest = `sha256:${'0'.repeat(64)}` },
    (release) => { release.value.assets[0].size += 1 },
  ]) {
    const release = publishedRelease(['windows'])
    mutate(release)
    const local = fixture(t, release)
    await assert.rejects(syncPublishedManagerRelease(local.options), /校验失败/)
    assert.equal(local.events.length, 0)
    assert.equal(local.index(), null)
    assert.deepEqual(fs.readdirSync(local.temporaryBase), [])
  }
})

test('draft releases fail before downloading and unexpected local updater files fail before COS writes', async (t) => {
  const draft = fixture(t)
  draft.release.value.draft = true
  await assert.rejects(syncPublishedManagerRelease(draft.options), /正式版本/)
  assert.equal(draft.calls.filter((call) => call.kind === 'download').length, 0)
  assert.equal(draft.events.length, 0)
  const extra = fixture(t, publishedRelease(['windows']))
  const download = extra.options.utilities.downloadResource
  extra.options.utilities.downloadResource = async (...args) => {
    await download(...args)
    fs.writeFileSync(path.join(path.dirname(args[0].filePath), 'latest.yml'), 'not a published installer')
  }
  await assert.rejects(syncPublishedManagerRelease(extra.options), /不允许同步/)
  assert.equal(extra.events.length, 0)
})

test('GitHub digests remain authoritative if installer bytes change before the publisher reads its plan', async (t) => {
  const local = fixture(t, publishedRelease(['windows']))
  local.options.sync = async (options) => {
    fs.writeFileSync(path.join(options.directory, local.release.value.assets[0].name), 'changed after initial validation')
    return syncManagerRelease(options)
  }
  await assert.rejects(syncPublishedManagerRelease(local.options), /校验失败/)
  assert.equal(local.events.length, 0)
  assert.equal(local.index(), null)
})

test('temporary cleanup failures cannot replace the primary publication error', async (t) => {
  const local = fixture(t, publishedRelease(['windows']))
  const originalRemove = fs.promises.rm
  t.mock.method(fs.promises, 'rm', async (directory, options) => {
    if (path.dirname(directory) === local.temporaryBase) throw new Error('cleanup fixture failure')
    return originalRemove(directory, options)
  })
  local.options.sync = async () => { throw new Error('primary publication fixture failure') }
  const diagnostics = []
  local.options.onDiagnostic = event => diagnostics.push(event)
  try {
    await assert.rejects(syncPublishedManagerRelease(local.options), error => {
      assert.match(error.message, /primary publication fixture failure/)
      assert.equal(safeManagerSyncFailure(error).stage, 'cos-manager-publication')
      return true
    })
    assert.ok(diagnostics.some(event => event.stage === 'cleanup-temp' && event.event === 'stage-failed'))
  } finally { t.mock.restoreAll() }
})

test('cleanup after confirmed publication reports the published pointer without exposing the filesystem error', async (t) => {
  const local = fixture(t, publishedRelease(['windows']))
  const originalRemove = fs.promises.rm
  t.mock.method(fs.promises, 'rm', async (directory, options) => {
    if (path.dirname(directory) === local.temporaryBase) throw new Error('PRIVATE filesystem cleanup detail')
    return originalRemove(directory, options)
  })
  const diagnostics = []
  local.options.onDiagnostic = event => diagnostics.push(event)
  try {
    await assert.rejects(syncPublishedManagerRelease(local.options), error => {
      const value = safeManagerSyncFailure(error)
      assert.equal(value.stage, 'cleanup-temp')
      assert.equal(value.latestState, 'published-and-read-back')
      return true
    })
    assert.equal(local.index().version, VERSION)
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE|temporaryBase|filePath|signature=mock|https:/)
  } finally { t.mock.restoreAll() }
})

test('asset redirects allow GitHub storage only and reject credentials, repository switches and loops', async () => {
  const asset = validatePublishedRelease(publishedRelease(['windows']).value, TAG).assets[0]
  let calls = 0
  const result = await resolveAssetDownloadUrl(asset, { inspectHead: async () => (++calls === 1
    ? { status: 302, location: 'https://release-assets.githubusercontent.com/asset?signature=mock' }
    : { status: 200 }) })
  assert.equal(result, 'https://release-assets.githubusercontent.com/asset?signature=mock')
  for (const location of [
    'http://release-assets.githubusercontent.com/asset', 'https://evil.example/asset',
    'https://user:secret@release-assets.githubusercontent.com/asset',
    `https://github.com/attacker/repo/releases/download/${TAG}/installer.exe`,
    'https://release-assets.githubusercontent.com:444/asset',
  ]) {
    await assert.rejects(resolveAssetDownloadUrl(asset, { inspectHead: async () => ({ status: 302, location }) }))
  }
  calls = 0
  await assert.rejects(resolveAssetDownloadUrl(asset, { inspectHead: async () => {
    calls += 1
    return { status: 302, location: 'https://release-assets.githubusercontent.com/loop' }
  } }), /超限/)
  assert.equal(calls, 4)
})

test('download probing sends no authentication and rejects transport errors without exposing raw details', async () => {
  const seen = []
  const requestImpl = (url, options, response) => {
    seen.push(options)
    const request = new EventEmitter()
    request.destroy = () => {}
    request.end = () => queueMicrotask(() => response({ statusCode: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' }, destroy() {} }))
    return request
  }
  const result = await requestDownloadHead('https://github.com/example', { requestImpl })
  assert.equal(result.status, 302)
  assert.equal(seen[0].method, 'HEAD')
  assert.equal(seen[0].headers.authorization, undefined)
  assert.equal(seen[0].maxHeaderSize, 16384)
  await assert.rejects(requestDownloadHead('https://github.com/example', { requestImpl: () => { throw Object.assign(new Error('secret signed URL'), { code: 'ECONNRESET' }) } }), (error) => {
    const value = safeManagerSyncFailure(error).failure
    assert.equal(value.code, 'github-head-network-failed')
    assert.equal(value.transportCode, 'ECONNRESET')
    assert.doesNotMatch(JSON.stringify(value), /secret|signed URL|https:/)
    return !error.message.includes('secret')
  })
  await assert.rejects(requestDownloadHead('https://github.com/example', {
    timeoutMs: 5,
    requestImpl: () => {
      const request = new EventEmitter()
      request.end = () => {}
      request.destroy = () => {}
      return request
    },
  }), error => {
    assert.match(error.message, /超时/)
    assert.equal(safeManagerSyncFailure(error).failure.code, 'github-head-timeout')
    return true
  })
})

test('download location diagnostics distinguish HEAD HTTP status from every rejected redirect without logging locations', async () => {
  const asset = validatePublishedRelease(publishedRelease(['windows']).value, TAG).assets[0]
  const scenarios = [
    { response: { status: 405 }, code: 'github-head-http-status' },
    { response: { status: 403 }, code: 'github-head-http-status' },
    { response: { status: 302 }, code: 'github-head-redirect-rejected', reason: 'missing-location' },
    { response: { status: 302, location: 'https://evil.invalid/?token=PRIVATE' }, code: 'github-head-redirect-rejected', reason: 'invalid-target' },
    { response: { status: 302, location: `https://github.com/attacker/repo/releases/download/${TAG}/setup.exe` }, code: 'github-head-redirect-rejected', reason: 'repository-switch' },
    { response: { status: 302, location: 'https://release-assets.githubusercontent.com/asset?token=PRIVATE' }, code: 'github-head-redirect-rejected', reason: 'redirect-limit' },
  ]
  for (const scenario of scenarios) {
    await assert.rejects(resolveAssetDownloadUrl(asset, { inspectHead: async () => scenario.response }), error => {
      const value = safeManagerSyncFailure(error).failure
      assert.equal(value.code, scenario.code)
      assert.equal(value.status, scenario.response.status)
      if (scenario.reason) assert.equal(value.reason, scenario.reason)
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE|https:|evil|attacker|"(?:location|token)":/)
      return true
    })
  }
})

test('the manual import workflow stays owner-main gated, read-only and serialized with the release publisher', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/sync-published-manager-cos.yml'), 'utf8')
  const workflow = YAML.parse(source)
  const publisher = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github/workflows/publish-release.yml'), 'utf8'))
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.concurrency, publisher.jobs.publish.concurrency)
  assert.equal(workflow.jobs.sync.if, "${{ github.repository == 'xufei5620/xingmang-ai-manager' && github.ref == 'refs/heads/main' && vars.XINGMANG_COS_SYNC_ENABLED == 'true' }}")
  assert.equal(workflow.jobs.sync.environment, 'cos-sync')
  assert.equal(workflow.jobs.sync['timeout-minutes'], 90)
  const steps = workflow.jobs.sync.steps
  const upload = steps.find((step) => step.env?.COS_SECRET_KEY)
  assert.equal(upload.run, 'node scripts/sync-published-manager-cos.cjs')
  assert.equal(upload.env.MANAGER_RELEASE_TAG, "${{ inputs.tag || '' }}")
  assert.equal(steps.filter((step) => step.env?.COS_SECRET_KEY).length, 1)
  assert.doesNotMatch(source, /R2_|GH_TOKEN|release create|release upload|contents: write/)
  for (const step of steps.filter((entry) => entry.uses)) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/)
})
