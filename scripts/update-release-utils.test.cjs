const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { gzipSync } = require('node:zlib')
const { test } = require('node:test')
const YAML = require('yaml')
const {
  DEFAULT_UPDATE_URL,
  LEGACY_UPDATE_URL,
  NEW_UPDATE_URL,
  UPDATE_MIGRATION_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_BLOCKMAP_BYTES,
  MAX_METADATA_BYTES,
  assertRemoteReleaseIsOlder,
  compareReleaseVersions,
  normalizeUpdateBaseUrl,
  parseLatestMetadata,
  resolveEmptyReleaseOutputDirectory,
  resolveUpdateUrlForVersion,
  validateLocalRelease,
  validateReleaseEnvironment,
  verifyRemoteFeed,
} = require('./update-release-utils.cjs')

function fixtureMetadata(fileName, contents, version = '1.2.3') {
  return fixtureMetadataFiles([{ fileName, contents }], version)
}

function fixtureMetadataFiles(files, version = '1.2.3') {
  const entries = files.map(({ fileName, contents }) => ({
    url: fileName,
    sha512: createHash('sha512').update(contents).digest('base64'),
    size: contents.length,
  }))
  return YAML.stringify({
    version,
    files: entries,
    path: entries[0].url,
    sha512: entries[0].sha512,
    releaseDate: '2026-07-24T00:00:00.000Z',
  })
}

function fixtureBlockmap() {
  return gzipSync(Buffer.from(JSON.stringify({
    version: '2',
    files: [{
      name: 'file',
      offset: 0,
      checksums: ['YWJjZA=='],
      sizes: [4],
    }],
  })))
}

async function createReleaseFixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-update-test-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const fileName = 'XingMang-AI-Manager-1.2.3-Setup.exe'
  const contents = Buffer.from('signed-installer-fixture')
  await fs.promises.writeFile(path.join(directory, fileName), contents)
  await fs.promises.writeFile(path.join(directory, `${fileName}.blockmap`), fixtureBlockmap())
  await fs.promises.writeFile(path.join(directory, 'latest.yml'), fixtureMetadata(fileName, contents))
  const macFiles = [
    {
      fileName: 'XingMang-AI-Manager-1.2.3-arm64.zip',
      contents: Buffer.from('mac-arm64-update-fixture'),
    },
    {
      fileName: 'XingMang-AI-Manager-1.2.3-x64.zip',
      contents: Buffer.from('mac-x64-update-fixture'),
    },
  ]
  for (const file of macFiles) {
    await fs.promises.writeFile(path.join(directory, file.fileName), file.contents)
    await fs.promises.writeFile(path.join(directory, `${file.fileName}.blockmap`), fixtureBlockmap())
  }
  await fs.promises.writeFile(
    path.join(directory, 'latest-mac.yml'),
    fixtureMetadataFiles(macFiles),
  )
  return { directory, fileName, contents, macFiles }
}

async function writeVersionedMacFixture(directory, files, version) {
  const versionedFiles = files.map((file) => ({
    ...file,
    fileName: file.fileName.replace('1.2.3', version),
  }))
  for (const file of versionedFiles) {
    await fs.promises.writeFile(path.join(directory, file.fileName), file.contents)
    await fs.promises.writeFile(path.join(directory, `${file.fileName}.blockmap`), fixtureBlockmap())
  }
  await fs.promises.writeFile(
    path.join(directory, 'latest-mac.yml'),
    fixtureMetadataFiles(versionedFiles, version),
  )
  return versionedFiles
}

