const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash, generateKeyPairSync } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')
const {
  SIGNATURE_FIELD,
  UpdateSignatureError,
  buildPayload,
  exportPublicKey,
  loadSigningKey,
  prepareRollbackText,
  readPinnedPublicKeys,
  signManifestText,
  verifyManifestText,
} = require('./update-manifest-signature.cjs')

function keyPair() {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: exportPublicKey(privateKey) }
}

function manifestText(version = '0.2.11', installer = Buffer.from(`installer ${version}`)) {
  const file = `XingMang-AI-Manager-${version}-Setup.exe`
  const sha512 = createHash('sha512').update(installer).digest('base64')
  // electron-builder 写出来的样子：顶层 path/sha512 与 files[0] 重复，releaseDate 带引号。
  return {
    file,
    installer,
    text: [
      `version: ${version}`,
      'files:',
      `  - url: ${file}`,
      `    sha512: ${sha512}`,
      `    size: ${installer.length}`,
      `path: ${file}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-09-25T12:00:00.000Z'",
      '',
    ].join('\n'),
  }
}

test('signs every file entry and leaves the rest of the manifest untouched', () => {
  const { privateKey, publicKey } = keyPair()
  const { text } = manifestText()
  const signed = signManifestText(text, privateKey, [publicKey])
  const original = YAML.parse(text)
  const parsed = YAML.parse(signed)
  assert.equal(typeof parsed.files[0][SIGNATURE_FIELD], 'string')
  delete parsed.files[0][SIGNATURE_FIELD]
  assert.deepEqual(parsed, original)
  // electron-updater 读的其余行一个字节都不变，签名只是多出来的一行。
  const added = signed.split('\n').filter((line) => !text.split('\n').includes(line))
  assert.equal(added.length, 1)
  assert.match(added[0], new RegExp(`^    ${SIGNATURE_FIELD}: `))
  assert.equal(verifyManifestText(signed, [publicKey]), 1)
})

test('signing is deterministic so a re-run publish uploads identical bytes', () => {
  const { privateKey, publicKey } = keyPair()
  const { text } = manifestText()
  assert.equal(signManifestText(text, privateKey, [publicKey]), signManifestText(text, privateKey, [publicKey]))
})

test('refuses to sign with a key the client does not trust', () => {
  const signer = keyPair()
  const pinned = keyPair()
  assert.throws(() => signManifestText(manifestText().text, signer.privateKey, [pinned.publicKey]), /不在客户端内置名单里/)
})

test('rejects a manifest whose entry was swapped after signing', () => {
  const { privateKey, publicKey } = keyPair()
  const signed = signManifestText(manifestText().text, privateKey, [publicKey])
  const forged = manifestText('0.2.11', Buffer.from('something else'))
  const tampered = YAML.parse(signed)
  tampered.files[0].sha512 = YAML.parse(forged.text).files[0].sha512
  tampered.sha512 = tampered.files[0].sha512
  assert.throws(() => verifyManifestText(YAML.stringify(tampered), [publicKey]), /签名校验不通过/)
})

test('rejects an old signed entry re-announced under a higher version', () => {
  const { privateKey, publicKey } = keyPair()
  const signed = YAML.parse(signManifestText(manifestText('0.2.11').text, privateKey, [publicKey]))
  signed.version = '0.2.12'
  assert.throws(() => verifyManifestText(YAML.stringify(signed), [publicKey]), /签名校验不通过/)
})

test('rejects an unsigned manifest and an empty key list', () => {
  const { publicKey } = keyPair()
  assert.throws(() => verifyManifestText(manifestText().text, [publicKey]), /没有发布者签名/)
  assert.throws(() => verifyManifestText(manifestText().text, []), /还没有内置/)
})

test('explains a missing or malformed signing secret by name', () => {
  assert.throws(() => loadSigningKey(''), /XINGMANG_UPDATE_SIGNING_KEY/)
  assert.throws(() => loadSigningKey('not a key'), /不是有效的私钥/)
  const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const encoded = rsa.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  assert.throws(() => loadSigningKey(encoded), /不是 Ed25519/)
  const { privateKey } = keyPair()
  const good = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  assert.equal(exportPublicKey(loadSigningKey(`${good}\n`)), exportPublicKey(privateKey))
})

test('builds the payload the client verifies and refuses line breaks', () => {
  assert.equal(
    buildPayload('0.2.11', 'a.exe', 'abc=='),
    'xingmang-update-signature/v1\nversion=0.2.11\nurl=a.exe\nsha512=abc==\n',
  )
  assert.throws(() => buildPayload('0.2.11', 'a.exe\nsha512=x', 'abc=='), UpdateSignatureError)
})

test('reads the pinned keys from the client source, tolerating CRLF', () => {
  const source = "x\n// update-signing-keys:begin\r\nexport const k = [\r\n  'QUJD',\r\n  'REVG',\r\n]\r\n// update-signing-keys:end\n"
  assert.deepEqual(readPinnedPublicKeys(source), ['QUJD', 'REVG'])
  assert.throws(() => readPinnedPublicKeys('no markers'), /起止标记/)
  // 真实源码的标记必须一直在：发布时就是从这里读公钥的。
  assert.ok(Array.isArray(readPinnedPublicKeys()))
})

function releaseDirectory(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-release-assets-'))
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes)
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('rollback re-signs a pre-signature backup only when GitHub Release has the same bytes', () => {
  const { privateKey, publicKey } = keyPair()
  const legacy = manifestText('0.2.10')
  const assets = releaseDirectory({ [legacy.file]: legacy.installer })
  try {
    const result = prepareRollbackText(legacy.text, { releaseDir: assets.directory, privateKey, pinnedKeys: [publicKey] })
    assert.equal(result.action, 'signed')
    assert.equal(verifyManifestText(result.text, [publicKey]), 1)
  } finally { assets.cleanup() }
})

test('rollback refuses to vouch for a backup that does not match GitHub Release, and restores it unsigned when the asset is absent', () => {
  const { privateKey, publicKey } = keyPair()
  const legacy = manifestText('0.2.10')
  const swapped = releaseDirectory({ [legacy.file]: Buffer.from('the genuine installer') })
  const missing = releaseDirectory({})
  try {
    assert.throws(
      () => prepareRollbackText(legacy.text, { releaseDir: swapped.directory, privateKey, pinnedKeys: [publicKey] }),
      /SHA-512 不一致/,
    )
    // 第二个来源缺席时不补签也不拦回退：老客户端照样退得回去。
    assert.deepEqual(
      prepareRollbackText(legacy.text, { releaseDir: missing.directory, privateKey, pinnedKeys: [publicKey] }),
      { text: legacy.text, action: 'unsigned', missing: legacy.file },
    )
  } finally {
    swapped.cleanup()
    missing.cleanup()
  }
})

test('rollback keeps an already signed backup as is and rejects a bad signature', () => {
  const { privateKey, publicKey } = keyPair()
  const signed = signManifestText(manifestText('0.2.11').text, privateKey, [publicKey])
  const result = prepareRollbackText(signed, { releaseDir: '/nonexistent', privateKey, pinnedKeys: [publicKey] })
  assert.deepEqual(result, { text: signed, action: 'verified' })
  const other = keyPair()
  assert.throws(
    () => prepareRollbackText(signed, { releaseDir: '/nonexistent', privateKey: other.privateKey, pinnedKeys: [other.publicKey] }),
    /签名校验不通过/,
  )
})

function linuxManifestText(version = '0.2.22', architecture = 'arm64') {
  const file = `xingmang-ai-manager_${version}_${architecture}.deb`
  const deb = Buffer.from(`deb ${version} ${architecture}`)
  const sha512 = createHash('sha512').update(deb).digest('base64')
  // latest-linux*.yml 和 latest.yml 同一个样子，只是没有 blockmap。
  return {
    file,
    deb,
    text: [
      `version: ${version}`,
      'files:',
      `  - url: ${file}`,
      `    sha512: ${sha512}`,
      `    size: ${deb.length}`,
      `path: ${file}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-10-27T12:00:00.000Z'",
      '',
    ].join('\n'),
  }
}

