const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { gzipSync } = require('node:zlib')
const asar = require('@electron/asar')
const YAML = require('yaml')
const {
  expectedFreeArtifactNames,
  assertExactArchitecture,
  assertExactCodesignIdentifier,
  formatSha256Manifest,
  hashArtifactFiles,
  parseDesignatedRequirement,
  parseLatestMacMetadata,
  resolveSafeOutputDirectory,
  validateZipEntryPaths,
  verifyPackagedUpdateConfig,
  verifyMacosFreeArtifacts,
  verifyZipApplication,
} = require('./verify-macos-free-artifacts.cjs')

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-free-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function sha512(contents) {
  return crypto.createHash('sha512').update(contents).digest('base64')
}

function latestMacMetadata(names, version = '1.2.3') {
  const files = names.filter((name) => name.endsWith('.zip')).reverse().map((name) => ({
    url: name,
    sha512: sha512(name),
    size: Buffer.byteLength(name),
  }))
  return YAML.stringify({
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: '2026-08-03T00:00:00.000Z',
  })
}

function validBlockmap() {
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

function createFreeArtifacts(t, version = '1.2.3') {
  const projectRoot = temporaryDirectory(t)
  const outputDirectory = path.join(projectRoot, `release-free-${version}`)
  fs.mkdirSync(outputDirectory)
  const names = expectedFreeArtifactNames(version)
  for (const name of names) fs.writeFileSync(path.join(outputDirectory, name), name)
  const blockmapNames = names
    .filter((name) => name.endsWith('.zip'))
    .map((name) => `${name}.blockmap`)
  for (const name of blockmapNames) fs.writeFileSync(path.join(outputDirectory, name), validBlockmap())
  fs.writeFileSync(path.join(outputDirectory, 'latest-mac.yml'), latestMacMetadata(names, version))
  return { projectRoot, outputDirectory, names, blockmapNames }
}

function verifiedApplication(architecture, certificateSha1 = 'cd'.repeat(20), slot = 'root') {
  return {
    architecture,
    certificateSha256: 'ab'.repeat(32),
    certificateSha1,
    designatedRequirement: `identifier "com.xingmang.ai.manager" and certificate ${slot} = H"${certificateSha1}"`,
  }
}

function createPackagedUpdateFixture(t, updateConfig) {
  const root = temporaryDirectory(t)
  const appPath = path.join(root, 'Fixture.app')
  const sourceResources = path.join(appPath, 'Contents', 'Resources')
  fs.mkdirSync(sourceResources, { recursive: true })
  if (updateConfig !== undefined) fs.writeFileSync(path.join(sourceResources, 'app-update.yml'), updateConfig)
  return appPath
}

async function createInspectableZipFixture(t, {
  infoPlist = {
    CFBundleIdentifier: 'com.xingmang.ai.manager',
    CFBundleShortVersionString: '1.2.3',
    CFBundleVersion: '1.2.3',
  },
  packageVersion = '1.2.3',
  xingmangLocalBuild = false,
} = {}) {
  const root = temporaryDirectory(t)
  const sourceApp = path.join(root, 'Fixture.app')
  const contentsDirectory = path.join(sourceApp, 'Contents')
  const resourcesDirectory = path.join(contentsDirectory, 'Resources')
  const executableDirectory = path.join(contentsDirectory, 'MacOS')
  fs.mkdirSync(resourcesDirectory, { recursive: true })
  fs.mkdirSync(executableDirectory, { recursive: true })
  const infoPlistContents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    ...Object.entries(infoPlist).flatMap(([key, value]) => [`<key>${key}</key>`, `<string>${value}</string>`]),
    '</dict></plist>',
  ].join('\n')
  fs.writeFileSync(path.join(contentsDirectory, 'Info.plist'), infoPlistContents)
  fs.writeFileSync(path.join(executableDirectory, 'Fixture'), '#!/bin/sh\n')
  fs.chmodSync(path.join(executableDirectory, 'Fixture'), 0o755)
  fs.writeFileSync(path.join(resourcesDirectory, 'app-update.yml'), [
    'provider: generic',
    'url: https://updates.shenfengwl.fun/xingmang-manager/',
    '',
  ].join('\n'))
  const asarSource = path.join(root, 'asar-source')
  fs.mkdirSync(asarSource)
  fs.writeFileSync(path.join(asarSource, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: packageVersion,
    xingmangLocalBuild,
  }))
  await asar.createPackage(asarSource, path.join(resourcesDirectory, 'app.asar'))

  const certificate = Buffer.from('fixture self-signed certificate')
  const zipPath = path.join(root, 'fixture.zip')
  fs.writeFileSync(zipPath, 'fixture zip bytes')
  return { certificate, infoPlist, sourceApp, zipPath }
}