async function serveFixtureDirectory(t, directory, intercept = null) {
  const server = http.createServer(async (request, response) => {
    if (intercept?.(request, response) === true) return
    const relativePath = decodeURIComponent((request.url || '/').replace(/^\/+/, ''))
    const target = path.join(directory, relativePath)
    try {
      const stat = await fs.promises.stat(target)
      response.writeHead(200, {
        'Content-Type': target.endsWith('.yml') ? 'application/yaml' : 'application/octet-stream',
        'Content-Length': stat.size,
      })
      if (request.method === 'HEAD') response.end()
      else fs.createReadStream(target).pipe(response)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  return `http://127.0.0.1:${address.port}/`
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve('.'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('normalizes production URLs and only permits loopback HTTP for development', () => {
  assert.equal(
    normalizeUpdateBaseUrl('https://updates.example.test/releases'),
    'https://updates.example.test/releases/',
  )
  assert.equal(
    normalizeUpdateBaseUrl('http://127.0.0.1:8123', { allowLocalHttp: true }),
    'http://127.0.0.1:8123/',
  )
  assert.throws(() => normalizeUpdateBaseUrl('http://updates.example.test/'), { code: 'UPDATE_URL_INSECURE' })
  assert.throws(() => normalizeUpdateBaseUrl('https://user:secret@updates.example.test/'), { code: 'UPDATE_URL_CREDENTIALS' })
  assert.throws(() => normalizeUpdateBaseUrl('https://updates.example.test/?token=secret'), { code: 'UPDATE_URL_SUFFIX' })
})

test('compares release versions and blocks remote downgrade or same-version overwrite', () => {
  assert.equal(compareReleaseVersions('0.1.5', '0.1.4'), 1)
  assert.equal(compareReleaseVersions('0.1.4-beta.2', '0.1.4-beta.10'), -1)
  assert.equal(compareReleaseVersions('0.1.4+build.2', '0.1.4+build.1'), 0)
  assert.equal(compareReleaseVersions('0.1.4', '0.1.4-beta.9'), 1)
  assert.doesNotThrow(() => assertRemoteReleaseIsOlder('0.1.3', '0.1.4'))
  assert.throws(() => assertRemoteReleaseIsOlder('0.1.4', '0.1.4'), {
    code: 'REMOTE_VERSION_ALREADY_PUBLISHED',
  })
  assert.throws(() => assertRemoteReleaseIsOlder('0.1.5', '0.1.4'), {
    code: 'REMOTE_VERSION_NEWER_THAN_LOCAL',
  })
})

test('rejects website HTML and unsafe artifact paths as latest.yml metadata', () => {
  assert.throws(() => parseLatestMetadata('<!doctype html><html><head></head></html>'), {
    code: 'METADATA_IS_HTML',
  })
  const contents = Buffer.from('fixture')
  const metadata = fixtureMetadata('../outside.exe', contents)
  assert.throws(() => parseLatestMetadata(metadata), { code: 'METADATA_FILE_TRAVERSAL' })
  assert.throws(() => parseLatestMetadata(fixtureMetadata('app%3Fname.exe', contents)), {
    code: 'METADATA_FILE_UNSAFE',
  })
})

test('preserves the raw metadata URL and primary path spelling alongside normalized paths', () => {
  const fileName = 'XingMang-AI-Manager-1.2.3-arm64.zip'
  const contents = Buffer.from('fixture')
  const value = YAML.parse(fixtureMetadata(fileName, contents))
  value.files[0].url = ` ${fileName} `
  value.path = '%58ingMang-AI-Manager-1.2.3-arm64.zip'
  const metadata = parseLatestMetadata(YAML.stringify(value), 'latest-mac.yml')

  assert.equal(metadata.files[0].relativePath, fileName)
  assert.equal(metadata.files[0].rawUrl, ` ${fileName} `)
  assert.equal(metadata.rawPrimaryPath, '%58ingMang-AI-Manager-1.2.3-arm64.zip')
  assert.equal(metadata.primaryPath, fileName)
})

test('validates local installer hashes and requires the blockmap', async (t) => {
  const fixture = await createReleaseFixture(t)
  const result = await validateLocalRelease(fixture.directory)
  assert.equal(result.metadata.version, '1.2.3')

  await fs.promises.writeFile(
    path.join(fixture.directory, fixture.fileName),
    Buffer.alloc(fixture.contents.length, 0x78),
  )
  await assert.rejects(validateLocalRelease(fixture.directory), { code: 'LOCAL_ARTIFACT_HASH_MISMATCH' })

  await fs.promises.writeFile(path.join(fixture.directory, fixture.fileName), fixture.contents)
  await fs.promises.rm(path.join(fixture.directory, `${fixture.fileName}.blockmap`))
  await assert.rejects(validateLocalRelease(fixture.directory), { code: 'LOCAL_BLOCKMAP_MISSING' })
})

test('requires a safe empty versioned directory for every formal release', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-release-output-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))

  assert.equal(
    resolveEmptyReleaseOutputDirectory(root, '1.2.3'),
    path.join(root, 'release-1.2.3'),
  )
  const output = path.join(root, 'release-1.2.3')
  await fs.promises.mkdir(output)
  assert.equal(resolveEmptyReleaseOutputDirectory(root, '1.2.3'), output)

  const existingArtifact = path.join(output, 'old-installer.exe')
  await fs.promises.writeFile(existingArtifact, 'preserve-me')
  assert.throws(() => resolveEmptyReleaseOutputDirectory(root, '1.2.3'), {
    code: 'RELEASE_OUTPUT_NOT_EMPTY',
  })
  assert.equal(await fs.promises.readFile(existingArtifact, 'utf8'), 'preserve-me')
  assert.throws(() => resolveEmptyReleaseOutputDirectory(root, '1.2.3', path.join('..', 'outside')), {
    code: 'RELEASE_OUTPUT_UNSAFE',
  })
  assert.throws(() => resolveEmptyReleaseOutputDirectory(root, '../invalid'), {
    code: 'RELEASE_VERSION_INVALID',
  })
})

test('rejects a local release whose metadata or installer filename has a different version', async (t) => {
  const fixture = await createReleaseFixture(t)
  await assert.rejects(
    validateLocalRelease(fixture.directory, { expectedVersion: '9.9.9' }),
    { code: 'LOCAL_VERSION_MISMATCH' },
  )

  const mismatchedName = 'XingMang-AI-Manager-9.9.9-Setup.exe'
  const metadata = fixtureMetadata(mismatchedName, fixture.contents, '1.2.3')
  await fs.promises.rename(
    path.join(fixture.directory, fixture.fileName),
    path.join(fixture.directory, mismatchedName),
  )
  await fs.promises.rename(
    path.join(fixture.directory, `${fixture.fileName}.blockmap`),
    path.join(fixture.directory, `${mismatchedName}.blockmap`),
  )
  await fs.promises.writeFile(path.join(fixture.directory, 'latest.yml'), metadata)
  await assert.rejects(
    validateLocalRelease(fixture.directory),
    { code: 'LOCAL_ARTIFACT_VERSION_MISMATCH' },
  )
})

test('accepts a prerelease installer whose filename carries the full version', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-update-test-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const fileName = 'XingMang-AI-Manager-1.2.4-beta.1-Setup.exe'
  const contents = Buffer.from('signed-installer-fixture')
  await fs.promises.writeFile(path.join(directory, fileName), contents)
  await fs.promises.writeFile(path.join(directory, `${fileName}.blockmap`), fixtureBlockmap())
  await fs.promises.writeFile(
    path.join(directory, 'latest.yml'),
    fixtureMetadata(fileName, contents, '1.2.4-beta.1'),
  )

  const result = await validateLocalRelease(directory)
  assert.equal(result.metadata.version, '1.2.4-beta.1')
})

test('validates local release configuration without requiring signing secrets', () => {
  assert.deepEqual(validateReleaseEnvironment({}), {
    updateUrl: DEFAULT_UPDATE_URL,
    signing: {
      releaseMode: false,
      allowUnsigned: false,
      certificateConfigured: false,
      expectedPublisher: null,
    },
  })
  assert.deepEqual(validateReleaseEnvironment({
    XINGMANG_UPDATE_URL: 'https://updates.example.test/app/',
  }), {
    updateUrl: 'https://updates.example.test/app/',
    signing: {
      releaseMode: false,
      allowUnsigned: false,
      certificateConfigured: false,
      expectedPublisher: null,
    },
  })
})

test('keeps legacy clients on the old bucket and sends 0.1.3+ builds to the new R2 feed', () => {
  assert.equal(UPDATE_MIGRATION_VERSION, '0.1.3')
  assert.equal(resolveUpdateUrlForVersion('0.1.2'), LEGACY_UPDATE_URL)
  assert.equal(resolveUpdateUrlForVersion('0.1.3-beta.1'), LEGACY_UPDATE_URL)
  assert.equal(resolveUpdateUrlForVersion('0.1.3'), NEW_UPDATE_URL)
  assert.equal(resolveUpdateUrlForVersion('0.1.13'), NEW_UPDATE_URL)
  assert.equal(resolveUpdateUrlForVersion('0.1.3+build.1'), NEW_UPDATE_URL)
  assert.equal(validateReleaseEnvironment({}, '0.1.2').updateUrl, LEGACY_UPDATE_URL)
  assert.equal(validateReleaseEnvironment({}, '0.1.3').updateUrl, NEW_UPDATE_URL)
  assert.equal(validateReleaseEnvironment({
    XINGMANG_UPDATE_URL: 'https://updates.example.test/beta',
  }, '0.1.13').updateUrl, 'https://updates.example.test/beta/')
  assert.throws(() => resolveUpdateUrlForVersion('not-a-version'), { code: 'RELEASE_VERSION_INVALID' })
})

test('fails formal release preflight without a certificate and fixed publisher', () => {
  assert.throws(() => validateReleaseEnvironment({ XINGMANG_RELEASE: '1' }), {
    code: 'SIGNING_CERTIFICATE_MISSING',
  })
  assert.throws(() => validateReleaseEnvironment({
    XINGMANG_RELEASE: '1',
    CSC_LINK: 'C:\\signing\\xingmang.p12',
  }), { code: 'SIGNING_PUBLISHER_MISSING' })
  assert.throws(() => validateReleaseEnvironment({
    XINGMANG_RELEASE: '1',
    CSC_LINK: 'C:\\signing\\xingmang.p12',
    XINGMANG_SIGNING_PUBLISHER: '绍兴星芒文化传媒有限责任公司',
    XINGMANG_ALLOW_UNSIGNED_RELEASE: '1',
  }), { code: 'UNSIGNED_RELEASE_OVERRIDE_FORBIDDEN' })
})

test('electron-builder production config requires signing and stays hardened', () => {
  const configPath = path.resolve('electron-builder.config.cjs')
  const packagePath = path.resolve('package.json')
  const script = `const c=require(${JSON.stringify(configPath)}); const p=require(${JSON.stringify(packagePath)}); process.stdout.write(JSON.stringify({appId:c.appId,asar:c.asar,copyright:c.copyright,electronFuses:c.electronFuses,forceCodeSigning:c.forceCodeSigning,nsis:c.nsis,productName:c.productName,package:p,win:c.win,publish:c.publish}))`
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      XINGMANG_RELEASE: '1',
      XINGMANG_MAC_FREE_RELEASE: '',
      XINGMANG_ALLOW_UNSIGNED_RELEASE: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  assert.equal(config.package.name, 'xingmang-ai-manager')
  assert.equal(config.package.author, '神风')
  assert.equal(config.package.description, '星芒AI管理工具')
  assert.equal(config.appId, 'com.xingmang.ai.manager')
  assert.equal(config.productName, '星芒AI管理工具')
  assert.equal(config.copyright, 'Copyright © 2026 绍兴星芒文化传媒有限责任公司')
  assert.equal(config.forceCodeSigning, true)
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker')
  // electron-builder 26 起 publisherName 属于 publish 配置；只有它写进
  // app-update.yml，electron-updater 才会校验下载到的安装程序。
  assert.deepEqual(config.publish.publisherName, ['绍兴星芒文化传媒有限责任公司'])
  assert.equal(config.win.verifyUpdateCodeSignature, true)
  assert.equal(config.win.legalTrademarks, '星芒AI')
  assert.equal(config.win.artifactName, 'XingMang-AI-Manager-${version}-Setup.${ext}')
  assert.equal(config.nsis.shortcutName, '星芒AI管理工具')
  assert.equal(config.nsis.uninstallDisplayName, '星芒AI管理工具')
  assert.equal(config.nsis.perMachine, true)
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true)
  assert.equal(config.asar, true)
  assert.deepEqual(config.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  })
})

