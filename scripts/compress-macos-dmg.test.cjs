const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { releaseArtifactNames } = require('./macos-artifact-names.cjs')
const { compressMacosDmgArtifacts, parseImageFormat } = require('./compress-macos-dmg.cjs')

const version = '1.2.3'

function temporaryOutputDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-dmg-compress-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const outputDirectory = path.join(root, `release-free-${version}`)
  fs.mkdirSync(outputDirectory)
  return outputDirectory
}

function writeReleaseDmgs(outputDirectory) {
  for (const architecture of ['arm64', 'x64']) {
    fs.writeFileSync(path.join(outputDirectory, releaseArtifactNames(version, architecture).dmg), `udzo-${architecture}`)
  }
}

function imageInfo(format) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>Checksum Type</key>
\t<string>CRC32</string>
\t<key>Format</key>
\t<string>${format}</string>
\t<key>Format Description</key>
\t<string>LZMA-compressed</string>
</dict>
</plist>
`
}

// Stands in for hdiutil: `convert` writes the output it was asked for, and
// `imageinfo` reports whatever format the case wants.
function fakeHdiutil(calls, options = {}) {
  return async (args) => {
    calls.push(args)
    if (args[0] === 'convert') {
      if (options.failConvert) throw new Error('hdiutil convert 失败：磁盘满了')
      const source = fs.readFileSync(args[1], 'utf8')
      fs.writeFileSync(args[5], source.replace('udzo-', 'ulmo-'))
      return ''
    }
    if (args[0] === 'imageinfo') return imageInfo(options.format || 'ULMO')
    throw new Error(`unexpected hdiutil call: ${args.join(' ')}`)
  }
}

function releaseFiles(outputDirectory) {
  return fs.readdirSync(outputDirectory).sort()
}

test('converts both release DMGs to ULMO in place and leaves nothing else behind', async (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  writeReleaseDmgs(outputDirectory)
  const calls = []
  const lines = []

  const results = await compressMacosDmgArtifacts({
    outputDirectory, version, runHdiutil: fakeHdiutil(calls), log: (line) => lines.push(line),
  })

  const names = ['arm64', 'x64'].map((architecture) => releaseArtifactNames(version, architecture).dmg)
  assert.deepEqual(releaseFiles(outputDirectory), [...names].sort())
  for (const [index, architecture] of ['arm64', 'x64'].entries()) {
    assert.equal(fs.readFileSync(path.join(outputDirectory, names[index]), 'utf8'), `ulmo-${architecture}`)
  }
  assert.deepEqual(results.map((result) => [result.architecture, result.name]), [['arm64', names[0]], ['x64', names[1]]])
  assert.equal(lines.length, 2)

  // Exactly convert-then-check per image, the converted copy written next to the
  // original under a hidden temporary name, and the source never overwritten by hdiutil.
  assert.equal(calls.length, 4)
  for (const [index, name] of names.entries()) {
    const [convert, info] = calls.slice(index * 2, index * 2 + 2)
    assert.deepEqual(convert.slice(0, 5), ['convert', path.join(outputDirectory, name), '-format', 'ULMO', '-o'])
    const temporary = convert[5]
    assert.equal(path.dirname(temporary), outputDirectory)
    assert.match(path.basename(temporary), /^\..+\.[0-9a-f]{12}\.dmg$/)
    assert.notEqual(temporary, path.join(outputDirectory, name))
    assert.deepEqual(info, ['imageinfo', '-plist', temporary])
  }
})

test('keeps the original DMG and removes the temporary copy when the result is not ULMO', async (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  writeReleaseDmgs(outputDirectory)
  const before = releaseFiles(outputDirectory)

  await assert.rejects(
    () => compressMacosDmgArtifacts({ outputDirectory, version, runHdiutil: fakeHdiutil([], { format: 'UDZO' }), log: () => {} }),
    /转换后的格式是 UDZO，不是 ULMO/,
  )

  assert.deepEqual(releaseFiles(outputDirectory), before)
  const arm64 = releaseArtifactNames(version, 'arm64').dmg
  assert.equal(fs.readFileSync(path.join(outputDirectory, arm64), 'utf8'), 'udzo-arm64')
})

test('keeps the original DMG when hdiutil convert fails', async (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  writeReleaseDmgs(outputDirectory)
  const before = releaseFiles(outputDirectory)

  await assert.rejects(
    () => compressMacosDmgArtifacts({ outputDirectory, version, runHdiutil: fakeHdiutil([], { failConvert: true }), log: () => {} }),
    /磁盘满了/,
  )

  assert.deepEqual(releaseFiles(outputDirectory), before)
})

test('refuses a missing or empty release DMG before running hdiutil', async (t) => {
  for (const setup of ['missing', 'empty']) {
    const outputDirectory = temporaryOutputDirectory(t)
    if (setup === 'empty') fs.writeFileSync(path.join(outputDirectory, releaseArtifactNames(version, 'arm64').dmg), '')
    const calls = []

    await assert.rejects(
      () => compressMacosDmgArtifacts({ outputDirectory, version, runHdiutil: fakeHdiutil(calls), log: () => {} }),
      setup === 'missing' ? /缺少arm64 安装包/ : /必须是非空普通文件/,
    )
    assert.deepEqual(calls, [], setup)
  }
})

// The script only ever runs on macOS; creating symlinks on Windows needs a
// privilege the machine running npm test may not hold.
test('refuses a linked release DMG or output directory', { skip: process.platform === 'win32' }, async (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const elsewhere = path.join(path.dirname(outputDirectory), 'elsewhere.dmg')
  fs.writeFileSync(elsewhere, 'udzo-arm64')
  fs.symlinkSync(elsewhere, path.join(outputDirectory, releaseArtifactNames(version, 'arm64').dmg))
  const calls = []
  await assert.rejects(
    () => compressMacosDmgArtifacts({ outputDirectory, version, runHdiutil: fakeHdiutil(calls), log: () => {} }),
    /必须是非空普通文件/,
  )
  assert.deepEqual(calls, [])

  const link = `${outputDirectory}-link`
  fs.symlinkSync(outputDirectory, link)
  t.after(() => fs.rmSync(link, { force: true }))
  await assert.rejects(() => compressMacosDmgArtifacts({ outputDirectory: link, version, runHdiutil: fakeHdiutil([]) }), /普通目录/)
})

test('refuses an output directory that is not a valid path', async () => {
  await assert.rejects(() => compressMacosDmgArtifacts({ outputDirectory: '', version, runHdiutil: fakeHdiutil([]) }), /有效路径/)
  await assert.rejects(() => compressMacosDmgArtifacts({ outputDirectory: 'a\0b', version, runHdiutil: fakeHdiutil([]) }), /有效路径/)
})

test('reads the image format out of hdiutil imageinfo -plist', () => {
  assert.equal(parseImageFormat(imageInfo('ULMO')), 'ULMO')
  assert.equal(parseImageFormat(imageInfo('UDZO')), 'UDZO')
  assert.equal(parseImageFormat('<plist><dict><key>Format Description</key><string>ULMO</string></dict></plist>'), null)
  assert.equal(parseImageFormat(''), null)
  assert.equal(parseImageFormat(undefined), null)
})
