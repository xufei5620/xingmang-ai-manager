// 「旧版升新版」冒烟里不碰系统的那一半（G13，见 docs/RELEASING.md「旧版升新版冒烟」）：本地假更新源
// 怎么备、装好的旧版本怎么改成认这个假源和这把临时钥匙、旧版本留下的记录里怎么看出它已经升上来。
// 真正装包、开软件、断网的那一半在 scripts/upgrade-smoke.cjs，只在 Windows / macOS runner 上跑。
//
// Why the installed old version is patched instead of the product growing a test
// hook: the old versions under test are the installers customers already have,
// downloaded from the GitHub Release. Their update feed is fixed in
// resources/app-update.yml and, on Windows, the publisher key that must vouch for
// every update is compiled into app.asar. A switch for either would have to ship
// in customer builds to be any use here, and a customer build that can be told to
// trust another key or another feed is exactly what update signing exists to
// rule out. So the runner edits its own installed copy: the feed line, and the
// pinned key swapped for a key generated for this one run, with the asar header
// and the executable's integrity record brought back in line so Electron still
// loads the archive. Nothing here is reachable from a shipped build.
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const YAML = require('yaml')
const { compareReleaseVersions, parseLatestMetadata } = require('./update-release-utils.cjs')

// @electron/asar writes the header as two pickles: an 8-byte one holding the
// size of the next, then the header pickle itself (payload size, string length,
// the JSON text, padding). The JSON therefore always starts at byte 16.
const ASAR_HEADER_TEXT_OFFSET = 16
const ASAR_INTEGRITY_ALGORITHM = 'SHA256'
// Electron's Windows build reads the expected header hash from this resource
// (electron-builder's addWinAsarIntegrity writes it).
const WINDOWS_INTEGRITY_RESOURCE = { type: 'INTEGRITY', id: 'ELECTRONASAR' }
const WINDOWS_ASAR_RESOURCE_FILE = 'resources\\app.asar'
// Hosts the runner itself talks to while a job runs. The apps under test name
// some of them (download pages, release links); blocking them would cut the
// job off from GitHub instead of cutting the app off from production.
const RUNNER_HOST_SUFFIXES = [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'github.io',
  'blob.core.windows.net',
  'actions.githubusercontent.com',
]
// Documentation and test-fixture names that only ever appear in strings.
const PLACEHOLDER_HOST_SUFFIXES = ['example', 'example.com', 'example.net', 'example.org', 'test', 'invalid', 'localhost', 'local']
// The operating systems' own "am I online" probes, which the apps name in
// their network diagnostics. Pointing them at loopback would make the runner
// itself believe it is offline or behind a captive portal, and they are not
// production services.
const OS_PROBE_HOSTS = new Set([
  'captive.apple.com',
  'www.apple.com',
  'msftconnecttest.com',
  'www.msftconnecttest.com',
  'ipv6.msftconnecttest.com',
  'msftncsi.com',
  'www.msftncsi.com',
  'dns.msftncsi.com',
  'connectivitycheck.gstatic.com',
  'clients3.google.com',
])
// Where electron/update-package-signature.ts lands in the packed app, and the
// base64 DER prefix every Ed25519 SubjectPublicKeyInfo starts with. The keys
// are read out of the old version itself, so a key rotated out of this
// checkout since that release is still found and swapped.
const UPDATE_KEY_MODULE = 'dist-electron/update-package-signature.js'
const ED25519_SPKI_BASE64 = /MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=/g
// Appearance choices a customer makes in 设置 that neither version changes on
// its own and that have nothing to do with updating, written into the old
// version's settings before it updates so the new version has something of
// the customer's to keep.
const CUSTOMER_SETTINGS = { uiSkin: 'aurora', uiScale: '110', reducedMotion: true }
const UPDATE_FILE_CONTENT_TYPES = new Map([
  ['.yml', 'application/yaml; charset=utf-8'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.zip', 'application/zip'],
  ['.blockmap', 'application/octet-stream'],
])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64')
}

/**
 * Points an installed app-update.yml at another feed and leaves every other key
 * as the installer wrote it: updaterCacheDirName decides where the old version
 * caches the download, and the run has to exercise that same place.
 */
