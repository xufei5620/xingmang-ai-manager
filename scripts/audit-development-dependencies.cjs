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

// GHSA-g3hv-75wg-m249（minimatch）不再放行：package.json 的 overrides 按版本把
// app-builder-lib 用的 ^10.2.5 和 @electron/universal 用的 ^9.0.3 换成 11.0.5，
// 三个平台打包前后的文件清单一致。别改写成 "app-builder-lib": { "minimatch": … }，
// 那会把底下 glob 7、dir-compare 用的 3.x 也换成 11，它们调的默认导出 11 里没有。

// GHSA-fc5q-39xc-vjpf（picomatch）不再放行：GitHub 2026-11-18 撤回了这条公告，
// picomatch 维护者在 micromatch/picomatch#235 说 glob 本来就是正则、不收不可信的规则
// 就不是漏洞；npm audit 从此不再报它。picomatch 没发新版，树里还是 4.0.5。

// 这里放宽的是安全校验：每加一条、每延一次期，都要 yoyo 亲手打字同意，并写明到期日。
// 表空着的时候，npm audit 报出任何一条公告都会让审计变红。
const temporaryAdvisoryExceptions = []

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

// Walks "depends on a vulnerable package" edges breadth-first, so dependency
// cycles (app-builder-lib <-> dmg-builder) are fine. Callers have already
// checked every string edge names a node in the report. Returns -1 when no
// advisory object is reachable.
function worstReachableAdvisorySeverity(vulnerabilities, start) {
  let worst = -1
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) {
    const name = queue.shift()
    for (const source of vulnerabilities[name].via) {
      if (typeof source !== 'string') {
        worst = Math.max(worst, severityRank[source.severity])
      } else if (!seen.has(source)) {
        seen.add(source)
        queue.push(source)
      }
    }
  }
  return worst
}

// Every affected package must trace back, through npm's "depends on a
// vulnerable package" edges, to nothing but excepted advisories. Anything else
// (a second advisory, a dangling edge, a node with no advisory under it, a
// node more severe than the excepted advisories it reaches, or counts that
// disagree with the nodes) fails exactly as an unexcepted report would.
function exceptedAdvisoryCoverage(report, exceptions) {
  const vulnerabilities = report.vulnerabilities ?? {}
  const counts = report.metadata.vulnerabilities
  const usedExceptions = new Set()
  const expectedCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }

  for (const [name, node] of Object.entries(vulnerabilities)) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.via) || node.via.length === 0) return null
    if (!Object.prototype.hasOwnProperty.call(severityRank, node.severity)) return null
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

  // Each node is capped by the worst excepted advisory it actually reaches, not
  // by the highest ceiling on the list: otherwise a chain that only reaches a
  // moderate excepted advisory could report "high" because another exception
  // on the list allows high.
  for (const [name, node] of Object.entries(vulnerabilities)) {
    const worst = worstReachableAdvisorySeverity(vulnerabilities, name)
    if (worst < 0 || severityRank[node.severity] > worst) return null
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