function inspectableZipCommandRunner(sourceApp, certificate, infoPlist) {
  const certificateSha1 = crypto.createHash('sha1').update(certificate).digest('hex')
  return async (command, args) => {
    if (command === '/usr/bin/unzip') return { stdout: 'Fixture.app/\nFixture.app/Contents/\n' }
    if (command === '/usr/bin/ditto') {
      fs.cpSync(sourceApp, path.join(args.at(-1), 'Fixture.app'), { recursive: true })
      return { stdout: '' }
    }
    if (command === '/usr/bin/plutil') {
      return { stdout: JSON.stringify(infoPlist) }
    }
    if (command === '/usr/bin/lipo') return { stdout: 'arm64\n' }
    if (command === '/usr/bin/codesign' && args[0] === '--verify') return { stdout: '' }
    if (command === '/usr/bin/codesign' && args.includes('--verbose=4')) {
      return { stderr: 'Identifier=com.xingmang.ai.manager\n' }
    }
    if (command === '/usr/bin/codesign' && args[0] === '-d' && args[1].startsWith('--extract-certificates=')) {
      fs.writeFileSync(`${args[1].slice('--extract-certificates='.length)}0`, certificate)
      return { stdout: '' }
    }
    if (command === '/usr/bin/codesign' && args.includes('-r-')) {
      return {
        stdout: `designated => identifier "com.xingmang.ai.manager" and certificate root = H"${certificateSha1}"\n`,
        stderr: 'Executable=/tmp/Fixture.app/Contents/MacOS/Fixture\n',
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
}

test('requires the exact trusted generic HTTPS updater configuration in packaged apps', async (t) => {
  const expectedUrl = 'https://updates.example.test/custom/'
  for (const [name, config, message] of [
    ['missing', undefined, /app-update\.yml/],
    ['malformed', 'provider: [generic\nurl: https://updates.example.test/custom/\n', /app-update\.yml|YAML/],
    ['wrong provider', 'provider: s3\nurl: https://updates.example.test/custom/\n', /generic|provider/],
    ['insecure URL', 'provider: generic\nurl: http://127.0.0.1:8123/\n', /HTTPS|更新地址/],
    ['wrong URL', 'provider: generic\nurl: https://updates.example.test/other/\n', /更新地址|URL/],
  ]) {
    assert.throws(() => verifyPackagedUpdateConfig(createPackagedUpdateFixture(t, config), expectedUrl), message, name)
  }
  assert.doesNotThrow(() => verifyPackagedUpdateConfig(
    createPackagedUpdateFixture(t, 'provider: generic\nurl: https://updates.example.test/custom/\n'),
    expectedUrl,
  ))
})

test('requires the four versioned public free-distribution artifact names', () => {
  assert.deepEqual(expectedFreeArtifactNames('0.1.12'), [
    'XingMang-AI-Manager-0.1.12-arm64.dmg',
    'XingMang-AI-Manager-0.1.12-arm64.zip',
    'XingMang-AI-Manager-0.1.12-x64.dmg',
    'XingMang-AI-Manager-0.1.12-x64.zip',
  ])
})

test('contains artifact output in a non-symlink child directory', (t) => {
  const root = temporaryDirectory(t)
  assert.equal(resolveSafeOutputDirectory(root, 'release-free-1.2.3'), path.join(fs.realpathSync(root), 'release-free-1.2.3'))
  assert.throws(() => resolveSafeOutputDirectory(root, ''), /输出目录/)
  assert.throws(() => resolveSafeOutputDirectory(root, '.'), /项目内的独立目录/)
  assert.throws(() => resolveSafeOutputDirectory(root, '../outside'), /项目内的独立目录/)
  assert.throws(() => resolveSafeOutputDirectory(root, 'bad\0name'), /NUL/)
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'))
  assert.throws(() => resolveSafeOutputDirectory(root, 'escape'), /项目内的独立目录|链接指向项目目录外|不能是链接/)
})

test('parses latest-mac metadata only when it exactly references the two update ZIPs', () => {
  const names = expectedFreeArtifactNames('1.2.3')
  const parsed = parseLatestMacMetadata(latestMacMetadata(names), '1.2.3', names)
  assert.equal(parsed.version, '1.2.3')
  assert.deepEqual(parsed.files.map((entry) => entry.rawUrl).sort(), [
    'XingMang-AI-Manager-1.2.3-arm64.zip',
    'XingMang-AI-Manager-1.2.3-x64.zip',
  ])
  assert.throws(() => parseLatestMacMetadata('<!doctype html><html></html>', '1.2.3', []), /HTML/)
  assert.throws(() => parseLatestMacMetadata(latestMacMetadata(names, '9.9.9'), '1.2.3', []), /版本/)
  assert.throws(() => parseLatestMacMetadata(YAML.stringify({
    version: '1.2.3',
    files: [{ url: '../escape.zip', sha512: sha512('x'), size: 1 }],
    path: '../escape.zip',
    sha512: sha512('x'),
  }), '1.2.3', []), /不安全|路径/)
  assert.throws(() => parseLatestMacMetadata(
    latestMacMetadata(names).replace('-arm64.zip', '-ARM64.zip'),
    '1.2.3',
    names,
  ), /精确|引用/)
})

test('rejects missing or extra ZIP, DMG, and unknown update metadata entries', () => {
  const names = expectedFreeArtifactNames('1.2.3')
  for (const name of [
    'unverified-arm64.zip',
    'unverified-arm64.dmg',
    'unverified.txt',
  ]) {
    const metadata = YAML.parse(latestMacMetadata(names))
    metadata.files.push({
      url: name,
      sha512: sha512(name),
      size: Buffer.byteLength(name),
    })
    assert.throws(
      () => parseLatestMacMetadata(YAML.stringify(metadata), '1.2.3', names),
      /必须精确引用两个预期 ZIP 更新文件/,
      name,
    )
  }

  const missingZip = YAML.parse(latestMacMetadata(names))
  missingZip.files = missingZip.files.filter((entry) => entry.url !== names[1])
  assert.throws(
    () => parseLatestMacMetadata(YAML.stringify(missingZip), '1.2.3', names),
    /必须精确引用两个预期 ZIP 更新文件/,
  )
})

test('rejects an unverified primary ZIP in latest-mac metadata', () => {
  const names = expectedFreeArtifactNames('1.2.3')
  const metadata = YAML.parse(latestMacMetadata(names))
  metadata.files.unshift({
    url: 'unverified-arm64.zip',
    sha512: sha512('unverified-arm64.zip'),
    size: Buffer.byteLength('unverified-arm64.zip'),
  })
  metadata.path = 'unverified-arm64.zip'
  metadata.sha512 = sha512('unverified-arm64.zip')

  assert.throws(
    () => parseLatestMacMetadata(YAML.stringify(metadata), '1.2.3', names),
    /主更新文件必须是预期架构 ZIP/,
  )

  const primaryDmg = YAML.parse(latestMacMetadata(names))
  const dmgName = names.find((name) => name.endsWith('.dmg'))
  const dmgEntry = {
    url: dmgName,
    sha512: sha512(dmgName),
    size: Buffer.byteLength(dmgName),
  }
  primaryDmg.files.push(dmgEntry)
  primaryDmg.path = dmgEntry.url
  primaryDmg.sha512 = dmgEntry.sha512
  assert.throws(
    () => parseLatestMacMetadata(YAML.stringify(primaryDmg), '1.2.3', names),
    /主更新文件必须是预期架构 ZIP/,
  )
})

test('rejects normalized but non-exact URL and primary path spellings', () => {
  const names = expectedFreeArtifactNames('1.2.3')
  const primaryName = names.find((name) => name.endsWith('-x64.zip'))
  const encodedPrimaryName = `%58${primaryName.slice(1)}`
  for (const mutate of [
    (metadata) => { metadata.files.find((entry) => entry.url === primaryName).url = ` ${primaryName}` },
    (metadata) => { metadata.files.find((entry) => entry.url === primaryName).url = encodedPrimaryName },
    (metadata) => { metadata.path = `${primaryName} ` },
    (metadata) => { metadata.path = encodedPrimaryName },
  ]) {
    const metadata = YAML.parse(latestMacMetadata(names))
    mutate(metadata)
    assert.throws(
      () => parseLatestMacMetadata(YAML.stringify(metadata), '1.2.3', names),
      /原始|精确引用/,
    )
  }
})

test('requires each ZIP metadata entry to match the exact bytes before verification', async (t) => {
  const changedFile = createFreeArtifacts(t)
  fs.writeFileSync(path.join(changedFile.outputDirectory, changedFile.names[1]), 'changed-after-metadata')
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: changedFile.projectRoot,
    outputDirectory: changedFile.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  }), /SHA-512|大小/)

  const changedSize = createFreeArtifacts(t)
  const metadataPath = path.join(changedSize.outputDirectory, 'latest-mac.yml')
  const metadata = YAML.parse(fs.readFileSync(metadataPath, 'utf8'))
  metadata.files.find((entry) => entry.url.endsWith('.zip')).size += 1
  fs.writeFileSync(metadataPath, YAML.stringify(metadata))
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: changedSize.projectRoot,
    outputDirectory: changedSize.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  }), /SHA-512|大小/)

  const missingSize = createFreeArtifacts(t)
  const missingSizePath = path.join(missingSize.outputDirectory, 'latest-mac.yml')
  const withoutSize = YAML.parse(fs.readFileSync(missingSizePath, 'utf8'))
  delete withoutSize.files.find((entry) => entry.url.endsWith('.zip')).size
  fs.writeFileSync(missingSizePath, YAML.stringify(withoutSize))
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: missingSize.projectRoot,
    outputDirectory: missingSize.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  }), /大小/)
})