test('unsigned local builds must not advertise a publisher name', () => {
  // 带 publisherName 的未签名包会让客户端从此只接受签名更新，而当前尚无证书，
  // 那些用户将再也收不到任何更新，只能手工重装才能脱困。
  const configPath = path.resolve('electron-builder.config.cjs')
  const script = `const c=require(${JSON.stringify(configPath)}); process.stdout.write(JSON.stringify({publish:c.publish,forceCodeSigning:c.forceCodeSigning}))`
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      XINGMANG_RELEASE: '',
      XINGMANG_MAC_FREE_RELEASE: '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  assert.equal(config.forceCodeSigning, false)
  assert.equal(config.publish.publisherName, undefined)
})

test('remote feed verification rejects SPA fallback and validates served assets', async (t) => {
  const fixture = await createReleaseFixture(t)
  let htmlMode = true
  const acceptedEncodings = []
  const server = http.createServer(async (request, response) => {
    acceptedEncodings.push(request.headers['accept-encoding'])
    if (htmlMode && request.url === '/latest.yml') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html></html>')
      return
    }
    const relativePath = decodeURIComponent((request.url || '/').replace(/^\//, ''))
    const target = path.join(fixture.directory, relativePath)
    try {
      const stat = await fs.promises.stat(target)
      response.writeHead(200, {
        'Content-Type': target.endsWith('.yml') ? 'application/yaml' : 'application/octet-stream',
        'Content-Length': stat.size,
      })
      if (request.method === 'HEAD') response.end()
      else fs.createReadStream(target).pipe(response)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}/`

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
  }), { code: 'REMOTE_METADATA_HTML' })

  htmlMode = false
  const result = await verifyRemoteFeed({ baseUrl, allowLocalHttp: true, verifyAssets: true })
  assert.equal(result.metadata.version, '1.2.3')
  assert.equal(result.mac.metadata.version, '1.2.3')
  assert.deepEqual([...new Set(acceptedEncodings)], ['identity'])
})

test('verify-update-feed reports both platform versions and the verified scope', async (t) => {
  const fixture = await createReleaseFixture(t)
  await writeVersionedMacFixture(fixture.directory, fixture.macFiles, '2.3.4')
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)
  const metadataResult = await runNodeScript(path.join(__dirname, 'verify-update-feed.cjs'), [
    baseUrl,
    '--allow-local',
    '--metadata-only',
  ])

  assert.equal(metadataResult.status, 0, metadataResult.stderr)
  assert.match(metadataResult.stdout, /Windows v1\.2\.3；macOS v2\.3\.4（双平台元数据）/)

  const fullResult = await runNodeScript(path.join(__dirname, 'verify-update-feed.cjs'), [
    baseUrl,
    '--allow-local',
  ])
  assert.equal(fullResult.status, 0, fullResult.stderr)
  assert.match(
    fullResult.stdout,
    /Windows v1\.2\.3；macOS v2\.3\.4（双平台元数据与引用文件、Windows blockmap、macOS 双架构 ZIP blockmap）/,
  )
})

test('remote feed verification requires latest-mac.yml even without asset verification', async (t) => {
  const fixture = await createReleaseFixture(t)
  await fs.promises.rm(path.join(fixture.directory, 'latest-mac.yml'))
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
  }), (error) => error.code === 'REMOTE_METADATA_STATUS' && /latest-mac\.yml/.test(error.message))
})

test('platform-specific verification does not require the other update channel', async (t) => {
  const fixture = await createReleaseFixture(t)
  await fs.promises.rm(path.join(fixture.directory, 'latest-mac.yml'))
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  const windows = await verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
    platform: 'windows',
  })
  assert.equal(windows.metadata.version, '1.2.3')
  assert.deepEqual(windows.mac, { skipped: true, missing: true, metadata: null })

  await writeVersionedMacFixture(fixture.directory, fixture.macFiles, '2.3.4')
  await fs.promises.rm(path.join(fixture.directory, 'latest.yml'))

  const macos = await verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
    platform: 'macos',
  })
  assert.equal(macos.skipped, true)
  assert.equal(macos.metadata, null)
  assert.equal(macos.mac.metadata.version, '2.3.4')
})

test('macOS feed verification requires a version-matched ZIP for both architectures', async (t) => {
  const fixture = await createReleaseFixture(t)
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  for (const missingArchitecture of ['arm64', 'x64']) {
    const presentFiles = fixture.macFiles.filter((file) => !file.fileName.endsWith(`-${missingArchitecture}.zip`))
    await fs.promises.writeFile(
      path.join(fixture.directory, 'latest-mac.yml'),
      fixtureMetadataFiles(presentFiles),
    )

    await assert.rejects(verifyRemoteFeed({
      baseUrl,
      allowLocalHttp: true,
      verifyAssets: false,
      platform: 'macos',
    }), (error) => (
      error.code === 'MACOS_UPDATE_ARCHITECTURE_INCOMPLETE'
        && error.message.includes(missingArchitecture)
    ))
  }
})

test('macOS feed verification rejects additional or ambiguously named ZIP candidates', async (t) => {
  const fixture = await createReleaseFixture(t)
  const extraZip = {
    fileName: 'XingMang-AI-Manager-1.2.3-arm64-copy.zip',
    contents: Buffer.from('ambiguous-arm64-update-fixture'),
  }
  await fs.promises.writeFile(
    path.join(fixture.directory, 'latest-mac.yml'),
    fixtureMetadataFiles([...fixture.macFiles, extraZip]),
  )
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
    platform: 'macos',
  }), { code: 'MACOS_UPDATE_ZIP_INVENTORY_INVALID' })
})

test('macOS feed verification requires the primary update to be an architecture ZIP', async (t) => {
  const fixture = await createReleaseFixture(t)
  const primaryDmg = {
    fileName: 'XingMang-AI-Manager-1.2.3-arm64.dmg',
    contents: Buffer.from('mac-arm64-dmg-fixture'),
  }
  await fs.promises.writeFile(
    path.join(fixture.directory, 'latest-mac.yml'),
    fixtureMetadataFiles([primaryDmg, ...fixture.macFiles]),
  )
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
    platform: 'macos',
  }), { code: 'MACOS_UPDATE_PRIMARY_INVALID' })
})

test('verify-update-feed exposes an explicit Windows-only mode', async (t) => {
  const fixture = await createReleaseFixture(t)
  await fs.promises.rm(path.join(fixture.directory, 'latest-mac.yml'))
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)
  const result = await runNodeScript(path.join(__dirname, 'verify-update-feed.cjs'), [
    baseUrl,
    '--allow-local',
    '--metadata-only',
    '--platform=windows',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Windows v1\.2\.3（Windows 元数据）/)
  assert.doesNotMatch(result.stdout, /macOS/)
})

test('remote feed verification names malformed macOS metadata correctly', async (t) => {
  const fixture = await createReleaseFixture(t)
  await fs.promises.writeFile(path.join(fixture.directory, 'latest-mac.yml'), 'version: [\n')
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
  }), (error) => (
    error.code === 'METADATA_YAML_INVALID'
      && /latest-mac\.yml/.test(error.message)
      && !/(^|[^-])latest\.yml/.test(error.message)
  ))
})

test('remote feed verification validates hashes for every macOS artifact', async (t) => {
  const fixture = await createReleaseFixture(t)
  const corrupted = fixture.macFiles[1]
  await fs.promises.writeFile(
    path.join(fixture.directory, corrupted.fileName),
    Buffer.alloc(corrupted.contents.length, 0x78),
  )
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: true,
  }), (error) => (
    error.code === 'REMOTE_ARTIFACT_HASH_MISMATCH'
      && error.message.includes(corrupted.fileName)
  ))
})

test('remote macOS feed verification requires blockmaps for both architecture ZIPs', async (t) => {
  const fixture = await createReleaseFixture(t)
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  for (const file of fixture.macFiles) {
    const blockmapPath = path.join(fixture.directory, `${file.fileName}.blockmap`)
    await fs.promises.rm(blockmapPath)
    await assert.rejects(verifyRemoteFeed({
      baseUrl,
      allowLocalHttp: true,
      verifyAssets: true,
      platform: 'macos',
    }), (error) => (
      error.code === 'REMOTE_BLOCKMAP_STATUS'
        && error.message.includes(`${file.fileName}.blockmap`)
    ))
    await fs.promises.writeFile(blockmapPath, fixtureBlockmap())
  }
})

test('remote feed verification rejects macOS artifact redirects before contacting their target', async (t) => {
  const fixture = await createReleaseFixture(t)
  let redirectedRequests = 0
  const redirectTarget = http.createServer((_request, response) => {
    redirectedRequests += 1
    response.writeHead(200).end('unexpected redirect target')
  })
  await new Promise((resolve) => redirectTarget.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => redirectTarget.close(resolve)))
  const redirectAddress = redirectTarget.address()
  const redirectedFile = fixture.macFiles[0].fileName
  const baseUrl = await serveFixtureDirectory(t, fixture.directory, (request, response) => {
    if (request.url !== `/${redirectedFile}`) return false
    response.writeHead(302, {
      Location: `http://127.0.0.1:${redirectAddress.port}/outside`,
    }).end()
    return true
  })

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: true,
  }), { code: 'REMOTE_REDIRECT_FORBIDDEN' })
  assert.equal(redirectedRequests, 0)
})

