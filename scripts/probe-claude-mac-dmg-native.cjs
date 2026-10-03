const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { X509Certificate } = require('node:crypto')
const common = require('./cos-sync-utils.cjs')
const claude = require('./sync-claude-official-cos.cjs')

const SOURCE_URL = 'https://downloads.claude.ai/releases/darwin/universal/2.19675.0/Claude-5706e5524dba58b23e105c31c358df8ab0a95852.dmg'
const EXPECTED_BYTES = 377037896
const EXPECTED_SHA256 = 'c0e6e512c5913e20567cdbfad33f8622e69ab39a2a9886bf2a752b2ab06455cb'
const PROOF_DIRECTORY = 'xingmang-claude-mac-native-proof-results'
const MAX_BYTES = 2 * 1024 * 1024 * 1024

function safeFailure(error) {
  return { code: error?.preserveWorkDirectory === true ? 'mount-state-unconfirmed'
    : error?.message === 'Claude Mac 签名 Team 候选缺失或存在歧义' ? 'signature-authority-unrecognized' : 'verification-failed',
    ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) }
}

function safePublicText(value, maximumBytes = 512) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximumBytes
    || /[\0-\x08\x0b-\x1f\x7f]|\bBearer\s|(?:api[_-]?key|access_token|token)=|sk-[A-Za-z0-9]|https?:\/\/|\/private\/|\/Users\/|\/var\/|[A-Za-z]:\\/i.test(value)) return undefined
  return value
}

