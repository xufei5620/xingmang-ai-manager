const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash } = require('node:crypto')
const YAML = require('yaml')
const { RollbackInputError, inspectBackup, manifestVersion, requirePlainVersion } = require('./rollback-release.cjs')

const root = path.resolve(__dirname, '..')

function writeManifest(version, name = 'latest.yml') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rollback-'))
  const sha512 = createHash('sha512').update(version).digest('base64')
  const file = `XingMang-AI-Manager-${version}-Setup.exe`
  const text = YAML.stringify({ version, files: [{ url: file, sha512, size: 10 }], path: file, sha512, releaseDate: '2026-09-23T00:00:00.000Z' })
  const target = path.join(directory, name)
  fs.writeFileSync(target, text)
  return { target, file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('reads the version of a manifest so it can be backed up under it', () => {
  const manifest = writeManifest('0.2.9')
  try {
    assert.equal(manifestVersion(manifest.target, 'latest.yml'), '0.2.9')
    assert.throws(() => manifestVersion(manifest.target, 'latest-linux.yml'), RollbackInputError)
  } finally { manifest.cleanup() }
})

test('only accepts a backup of the requested, older version and lists the installers it needs', () => {
  const manifest = writeManifest('0.2.9')
  try {
    assert.deepEqual(inspectBackup(manifest.target, 'latest.yml', 'v0.2.9', '0.2.10'), [manifest.file])
    assert.throws(() => inspectBackup(manifest.target, 'latest.yml', '0.2.8', '0.2.10'), /不是要退回的 0\.2\.8/)
    assert.throws(() => inspectBackup(manifest.target, 'latest.yml', '0.2.9', '0.2.9'), /这不是回退/)
    assert.throws(() => inspectBackup(manifest.target, 'latest.yml', '0.2.9', '0.2.8'), /这不是回退/)
  } finally { manifest.cleanup() }
})

test('refuses version strings that could not safely become part of an object path', () => {
  for (const value of ['../0.2.9', '0.2.9/..', '0.2', '0.2.9-beta', '', 'latest']) {
    assert.throws(() => requirePlainVersion(value, '版本'), RollbackInputError)
  }
})

test('publishing backs up the live manifests before any of them is overwritten', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-release.yml'), 'utf8'))
  const step = workflow.jobs.publish.steps.find((entry) => /Publish the update manifests/.test(String(entry.name)))
  const script = String(step.run)
  const backup = script.indexOf('manifests/$live/$manifest')
  const ownCopy = script.indexOf('manifests/$PACKAGE_VERSION/$manifest')
  const overwrite = script.indexOf('"s3://$R2_BUCKET/$OBJECT_PREFIX/$manifest"')
  assert.ok(backup > 0 && ownCopy > backup && overwrite > ownCopy, '备份必须排在覆盖根目录清单之前')
  assert.match(script, /\*\) echo "::error::读取线上 \$manifest 失败/)
})

test('the rollback workflow checks everything first, withdraws the bad version, then restores', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'rollback-release.yml'), 'utf8'))
  const job = workflow.jobs.rollback
  assert.equal(job.environment, 'release')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const names = job.steps.map((step) => String(step.name ?? step.uses ?? step.run))
  const plan = names.findIndex((name) => /Check the backups/.test(name))
  const withdraw = names.findIndex((name) => /Withdraw the live version/.test(name))
  const restore = names.findIndex((name) => /Put the backup manifests back/.test(name))
  const verify = names.findIndex((name) => /Re-verify/.test(name))
  assert.ok(plan >= 0 && withdraw > plan && restore > withdraw && verify > restore)
  for (const step of job.steps) {
    assert.doesNotMatch(String(step.run ?? ''), /\$\{\{\s*(inputs|github\.event)\./, `${step.name} must read inputs through env`)
    if (step.name && !/Withdraw|Put the backup/.test(step.name)) assert.doesNotMatch(String(step.run ?? ''), /aws s3 cp/)
  }
})
