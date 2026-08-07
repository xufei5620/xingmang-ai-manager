const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const OPENSSL_PATH = '/usr/bin/openssl'
const SECURITY_PATH = '/usr/bin/security'

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

function defaultRunner(executable, env, run = spawnSync) {
  return (args) => {
    const result = run(executable, args, { encoding: 'utf8', env, shell: false, windowsHide: true })
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

function hasExclusiveCriticalCodeSigningEku(certificateText) {
  const lines = String(certificateText).split(/\r?\n/)
  const headers = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)X509v3 Extended Key Usage:\s*(critical)?\s*$/.exec(lines[index])
    if (match) headers.push({ index, indentation: match[1].length, critical: match[2] === 'critical' })
  }
  if (headers.length !== 1 || !headers[0].critical) return false

  const values = []
  const header = headers[0]
  for (let index = header.index + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indentation = /^\s*/.exec(line)[0].length
    if (indentation <= header.indentation) break
    values.push(...line.trim().split(',').map((value) => value.trim()).filter(Boolean))
  }
  return values.length === 1 && /^(?:Code Signing|1\.3\.6\.1\.5\.5\.7\.3\.3)$/i.test(values[0])
}

function parseCodeSigningIdentities(output) {
  const entries = []
  for (const line of String(output).split(/\r?\n/)) {
    if (!/^\s*\d+\)/.test(line)) continue
    const match = /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"\r\n]*)"\s*$/.exec(line)
    if (!match) fail('security 返回了无法解析的代码签名身份')
    entries.push({ fingerprint: match[1].toUpperCase(), name: match[2], raw: line })
  }
  return entries
}

function verifyFreeMacSigningIdentity(options = {}) {
  const env = options.env || process.env
  const identityName = (options.identityName ?? env.CSC_NAME ?? '').trim()
  if (!identityName) fail('缺少 CSC_NAME：必须指定免费发布签名身份')
  const expectedFingerprint = normalizeFingerprint(
    options.expectedFingerprint ?? env.XINGMANG_MAC_SIGNING_SHA256,
    'XINGMANG_MAC_SIGNING_SHA256',
  )
  const runSecurity = options.runSecurity || defaultRunner(SECURITY_PATH, env, options.spawnSync)
  const runOpenSsl = options.runOpenSsl || defaultRunner(OPENSSL_PATH, env, options.spawnSync)
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
    outputOf(runOpenSsl, ['verify', '-check_ss_sig', '-CAfile', certificatePath, certificatePath])

    const dates = outputOf(runOpenSsl, ['x509', '-in', certificatePath, '-noout', '-startdate', '-enddate'])
    const notBefore = new Date(certificateField(dates, 'notBefore'))
    const notAfter = new Date(certificateField(dates, 'notAfter'))
    if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) fail('证书有效期格式无效')
    if (notBefore > now) fail('证书尚未生效')
    if (notAfter <= now) fail('证书已经过期')

    const text = outputOf(runOpenSsl, ['x509', '-in', certificatePath, '-noout', '-text'])
    if (!hasExclusiveCriticalCodeSigningEku(text)) {
      fail('证书必须仅包含 critical codeSigning EKU')
    }

    const sha1 = fingerprintFromOpenSsl(outputOf(runOpenSsl, [
      'x509', '-in', certificatePath, '-noout', '-fingerprint', '-sha1',
    ]), 'SHA1', '证书 SHA-1', 20)
    const identities = outputOf(runSecurity, ['find-identity', '-v', '-p', 'codesigning'])
    const builderSelectable = parseCodeSigningIdentities(identities)
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

module.exports = { verifyFreeMacSigningIdentity }
