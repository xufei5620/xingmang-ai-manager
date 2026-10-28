const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const asar = require('@electron/asar')
const YAML = require('yaml')
const {
  CUSTOMER_SETTINGS,
  UPDATE_KEY_MODULE,
  addHostsBlock,
  applyCustomerSettings,
  asarFileIntegrity,
  asarHeaderHash,
  createFeedServer,
  describeLogEntry,
  describeUpdaterEntries,
  extractNetworkTargets,
  findLostSettings,
  findPinnedUpdateKeys,
  findSafeStorageItem,
  findVersionUpdatedEntry,
  generateUpdateSigningKey,
  parseRuntimeLog,
  readAsarLayout,
  readDownloadedVersion,
  readLastRunVersion,
  readPackedAsarFile,
  readWindowsAsarIntegrity,
  removeHostsBlock,
  resolveUpgradeTestVersion,
  rewriteMacManifestEntry,
  rewriteUpdateFeedUrl,
  selectMacUpdateFile,
  setWindowsAsarIntegrity,
  sha512Base64,
  swapAsarText,
} = require('./upgrade-smoke-support.cjs')
const { parseLatestMetadata } = require('./update-release-utils.cjs')
const { verifyManifestText, signManifestText } = require('./update-manifest-signature.cjs')
const { parseArguments } = require('./upgrade-smoke.cjs')

const PUBLISHER_KEY = 'MCowBQYDK2VwAyEAoPgUK8oEbKhzPMGpEAOmkOBaIjgSGazK/p0np8+nI5s='
const DIGEST = Object.fromEntries(['setup', 'arm', 'intel', 'dmg', 'arm-new', 'intel-new'].map((name) => [name, sha512Base64(Buffer.from(name))]))

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

// A packed app laid out like the real one: the key module under
// dist-electron/, the same key quoted somewhere else, and a file without it.
async function packedApp(t, { keyModule = `const keys = ['${PUBLISHER_KEY}']\n` } = {}) {
  const root = temporaryDirectory(t, 'xingmang-upgrade-asar-')
  const source = path.join(root, 'app')
  fs.mkdirSync(path.join(source, 'dist-electron'), { recursive: true })
  if (keyModule !== null) fs.writeFileSync(path.join(source, UPDATE_KEY_MODULE), keyModule)
  fs.writeFileSync(path.join(source, 'dist-electron', 'notes.js'), `// mentions ${PUBLISHER_KEY} in passing\n`)
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'xingmang-ai-manager', version: '0.2.19' }))
  const archive = path.join(root, 'app.asar')
  await asar.createPackage(source, archive)
  return archive
}

function recordedIntegrity(buffer, filePath) {
  let node = readAsarLayout(buffer).header
  for (const part of filePath.split('/')) node = node.files[part]
  return node.integrity
}

function emptyExecutableWithIntegrity(value) {
  const { NtExecutable, NtExecutableResource } = require('resedit')
  const image = NtExecutable.createEmpty(false, false)
  const resources = NtExecutableResource.from(image)
  const encoded = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value }]))
  resources.entries.push({
    type: 'INTEGRITY',
    id: 'ELECTRONASAR',
    lang: 1033,
    codepage: 0,
    bin: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
  })
  resources.outputResource(image)
  return Buffer.from(image.generate())
}

function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

test('rewriteUpdateFeedUrl changes only the feed and keeps the cache directory', () => {
  const installed = 'provider: generic\nurl: https://updatesnew.shenfengwl.fun/xingmang-manager/\nupdaterCacheDirName: xingmang-ai-manager-updater\n'
  const rewritten = YAML.parse(rewriteUpdateFeedUrl(installed, 'http://127.0.0.1:18123/'))
  assert.deepEqual(rewritten, {
    provider: 'generic',
    url: 'http://127.0.0.1:18123/',
    updaterCacheDirName: 'xingmang-ai-manager-updater',
  })
})

test('rewriteUpdateFeedUrl refuses a feed it does not recognize', () => {
  assert.throws(() => rewriteUpdateFeedUrl('provider: github\nowner: x\n', 'http://127.0.0.1/'), /generic/)
  assert.throws(() => rewriteUpdateFeedUrl('provider: [', 'http://127.0.0.1/'), /YAML/)
})