test('rejects extra top-level ZIP, DMG, or blockmap inventory entries regardless of case or file type', async (t) => {
  for (const extraName of [
    'unverified.zip',
    'unverified.DMG',
    'unverified.zip.blockmap',
    'orphan.blockmap',
    'old.dmg.blockmap',
  ]) {
    const fixture = createFreeArtifacts(t)
    fs.writeFileSync(path.join(fixture.outputDirectory, extraName), 'extra')
    await assert.rejects(() => verifyMacosFreeArtifacts({
      projectRoot: fixture.projectRoot,
      outputDirectory: fixture.outputDirectory,
      version: '1.2.3',
      signingCertificateSha256: 'ab'.repeat(32),
      verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
    }), /顶层|额外|ZIP|DMG/, extraName)
  }

  const linked = createFreeArtifacts(t)
  fs.writeFileSync(path.join(linked.outputDirectory, 'target.txt'), 'extra')
  fs.symlinkSync('target.txt', path.join(linked.outputDirectory, 'linked.ZIP'))
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: linked.projectRoot,
    outputDirectory: linked.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  }), /顶层|额外|ZIP|链接/)
})

test('copies latest-mac metadata without following symlinks and detects replacement during ZIP verification', async (t) => {
  const linked = createFreeArtifacts(t)
  const linkedMetadataPath = path.join(linked.outputDirectory, 'latest-mac.yml')
  fs.renameSync(linkedMetadataPath, path.join(linked.outputDirectory, 'metadata-source.yml'))
  fs.symlinkSync('metadata-source.yml', linkedMetadataPath)
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: linked.projectRoot,
    outputDirectory: linked.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  }), /latest-mac\.yml.*链接|latest-mac\.yml.*普通文件/)

  const replaced = createFreeArtifacts(t)
  const replacedMetadataPath = path.join(replaced.outputDirectory, 'latest-mac.yml')
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: replaced.projectRoot,
    outputDirectory: replaced.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => {
      if (architecture === 'arm64') {
        const contents = fs.readFileSync(replacedMetadataPath)
        fs.renameSync(replacedMetadataPath, path.join(replaced.outputDirectory, 'latest-mac-before.yml'))
        fs.writeFileSync(replacedMetadataPath, contents)
      }
      return verifiedApplication(architecture)
    },
  }), /latest-mac\.yml.*已变更|latest-mac\.yml.*替换/)
})

