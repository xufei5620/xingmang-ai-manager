const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { SOURCES, APT_ROOT, OFFICIAL_HOSTS, LATEST_KEY, MAX_PACKAGE_BYTES, WINDOWS_INSPECTION_SCRIPT,
  parsePlatforms, validateOfficialUrl, validateHead, compareVersions, resolveOfficialPackage, requestHead, requestRedirectHeaders,
  parseDebianPackages, artifactKey, validateIndex, validateWindowsInspection, synchronizeOfficialClaude,
  safeChildEnvironment, validatePackageMagic, darwinClaudeRequirement, inspectPackage } = require('./sync-claude-official-cos.cjs')

function clone(value) { return value === undefined ? undefined : structuredClone(value) }

function aptParagraph(architecture, version = '1.1.42', sha256 = 'a'.repeat(64)) {
  return `Package: claude-desktop\nVersion: ${version}\nArchitecture: ${architecture}\nSize: 1024\nSHA256: ${sha256}\nFilename: pool/main/c/claude-desktop/claude-desktop_${version}_${architecture}.deb\nDescription: Claude Desktop\n official package\n`
}

function windowsReport(architecture, version = '1.1.42.0') {
  return { identity: { name: 'Claude', architecture, version, publisherCanonical: 'RkFLRURJTg==', containsPackageSignature: true }, signature: { status: 'Valid', simpleName: 'Anthropic, PBC', subjectCanonical: 'RkFLRURJTg==' } }
}

