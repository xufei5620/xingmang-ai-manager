const assert = require('node:assert/strict')
const test = require('node:test')
const {
  advisoryUrls,
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
