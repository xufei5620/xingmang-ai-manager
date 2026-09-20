const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  LEGACY_PROFILE_MAX_VALIDITY_DAYS,
  assertPublishedSigningCertificate,
  createRehearsalSigningLedger,
  isLegacyProfileExemptCertificate,
  legacyProfileExemptCertificateSha256,
  normalizeCertificateSha256,
  publishedSigningCertificateSha256,
} = require('./macos-published-signing-identity.cjs')

const LEDGER_SOURCE = fs.readFileSync(
  path.join(__dirname, 'macos-published-signing-identity.cjs'),
  'utf8',
)

test('the ledger accepts both fingerprint spellings and refuses anything else', () => {
  const plain = 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899'
  const colonSeparated = plain.match(/../g).join(':')
  assert.equal(normalizeCertificateSha256(colonSeparated.toLowerCase(), '指纹'), plain)
  assert.equal(normalizeCertificateSha256(plain, '指纹'), plain)
  // 直接把命令输出整行粘进来也认：这是最可能的填写方式。
  assert.equal(normalizeCertificateSha256(`SHA256 Fingerprint=${colonSeparated}`, '指纹'), plain)
  assert.equal(normalizeCertificateSha256(`  sha256 Fingerprint = ${plain.toLowerCase()}\n`, '指纹'), plain)
  assert.equal(normalizeCertificateSha256('', '指纹'), null)
  assert.equal(normalizeCertificateSha256(undefined, '指纹'), null)
  for (const invalid of ['abc', `${plain}AA`, plain.slice(0, 63), '11:22:33', `SHA1 Fingerprint=${plain}`]) {
    assert.throws(() => normalizeCertificateSha256(invalid, '指纹'), /SHA-256 指纹/)
  }
})

test('an unrecorded ledger keeps the previous behaviour instead of blocking every release', () => {
  // 台账为空 = 还没登记过已发布身份。这时不拦，但发布 macOS 正式版之前必须登记，
  // 口径写在 docs/RELEASING.md。
  if (publishedSigningCertificateSha256() !== null) return
  assert.equal(assertPublishedSigningCertificate('AA'.repeat(32), '证书'), null)
  assert.equal(isLegacyProfileExemptCertificate('AA'.repeat(32)), false)
})

test('a recorded ledger refuses any certificate other than the published one', () => {
  const published = publishedSigningCertificateSha256()
  if (published === null) return
  assert.equal(assertPublishedSigningCertificate(published, '证书'), published)
  const other = published.startsWith('A') ? `B${published.slice(1)}` : `A${published.slice(1)}`
  assert.throws(() => assertPublishedSigningCertificate(other, '本次发布使用的签名证书'), /不一致/)
  assert.throws(() => assertPublishedSigningCertificate('', '本次发布使用的签名证书'), /不一致/)
})

test('the legacy profile exemption may only ever name the published certificate', () => {
  // 豁免让一张 CA 证书继续签发布包，所以它不能指向台账以外的任何证书；
  // 换证书那天清空豁免，严格口径自动恢复。
  const exempt = legacyProfileExemptCertificateSha256()
  if (exempt === null) {
    assert.equal(isLegacyProfileExemptCertificate('AA'.repeat(32)), false)
    return
  }
  assert.equal(exempt, publishedSigningCertificateSha256())
  assert.equal(isLegacyProfileExemptCertificate(exempt), true)
  assert.equal(isLegacyProfileExemptCertificate(exempt.match(/../g).join(':').toLowerCase()), true)
  assert.equal(isLegacyProfileExemptCertificate('AA'.repeat(32)), false)
})

test('the ledger never carries private key material', () => {
  assert.equal(/BEGIN [A-Z ]*PRIVATE KEY|-----BEGIN PKCS|P12_PASSWORD/.test(LEDGER_SOURCE), false)
})

test('the legacy validity cap matches the profile the old generator produced', () => {
  assert.equal(LEGACY_PROFILE_MAX_VALIDITY_DAYS, 7300)
})

test('the rehearsal ledger only ever stands in for a throwaway certificate', () => {
  const rehearsal = 'AB'.repeat(32)
  const ledger = createRehearsalSigningLedger(rehearsal)

  assert.equal(ledger.assertPublishedIdentity(rehearsal, '本次发布使用的签名证书'), rehearsal)
  // 一次性证书刻意按已发布那张的 profile 生成，所以豁免判定也要跟着换过去，
  // 否则排练会红在 P-22 上——而那恰恰是已发布证书被明确豁免掉的一条。
  assert.equal(ledger.isLegacyProfileExempt(rehearsal), true)
  assert.equal(ledger.isLegacyProfileExempt(rehearsal.match(/../g).join(':').toLowerCase()), true)
  assert.equal(ledger.isLegacyProfileExempt('CD'.repeat(32)), false)
  assert.throws(() => ledger.assertPublishedIdentity('CD'.repeat(32), '本次发布使用的签名证书'), /不一致/)

  // 这不是「关掉连续性核对」的开关：把真指纹传进来的唯一用处就是绕过那道核对。
  const published = publishedSigningCertificateSha256()
  if (published !== null) {
    assert.throws(() => createRehearsalSigningLedger(published), /不能指向已发布的那张证书/)
    assert.throws(
      () => createRehearsalSigningLedger(published.match(/../g).join(':').toLowerCase()),
      /不能指向已发布的那张证书/,
    )
  }
  assert.throws(() => createRehearsalSigningLedger(''), /不能为空/)
  assert.throws(() => createRehearsalSigningLedger('not-a-fingerprint'), /SHA-256/)
})
