const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const {
  architectureArtifactNames,
  mergeMacosFreeArchitectureOutputs,
} = require('./merge-macos-free-artifacts.cjs')
const { parseLatestMacMetadata } = require('./verify-macos-free-artifacts.cjs')

const version = '1.2.3'

function temporaryOutputDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-merge-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const outputDirectory = path.join(root, `release-free-${version}`)
  fs.mkdirSync(outputDirectory)
  return outputDirectory
}

function sha512(text) {
  return createHash('sha512').update(text).digest('base64')
}

function writeStage(outputDirectory, architecture, overrides = {}) {
  const directory = path.join(outputDirectory, `arch-${architecture}`)
  fs.mkdirSync(directory)
  const [dmgName, zipName, blockmapName] = architectureArtifactNames(version, architecture)
  const zipBody = `zip-${architecture}`
  fs.writeFileSync(path.join(directory, dmgName), `dmg-${architecture}`)
  fs.writeFileSync(path.join(directory, zipName), zipBody)
  fs.writeFileSync(path.join(directory, blockmapName), `blockmap-${architecture}`)
  const document = {
    version,
    files: [{
      url: zipName,
      sha512: sha512(zipBody),
      size: Buffer.byteLength(zipBody),
      blockMapSize: 32,
    }],
    path: zipName,
    sha512: sha512(zipBody),
    releaseDate: `2026-09-19T0${architecture === 'arm64' ? 1 : 2}:00:00.000Z`,
    ...overrides,
  }
  // electron-builder leaves its own unpacked tree behind; the merge is expected
  // to drop it rather than carry it into a release directory.
  fs.mkdirSync(path.join(directory, `mac-${architecture}`))
  fs.writeFileSync(path.join(directory, `mac-${architecture}`, 'placeholder'), 'app')
  fs.writeFileSync(path.join(directory, 'builder-effective-config.yaml'), 'effective: true')
  fs.writeFileSync(path.join(directory, 'latest-mac.yml'), YAML.stringify(document, { lineWidth: 0 }))
  return { directory, architecture, names: [dmgName, zipName, blockmapName], document }
}

function bothStages(outputDirectory) {
  return [
    { architecture: 'arm64', directory: path.join(outputDirectory, 'arch-arm64') },
    { architecture: 'x64', directory: path.join(outputDirectory, 'arch-x64') },
  ]
}

test('merges two single-architecture builds into one verifiable release directory', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const arm64 = writeStage(outputDirectory, 'arm64')
  const x64 = writeStage(outputDirectory, 'x64')

  const result = mergeMacosFreeArchitectureOutputs({
    outputDirectory,
    version,
    stages: bothStages(outputDirectory),
  })

  assert.equal(result.outputDirectory, outputDirectory)
  assert.deepEqual(
    fs.readdirSync(outputDirectory).sort(),
    [...arm64.names, ...x64.names, 'latest-mac.yml'].sort(),
  )
  assert.equal(fs.existsSync(arm64.directory), false)
  assert.equal(fs.existsSync(x64.directory), false)

  const metadata = parseLatestMacMetadata(
    fs.readFileSync(result.metadataPath, 'utf8'),
    version,
    [...arm64.names, ...x64.names],
  )
  assert.equal(metadata.rawPrimaryPath, arm64.document.path)
  assert.deepEqual(metadata.files.map((entry) => entry.rawUrl), [
    arm64.document.path,
    x64.document.path,
  ])
  assert.deepEqual(metadata.files.map((entry) => entry.size), [
    arm64.document.files[0].size,
    x64.document.files[0].size,
  ])

  // Whatever else electron-builder wrote into the primary architecture's
  // manifest has to survive: the merge only replaces the file list.
  const merged = YAML.parse(fs.readFileSync(result.metadataPath, 'utf8'))
  assert.equal(merged.releaseDate, arm64.document.releaseDate)
  assert.deepEqual(merged.files.map((entry) => entry.blockMapSize), [32, 32])
})

test('refuses a staging directory whose manifest describes another build', (t) => {
  const foreignZip = `XingMang-AI-Manager-${version}-x64.zip`
  const foreignDigest = sha512('zip-x64')
  for (const [overrides, expected] of [
    [{ version: '9.9.9' }, /版本/],
    [{
      files: [{ url: foreignZip, sha512: foreignDigest, size: 7 }],
      path: foreignZip,
      sha512: foreignDigest,
    }, /主更新文件必须是预期架构/],
  ]) {
    const outputDirectory = temporaryOutputDirectory(t)
    writeStage(outputDirectory, 'arm64', overrides)
    writeStage(outputDirectory, 'x64')
    assert.throws(() => mergeMacosFreeArchitectureOutputs({
      outputDirectory,
      version,
      stages: bothStages(outputDirectory),
    }), expected)
  }
})

test('refuses a staging directory carrying an artifact it did not build', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const arm64 = writeStage(outputDirectory, 'arm64')
  writeStage(outputDirectory, 'x64')
  fs.writeFileSync(
    path.join(arm64.directory, `XingMang-AI-Manager-${version}-x64.zip`),
    'foreign',
  )

  assert.throws(() => mergeMacosFreeArchitectureOutputs({
    outputDirectory,
    version,
    stages: bothStages(outputDirectory),
  }), /非预期 ZIP\/DMG\/blockmap/)
})

test('never overwrites something already sitting in the release directory', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const arm64 = writeStage(outputDirectory, 'arm64')
  writeStage(outputDirectory, 'x64')
  const occupied = path.join(outputDirectory, arm64.names[1])
  fs.writeFileSync(occupied, 'existing')

  assert.throws(() => mergeMacosFreeArchitectureOutputs({
    outputDirectory,
    version,
    stages: bothStages(outputDirectory),
  }), /已存在同名产物/)
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing')
  // Nothing may move before every check has passed, or a rejected merge leaves
  // a directory that looks half-released.
  assert.equal(fs.existsSync(path.join(outputDirectory, arm64.names[0])), false)
  assert.equal(fs.existsSync(arm64.directory), true)
})

test('only ever deletes staging directories directly under the release directory', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  writeStage(outputDirectory, 'arm64')
  writeStage(outputDirectory, 'x64')

  assert.throws(() => mergeMacosFreeArchitectureOutputs({
    outputDirectory,
    version,
    stages: [
      { architecture: 'arm64', directory: outputDirectory },
      { architecture: 'x64', directory: path.join(outputDirectory, 'arch-x64') },
    ],
  }), /直接子目录/)
  assert.equal(fs.existsSync(path.join(outputDirectory, 'arch-arm64')), true)

  assert.throws(() => mergeMacosFreeArchitectureOutputs({
    outputDirectory,
    version,
    stages: [{ architecture: 'arm64', directory: path.join(outputDirectory, 'arch-arm64') }],
  }), /arm64、x64 顺序/)
})