test('remote feed verification reports independently missing platform metadata when allowed', async (t) => {
  const fixture = await createReleaseFixture(t)
  await fs.promises.rm(path.join(fixture.directory, 'latest-mac.yml'))
  const baseUrl = await serveFixtureDirectory(t, fixture.directory)

  const result = await verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    allowMissing: true,
    verifyAssets: false,
  })
  assert.equal(result.missing, false)
  assert.equal(result.metadata.version, '1.2.3')
  assert.deepEqual(result.mac, { missing: true, metadata: null })

  await fs.promises.writeFile(
    path.join(fixture.directory, 'latest-mac.yml'),
    fixtureMetadataFiles(fixture.macFiles),
  )
  await fs.promises.rm(path.join(fixture.directory, 'latest.yml'))

  const windowsMissing = await verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    allowMissing: true,
    verifyAssets: false,
  })
  assert.equal(windowsMissing.missing, true)
  assert.equal(windowsMissing.metadata, null)
  assert.equal(windowsMissing.mac.missing, false)
  assert.equal(windowsMissing.mac.metadata.version, '1.2.3')
})

test('remote feed verification never follows cross-origin or out-of-directory redirects', async (t) => {
  const fileName = 'XingMang-AI-Manager-1.2.3-Setup.exe'
  const contents = Buffer.from('signed-installer-fixture')
  const metadata = fixtureMetadata(fileName, contents)
  let mode = 'metadata-cross-origin'
  let redirectedRequests = 0

  const redirectTarget = http.createServer((_request, response) => {
    redirectedRequests += 1
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(contents)
  })
  await new Promise((resolve) => redirectTarget.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => redirectTarget.close(resolve)))
  const redirectAddress = redirectTarget.address()
  const crossOriginUrl = `http://127.0.0.1:${redirectAddress.port}/stolen`

  const feed = http.createServer((request, response) => {
    if (request.url === '/feed/latest.yml') {
      if (mode === 'metadata-cross-origin') {
        response.writeHead(302, { Location: crossOriginUrl }).end()
        return
      }
      response.writeHead(200, {
        'Content-Type': 'application/yaml',
        'Content-Length': Buffer.byteLength(metadata),
      }).end(metadata)
      return
    }
    if (request.url === `/feed/${fileName}`) {
      if (mode === 'artifact-path-escape') {
        response.writeHead(302, { Location: `/outside/${fileName}` }).end()
        return
      }
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': contents.length,
      }).end(contents)
      return
    }
    if (request.url === `/feed/${fileName}.blockmap`) {
      if (mode === 'blockmap-cross-origin') {
        response.writeHead(307, { Location: crossOriginUrl }).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(fixtureBlockmap())
      return
    }
    if (request.url?.startsWith('/outside/')) redirectedRequests += 1
    response.writeHead(404).end()
  })
  await new Promise((resolve) => feed.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => feed.close(resolve)))
  const feedAddress = feed.address()
  const baseUrl = `http://127.0.0.1:${feedAddress.port}/feed/`

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
  }), { code: 'REMOTE_REDIRECT_FORBIDDEN' })

  mode = 'artifact-path-escape'
  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: true,
  }), { code: 'REMOTE_REDIRECT_FORBIDDEN' })

  mode = 'blockmap-cross-origin'
  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: true,
  }), { code: 'REMOTE_REDIRECT_FORBIDDEN' })
  assert.equal(redirectedRequests, 0)
})

