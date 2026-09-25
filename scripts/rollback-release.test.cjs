const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const http = require('node:http')
const zlib = require('node:zlib')
const { createHash, generateKeyPairSync } = require('node:crypto')
const YAML = require('yaml')
const { spawnSync } = require('node:child_process')
const { RollbackInputError, inspectBackup, manifestVersion, planPlatform, requirePlainVersion, verifyBackup } = require('./rollback-release.cjs')
const { verifyManifestText } = require('./update-manifest-signature.cjs')

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

// #547：两个平台分开判断。
test('a platform already on the target version is skipped instead of blocking the other one', () => {
  // Windows 升到了坏的 0.2.11，Mac 还在 0.2.10，退回 0.2.10。
  assert.equal(planPlatform('0.2.11', '0.2.10'), 'rollback')
  assert.equal(planPlatform('0.2.10', 'v0.2.10'), 'skip')
  // 线上比目标还旧：不是回退，照样停下。
  assert.throws(() => planPlatform('0.2.9', '0.2.10'), /这不是回退/)
  assert.throws(() => planPlatform('0.2.10', '../0.2.9'), RollbackInputError)
})

function runPlanStep({ live, backups, releaseAssets }) {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'rollback-release.yml'), 'utf8'))
  const step = workflow.jobs.rollback.steps.find((entry) => /Check the backups/.test(String(entry.name)))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rollback-plan-'))
  const bin = path.join(workspace, 'bin')
  const scripts = path.join(workspace, 'scripts')
  const feed = path.join(workspace, 'feed')
  const electron = path.join(workspace, 'electron')
  const assets = path.join(workspace, 'assets')
  for (const directory of [bin, scripts, feed, electron, assets]) fs.mkdirSync(directory)
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'))
  // Windows 那份清单在 verify 之后要过更新包签名：真脚本照原样用，只把它读公钥的那个
  // 客户端源码换成一份只钉着本次临时公钥的，私钥经 secret 同名的环境变量交给它。
  for (const name of ['update-manifest-signature.cjs', 'update-release-utils.cjs', 'macos-artifact-names.cjs']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(scripts, name))
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pinned = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  fs.writeFileSync(path.join(electron, 'update-package-signature.ts'), `// update-signing-keys:begin\nexport const keys = [\n  '${pinned}',\n]\n// update-signing-keys:end\n`)
  // GitHub Release 上的安装包：缺省就是每个 Windows 备份引用的那个安装包本身。
  const published = releaseAssets ?? Object.fromEntries(Object.entries(backups)
    .filter(([name]) => name === 'latest.yml')
    .map(([, version]) => [`XingMang-AI-Manager-${version}-Setup.exe`, version]))
  for (const [name, content] of Object.entries(published)) fs.writeFileSync(path.join(assets, name), content)
  const gh = path.join(bin, 'gh')
  fs.writeFileSync(gh, `#!/bin/bash
dir=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--dir' ]; then dir=$2; shift; fi
  shift
done
mkdir -p "$dir"
cp ${JSON.stringify(assets)}/* "$dir"/ 2> /dev/null || exit 1
`)
  fs.chmodSync(gh, 0o755)
  // verify 要从更新目录完整下载安装包，那一半已由上面的用例在本机回环地址上验过；这里
  // 只看两个平台各自走哪条路，所以 verify 换成记一笔，其余命令照原样交给真脚本。
  fs.writeFileSync(path.join(scripts, 'rollback-release.cjs'), `const real = ${JSON.stringify(path.join(root, 'scripts', 'rollback-release.cjs'))}
if (require.main !== module) { module.exports = require(real); return }
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === 'verify') { console.log('VERIFY ' + args[args.indexOf('--name') + 1]); process.exit(0) }
const result = spawnSync(process.execPath, [real, ...args], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  for (const [name, version] of Object.entries(live)) fs.writeFileSync(path.join(feed, name), fs.readFileSync(writeManifestFile(workspace, version, name)))
  for (const [name, version] of Object.entries(backups)) {
    fs.mkdirSync(path.join(feed, 'manifests', version), { recursive: true })
    fs.writeFileSync(path.join(feed, 'manifests', version, name), fs.readFileSync(writeManifestFile(workspace, version, name)))
  }
  // 最后一个参数是地址，去掉更新目录前缀后在 feed 里找，没有就是 404。
  const curl = path.join(bin, 'curl')
  fs.writeFileSync(curl, `#!/bin/bash
output=''
while [ "$#" -gt 1 ]; do
  if [ "$1" = '--output' ]; then output=$2; shift; fi
  shift
done
file=${JSON.stringify(feed)}/\${1#https://updates.example.test/xingmang-manager/}
if [ -f "$file" ]; then cp "$file" "$output"; printf 200; else printf 404; fi
`)
  fs.chmodSync(curl, 0o755)
  const result = spawnSync('/bin/bash', ['-c', step.run], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: workspace,
      RUNNER_TEMP: workspace,
      GITHUB_OUTPUT: path.join(workspace, 'output'),
      PUBLIC_BASE: 'https://updates.example.test/xingmang-manager',
      TO_VERSION: '0.2.10',
      GITHUB_REPOSITORY: 'xufei5620/xingmang-ai-manager',
      XINGMANG_UPDATE_SIGNING_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    },
  })
  const outputs = fs.existsSync(path.join(workspace, 'output')) ? fs.readFileSync(path.join(workspace, 'output'), 'utf8') : ''
  const restoredPath = path.join(workspace, 'restore', 'latest.yml')
  const restored = fs.existsSync(restoredPath) ? fs.readFileSync(restoredPath, 'utf8') : null
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, log: result.stdout + result.stderr, outputs, restored, pinned }
}

function writeManifestFile(workspace, version, name) {
  const target = path.join(workspace, `fixture-${version}-${name}`)
  const file = `XingMang-AI-Manager-${version}-${name === 'latest.yml' ? 'Setup.exe' : 'arm64-mac.zip'}`
  const sha512 = createHash('sha512').update(version).digest('base64')
  fs.writeFileSync(target, YAML.stringify({ version, files: [{ url: file, sha512, size: 10 }], path: file, sha512, releaseDate: '2026-09-23T00:00:00.000Z' }))
  return target
}

const posixOnly = { skip: process.platform === 'win32' ? '工作流步骤是 bash，只在 POSIX 上跑' : false }

test('the rollback plan skips a platform already on the target and still rolls back the other', posixOnly, () => {
  const run = runPlanStep({
    live: { 'latest.yml': '0.2.10', 'latest-mac.yml': '0.2.11' },
    backups: { 'latest.yml': '0.2.10', 'latest-mac.yml': '0.2.10' },
  })
  assert.equal(run.status, 0, run.log)
  assert.match(run.log, /latest\.yml：线上已经是 0\.2\.10，这个平台不用退回/)
  assert.match(run.log, /VERIFY latest-mac\.yml/)
  assert.doesNotMatch(run.log, /VERIFY latest\.yml/)
  assert.match(run.outputs, /^platforms= latest-mac\.yml$/m)
  // 只撤回真正退回的那一边的线上版本。
  assert.match(run.outputs, /^withdrawn=0\.2\.11 $/m)
})

test('the rollback plan stops when no platform needs rolling back or one is older than the target', posixOnly, () => {
  const nothing = runPlanStep({
    live: { 'latest.yml': '0.2.10', 'latest-mac.yml': '0.2.10' },
    backups: { 'latest.yml': '0.2.10', 'latest-mac.yml': '0.2.10' },
  })
  assert.notEqual(nothing.status, 0)
  assert.match(nothing.log, /::error::没有哪个平台需要退回到 0\.2\.10/)
  const older = runPlanStep({
    live: { 'latest.yml': '0.2.11', 'latest-mac.yml': '0.2.9' },
    backups: { 'latest.yml': '0.2.10', 'latest-mac.yml': '0.2.10' },
  })
  assert.notEqual(older.status, 0)
  assert.match(older.log, /这不是回退/)
  assert.equal(older.outputs, '')
})

test('a Windows rollback to a pre-signature version is re-signed once GitHub Release has the same installer', posixOnly, () => {
  const run = runPlanStep({
    live: { 'latest.yml': '0.2.11', 'latest-mac.yml': '0.2.10' },
    backups: { 'latest.yml': '0.2.10', 'latest-mac.yml': '0.2.10' },
  })
  assert.equal(run.status, 0, run.log)
  assert.match(run.log, /老版本备份已核对 GitHub Release 并补签/)
  assert.match(run.outputs, /^platforms= latest\.yml$/m)
  // 写回去的正是补过签名、客户端内置公钥认得的那一份。
  assert.equal(verifyManifestText(run.restored, [run.pinned]), 1)
})

test('a Windows rollback stops when GitHub Release holds a different installer, and goes ahead unsigned when it holds none', posixOnly, () => {
  const swapped = runPlanStep({
    live: { 'latest.yml': '0.2.11' },
    backups: { 'latest.yml': '0.2.10' },
    releaseAssets: { 'XingMang-AI-Manager-0.2.10-Setup.exe': 'the genuine installer' },
  })
  assert.notEqual(swapped.status, 0)
  assert.match(swapped.log, /SHA-512 不一致/)
  assert.equal(swapped.outputs, '')
  const absent = runPlanStep({
    live: { 'latest.yml': '0.2.11' },
    backups: { 'latest.yml': '0.2.10' },
    releaseAssets: {},
  })
  assert.equal(absent.status, 0, absent.log)
  assert.match(absent.log, /::warning::GitHub Release 上找不到 XingMang-AI-Manager-0\.2\.10-Setup\.exe/)
  assert.match(absent.outputs, /^platforms= latest\.yml$/m)
})
