// 已发布的 macOS 免费分发签名身份台账。
//
// Squirrel.Mac validates a candidate update against the designated requirement
// of the app already installed, and this project's designated requirement pins
// the leaf certificate's SHA-1 (see parseDesignatedRequirement in
// verify-macos-free-artifacts.cjs). A release signed by any other certificate
// is therefore refused by every Mac that already runs this app, and the only
// way back is a manual reinstall by each customer. Nothing used to compare a
// release against the identity the previous release shipped with: the expected
// fingerprint came from XINGMANG_MAC_SIGNING_SHA256, which the publisher types
// at release time, so one wrong export would have passed every gate and broken
// automatic updates for every macOS customer at once. The fingerprint recorded
// here is what the gates compare against.
//
// 指纹不是秘密，证书的公开部分算出来的哈希而已；私钥永远不进仓库。
const PUBLISHED_CERTIFICATE_SHA256 = ''

// 2026-09-20 产品所有者拍板：继续使用这张已发布的自签证书，不轮换。
//
// This certificate predates the profile the current generator produces: it runs
// for twenty years, is CA:TRUE with pathlen:0, and its keyUsage carries
// keyCertSign. Those three properties are exactly what the release preflight
// refuses (P-22), because the publisher marks this certificate trusted for code
// signing on the release Mac, so whoever holds its P12 can mint further
// certificates that chain to an anchor that Mac already accepts.
//
// 这是有意接受的风险，换来的是已装 Mac 客户的自动更新不中断。CA:TRUE 与
// keyCertSign 是同一个缺陷的两半（一张能签发下级证书的证书），不可能只放宽其中
// 一条，所以豁免覆盖这两条加上 3650 天有效期上限，其余检查一条都不放松。
// 换证书那天把这一行清空，预检自动恢复到严格口径。
const LEGACY_PROFILE_EXEMPT_CERTIFICATE_SHA256 = ''

// 旧生成器签发的有效期：20 年。豁免只放宽到这个上限，不是取消上限。
const LEGACY_PROFILE_MAX_VALIDITY_DAYS = 7300

// 指纹是人从 openssl 或 security 的输出里复制过来的，所以三种写法都认：
// 64 位连写、`AB:CD:...` 冒号分隔，以及直接整行粘贴的 `SHA256 Fingerprint=AB:CD:...`。
// 大小写不限。认不出来的写法一律报错，不猜。
function normalizeCertificateSha256(value, label) {
  const input = String(value ?? '').trim().replace(/^sha-?256\s+fingerprint\s*=\s*/i, '')
  if (!input) return null
  const compact = input.replace(/[\s:]/g, '')
  if (!/^[A-Fa-f0-9]{64}$/.test(compact)) {
    throw new Error(`${label} 必须是有效的 SHA-256 指纹：64 位十六进制，可带冒号分隔`)
  }
  return compact.toUpperCase()
}

/** 仓库里记着的已发布签名证书指纹；还没登记时返回 null。 */
function publishedSigningCertificateSha256() {
  return normalizeCertificateSha256(PUBLISHED_CERTIFICATE_SHA256, '已发布签名证书指纹')
}

function legacyProfileExemptCertificateSha256() {
  return normalizeCertificateSha256(
    LEGACY_PROFILE_EXEMPT_CERTIFICATE_SHA256,
    '旧证书豁免指纹',
  )
}

/**
 * 跨版本连续性核对：本次发布用的证书必须就是已发布的那一张。
 * 台账为空时不拦（第一次登记之前保持原有行为），发布前必须登记。
 */
function assertPublishedSigningCertificate(fingerprint, label) {
  const expected = publishedSigningCertificateSha256()
  if (expected === null) return null
  const actual = normalizeCertificateSha256(fingerprint, label)
  if (actual === null || actual !== expected) {
    throw new Error(
      `${label}与仓库登记的已发布签名证书不一致：换证书会让所有已装 macOS 客户的自动更新失败、`
      + '只能手动重装。确认要换证书再更新 scripts/macos-published-signing-identity.cjs 的台账，'
      + '口径见 docs/RELEASING.md',
    )
  }
  return actual
}

/** 这张证书是否被登记为「沿用的旧 profile」，可以带 CA:TRUE、keyCertSign 与 20 年有效期。 */
function isLegacyProfileExemptCertificate(fingerprint) {
  const exempt = legacyProfileExemptCertificateSha256()
  if (exempt === null) return false
  const actual = normalizeCertificateSha256(fingerprint, '证书指纹')
  return actual !== null && actual === exempt
}

module.exports = {
  LEGACY_PROFILE_MAX_VALIDITY_DAYS,
  assertPublishedSigningCertificate,
  isLegacyProfileExemptCertificate,
  legacyProfileExemptCertificateSha256,
  normalizeCertificateSha256,
  publishedSigningCertificateSha256,
}
