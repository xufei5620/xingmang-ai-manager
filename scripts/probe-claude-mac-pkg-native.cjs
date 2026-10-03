const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const common = require('./cos-sync-utils.cjs')
const claude = require('./sync-claude-official-cos.cjs')
const { safePublicText } = require('./probe-claude-mac-dmg-native.cjs')

const SOURCE_URL = 'https://downloads.claude.ai/releases/darwin/universal/2.19675.0/Claude-5706e5524dba58b23e105c31c358df8ab0a95852.pkg'
const EXPECTED_BYTES = 384935158
const EXPECTED_SHA256 = '5c8d7ec0fc49121d29bf80ea08b754b1ce486afd695fec157de97de8dbef080e'
const PROOF_DIRECTORY = 'xingmang-claude-mac-pkg-native-proof-results'

async function main() {
  const outputDirectory = path.join(await fs.realpath(process.env.RUNNER_TEMP || os.tmpdir()), PROOF_DIRECTORY)
  await fs.mkdir(outputDirectory, { mode: 0o700 })
  const nativeRun = promisify(execFile)
  const dependencies = claude.createRuntimeDependencies(common)
  const source = claude.SOURCES['macos-pkg-universal']
  const report = { checkedAt: new Date().toISOString(), product: 'claude-desktop', platformId: 'macos-pkg-universal',
    sourceUrl: SOURCE_URL, expectedBytes: EXPECTED_BYTES, expectedSha256: EXPECTED_SHA256,
    ok: false, phase: 'setup', packageExecuted: false, packageInstalled: false, cosReadOrWrite: false, nativeCommands: [] }
  let directory
  async function inspectPayloadMetadata(filePath, options) {
    const expanded = path.join(directory, 'public-pkg-expanded-full')
    report.nativeCommands.push({ command: 'pkgutil', operation: 'expand-full-read-only' })
    await nativeRun('/usr/sbin/pkgutil', ['--expand-full', filePath, expanded], options)
    const canonicalRoot = await fs.realpath(expanded)
    const applications = []
    const packageInfo = []
    let visited = 0
    async function boundedPath(candidate) {
      const canonical = await fs.realpath(candidate)
      if (!canonical.startsWith(canonicalRoot + path.sep)) throw new Error('PKG 元数据路径越出私有展开目录')
      const stat = await fs.lstat(canonical)
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('PKG 元数据或 Mach-O 不是单链接普通文件')
      return canonical
    }
    async function visit(current, depth = 0) {
      if (depth > 8 || ++visited > 2048) throw new Error('PKG 元数据目录超过上限')
      const entries = await fs.readdir(current, { withFileTypes: true })
      if (entries.length > 2048) throw new Error('PKG 元数据目录项超过上限')
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const child = path.join(current, entry.name)
        if (entry.isDirectory() && entry.name === 'Claude.app') {
          const infoPath = await boundedPath(path.join(child, 'Contents', 'Info.plist'))
          report.nativeCommands.push({ command: 'plutil', operation: 'payload-bundle-metadata' })
          const metadata = await nativeRun('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], options)
          const info = JSON.parse(metadata.stdout)
          if (typeof info.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9._-]+$/.test(info.CFBundleExecutable)) throw new Error('PKG 应用可执行文件名无效')
          const executable = await boundedPath(path.join(child, 'Contents', 'MacOS', info.CFBundleExecutable))
          report.nativeCommands.push({ command: 'lipo', operation: 'payload-mach-o-archs' })
          const architecture = await nativeRun('/usr/bin/lipo', ['-archs', executable], options)
          applications.push({ identifier: safePublicText(info.CFBundleIdentifier), shortVersion: safePublicText(info.CFBundleShortVersionString),
            buildVersion: safePublicText(info.CFBundleVersion), architectures: architecture.stdout.trim().split(/\s+/).filter(value => /^[A-Za-z0-9_+-]{1,32}$/.test(value)).slice(0, 8), trustedByPublisher: false })
        } else if (entry.isDirectory()) await visit(child, depth + 1)
        else if (entry.name === 'PackageInfo') {
          const text = (await common.readBoundedRegularFile(await boundedPath(child), { maxBytes: 256 * 1024 })).toString('utf8')
          if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('PKG PackageInfo XML 不允许 DTD')
          packageInfo.push({ identifier: safePublicText(/<pkg-info\b[^>]*\bidentifier="([^"]+)"/.exec(text)?.[1]),
            version: safePublicText(/<pkg-info\b[^>]*\bversion="([^"]+)"/.exec(text)?.[1]), trustedByPublisher: false })
        }
      }
    }
    await visit(expanded)
    report.payloadMetadataCandidate = { applications, packageInfo, architectureProofSource: 'actual-payload-mach-o-lipo', trustedByPublisher: false }
  }
  async function observedRun(executable, args, options) {
    report.nativeCommands.push({ command: path.basename(executable), operation: args[0] })
    const result = await nativeRun(executable, args, options)
    if (executable === '/usr/sbin/pkgutil' && args[0] === '--check-signature') {
      const status = /^\s*Status:\s*([^\r\n]+)$/m.exec(result.stdout)?.[1]
      const certificates = [...result.stdout.matchAll(/^\s*\d+\.\s*([^\r\n]+)$/gm)].map(match => safePublicText(match[1])).filter(Boolean).slice(0, 8)
      report.signatureMetadataCandidate = { nativeTrustStatus: safePublicText(status), certificateNames: certificates, trustedByPublisher: false }
      if (status === 'signed by a certificate trusted by macOS' || status === 'signed by a developer certificate issued by Apple for distribution') {
        try { await inspectPayloadMetadata(args[1], options) } catch { report.payloadMetadataUnavailable = true }
      }
    }
    return result
  }
  try {
    if (process.platform !== 'darwin') throw new Error('PKG 只读验证需要原生 macOS')
    claude.validateOfficialUrl(SOURCE_URL)
    report.phase = 'head'
    const head = claude.validateHead(await common.inspectResource({ url: SOURCE_URL, allowedHosts: ['downloads.claude.ai'], maxBytes: claude.MAX_PACKAGE_BYTES }, { headerTimeoutMs: 30000, bodyTimeoutMs: 30000 }))
    if (head.bytes !== EXPECTED_BYTES) throw new Error('PKG HEAD 与正常官方浏览器下载大小不一致')
    report.head = { bytes: head.bytes, etag: head.etag, sizeMatched: true }
    directory = await dependencies.createWorkDirectory()
    const filePath = path.join(directory, 'Claude-verified-universal.pkg')
    report.phase = 'download'
    const downloaded = await common.downloadResource({ url: SOURCE_URL, filePath, allowedHosts: ['downloads.claude.ai'], maxBytes: claude.MAX_PACKAGE_BYTES,
      expectedBytes: EXPECTED_BYTES, expectedSha256: EXPECTED_SHA256, expectedEtag: head.etag }, { headerTimeoutMs: 30000, bodyTimeoutMs: 20 * 60 * 1000 })
    report.download = { bytes: downloaded.bytes, sha256: downloaded.sha256, digestMatched: true }
    await claude.validatePackageMagic(filePath, 'pkg', downloaded.bytes)
    report.magic = 'xar!'
    report.phase = 'native-inspection'
    const inspected = await claude.inspectPackage({ filePath, source, workDirectory: directory, run: observedRun })
    const validated = claude.validateInspection(inspected, source)
    if (validated.architectureProof === 'official-universal-endpoint') throw new Error('URL 标签不是实际架构验收，必须修复生产 PKG Mach-O 校验')
    report.inspection = validated
    report.ok = true
  } catch (error) {
    report.failure = { code: error?.message === 'Claude Mac PKG 官方安装者签名或可信链无效' ? 'installer-authority-unrecognized' : 'verification-failed',
      ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) }
  } finally {
    if (directory) {
      try { await dependencies.removeWorkDirectory(directory); report.cleanup = 'verified-temp-directory-removed' } catch { report.cleanup = 'failed'; report.ok = false }
    }
    await fs.writeFile(path.join(outputDirectory, 'claude-mac-pkg-native-proof.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify(report))
    if (!report.ok) process.exitCode = 1
  }
}

if (require.main === module) main().catch(function () { console.error('PKG 原生只读探测未完成，未输出原始异常或认证信息'); process.exitCode = 1 })

module.exports = { SOURCE_URL, EXPECTED_BYTES, EXPECTED_SHA256, PROOF_DIRECTORY, main }