test('remote feed verification rejects oversized metadata before reading its body', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/yaml',
      'Content-Length': MAX_METADATA_BYTES + 1,
    })
    response.flushHeaders()
    setImmediate(() => {
      if (response.destroyed) return
      response.end('not-read')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()

  await assert.rejects(verifyRemoteFeed({
    baseUrl: `http://127.0.0.1:${address.port}/`,
    allowLocalHttp: true,
    verifyAssets: false,
  }), { code: 'REMOTE_BODY_TOO_LARGE' })
})

test('remote feed verification stops chunked metadata and installer bodies at their limits', async (t) => {
  const fileName = 'XingMang-AI-Manager-1.2.3-Setup.exe'
  const contents = Buffer.from('signed-installer-fixture')
  const metadata = fixtureMetadata(fileName, contents)
  let mode = 'metadata'

  const server = http.createServer((request, response) => {
    if (request.url === '/latest.yml' && mode === 'metadata') {
      response.writeHead(200, { 'Content-Type': 'application/yaml' })
      response.write(Buffer.alloc(MAX_METADATA_BYTES, 0x61))
      response.end('b')
      return
    }
    if (request.url === '/latest.yml') {
      response.writeHead(200, {
        'Content-Type': 'application/yaml',
        'Content-Length': Buffer.byteLength(metadata),
      }).end(metadata)
      return
    }
    if (request.url === `/${fileName}`) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.write(contents)
      response.end('extra')
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}/`

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: false,
  }), { code: 'REMOTE_BODY_TOO_LARGE' })

  mode = 'artifact'
  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: true,
  }), { code: 'REMOTE_ARTIFACT_SIZE_MISMATCH' })
})

test('remote feed verification rejects oversized installer declarations and blockmaps early', async (t) => {
  const fileName = 'XingMang-AI-Manager-1.2.3-Setup.exe'
  const contents = Buffer.from('signed-installer-fixture')
  const sha512 = createHash('sha512').update(contents).digest('base64')
  const oversizedMetadata = YAML.stringify({
    version: '1.2.3',
    files: [{ url: fileName, sha512, size: MAX_ARTIFACT_BYTES + 1 }],
    path: fileName,
    sha512,
  })
  const normalMetadata = fixtureMetadata(fileName, contents)
  let mode = 'installer-declaration'
  let installerRequests = 0

  const server = http.createServer((request, response) => {
    if (request.url === '/latest.yml') {
      const body = mode === 'installer-declaration' ? oversizedMetadata : normalMetadata
      response.writeHead(200, {
        'Content-Type': 'application/yaml',
        'Content-Length': Buffer.byteLength(body),
      }).end(body)
      return
    }
    if (request.url === `/${fileName}`) {
      installerRequests += 1
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': contents.length,
      }).end(contents)
      return
    }
    if (request.url === `/${fileName}.blockmap`) {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': MAX_BLOCKMAP_BYTES + 1,
      })
      response.flushHeaders()
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}/`

  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: true,
  }), { code: 'REMOTE_ARTIFACT_TOO_LARGE' })
  assert.equal(installerRequests, 0)

  mode = 'blockmap'
  await assert.rejects(verifyRemoteFeed({
    baseUrl,
    allowLocalHttp: true,
    verifyAssets: true,
  }), { code: 'REMOTE_BLOCKMAP_TOO_LARGE' })
  assert.equal(installerRequests, 1)
})