test('detects output directory replacement even when artifact inodes are preserved', async (t) => {
  const fixture = createFreeArtifacts(t)
  const movedDirectory = `${fixture.outputDirectory}-moved`
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => {
      if (architecture === 'arm64') {
        fs.renameSync(fixture.outputDirectory, movedDirectory)
        fs.mkdirSync(fixture.outputDirectory)
        for (const name of [...fixture.names, 'latest-mac.yml']) {
          fs.renameSync(path.join(movedDirectory, name), path.join(fixture.outputDirectory, name))
        }
      }
      return verifiedApplication(architecture)
    },
  }), /输出目录.*已变更|输出目录.*替换/)
})

test('rejects universal architectures and unsafe ZIP entry paths before extraction', async (t) => {
  assert.equal(assertExactArchitecture('arm64', 'arm64'), 'arm64')
  assert.equal(assertExactArchitecture('x86_64', 'x64'), 'x86_64')
  assert.throws(() => assertExactArchitecture('arm64 x64', 'arm64'), /精确|架构/)
  assert.throws(() => assertExactArchitecture('x64', 'arm64'), /精确|架构/)
  assert.throws(() => assertExactArchitecture('arm64', 'x64'), /精确|架构/)
  assert.throws(() => assertExactArchitecture('x86_64 arm64', 'x64'), /精确|架构/)
  assert.throws(() => assertExactArchitecture('x64', 'x64'), /精确|架构/)
  assert.deepEqual(validateZipEntryPaths('XingMang.app/\nXingMang.app/Contents/\n'), [
    'XingMang.app/',
    'XingMang.app/Contents/',
  ])
  for (const unsafe of ['/absolute', '../escape', 'XingMang.app\\Contents', 'XingMang.app/../escape']) {
    assert.throws(() => validateZipEntryPaths(`${unsafe}\n`), /ZIP.*路径/)
  }
  const zipPath = path.join(temporaryDirectory(t), 'fixture.zip')
  fs.writeFileSync(zipPath, 'fixture')
  await assert.rejects(() => verifyZipApplication(zipPath, 'arm64', {
    expectedCertificateSha256: 'ab'.repeat(32),
    commandRunner: async (command) => {
      if (command === '/usr/bin/unzip') return { stdout: '../outside\n' }
      throw new Error(`unexpected command: ${command}`)
    },
  }), /ZIP.*路径/)
})

