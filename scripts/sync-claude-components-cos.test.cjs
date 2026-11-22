const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const {
  SOURCE_HOST, PREFIX, CONTENT_TYPE, CACHE_CONTROL, MSIX_REQUEST_URL, MAC_ZIP_REQUEST_URL, INSTALLERS, INSTALLER_IDS, PARTS, PART_IDS,
  MULTIPART_DEADLINE_MS, MULTIPART_MIN_BYTES, parsePart, parsePartArgument, componentSourceUrl, validateComponentSourceUrl, assertObjectKey,
  componentsFromModules, loadComponents, buildPlan, synchronizeClaudeComponents, safeComponentsSyncFailure, extractAsar, requestMacZipLocation,
  resolveInstaller, createRuntimeDependencies, createComponentsCosStore,
} = require('./sync-claude-components-cos.cjs')
const { PART_BYTES, THRESHOLD_BYTES } = require('./cos-multipart-upload.cjs')
const { OFFICIAL_HOSTS } = require('./sync-claude-official-cos.cjs')
const { checkFailure } = require('./cos-sync-utils.cjs')

const VM_SHA = '072b6cbf'.padEnd(40, 'a')
// Windows and Mac do not move to a new Claude version together (11-19: Windows store build 5.11492.5, Mac 6.6395.1),
// so the Mac installer pins a newer workspace and Claude Code than the Windows one.
const MAC_VM_SHA = '37817e32'.padEnd(40, 'b')
const MSIX_URL = 'https://downloads.claude.ai/releases/win32/x64/1.4212.0/Claude-1.4212.0-x64.msix'
const MAC_ZIP_URL = `https://downloads.claude.ai/releases/darwin/universal/6.6395.1/Claude-${'8fc566f7'.padEnd(40, 'c')}.zip`

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function content(label) {
  return Buffer.from(`official bytes of ${label}`)
}

function vmFile(name, platformKey, architecture, sha = VM_SHA) {
  const bytes = content(`${sha}-${platformKey}-${architecture}-${name}`)
  return { name, checksum: sha256(bytes), size: bytes.length, rawChecksum: null, rawSize: null }
}

function macPin(platform, version = '2.1.309') {
  const bytes = content(`code-${version}-${platform}`)
  return { checksum: sha256(bytes), size: bytes.length }
}

function manifestFixture({ sha = VM_SHA, version = '2.1.309' } = {}) {
  return {
    code: { version, macBundles: { 'darwin-arm64': macPin('darwin-arm64', version), 'darwin-x64': macPin('darwin-x64', version) }, linux: {} },
    vm: {
      sha,
      files: {
        win32: { x64: ['rootfs.vhdx', 'vmlinuz', 'initrd'].map((name) => vmFile(name, 'win32', 'x64', sha)), arm64: ['rootfs.vhdx', 'vmlinuz', 'initrd'].map((name) => vmFile(name, 'win32', 'arm64', sha)) },
        unix: { x64: ['rootfs.img', 'vmlinuz', 'initrd', 'initrd-micro'].map((name) => vmFile(name, 'unix', 'x64', sha)), arm64: ['rootfs.img', 'vmlinuz', 'initrd', 'initrd-micro'].map((name) => vmFile(name, 'unix', 'arm64', sha)) },
      },
    },
  }
}

function macManifestFixture() {
  return manifestFixture({ sha: MAC_VM_SHA, version: '2.1.310' })
}

// Same key formulas as electron/claude-desktop-workspace-seed.ts and claude-desktop-mac-code-seed.ts;
// electron/claude-desktop-components-sync.test.ts runs the plan against the real modules.
function fakeModules(manifest, macManifest = manifest) {
  return [
    { readClaudeDesktopComponentManifest: async (asarPath) => (asarPath.split(path.sep).includes('macos') ? macManifest : manifest) },
    {
      claudeDesktopComponentsBucketPrefix: PREFIX,
      claudeDesktopWorkspaceObjectKey: (sha, platformKey, architecture, file) => `${PREFIX}/vm/${sha}/${platformKey}-${architecture}/${file.checksum}/${file.name}.zst`,
      resolveClaudeCodeMacPin: (value, architecture) => {
        const platform = architecture === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
        const bundle = value.code?.macBundles[platform]
        return bundle ? { version: value.code.version, platform, ...bundle } : null
      },
      claudeCodeMacObjectKey: (pin) => `${PREFIX}/code/${pin.version}/${pin.platform}/${pin.checksum}/claude.app.tar.zst`,
    },
  ]
}

