const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { buildElectronZipChecksums, packagedTargets, resolveLockedElectronZipChecksums } = require('./electron-zip-checksums.cjs')

const root = path.resolve(__dirname, '..')
const electronPackage = path.join(root, 'node_modules', 'electron')

async function lockedElectron() {
  const { version } = JSON.parse(await fs.readFile(path.join(electronPackage, 'package.json'), 'utf8'))
  const checksums = JSON.parse(await fs.readFile(path.join(electronPackage, 'checksums.json'), 'utf8'))
  return { version, checksums }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('the packaging checksums are the installed Electron package\'s own checksums.json, covering every packaged target', async () => {
  const { version, checksums } = await lockedElectron()
  const resolved = resolveLockedElectronZipChecksums()

  assert.deepEqual(resolved, checksums)
  assert.ok(Object.isFrozen(resolved))
  for (const [platform, arch] of packagedTargets) {
    assert.match(resolved[`electron-v${version}-${platform}-${arch}.zip`], /^[0-9a-f]{64}$/)
  }
})

test('a checksums file that cannot vouch for every packaged zip is refused when the config loads', async () => {
  const { version, checksums } = await lockedElectron()
  const missing = { ...checksums }
  delete missing[`electron-v${version}-darwin-x64.zip`]

  assert.throws(() => buildElectronZipChecksums(version, missing), /没有 electron-v.*-darwin-x64\.zip/)
  assert.throws(() => buildElectronZipChecksums('latest', checksums), /版本号不可识别/)
  // A different Electron than the one locked has no entries for its zips.
  assert.throws(() => buildElectronZipChecksums('1.2.3', checksums), /没有 electron-v1\.2\.3-/)
  for (const broken of [
    null,
    [],
    {},
    { ...checksums, [`electron-v${version}-linux-x64.zip`]: 'not-a-sha256' },
    { ...checksums, [`electron-v${version}-linux-x64.zip`]: checksums[`electron-v${version}-linux-x64.zip`].toUpperCase() },
    // @electron/get writes the table out line by line as a SHASUMS256.txt.
    { ...checksums, [`x.zip\n${'0'.repeat(64)} *electron-v${version}-linux-x64.zip`]: '0'.repeat(64) },
    { ...checksums, '../escape.zip': '0'.repeat(64) },
  ]) {
    assert.throws(() => buildElectronZipChecksums(version, broken), /checksums\.json 格式不对/)
  }
})

test('the packaging config gives electron-builder the locked checksums with verification switched on', () => {
  const config = require('../electron-builder.config.cjs')

  assert.deepEqual(config.electronDownload, { unsafelyDisableChecksums: false, checksums: resolveLockedElectronZipChecksums() })
})

// What follows drives electron-builder's own download entry point, the one its
// ElectronFramework calls for every package, with the options it builds from
// `electronDownload` (createDownloadOpts: { platform, arch, version, ...dl }).
// The only additions are the test's cache folder, a downloader that records
// what would have gone over the network, and a fixed asset URL so a mirror set
// in the developer's npm config cannot move the cache path.
async function cachedZipFixture(t, version) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-electron-zip-checksums-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fileName = `electron-v${version}-linux-x64.zip`
  const base = `https://downloads.invalid/electron/v${version}`
  const cacheRoot = path.join(directory, 'cache')
  const cachedZip = path.join(cacheRoot, sha256(base), fileName)
  const content = 'a cached Electron zip'
  await fs.mkdir(path.dirname(cachedZip), { recursive: true })
  await fs.writeFile(cachedZip, content)
  const requested = []
  const downloader = {
    async download(url) {
      requested.push(url.slice(base.length + 1))
      throw Object.assign(new Error('the test has no network'), { response: { status: 404 } })
    },
  }
  const mirrorOptions = {
    resolveAssetURL: async (details) => `${base}/${details.isGeneric ? details.artifactName : fileName}`,
  }
  return { cacheRoot, cachedZip, content, fileName, requested, downloader, mirrorOptions }
}

function downloadZip(fixture, version, electronDownload) {
  const { downloadElectronArtifactZip } = require('app-builder-lib/out/util/electronGet.js')
  return downloadElectronArtifactZip({
    electronDownload: {
      platform: 'linux',
      arch: 'x64',
      version,
      ...electronDownload,
      mirrorOptions: fixture.mirrorOptions,
      downloader: fixture.downloader,
    },
    artifactName: 'electron',
    platformName: 'linux',
    arch: 'x64',
    version,
    cacheDir: fixture.cacheRoot,
  })
}

test('electron-builder accepts a cached zip that matches the locked checksums without any download', async (t) => {
  const { version } = await lockedElectron()
  const fixture = await cachedZipFixture(t, version)
  const { electronDownload } = require('../electron-builder.config.cjs')
  // The real table, with the one entry this fixture's stand-in zip needs.
  const checksums = { ...electronDownload.checksums, [fixture.fileName]: sha256(fixture.content) }

  assert.equal(await downloadZip(fixture, version, { ...electronDownload, checksums }), fixture.cachedZip)
  assert.deepEqual(fixture.requested, [])
})

test('a cached zip that does not match the locked checksums is still rejected and fetched again', async (t) => {
  const { version } = await lockedElectron()
  const fixture = await cachedZipFixture(t, version)
  const { electronDownload } = require('../electron-builder.config.cjs')

  await assert.rejects(downloadZip(fixture, version, electronDownload), /the test has no network/)
  // Straight to the zip: there is no checksum file to fetch any more.
  assert.deepEqual(fixture.requested, [fixture.fileName])
})

test('without the locked checksums a cached zip still sends electron-builder to GitHub for SHASUMS256.txt', async (t) => {
  // The failure CI-1 is about, kept here so the reason for electronDownload
  // stays visible: the checksum file is never cached, so every package
  // fetched it, and a 504 on it threw the cached zip away as well.
  const { version } = await lockedElectron()
  const fixture = await cachedZipFixture(t, version)

  await assert.rejects(downloadZip(fixture, version, { unsafelyDisableChecksums: false }), /the test has no network/)
  assert.deepEqual(fixture.requested, ['SHASUMS256.txt', fixture.fileName])
})