test('ZIP verifier passes its explicit environment to the default command boundary', async (t) => {
  const zipPath = path.join(temporaryDirectory(t), 'fixture.zip')
  fs.writeFileSync(zipPath, 'fixture')
  const env = {
    CSC_NAME: 'XingMang Free Update Identity',
    XINGMANG_MAC_SIGNING_SHA256: 'ab'.repeat(32),
    CSC_LINK: undefined,
    APPLE_API_KEY: undefined,
    AZURE_CLIENT_SECRET: undefined,
  }
  const calls = []
  await assert.rejects(() => verifyZipApplication(zipPath, 'arm64', {
    expectedCertificateSha256: 'ab'.repeat(32),
    env,
    runFile: async (command, args, options) => {
      calls.push({ command, args, options })
      return { stdout: '../outside\n', stderr: '' }
    },
  }), /ZIP.*路径/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/usr/bin/unzip')
  assert.equal(calls[0].options.env, env)
  assert.equal(calls[0].options.shell, false)
})

test('formats hashes in sorted public-artifact-only SHA256SUMS rows', async (t) => {
  const outputDirectory = temporaryDirectory(t)
  fs.writeFileSync(path.join(outputDirectory, 'b.zip'), 'second')
  fs.writeFileSync(path.join(outputDirectory, 'a.dmg'), 'first')
  const entries = await hashArtifactFiles(outputDirectory, ['b.zip', 'a.dmg'])
  assert.equal(formatSha256Manifest(entries), [
    `${crypto.createHash('sha256').update('first').digest('hex')}  a.dmg`,
    `${crypto.createHash('sha256').update('second').digest('hex')}  b.zip`,
    '',
  ].join('\n'))
})

test('verifies both ZIP applications, continuity, metadata, and writes SHA256SUMS without touching other files', async (t) => {
  const fixture = createFreeArtifacts(t)
  fs.writeFileSync(path.join(fixture.outputDirectory, 'preserve-me.txt'), 'preserve-me')
  const verified = []
  const result = await verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (zipPath, architecture, options) => {
      verified.push([path.basename(zipPath), architecture, options.expectedUpdateUrl])
      return verifiedApplication(architecture)
    },
  })
  assert.deepEqual(verified, [
    ['XingMang-AI-Manager-1.2.3-arm64.zip', 'arm64', 'https://updates.shenfengwl.fun/xingmang-manager/'],
    ['XingMang-AI-Manager-1.2.3-x64.zip', 'x64', 'https://updates.shenfengwl.fun/xingmang-manager/'],
  ])
  assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'preserve-me.txt'), 'utf8'), 'preserve-me')
  assert.equal(fs.readFileSync(result.sha256ManifestPath, 'utf8'), formatSha256Manifest(result.entries))
  assert.equal(result.entries.length, 6)
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(
      architecture,
      architecture === 'arm64' ? 'cd'.repeat(20) : 'ef'.repeat(20),
    ),
  }), /证书根|连续性/)
})