function officialBytes(url, platformKey) {
  const pathname = new URL(url).pathname
  const vm = /^\/vms\/linux\/(x64|arm64)\/([0-9a-f]{40})\/(.+)\.zst$/.exec(pathname)
  if (vm) return platformKey ? content(`${vm[2]}-${platformKey}-${vm[1]}-${vm[3]}`) : null
  const code = /^\/claude-code-releases\/([^/]+)\/(darwin-(?:arm64|x64))\/claude\.app\.tar\.zst$/.exec(pathname)
  return code ? content(`code-${code[1]}-${code[2]}`) : null
}

const INSTALLER_RESOURCES = { windows: { url: MSIX_URL, bytes: 4096, etag: '"msix"' }, macos: { url: MAC_ZIP_URL, bytes: 8192, etag: '"zip"' } }

function createFixture(part, { manifest = manifestFixture(), macManifest = macManifestFixture(), existing = new Map(), corrupt = new Set(), failInstaller = null } = {}) {
  const fixture = {
    manifest,
    macManifest,
    objects: new Map(existing),
    downloads: [],
    publications: [],
    removedFiles: [],
    removed: [],
    events: [],
    workDirectory: path.join(os.tmpdir(), 'xingmang-claude-components-cos-test'),
  }
  const platformKey = part.startsWith('vm-') ? part.split('-')[1] : null
  fixture.components = componentsFromModules(...fakeModules(manifest, macManifest))
  fixture.dependencies = {
    async createWorkDirectory() { return fixture.workDirectory },
    async removeWorkDirectory(directory) { fixture.removed.push(directory) },
    async removeFile(filePath) { fixture.removedFiles.push(filePath) },
    async resolveInstaller(id) {
      assert.ok(Object.hasOwn(INSTALLER_RESOURCES, id))
      if (id === failInstaller) throw checkFailure('source-url-rejected', 'entry moved')
      return INSTALLER_RESOURCES[id]
    },
    async extractAsar(packagePath, workDirectory, installer) {
      assert.equal(path.dirname(packagePath), workDirectory)
      assert.equal(path.basename(packagePath), INSTALLERS[installer].fileName)
      return path.join(workDirectory, installer, ...INSTALLERS[installer].asarEntry.split('/'))
    },
    async downloadResource(input) {
      fixture.downloads.push(input)
      const installer = Object.values(INSTALLER_RESOURCES).find((resource) => resource.url === input.url)
      if (installer) {
        assert.deepEqual(input.allowedHosts, OFFICIAL_HOSTS)
        assert.equal(input.expectedEtag, installer.etag)
        return { bytes: installer.bytes, sha256: 'f'.repeat(64), etag: installer.etag }
      }
      assert.deepEqual(input.allowedHosts, [SOURCE_HOST])
      const bytes = officialBytes(input.url, platformKey)
      assert.ok(bytes, `unexpected download ${input.url}`)
      const served = corrupt.has(input.url) ? Buffer.concat([bytes, Buffer.from('x')]) : bytes
      if (served.length !== input.expectedBytes) throw checkFailure('download-mismatch', 'size')
      if (sha256(served) !== input.expectedSha256) throw checkFailure('download-mismatch', 'digest')
      fixture.files = fixture.files || new Map()
      fixture.files.set(input.filePath, served)
      return { bytes: served.length, sha256: sha256(served), etag: '"x"' }
    },
  }
  fixture.store = {
    async inspect(key) {
      const object = fixture.objects.get(key)
      return object ? { bytes: object.bytes, sha256: object.sha256, etag: object.etag, contentType: object.contentType } : null
    },
    async publishFile(key, filePath, input) {
      const bytes = fixture.files.get(filePath)
      assert.equal(bytes.length, input.expectedBytes)
      assert.equal(sha256(bytes), input.expectedSha256)
      const object = { bytes: bytes.length, sha256: sha256(bytes), etag: `"${sha256(bytes).slice(0, 8)}"`, contentType: input.contentType }
      fixture.objects.set(key, object)
      fixture.publications.push({ key, input })
      return { key, bytes: object.bytes, sha256: object.sha256, etag: object.etag, contentType: object.contentType }
    },
  }
  fixture.run = function (installers) {
    return synchronizeClaudeComponents({ part, installers, store: fixture.store, dependencies: fixture.dependencies, components: fixture.components, progress: (event) => fixture.events.push(event) })
  }
  return fixture
}