function rewriteUpdateFeedUrl(text, url) {
  const document = YAML.parseDocument(String(text), { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error('app-update.yml 不是有效的 YAML')
  const config = document.toJS({ maxAliasCount: 0 })
  if (!isRecord(config) || config.provider !== 'generic' || typeof config.url !== 'string') {
    throw new Error('app-update.yml 不是 generic 更新源，认不出该改哪一行')
  }
  document.set('url', url)
  return document.toString()
}

function readAsarLayout(buffer) {
  if (buffer.length < ASAR_HEADER_TEXT_OFFSET || buffer.readUInt32LE(0) !== 4) {
    throw new Error('app.asar 的文件头认不出来')
  }
  const headerPickleSize = buffer.readUInt32LE(4)
  const textLength = buffer.readInt32LE(12)
  const contentOffset = 8 + headerPickleSize
  if (textLength <= 0 || ASAR_HEADER_TEXT_OFFSET + textLength > contentOffset || contentOffset > buffer.length) {
    throw new Error('app.asar 的文件头长度不对')
  }
  const headerText = buffer.toString('utf8', ASAR_HEADER_TEXT_OFFSET, ASAR_HEADER_TEXT_OFFSET + textLength)
  if (Buffer.byteLength(headerText) !== textLength) throw new Error('app.asar 的文件头不是完整的 UTF-8')
  return { header: JSON.parse(headerText), headerText, contentOffset }
}

/**
 * Same digest @electron/asar records: the whole file, plus one hash per
 * blockSize slice where the last slice is always present, even when it is
 * empty because the size is an exact multiple of the block.
 */
function asarFileIntegrity(content, blockSize) {
  const blocks = []
  let start = 0
  for (; start + blockSize <= content.length; start += blockSize) {
    blocks.push(sha256Hex(content.subarray(start, start + blockSize)))
  }
  blocks.push(sha256Hex(content.subarray(start)))
  return { algorithm: ASAR_INTEGRITY_ALGORITHM, hash: sha256Hex(content), blockSize, blocks }
}

function* packedAsarFiles(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const filePath = prefix ? `${prefix}/${name}` : name
    if (isRecord(entry.files)) {
      yield* packedAsarFiles(entry, filePath)
    } else if (!entry.unpacked && !entry.link && typeof entry.size === 'number') {
      yield { filePath, entry }
    }
  }
}

function replaceAll(buffer, search, replacement) {
  let count = 0
  for (let index = buffer.indexOf(search); index !== -1; index = buffer.indexOf(search, index + replacement.length)) {
    replacement.copy(buffer, index)
    count += 1
  }
  return count
}

/**
 * Swaps one text for another of the same byte length inside the files packed
 * into an asar archive, in place, and rewrites those files' integrity records.
 * Same length keeps every file offset, and hex digests of the same length keep
 * the header text the same length too, so nothing else in the archive moves.
 * `files` limits the swap to those packed paths. Returns the paths it changed
 * and the new header hash, the value Electron checks the archive against at load.
 */
function swapAsarText(buffer, { from, to, files }) {
  const replacement = Buffer.from(to, 'utf8')
  const searches = [...new Set(from)].map((text) => Buffer.from(text, 'utf8'))
  if (searches.length === 0) throw new Error('没有要换掉的内容')
  for (const search of searches) {
    if (search.length !== replacement.length) throw new Error('换进去的内容必须和换掉的一样长，否则包里的文件位置全要挪')
  }
  const { header, headerText, contentOffset } = readAsarLayout(buffer)
  // The header is rewritten by serializing the parsed object again. That only
  // reproduces the archive's own bytes if it was written the same way, which is
  // what @electron/asar does; anything else is refused rather than guessed at.
  if (JSON.stringify(header) !== headerText) throw new Error('app.asar 的文件头不是标准写法，不敢原地改')
  const only = files ? new Set(files) : null
  const changed = []
  for (const { filePath, entry } of packedAsarFiles(header, '')) {
    if (only && !only.has(filePath)) continue
    const start = contentOffset + Number(entry.offset)
    const end = start + entry.size
    if (!Number.isSafeInteger(start) || end > buffer.length) throw new Error(`app.asar 里 ${filePath} 的位置超出了文件`)
    const content = buffer.subarray(start, end)
    if (!searches.some((search) => content.includes(search))) continue
    const integrity = entry.integrity
    if (!isRecord(integrity) || integrity.algorithm !== ASAR_INTEGRITY_ALGORITHM || !Number.isSafeInteger(integrity.blockSize)) {
      throw new Error(`app.asar 里 ${filePath} 没有认得出的完整性记录`)
    }
    // Recomputing the untouched file first proves this code hashes the way the
    // packer did; a mismatch here would otherwise surface as Electron refusing
    // to start, far from the cause.
    const before = asarFileIntegrity(content, integrity.blockSize)
    if (before.hash !== integrity.hash || JSON.stringify(before.blocks) !== JSON.stringify(integrity.blocks)) {
      throw new Error(`app.asar 里 ${filePath} 的完整性记录和内容对不上`)
    }
    for (const search of searches) replaceAll(content, search, replacement)
    entry.integrity = asarFileIntegrity(content, integrity.blockSize)
    changed.push(filePath)
  }
  if (changed.length === 0) throw new Error('app.asar 里找不到要换掉的内容')
  const nextHeaderText = JSON.stringify(header)
  if (Buffer.byteLength(nextHeaderText) !== Buffer.byteLength(headerText)) {
    throw new Error('改完以后 app.asar 的文件头长度变了')
  }
  buffer.write(nextHeaderText, ASAR_HEADER_TEXT_OFFSET, 'utf8')
  return { changed, headerHash: sha256Hex(Buffer.from(nextHeaderText, 'utf8')) }
}

function asarHeaderHash(buffer) {
  return sha256Hex(Buffer.from(readAsarLayout(buffer).headerText, 'utf8'))
}

function readPackedAsarFile(buffer, filePath) {
  const { header, contentOffset } = readAsarLayout(buffer)
  for (const file of packedAsarFiles(header, '')) {
    if (file.filePath !== filePath) continue
    const start = contentOffset + Number(file.entry.offset)
    if (!Number.isSafeInteger(start) || start + file.entry.size > buffer.length) throw new Error(`app.asar 里 ${filePath} 的位置超出了文件`)
    return buffer.subarray(start, start + file.entry.size)
  }
  return null
}

/** The update publisher keys an old version pins, read from its own packed code. */
function findPinnedUpdateKeys(buffer) {
  const content = readPackedAsarFile(buffer, UPDATE_KEY_MODULE)
  if (!content) throw new Error(`app.asar 里没有 ${UPDATE_KEY_MODULE}，认不出旧版本认哪把发布者钥匙`)
  const keys = [...new Set(content.toString('utf8').match(ED25519_SPKI_BASE64) || [])]
  if (keys.length === 0) throw new Error(`${UPDATE_KEY_MODULE} 里找不到发布者钥匙`)
  return keys
}

function isIntegrityResource(entry) {
  return String(entry.type).toUpperCase() === WINDOWS_INTEGRITY_RESOURCE.type
    && String(entry.id).toUpperCase() === WINDOWS_INTEGRITY_RESOURCE.id
}

/**
 * Rewrites the header hash a Windows Electron executable expects for
 * resources\app.asar. Returns the executable's new bytes and the hash it held.
 */
function setWindowsAsarIntegrity(executable, headerHash) {
  if (!/^[0-9a-f]{64}$/.test(headerHash)) throw new Error('app.asar 的文件头哈希格式不对')
  const { NtExecutable, NtExecutableResource } = require('resedit')
  const image = NtExecutable.from(executable)
  const resources = NtExecutableResource.from(image)
  const entries = resources.entries.filter(isIntegrityResource)
  if (entries.length !== 1) throw new Error('程序文件里应当正好有一份 app.asar 完整性记录')
  const list = JSON.parse(Buffer.from(entries[0].bin).toString('utf8'))
  const record = Array.isArray(list)
    ? list.find((item) => isRecord(item) && String(item.file).toLowerCase() === WINDOWS_ASAR_RESOURCE_FILE)
    : null
  if (!record || String(record.alg).toUpperCase() !== ASAR_INTEGRITY_ALGORITHM) {
    throw new Error('程序文件里的完整性记录没有 resources\\app.asar 那一项')
  }
  const previous = record.value
  record.value = headerHash
  const encoded = Buffer.from(JSON.stringify(list), 'utf8')
  entries[0].bin = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
  resources.outputResource(image)
  return { executable: Buffer.from(image.generate()), previous }
}

function readWindowsAsarIntegrity(executable) {
  const { NtExecutable, NtExecutableResource } = require('resedit')
  const resources = NtExecutableResource.from(NtExecutable.from(executable))
  const entry = resources.entries.find(isIntegrityResource)
  if (!entry) return null
  const list = JSON.parse(Buffer.from(entry.bin).toString('utf8'))
  const record = Array.isArray(list)
    ? list.find((item) => isRecord(item) && String(item.file).toLowerCase() === WINDOWS_ASAR_RESOURCE_FILE)
    : null
  return record ? String(record.value) : null
}

function generateUpdateSigningKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  return { privateKey, publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
}

/**
 * The test version a freshly built package gets: the checkout's own version when
 * it is already above every release under test, otherwise one patch above the
 * highest of them, so each old version sees an update and none of them sees its
 * own number again.
 */
function resolveUpgradeTestVersion(packageVersion, releasedVersions) {
  const floor = [...releasedVersions].sort(compareReleaseVersions).at(-1)
  if (!floor || compareReleaseVersions(packageVersion, floor) > 0) return packageVersion
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(floor)
  if (!match) throw new Error(`已发版本号无效：${floor}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

/**
 * Rewrites the digest and size latest-mac.yml records for one file after the
 * runner re-signed and re-zipped the app inside it, and moves the top-level
 * path/sha512 along when that file is the primary one.
 */
function rewriteMacManifestEntry(text, fileName, { sha512, size }) {
  const metadata = parseLatestMetadata(text, 'latest-mac.yml')
  const document = YAML.parseDocument(String(text), { uniqueKeys: true })
  const files = document.get('files')
  const index = metadata.files.findIndex((file) => file.relativePath === fileName)
  if (index === -1) throw new Error(`latest-mac.yml 里没有 ${fileName}`)
  const item = files.items[index]
  item.set('sha512', sha512)
  item.set('size', size)
  if (metadata.primaryPath === fileName) document.set('sha512', sha512)
  return document.toString()
}

/** The ZIP an Apple silicon (or Intel) Mac would take from latest-mac.yml. */
function selectMacUpdateFile(metadata, arch) {
  // electron-updater's MacUpdater: an arm64 Mac takes the first file whose URL
  // contains "arm64", any other Mac one that does not (macos-artifact-names.cjs).
  const zips = metadata.files.filter((file) => file.relativePath.toLowerCase().endsWith('.zip'))
  const match = zips.find((file) => file.relativePath.includes('arm64') === (arch === 'arm64'))
  if (!match) throw new Error(`latest-mac.yml 里没有 ${arch} 的更新包`)
  return match
}

function hostMatchesSuffix(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/**
 * Hosts named in the apps' own code. The run maps each of them to the loopback
 * address so neither the old version nor the new one reaches a production
 * service; the runner's own GitHub traffic, the operating systems' online
 * probes and placeholder names are left alone. A host is taken from a URL
 * literal, or from a bare quoted name under a domain some URL literal already
 * uses (route tables name their hosts without a scheme). IP literals come back
 * separately because a hosts file cannot redirect them.
 */
function extractNetworkTargets(texts) {
  const hosts = new Set()
  const addresses = new Set()
  const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
  const urlPattern = new RegExp(`\\b(?:https?|wss?)://(\\[[0-9a-f:]+\\]|${label}(?:\\.${label})+)`, 'gi')
  const barePattern = new RegExp(`['"\`](${label}(?:\\.${label})+)['"\`]`, 'gi')
  const keep = (host) => !RUNNER_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))
    && !PLACEHOLDER_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))
    && !OS_PROBE_HOSTS.has(host)
  for (const text of texts) {
    for (const match of String(text).matchAll(urlPattern)) {
      const host = match[1].toLowerCase()
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        if (!host.startsWith('127.') && host !== '0.0.0.0') addresses.add(host)
        continue
      }
      if (host.startsWith('[') || !/[a-z]/.test(host.split('.').at(-1))) continue
      if (keep(host)) hosts.add(host)
    }
  }
  const domains = new Set([...hosts].map((host) => host.split('.').slice(-2).join('.')))
  for (const text of texts) {
    for (const match of String(text).matchAll(barePattern)) {
      const host = match[1].toLowerCase()
      if (domains.has(host.split('.').slice(-2).join('.')) && keep(host)) hosts.add(host)
    }
  }
  return { hosts: [...hosts].sort(), addresses: [...addresses].sort() }
}