function fixture() {
  const value = { latest: null, objects: new Map(), downloads: [], publications: [], pointers: [], candidates: [], inspections: [], reads: 0, removed: [], heads: new Map() }
  for (const [id, source] of Object.entries(SOURCES)) {
    const url = source.metadataUrl ? `${APT_ROOT}pool/main/c/claude-desktop/claude-desktop_1.1.42_${source.packageArchitecture}.deb` : `https://downloads.claude.ai/releases/mock/${id}/${source.fileName}`
    const sha256 = createHash('sha256').update(url).digest('hex')
    value.heads.set(id, { url, bytes: 1024, etag: `"${sha256.slice(0, 20)}"`, lastModified: 'Fri, 02 Oct 2026 04:00:00 GMT', sha256 })
  }
  value.dependencies = {
    async fetchText(input) {
      assert.deepEqual(input.allowedHosts, OFFICIAL_HOSTS)
      assert.equal(input.maxBytes, 1024 * 1024)
      const id = input.url.includes('binary-amd64') ? 'linux-deb-x64' : 'linux-deb-arm64'
      const source = SOURCES[id]
      return aptParagraph(source.packageArchitecture, value.linuxVersion || '1.1.42', value.heads.get(id).sha256)
    },
    async resolveOfficialPackage(requestUrl) {
      const [id] = Object.entries(SOURCES).find(([, source]) => source.requestUrl === requestUrl)
      const head = value.heads.get(id)
      return { ...clone(head), requestUrl, redirects: [{ from: requestUrl, to: head.url, status: 302 }] }
    },
    async inspectResource(input) {
      assert.deepEqual(input.allowedHosts, OFFICIAL_HOSTS)
      return clone([...value.heads.values()].find(head => head.url === input.url))
    },
    async downloadResource(input) {
      value.downloads.push(clone(input))
      assert.deepEqual(input.allowedHosts, OFFICIAL_HOSTS)
      const head = [...value.heads.values()].find(head => head.url === input.url)
      assert.ok(head)
      assert.equal(input.expectedEtag, head.etag)
      assert.equal(input.expectedBytes, head.bytes)
      if (input.expectedSha256) assert.equal(input.expectedSha256, head.sha256)
      return { ...clone(head), ...value.downloadOverride }
    },
    async validatePackageMagic() { if (value.badMagic) throw new Error('Mock invalid package magic') },
    async inspectPackage(input) {
      value.inspections.push(clone(input))
      if (value.badInspection) return { signatureStatus: 'Invalid' }
      if (input.source.platform === 'windows') return windowsReport(input.source.architecture, value.windowsVersion || '1.1.42.0')
      if (input.source.platform === 'linux') return { package: 'claude-desktop', architecture: input.source.packageArchitecture, version: value.linuxVersion || '1.1.42' }
      return { version: '1.1.42', signerOrganization: 'Anthropic PBC', teamIdentifier: 'Q6L2SF6YDW', signatureStatus: 'Valid', bundleIdentifier: 'com.anthropic.claudefordesktop', architectures: ['arm64', 'x86_64'], architectureProof: 'native-payload-mach-o', installerTeamIdentifier: 'Q6L2SF6YDW', installerSignatureStatus: 'Valid' }
    },
    async createWorkDirectory() { return path.join(os.tmpdir(), 'mock-claude-sync') },
    async removeWorkDirectory(directory) { value.removed.push(directory) },
  }
  value.store = {
    publicUrl(key) { return `https://mock.cos.ap-shanghai.myqcloud.com/${key}` },
    async readJson(key) {
      assert.equal(key, LATEST_KEY)
      value.reads += 1
      if (value.readOverride) return clone(value.readOverride(value.reads))
      return clone(value.latest)
    },
    async inspect(key) { return clone(value.objects.get(key)) },
    async publishFile(key, filePath, input) {
      value.publications.push({ key, filePath, ...input })
      if (value.publishError) throw new Error('Mock public readback failure')
      const result = { key, url: this.publicUrl(key), bytes: input.expectedBytes, sha256: input.expectedSha256, contentType: input.contentType, etag: `"cos-${input.expectedSha256.slice(0, 20)}"` }
      value.objects.set(key, result)
      return { ...result, ...value.publishOverride }
    },
    async publishJson(key, manifest, input) {
      if (key !== LATEST_KEY) {
        assert.match(key, /^xingmang\/offline\/claude\/indexes\/[a-f0-9]{64}\.json$/)
        assert.equal(input.overwrite, undefined)
        if (value.candidateError) throw new Error('Mock candidate verification failed')
        value.candidates.push(clone(manifest))
        return {}
      }
      assert.equal(input.overwrite, true)
      value.pointers.push(clone(manifest))
      if (value.pointerError && !value.appliedUnknownWrite) throw new Error('Mock unknown pointer result')
      value.latest = clone(manifest)
      if (value.pointerError) throw new Error('Mock unknown successful pointer result')
      return {}
    },
  }
  value.run = function (platforms) { return synchronizeOfficialClaude({ store: value.store, platforms, dependencies: value.dependencies, now: () => '2026-10-03T01:00:00.000Z' }) }
  return value
}

test('exposes only the six documented platforms and supports native runner aliases', () => {
  assert.equal(parsePlatforms('all').length, 6)
  assert.deepEqual(parsePlatforms('macos'), ['macos-dmg-universal', 'macos-pkg-universal'])
  assert.deepEqual(parsePlatforms('linux'), ['linux-deb-x64', 'linux-deb-arm64'])
  assert.throws(() => parsePlatforms('linux-rpm-x64'), /平台无效/)
  assert.throws(() => parsePlatforms('../escape'), /平台无效/)
})

test('permits only fixed documented official HTTPS scopes without credentials or signed queries', () => {
  assert.equal(validateOfficialUrl(SOURCES['windows-x64'].requestUrl).hostname, 'claude.ai')
  for (const value of ['http://claude.ai/api/desktop/x', 'https://downloads.claude.ai.evil.invalid/releases/x', 'https://user:password@claude.ai/api/desktop/x', 'https://storage.googleapis.com/arbitrary-bucket/x', `${SOURCES['windows-x64'].requestUrl}?secret=1`]) {
    assert.throws(() => validateOfficialUrl(value), /HTTPS 范围|未核实的主机/)
  }
})

test('validates numeric versions and rejects overlarge packages or unsafe ETags', () => {
  assert.equal(compareVersions('1.1.42.0', '1.1.41.999'), 1)
  assert.equal(compareVersions('1.1.42-2', '1.1.42-1'), 1)
  assert.throws(() => validateHead({ bytes: MAX_PACKAGE_BYTES + 1, etag: 'ok' }), /上限/)
  assert.throws(() => validateHead({ bytes: 1024, etag: 'unsafe\r\n' }), /ETag/)
})