test('only the five fixed parts can be selected, from one argument or the workflow variable', () => {
  assert.deepEqual(PART_IDS, ['vm-win32-x64', 'vm-win32-arm64', 'vm-unix-x64', 'vm-unix-arm64', 'code-mac'])
  for (const id of PART_IDS) assert.equal(parsePart(id), id)
  // Windows customers run the MSIX and Mac customers the universal zip; each part follows the installer its platform actually uses.
  assert.deepEqual(Object.fromEntries(PART_IDS.map((id) => [id, PARTS[id].installers])), {
    'vm-win32-x64': ['windows'], 'vm-win32-arm64': ['windows'], 'vm-unix-x64': ['macos'], 'vm-unix-arm64': ['macos'], 'code-mac': ['macos'],
  })
  assert.equal(parsePartArgument(['--part=code-mac'], {}), 'code-mac')
  assert.equal(parsePartArgument([], { CLAUDE_COMPONENTS_PART: 'vm-unix-arm64' }), 'vm-unix-arm64')
  for (const value of [undefined, '', 'all', 'vm-linux-x64', 'constructor', '__proto__', 'vm-win32-x64,code-mac']) assert.throws(() => parsePart(value), /要同步的部分无效/)
  assert.throws(() => parsePartArgument(['--part=code-mac', '--part=vm-win32-x64'], {}), /用法/)
  assert.throws(() => parsePartArgument(['code-mac'], {}), /用法/)
  assert.throws(() => parsePartArgument([], {}), /要同步的部分无效/)
})

test('component downloads may only come from the two official component paths on downloads.claude.ai', () => {
  assert.equal(componentSourceUrl({ kind: 'vm', architecture: 'arm64', sha: VM_SHA, name: 'rootfs.img' }), `https://downloads.claude.ai/vms/linux/arm64/${VM_SHA}/rootfs.img.zst`)
  assert.equal(componentSourceUrl({ kind: 'code', version: '2.1.309', platform: 'darwin-x64' }), 'https://downloads.claude.ai/claude-code-releases/2.1.309/darwin-x64/claude.app.tar.zst')
  for (const url of [`https://downloads.claude.ai/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst`, 'https://downloads.claude.ai/claude-code-releases/2.1.309/darwin-arm64/claude.app.tar.zst']) {
    assert.equal(validateComponentSourceUrl(url).href, url)
  }
  for (const url of [
    `http://downloads.claude.ai/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst`,
    `https://downloads.claude.ai:8443/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst`,
    `https://user@downloads.claude.ai/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst`,
    `https://downloads.claude.ai/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst?sig=1`,
    `https://downloads.claude.ai/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst#x`,
    `https://downloads.claude.ai.evil.example/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst`,
    `https://claude.ai/vms/linux/x64/${VM_SHA}/rootfs.vhdx.zst`,
    `https://downloads.claude.ai/vms/linux/riscv/${VM_SHA}/rootfs.vhdx.zst`,
    `https://downloads.claude.ai/vms/linux/x64/${VM_SHA}/rootfs.vhdx`,
    `https://downloads.claude.ai/vms/linux/x64/${VM_SHA}/a..b.zst`,
    'https://downloads.claude.ai/releases/win32/x64/1.0.0/Claude.msix',
    'https://downloads.claude.ai/claude-code-releases/2.1.309/linux-x64/claude.zst',
    'https://downloads.claude.ai/claude-code-releases/latest/darwin-arm64/claude.app.tar.zst',
    'not a url',
  ]) assert.throws(() => validateComponentSourceUrl(url), /Claude 组件下载地址/, url)
})

test('keys must stay inside the Claude components prefix', () => {
  assert.equal(assertObjectKey(`${PREFIX}/vm/${VM_SHA}/win32-x64/${'a'.repeat(64)}/vmlinuz.zst`), `${PREFIX}/vm/${VM_SHA}/win32-x64/${'a'.repeat(64)}/vmlinuz.zst`)
  for (const key of ['xingmang/offline/claude/latest.json', `${PREFIX}`, `${PREFIX}/`, `${PREFIX}/../claude/latest.json`, `${PREFIX}//x`, `${PREFIX}/a b`, 42]) {
    assert.throws(() => assertObjectKey(key), /桶内位置/)
  }
})

test('the compiled client modules must still export the parser, the key builders and the same prefix', () => {
  const modules = fakeModules(manifestFixture())
  assert.equal(typeof componentsFromModules(...modules).readManifest, 'function')
  assert.throws(() => componentsFromModules({}, modules[1]), /找不到 Claude 组件清单的读法/)
  assert.throws(() => componentsFromModules(modules[0], { ...modules[1], claudeDesktopComponentsBucketPrefix: 'xingmang/offline/elsewhere' }), /桶内目录变了/)
  assert.throws(() => componentsFromModules(modules[0], { ...modules[1], claudeCodeMacObjectKey: undefined }), /找不到/)
  assert.throws(() => loadComponents(path.join(os.tmpdir(), 'xingmang-no-such-checkout')), /先跑 tsc/)
})