const HOSTS_BLOCK_BEGIN = '# xingmang-upgrade-smoke begin'
const HOSTS_BLOCK_END = '# xingmang-upgrade-smoke end'

/** Adds (or replaces) this run's block in a hosts file; removeHostsBlock takes it back out. */
function addHostsBlock(text, hosts) {
  const base = removeHostsBlock(text)
  const lines = hosts.flatMap((host) => [`127.0.0.1 ${host}`, `::1 ${host}`])
  const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n'
  return `${base}${separator}${HOSTS_BLOCK_BEGIN}\n${lines.join('\n')}${lines.length ? '\n' : ''}${HOSTS_BLOCK_END}\n`
}

function removeHostsBlock(text) {
  const source = String(text).replace(/\r\n/g, '\n')
  const begin = source.indexOf(`${HOSTS_BLOCK_BEGIN}\n`)
  if (begin === -1) return source
  const end = source.indexOf(`${HOSTS_BLOCK_END}\n`, begin)
  if (end === -1) throw new Error('hosts 文件里这次加的那段没有结尾，不敢动')
  return source.slice(0, begin) + source.slice(end + HOSTS_BLOCK_END.length + 1)
}

function readVersionField(text, field) {
  try {
    const value = JSON.parse(String(text))
    return isRecord(value) && typeof value[field] === 'string' ? value[field] : null
  } catch {
    return null
  }
}

