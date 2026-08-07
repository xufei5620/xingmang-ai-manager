const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const auditSeverityNames = ['info', 'low', 'moderate', 'high', 'critical', 'total']

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

function isSafeWorkspaceLocation(location) {
  if (
    typeof location !== 'string'
    || !location
    || location.includes('\\')
    || path.posix.isAbsolute(location)
    || path.win32.isAbsolute(location)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(location)
  ) return false
  return location.split('/').every((segment) => (
    segment && segment !== '.' && segment !== '..' && segment !== 'node_modules'
  ))
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
  const linkedWorkspaceLocations = new Set()
  for (const [location, entry] of Object.entries(lockfile.packages)) {
    if (location === '' || !entry || typeof entry !== 'object' || entry.link !== true) continue
    const workspaceLocation = entry.resolved
    const workspaceEntry = lockfile.packages[workspaceLocation]
    if (
      !isSafeWorkspaceLocation(workspaceLocation)
      || !Object.prototype.hasOwnProperty.call(lockfile.packages, workspaceLocation)
      || !workspaceEntry
      || typeof workspaceEntry !== 'object'
      || Array.isArray(workspaceEntry)
      || workspaceEntry.link === true
    ) {
      throw new Error(`锁文件工作区链接无效：${location}`)
    }
    linkedWorkspaceLocations.add(workspaceLocation)
  }
  let verifiedPackages = 0
  for (const [location, entry] of Object.entries(lockfile.packages)) {
    if (location === '' || entry?.link === true || linkedWorkspaceLocations.has(location)) continue
    if (!entry || typeof entry !== 'object' || typeof entry.resolved !== 'string') {
      throw new Error(`锁文件依赖未固定到 npm 官方 HTTPS 源：${location}`)
    }
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
  const actualAdvisories = advisoryUrls(report)
  const affectedPackages = sorted(Object.keys(report.vulnerabilities ?? {}))
  const hasNonZeroCount = auditSeverityNames.some((name) => counts[name] !== 0)
  if (actualAdvisories.length || affectedPackages.length || hasNonZeroCount) {
    throw new Error([
      '构建依赖存在漏洞',
      actualAdvisories.length ? `新增公告：${actualAdvisories.join(', ')}` : '',
      affectedPackages.length ? `受影响包：${affectedPackages.join(', ')}` : '',
      hasNonZeroCount
        ? `计数：${auditSeverityNames.map((name) => `${name} ${String(counts[name])}`).join(' / ')}`
        : '',
    ].filter(Boolean).join('；'))
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
      `构建依赖审计通过：${result.verifiedLockPackages} 个锁定包均来自 npm 官方 HTTPS 源并带 SHA-512；npm audit 未发现漏洞`,
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
