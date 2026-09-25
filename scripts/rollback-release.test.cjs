const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const http = require('node:http')
const zlib = require('node:zlib')
const { createHash } = require('node:crypto')
const YAML = require('yaml')
const { RollbackInputError, inspectBackup, manifestVersion, requirePlainVersion, verifyBackup } = require('./rollback-release.cjs')

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

// #494：一个假的更新目录，只在本机回环地址上，不碰线上。
async function withFeed(files, run) {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.replace(/^\/xingmang-manager\//, ''))
    const body = files[name]
    if (body === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}/xingmang-manager/`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function backupFixture() {
  const installer = Buffer.from('the 0.2.9 installer bytes')
  const name = 'XingMang-AI-Manager-0.2.9-Setup.exe'
  const sha512 = createHash('sha512').update(installer).digest('base64')
  const blockmap = zlib.gzipSync(JSON.stringify({
    version: '2',
    files: [{ name: 'file', offset: 0, sizes: [installer.length], checksums: ['AAAA'] }],
  }))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rollback-verify-'))
  const manifest = path.join(directory, 'latest.yml')
  fs.writeFileSync(manifest, YAML.stringify({
    version: '0.2.9',
    files: [{ url: name, sha512, size: installer.length }],
    path: name,
    sha512,
    releaseDate: '2026-09-23T00:00:00.000Z',
  }))
  return { installer, name, blockmap, manifest, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('a backup passes only when every installer it names downloads byte for byte', async () => {
  const fixture = backupFixture()
  try {
    const options = { file: fixture.manifest, name: 'latest.yml', expected: '0.2.9', live: '0.2.10', allowLocalHttp: true }
    await withFeed({ [fixture.name]: fixture.installer, [`${fixture.name}.blockmap`]: fixture.blockmap }, async (baseUrl) => {
      await verifyBackup({ ...options, baseUrl })
    })
    // 200 但内容被同名覆盖：长度一样，字节不一样。
    const tampered = Buffer.from(fixture.installer)
    tampered[0] ^= 0xff
    await withFeed({ [fixture.name]: tampered, [`${fixture.name}.blockmap`]: fixture.blockmap }, async (baseUrl) => {
      await assert.rejects(verifyBackup({ ...options, baseUrl }), /SHA-512 不匹配/)
    })
    await withFeed({ [fixture.name]: fixture.installer.subarray(1), [`${fixture.name}.blockmap`]: fixture.blockmap }, async (baseUrl) => {
      await assert.rejects(verifyBackup({ ...options, baseUrl }), (error) => error.code === 'REMOTE_ARTIFACT_SIZE_MISMATCH')
    })
    await withFeed({ [fixture.name]: fixture.installer }, async (baseUrl) => {
      await assert.rejects(verifyBackup({ ...options, baseUrl }), /blockmap/)
    })
    await withFeed({ [fixture.name]: fixture.installer, [`${fixture.name}.blockmap`]: fixture.blockmap }, async (baseUrl) => {
      await assert.rejects(verifyBackup({ ...options, expected: '0.2.8', baseUrl }), RollbackInputError)
    })
  } finally { fixture.cleanup() }
})

test('the rollback workflow fully verifies every backup before it writes anything', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'rollback-release.yml'), 'utf8'))
  const steps = workflow.jobs.rollback.steps
  const plan = steps.findIndex((step) => /Check the backups/.test(String(step.name)))
  const firstWrite = steps.findIndex((step) => /aws s3 cp/.test(String(step.run ?? '')))
  assert.ok(plan >= 0 && firstWrite > plan)
  const script = String(steps[plan].run)
  assert.match(script, /node scripts\/rollback-release\.cjs verify --manifest "\$RUNNER_TEMP\/restore\/\$manifest"/)
  assert.match(script, /--base "\$PUBLIC_BASE"/)
  // 只 HEAD 一下确认「在」正是 #494 那个缺口，别让它以别的写法回来。
  assert.doesNotMatch(script, /--head/)
  // 认签名的新客户端只装带签名的 Windows 包：恢复的 latest.yml 必须在写回之前验签，
  // 或对过 GitHub Release 后补签。
  const verifyAt = script.indexOf('rollback-release.cjs verify')
  const signAt = script.indexOf('update-manifest-signature.cjs rollback --manifest "$RUNNER_TEMP/restore/$manifest"')
  assert.ok(verifyAt >= 0 && signAt > verifyAt)
  assert.match(script, /gh release download "v\$target"/)
})