test('rejects a free release when either architecture ZIP blockmap is missing', async (t) => {
  const fixture = createFreeArtifacts(t)
  fs.rmSync(path.join(fixture.outputDirectory, fixture.blockmapNames[0]))

  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  }), /blockmap/i)
})

test('rejects a malformed ZIP blockmap before publishing free artifacts', async (t) => {
  const fixture = createFreeArtifacts(t)
  fs.writeFileSync(path.join(fixture.outputDirectory, fixture.blockmapNames[1]), 'not-gzip')

  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  }), /blockmap/i)
})

test('includes both verified ZIP blockmaps in SHA256SUMS', async (t) => {
  const fixture = createFreeArtifacts(t)
  const result = await verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
  })

  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    [...fixture.names, ...fixture.blockmapNames].sort((left, right) => left.localeCompare(right)),
  )
  for (const name of fixture.blockmapNames) {
    assert.match(fs.readFileSync(result.sha256ManifestPath, 'utf8'), new RegExp(`  ${name.replaceAll('.', '\\.')}$`, 'm'))
  }
})

test('builds SHA256SUMS from bound private-copy digests without reopening public artifacts', async (t) => {
  const fixture = createFreeArtifacts(t)
  const publicDirectory = fs.realpathSync(fixture.outputDirectory)
  const originalCreateReadStream = fs.createReadStream
  let blockPublicReads = false
  fs.createReadStream = function guardedCreateReadStream(filePath, ...args) {
    const absolutePath = path.resolve(String(filePath))
    if (blockPublicReads
      && path.dirname(absolutePath) === publicDirectory
      && [...fixture.names, ...fixture.blockmapNames].includes(path.basename(absolutePath))) {
      throw new Error(`公开产物不应被重新读取：${absolutePath}`)
    }
    return originalCreateReadStream.call(this, filePath, ...args)
  }
  try {
    const result = await verifyMacosFreeArtifacts({
      projectRoot: fixture.projectRoot,
      outputDirectory: fixture.outputDirectory,
      version: '1.2.3',
      signingCertificateSha256: 'ab'.repeat(32),
      verifyZipApplication: async (_zipPath, architecture) => {
        if (architecture === 'x64') blockPublicReads = true
        return verifiedApplication(architecture)
      },
    })
    assert.equal(result.entries.length, 6)
  } finally {
    fs.createReadStream = originalCreateReadStream
  }
})

test('fails closed when an artifact, metadata, or output directory changes during manifest publication', async (t) => {
  for (const mutate of [
    (fixture) => fs.writeFileSync(
      path.join(fixture.outputDirectory, fixture.names[0]),
      'x'.repeat(Buffer.byteLength(fixture.names[0])),
    ),
    (fixture) => {
      const metadataPath = path.join(fixture.outputDirectory, 'latest-mac.yml')
      const contents = fs.readFileSync(metadataPath)
      fs.renameSync(metadataPath, path.join(fixture.outputDirectory, 'latest-mac-before.yml'))
      fs.writeFileSync(metadataPath, contents)
    },
    (fixture) => {
      fs.renameSync(fixture.outputDirectory, `${fixture.outputDirectory}-during-manifest`)
      fs.mkdirSync(fixture.outputDirectory)
    },
  ]) {
    const fixture = createFreeArtifacts(t)
    const originalWriteFile = fs.promises.writeFile
    let mutationRan = false
    fs.promises.writeFile = async function guardedWriteFile(filePath, ...args) {
      if (!mutationRan && path.basename(String(filePath)).startsWith('.SHA256SUMS.')) {
        mutationRan = true
        mutate(fixture)
      }
      return originalWriteFile.call(this, filePath, ...args)
    }
    try {
      await assert.rejects(() => verifyMacosFreeArtifacts({
        projectRoot: fixture.projectRoot,
        outputDirectory: fixture.outputDirectory,
        version: '1.2.3',
        signingCertificateSha256: 'ab'.repeat(32),
        verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture),
      }), /已变更|替换/)
      assert.equal(mutationRan, true)
    } finally {
      fs.promises.writeFile = originalWriteFile
    }
  }
})

