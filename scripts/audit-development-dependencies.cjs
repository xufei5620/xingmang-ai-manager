const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const allowedAdvisories = new Set([
  'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
])

const expectedAffectedPackages = [
  '@electron/asar',
  '@electron/universal',
  'app-builder-lib',
  'brace-expansion',
  'dir-compare',
  'dmg-builder',
  'ejs',
  'electron-builder',
  'electron-builder-squirrel-windows',
  'electron-winstaller',
  'filelist',
  'glob',
  'jake',
  'minimatch',
  'rimraf',
  'temp',
]

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function advisoryUrls(report) {
  const urls = new Set()
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const source of vulnerability?.via ?? []) {
      if (source && typeof source === 'object' && typeof source.url === 'string') {
        urls.add(source.url)
      }
    }
  }
  return sorted(urls)
}

function validatePackageLockSources(lockfile) {
  if (
    !lockfile
    || lockfile.lockfileVersion !== 3
    || !lockfile.packages
    || typeof lockfile.packages !== 'object'
    || Array.isArray(lockfile.packages)
  ) {
    throw new Error('package-lock.json 不是受支持的 npm lockfileVersion 3 结构')
  }
  let verifiedPackages = 0
  for (const [location, entry] of Object.entries(lockfile.packages)) {
    if (!entry || typeof entry !== 'object' || typeof entry.resolved !== 'string') continue
    let resolved
    try {
      resolved = new URL(entry.resolved)
    } catch {
      throw new Error(`锁文件依赖地址无效：${location || '<root>'}`)
    }
    if (
      resolved.protocol !== 'https:'
      || resolved.hostname !== 'registry.npmjs.org'
      || resolved.port
      || resolved.username
      || resolved.password
      || resolved.search
      || resolved.hash
    ) {
      throw new Error(`锁文件依赖未固定到 npm 官方 HTTPS 源：${location || '<root>'}`)
    }
    const integrity = typeof entry.integrity === 'string' ? entry.integrity : ''
    const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
    if (!match || Buffer.from(match[1], 'base64').length !== 64) {
      throw new Error(`锁文件依赖缺少有效 SHA-512：${location || '<root>'}`)
    }
    verifiedPackages += 1
  }
  if (verifiedPackages === 0) throw new Error('package-lock.json 没有可验证的依赖地址')
  return verifiedPackages
}

function readAndValidatePackageLock() {
  const lockPath = path.join(process.cwd(), 'package-lock.json')
  const stat = fs.statSync(lockPath)
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
    throw new Error('package-lock.json 不存在或超过 16 MiB 安全上限')
  }
  return validatePackageLockSources(JSON.parse(fs.readFileSync(lockPath, 'utf8')))
}

function validateDevelopmentAuditReport(report) {
  if (!report || report.auditReportVersion !== 2 || !report.metadata?.vulnerabilities) {
    throw new Error('npm audit 返回了不受支持的 JSON 结构')
  }

  const counts = report.metadata.vulnerabilities
  if (counts.critical !== 0) {
    throw new Error(`构建依赖出现 ${counts.critical} 个 Critical 漏洞`)
  }

  const actualAdvisories = advisoryUrls(report)
  const unexpectedAdvisories = actualAdvisories.filter((url) => !allowedAdvisories.has(url))
  const missingAdvisories = [...allowedAdvisories].filter((url) => !actualAdvisories.includes(url))
  if (unexpectedAdvisories.length || missingAdvisories.length) {
    throw new Error([
      unexpectedAdvisories.length ? `新增公告：${unexpectedAdvisories.join(', ')}` : '',
      missingAdvisories.length ? `基线公告已变化：${missingAdvisories.join(', ')}` : '',
    ].filter(Boolean).join('；'))
  }

  const affectedPackages = sorted(Object.keys(report.vulnerabilities ?? {}))
  const expectedPackages = sorted(expectedAffectedPackages)
  if (JSON.stringify(affectedPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error(
      `构建依赖漏洞传播路径发生变化：实际 ${affectedPackages.join(', ') || '无'}；基线 ${expectedPackages.join(', ')}`,
    )
  }
  if (counts.high !== expectedPackages.length || counts.moderate !== 0 || counts.low !== 0) {
    throw new Error(
      `构建依赖漏洞计数发生变化：Critical ${counts.critical} / High ${counts.high} / Moderate ${counts.moderate} / Low ${counts.low}`,
    )
  }

  return {
    advisories: actualAdvisories,
    affectedPackages,
    counts,
  }
}

function runNpmAudit() {
  const verifiedLockPackages = readAndValidatePackageLock()
  const npmCli = process.env.npm_execpath
  const executable = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const argv = npmCli
    ? [npmCli, 'audit', '--json', '--registry=https://registry.npmjs.org/']
    : ['audit', '--json', '--registry=https://registry.npmjs.org/']
  const result = spawnSync(executable, argv, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500)
    throw new Error(`npm audit JSON 读取失败${detail ? `：${detail}` : ''}`)
  }
  return { ...validateDevelopmentAuditReport(report), verifiedLockPackages }
}

if (require.main === module) {
  try {
    const result = runNpmAudit()
    console.log(
      `构建依赖审计通过：${result.verifiedLockPackages} 个锁定包均来自 npm 官方 HTTPS 源并带 SHA-512；仅保留已知 ${result.advisories[0]}，影响 ${result.affectedPackages.length} 个构建链包；未发现新增公告`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  advisoryUrls,
  validatePackageLockSources,
  validateDevelopmentAuditReport,
}
