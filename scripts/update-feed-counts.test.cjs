const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const fc = require('fast-check')
const { CountsSealError, openSealedTexts, readPublicKey, sealText } = require('./update-feed-counts.cjs')

function keyPair(modulusLength = 3072) {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

const keys = keyPair()
const otherKeys = keyPair()
const script = path.join(__dirname, 'update-feed-counts.cjs')

test('a sealed line opens back to the same text, and two seals of the same text differ', () => {
  const text = '| 2026-11-20 | 312 | 140 | 0 | **452** |'
  const first = sealText(text, keys.publicKey)
  const second = sealText(text, keys.publicKey)
  assert.match(first, /^XMC1\.[A-Za-z0-9+/=.]+$/)
  assert.notEqual(first, second)
  assert.doesNotMatch(first, /312|452/)
  assert.deepEqual(openSealedTexts(`前面的字\n2026-11-21T06:17:00.1Z ${first}\n后面的字 ${second}`, keys.privateKey), [text, text])
  assert.deepEqual(openSealedTexts('一段密文都没有', keys.privateKey), [])
})

test('a line that was cut, edited or sealed for another key does not open', () => {
  const sealed = sealText('台数', keys.publicKey)
  assert.throws(() => openSealedTexts(sealed, otherKeys.privateKey), CountsSealError)
  const parts = sealed.split('.')
  const body = Buffer.from(parts[4], 'base64')
  body[0] ^= 1
  assert.throws(() => openSealedTexts([...parts.slice(0, 4), body.toString('base64')].join('.'), keys.privateKey), /解不开/)
  assert.throws(() => openSealedTexts(sealed.slice(0, -8), keys.privateKey), /解不开/)
})

test('only RSA keys of 3072 bits or more are taken, public to seal and private to open', () => {
  const small = keyPair(2048)
  assert.throws(() => sealText('台数', small.publicKey), /至少要 3072 位/)
  assert.throws(() => sealText('台数', keys.privateKey.replace(/PRIVATE KEY/g, 'NOT A KEY')), /公钥读不出来/)
  assert.throws(() => openSealedTexts('', keys.publicKey), /钥匙文件读不出来|不是 RSA 私钥/)
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  assert.throws(() => readPublicKey(ec.publicKey), /不是 RSA 公钥/)
  assert.throws(() => sealText('x'.repeat(300 * 1024), keys.publicKey), /太长/)
})

test('the command line opens every sealed line in a saved run page with the private key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-feed-counts-'))
  try {
    const page = path.join(directory, 'run.md')
    const keyFile = path.join(directory, 'key.pem')
    fs.writeFileSync(page, `### 每天多少台（加密）\n\n\`\`\`text\n${sealText('第一段', keys.publicKey)}\n\`\`\`\n${sealText('第二段', keys.publicKey)}\n`)
    fs.writeFileSync(keyFile, keys.privateKey)
    assert.equal(execFileSync(process.execPath, [script, page, keyFile], { encoding: 'utf8' }), '第一段\n\n---\n\n第二段\n')

    fs.writeFileSync(page, '没有密文')
    assert.throws(() => execFileSync(process.execPath, [script, page, keyFile], { encoding: 'utf8', stdio: 'pipe' }), (error) => /没有台数的密文/.test(String(error.stderr)))
    assert.throws(() => execFileSync(process.execPath, [script, page], { encoding: 'utf8', stdio: 'pipe' }), (error) => /用法/.test(String(error.stderr)))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the committed public key is one this sealing accepts', () => {
  readPublicKey(fs.readFileSync(path.join(__dirname, 'update-feed-counts.pub.pem'), 'utf8'))
})

test('whatever the report says, it opens back unchanged with random inputs', () => {
  fc.assert(fc.property(fc.string({ maxLength: 2000 }), (text) => {
    assert.deepEqual(openSealedTexts(sealText(text, keys.publicKey), keys.privateKey), [text])
  }), { numRuns: 30 })
})
