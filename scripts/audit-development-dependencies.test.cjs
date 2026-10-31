const assert = require('node:assert/strict')
const test = require('node:test')
const {
  advisoryUrls,
  temporaryAdvisoryExceptions,
  validatePackageLockSources,
  validateDevelopmentAuditReport,
} = require('./audit-development-dependencies.cjs')

const previouslyAffectedPackages = [
  '@electron/asar', '@electron/universal', 'app-builder-lib', 'brace-expansion',
  'dir-compare', 'dmg-builder', 'ejs', 'electron-builder',
  'electron-builder-squirrel-windows', 'electron-winstaller', 'filelist', 'glob',
  'jake', 'minimatch', 'rimraf', 'temp',
]

function cleanReport(overrides = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    },
    ...overrides,
  }
}

function vulnerableReport(overrides = {}) {
  const vulnerabilities = Object.fromEntries(previouslyAffectedPackages.map((name) => [name, {
    name,
    severity: 'high',
    via: name === 'brace-expansion'
      ? [{ url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg', severity: 'high' }]
      : ['brace-expansion'],
  }]))
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 16, critical: 0, total: 16 },
    },
    ...overrides,
  }
}

test('accepts only an audit report with no vulnerabilities', () => {
  const result = validateDevelopmentAuditReport(cleanReport())
  assert.deepEqual(result.advisories, [])
  assert.deepEqual(result.affectedPackages, [])
  assert.deepEqual(result.counts, {
    info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0,
  })
})

test('rejects the previously allowed advisory baseline', () => {
  assert.throws(() => validateDevelopmentAuditReport(vulnerableReport()), /构建依赖存在漏洞/)
})

test('rejects a new advisory even when npm reports no critical vulnerability', () => {
  const input = vulnerableReport()
  input.vulnerabilities.ejs.via = [{
    url: 'https://github.com/advisories/GHSA-new-advisory',
    severity: 'high',
  }]
  assert.throws(() => validateDevelopmentAuditReport(input), /新增公告/)
})

test('rejects vulnerability entries and severity-count drift', () => {
  const hiddenVulnerability = cleanReport()
  hiddenVulnerability.vulnerabilities['hidden-build-package'] = {
    name: 'hidden-build-package',
    severity: 'high',
    via: ['transitive-package'],
  }
  assert.throws(() => validateDevelopmentAuditReport(hiddenVulnerability), /构建依赖存在漏洞/)

  const critical = cleanReport()
  critical.metadata.vulnerabilities.critical = 1
  critical.metadata.vulnerabilities.total = 1
  assert.throws(() => validateDevelopmentAuditReport(critical), /构建依赖存在漏洞/)
})

const minimatchAdvisory = 'https://github.com/advisories/GHSA-g3hv-75wg-m249'
const testException = {
  url: minimatchAdvisory,
  packageName: 'minimatch',
  maxSeverity: 'moderate',
  expiresAt: '2026-11-30T16:00:00.000Z',
}
const beforeExpiry = new Date('2026-11-01T00:00:00.000Z')

// Same shape as the 2026-10-31 report: one advisory object on minimatch, and
// every other package only "depends on vulnerable versions of" something.
function minimatchChainReport() {
  const via = {
    minimatch: [{ name: 'minimatch', url: minimatchAdvisory, severity: 'moderate' }],
    glob: ['minimatch'],
    '@electron/asar': ['glob', 'minimatch'],
    'app-builder-lib': ['@electron/asar', 'minimatch'],
    'electron-builder': ['app-builder-lib'],
  }
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(Object.entries(via).map(([name, entries]) => [
      name,
      { name, severity: 'moderate', via: entries },
    ])),
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 5, high: 0, critical: 0, total: 5 },
    },
  }
}

function validateWithTestException(report, now = beforeExpiry) {
  return validateDevelopmentAuditReport(report, { exceptions: [testException], now })
}

