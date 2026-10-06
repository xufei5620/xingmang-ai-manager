const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  TRUFFLEHOG_IMAGE, TRUFFLEHOG_VERSION,
  scanRange, buildDetectorConfig, buildScanArgs, classifyFinding, describeFinding,
  annotation, parseResults, scanErrors, buildReport, reportLines, installTrufflehog, scanNewCommits,
} = require('./scan-new-commits-for-secrets.cjs')

// Built at run time so this file never holds a string its own rule would stop
// when the pull request that changes it is scanned.
const relayKey = `sk-${'a1B2'.repeat(12)}`
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const CONTAINER = 'f'.repeat(64)

// The relay rule the way TruffleHog applies it: the regex finds candidates,
// then any candidate an exclusion pattern matches is dropped.
function relayKeyMatches(text) {
  const [detector] = buildDetectorConfig().detectors
  const exclusions = detector.exclude_regexes_match.map((source) => new RegExp(source))
  return [...text.matchAll(new RegExp(detector.regex.key, 'g'))]
    .map((match) => match[0])
    .filter((candidate) => !exclusions.some((exclusion) => exclusion.test(candidate)))
}

// Shaped like a line of `trufflehog --json` output. Every field that carries
// the secret holds a marker, so a test can prove none of them is ever printed.
function result(fields = {}, location = {}) {
  return {
    SourceMetadata: { Data: { Git: { commit: 'c'.repeat(40), file: 'electron/config-files.ts', line: 12, ...location } } },
    DetectorName: 'Github',
    Verified: false,
    Raw: 'RAW-SECRET-MARKER',
    RawV2: 'RAWV2-SECRET-MARKER',
    Redacted: 'REDACTED-SECRET-MARKER',
    SecretParts: { key: 'PARTS-SECRET-MARKER' },
    ...fields,
  }
}

function relayResult(location) {
  return result({ DetectorName: 'CustomRegex', DetectorType: 904, ExtraData: { name: 'XingmangRelayKey' } }, location)
}

const secretMarkers = ['RAW-SECRET-MARKER', 'RAWV2-SECRET-MARKER', 'REDACTED-SECRET-MARKER', 'PARTS-SECRET-MARKER', 'ERROR-SECRET-MARKER']

function noWait() {
  return Promise.resolve()
}

