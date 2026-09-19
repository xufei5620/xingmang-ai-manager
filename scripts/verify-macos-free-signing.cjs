const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { X509Certificate } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { SIGNING_TEAM_IDENTIFIER } = require('./create-macos-free-signing-certificate.cjs')

const OPENSSL_PATH = '/usr/bin/openssl'
const SECURITY_PATH = '/usr/bin/security'
const COMMAND_TIMEOUT_MS = 30_000
// P-22. Mirrors VALIDITY_DAYS in create-macos-free-signing-certificate.cjs,
// with a couple of days of slack for how OpenSSL rounds the notAfter it
// writes. Certificates minted before that cap existed ran for twenty years.
const MAX_VALIDITY_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

function fail(message) {
  throw new Error(message)
}

function normalizeFingerprint(value, label, byteLength = 32) {
  const input = String(value || '').trim()
  const plain = new RegExp(`^[A-Fa-f0-9]{${byteLength * 2}}$`)
  const colonSeparated = new RegExp(`^(?:[A-Fa-f0-9]{2}:){${byteLength - 1}}[A-Fa-f0-9]{2}$`)
  if (!plain.test(input) && !colonSeparated.test(input)) {
    const algorithm = byteLength === 32 ? 'SHA-256' : byteLength === 20 ? 'SHA-1' : `${byteLength * 8} 位`
    fail(`${label} 必须是有效的 ${algorithm} 指纹`)
  }
  return input.replaceAll(':', '').toUpperCase()
}

function fingerprintFromOpenSsl(output, algorithm, label, byteLength) {
  const match = new RegExp(`^${algorithm} Fingerprint=([^\\r\\n]+)\\s*$`, 'i').exec(String(output).trim())
  if (!match) fail(`无法读取${label}指纹`)
  return normalizeFingerprint(match[1], label, byteLength)
}

function defaultRunner(executable, env, run = spawnSync, timeoutMs = COMMAND_TIMEOUT_MS) {
  return (args) => {
    const result = run(executable, args, {
      encoding: 'utf8',
      env,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    })
    if (result.error) fail(`无法运行 ${executable}：${result.error.message}`)
    if (result.status !== 0) fail(`${executable} 命令失败：${result.stderr?.trim() || '未知错误'}`)
    return result.stdout
  }
}

function outputOf(runner, args) {
  const result = runner(args)
  if (typeof result === 'string') return result
  if (result && result.status === 0) return result.stdout || ''
  fail(`命令失败：${args.join(' ')}`)
}

function certificateField(output, name) {
  const match = new RegExp(`^${name}=(.+)$`, 'mi').exec(output)
  if (!match) fail(`无法读取证书 ${name}`)
  return match[1].trim()
}

/** Reads the values of a single critical X509v3 extension out of
 * `openssl x509 -text` output. Returns null unless the extension appears
 * exactly once and is marked critical: a second copy, or a non-critical one,
 * means the extension does not constrain the certificate the way the caller
 * is about to assume it does. */
