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

// The minimatch exception is no longer on the real list (package.json now
// overrides the two affected copies); these tests keep it only as a fixture for
// the exception mechanism the remaining entries still rely on.
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

// GitHub withdrew the picomatch advisory on 2026-11-18, so its exception is off
// the real list too; like the minimatch one above, it stays here only as a
// fixture for a high-severity exception sitting beside a moderate one.
const picomatchAdvisory = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf'
const picomatchException = {
  url: picomatchAdvisory,
  packageName: 'picomatch',
  maxSeverity: 'high',
  expiresAt: '2026-12-15T16:00:00.000Z',
}

test('pins the temporary exception list to the advisories yoyo approved', () => {
  assert.deepEqual(temporaryAdvisoryExceptions, [])
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

// Same shape as the 2026-11-17 report on main ca72c20: the high picomatch
// advisory reaches through vite / vitest / tinyglobby and, via node-gyp, into
// app-builder-lib, which also sits on the moderate minimatch chain.
function combinedChainReport() {
  const nodes = {
    minimatch: ['moderate', [{ name: 'minimatch', url: minimatchAdvisory, severity: 'moderate' }]],
    '@electron/universal': ['moderate', ['minimatch']],
    picomatch: ['high', [{ name: 'picomatch', url: picomatchAdvisory, severity: 'high' }]],
    fdir: ['high', ['picomatch']],
    tinyglobby: ['high', ['fdir', 'picomatch']],
    vite: ['high', ['picomatch', 'tinyglobby']],
    vitest: ['high', ['picomatch', 'tinyglobby']],
    '@vitejs/plugin-react': ['high', ['vite']],
    'node-gyp': ['high', ['tinyglobby']],
    '@electron/rebuild': ['high', ['node-gyp']],
    'app-builder-lib': ['high', ['@electron/rebuild', '@electron/universal', 'dmg-builder', 'minimatch']],
    'dmg-builder': ['moderate', ['app-builder-lib']],
    'electron-builder': ['moderate', ['app-builder-lib', 'dmg-builder']],
  }
  const vulnerabilities = Object.fromEntries(Object.entries(nodes).map(([name, [severity, via]]) => [
    name,
    { name, severity, via },
  ]))
  const moderate = Object.values(vulnerabilities).filter((node) => node.severity === 'moderate').length
  const high = Object.values(vulnerabilities).filter((node) => node.severity === 'high').length
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate, high, critical: 0, total: moderate + high },
    },
  }
}

function validateWithBothExceptions(report, now = beforeExpiry) {
  return validateDevelopmentAuditReport(report, { exceptions: [testException, picomatchException], now })
}

test('accepts the combined minimatch and picomatch chains before either exception expires', () => {
  const result = validateWithBothExceptions(combinedChainReport())
  assert.deepEqual(result.exceptedAdvisories, [picomatchAdvisory, minimatchAdvisory])
  assert.deepEqual(result.unusedExceptions, [])
})

test('rejects the picomatch chain without its own exception', () => {
  assert.throws(() => validateWithTestException(combinedChainReport()), /构建依赖存在漏洞/)
})

test('rejects the combined chains once either exception expires', () => {
  assert.throws(
    () => validateWithBothExceptions(combinedChainReport(), new Date(testException.expiresAt)),
    /临时例外已到期：https:\/\/github\.com\/advisories\/GHSA-g3hv-75wg-m249/,
  )
  const picomatchOnly = combinedChainReport()
  delete picomatchOnly.vulnerabilities.minimatch
  delete picomatchOnly.vulnerabilities['@electron/universal']
  picomatchOnly.vulnerabilities['app-builder-lib'].via = ['@electron/rebuild', 'dmg-builder']
  picomatchOnly.metadata.vulnerabilities.moderate -= 2
  picomatchOnly.metadata.vulnerabilities.total -= 2
  assert.deepEqual(
    validateWithBothExceptions(picomatchOnly, new Date(testException.expiresAt)).unusedExceptions,
    [minimatchAdvisory],
  )
  assert.throws(
    () => validateWithBothExceptions(picomatchOnly, new Date(picomatchException.expiresAt)),
    /临时例外已到期：https:\/\/github\.com\/advisories\/GHSA-fc5q-39xc-vjpf/,
  )
})

test('keeps a minimatch-only node capped at moderate while the picomatch exception allows high', () => {
  const report = combinedChainReport()
  report.vulnerabilities['@electron/universal'].severity = 'high'
  report.metadata.vulnerabilities.moderate -= 1
  report.metadata.vulnerabilities.high += 1
  assert.throws(() => validateWithBothExceptions(report), /构建依赖存在漏洞/)
})

test('rejects the picomatch advisory once its severity rises to critical', () => {
  const report = combinedChainReport()
  report.vulnerabilities.picomatch.via[0].severity = 'critical'
  report.vulnerabilities.picomatch.severity = 'critical'
  report.metadata.vulnerabilities.high -= 1
  report.metadata.vulnerabilities.critical += 1
  assert.throws(() => validateWithBothExceptions(report), /构建依赖存在漏洞/)
})

test('rejects the picomatch chain with the real exception list', () => {
  const report = combinedChainReport()
  delete report.vulnerabilities.minimatch
  delete report.vulnerabilities['@electron/universal']
  report.vulnerabilities['app-builder-lib'].via = ['@electron/rebuild', 'dmg-builder']
  report.metadata.vulnerabilities.moderate -= 2
  report.metadata.vulnerabilities.total -= 2
  assert.throws(
    () => validateDevelopmentAuditReport(report, { now: beforeExpiry }),
    /构建依赖存在漏洞；新增公告：https:\/\/github\.com\/advisories\/GHSA-fc5q-39xc-vjpf/,
  )
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