test('remote feed verification rejects HTML, non-gzip and malformed blockmaps', async (t) => {
  const fileName = 'XingMang-AI-Manager-1.2.3-Setup.exe'
  const contents = Buffer.from('signed-installer-fixture')
  const metadata = fixtureMetadata(fileName, contents)
  let mode = 'html'
  const server = http.createServer((request, response) => {
    if (request.url === '/latest.yml') {
      response.writeHead(200, { 'Content-Type': 'application/yaml' }).end(metadata)
      return
    }
    if (request.url === `/${fileName}`) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(contents)
      return
    }
    if (request.url === `/${fileName}.blockmap`) {
      if (mode === 'html') {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html></html>')
      } else if (mode === 'plain') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end('not-gzip')
      } else {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
          .end(gzipSync(Buffer.from('not-json')))
      }
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const options = {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    allowLocalHttp: true,
    verifyAssets: true,
  }

  await assert.rejects(verifyRemoteFeed(options), { code: 'REMOTE_BLOCKMAP_INVALID' })
  mode = 'plain'
  await assert.rejects(verifyRemoteFeed(options), { code: 'REMOTE_BLOCKMAP_INVALID' })
  mode = 'malformed'
  await assert.rejects(verifyRemoteFeed(options), { code: 'REMOTE_BLOCKMAP_INVALID' })
})

test('remote feed verification rejects unexpected content encoding and cancels error bodies', async (t) => {
  const compressedMetadata = gzipSync(Buffer.from(fixtureMetadata(
    'XingMang-AI-Manager-1.2.3-Setup.exe',
    Buffer.from('signed-installer-fixture'),
  )))
  let mode = 'compressed'
  let closeResponse
  const responseClosed = new Promise((resolve) => { closeResponse = resolve })
  const server = http.createServer((_request, response) => {
    if (mode === 'compressed') {
      response.writeHead(200, {
        'Content-Type': 'application/yaml',
        'Content-Encoding': 'gzip',
        'Content-Length': compressedMetadata.length,
      }).end(compressedMetadata)
      return
    }
    response.on('close', closeResponse)
    response.writeHead(503, { 'Content-Type': 'text/plain' })
    response.write('unbounded error body')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const options = {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    allowLocalHttp: true,
    verifyAssets: false,
  }

  await assert.rejects(verifyRemoteFeed(options), { code: 'REMOTE_CONTENT_ENCODING_UNSUPPORTED' })
  mode = 'error'
  await assert.rejects(verifyRemoteFeed(options), { code: 'REMOTE_METADATA_STATUS' })
  await Promise.race([
    responseClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('错误响应正文未被及时取消')), 1_000)),
  ])
})