function criticalExtensionValues(certificateText, extensionName) {
  const lines = String(certificateText).split(/\r?\n/)
  const headers = []
  const headerPattern = new RegExp(`^(\\s*)X509v3 ${extensionName}:\\s*(critical)?\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = headerPattern.exec(lines[index])
    if (match) headers.push({ index, indentation: match[1].length, critical: match[2] === 'critical' })
  }
  if (headers.length !== 1 || !headers[0].critical) return null

  const values = []
  const header = headers[0]
  for (let index = header.index + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indentation = /^\s*/.exec(line)[0].length
    if (indentation <= header.indentation) break
    values.push(...line.trim().split(',').map((value) => value.trim()).filter(Boolean))
  }
  return values
}

function hasExclusiveCriticalCodeSigningEku(certificateText) {
  const values = criticalExtensionValues(certificateText, 'Extended Key Usage')
  return values !== null && values.length === 1 &&
    /^(?:Code Signing|1\.3\.6\.1\.5\.5\.7\.3\.3)$/i.test(values[0])
}

/** P-22. The publisher marks this certificate trusted for code signing on the
 * release Mac, so a certificate that can also issue certificates turns a
 * stolen P12 into a trusted issuer on that machine: every certificate minted
 * from it would chain to an anchor the Mac already accepts. codesign never
 * needs the signing certificate to be a CA, so the release gate refuses one
 * outright rather than relying on the generator having produced the right
 * profile. */
function assertNonIssuingSigningCertificate(certificateText) {
  const basicConstraints = criticalExtensionValues(certificateText, 'Basic Constraints')
  if (basicConstraints === null || basicConstraints.length !== 1 ||
    !/^CA:FALSE$/i.test(basicConstraints[0])) {
    fail('证书必须带 critical 的 basicConstraints=CA:FALSE：发布签名证书不能是 CA，请用 npm run mac:free:create-certificate 重新生成')
  }
  const keyUsage = criticalExtensionValues(certificateText, 'Key Usage')
  if (keyUsage === null || !keyUsage.some((value) => /^Digital Signature$/i.test(value)) ||
    keyUsage.some((value) => /^(?:Certificate Sign|CRL Sign)$/i.test(value))) {
    fail('证书的 critical keyUsage 必须只授予签名用途，不能包含 Certificate Sign 或 CRL Sign，请重新生成证书')
  }
}

/** The hardened runtime's library validation compares the TeamIdentifier of a
 * process against every library it loads, and codesign takes that identifier
 * from the signing certificate's organizational unit. A certificate minted
 * before 2026-09-19 carries `/CN=` alone, so the identifier is unset and macOS
 * kills the packaged app while loading its own Electron framework -- a failure
 * no artifact check can see, because the signature itself is perfectly valid.
 * Refusing the certificate here is the only place the release gate can catch
 * it before a package that cannot start reaches anyone. */
function assertSigningCertificateTeamIdentifier(subject) {
  const values = String(subject).split(/[\/,]/)
    .map((part) => /^\s*OU\s*=\s*(.+?)\s*$/i.exec(part))
    .filter((match) => match !== null)
    .map((match) => match[1])
  if (values.length !== 1 || values[0] !== SIGNING_TEAM_IDENTIFIER) {
    fail(`证书必须带唯一的 OU=${SIGNING_TEAM_IDENTIFIER}，codesign 才会记录 team identifier；没有它，打出来的包会被 library validation 拦在启动之前，请用 npm run mac:free:create-certificate 重新生成证书`)
  }
}

/** P-22. `openssl verify -CAfile <cert> <cert>` used to stand in for "this
 * certificate really is self-signed", but it asks a chain-building question:
 * it will only accept a certificate as its own issuer when that certificate
 * may issue certificates. Now that the signing identity is deliberately a
 * non-issuing leaf, macOS's LibreSSL answers "unable to get local issuer
 * certificate" for a perfectly valid certificate. The question that matters
 * has no chain in it -- was this signature made by this certificate's own
 * key -- and Node answers it identically on every platform. */
function verifyCertificateSelfSignature(certificatePem) {
  const certificate = new X509Certificate(certificatePem)
  return certificate.verify(certificate.publicKey)
}

/**
 * Without `-v`, `find-identity` prints two sections — every matching identity,
 * then the valid ones — and only the first is read here. On a machine where the
 * identity is trusted it appears in both, and two entries for one identity is
 * exactly what the ambiguity check in the caller exists to refuse. The `-v`
 * form prints neither header, so its output passes through untouched.
 */
function selectMatchingIdentities(output) {
  const lines = String(output).split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*Matching identities\s*$/.test(line))
  if (start === -1) return output
  const end = lines.findIndex((line, index) => (
    index > start && /^\s*Valid identities only\s*$/.test(line)
  ))
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n')
}

function parseCodeSigningIdentities(output) {
  const entries = []
  for (const line of String(output).split(/\r?\n/)) {
    if (!/^\s*\d+\)/.test(line)) continue
    // The unfiltered listing appends the policy error to every entry it would
    // have filtered out, e.g. `"name" (CSSMERR_TP_NOT_TRUSTED)`. It is captured
    // rather than discarded: on the release path an annotated entry means the
    // `-v` filter did not do what that path relies on it to do.
    const match = /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"\r\n]*)"(?:\s+\(([A-Za-z0-9_]+)\))?\s*$/.exec(line)
    if (!match) fail('security 返回了无法解析的代码签名身份')
    entries.push({
      fingerprint: match[1].toUpperCase(),
      name: match[2],
      trustError: match[3] ?? null,
      raw: line,
    })
  }
  return entries
}

/**
 * `find-identity -v` keeps only the identities whose certificate passes policy
 * evaluation. On the release Mac this certificate passes it because its
 * publisher marked it trusted for code signing by hand — step 1 of
 * docs/MACOS_FREE_DISTRIBUTION.md — so there the filter is part of what is
 * being asserted. The CI rehearsal builds the same certificate in a throwaway
 * keychain and deliberately writes no Trust Settings, so there the filter would
 * hide the very identity codesign is pinned to, and the preflight could only be
 * stubbed out wholesale. Dropping it is the single difference between the two
 * runs; every certificate assertion stays identical.
 */
function buildCodeSigningIdentityQuery(trustedIdentitiesOnly) {
  return trustedIdentitiesOnly
    ? ['find-identity', '-v', '-p', 'codesigning']
    : ['find-identity', '-p', 'codesigning']
}

function verifyFreeMacSigningIdentity(options = {}) {
  const env = options.env || process.env
  const trustedIdentitiesOnly = options.trustedIdentitiesOnly !== false
  const identityName = (options.identityName ?? env.CSC_NAME ?? '').trim()
  if (!identityName) fail('缺少 CSC_NAME：必须指定免费发布签名身份')
  const expectedFingerprint = normalizeFingerprint(
    options.expectedFingerprint ?? env.XINGMANG_MAC_SIGNING_SHA256,
    'XINGMANG_MAC_SIGNING_SHA256',
  )
  const runSecurity = options.runSecurity || defaultRunner(
    SECURITY_PATH,
    env,
    options.spawnSync,
    options.timeoutMs,
  )
  const runOpenSsl = options.runOpenSsl || defaultRunner(
    OPENSSL_PATH,
    env,
    options.spawnSync,
    options.timeoutMs,
  )
  const verifySelfSignature = options.verifySelfSignature || verifyCertificateSelfSignature
  const now = options.now || new Date()
  const certificatePem = outputOf(runSecurity, ['find-certificate', '-c', identityName, '-p'])
  if (!certificatePem.includes('BEGIN CERTIFICATE')) fail('找不到 CSC_NAME 对应的证书')

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-preflight-'))
  const certificatePath = path.join(temporaryDirectory, 'certificate.pem')
  fs.writeFileSync(certificatePath, certificatePem, { mode: 0o600 })
  try {
    const fingerprint = fingerprintFromOpenSsl(outputOf(runOpenSsl, [
      'x509', '-in', certificatePath, '-noout', '-fingerprint', '-sha256',
    ]), 'SHA256', '证书 SHA-256', 32)
    if (fingerprint !== expectedFingerprint) fail('证书指纹与 XINGMANG_MAC_SIGNING_SHA256 不一致')

    const subjectIssuer = outputOf(runOpenSsl, ['x509', '-in', certificatePath, '-noout', '-subject', '-issuer'])
    if (certificateField(subjectIssuer, 'subject').replace(/\s+/g, '') !==
      certificateField(subjectIssuer, 'issuer').replace(/\s+/g, '')) {
      fail('证书不是自签名证书')
    }
    if (!verifySelfSignature(certificatePem)) fail('证书自签名验证失败：签名不是由证书自身的密钥签出的')
    assertSigningCertificateTeamIdentifier(certificateField(subjectIssuer, 'subject'))

    const dates = outputOf(runOpenSsl, ['x509', '-in', certificatePath, '-noout', '-startdate', '-enddate'])
    const notBefore = new Date(certificateField(dates, 'notBefore'))
    const notAfter = new Date(certificateField(dates, 'notAfter'))
    if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) fail('证书有效期格式无效')
    if (notBefore > now) fail('证书尚未生效')
    if (notAfter <= now) fail('证书已经过期')
    if (notAfter.getTime() - notBefore.getTime() > (MAX_VALIDITY_DAYS + 2) * DAY_MS) {
      fail(`证书有效期不能超过 ${MAX_VALIDITY_DAYS} 天，请用 npm run mac:free:create-certificate 重新生成`)
    }

    const text = outputOf(runOpenSsl, ['x509', '-in', certificatePath, '-noout', '-text'])
    if (!hasExclusiveCriticalCodeSigningEku(text)) {
      fail('证书必须仅包含 critical codeSigning EKU')
    }
    assertNonIssuingSigningCertificate(text)

    const sha1 = fingerprintFromOpenSsl(outputOf(runOpenSsl, [
      'x509', '-in', certificatePath, '-noout', '-fingerprint', '-sha1',
    ]), 'SHA1', '证书 SHA-1', 20)
    const identities = outputOf(runSecurity, buildCodeSigningIdentityQuery(trustedIdentitiesOnly))
    const builderSelectable = parseCodeSigningIdentities(selectMatchingIdentities(identities))
      .filter((identity) => identity.raw.includes(identityName))
    if (builderSelectable.length !== 1) {
      fail('CSC_NAME 对应的代码签名私钥身份不存在或存在选择歧义')
    }
    if (builderSelectable[0].name !== identityName) {
      fail('security 中没有名称与 CSC_NAME 精确相等的代码签名身份')
    }
    if (builderSelectable[0].fingerprint !== sha1) {
      fail('CSC_NAME 对应的私钥身份与已检查证书不一致')
    }
    // `-v` cannot list an identity the code-signing policy rejects, so an entry
    // carrying a trust error on the release path means that filter did not hold.
    if (trustedIdentitiesOnly && builderSelectable[0].trustError) {
      fail('security 返回的代码签名身份带有信任错误')
    }
    return { identityName, fingerprint }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function main() {
  const result = verifyFreeMacSigningIdentity()
  console.log(`macOS 免费发布签名身份验证通过：${result.identityName} (${result.fingerprint})`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`macOS 免费发布签名身份验证失败：${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  assertNonIssuingSigningCertificate,
  assertSigningCertificateTeamIdentifier,
  verifyCertificateSelfSignature,
  verifyFreeMacSigningIdentity,
}