test('signs a Linux manifest and names that manifest when a signature is missing or wrong', () => {
  const { privateKey, publicKey } = keyPair()
  const { text } = linuxManifestText()
  const signed = signManifestText(text, privateKey, [publicKey], 'latest-linux-arm64.yml')
  assert.equal(verifyManifestText(signed, [publicKey], 'latest-linux-arm64.yml'), 1)
  assert.throws(
    () => verifyManifestText(text, [publicKey], 'latest-linux-arm64.yml'),
    /latest-linux-arm64\.yml 的 xingmang-ai-manager_0\.2\.22_arm64\.deb 没有发布者签名/,
  )
  const other = keyPair()
  assert.throws(() => verifyManifestText(signed, [other.publicKey], 'latest-linux-arm64.yml'), /latest-linux-arm64\.yml 的 .* 签名校验不通过/)
})

test('the command line signs and verifies a Linux manifest under its own name', () => {
  const { privateKey, publicKey } = keyPair()
  const { text } = linuxManifestText('0.2.22', 'amd64')
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-manifest-'))
  try {
    // 真脚本照原样用，只把它读公钥的客户端源码换成一份只钉着本次临时公钥的。
    fs.mkdirSync(path.join(workspace, 'scripts'))
    fs.mkdirSync(path.join(workspace, 'electron'))
    for (const name of ['update-manifest-signature.cjs', 'update-release-utils.cjs', 'macos-artifact-names.cjs', 'linux-artifact-names.cjs']) {
      fs.copyFileSync(path.join(__dirname, name), path.join(workspace, 'scripts', name))
    }
    // junction：Windows 上建目录联接不要开发者模式，别的系统忽略这个参数。
    fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(workspace, 'node_modules'), 'junction')
    fs.writeFileSync(path.join(workspace, 'electron', 'update-package-signature.ts'), `// update-signing-keys:begin\nexport const keys = [\n  '${publicKey}',\n]\n// update-signing-keys:end\n`)
    const manifest = path.join(workspace, 'latest-linux.yml')
    fs.writeFileSync(manifest, text)
    const script = path.join(workspace, 'scripts', 'update-manifest-signature.cjs')
    const env = { ...process.env, XINGMANG_UPDATE_SIGNING_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }
    const unsigned = spawnSync(process.execPath, [script, 'verify', '--manifest', manifest], { encoding: 'utf8', env })
    assert.notEqual(unsigned.status, 0)
    assert.match(unsigned.stderr, /::error::latest-linux\.yml 的 xingmang-ai-manager_0\.2\.22_amd64\.deb 没有发布者签名/)
    const signed = spawnSync(process.execPath, [script, 'sign', '--manifest', manifest], { encoding: 'utf8', env })
    assert.equal(signed.status, 0, signed.stderr)
    const verified = spawnSync(process.execPath, [script, 'verify', '--manifest', manifest], { encoding: 'utf8', env })
    assert.equal(verified.status, 0, verified.stderr)
    assert.equal(verifyManifestText(fs.readFileSync(manifest, 'utf8'), [publicKey], 'latest-linux.yml'), 1)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