/** pending-update.json (auto-update-install.ts): the version the old app reports as downloaded. */
function readDownloadedVersion(text) {
  return readVersionField(text, 'downloadedVersion')
}

/** last-run-version.json (installed-release.ts): the version that last started on this machine. */
function readLastRunVersion(text) {
  return readVersionField(text, 'lastRunVersion')
}

function parseSettingsRecord(text, label) {
  let value
  try {
    value = JSON.parse(String(text))
  } catch {
    throw new Error(`${label}的设置文件不是有效的 JSON`)
  }
  if (!isRecord(value)) throw new Error(`${label}的设置文件不是一个对象`)
  return value
}

/** The old version's settings.json with the customer's own choices written in. */
function applyCustomerSettings(text) {
  return `${JSON.stringify({ ...parseSettingsRecord(text, '旧版本'), ...CUSTOMER_SETTINGS }, null, 2)}\n`
}

/**
 * What the new version dropped or changed of the settings the old version
 * left: the customer's choices above, and the working folder every tool
 * session starts in. Empty when everything carried over.
 */
function findLostSettings(beforeText, afterText) {
  const before = parseSettingsRecord(beforeText, '旧版本')
  const after = parseSettingsRecord(afterText, '新版本')
  const expected = { ...CUSTOMER_SETTINGS, workspace: before.workspace }
  return Object.entries(expected)
    .filter(([key, value]) => JSON.stringify(after[key]) !== JSON.stringify(value))
    .map(([key, value]) => `${key}：应为 ${JSON.stringify(value)}，实际是 ${JSON.stringify(after[key])}`)
}