test('pins the temporary exception list to the single advisory yoyo approved', () => {
  assert.deepEqual(temporaryAdvisoryExceptions, [testException])
})

test('accepts the excepted minimatch chain before it expires', () => {
  const result = validateWithTestException(minimatchChainReport())
  assert.deepEqual(result.advisories, [minimatchAdvisory])
  assert.deepEqual(result.exceptedAdvisories, [minimatchAdvisory])
  assert.deepEqual(result.unusedExceptions, [])
  assert.deepEqual(result.affectedPackages, [
    '@electron/asar', 'app-builder-lib', 'electron-builder', 'glob', 'minimatch',
  ])
})

test('rejects the excepted chain once the exception expires', () => {
  assert.throws(
    () => validateWithTestException(minimatchChainReport(), new Date(testException.expiresAt)),
    /临时例外已到期/,
  )
})

test('rejects the excepted chain when any other advisory appears beside it', () => {
  const report = minimatchChainReport()
  report.vulnerabilities.joi = {
    name: 'joi',
    severity: 'moderate',
    via: [{ name: 'joi', url: 'https://github.com/advisories/GHSA-new-advisory', severity: 'moderate' }],
  }
  report.metadata.vulnerabilities.moderate = 6
  report.metadata.vulnerabilities.total = 6
  assert.throws(() => validateWithTestException(report), /新增公告/)
})

test('rejects the excepted advisory once its severity rises above the approved ceiling', () => {
  const report = minimatchChainReport()
  for (const node of Object.values(report.vulnerabilities)) node.severity = 'high'
  report.vulnerabilities.minimatch.via[0].severity = 'high'
  report.metadata.vulnerabilities.moderate = 0
  report.metadata.vulnerabilities.high = 5
  assert.throws(() => validateWithTestException(report), /构建依赖存在漏洞/)
})

test('rejects the excepted advisory URL reported against another package', () => {
  const report = minimatchChainReport()
  report.vulnerabilities.glob.via = [{ name: 'glob', url: minimatchAdvisory, severity: 'moderate' }]
  assert.throws(() => validateWithTestException(report), /构建依赖存在漏洞/)
})

test('rejects dangling and advisory-free chains even when the excepted advisory is present', () => {
  const dangling = minimatchChainReport()
  dangling.vulnerabilities.orphan = { name: 'orphan', severity: 'moderate', via: ['not-in-report'] }
  dangling.metadata.vulnerabilities.moderate = 6
  dangling.metadata.vulnerabilities.total = 6
  assert.throws(() => validateWithTestException(dangling), /构建依赖存在漏洞/)

  const loop = minimatchChainReport()
  loop.vulnerabilities['loop-a'] = { name: 'loop-a', severity: 'moderate', via: ['loop-b'] }
  loop.vulnerabilities['loop-b'] = { name: 'loop-b', severity: 'moderate', via: ['loop-a'] }
  loop.metadata.vulnerabilities.moderate = 7
  loop.metadata.vulnerabilities.total = 7
  assert.throws(() => validateWithTestException(loop), /构建依赖存在漏洞/)
})

test('rejects severity-count drift alongside the excepted chain', () => {
  const report = minimatchChainReport()
  report.metadata.vulnerabilities.high = 1
  report.metadata.vulnerabilities.total = 6
  assert.throws(() => validateWithTestException(report), /构建依赖存在漏洞/)

  const hiddenTotal = minimatchChainReport()
  hiddenTotal.metadata.vulnerabilities.total = 4
  assert.throws(() => validateWithTestException(hiddenTotal), /构建依赖存在漏洞/)
})

test('reports an exception as unused once the audit comes back clean', () => {
  assert.deepEqual(validateWithTestException(cleanReport()).unusedExceptions, [minimatchAdvisory])
})

test('extracts unique advisory URLs from npm audit report nodes', () => {
  assert.deepEqual(advisoryUrls({
    vulnerabilities: {
      one: { via: [{ url: 'https://example.test/B' }, { url: 'https://example.test/A' }] },
      two: { via: [{ url: 'https://example.test/A' }, 'one'] },
    },
  }), ['https://example.test/A', 'https://example.test/B'])
})

