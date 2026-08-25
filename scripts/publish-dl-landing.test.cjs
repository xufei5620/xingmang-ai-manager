const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  assertSafeVersion,
  installerFileNames,
  buildLatestManifest,
  formatLatestJson,
  parsePublishArgs,
  collectInstallers,
  missingInstallerMessage,
  pickWindowsArtifact,
  buildPublishPlan,
  publishDlLanding,
} = require('./publish-dl-landing.cjs')

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-dl-landing-test-'))
}

test('accepts a dotted release version and rejects a path-like value', () => {
  assert.equal(assertSafeVersion('0.1.22'), '0.1.22')
  assert.equal(assertSafeVersion('1.2.3-beta.1'), '1.2.3-beta.1')
  assert.throws(() => assertSafeVersion('../etc/passwd'), /版本号不合法/)
  assert.throws(() => assertSafeVersion(''), /版本号不合法/)
})

test('names landing installers after the electron-builder artifacts', () => {
  assert.deepEqual(installerFileNames('0.1.22'), {
    win: 'XingMang-AI-Manager-0.1.22-Setup.exe',
    macArm64: 'XingMang-AI-Manager-0.1.22-arm64.dmg',
    macX64: 'XingMang-AI-Manager-0.1.22-x64.dmg',
    windowsArtifact: 'windows-release-0.1.22',
    testSignedArtifact: 'TEST-SIGNED-DO-NOT-PUBLISH-0.1.22',
  })
})

test('builds latest.json paths that match those installer file names', () => {
  assert.deepEqual(buildLatestManifest('0.1.22'), {
    version: '0.1.22',
    win: '/files/latest/XingMang-AI-Manager-0.1.22-Setup.exe',
    macArm64: '/files/latest/XingMang-AI-Manager-0.1.22-arm64.dmg',
    macX64: '/files/latest/XingMang-AI-Manager-0.1.22-x64.dmg',
  })
  assert.equal(
    formatLatestJson(buildLatestManifest('0.1.22')),
    `${JSON.stringify(buildLatestManifest('0.1.22'), null, 2)}\n`,
  )
})

test('parses operator flags and treats dry-run as a non-upload', () => {
  const options = parsePublishArgs([
    '--version', '0.1.22',
    '--local-dir', 'C:\\bags',
    '--mac-dir', 'D:\\mac',
    '--run-id', '99',
    '--dry-run',
    '--yes',
    '--port', '5620',
  ], { version: '9.9.9' })
  assert.equal(options.version, '0.1.22')
  assert.equal(options.localDir, 'C:\\bags')
  assert.equal(options.macDir, 'D:\\mac')
  assert.equal(options.runId, '99')
  assert.equal(options.dryRun, true)
  assert.equal(options.yes, false)
  assert.equal(options.port, 5620)
})