function vmPlanItems(manifest, platformKey, architecture) {
  const sha = manifest.vm.sha
  return manifest.vm.files[platformKey][architecture].map((file) => ({
    label: `${file.name}.zst`,
    key: `${PREFIX}/vm/${sha}/${platformKey}-${architecture}/${file.checksum}/${file.name}.zst`,
    sourceUrl: `https://downloads.claude.ai/vms/linux/${architecture}/${sha}/${file.name}.zst`,
    bytes: file.size,
    sha256: file.checksum,
  }))
}

test('each workspace part plans exactly its own platform files, with keys and official URLs from the manifest', () => {
  const manifest = manifestFixture()
  const components = componentsFromModules(...fakeModules(manifest))
  for (const [part, platformKey, architecture] of [['vm-win32-x64', 'win32', 'x64'], ['vm-win32-arm64', 'win32', 'arm64'], ['vm-unix-x64', 'unix', 'x64'], ['vm-unix-arm64', 'unix', 'arm64']]) {
    const plan = buildPlan(part, manifest, components)
    assert.deepEqual(plan.reference, { vmShas: [VM_SHA] })
    assert.deepEqual(plan.items, vmPlanItems(manifest, platformKey, architecture))
  }
})

test('a part copies what both installers pin for its platform, and a workspace both share only once', () => {
  const windows = manifestFixture()
  const mac = macManifestFixture()
  const components = componentsFromModules(...fakeModules(windows, mac))
  for (const [part, platformKey, architecture] of [['vm-win32-x64', 'win32', 'x64'], ['vm-unix-arm64', 'unix', 'arm64']]) {
    const plan = buildPlan(part, [windows, mac], components)
    assert.deepEqual(plan.reference, { vmShas: [VM_SHA, MAC_VM_SHA] })
    assert.deepEqual(plan.items, [...vmPlanItems(windows, platformKey, architecture), ...vmPlanItems(mac, platformKey, architecture)])
    assert.deepEqual(buildPlan(part, [windows, manifestFixture()], components), buildPlan(part, [windows], components))
  }
  const code = buildPlan('code-mac', [windows, mac], components)
  assert.deepEqual(code.reference, { codeVersions: ['2.1.309', '2.1.310'] })
  assert.deepEqual(code.items.map((item) => item.label.split('/')[0] + '@' + item.key.split('/')[4]), ['darwin-arm64@2.1.309', 'darwin-x64@2.1.309', 'darwin-arm64@2.1.310', 'darwin-x64@2.1.310'])
  assert.throws(() => buildPlan('vm-win32-x64', [], components), /没有读到任何一份/)
})

test('the Mac program part plans both chips from the Claude Code pin', () => {
  const manifest = manifestFixture()
  const plan = buildPlan('code-mac', manifest, componentsFromModules(...fakeModules(manifest)))
  assert.deepEqual(plan.reference, { codeVersions: ['2.1.309'] })
  assert.deepEqual(plan.items.map((item) => [item.label, item.key, item.sourceUrl, item.bytes, item.sha256]), ['darwin-arm64', 'darwin-x64'].map((platform) => [
    `${platform}/claude.app.tar.zst`,
    `${PREFIX}/code/2.1.309/${platform}/${manifest.code.macBundles[platform].checksum}/claude.app.tar.zst`,
    `https://downloads.claude.ai/claude-code-releases/2.1.309/${platform}/claude.app.tar.zst`,
    manifest.code.macBundles[platform].size,
    manifest.code.macBundles[platform].checksum,
  ]))
})