async function main() {
  const started = performance.now()
  const nativeRun = promisify(execFile)
  const source = claude.SOURCES['macos-dmg-universal']
  const dependencies = claude.createRuntimeDependencies(common)
  const outputRoot = await fs.realpath(process.env.RUNNER_TEMP || os.tmpdir())
  const outputDirectory = path.join(outputRoot, PROOF_DIRECTORY)
  await fs.mkdir(outputDirectory, { mode: 0o700 })
  const report = { checkedAt: new Date().toISOString(), product: 'claude-desktop', platformId: 'macos-dmg-universal',
    sourceUrl: SOURCE_URL, expectedBytes: EXPECTED_BYTES, expectedSha256: EXPECTED_SHA256,
    platform: process.platform, phase: 'setup', ok: false, packageExecuted: false, packageInstalled: false,
    cosReadOrWrite: false, nativeCommands: [], workDirectoryPreserved: false }
  let directory
  let primaryError
  let authorityTeam
  let nativeRequirementVerified = false
  let bundleMetadata
  async function collectSignerMetadata(application, options) {
    // Certificate subjects and architecture are public observations only.
    // They never substitute for the publisher's unchanged --verify predicate.
    if (bundleMetadata && /^[A-Za-z0-9._-]+$/.test(bundleMetadata.CFBundleExecutable || '')) {
      try {
        report.nativeCommands.push({ command: 'lipo', operation: 'metadata-archs' })
        const result = await nativeRun('/usr/bin/lipo', ['-archs', path.join(application, 'Contents', 'MacOS', bundleMetadata.CFBundleExecutable)], options)
        report.architecturesCandidate = result.stdout.trim().split(/\s+/).filter(value => /^[A-Za-z0-9_+-]{1,32}$/.test(value)).slice(0, 8)
      } catch { report.architectureMetadataUnavailable = true }
    }
    try {
      const prefix = path.join(directory, 'claude-public-cert-')
      report.nativeCommands.push({ command: 'codesign', operation: 'extract-public-certificates' })
      await nativeRun('/usr/bin/codesign', ['--display', `--extract-certificates=${prefix}`, application], options)
      const certificates = []
      for (let index = 0; index < 4; index += 1) {
        let bytes
        try { bytes = await common.readBoundedRegularFile(`${prefix}${index}`, { maxBytes: 64 * 1024 }) } catch { break }
        const certificate = new X509Certificate(bytes)
        certificates.push({ index, subject: safePublicText(certificate.subject, 2048), issuer: safePublicText(certificate.issuer, 2048),
          ca: certificate.ca, validFrom: safePublicText(certificate.validFrom), validTo: safePublicText(certificate.validTo), trustedByPublisher: false })
      }
      report.publicCertificateMetadata = certificates
    } catch { report.certificateMetadataUnavailable = true }
  }
  async function observedRun(executable, args, options) {
    const operation = executable === '/usr/bin/codesign' ? args[0]
      : executable === '/usr/bin/hdiutil' ? args[0]
        : executable === '/usr/bin/lipo' ? 'archs' : 'metadata'
    report.nativeCommands.push({ command: path.basename(executable), operation })
    // Forward the publisher's exact argv, timeouts, response limits and clean
    // environment to real native programs. This observer never supplies results.
    let result
    try { result = await nativeRun(executable, args, options) } catch (error) {
      report.nativeFailure = { command: path.basename(executable), operation,
        ...(Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? { exitCode: error.code } : {}),
        ...(['SIGTERM', 'SIGKILL'].includes(error?.signal) ? { signal: error.signal } : {}) }
      throw error
    }
    if (executable === '/usr/bin/plutil' && args.at(-1)?.endsWith('/Contents/Info.plist')) {
      bundleMetadata = JSON.parse(result.stdout)
      report.bundleMetadataCandidate = { identifier: safePublicText(bundleMetadata.CFBundleIdentifier),
        shortVersion: safePublicText(bundleMetadata.CFBundleShortVersionString), buildVersion: safePublicText(bundleMetadata.CFBundleVersion), trustedByPublisher: false }
    }
    if (executable === '/usr/bin/codesign' && args[0] === '--display') {
      const matches = [...result.stderr.matchAll(/^Authority=Developer ID Application: Anthropic, PBC \(([A-Z0-9]{10})\)$/gm)]
      if (matches.length === 1) authorityTeam = matches[0][1]
      const authority = [...result.stderr.matchAll(/^Authority=([^\r\n]+)$/gm)].map(match => safePublicText(match[1])).filter(Boolean).slice(0, 16)
      const identifier = /^Identifier=([^\r\n]+)$/m.exec(result.stderr)?.[1]
      const team = /^TeamIdentifier=([^\r\n]+)$/m.exec(result.stderr)?.[1]
      const signature = /^Signature=([^\r\n]+)$/m.exec(result.stderr)?.[1]
      report.signatureMetadataCandidate = { identifier: safePublicText(identifier), teamIdentifier: safePublicText(team), authority,
        signatureType: signature ? safePublicText(signature) : authority.length ? 'cms-signed-candidate' : 'unclassified',
        existingAuthorityPredicateMatches: matches.length, trustedByPublisher: false }
      await collectSignerMetadata(args.at(-1), options)
    }
    if (executable === '/usr/bin/codesign' && args[0] === '--verify' && authorityTeam
      && args.includes(`-R=${claude.darwinClaudeRequirement(authorityTeam)}`)) nativeRequirementVerified = true
    return result
  }
  try {
    if (process.platform !== 'darwin') throw new Error('此只读验证需要原生 macOS runner')
    claude.validateOfficialUrl(SOURCE_URL)
    report.phase = 'head'
    const head = claude.validateHead(await common.inspectResource({ url: SOURCE_URL, allowedHosts: ['downloads.claude.ai'], maxBytes: MAX_BYTES }, { headerTimeoutMs: 30000, bodyTimeoutMs: 30000 }))
    if (head.bytes !== EXPECTED_BYTES) throw new Error('已核实 DMG 大小与 CDN HEAD 不一致，停止下载')
    report.head = { bytes: head.bytes, etag: head.etag, sizeMatched: true }
    directory = await dependencies.createWorkDirectory()
    const filePath = path.join(directory, 'Claude-verified-universal.dmg')
    report.phase = 'download'
    const downloaded = await common.downloadResource({ url: SOURCE_URL, filePath, allowedHosts: ['downloads.claude.ai'], maxBytes: MAX_BYTES,
      expectedBytes: EXPECTED_BYTES, expectedSha256: EXPECTED_SHA256, expectedEtag: head.etag }, { headerTimeoutMs: 30000, bodyTimeoutMs: 20 * 60 * 1000 })
    report.download = { bytes: downloaded.bytes, sha256: downloaded.sha256, digestMatched: true }
    report.phase = 'magic'
    await claude.validatePackageMagic(filePath, 'dmg', downloaded.bytes)
    report.magic = 'koly'
    report.phase = 'native-inspection'
    const inspected = await claude.inspectPackage({ filePath, source, workDirectory: directory, run: observedRun })
    const validated = claude.validateInspection(inspected, source)
    if (!authorityTeam || !nativeRequirementVerified) throw new Error('原生签名 Team 和完整 Apple 证书要求未得到验证')
    report.inspection = { ...validated, bundleIdentifier: inspected.bundleIdentifier,
      signerOrganization: inspected.signerOrganization, teamIdentifier: authorityTeam,
      appleRequirementVerified: true, detachAndIndependentMountCheckPassed: true }
    report.ok = true
    report.phase = 'complete'
  } catch (error) {
    primaryError = error
    report.failure = safeFailure(error)
    report.workDirectoryPreserved = error?.preserveWorkDirectory === true
  } finally {
    if (directory && !report.workDirectoryPreserved) {
      try { await dependencies.removeWorkDirectory(directory); report.cleanup = 'verified-temp-directory-removed' } catch (error) {
        report.cleanup = 'failed'
        if (!primaryError) { report.ok = false; report.phase = 'cleanup'; report.failure = safeFailure(error) }
      }
    }
    report.elapsedMs = Math.round(performance.now() - started)
    await fs.writeFile(path.join(outputDirectory, 'claude-mac-native-proof.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify(report))
    if (!report.ok) process.exitCode = 1
  }
}

if (require.main === module) main().catch(function () { console.error('Mac 原生只读验证未完成，未输出原始异常或认证信息'); process.exitCode = 1 })

module.exports = { SOURCE_URL, EXPECTED_BYTES, EXPECTED_SHA256, PROOF_DIRECTORY, MAX_BYTES, safePublicText, main }