test('checks every redirect hop and rejects unknown CDN, loops, or extra hops before payload download', async () => {
  const start = SOURCES['windows-x64'].requestUrl
  const target = 'https://downloads.claude.ai/releases/windows/Claude.msix'
  const good = await resolveOfficialPackage(start, { requestRedirectHeaders: async () => ({ status: 302, headers: { location: target } }), requestHead: async () => ({ status: 200, headers: { 'content-length': '1024', etag: '"source"' } }) })
  assert.equal(good.url, target)
  assert.equal(good.redirects.length, 1)
  await assert.rejects(resolveOfficialPackage(start, { requestRedirectHeaders: async () => ({ status: 302, headers: { location: 'https://evil.invalid/file' } }), requestHead: async () => { throw new Error('Unexpected static request') } }), /未核实的主机/)
  await assert.rejects(resolveOfficialPackage(start, { requestRedirectHeaders: async () => ({ status: 302, headers: { location: start } }), requestHead: async () => { throw new Error('Unexpected static request') } }), /循环/)
  let count = 0
  const redirect = async () => ({ status: 302, headers: { location: `${target}/${count++}` } })
  await assert.rejects(resolveOfficialPackage(start, { requestRedirectHeaders: redirect, requestHead: redirect }), /超过上限/)
})

test('uses headers-only GET for the documented Windows redirect that rejects HEAD then HEAD for the static package', async () => {
  for (const id of ['windows-x64', 'windows-arm64']) {
    const start = SOURCES[id].requestUrl
    const target = `https://downloads.claude.ai/releases/win32/${SOURCES[id].architecture}/2.19675.0/Claude-5706e5524dba58b23e105c31c358df8ab0a95852.msix`
    const calls = []
    const responses = []
    let bodyReads = 0
    const options = { requestImpl(url, input, callback) {
      calls.push({ url: url.href, method: input.method })
      assert.equal(input.headers.authorization, undefined)
      assert.equal(input.headers.cookie, undefined)
      assert.equal(input.agent, false)
      assert.equal(input.maxHeaderSize, 16 * 1024)
      const response = new Readable({ read() { bodyReads += 1; this.push('must not consume redirect or package bytes'); this.push(null) } })
      responses.push(response)
      response.statusCode = url.href === start ? input.method === 'HEAD' ? 405 : 307 : 200
      response.headers = response.statusCode === 307 ? { location: target } : { 'content-length': '1024', etag: '"source"' }
      const request = new EventEmitter()
      request.end = () => callback(response)
      request.destroy = () => {}
      return request
    } }
    assert.equal((await requestHead(start, options)).status, 405)
    const result = await resolveOfficialPackage(start, options)
    assert.equal(result.url, target)
    assert.equal(result.redirects.length, 1)
    assert.deepEqual(calls.map(call => call.method), ['HEAD', 'GET', 'HEAD'])
    assert.equal(bodyReads, 0)
    assert.equal(responses.every(response => response.destroyed), true)
  }
})

test('GET header probes reject unapproved endpoints, query redirects, unknown hosts and paths before the next request', async () => {
  let requests = 0
  const options = { requestImpl(url, input, callback) {
    requests += 1
    const request = new EventEmitter()
    request.end = () => callback({ statusCode: 307, headers: { location: options.redirect }, destroy() {} })
    request.destroy = () => {}
    return request
  } }
  const start = SOURCES['windows-x64'].requestUrl
  for (const invalid of [start + '?token=secret', 'https://claude.ai/api/desktop/arbitrary', 'https://downloads.claude.ai/releases/file.msix']) {
    await assert.rejects(requestRedirectHeaders(invalid, options))
    assert.equal(requests, 0)
  }
  for (const redirect of ['https://evil.invalid/file.msix', 'https://downloads.claude.ai/releases/file.msix?token=secret', 'https://downloads.claude.ai/arbitrary/file.msix']) {
    options.redirect = redirect
    const before = requests
    await assert.rejects(resolveOfficialPackage(start, options))
    assert.equal(requests, before + 1)
  }
})