test('a manifest Claude stopped writing, or wrote differently, stops the part instead of uploading a guess', () => {
  function planWith(part, edit) {
    const manifest = manifestFixture()
    edit(manifest)
    return () => buildPlan(part, manifest, componentsFromModules(...fakeModules(manifest)))
  }
  assert.throws(planWith('vm-win32-x64', (m) => { m.vm = null }), /读不到工作区清单/)
  assert.throws(planWith('vm-win32-x64', (m) => { m.vm.sha = 'short' }), /读不到工作区清单/)
  assert.throws(planWith('vm-win32-arm64', (m) => { delete m.vm.files.win32.arm64 }), /没有这个平台的文件/)
  assert.throws(planWith('vm-unix-x64', (m) => { m.vm.files.unix.x64 = [] }), /没有这个平台的文件/)
  assert.throws(planWith('vm-unix-x64', (m) => { m.vm.files.unix.x64[0].name = '../rootfs.img' }), /文件名、校验值或大小不对/)
  assert.throws(planWith('vm-unix-x64', (m) => { m.vm.files.unix.x64[1].name = m.vm.files.unix.x64[0].name }), /文件名、校验值或大小不对/)
  assert.throws(planWith('vm-unix-x64', (m) => { m.vm.files.unix.x64[0].checksum = 'A'.repeat(64) }), /文件名、校验值或大小不对/)
  assert.throws(planWith('vm-unix-x64', (m) => { m.vm.files.unix.x64[0].size = 3 * 1024 * 1024 * 1024 }), /文件名、校验值或大小不对/)
  assert.throws(planWith('code-mac', (m) => { m.code = null }), /读不到 Claude Code 清单/)
  assert.throws(planWith('code-mac', (m) => { delete m.code.macBundles['darwin-x64'] }), /缺 Mac 程序包/)
  assert.throws(planWith('code-mac', (m) => { m.code.version = '2.1' }), /版本、校验值或大小不对/)
})

test('a missing file is downloaded from the official site, checked, uploaded under its checksum key and checked again', async () => {
  const fixture = createFixture('vm-win32-x64', { macManifest: manifestFixture() })
  const result = await fixture.run()
  const files = fixture.manifest.vm.files.win32.x64
  assert.deepEqual(result, { part: 'vm-win32-x64', vmShas: [VM_SHA], files: files.map((file) => ({ file: `${file.name}.zst`, bytes: file.size, state: 'uploaded' })) })
  assert.deepEqual(fixture.downloads.map((input) => input.url), [MSIX_URL, ...files.map((file) => `https://downloads.claude.ai/vms/linux/x64/${VM_SHA}/${file.name}.zst`)])
  for (const [index, input] of fixture.downloads.slice(1).entries()) {
    assert.equal(input.maxBytes, files[index].size)
    assert.equal(input.expectedBytes, files[index].size)
    assert.equal(input.expectedSha256, files[index].checksum)
    assert.equal(path.dirname(input.filePath), fixture.workDirectory)
  }
  assert.deepEqual(fixture.publications.map((entry) => entry.key), files.map((file) => `${PREFIX}/vm/${VM_SHA}/win32-x64/${file.checksum}/${file.name}.zst`))
  for (const { input } of fixture.publications) {
    assert.equal(input.contentType, CONTENT_TYPE)
    assert.equal(input.cacheControl, CACHE_CONTROL)
    assert.equal(input.overwrite, undefined)
  }
  assert.equal(fixture.removedFiles.length, 1 + files.length, 'the installer and every component are removed as soon as they are done')
  assert.deepEqual(fixture.removed, [fixture.workDirectory])
  const plan = fixture.events.find((event) => event.event === 'plan')
  assert.deepEqual(plan, { event: 'plan', part: 'vm-win32-x64', vmShas: [VM_SHA], files: files.map((file) => ({ file: `${file.name}.zst`, bytes: file.size })) })
  assert.doesNotMatch(JSON.stringify(fixture.events), /https?:\/\//)
})

test('a file the bucket already holds with the same size and checksum is not downloaded again', async () => {
  const manifest = manifestFixture()
  const present = manifest.code.macBundles['darwin-arm64']
  const key = `${PREFIX}/code/2.1.309/darwin-arm64/${present.checksum}/claude.app.tar.zst`
  const fixture = createFixture('code-mac', { manifest, macManifest: manifestFixture(), existing: new Map([[key, { bytes: present.size, sha256: present.checksum, etag: '"old"', contentType: CONTENT_TYPE }]]) })
  const result = await fixture.run()
  assert.deepEqual(result.files.map((file) => [file.file, file.state]), [['darwin-arm64/claude.app.tar.zst', 'present'], ['darwin-x64/claude.app.tar.zst', 'uploaded']])
  assert.deepEqual(fixture.downloads.map((input) => input.url), [MAC_ZIP_URL, 'https://downloads.claude.ai/claude-code-releases/2.1.309/darwin-x64/claude.app.tar.zst'])
  assert.equal(fixture.publications.length, 1)
})

test('an object under the key that does not match the manifest is left alone and stops the part', async () => {
  const manifest = manifestFixture()
  const file = manifest.vm.files.unix.arm64[0]
  const key = `${PREFIX}/vm/${VM_SHA}/unix-arm64/${file.checksum}/${file.name}.zst`
  const fixture = createFixture('vm-unix-arm64', { manifest, macManifest: manifestFixture(), existing: new Map([[key, { bytes: file.size, sha256: undefined, etag: '"foreign"' }]]) })
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(safeComponentsSyncFailure(error), { stage: 'cos-check-existing', part: 'vm-unix-arm64', file: 'rootfs.img.zst', expectedBytes: file.size, failure: { code: 'cos-object-mismatch' } })
    return true
  })
  assert.equal(fixture.publications.length, 0)
  assert.equal(fixture.objects.get(key).etag, '"foreign"')
  assert.deepEqual(fixture.removed, [fixture.workDirectory], 'the work directory is cleaned up after a failure too')
})

