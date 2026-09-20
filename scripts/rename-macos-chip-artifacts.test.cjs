const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const { builderArtifactNames, releaseArtifactNames } = require('./macos-artifact-names.cjs')
const { renameMacosChipArtifacts } = require('./rename-macos-chip-artifacts.cjs')

const version = '1.2.3'

function sha512(text) {
  return createHash('sha512').update(text).digest('base64')
}

function temporaryOutputDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-rename-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const outputDirectory = path.join(root, `release-free-${version}`)
  fs.mkdirSync(outputDirectory)
  return outputDirectory
}

function zipBody(architecture) {
  return `zip-${architecture}`
}

function builderMetadataDocument(overrides = {}) {
  const primary = builderArtifactNames(version, 'arm64').zip
  return {
    version,
    files: ['arm64', 'x64'].map((architecture) => ({
      url: builderArtifactNames(version, architecture).zip,
      sha512: sha512(zipBody(architecture)),
      size: Buffer.byteLength(zipBody(architecture)),
      blockMapSize: 32,
    })),
    path: primary,
    sha512: sha512(zipBody('arm64')),
    releaseDate: '2026-09-20T01:00:00.000Z',
    ...overrides,
  }
}

function writeBuilderOutput(t, { metadata = builderMetadataDocument(), skip = [] } = {}) {
  const outputDirectory = temporaryOutputDirectory(t)
  for (const architecture of ['arm64', 'x64']) {
    const names = builderArtifactNames(version, architecture)
    if (!skip.includes(names.dmg)) fs.writeFileSync(path.join(outputDirectory, names.dmg), `dmg-${architecture}`)
    if (!skip.includes(names.zip)) fs.writeFileSync(path.join(outputDirectory, names.zip), zipBody(architecture))
    if (!skip.includes(names.blockmap)) {
      fs.writeFileSync(path.join(outputDirectory, names.blockmap), `blockmap-${architecture}`)
    }
  }
  if (metadata) {
    fs.writeFileSync(path.join(outputDirectory, 'latest-mac.yml'), YAML.stringify(metadata, { lineWidth: 0 }))
  }
  return outputDirectory
}

test('renames all six artifacts and rewrites the update manifest to match', (t) => {
  const outputDirectory = writeBuilderOutput(t)

  const result = renameMacosChipArtifacts({ outputDirectory, version })

  assert.deepEqual(fs.readdirSync(outputDirectory).sort(), [
    'XingMang-AI-Manager-1.2.3-Apple-Silicon-arm64.dmg',
    'XingMang-AI-Manager-1.2.3-Apple-Silicon-arm64.zip',
    'XingMang-AI-Manager-1.2.3-Apple-Silicon-arm64.zip.blockmap',
    'XingMang-AI-Manager-1.2.3-Intel-x64.dmg',
    'XingMang-AI-Manager-1.2.3-Intel-x64.zip',
    'XingMang-AI-Manager-1.2.3-Intel-x64.zip.blockmap',
    'latest-mac.yml',
  ].sort())
  assert.equal(result.names.length, 6)
  const metadata = YAML.parse(fs.readFileSync(result.metadataPath, 'utf8'))
  assert.deepEqual(metadata.files.map((entry) => entry.url), [
    releaseArtifactNames(version, 'arm64').zip,
    releaseArtifactNames(version, 'x64').zip,
  ])
  assert.equal(metadata.path, releaseArtifactNames(version, 'arm64').zip)
})

test('moves bytes without touching them, so every digest and size still holds', (t) => {
  const outputDirectory = writeBuilderOutput(t)

  renameMacosChipArtifacts({ outputDirectory, version })

  const metadata = YAML.parse(fs.readFileSync(path.join(outputDirectory, 'latest-mac.yml'), 'utf8'))
  for (const entry of metadata.files) {
    const body = fs.readFileSync(path.join(outputDirectory, entry.url))
    assert.equal(createHash('sha512').update(body).digest('base64'), entry.sha512)
    assert.equal(body.byteLength, entry.size)
  }
  assert.equal(metadata.releaseDate, '2026-09-20T01:00:00.000Z')
  assert.equal(metadata.files.every((entry) => entry.blockMapSize === 32), true)
})

test('refuses an output directory that is missing one of the artifacts', (t) => {
  const outputDirectory = writeBuilderOutput(t, { skip: [builderArtifactNames(version, 'x64').blockmap] })

  assert.throws(() => renameMacosChipArtifacts({ outputDirectory, version }), /缺少x64 产物/)
  // Nothing may move while a name is still unaccounted for: a half-renamed
  // release installs and then never updates.
  assert.equal(fs.existsSync(path.join(outputDirectory, builderArtifactNames(version, 'arm64').dmg)), true)
  assert.equal(fs.existsSync(path.join(outputDirectory, releaseArtifactNames(version, 'arm64').dmg)), false)
})

test('refuses a directory whose manifest is missing, oversized or already renamed', (t) => {
  assert.throws(
    () => renameMacosChipArtifacts({ outputDirectory: writeBuilderOutput(t, { metadata: null }), version }),
    /缺少latest-mac\.yml/,
  )

  const renamed = builderMetadataDocument({
    files: [{ url: releaseArtifactNames(version, 'arm64').zip, sha512: sha512(zipBody('arm64')), size: 9 }],
    path: releaseArtifactNames(version, 'arm64').zip,
  })
  assert.throws(
    () => renameMacosChipArtifacts({ outputDirectory: writeBuilderOutput(t, { metadata: renamed }), version }),
    /latest-mac\.yml/,
  )

  const oversized = writeBuilderOutput(t)
  fs.writeFileSync(path.join(oversized, 'latest-mac.yml'), 'x'.repeat(1024 * 1024 + 1))
  assert.throws(() => renameMacosChipArtifacts({ outputDirectory: oversized, version }), /超过 1 MiB/)
})

test('refuses a version the manifest does not claim and a directory that is not one', (t) => {
  const outputDirectory = writeBuilderOutput(t)
  assert.throws(() => renameMacosChipArtifacts({ outputDirectory, version: '9.9.9' }), /版本/)
  assert.throws(
    () => renameMacosChipArtifacts({ outputDirectory: path.join(outputDirectory, 'latest-mac.yml'), version }),
    /产物目录必须是普通目录/,
  )
  assert.throws(
    () => renameMacosChipArtifacts({ outputDirectory: path.join(outputDirectory, 'missing'), version }),
    /产物目录不存在/,
  )
})

test('refuses to overwrite a release name that already sits in the directory', (t) => {
  const outputDirectory = writeBuilderOutput(t)
  fs.writeFileSync(path.join(outputDirectory, releaseArtifactNames(version, 'x64').zip), 'stale')

  assert.throws(() => renameMacosChipArtifacts({ outputDirectory, version }), /已存在同名发行文件/)
  assert.equal(fs.readFileSync(path.join(outputDirectory, releaseArtifactNames(version, 'x64').zip), 'utf8'), 'stale')
})