function fakeDocker({ pullFailures = 0, pullStatus = 1, copyStatus = 0, versionStatus = 0, version = `trufflehog ${TRUFFLEHOG_VERSION}\n` } = {}) {
  const calls = []
  let pulls = 0
  function run(command, args) {
    calls.push([command, ...args])
    if (command === 'docker' && args[0] === 'pull') {
      pulls += 1
      if (pulls <= pullFailures) return { status: pullStatus, stdout: '', stderr: 'toomanyrequests' }
      return { status: 0, stdout: '', stderr: '' }
    }
    if (command === 'docker' && args[0] === 'create') return { status: 0, stdout: `${CONTAINER}\n`, stderr: '' }
    if (command === 'docker' && args[0] === 'cp') return { status: copyStatus, stdout: '', stderr: copyStatus ? 'Could not find the file' : '' }
    if (command === 'docker' && args[0] === 'rm') return { status: 0, stdout: CONTAINER, stderr: '' }
    // kingpin prints the version on stderr.
    if (args[0] === '--version') return { status: versionStatus, stdout: '', stderr: versionStatus === null ? 'spawnSync EACCES' : version }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
  return { run, calls }
}

// Stands in for git and for the scanner itself; docker goes to fakeDocker.
function fakeRunner({ missing = [], count = '3\n', scan = { status: 0, stdout: '', stderr: '' } } = {}) {
  const docker = fakeDocker()
  const calls = []
  const seen = { scanArgs: null, config: null }
  function run(command, args) {
    calls.push([command, ...args])
    if (command === 'git' && args[2] === 'cat-file') {
      return { status: missing.includes(args[4].replace('^{commit}', '')) ? 128 : 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && args[2] === 'rev-list') return { status: 0, stdout: count, stderr: '' }
    if (command !== 'docker' && args[0] === 'git') {
      seen.scanArgs = args
      const config = args.find((arg) => arg.startsWith('--config='))
      seen.config = JSON.parse(fs.readFileSync(config.slice('--config='.length), 'utf8'))
      return scan
    }
    return docker.run(command, args)
  }
  return { run, calls, seen }
}

function workspace(t, event, eventName = 'pull_request') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-secret-scan-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const eventPath = path.join(directory, 'event.json')
  fs.writeFileSync(eventPath, JSON.stringify(event))
  const summary = path.join(directory, 'summary.md')
  return {
    directory,
    summary,
    env: { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName, GITHUB_WORKSPACE: path.join(directory, 'repo'), GITHUB_STEP_SUMMARY: summary },
  }
}

const pullRequest = { pull_request: { base: { sha: BASE }, head: { sha: HEAD } } }

test('the relay rule catches a key new-api would issue wherever it is written', () => {
  // new-api (rc.24, common.GenerateKey) issues 48 characters from [0-9A-Za-z]
  // and shows them to the user behind `sk-`.
  assert.equal(relayKey.length, 3 + 48)
  assert.deepEqual(relayKeyMatches(relayKey), [relayKey])
  assert.deepEqual(relayKeyMatches(`OPENAI_API_KEY=${relayKey}\n`), [relayKey])
  assert.deepEqual(relayKeyMatches(`{"apiKey":"${relayKey}"}`), [relayKey])
  assert.deepEqual(relayKeyMatches(`Authorization: Bearer ${relayKey}`), [relayKey])
  assert.deepEqual(relayKeyMatches(`api_key = '${relayKey}' # 星芒`), [relayKey])
  const longest = `sk-${'Zz9'.repeat(21)}x`
  assert.equal(longest.length, 3 + 64)
  assert.deepEqual(relayKeyMatches(longest), [longest])
})

test('the relay rule leaves alone the fakes and other vendors this repository writes', () => {
  for (const text of [
    'sk-test',
    'sk-probe-abcdef',
    // The redaction tests' own fakes stay well short of a real key.
    `sk-${'abcdefghijklmnopqrstuvwxyz0123456789'}`,
    `sk-${'a'.repeat(47)}`,
    `sk-${'a'.repeat(65)}`,
    `sk-ant-api03-${'x'.repeat(95)}`,
    `sk-proj-${'x'.repeat(60)}`,
    // A word that merely ends in "sk-" is not the start of a key.
    `task-${'a'.repeat(48)}`,
  ]) {
    assert.deepEqual(relayKeyMatches(text), [], text)
  }
})

test('an old-format OpenAI key is left to the OpenAI check, which can verify it', () => {
  // When two rules match one string TruffleHog turns verification off for it,
  // so a live OpenAI key would come back as merely "unverified".
  const legacy = `sk-${'A1'.repeat(10)}${'T3Blbk'}FJ${'B2'.repeat(10)}`
  assert.equal(new RegExp(buildDetectorConfig().detectors[0].regex.key).test(legacy), true)
  assert.deepEqual(relayKeyMatches(legacy), [])
  assert.deepEqual(buildDetectorConfig().detectors[0].keywords, ['sk-'])
})

test('the range is what the pull request or push added, and nothing is guessed', () => {
  assert.deepEqual(scanRange({ pull_request: { base: { sha: BASE.toUpperCase() }, head: { sha: HEAD } } }, 'pull_request'), { base: BASE, head: HEAD })
  assert.deepEqual(scanRange({ before: BASE, after: HEAD }, 'push'), { base: BASE, head: HEAD })
  // A push that creates a branch has no lower end. All of head's history is
  // more than was asked, never less.
  assert.deepEqual(scanRange({ before: '0'.repeat(40), after: HEAD }, 'push'), { base: '', head: HEAD })
  // Deleting a branch adds nothing to scan, and a malformed event is refused.
  assert.equal(scanRange({ before: BASE, after: '0'.repeat(40) }, 'push'), null)
  assert.equal(scanRange({ before: BASE, after: 'main' }, 'push'), null)
  assert.equal(scanRange({ pull_request: { base: { sha: BASE } } }, 'pull_request'), null)
  // A pull request event never falls back to the push fields.
  assert.equal(scanRange({ before: BASE, after: HEAD }, 'pull_request'), null)
  assert.equal(scanRange(null, 'push'), null)
})

test('the scanner is asked for every verdict and never told to skip verification', () => {
  const args = buildScanArgs({ repository: '/work/repo', base: BASE, head: HEAD, configPath: '/tmp/scan/detectors.json' })
  assert.deepEqual(args.slice(0, 4), ['git', 'file:///work/repo', '--branch', HEAD])
  assert.equal(args[args.indexOf('--since-commit') + 1], BASE)
  for (const flag of [
    '--json',
    '--results=verified,unknown,unverified',
    // The URI detector "verifies" by requesting the URL it found, and our
    // tests hold fake credentials in URLs on the production hosts.
    '--exclude-detectors=URI',
    '--config=/tmp/scan/detectors.json',
    // Otherwise a range it could not read exits 0 with nothing found.
    '--fail-on-scan-errors',
    '--no-update',
  ]) {
    assert.ok(args.includes(flag), flag)
  }
  // Verification is what tells a live key from the fakes in our tests.
  assert.equal(args.some((arg) => /no-verification|allow-verification-overlap|trust-local-git-config|filter-unverified/.test(arg)), false)
  assert.equal(buildScanArgs({ repository: '/work/repo', base: '', head: HEAD, configPath: '/c' }).includes('--since-commit'), false)
})

test('only a key that still works or one shaped like a relay key blocks the merge', () => {
  assert.equal(classifyFinding(result({ Verified: true })), 'live')
  assert.equal(classifyFinding(relayResult()), 'relay-key')
  // A relay-shaped key the verifier also confirmed is blocked either way.
  assert.equal(classifyFinding({ ...relayResult(), Verified: true }), 'live')
  // Somebody else's custom rule is not ours to enforce.
  assert.equal(classifyFinding(result({ DetectorName: 'CustomRegex', ExtraData: { name: 'Other' } })), 'unconfirmed')
  // A verifier that could not reach the vendor proves nothing either way.
  assert.equal(classifyFinding(result({ DetectorName: 'OpenAI', VerificationError: 'dial tcp: i/o timeout' })), 'unchecked')
  // A private key has no API to try, so "unverified" is not "fake".
  assert.equal(classifyFinding(result({ DetectorName: 'PrivateKey' })), 'unchecked')
  assert.equal(classifyFinding(result({ DetectorName: 'Anthropic' })), 'unconfirmed')
  assert.equal(classifyFinding({}), 'unconfirmed')

  const report = buildReport([
    result({ Verified: true }),
    relayResult(),
    result({ DetectorName: 'PrivateKey' }),
    result({ DetectorName: 'Anthropic' }),
  ])
  assert.deepEqual([report.blocking.length, report.unchecked.length, report.unconfirmed.length], [2, 1, 1])
})

test('nothing printed carries the secret or the verifier error text', () => {
  const report = buildReport([
    result({ Verified: true, ExtraData: { rotation_guide: 'https://howtorotate.com/docs/tutorials/github/', username: 'someone' } }),
    relayResult(),
    // A verifier error can quote the request URL, query string and all.
    result({ DetectorName: 'OpenAI', VerificationError: 'Get "https://api.example/v1/check?key=ERROR-SECRET-MARKER": timeout' }),
    result({ DetectorName: 'Anthropic' }),
  ])
  const printed = [
    ...report.blocking.map((finding) => annotation('error', finding)),
    ...report.unchecked.map((finding) => annotation('warning', finding)),
    ...reportLines(report, '这次新加的 4 个提交'),
  ].join('\n')
  for (const marker of secretMarkers) assert.equal(printed.includes(marker), false, marker)
  assert.ok(printed.includes('https://howtorotate.com/docs/tutorials/github/'))
  assert.ok(printed.includes('electron/config-files.ts:12（提交 ccccccc）'))
})

test('a rotation guide is linked only when it points at howtorotate.com', () => {
  for (const guide of ['https://evil.example/rotate', 'https://howtorotate.com.evil.example/x', 'javascript:alert(1)', 42]) {
    assert.equal(describeFinding(result({ Verified: true, ExtraData: { rotation_guide: guide } })).rotationGuide, '', String(guide))
  }
})

test('an annotation lands on the file and line and cannot be cut short by a file name', () => {
  const finding = describeFinding(relayResult({ file: 'docs/a,b:c.md', line: 7 }))
  const line = annotation('error', finding)
  assert.ok(line.startsWith('::error file=docs/a%2Cb%3Ac.md,line=7,title=发现星芒 Key::'), line)
  assert.ok(line.endsWith('（提交 ccccccc）'), line)
  assert.equal(/[\r\n]/.test(line), false)
  // Without a location the annotation still shows, just not on a file.
  assert.ok(annotation('error', describeFinding({ Verified: true, DetectorName: 'AWS' })).startsWith('::error title=发现还能用的 AWS 密钥::'))
  assert.match(reportLines(buildReport([{ Verified: true, DetectorName: 'AWS' }]), '这次新加的 1 个提交')[1], /^- 位置不明：AWS。/)

  // A line break in a file name would start a log line of its own, and the
  // runner reads a log line that starts with `::` as a command.
  const hostile = relayResult({ file: 'a\n::add-mask::x\r.txt' })
  assert.equal(/[\r\n]/.test(describeFinding(hostile).file), false)
  assert.equal(reportLines(buildReport([hostile]), '这次新加的 1 个提交').some((text) => /[\r\n]/.test(text)), false)
})

test('output that cannot be read fails the scan instead of passing it', () => {
  assert.deepEqual(parseResults(''), [])
  assert.deepEqual(parseResults(`${JSON.stringify({ a: 1 })}\n\n${JSON.stringify({ b: 2 })}\r\n`), [{ a: 1 }, { b: 2 }])
  // The unreadable line is never echoed: it is scanner output and may hold the key.
  assert.throws(() => parseResults(`{"a":1}\nnot json ${relayKey}`), (error) => /不能当作通过/.test(error.message) && !error.message.includes(relayKey))
  assert.throws(() => parseResults('[1,2]'), /不能当作通过/)
  assert.throws(() => parseResults('null'), /不能当作通过/)
})

test('a scan that stops early is explained with the error lines the scanner logged', () => {
  const stderr = [
    JSON.stringify({ level: 'info-0', msg: 'running source' }),
    'panic: not json',
    JSON.stringify({ level: 'error', msg: 'encountered errors during scan', errors: ['bad revision', 'clone failed'] }),
  ].join('\n')
  assert.deepEqual(scanErrors(stderr), ['encountered errors during scan：bad revision；clone failed'])
  assert.ok(scanErrors(JSON.stringify({ level: 'error', msg: 'x', error: 'y'.repeat(2000) }))[0].length <= 500)
  // Quoted error text stays on one line, so none of it can start a workflow command.
  assert.deepEqual(scanErrors(JSON.stringify({ level: 'error', msg: 'bad', error: 'one\n::error::two' })), ['bad：one ::error::two'])
})

test('the scanner comes out of the image pinned by digest and must be the pinned release', async () => {
  // A tag can be moved to other bytes after review; a digest cannot.
  assert.match(TRUFFLEHOG_IMAGE, /^ghcr\.io\/trufflesecurity\/trufflehog@sha256:[0-9a-f]{64}$/)
  const docker = fakeDocker({ pullFailures: 2 })
  const waits = []
  const binary = await installTrufflehog({ run: docker.run, directory: '/tmp/scan', wait: (milliseconds) => { waits.push(milliseconds); return noWait() } })
  assert.equal(binary, path.join('/tmp/scan', 'trufflehog'))
  assert.deepEqual(waits, [10_000, 20_000])
  for (const call of docker.calls.filter(([command, verb]) => command === 'docker' && ['pull', 'create'].includes(verb))) {
    assert.equal(call[2], TRUFFLEHOG_IMAGE)
  }
  // Copied out and run on the runner, never through the image's entrypoint.
  assert.equal(docker.calls.some(([command, verb]) => command === 'docker' && verb === 'run'), false)
  assert.deepEqual(docker.calls.find(([, verb]) => verb === 'cp'), ['docker', 'cp', `${CONTAINER}:/usr/bin/trufflehog`, binary])
  assert.deepEqual(docker.calls.find(([, verb]) => verb === 'rm'), ['docker', 'rm', CONTAINER])
  assert.deepEqual(docker.calls.at(-1), [binary, '--version'])
})

test('a scanner that cannot be had or is not the pinned release fails the scan', async () => {
  const flaky = fakeDocker({ pullFailures: 3 })
  await assert.rejects(installTrufflehog({ run: flaky.run, directory: '/tmp/scan', wait: noWait }), /试了 3 次[\s\S]*不能当作通过/)
  assert.equal(flaky.calls.some(([, verb]) => verb === 'create'), false)

  // No docker at all will not appear on a retry, so nothing waits for one.
  const waits = []
  const absent = fakeDocker({ pullFailures: 1, pullStatus: null })
  await assert.rejects(installTrufflehog({ run: absent.run, directory: '/tmp/scan', wait: (milliseconds) => { waits.push(milliseconds); return noWait() } }), /运行不了 docker/)
  assert.deepEqual(waits, [])

  // The container is removed even when the copy out of it failed.
  const broken = fakeDocker({ copyStatus: 1 })
  await assert.rejects(installTrufflehog({ run: broken.run, directory: '/tmp/scan', wait: noWait }), /取出程序/)
  assert.ok(broken.calls.some(([, verb]) => verb === 'rm'))

  await assert.rejects(installTrufflehog({ run: fakeDocker({ versionStatus: null }).run, directory: '/tmp/scan', wait: noWait }), /取出的程序运行不了/)
  for (const version of ['trufflehog 3.97.8', 'trufflehog 13.97.9', 'trufflehog 3.97.91', 'trufflehog v3.97.9x', 'trufflehog dev']) {
    await assert.rejects(installTrufflehog({ run: fakeDocker({ version }).run, directory: '/tmp/scan', wait: noWait }), /不是钉住的/, version)
  }
})

test('a clean pull request passes and says how much was scanned', async (t) => {
  const { env, summary } = workspace(t, pullRequest)
  const runner = fakeRunner()
  const logs = []
  const report = await scanNewCommits({ env, run: runner.run, log: (line) => logs.push(line), wait: noWait })
  assert.equal(report.blocking.length, 0)
  assert.deepEqual(logs, ['已扫这次新加的 3 个提交：没发现还能用的密钥，也没有星芒 Key。'])
  assert.match(fs.readFileSync(summary, 'utf8'), /^### 密钥扫描\n\n已扫这次新加的 3 个提交/)
  assert.deepEqual(runner.seen.scanArgs.slice(0, 4), ['git', `file://${env.GITHUB_WORKSPACE}`, '--branch', HEAD])
  assert.equal(runner.seen.scanArgs[runner.seen.scanArgs.indexOf('--since-commit') + 1], BASE)
  // The scanner read the rule file this script wrote for it.
  assert.deepEqual(runner.seen.config, buildDetectorConfig())
})

test('a key that must be handled fails the run and is pointed at, not printed', async (t) => {
  const { env, summary } = workspace(t, pullRequest)
  const stdout = [relayResult({ file: 'electron/x.ts', line: 3 }), result({ DetectorName: 'Anthropic' })]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  const runner = fakeRunner({ scan: { status: 0, stdout, stderr: '' } })
  const logs = []
  const report = await scanNewCommits({ env, run: runner.run, log: (line) => logs.push(line), wait: noWait })
  assert.equal(report.blocking.length, 1)
  assert.ok(logs[0].startsWith('::error file=electron/x.ts,line=3,title=发现星芒 Key::'), logs[0])
  assert.match(logs[1], /^这次新加的 3 个提交里发现 1 处必须处理的密钥，这次改动不能合并：/)
  const printed = `${logs.join('\n')}\n${fs.readFileSync(summary, 'utf8')}`
  for (const marker of secretMarkers) assert.equal(printed.includes(marker), false, marker)
})

test('a scan that did not finish never reads as a pass', async (t) => {
  const { env } = workspace(t, pullRequest)
  const stderr = JSON.stringify({ level: 'error', msg: 'encountered errors during scan', errors: ['bad revision'] })
  const runner = fakeRunner({ scan: { status: 1, stdout: '', stderr } })
  await assert.rejects(scanNewCommits({ env, run: runner.run, log: () => {}, wait: noWait }), /没扫完（退出码 1）[\s\S]*bad revision/)
  // Raw output from a crash is quoted on one line for the same reason.
  const crashed = fakeRunner({ scan: { status: 2, stdout: '', stderr: 'panic: boom\n::warning::x\ngoroutine 1' } })
  await assert.rejects(scanNewCommits({ env, run: crashed.run, log: () => {}, wait: noWait }), (error) => /panic: boom/.test(error.message) && !/[\r\n]/.test(error.message))
})

test('a base commit missing from the checkout widens the scan to all of head', async (t) => {
  const { env } = workspace(t, pullRequest)
  const runner = fakeRunner({ missing: [BASE], count: '922\n' })
  const logs = []
  await scanNewCommits({ env, run: runner.run, log: (line) => logs.push(line), wait: noWait })
  assert.equal(runner.seen.scanArgs.includes('--since-commit'), false)
  assert.match(logs[0], /找不到起点提交 aaaaaaa/)
  assert.equal(logs.at(-1), '已扫到 bbbbbbb 为止的整段历史（922 个提交）：没发现还能用的密钥，也没有星芒 Key。')
  assert.deepEqual(runner.calls.find((call) => call[0] === 'git' && call[3] === 'rev-list'), ['git', '-C', env.GITHUB_WORKSPACE, 'rev-list', '--count', HEAD])
})

test('a run that cannot tell what to scan fails before pulling anything', async (t) => {
  const { env, directory } = workspace(t, pullRequest)
  const missingHead = fakeRunner({ missing: [HEAD] })
  await assert.rejects(scanNewCommits({ env, run: missingHead.run, log: () => {}, wait: noWait }), /找不到要扫的提交 bbbbbbb/)
  assert.equal(missingHead.calls.some(([command]) => command === 'docker'), false)

  const unread = fakeRunner()
  await assert.rejects(scanNewCommits({ env: { ...env, GITHUB_EVENT_PATH: path.join(directory, 'missing.json') }, run: unread.run, log: () => {}, wait: noWait }), /读不到这次触发的事件信息/)
  const empty = workspace(t, { pull_request: {} })
  await assert.rejects(scanNewCommits({ env: empty.env, run: unread.run, log: () => {}, wait: noWait }), /没有这次改动的提交范围/)
  assert.equal(unread.calls.some(([command]) => command === 'docker'), false)
})

test('the copied scanner and its rule file are removed whether the scan passed or not', async (t) => {
  const { env } = workspace(t, pullRequest)
  for (const scan of [{ status: 0, stdout: '', stderr: '' }, { status: 2, stdout: '', stderr: 'panic: boom' }]) {
    const runner = fakeRunner({ scan })
    await scanNewCommits({ env, run: runner.run, log: () => {}, wait: noWait }).catch(() => {})
    const copiedTo = runner.calls.find(([command, verb]) => command === 'docker' && verb === 'cp')[3]
    assert.equal(fs.existsSync(path.dirname(copiedTo)), false)
  }
})

test('a scanner named in XINGMANG_TRUFFLEHOG is used instead of the image', async (t) => {
  const { env } = workspace(t, pullRequest)
  const runner = fakeRunner()
  await scanNewCommits({ env: { ...env, XINGMANG_TRUFFLEHOG: '/opt/trufflehog' }, run: runner.run, log: () => {}, wait: noWait })
  assert.equal(runner.calls.some(([command]) => command === 'docker'), false)
  assert.ok(runner.calls.some(([command, first]) => command === '/opt/trufflehog' && first === 'git'))
})