test('an official file that does not match the manifest is never uploaded', async () => {
  const manifest = manifestFixture()
  const file = manifest.vm.files.unix.x64[1]
  const bad = `https://downloads.claude.ai/vms/linux/x64/${VM_SHA}/${file.name}.zst`
  const fixture = createFixture('vm-unix-x64', { manifest, macManifest: manifestFixture(), corrupt: new Set([bad]) })
  await assert.rejects(fixture.run(), (error) => {
    const diagnostic = safeComponentsSyncFailure(error)
    assert.equal(diagnostic.stage, 'source-download')
    assert.equal(diagnostic.file, `${file.name}.zst`)
    assert.equal(diagnostic.failure.code, 'download-mismatch')
    assert.doesNotMatch(JSON.stringify(diagnostic), /https?:|downloads\.claude/)
    return true
  })
  assert.deepEqual(fixture.publications.map((entry) => entry.key), [`${PREFIX}/vm/${VM_SHA}/unix-x64/${manifest.vm.files.unix.x64[0].checksum}/rootfs.img.zst`])
})

test('the bucket must read back and HEAD exactly what was checked before the part counts as done', async () => {
  const readback = createFixture('code-mac')
  const publishFile = readback.store.publishFile
  readback.store.publishFile = async (...args) => ({ ...(await publishFile(...args)), sha256: '0'.repeat(64) })
  await assert.rejects(readback.run(), (error) => safeComponentsSyncFailure(error).stage === 'cos-publish')

  const head = createFixture('code-mac')
  const inspect = head.store.inspect
  let calls = 0
  head.store.inspect = async (key) => {
    calls += 1
    const result = await inspect(key)
    return result && calls === 2 ? { ...result, etag: '"other"' } : result
  }
  await assert.rejects(head.run(), (error) => safeComponentsSyncFailure(error).stage === 'cos-head')
})

test('a manifest that cannot be read is reported without the raw error', async () => {
  const fixture = createFixture('vm-win32-x64')
  fixture.components = { ...fixture.components, readManifest: async () => { throw new Error('asar-truncated at C:\\secret') } }
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(safeComponentsSyncFailure(error), { stage: 'read-manifest', part: 'vm-win32-x64', installer: 'windows', failure: { code: 'package-format-invalid' } })
    return true
  })
  assert.equal(fixture.publications.length, 0)
  assert.deepEqual(safeComponentsSyncFailure(new Error('not from a stage')), { stage: 'setup', failure: { code: 'operation-failed' } })
})

test('a part whose installer cannot be read uploads nothing and fails', async () => {
  const fixture = createFixture('vm-win32-x64', { failInstaller: 'windows' })
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(safeComponentsSyncFailure(error), { stage: 'source-resolve', part: 'vm-win32-x64', installer: 'windows', failure: { code: 'source-url-rejected' } })
    return true
  })
  assert.deepEqual(fixture.downloads, [])
  assert.deepEqual(fixture.publications, [])
  assert.deepEqual(fixture.removed, [fixture.workDirectory])
})

test('when a part is given both installers, one that cannot be read does not hold back the other, but the part still fails', async () => {
  for (const [failInstaller, sha] of [['macos', VM_SHA], ['windows', MAC_VM_SHA]]) {
    const fixture = createFixture('vm-unix-x64', { failInstaller })
    await assert.rejects(fixture.run(['windows', 'macos']), (error) => {
      assert.deepEqual(safeComponentsSyncFailure(error), { stage: 'source-resolve', part: 'vm-unix-x64', installer: failInstaller, failure: { code: 'source-url-rejected' } })
      return true
    })
    const readable = failInstaller === 'macos' ? fixture.manifest : fixture.macManifest
    assert.deepEqual(fixture.publications.map((entry) => entry.key), vmPlanItems(readable, 'unix', 'x64').map((item) => item.key))
    assert.ok(fixture.publications.every((entry) => entry.key.includes(`/vm/${sha}/`)))
  }
  await assert.rejects(synchronizeClaudeComponents({ part: 'code-mac', installers: ['linux'], store: {}, dependencies: {}, components: {} }), /安装包来源无效/)
  await assert.rejects(synchronizeClaudeComponents({ part: 'code-mac', installers: [], store: {}, dependencies: {}, components: {} }), /安装包来源无效/)
})

