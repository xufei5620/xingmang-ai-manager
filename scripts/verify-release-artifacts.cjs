const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parseDn } = require('builder-util-runtime')
const {
  validateLocalRelease,
  validateReleaseEnvironment,
} = require('./update-release-utils.cjs')
const { resolveTrustedWindowsPowerShell } = require('./windows-machine-paths.cjs')
const packageVersion = require('../package.json').version

// Mirrors electron/update-signature.ts so the release gate accepts exactly the
// publisher forms the runtime verifier accepts.
function normalizedDn(value) {
  const result = new Map()
  for (const [key, entry] of parseDn(value)) {
    const normalizedKey = key.trim().toUpperCase()
    const normalizedValue = entry.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalizedKey && normalizedValue) result.set(normalizedKey, normalizedValue)
  }
  return result
}

function publisherMatches(expectedPublisher, subject) {
  const actualDn = normalizedDn(subject)
  const actualCommonName = actualDn.get('CN')
  if (!actualCommonName) return false
  const expected = expectedPublisher.trim()
  if (!expected) return false
  const expectedDn = normalizedDn(expected)
  if (expectedDn.size === 0) {
    return expected.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === actualCommonName
  }
  return [...expectedDn].every(([key, value]) => actualDn.get(key) === value)
}

function verifyAuthenticode(filePath, expectedPublisher = null, options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') {
    throw Object.assign(new Error('Windows 发布产物必须在 Windows 发布机校验签名状态'), {
      code: 'SIGNATURE_PLATFORM_UNSUPPORTED',
    })
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Import-Module -Name $env:XINGMANG_SECURITY_MODULE -Force -ErrorAction Stop',
    '$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_SIGNATURE_TARGET -ErrorAction Stop',
    'if ($null -eq $signature) { throw "Get-AuthenticodeSignature did not return a result" }',
    '[pscustomobject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join('\n')
  const resolvePowerShell = options.resolvePowerShell || resolveTrustedWindowsPowerShell
  const resolved = resolvePowerShell({ platform })
  const securityModule = path.win32.join(
    path.win32.dirname(resolved.executable),
    'Modules',
    'Microsoft.PowerShell.Security',
    'Microsoft.PowerShell.Security.psd1',
  )
  const run = options.spawnSync || spawnSync
  const result = run(resolved.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      SystemRoot: resolved.systemRoot,
      WINDIR: resolved.systemRoot,
      PATH: resolved.system32,
      PSModulePath: '',
      XINGMANG_SIGNATURE_TARGET: filePath,
      XINGMANG_SECURITY_MODULE: securityModule,
    },
  })
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter((value) => typeof value === 'string' && value.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500)
    throw Object.assign(new Error(`无法读取安装程序 Authenticode 签名${detail ? `：${detail}` : ''}`), {
      code: 'SIGNATURE_CHECK_FAILED',
    })
  }
  let signature
  try {
    signature = JSON.parse(result.stdout.trim())
  } catch {
    throw Object.assign(new Error('Authenticode 校验返回了无效结果'), { code: 'SIGNATURE_RESULT_INVALID' })
  }
  if (signature.Status !== 'Valid') {
    throw Object.assign(new Error(`安装程序必须具有有效 Authenticode 签名，实际为：${signature.Status || 'Unknown'}`), {
      code: 'INSTALLER_SIGNATURE_INVALID',
    })
  }
  // Skipping the subject comparison when no publisher is configured accepted any
  // installer carrying some valid Authenticode signature — an attacker's own
  // certificate included. validateReleaseEnvironment already refuses an empty
  // publisher in release mode, but this function is exported and `npm run
  // release:verify` reaches it without XINGMANG_RELEASE=1, so the gate has to
  // hold on its own rather than trust the caller to have checked.
  if (!expectedPublisher || !String(expectedPublisher).trim()) {
    throw Object.assign(
      new Error('缺少固定签名发布者，无法校验安装程序签名主体；请设置 XINGMANG_SIGNING_PUBLISHER'),
      { code: 'SIGNING_PUBLISHER_MISSING' },
    )
  }
  const subject = typeof signature.Subject === 'string' ? signature.Subject : ''
  if (!publisherMatches(expectedPublisher, subject)) {
    throw Object.assign(new Error(`安装程序签名发布者不匹配：期望 ${expectedPublisher}，实际 ${subject || 'Unknown'}`), {
      code: 'INSTALLER_PUBLISHER_MISMATCH',
    })
  }
}

async function main() {
  // Formal builds are isolated by package version. Falling back to the legacy
  // `release/` directory silently verifies stale artifacts from an older build
  // and produces a misleading version-mismatch error.
  const requestedDirectory = process.argv[2] || process.env.XINGMANG_OUTPUT_DIR || `release-${packageVersion}`
  const releaseDirectory = path.resolve(requestedDirectory)
  const { signing } = validateReleaseEnvironment()
  const result = await validateLocalRelease(releaseDirectory, { expectedVersion: packageVersion })
  const installers = result.metadata.files.filter((file) => file.relativePath.toLowerCase().endsWith('.exe'))
  if (installers.length === 0) {
    throw Object.assign(new Error('latest.yml 未引用 Windows EXE 安装程序'), {
      code: 'INSTALLER_MISSING',
    })
  }
  for (const installer of installers) {
    verifyAuthenticode(path.join(result.releaseDirectory, installer.relativePath), signing.expectedPublisher)
  }
  console.log(`发布产物校验通过：v${result.metadata.version}，${installers.length} 个已签名安装程序`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`发布产物校验失败 [${error.code || 'UNKNOWN'}]：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { main, verifyAuthenticode }