test('GET header deadline destroys a stalled request and preserves timeout classification without raw errors', async () => {
  let destroyed = false
  await assert.rejects(requestRedirectHeaders(SOURCES['windows-x64'].requestUrl, { headerTimeoutMs: 20, requestImpl() {
    const request = new EventEmitter()
    request.end = () => {}
    request.destroy = () => { destroyed = true; request.emit('error', new Error('Bearer SECRET')) }
    return request
  } }), error => /响应头超时/.test(error.message) && !error.message.includes('SECRET'))
  assert.equal(destroyed, true)
  await assert.rejects(requestRedirectHeaders(SOURCES['windows-x64'].requestUrl, { headerTimeoutMs: 30001 }), /超时配置/)
})

test('HEAD resolver has fixed anonymous headers and destroys redirect response bodies', async () => {
  let destroyed = false
  const result = await requestHead(SOURCES['windows-x64'].requestUrl, { requestImpl(url, options, callback) {
    assert.equal(options.method, 'HEAD')
    assert.equal(options.headers.authorization, undefined)
    assert.equal(options.headers.cookie, undefined)
    assert.equal(options.maxHeaderSize, 16 * 1024)
    const request = new EventEmitter()
    request.end = () => callback({ statusCode: 302, headers: { location: '/api/desktop/next' }, destroy() { destroyed = true } })
    request.destroy = () => {}
    return request
  } })
  assert.equal(result.status, 302)
  assert.equal(destroyed, true)
})

test('parses package-index identity, version ordering, SHA256, and fixed pool paths', () => {
  const result = parseDebianPackages(`${aptParagraph('amd64', '1.1.9')}\n${aptParagraph('amd64', '1.1.42')}`, 'amd64')
  assert.equal(result.version, '1.1.42')
  assert.ok(result.url.startsWith(APT_ROOT))
  for (const text of [aptParagraph('arm64'), aptParagraph('amd64').replace('pool/main/c/claude-desktop/', '../../'), aptParagraph('amd64').replace('a'.repeat(64), 'wrong'), `${aptParagraph('amd64')}\n${aptParagraph('amd64')}`]) {
    assert.throws(() => parseDebianPackages(text, 'amd64'))
  }
})

test('requires genuine Claude identity, signer, architecture, and publisher-DN equality', () => {
  assert.equal(validateWindowsInspection(windowsReport('x64'), 'x64').version, '1.1.42.0')
  for (const mutate of [value => { value.identity.name = 'Attacker' }, value => { value.identity.architecture = 'arm64' }, value => { value.signature.status = 'NotTrusted' }, value => { value.signature.simpleName = 'Attacker' }, value => { value.signature.subjectCanonical = 'DIFFERENT' }]) {
    const report = windowsReport('x64')
    mutate(report)
    assert.throws(() => validateWindowsInspection(report, 'x64'), /不匹配/)
  }
})

test('downloads and validates all candidates before any upload then publishes immutable objects and latest last', async () => {
  const value = fixture()
  const result = await value.run('all')
  assert.equal(result.manifest.product, 'claude-desktop')
  assert.equal(result.manifest.files.length, 6)
  assert.equal(value.downloads.length, 6)
  assert.equal(value.inspections.length, 6)
  assert.equal(value.publications.length, 6)
  assert.equal(value.candidates.length, 1)
  assert.equal(value.pointers.length, 1)
  for (const entry of result.manifest.files) {
    assert.equal(entry.key, artifactKey(entry.platformId, entry.sha256))
    assert.equal(entry.kind, 'installer')
    assert.equal(entry.size, 1024)
    assert.equal(entry.source.url, undefined)
    assert.equal(entry.source.redirects, undefined)
    assert.equal(entry.source.requestUrl, SOURCES[entry.platformId].requestUrl || SOURCES[entry.platformId].metadataUrl)
    if (entry.platform === 'linux') assert.equal(entry.inspection.aptSignatureVerified, false)
  }
})