test('rejects a ZIP source that changes while its private verification copy is inspected', async (t) => {
  const fixture = createFreeArtifacts(t)
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => {
      if (architecture === 'arm64') fs.writeFileSync(path.join(fixture.outputDirectory, fixture.names[1]), 'swapped')
      return verifiedApplication(architecture)
    },
  }), /已变更|身份/)
})

test('parses exactly one root or leaf designated certificate slot and rejects unsafe alternatives', () => {
  assert.deepEqual(parseDesignatedRequirement(
    'designated => identifier "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"',
  ), {
    designatedRequirement: 'designated => identifier "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"',
    certificateSlot: 'leaf',
    certificateRequirementHash: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  })
  for (const requirement of [
    'IDENTIFIER "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"',
    'identifier "com.xingmang.ai.manager" or certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"',
    'not identifier "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"',
    '(identifier "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd")',
    'identifier "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" and anchor trusted',
    'identifier "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" trailing',
    'identifier "com.xingmang.ai.manager" and certificate intermediate = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"',
    'identifier "com.xingmang.ai.manager" and certificate root = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"',
    'identifier "com.xingmang.ai.manager" and certificate leaf = H"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" and certificate leaf = H"efefefefefefefefefefefefefefefefefefefef"',
  ]) {
    assert.throws(() => parseDesignatedRequirement(requirement), /指定要求|certificate.*固定|固定 SHA-1/)
  }
  assert.throws(
    () => parseDesignatedRequirement('identifier "com.xingmang.ai.manager" and cdhash H"abcd"'),
    /cdhash/,
  )
})

test('requires one exact codesign Identifier line without prefixes, suffixes, or duplicates', () => {
  assert.equal(assertExactCodesignIdentifier([
    'Executable=/tmp/XingMang.app/Contents/MacOS/XingMang',
    'Identifier=com.xingmang.ai.manager',
    'Format=app bundle with Mach-O thin (arm64)',
  ].join('\n')), 'com.xingmang.ai.manager')
  for (const details of [
    'Identifier=com.xingmang.ai.manager.evil',
    'evilIdentifier=com.xingmang.ai.manager',
    'Identifier=evil.com.xingmang.ai.manager',
    'Identifier=com.xingmang.ai.manager\nIdentifier=com.xingmang.ai.manager',
  ]) {
    assert.throws(() => assertExactCodesignIdentifier(details), /bundle identifier|Identifier/)
  }
})

test('requires the designated requirement slot hash to be the extracted leaf certificate SHA-1', async (t) => {
  const fixture = createFreeArtifacts(t)
  await assert.rejects(() => verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => ({
      ...verifiedApplication(architecture),
      certificateSha1: 'ef'.repeat(20),
    }),
  }), /指定要求.*叶证书|叶证书.*指定要求/)
})

test('accepts a leaf designated requirement only when both ZIPs bind it to their extracted certificate', async (t) => {
  const fixture = createFreeArtifacts(t)
  const result = await verifyMacosFreeArtifacts({
    projectRoot: fixture.projectRoot,
    outputDirectory: fixture.outputDirectory,
    version: '1.2.3',
    signingCertificateSha256: 'ab'.repeat(32),
    verifyZipApplication: async (_zipPath, architecture) => verifiedApplication(architecture, 'cd'.repeat(20), 'leaf'),
  })
  assert.deepEqual(result.applications.map((application) => application.certificateSlot), ['leaf', 'leaf'])
  assert.deepEqual(result.applications.map((application) => application.certificateRequirementHash), ['cd'.repeat(20), 'cd'.repeat(20)])
})