function parseRuntimeLog(text) {
  const entries = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (isRecord(entry)) entries.push(entry)
    } catch {
      // A line cut off by the force-kill between runs; the next run appends after it.
    }
  }
  return entries
}

/**
 * The line the new version writes on its first start after an update
 * (main.ts, version.updated): proof that it read the old version's record
 * from the same data directory rather than starting as a fresh install.
 */
function findVersionUpdatedEntry(entries, { from, to }) {
  return entries.find((entry) => entry.event === 'version.updated'
    && isRecord(entry.detail) && entry.detail.from === from && entry.detail.to === to) || null
}

function describeUpdaterEntries(entries) {
  return entries
    .filter((entry) => entry.source === 'updater')
    .map((entry) => `${entry.timestamp || ''} [${entry.level || ''}] ${entry.event || ''} ${entry.message || ''}${isRecord(entry.detail) ? ` ${JSON.stringify(entry.detail)}` : ''}`)
}

/**
 * Serves the flat feed directory over loopback HTTP and reports every request,
 * so a failed run shows what the old version asked for and what it got.
 */
function createFeedServer(root, report) {
  const realRoot = fs.realpathSync(root)
  const names = new Set(fs.readdirSync(realRoot))
  return http.createServer((request, response) => {
    const finish = (status, body) => {
      report(`${request.method} ${request.url} -> ${status}`)
      response.writeHead(status).end(body)
    }
    let name
    try {
      name = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname).replace(/^\/+/, '')
    } catch {
      finish(400, 'Bad Request')
      return
    }
    // The feed is flat: anything with a separator in it is not one of its files.
    if (!names.has(name) || name.includes('/') || name.includes('\\')) {
      finish(404, 'Not Found')
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      finish(405, 'Method Not Allowed')
      return
    }
    const target = path.join(realRoot, name)
    const stat = fs.statSync(target)
    response.setHeader('Content-Type', UPDATE_FILE_CONTENT_TYPES.get(path.extname(name).toLowerCase()) || 'application/octet-stream')
    response.setHeader('Content-Length', stat.size)
    response.setHeader('Cache-Control', 'no-store')
    report(`${request.method} ${request.url} -> 200 (${stat.size} bytes)`)
    if (request.method === 'HEAD') {
      response.writeHead(200).end()
      return
    }
    response.writeHead(200)
    fs.createReadStream(target).on('error', () => response.destroy()).pipe(response)
  })
}

module.exports = {
  CUSTOMER_SETTINGS,
  UPDATE_KEY_MODULE,
  WINDOWS_ASAR_RESOURCE_FILE,
  addHostsBlock,
  applyCustomerSettings,
  asarFileIntegrity,
  asarHeaderHash,
  createFeedServer,
  describeUpdaterEntries,
  extractNetworkTargets,
  findLostSettings,
  findPinnedUpdateKeys,
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
}