test('preserves other platforms during serialized native runner supplements', async () => {
  const value = fixture()
  await value.run('windows')
  await value.run('macos')
  const result = await value.run('linux')
  assert.equal(result.manifest.files.length, 6)
  const downloads = value.downloads.length
  assert.equal((await value.run('all')).changed, false)
  assert.equal(value.downloads.length, downloads)
})

test('keeps every Claude write within the existing manager permission without using manager release paths', async () => {
  const value = fixture()
  const result = await value.run('all')
  assert.equal(LATEST_KEY, 'xingmang/offline/claude/latest.json')
  assert.equal(value.candidates.length, 1)
  assert.equal(value.pointers.length, 1)
  for (const publication of value.publications) {
    assert.match(publication.key, /^xingmang\/offline\/claude\/(?:windows|macos|linux)-[a-z0-9-]+\/sha256-[a-f0-9]{64}\/[A-Za-z0-9._-]+$/)
    assert.equal(publication.key.startsWith('xingmang/releases/'), false)
  }
  const oldPrefix = clone(result.manifest)
  oldPrefix.files[0].key = oldPrefix.files[0].key.replace('xingmang/offline/claude/', 'claude/')
  oldPrefix.files[0].url = value.store.publicUrl(oldPrefix.files[0].key)
  assert.throws(() => validateIndex(oldPrefix, value.store.publicUrl), /无效平台/)
})

test('rejects bad native verification, magic, bytes, ETag or SHA256 before any remote writes', async () => {
  for (const failure of ['native', 'magic', 'bytes', 'etag', 'sha256']) {
    const value = fixture()
    if (failure === 'native') value.badInspection = true
    else if (failure === 'magic') value.badMagic = true
    else value.downloadOverride = { [failure]: failure === 'bytes' ? 2 : 'wrong' }
    await assert.rejects(value.run('windows'))
    assert.equal(value.publications.length, 0)
    assert.equal(value.pointers.length, 0)
    assert.equal(value.removed.length, 1)
  }
})

test('rejects package-index hashes that differ from the Linux payload bytes', async () => {
  const value = fixture()
  value.downloadOverride = { sha256: 'f'.repeat(64) }
  await assert.rejects(value.run('linux'), /SHA256/)
  assert.equal(value.publications.length, 0)
})

test('rejects downgrade even after native version inspection and preserves the previous latest', async () => {
  const value = fixture()
  await value.run('windows')
  const old = clone(value.latest)
  value.windowsVersion = '1.1.40.0'
  value.heads.get('windows-x64').etag = '"changed"'
  await assert.rejects(value.run('windows'), /版本倒退/)
  assert.deepEqual(value.latest, old)
})

test('fails closed for untrusted prior index URLs and digest paths', async () => {
  const value = fixture()
  await value.run('windows')
  const manifest = clone(value.latest)
  manifest.files[0].url = 'https://evil.invalid/file'
  assert.throws(() => validateIndex(manifest, value.store.publicUrl), /无效平台/)
  manifest.files[0].url = value.store.publicUrl(manifest.files[0].key)
  manifest.files[0].source.url = 'https://downloads.claude.ai/releases/temporary?signed=secret'
  assert.throws(() => validateIndex(manifest, value.store.publicUrl), /非公开字段/)
  delete manifest.files[0].source.url
  manifest.files[0].key = 'claude/arbitrary/file'
  assert.throws(() => validateIndex(manifest, value.store.publicUrl), /无效平台/)
})

test('retains the old pointer on upload or candidate verification failure', async () => {
  for (const failure of ['publishError', 'candidateError']) {
    const value = fixture()
    value[failure] = true
    await assert.rejects(value.run('windows'))
    assert.equal(value.latest, null)
    assert.equal(value.pointers.length, 0)
  }
})