test('requires official npm HTTPS URLs and SHA-512 for every locked package', () => {
  const integrity = `sha512-${Buffer.alloc(64, 0x41).toString('base64')}`
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'test' },
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        integrity,
      },
    },
  }
  assert.equal(validatePackageLockSources(lockfile), 1)
  assert.throws(() => validatePackageLockSources({
    ...lockfile,
    packages: {
      ...lockfile.packages,
      'node_modules/example': {
        ...lockfile.packages['node_modules/example'],
        resolved: 'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
      },
    },
  }), /npm 官方 HTTPS 源/)
  assert.throws(() => validatePackageLockSources({
    ...lockfile,
    packages: {
      ...lockfile.packages,
      'node_modules/example': {
        ...lockfile.packages['node_modules/example'],
        integrity: 'sha512-invalid',
      },
    },
  }), /有效 SHA-512/)
})

test('rejects ordinary locked packages missing resolved or integrity', () => {
  const integrity = `sha512-${Buffer.alloc(64, 0x42).toString('base64')}`
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'test' },
      'node_modules/verified': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/verified/-/verified-1.0.0.tgz',
        integrity,
      },
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        integrity,
      },
    },
  }

  assert.throws(() => validatePackageLockSources({
    ...lockfile,
    packages: {
      ...lockfile.packages,
      'node_modules/example': { version: '1.0.0', integrity },
    },
  }), /npm 官方 HTTPS 源/)
  assert.throws(() => validatePackageLockSources({
    ...lockfile,
    packages: {
      ...lockfile.packages,
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
      },
    },
  }), /有效 SHA-512/)
})

test('permits root and linked workspace lock entries without registry pins', () => {
  const integrity = `sha512-${Buffer.alloc(64, 0x43).toString('base64')}`
  assert.equal(validatePackageLockSources({
    lockfileVersion: 3,
    packages: {
      '': { name: 'test' },
      'packages/local-workspace': { name: 'local-workspace', version: '1.0.0' },
      'node_modules/local-workspace': { resolved: 'packages/local-workspace', link: true },
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        integrity,
      },
    },
  }), 1)
})

test('rejects link entries without a local target', () => {
  const integrity = `sha512-${Buffer.alloc(64, 0x44).toString('base64')}`
  assert.throws(() => validatePackageLockSources({
    lockfileVersion: 3,
    packages: {
      '': { name: 'test' },
      'node_modules/local-workspace': { link: true },
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        integrity,
      },
    },
  }), /工作区链接无效/)
})

test('rejects links that can hide an unpinned package', () => {
  const integrity = `sha512-${Buffer.alloc(64, 0x45).toString('base64')}`
  assert.throws(() => validatePackageLockSources({
    lockfileVersion: 3,
    packages: {
      '': { name: 'test' },
      'node_modules/link': { link: true, resolved: 'node_modules/unpinned' },
      'node_modules/unpinned': { version: '1.0.0' },
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        integrity,
      },
    },
  }), /工作区链接无效/)
})

test('rejects unsafe link targets', () => {
  const integrity = `sha512-${Buffer.alloc(64, 0x46).toString('base64')}`
  for (const target of [
    '/packages/local-workspace',
    'https://example.test/workspace',
    'packages\\local-workspace',
    'packages/./local-workspace',
    'packages/../local-workspace',
    'node_modules/local-workspace',
  ]) {
    assert.throws(() => validatePackageLockSources({
      lockfileVersion: 3,
      packages: {
        '': { name: 'test' },
        'node_modules/workspace-link': { link: true, resolved: target },
        [target]: { name: 'local-workspace', version: '1.0.0' },
        'node_modules/example': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
          integrity,
        },
      },
    }), /工作区链接无效/, target)
  }
})
