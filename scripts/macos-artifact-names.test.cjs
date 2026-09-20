const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ARCHITECTURES,
  builderArtifactNames,
  releaseArtifactBaseName,
  releaseArtifactNames,
} = require('./macos-artifact-names.cjs')

test('builder names stay on the architecture electron-builder can express', () => {
  assert.deepEqual(builderArtifactNames('1.2.3', 'arm64'), {
    dmg: 'XingMang-AI-Manager-1.2.3-arm64.dmg',
    zip: 'XingMang-AI-Manager-1.2.3-arm64.zip',
    blockmap: 'XingMang-AI-Manager-1.2.3-arm64.zip.blockmap',
  })
  assert.deepEqual(builderArtifactNames('1.2.3', 'x64'), {
    dmg: 'XingMang-AI-Manager-1.2.3-x64.dmg',
    zip: 'XingMang-AI-Manager-1.2.3-x64.zip',
    blockmap: 'XingMang-AI-Manager-1.2.3-x64.zip.blockmap',
  })
})

test('release names carry the chip label customers read in 关于本机', () => {
  assert.deepEqual(releaseArtifactNames('1.2.3', 'arm64'), {
    dmg: 'XingMang-AI-Manager-1.2.3-Apple-Silicon-arm64.dmg',
    zip: 'XingMang-AI-Manager-1.2.3-Apple-Silicon-arm64.zip',
    blockmap: 'XingMang-AI-Manager-1.2.3-Apple-Silicon-arm64.zip.blockmap',
  })
  assert.deepEqual(releaseArtifactNames('1.2.3', 'x64'), {
    dmg: 'XingMang-AI-Manager-1.2.3-Intel-x64.dmg',
    zip: 'XingMang-AI-Manager-1.2.3-Intel-x64.zip',
    blockmap: 'XingMang-AI-Manager-1.2.3-Intel-x64.zip.blockmap',
  })
})

// electron-updater's MacUpdater.filterFilesForArch selects the update payload
// with `file.url.pathname.includes("arm64")`: Apple silicon takes a file whose
// URL carries that substring, every other Mac takes one that does not. A
// release name that loses the token - or an Intel name that gains it - hands
// every customer the wrong build, and nothing before install time notices.
test('every release name keeps the arm64 token exclusive to Apple silicon', () => {
  for (const [architecture, shouldMatch] of [['arm64', true], ['x64', false]]) {
    for (const name of Object.values(releaseArtifactNames('1.2.3', architecture))) {
      assert.equal(name.includes('arm64'), shouldMatch, name)
      assert.equal(name.endsWith(`-${architecture}.dmg`)
        || name.endsWith(`-${architecture}.zip`)
        || name.endsWith(`-${architecture}.zip.blockmap`), true, name)
    }
  }
})

test('release names stay ASCII so an update URL needs no percent encoding', () => {
  for (const architecture of ARCHITECTURES) {
    const baseName = releaseArtifactBaseName('1.2.3', architecture)
    assert.match(baseName, /^[A-Za-z0-9.-]+$/)
    assert.equal(encodeURIComponent(baseName), baseName)
  }
})

test('rejects a version or architecture it cannot name', () => {
  assert.throws(() => releaseArtifactNames('1.2', 'arm64'), /版本号无效/)
  assert.throws(() => releaseArtifactNames('../1.2.3', 'arm64'), /版本号无效/)
  assert.throws(() => releaseArtifactNames('1.2.3', 'ia32'), /架构必须是/)
  assert.throws(() => builderArtifactNames('1.2.3', 'universal'), /架构必须是/)
})
