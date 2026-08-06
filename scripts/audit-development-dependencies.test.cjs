const assert = require('node:assert/strict')
const test = require('node:test')
const {
  advisoryUrls,
  validatePackageLockSources,
  validateDevelopmentAuditReport,
} = require('./audit-development-dependencies.cjs')

const affectedPackages = [
  '@electron/asar', '@electron/universal', 'app-builder-lib', 'brace-expansion',
  'dir-compare', 'dmg-builder', 'ejs', 'electron-builder',
  'electron-builder-squirrel-windows', 'electron-winstaller', 'filelist', 'glob',
  'jake', 'minimatch', 'rimraf', 'temp',
]

function report(overrides = {}) {
  const vulnerabilities = Object.fromEntries(affectedPackages.map((name) => [name, {
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

test('accepts only the reviewed electron-builder brace-expansion advisory baseline', () => {
  const result = validateDevelopmentAuditReport(report())
  assert.deepEqual(result.advisories, ['https://github.com/advisories/GHSA-mh99-v99m-4gvg'])
  assert.equal(result.affectedPackages.length, 16)
})

test('rejects a new advisory even when npm reports no critical vulnerability', () => {
  const input = report()
  input.vulnerabilities.ejs.via = [{
    url: 'https://github.com/advisories/GHSA-new-advisory',
    severity: 'high',
  }]
  assert.throws(() => validateDevelopmentAuditReport(input), /新增公告/)
})

test('rejects propagation-path and severity-count drift', () => {
  const changedPath = report()
  changedPath.vulnerabilities['new-build-package'] = {
    name: 'new-build-package', severity: 'high', via: ['brace-expansion'],
  }
  assert.throws(() => validateDevelopmentAuditReport(changedPath), /传播路径发生变化/)

  const critical = report()
  critical.metadata.vulnerabilities.critical = 1
  assert.throws(() => validateDevelopmentAuditReport(critical), /Critical/)
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