test('detects a pointer change during candidate verification without overwriting it', async () => {
  const value = fixture()
  await value.run('windows')
  const old = clone(value.latest)
  const concurrent = { ...clone(old), generatedAt: 'changed-by-other-job' }
  value.readOverride = count => count === 3 ? old : concurrent
  await assert.rejects(value.run('macos'), /同步期间变化/)
  assert.equal(value.pointers.length, 1)
})

test('reconciles unknown latest write outcomes by one readback without retry or rollback', async () => {
  const applied = fixture()
  applied.pointerError = true
  applied.appliedUnknownWrite = true
  assert.equal((await applied.run('windows')).changed, true)
  assert.equal(applied.pointers.length, 1)
  const unknown = fixture()
  unknown.pointerError = true
  await assert.rejects(unknown.run('windows'), /未重复写入/)
  assert.equal(unknown.pointers.length, 1)
  assert.equal(unknown.reads, 3)
  assert.equal(unknown.latest, null)
})

test('native subprocesses have no COS credentials and never run installers or archive scripts', () => {
  const env = safeChildEnvironment('mock-private-directory')
  assert.equal(env.COS_SECRET_ID, undefined)
  assert.equal(env.COS_SECRET_KEY, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.match(WINDOWS_INSPECTION_SCRIPT, /DtdProcessing=\[Xml\.DtdProcessing\]::Prohibit/)
  assert.match(WINDOWS_INSPECTION_SCRIPT, /Get-AuthenticodeSignature -LiteralPath/)
  assert.doesNotMatch(WINDOWS_INSPECTION_SCRIPT, /Add-AppxPackage|msiexec|Start-Process/)
})

test('checks actual package-container magic without installing packages', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-magic-test-'))
  try {
    const buffers = { msix: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), pkg: Buffer.from('xar!fake'), deb: Buffer.from('!<arch>\n'), dmg: Buffer.alloc(1024) }
    buffers.dmg.write('koly', 512)
    for (const [format, body] of Object.entries(buffers)) {
      const filePath = path.join(directory, format)
      await fs.writeFile(filePath, body)
      await validatePackageMagic(filePath, format, body.length)
    }
    const fake = path.join(directory, 'wrong')
    await fs.writeFile(fake, '<html>fake</html>')
    await assert.rejects(validatePackageMagic(fake, 'msix', 17), /格式无效/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

async function macFixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-claude-dmg-'))
  const value = { directory, calls: [], mounted: false }
  value.run = async function (executable, args, input) {
    value.calls.push({ executable, args, input })
    assert.equal(input.env.COS_SECRET_KEY, undefined)
    if (executable === '/usr/bin/hdiutil') {
      if (args[0] === 'attach') {
        value.mounted = true
        if (options.attachUnknown) throw new Error('Mock reply lost after mount succeeded')
      } else if (args[0] === 'detach') {
        if (!options.detachFailure || options.detachedDespiteError) value.mounted = false
        if (!value.mounted && options.removeMountPoint) await fs.rmdir(path.join(directory, 'claude-dmg-readonly'))
        if (options.detachFailure) throw new Error('Mock detach reply failure')
      } else if (args[0] === 'info') {
        if (options.stateFailure) throw new Error('Mock mount inspection failed')
        return { stdout: '<plist><dict/></plist>', stderr: '' }
      }
    }
    if (executable === '/usr/bin/plutil') {
      if (args.at(-1).endsWith('Info.plist')) return { stdout: JSON.stringify({ CFBundleExecutable: 'Claude', CFBundleIdentifier: 'com.anthropic.claudefordesktop', CFBundleShortVersionString: '1.1.42' }), stderr: '' }
      return { stdout: JSON.stringify({ images: value.mounted ? [{ 'system-entities': [{ 'mount-point': path.join(directory, 'claude-dmg-readonly') }] }] : [] }), stderr: '' }
    }
    if (executable === '/usr/bin/codesign') {
      if (args[0] === '--display') return { stdout: '', stderr: 'Identifier=forged\nAuthority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)\nTeamIdentifier=Q6L2SF6YDW\n' }
      const requirement = args.find(arg => arg.startsWith('-R='))
      assert.ok(requirement, 'trust must be decided by an explicit requirement')
      for (const clause of ['anchor apple generic', '1.2.840.113635.100.6.2.6', '1.2.840.113635.100.6.1.13', 'subject.CN', 'subject.O', 'subject.OU', 'identifier "com.anthropic.claudefordesktop"']) assert.ok(requirement.includes(clause))
      if (options.rejectForgedSignature) throw new Error('Mock ad-hoc or other-team certificate rejected by requirement')
    }
    if (executable === '/usr/bin/lipo') return { stdout: 'x86_64 arm64\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  value.inspect = function () { return inspectPackage({ filePath: path.join(directory, 'Claude-universal.dmg'), source: SOURCES['macos-dmg-universal'], workDirectory: directory, run: value.run, platform: 'darwin' }) }
  value.cleanup = function () { return fs.rm(directory, { recursive: true, force: true }) }
  return value
}

test('an uncertain successful attach still detaches and verifies absence before normal cleanup', async () => {
  const value = await macFixture({ attachUnknown: true })
  try {
    await assert.rejects(value.inspect(), /原生只读包检查失败/)
    assert.equal(value.mounted, false)
    assert.equal(value.calls.filter(call => call.args[0] === 'detach').length, 1)
    assert.equal(value.calls.filter(call => call.args[0] === 'info').length, 1)
    assert.equal(value.calls.some(call => call.executable === '/usr/bin/codesign'), false)
  } finally { await value.cleanup() }
})

test('an uncertain attach plus failed detach preserves the work directory and forbids outer recursive cleanup', async () => {
  const mac = await macFixture({ attachUnknown: true, detachFailure: true })
  try {
    const value = fixture()
    value.dependencies.createWorkDirectory = async () => mac.directory
    value.dependencies.inspectPackage = input => inspectPackage({ ...input, run: mac.run, platform: 'darwin' })
    await assert.rejects(value.run(['macos-dmg-universal']), error => error.preserveWorkDirectory === true && /禁止递归清理/.test(error.message))
    assert.equal(mac.mounted, true)
    assert.equal(value.removed.length, 0)
    assert.equal(value.publications.length, 0)
    assert.equal(value.pointers.length, 0)
    assert.equal((await fs.stat(mac.directory)).isDirectory(), true)
  } finally { await mac.cleanup() }
})

test('a lost detach reply can be reconciled by an independently empty mount table', async () => {
  const value = await macFixture({ detachFailure: true, detachedDespiteError: true })
  try {
    const report = await value.inspect()
    assert.equal(report.signatureStatus, 'Valid')
    assert.equal(value.mounted, false)
    assert.equal(value.calls.filter(call => call.args[0] === 'info').length, 1)
  } finally { await value.cleanup() }
})

test('failed mount-state inspection preserves the work directory even after a successful detach reply', async () => {
  const value = await macFixture({ stateFailure: true })
  try { await assert.rejects(value.inspect(), error => error.preserveWorkDirectory === true) } finally { await value.cleanup() }
})

test('an unmount that removes its mount directory still has a verifiable absent mount state', async () => {
  const value = await macFixture({ removeMountPoint: true })
  try {
    assert.equal((await value.inspect()).signatureStatus, 'Valid')
    assert.equal(value.mounted, false)
  } finally { await value.cleanup() }
})

test('forged Authority prose or ad-hoc code cannot bypass the Apple certificate requirement', async () => {
  const value = await macFixture({ rejectForgedSignature: true })
  try {
    await assert.rejects(value.inspect(), /原生只读包检查失败/)
    assert.equal(value.mounted, false)
    assert.equal(value.calls.some(call => call.executable === '/usr/bin/lipo'), false)
    assert.throws(() => darwinClaudeRequirement('TEAM000001" or true'), /候选无效/)
    assert.throws(() => darwinClaudeRequirement('TEAM000001'), /候选无效/)
    const requirement = darwinClaudeRequirement('Q6L2SF6YDW')
    assert.ok(requirement.includes('certificate leaf[subject.CN] = "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)"'))
  } finally { await value.cleanup() }
})