test('collects the three landing files and ignores update extras', () => {
  const directory = scratch()
  try {
    const nested = path.join(directory, 'windows-release-0.1.22')
    fs.mkdirSync(nested, { recursive: true })
    const names = installerFileNames('0.1.22')
    fs.writeFileSync(path.join(nested, names.win), 'exe')
    fs.writeFileSync(path.join(nested, `${names.win}.blockmap`), 'map')
    fs.writeFileSync(path.join(nested, 'latest.yml'), 'yml')
    fs.writeFileSync(path.join(directory, names.macArm64), 'arm')
    fs.writeFileSync(path.join(directory, names.macX64), 'intel')
    fs.writeFileSync(path.join(directory, `XingMang-AI-Manager-0.1.22-arm64.zip`), 'zip')

    const found = collectInstallers([directory], names)
    assert.equal(path.basename(found.win), names.win)
    assert.equal(path.basename(found.macArm64), names.macArm64)
    assert.equal(path.basename(found.macX64), names.macX64)
    assert.equal(missingInstallerMessage(names, found), '')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('explains that mac installers are not in the Windows GitHub artifact', () => {
  const names = installerFileNames('0.1.22')
  const message = missingInstallerMessage(names, { win: 'a.exe', macArm64: '', macX64: '' })
  assert.match(message, /XingMang-AI-Manager-0.1.22-arm64.dmg/)
  assert.match(message, /release-build 只出 Windows/)
})

test('picks the newest unexpired windows-release artifact and refuses a test-signed-only set', () => {
  const artifacts = [
    {
      name: 'windows-release-0.1.22',
      expired: false,
      created_at: '2026-08-01T00:00:00Z',
      workflow_run: { id: 11 },
      id: 1,
    },
    {
      name: 'windows-release-0.1.22',
      expired: false,
      created_at: '2026-08-25T00:00:00Z',
      workflow_run: { id: 22 },
      id: 2,
    },
    {
      name: 'TEST-SIGNED-DO-NOT-PUBLISH-0.1.22',
      expired: false,
      created_at: '2026-08-26T00:00:00Z',
      workflow_run: { id: 33 },
      id: 3,
    },
  ]
  assert.deepEqual(pickWindowsArtifact(artifacts, '0.1.22'), {
    name: 'windows-release-0.1.22',
    id: 2,
    runId: 22,
    size: undefined,
  })
  assert.equal(pickWindowsArtifact([], '0.1.22'), null)
  assert.throws(
    () => pickWindowsArtifact(artifacts.filter((item) => item.name.startsWith('TEST-')), '0.1.22'),
    /自签名测试包/,
  )
})

test('plans scp destinations under the landing files directory', () => {
  const names = installerFileNames('0.1.22')
  const plan = buildPublishPlan(
    { version: '0.1.22', remoteRoot: '/www/wwwroot/dl.solov.cc' },
    { win: 'w.exe', macArm64: 'a.dmg', macX64: 'x.dmg' },
    names,
  )
  assert.equal(plan.uploads[0].remoteDir, '/www/wwwroot/dl.solov.cc/files/latest')
  assert.equal(plan.manifestRemote, '/www/wwwroot/dl.solov.cc/latest.json')
  assert.equal(plan.manifest.win, `/files/latest/${names.win}`)
})

test('does not scp until --yes and writes the local manifest only after a successful upload', () => {
  const directory = scratch()
  const names = installerFileNames('0.1.22')
  const commands = []
  try {
    fs.mkdirSync(path.join(directory, 'dl-landing'), { recursive: true })
    fs.writeFileSync(path.join(directory, names.win), 'exe')
    fs.writeFileSync(path.join(directory, names.macArm64), 'arm')
    fs.writeFileSync(path.join(directory, names.macX64), 'intel')

    const preview = publishDlLanding({
      version: '0.1.22',
      localDir: directory,
      yes: false,
      key: path.join(directory, 'id'),
      cwd: directory,
    }, {
      collectInstallers,
      downloadWindowsArtifact() {
        throw new Error('should not download when --local-dir is set')
      },
      runTool() {
        throw new Error('should not ssh on a preview run')
      },
      cwd: directory,
    })
    assert.equal(preview.uploaded, false)
    assert.equal(fs.existsSync(path.join(directory, 'dl-landing', 'latest.json')), false)

    fs.writeFileSync(path.join(directory, 'id'), 'key')
    const uploaded = publishDlLanding({
      version: '0.1.22',
      localDir: directory,
      yes: true,
      host: '203.0.113.9',
      user: 'root',
      key: path.join(directory, 'id'),
      remoteRoot: '/www/wwwroot/dl.solov.cc',
      cwd: directory,
    }, {
      collectInstallers,
      downloadWindowsArtifact() {
        throw new Error('should not download when --local-dir is set')
      },
      runTool(command, args) {
        commands.push([command, ...args])
        return { status: 0, stdout: '{"version":"0.1.22"}\n', stderr: '' }
      },
      writeFile: (filePath, body) => fs.writeFileSync(filePath, body, 'utf8'),
      cwd: directory,
    })
    assert.equal(uploaded.uploaded, true)
    assert.ok(commands.some((line) => line[0] === 'scp' && line.includes(path.join(directory, names.win))))
    assert.ok(commands.some((line) => line[0] === 'scp' && line.some((arg) => String(arg).endsWith('/latest.json'))))
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, 'dl-landing', 'latest.json'), 'utf8')),
      buildLatestManifest('0.1.22'),
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
