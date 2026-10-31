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

// 这里放宽的是安全校验：每加一条、每延一次期，都要 yoyo 亲手打字同意，并写明到期日。
// GHSA-g3hv-75wg-m249：2026-10-31 北京时间 16:39，yoyo 回「同意 minimatch 例外到 11-30」。
// 只有 minimatch 11 修了，它换了匹配引擎，作者明说不回补旧版；electron-builder
// 26.18.1 和 27.0.0-alpha.14 仍要 ^10。强换 11 会直接报错：11 没有默认导出，
// asar 3.4.1、dir-compare 4.2.0 调的正是它；glob 7 把 Minimatch#set 里的段当正则
// 用，11 里那是别的对象。出事的 firstPhasePreProcess 只在 optimizationLevel >= 2
// 时走到，树里没有调用方传它，3.x / 5.x 根本没有这段代码；规则全来自自家打包配置，
// 客户装的那部分依赖（audit:production）不含 minimatch。到期后照常变红，那时回头
// 看上游有没有换到 11。
const temporaryAdvisoryExceptions = [{
  url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
  packageName: 'minimatch',
  maxSeverity: 'moderate',
  // 北京时间 2026-11-30 当天结束。
  expiresAt: '2026-11-30T16:00:00.000Z',
}]

const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }

function vulnerabilityError(actualAdvisories, affectedPackages, counts, hasNonZeroCount, extra) {
  return new Error([
    '构建依赖存在漏洞',
    actualAdvisories.length ? `新增公告：${actualAdvisories.join(', ')}` : '',
    affectedPackages.length ? `受影响包：${affectedPackages.join(', ')}` : '',
    hasNonZeroCount
      ? `计数：${auditSeverityNames.map((name) => `${name} ${String(counts[name])}`).join(' / ')}`
      : '',
    extra ?? '',
  ].filter(Boolean).join('；'))
}

function matchingException(source, exceptions) {
  return exceptions.find((exception) => (
    source.url === exception.url
    && source.name === exception.packageName
    && Object.prototype.hasOwnProperty.call(severityRank, source.severity)
    && severityRank[source.severity] <= severityRank[exception.maxSeverity]
  ))
}

// Every affected package must trace back, through npm's "depends on a
// vulnerable package" edges, to nothing but excepted advisories. Anything else
// (a second advisory, a dangling edge, a node with no advisory under it, a
// severity above the excepted ceiling, or counts that disagree with the nodes)
// fails exactly as an unexcepted report would.
function exceptedAdvisoryCoverage(report, exceptions) {
  const vulnerabilities = report.vulnerabilities ?? {}
  const counts = report.metadata.vulnerabilities
  const usedExceptions = new Set()
  const ceiling = Math.max(-1, ...exceptions.map((exception) => severityRank[exception.maxSeverity]))
  const expectedCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }

  for (const [name, node] of Object.entries(vulnerabilities)) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.via) || node.via.length === 0) return null
    if (!Object.prototype.hasOwnProperty.call(severityRank, node.severity)) return null
    if (severityRank[node.severity] > ceiling) return null
    expectedCounts[node.severity] += 1
    for (const source of node.via) {
      if (typeof source === 'string') {
        if (source === name || !Object.prototype.hasOwnProperty.call(vulnerabilities, source)) return null
        continue
      }
      if (!source || typeof source !== 'object') return null
      const exception = matchingException(source, exceptions)
      if (!exception || name !== exception.packageName) return null
      usedExceptions.add(exception)
    }
  }

  const reachesAdvisory = new Map()
  function reaches(name, visiting) {
    if (reachesAdvisory.has(name)) return reachesAdvisory.get(name)
    if (visiting.has(name)) return false
    visiting.add(name)
    const result = vulnerabilities[name].via.some((source) => (
      typeof source === 'string' ? reaches(source, visiting) : true
    ))
    visiting.delete(name)
    reachesAdvisory.set(name, result)
    return result
  }
  for (const name of Object.keys(vulnerabilities)) {
    if (!reaches(name, new Set())) return null
  }

  const total = Object.keys(vulnerabilities).length
  for (const severity of Object.keys(expectedCounts)) {
    if (counts[severity] !== expectedCounts[severity]) return null
  }
  if (counts.total !== total) return null

  return [...usedExceptions]
}

function validateDevelopmentAuditReport(report, options = {}) {
  if (!report || report.auditReportVersion !== 2 || !report.metadata?.vulnerabilities) {
    throw new Error('npm audit 返回了不受支持的 JSON 结构')
  }
  const exceptions = options.exceptions ?? temporaryAdvisoryExceptions
  const now = options.now ?? new Date()

  const counts = report.metadata.vulnerabilities
  const actualAdvisories = advisoryUrls(report)
  const affectedPackages = sorted(Object.keys(report.vulnerabilities ?? {}))
  const hasNonZeroCount = auditSeverityNames.some((name) => counts[name] !== 0)
  if (!actualAdvisories.length && !affectedPackages.length && !hasNonZeroCount) {
    return {
      advisories: actualAdvisories,
      affectedPackages,
      counts,
      exceptedAdvisories: [],
      unusedExceptions: exceptions.map((exception) => exception.url),
    }
  }

  const usedExceptions = actualAdvisories.length && affectedPackages.length
    ? exceptedAdvisoryCoverage(report, exceptions)
    : null
  if (!usedExceptions || !usedExceptions.length) {
    throw vulnerabilityError(actualAdvisories, affectedPackages, counts, hasNonZeroCount)
  }
  const expired = usedExceptions.filter((exception) => !(now.getTime() < Date.parse(exception.expiresAt)))
  if (expired.length) {
    throw vulnerabilityError(
      actualAdvisories,
      affectedPackages,
      counts,
      hasNonZeroCount,
      `临时例外已到期：${expired.map((exception) => `${exception.url}（${exception.expiresAt}）`).join(', ')}`,
    )
  }

  return {
    advisories: actualAdvisories,
    affectedPackages,
    counts,
    exceptedAdvisories: sorted(usedExceptions.map((exception) => exception.url)),
    unusedExceptions: sorted(exceptions
      .filter((exception) => !usedExceptions.includes(exception))
      .map((exception) => exception.url)),
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
    const auditSummary = result.exceptedAdvisories.length
      ? `npm audit 只报了临时放行的公告：${result.exceptedAdvisories.join(', ')}`
      : 'npm audit 未发现漏洞'
    console.log(
      `构建依赖审计通过：${result.verifiedLockPackages} 个锁定包均来自 npm 官方 HTTPS 源并带 SHA-512；${auditSummary}`,
    )
    if (result.unusedExceptions.length) {
      console.warn(`这些临时例外已用不上，可以从 audit-development-dependencies.cjs 删掉：${result.unusedExceptions.join(', ')}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  advisoryUrls,
  temporaryAdvisoryExceptions,
  validatePackageLockSources,
  validateDevelopmentAuditReport,
}