function fakeRequest(respond) {
  const calls = []
  function requestImpl(url, options, onResponse) {
    const request = new EventEmitter()
    request.destroyed = false
    request.destroy = () => { request.destroyed = true }
    request.end = () => {
      calls.push({ url: url.href, method: options.method, request })
      setImmediate(() => respond({ request, onResponse }))
    }
    return request
  }
  return { calls, requestImpl }
}

function redirectTo(status, location) {
  return ({ onResponse }) => {
    const response = new EventEmitter()
    response.statusCode = status
    response.headers = location === undefined ? {} : { location }
    response.destroyed = false
    response.destroy = () => { response.destroyed = true }
    onResponse(response)
  }
}

test('the Mac installer is found through one fixed redirect to a universal zip on downloads.claude.ai, reading headers only', async () => {
  const good = fakeRequest(redirectTo(307, MAC_ZIP_URL))
  assert.equal(await requestMacZipLocation({ requestImpl: good.requestImpl }), MAC_ZIP_URL)
  assert.deepEqual(good.calls.map((call) => [call.url, call.method]), [[MAC_ZIP_REQUEST_URL, 'GET']])
  assert.equal(good.calls[0].request.destroyed, true, 'the body is never read')
  for (const [status, location] of [
    [200, undefined],
    [307, undefined],
    [404, MAC_ZIP_URL],
    [307, MAC_ZIP_URL.replace('/universal/', '/arm64/')],
    [307, MAC_ZIP_URL.replace('downloads.claude.ai', 'downloads.claude.ai.evil.example')],
    [307, `${MAC_ZIP_URL}?x=1`],
    [307, MAC_ZIP_URL.replace('.zip', '.dmg')],
    [307, MAC_ZIP_URL.replace('https:', 'http:')],
    [307, 'https://downloads.claude.ai/releases/darwin/universal/latest/Claude.zip'],
  ]) {
    const { requestImpl } = fakeRequest(redirectTo(status, location))
    await assert.rejects(requestMacZipLocation({ requestImpl }), /没有跳到 downloads\.claude\.ai 的通用版 zip/, `${status} ${location}`)
  }
  const failing = fakeRequest(({ request }) => request.emit('error', new Error('ECONNRESET at C:\\secret')))
  await assert.rejects(requestMacZipLocation({ requestImpl: failing.requestImpl }), (error) => error.message === 'Claude Mac 安装包入口连不上')
  const silent = fakeRequest(() => {})
  await assert.rejects(requestMacZipLocation({ requestImpl: silent.requestImpl, headerTimeoutMs: 5 }), /响应头超时/)
  await assert.rejects(requestMacZipLocation({ headerTimeoutMs: 60000 }), /超时配置无效/)
})

test('each installer is resolved from its own fixed official entry', async () => {
  const resolved = []
  const options = {
    resolveOfficialPackage: async (url) => { resolved.push(url); return { url, bytes: 1, etag: '"e"' } },
    requestMacZipLocation: async () => MAC_ZIP_URL,
  }
  assert.deepEqual(INSTALLER_IDS, ['windows', 'macos'])
  assert.equal((await resolveInstaller('windows', options)).url, MSIX_REQUEST_URL)
  assert.equal((await resolveInstaller('macos', options)).url, MAC_ZIP_URL)
  assert.deepEqual(resolved, [MSIX_REQUEST_URL, MAC_ZIP_URL])
  await assert.rejects(resolveInstaller('linux', options), /安装包来源无效/)
})