test('asarFileIntegrity keeps an empty last block when the size is a multiple of the block', () => {
  const integrity = asarFileIntegrity(Buffer.from('abcdefgh'), 4)
  assert.equal(integrity.blocks.length, 3)
  assert.equal(integrity.blocks[2], crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  assert.equal(asarFileIntegrity(Buffer.from('abcdefghi'), 4).blocks.length, 3)
})

test('asarFileIntegrity matches what @electron/asar records', async (t) => {
  const archive = fs.readFileSync(await packedApp(t))
  const recorded = recordedIntegrity(archive, UPDATE_KEY_MODULE)
  const content = readPackedAsarFile(archive, UPDATE_KEY_MODULE)
  assert.deepEqual(asarFileIntegrity(content, recorded.blockSize), recorded)
})

test('findPinnedUpdateKeys reads the keys out of the old version\'s own key module', async (t) => {
  const archive = fs.readFileSync(await packedApp(t))
  assert.deepEqual(findPinnedUpdateKeys(archive), [PUBLISHER_KEY])
})

test('findPinnedUpdateKeys refuses an archive without the key module or without a key', async (t) => {
  const withoutModule = fs.readFileSync(await packedApp(t, { keyModule: null }))
  const withoutKey = fs.readFileSync(await packedApp(t, { keyModule: 'module.exports = []\n' }))
  assert.throws(() => findPinnedUpdateKeys(withoutModule), /update-package-signature/)
  assert.throws(() => findPinnedUpdateKeys(withoutKey), /找不到/)
})

test('swapAsarText swaps the key in place and keeps the archive loadable', async (t) => {
  const archivePath = await packedApp(t)
  const archive = fs.readFileSync(archivePath)
  const before = asarHeaderHash(archive)
  const { publicKeyBase64 } = generateUpdateSigningKey()
  const { changed, headerHash } = swapAsarText(archive, { from: [PUBLISHER_KEY], to: publicKeyBase64, files: [UPDATE_KEY_MODULE] })
  assert.deepEqual(changed, [UPDATE_KEY_MODULE])
  assert.notEqual(headerHash, before)
  assert.equal(headerHash, asarHeaderHash(archive))
  fs.writeFileSync(archivePath, archive)
  asar.uncacheAll()
  const swapped = asar.extractFile(archivePath, UPDATE_KEY_MODULE).toString('utf8')
  assert.equal(swapped, `const keys = ['${publicKeyBase64}']\n`)
  const recorded = recordedIntegrity(archive, UPDATE_KEY_MODULE)
  assert.deepEqual(asarFileIntegrity(Buffer.from(swapped), recorded.blockSize), recorded)
  // Outside the named files the old key is left exactly as it was.
  assert.match(asar.extractFile(archivePath, 'dist-electron/notes.js').toString('utf8'), new RegExp(PUBLISHER_KEY.replace(/[+/]/g, '\\$&')))
  assert.equal(JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8')).version, '0.2.19')
})

test('swapAsarText refuses a replacement of another length or a text it cannot find', async (t) => {
  const archive = fs.readFileSync(await packedApp(t))
  const untouched = Buffer.from(archive)
  assert.throws(() => swapAsarText(archive, { from: [PUBLISHER_KEY], to: `${PUBLISHER_KEY}x` }), /一样长/)
  assert.throws(() => swapAsarText(archive, { from: ['MCowBQYDK2VwAyEA'.padEnd(PUBLISHER_KEY.length - 1, 'A') + '='], to: PUBLISHER_KEY }), /找不到/)
  assert.ok(archive.equals(untouched))
})

test('swapAsarText refuses a file whose recorded integrity does not match its content', async (t) => {
  const archive = fs.readFileSync(await packedApp(t))
  const content = readPackedAsarFile(archive, UPDATE_KEY_MODULE)
  content[0] = content[0] === 0x63 ? 0x64 : 0x63
  assert.throws(() => swapAsarText(archive, { from: [PUBLISHER_KEY], to: generateUpdateSigningKey().publicKeyBase64, files: [UPDATE_KEY_MODULE] }), /对不上/)
})

test('setWindowsAsarIntegrity rewrites the header hash the executable expects', () => {
  const executable = emptyExecutableWithIntegrity('a'.repeat(64))
  assert.equal(readWindowsAsarIntegrity(executable), 'a'.repeat(64))
  const result = setWindowsAsarIntegrity(executable, 'b'.repeat(64))
  assert.equal(result.previous, 'a'.repeat(64))
  assert.equal(readWindowsAsarIntegrity(result.executable), 'b'.repeat(64))
  assert.throws(() => setWindowsAsarIntegrity(executable, 'not-a-hash'), /格式/)
})

test('setWindowsAsarIntegrity refuses an executable without the integrity record', () => {
  const { NtExecutable } = require('resedit')
  const bare = Buffer.from(NtExecutable.createEmpty(false, false).generate())
  assert.equal(readWindowsAsarIntegrity(bare), null)
  assert.throws(() => setWindowsAsarIntegrity(bare, 'b'.repeat(64)), /正好有一份/)
})

test('a manifest signed with the run key verifies against that key only', () => {
  const key = generateUpdateSigningKey()
  const manifest = `version: 0.2.23\nfiles:\n  - url: XingMang-AI-Manager-0.2.23-Setup.exe\n    sha512: ${DIGEST.setup}\n    size: 3\npath: XingMang-AI-Manager-0.2.23-Setup.exe\nsha512: ${DIGEST.setup}\nreleaseDate: '2026-10-28T00:00:00.000Z'\n`
  const signed = signManifestText(manifest, key.privateKey, [key.publicKeyBase64])
  assert.doesNotThrow(() => verifyManifestText(signed, [key.publicKeyBase64]))
  assert.throws(() => verifyManifestText(signed, [PUBLISHER_KEY]))
})

test('resolveUpgradeTestVersion stays above every release under test', () => {
  assert.equal(resolveUpgradeTestVersion('0.2.21', ['0.2.19', '0.2.22']), '0.2.23')
  assert.equal(resolveUpgradeTestVersion('0.2.23', ['0.2.19', '0.2.22']), '0.2.23')
  assert.equal(resolveUpgradeTestVersion('0.2.22', ['0.2.22', '0.2.19']), '0.2.23')
  assert.equal(resolveUpgradeTestVersion('0.3.0', ['0.2.22']), '0.3.0')
})

test('rewriteMacManifestEntry moves the top-level digest only for the primary file', () => {
  const manifest = [
    'version: 0.2.23',
    'files:',
    '  - url: XingMang-AI-Manager-0.2.23-Apple-Silicon-arm64.zip',
    `    sha512: ${DIGEST.arm}`,
    '    size: 10',
    '  - url: XingMang-AI-Manager-0.2.23-Intel-x64.zip',
    `    sha512: ${DIGEST.intel}`,
    '    size: 11',
    'path: XingMang-AI-Manager-0.2.23-Apple-Silicon-arm64.zip',
    `sha512: ${DIGEST.arm}`,
    "releaseDate: '2026-10-28T00:00:00.000Z'",
    '',
  ].join('\n')
  const primary = YAML.parse(rewriteMacManifestEntry(manifest, 'XingMang-AI-Manager-0.2.23-Apple-Silicon-arm64.zip', { sha512: DIGEST['arm-new'], size: 20 }))
  assert.equal(primary.files[0].sha512, DIGEST['arm-new'])
  assert.equal(primary.files[0].size, 20)
  assert.equal(primary.files[1].sha512, DIGEST.intel)
  assert.equal(primary.sha512, DIGEST['arm-new'])
  const other = YAML.parse(rewriteMacManifestEntry(manifest, 'XingMang-AI-Manager-0.2.23-Intel-x64.zip', { sha512: DIGEST['intel-new'], size: 21 }))
  assert.equal(other.files[1].sha512, DIGEST['intel-new'])
  assert.equal(other.sha512, DIGEST.arm)
  assert.throws(() => rewriteMacManifestEntry(manifest, 'missing.zip', { sha512: DIGEST.setup, size: 1 }), /没有/)
})

test('selectMacUpdateFile picks the ZIP electron-updater would take on each chip', () => {
  const metadata = parseLatestMetadata([
    'version: 0.2.23',
    'files:',
    '  - url: XingMang-AI-Manager-0.2.23-Intel-x64.zip',
    `    sha512: ${DIGEST.intel}`,
    '    size: 1',
    '  - url: XingMang-AI-Manager-0.2.23-Apple-Silicon-arm64.zip',
    `    sha512: ${DIGEST.arm}`,
    '    size: 2',
    '  - url: XingMang-AI-Manager-0.2.23-Apple-Silicon-arm64.dmg',
    `    sha512: ${DIGEST.dmg}`,
    '    size: 3',
    'path: XingMang-AI-Manager-0.2.23-Intel-x64.zip',
    `sha512: ${DIGEST.intel}`,
    "releaseDate: '2026-10-28T00:00:00.000Z'",
    '',
  ].join('\n'), 'latest-mac.yml')
  assert.equal(selectMacUpdateFile(metadata, 'arm64').relativePath, 'XingMang-AI-Manager-0.2.23-Apple-Silicon-arm64.zip')
  assert.equal(selectMacUpdateFile(metadata, 'x64').relativePath, 'XingMang-AI-Manager-0.2.23-Intel-x64.zip')
})

test('extractNetworkTargets blocks production hosts and leaves the runner\'s own traffic alone', () => {
  const targets = extractNetworkTargets([
    "const site = 'https://xm.solov.cc/api/status'",
    "const line2 = 'xm-direct.solov.cc'",
    "const notAHost = 'settings.json'",
    'fetch(`https://updatesnew.shenfengwl.fun/xingmang-manager/latest.yml`)',
    "const raw = 'http://38.147.105.28:8080/'",
    "const local = 'http://127.0.0.1:18123/'",
    "const docs = 'https://github.com/xufei5620/xingmang-ai-manager/releases'",
    "const probe = 'http://www.msftconnecttest.com/connecttest.txt'",
    "const captive = 'http://captive.apple.com/hotspot-detect.html'",
    "const sample = 'https://relay.example.com/v1'",
    "const ws = 'wss://ws.solov.cc/socket'",
  ])
  assert.deepEqual(targets.hosts, ['updatesnew.shenfengwl.fun', 'ws.solov.cc', 'xm-direct.solov.cc', 'xm.solov.cc'])
  assert.deepEqual(targets.addresses, ['38.147.105.28'])
})

test('addHostsBlock and removeHostsBlock put the hosts file back the way it was', () => {
  const original = '127.0.0.1 localhost\r\n# keep me\r\n'
  const blocked = addHostsBlock(original, ['xm.solov.cc', 'api.solov.cc'])
  assert.match(blocked, /^127\.0\.0\.1 xm\.solov\.cc$/m)
  assert.match(blocked, /^::1 api\.solov\.cc$/m)
  assert.equal(addHostsBlock(blocked, ['xm.solov.cc']).match(/xingmang-upgrade-smoke begin/g).length, 1)
  assert.equal(removeHostsBlock(blocked), original.replace(/\r\n/g, '\n'))
  assert.equal(removeHostsBlock('127.0.0.1 localhost'), '127.0.0.1 localhost')
  assert.throws(() => removeHostsBlock('# xingmang-upgrade-smoke begin\n127.0.0.1 a\n'), /没有结尾/)
})

test('the version records read the way the apps write them', () => {
  assert.equal(readDownloadedVersion(JSON.stringify({ downloadedVersion: '0.2.23', attemptedVersion: null })), '0.2.23')
  assert.equal(readDownloadedVersion('{"downloadedVersion":null}'), null)
  assert.equal(readDownloadedVersion('{"downloadedVer'), null)
  assert.equal(readLastRunVersion(JSON.stringify({ version: 1, lastRunVersion: '0.2.23' })), '0.2.23')
  assert.equal(readLastRunVersion(''), null)
})

test('findVersionUpdatedEntry finds the first start after the update in a log cut off by a kill', () => {
  const log = [
    JSON.stringify({ id: '1', timestamp: 't1', level: 'info', source: 'updater', event: 'update.downloaded', message: '下好了', detail: { version: '0.2.23' } }),
    '{"id":"2","timestamp":"t2","lev',
    JSON.stringify({ id: '3', timestamp: 't3', level: 'info', source: 'updater', event: 'version.updated', message: '本次启动是更新后的第一次', detail: { from: '0.2.19', to: '0.2.23', bundledNotes: 0 } }),
    JSON.stringify({ id: '4', timestamp: 't4', level: 'info', source: 'main', event: 'app.ready', message: '', detail: null }),
    '',
  ].join('\n')
  const entries = parseRuntimeLog(log)
  assert.equal(entries.length, 3)
  assert.equal(findVersionUpdatedEntry(entries, { from: '0.2.19', to: '0.2.23' }).id, '3')
  assert.equal(findVersionUpdatedEntry(entries, { from: '0.2.22', to: '0.2.23' }), null)
  assert.deepEqual(describeUpdaterEntries(entries).map((line) => line.split(' ')[0]), ['t1', 't3'])
  assert.equal(describeLogEntry(entries[2]), 't4 [info] main/app.ready ')
})

test('findLostSettings reports the customer choices and working folder the new version dropped', () => {
  const old = JSON.stringify({ version: 2, workspace: 'C:\\Users\\runneradmin', theme: 'light', checkUpdatesOnStartup: true })
  const before = applyCustomerSettings(old)
  assert.deepEqual(JSON.parse(before), { ...JSON.parse(old), ...CUSTOMER_SETTINGS })
  const kept = JSON.stringify({ ...JSON.parse(before), seededToolDefaults: ['claude'] })
  assert.deepEqual(findLostSettings(before, kept), [])
  const dropped = JSON.stringify({ ...JSON.parse(before), uiSkin: 'mist', workspace: 'C:\\' })
  assert.deepEqual(findLostSettings(before, dropped).map((line) => line.split('：')[0]), ['uiSkin', 'workspace'])
  assert.throws(() => applyCustomerSettings('[]'), /对象/)
  assert.throws(() => findLostSettings(before, '{'), /JSON/)
})

// What `security dump-keychain -a` printed on the macOS runner (2026-10-28)
// for a keychain holding the signing identity's key and the item the old
// version created on first start. The login keychain adds the integrity and
// partition_id entries; a keychain from `security create-keychain` does not.
function keychainDump({ login }) {
  const hex = (text) => Buffer.from(text, 'utf8').toString('hex').toUpperCase()
  const blob = (text) => `0x${hex(text)}  "${text}"`
  const entries = [
    ['decrypt derive export_clear export_wrapped mac sign', 'xingmang-ai-manager Safe Storage',
      ['        applications (1):', '            0: /Applications/星芒AI管理工具.app (OK)',
        '                requirement: identifier "com.xingmang.ai.manager" and certificate leaf = H"91b73eeaafe42f840f14b3484a2c14faf900be16"']],
    ['encrypt', 'xingmang-ai-manager Safe Storage', ['        applications: <null>']],
    ...(login ? [
      ['integrity', '2beddbfb47b151d9558b2b36bb4c76613f0bb352f8cd42ec7b62933cd0f7113e', ['        applications: <null>']],
      ['partition_id', 'cdhash:bd9bf15d06cebc67d970cf347068b427f096069e', ['        applications: <null>']],
    ] : []),
    ['change_acl', 'xingmang-ai-manager Safe Storage', ['        applications (0):']],
  ]
  return [
    'keychain: "/Users/runner/work/_temp/upgrade-smoke/upgrade-smoke.keychain-db"',
    'version: 512',
    'class: 0x0000000F ',
    'attributes:',
    '    0x00000001 <blob>="XingMang Upgrade Smoke Identity"',
    'access: 1 entries',
    '    entry 0:',
    '        authorizations (1): partition_id',
    "        don't-require-password",
    '        description: apple-tool:,apple:,codesign:',
    '        applications: <null>',
    'keychain: "/Users/runner/Library/Keychains/login.keychain-db"',
    'version: 512',
    'class: "genp"',
    'attributes:',
    `    0x00000007 <blob>=${blob('xingmang-ai-manager Safe Storage')}`,
    '    0x00000008 <blob>=<NULL>',
    '    "acct"<blob>="xingmang-ai-manager"',
    `    "svce"<blob>=${blob('xingmang-ai-manager Safe Storage')}`,
    `access: ${entries.length} entries`,
    ...entries.flatMap(([authorizations, description, rest], index) => [
      `    entry ${index}:`,
      `        authorizations (${authorizations.split(' ').length}): ${authorizations}`,
      "        don't-require-password",
      `        description: ${description}`,
      ...rest,
    ]),
    '',
  ].join('\n')
}

test('findSafeStorageItem reads the old version\'s key and which programs it admits', () => {
  const login = findSafeStorageItem(keychainDump({ login: true }))
  assert.equal(login.service, 'xingmang-ai-manager Safe Storage')
  assert.equal(login.account, 'xingmang-ai-manager')
  assert.deepEqual(login.partitions, ['cdhash:bd9bf15d06cebc67d970cf347068b427f096069e'])
  assert.match(login.access, /^access: 5 entries\n[\s\S]*change_acl/)
  assert.deepEqual(findSafeStorageItem(keychainDump({ login: false })).partitions, [])
  const chinese = '星芒AI管理工具 Safe Storage'
  const escaped = `keychain: "/k"\nclass: "genp"\nattributes:\n    "svce"<blob>=0x${Buffer.from(chinese).toString('hex').toUpperCase()}  "\\346\\230\\237"\n`
  assert.equal(findSafeStorageItem(escaped).service, chinese)
  const plist = 'keychain: "/k"\nclass: "genp"\nattributes:\n    "svce"<blob>="Electron Safe Storage"\naccess: 1 entries\n    entry 0:\n'
    + '        authorizations (1): partition_id\n'
    + `        description: ${Buffer.from('<plist><array><string>teamid:ABCDE12345</string></array></plist>').toString('hex')}\n`
  assert.deepEqual(findSafeStorageItem(plist).partitions, ['teamid:ABCDE12345'])
  assert.equal(findSafeStorageItem(keychainDump({ login: true }).split('keychain: ').slice(0, 2).join('keychain: ')), null)
})

test('createFeedServer serves the flat feed and nothing else', async (t) => {
  const feed = temporaryDirectory(t, 'xingmang-upgrade-feed-')
  fs.writeFileSync(path.join(feed, 'latest.yml'), 'version: 0.2.23\n')
  fs.writeFileSync(path.join(path.dirname(feed), `${path.basename(feed)}-outside.txt`), 'secret')
  t.after(() => fs.rmSync(path.join(path.dirname(feed), `${path.basename(feed)}-outside.txt`), { force: true }))
  const lines = []
  const server = createFeedServer(feed, (line) => lines.push(line))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  assert.deepEqual(await request(port, 'GET', '/latest.yml'), { status: 200, body: 'version: 0.2.23\n' })
  assert.deepEqual(await request(port, 'HEAD', '/latest.yml'), { status: 200, body: '' })
  assert.equal((await request(port, 'GET', `/..%2F${path.basename(feed)}-outside.txt`)).status, 404)
  assert.equal((await request(port, 'GET', '/missing.exe')).status, 404)
  assert.equal((await request(port, 'POST', '/latest.yml')).status, 405)
  assert.ok(lines.some((line) => line.startsWith('GET /latest.yml -> 200')))
  assert.ok(lines.some((line) => line.startsWith('POST /latest.yml -> 405')))
})

test('sha512Base64 is the digest electron-updater compares', () => {
  assert.equal(sha512Base64(Buffer.from('xingmang')), crypto.createHash('sha512').update('xingmang').digest('base64'))
})

test('parseArguments requires the three inputs and a sane port', () => {
  const parsed = parseArguments(['--old-installer', 'old.exe', '--old-version', 'v0.2.19', '--new-release', 'release'])
  assert.equal(parsed.oldVersion, '0.2.19')
  assert.equal(parsed.port, 18123)
  assert.equal(parsed.work, null)
  assert.ok(path.isAbsolute(parsed.oldInstaller))
  assert.throws(() => parseArguments(['--old-installer', 'old.exe']), /用法/)
  assert.throws(() => parseArguments(['--old-installer', 'old.exe', '--old-version', '0.2.19', '--new-release', 'r', '--port', '80']), /端口|--port/)
  assert.throws(() => parseArguments(['--old-installer', 'old.exe', '--old-version', '0.2.19', '--new-release', 'r', '--shell', 'x']), /无法识别/)
})

test('the test-version command prints the version a package for this run gets', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'upgrade-smoke.cjs'), 'test-version', '--package', '0.2.21', '--released', 'v0.2.19,0.2.22'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '0.2.23\n')
})

test('the upgrade run refuses to start anywhere but a disposable Windows or macOS runner', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'upgrade-smoke.cjs'), '--old-installer', 'old.exe', '--old-version', '0.2.19', '--new-release', 'release'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /只在 Windows 和 macOS 上跑|一次性托管 runner/)
})