for (const [field, value] of [
  ['CFBundleIdentifier', 'com.xingmang.ai.manager.invalid'],
  ['CFBundleShortVersionString', '9.9.9'],
  ['CFBundleVersion', '9.9.9'],
]) {
  test(`rejects a signed free ZIP whose Info.plist ${field} is not bound to the expected release`, async (t) => {
    const fixture = await createInspectableZipFixture(t, {
      infoPlist: {
        CFBundleIdentifier: 'com.xingmang.ai.manager',
        CFBundleShortVersionString: '1.2.3',
        CFBundleVersion: '1.2.3',
        [field]: value,
      },
    })
    const certificateSha256 = crypto.createHash('sha256').update(fixture.certificate).digest('hex')
    await assert.rejects(() => verifyZipApplication(fixture.zipPath, 'arm64', {
      expectedCertificateSha256: certificateSha256,
      expectedVersion: '1.2.3',
      commandRunner: inspectableZipCommandRunner(fixture.sourceApp, fixture.certificate, fixture.infoPlist),
    }), new RegExp(field))
  })
}

test('rejects a signed free ZIP whose packaged metadata marks it as a local build', async (t) => {
  const fixture = await createInspectableZipFixture(t, { xingmangLocalBuild: true })
  const certificateSha256 = crypto.createHash('sha256').update(fixture.certificate).digest('hex')
  await assert.rejects(() => verifyZipApplication(fixture.zipPath, 'arm64', {
    expectedCertificateSha256: certificateSha256,
    expectedVersion: '1.2.3',
    commandRunner: inspectableZipCommandRunner(fixture.sourceApp, fixture.certificate, fixture.infoPlist),
  }), /xingmangLocalBuild/)
})

test('rejects a signed free ZIP whose packaged package version is not bound to the expected release', async (t) => {
  const fixture = await createInspectableZipFixture(t, { packageVersion: '9.9.9' })
  const certificateSha256 = crypto.createHash('sha256').update(fixture.certificate).digest('hex')
  await assert.rejects(() => verifyZipApplication(fixture.zipPath, 'arm64', {
    expectedCertificateSha256: certificateSha256,
    expectedVersion: '1.2.3',
    commandRunner: inspectableZipCommandRunner(fixture.sourceApp, fixture.certificate, fixture.infoPlist),
  }), /package\.json.*version|version.*预期版本/)
})

test('macOS ZIP integration rejects an extracted unsigned application', {
  skip: process.platform !== 'darwin' ? 'requires macOS ditto and codesign' : false,
}, async (t) => {
  const root = temporaryDirectory(t)
  const appDirectory = path.join(root, 'Fixture.app')
  fs.mkdirSync(path.join(appDirectory, 'Contents', 'MacOS'), { recursive: true })
  fs.mkdirSync(path.join(appDirectory, 'Contents', 'Resources'), { recursive: true })
  fs.writeFileSync(path.join(appDirectory, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.xingmang.ai.manager</string>',
    '<key>CFBundleShortVersionString</key><string>1.2.3</string>',
    '<key>CFBundleVersion</key><string>1.2.3</string>',
    '</dict></plist>',
  ].join('\n'))
  fs.writeFileSync(path.join(appDirectory, 'Contents', 'MacOS', 'Fixture'), '#!/bin/sh\n')
  fs.chmodSync(path.join(appDirectory, 'Contents', 'MacOS', 'Fixture'), 0o755)
  fs.writeFileSync(path.join(appDirectory, 'Contents', 'Resources', 'app.asar'), 'not-an-asar')
  fs.writeFileSync(path.join(appDirectory, 'Contents', 'Resources', 'app-update.yml'), [
    'provider: generic',
    'url: https://updates.shenfengwl.fun/xingmang-manager/',
    '',
  ].join('\n'))
  const zipPath = path.join(root, 'fixture.zip')
  const { status, stderr } = require('node:child_process').spawnSync(
    '/usr/bin/ditto', ['-c', '-k', '--keepParent', appDirectory, zipPath], { encoding: 'utf8' },
  )
  assert.equal(status, 0, stderr)
  await assert.rejects(() => verifyZipApplication(zipPath, 'arm64', {
    expectedCertificateSha256: 'ab'.repeat(32),
    expectedVersion: '1.2.3',
    commandRunner: undefined,
  }), /codesign|签名|完整性/)
})