test('app.asar is unpacked alone with unzip into a fresh directory, and anything but one regular file is refused', async (t) => {
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-claude-components-extract-'))
  t.after(() => fs.rm(workDirectory, { recursive: true, force: true }))
  const calls = []
  const asarPath = await extractAsar('/tmp/Claude.msix', workDirectory, 'windows', async (executable, args, options) => {
    calls.push({ executable, args, env: options.env })
    const target = path.join(args[args.indexOf('-d') + 1], 'app', 'resources')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'app.asar'), Buffer.alloc(4096))
    return { stdout: '', stderr: '' }
  }, 'linux')
  assert.equal(asarPath, path.join(workDirectory, 'windows', 'app', 'resources', 'app.asar'))
  assert.deepEqual(calls.map((call) => [call.executable, call.args]), [['/usr/bin/unzip', ['-qq', '-n', '/tmp/Claude.msix', 'app/resources/app.asar', '-d', path.join(workDirectory, 'windows')]]])
  assert.deepEqual(Object.keys(calls[0].env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'])

  const macCalls = []
  const macAsar = await extractAsar('/tmp/Claude.zip', workDirectory, 'macos', async (executable, args) => {
    macCalls.push(args)
    const target = path.join(args[args.indexOf('-d') + 1], 'Claude.app', 'Contents', 'Resources')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'app.asar'), Buffer.alloc(4096))
    return { stdout: '', stderr: '' }
  }, 'linux')
  assert.equal(macAsar, path.join(workDirectory, 'macos', 'Claude.app', 'Contents', 'Resources', 'app.asar'))
  assert.deepEqual(macCalls, [['-qq', '-n', '/tmp/Claude.zip', 'Claude.app/Contents/Resources/app.asar', '-d', path.join(workDirectory, 'macos')]])
  await assert.rejects(extractAsar('/tmp/Claude.zip', workDirectory, 'linux', async () => ({}), 'linux'), /安装包来源无效/)

  const missing = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-claude-components-extract-'))
  t.after(() => fs.rm(missing, { recursive: true, force: true }))
  await assert.rejects(extractAsar('/tmp/Claude.msix', missing, 'windows', async () => ({ stdout: '' }), 'linux'), /没有 app\.asar/)

  // A directory, and a file with a second hard link, are both refused (no symlink here: Windows runners
  // without the privilege cannot create one, and lstat already never follows it).
  for (const plant of [
    (target) => fs.mkdir(path.join(target, 'app.asar')),
    async (target) => {
      await fs.writeFile(path.join(target, 'app.asar'), Buffer.alloc(4096))
      await fs.link(path.join(target, 'app.asar'), path.join(target, 'other'))
    },
  ]) {
    const planted = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-claude-components-extract-'))
    t.after(() => fs.rm(planted, { recursive: true, force: true }))
    await assert.rejects(extractAsar('/tmp/Claude.msix', planted, 'windows', async (executable, args) => {
      const target = path.join(args[args.indexOf('-d') + 1], 'app', 'resources')
      await fs.mkdir(target, { recursive: true })
      await plant(target)
      return { stdout: '' }
    }, 'linux'), /不是普通文件/)
  }

  const failed = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-claude-components-extract-'))
  t.after(() => fs.rm(failed, { recursive: true, force: true }))
  await assert.rejects(extractAsar('/tmp/Claude.msix', failed, 'windows', async () => { throw Object.assign(new Error('unzip said C:\\Users\\me'), { code: 11 }) }, 'linux'), /解不出 app\.asar/)
  await assert.rejects(extractAsar('/tmp/Claude.msix', failed, 'windows', async () => ({}), 'win32'), /Linux 或 macOS/)
})

test('the bucket store splits every file from one part up, so the 15 MB workspace kernel is not sent in one slow PUT', () => {
  // 11-21 (#2069): the Windows vmlinuz.zst files are 14809069 and 15111617 bytes, under the shared 16 MiB start.
  assert.equal(MULTIPART_MIN_BYTES, PART_BYTES)
  assert.ok(MULTIPART_MIN_BYTES < 14809069 && 14809069 < THRESHOLD_BYTES)
  const created = []
  const store = {}
  const config = { bucket: 'bucket-1250000000' }
  assert.equal(createComponentsCosStore({ createCosStore(value, options) { created.push([value, options]); return store } }, config), store)
  assert.deepEqual(created, [[config, { multipartDeadlineMs: MULTIPART_DEADLINE_MS, multipartMinBytes: PART_BYTES }]])
  assert.equal(MULTIPART_DEADLINE_MS, 240 * 60 * 1000)
})

test('the runtime only ever deletes its own temporary directory', async () => {
  const dependencies = createRuntimeDependencies({ downloadResource: async () => ({}) })
  const directory = await dependencies.createWorkDirectory()
  assert.match(path.basename(directory), /^xingmang-claude-components-cos-/)
  await fs.writeFile(path.join(directory, 'leftover'), 'x')
  await dependencies.removeWorkDirectory(directory)
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' })
  await assert.rejects(dependencies.removeWorkDirectory(os.tmpdir()), /拒绝删除/)
  await assert.rejects(dependencies.removeWorkDirectory(path.join(os.tmpdir(), 'xingmang-claude-cos-other')), /拒绝删除/)
  await assert.rejects(dependencies.removeWorkDirectory('/home/runner/xingmang-claude-components-cos-x'), /拒绝删除/)
})
