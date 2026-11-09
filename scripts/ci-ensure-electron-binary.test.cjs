const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const { attemptTimeoutMs, describeAttempt, downloadElectronZip, ensureElectronBinary, ensureElectronZip, parseArguments, retryDelaysSeconds, zipArchitectures } = require('./ci-ensure-electron-binary.cjs')
const { resolveLockedElectronZipChecksums } = require('./electron-zip-checksums.cjs')

const root = path.resolve(__dirname, '..')
const workflowDirectory = path.join(root, '.github', 'workflows')
const installCommand = 'node scripts/ci-ensure-electron-binary.cjs'
const workflows = new Map(fs.readdirSync(workflowDirectory)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => [name, YAML.parse(fs.readFileSync(path.join(workflowDirectory, name), 'utf8'))]))

// The e2e entry points that start the Electron binary from node_modules
// themselves, through Playwright's _electron or a direct import, as opposed to
// a browser fixture or the packaged app.
const electronE2eScripts = new Set(fs.readdirSync(path.join(root, 'e2e'))
  .filter((name) => /\.[cm]?js$/.test(name))
  .filter((name) => /_electron\b|from ['"]electron['"]|require\(['"]electron['"]\)/.test(fs.readFileSync(path.join(root, 'e2e', name), 'utf8')))
  .map((name) => `e2e/${name}`))

// Commands that reach require('electron'): the vitest suites over electron/ and
// src/ (so `npm test` and the release gates that run it), the macOS dev-origin
// check and the e2e scripts above. test:v2:vitest, test:canvas, test:scripts
// and test:browser were run with the binary removed and the download pointed
// at a dead mirror on 2026-10-03, and none of them asked for it.
function needsElectronBinary(command) {
  if (/\bnpm (?:run )?test(?![\w:-])/.test(command)) return true
  if (/\bnpm run (?:test:vitest|test:mac:dev-origin|release:build|dist:mac:free)\b/.test(command)) return true
  // The local all-in-one builds run `npm test` first; their :ci and :dir siblings do not.
  if (/\bnpm run build(?::mac|:linux)?(?![\w:-])/.test(command)) return true
  return [...command.matchAll(/\bnode (?:--test )?(?:\.\/)?(e2e\/[\w.-]+)/g)].some((match) => electronE2eScripts.has(match[1]))
}

// @electron/get's default download folder (env-paths 'electron', no suffix) on
// each hosted runner; XDG_CACHE_HOME is unset on the Ubuntu ones, where
// Playwright's browsers land in /home/runner/.cache/ms-playwright.
// electron-builder downloads Electron through the same library into the same
// folder, which is what lets the packaging steps reuse the restored zip.
const electronCacheByRunner = [
  [/^windows-/, '~/AppData/Local/electron/Cache'],
  [/^macos-/, '~/Library/Caches/electron'],
  [/^ubuntu-/, '~/.cache/electron'],
]

function defaultElectronCache(runsOn) {
  const match = electronCacheByRunner.find(([pattern]) => pattern.test(String(runsOn)))
  return match ? match[1] : null
}

// windows-test runs one interpolated command; what it runs is the matrix.
function stepCommands(job, step) {
  const run = String(step.run || '')
  return run.includes('matrix.command') ? job.strategy.matrix.include.map((entry) => entry.command) : [run]
}

function allJobs() {
  return [...workflows].flatMap(([file, workflow]) => Object.entries(workflow.jobs || {})
    .map(([name, job]) => ({ label: `${file}: ${name}`, file, name, job, steps: job.steps || [] })))
}

function electronJobs() {
  return allJobs().filter(({ job, steps }) => steps.some((step) => stepCommands(job, step).some(needsElectronBinary)))
}

function installIndex(steps) {
  return steps.findIndex((step) => step.run === installCommand)
}

const zipCommand = /^node scripts\/ci-ensure-electron-binary\.cjs --zip (x64|arm64)$/

function zipArch(step) {
  return zipCommand.exec(String(step?.run || ''))?.[1] ?? null
}

// The architecture each hosted runner label runs on, for the cache keys that
// name the zips they hold.
const runnerArch = new Map([
  ['windows-latest', 'x64'],
  ['macos-15', 'arm64'],
  ['macos-15-intel', 'x64'],
  ['ubuntu-latest', 'x64'],
  ['ubuntu-24.04', 'x64'],
  ['ubuntu-24.04-arm', 'arm64'],
])

const electronVersionHash = "${{ hashFiles('node_modules/electron/package.json') }}"

function exited(status) {
  return { status, signal: null }
}

function fakeInstaller(results) {
  const calls = { installs: 0, sleeps: [], logs: [] }
  return {
    calls,
    options: {
      install() {
        calls.installs += 1
        return results[Math.min(calls.installs, results.length) - 1]
      },
      async sleep(milliseconds) {
        calls.sleeps.push(milliseconds)
      },
      log(line) {
        calls.logs.push(line)
      },
    },
  }
}

test('a binary that is already in place, or downloads first time, costs one attempt and no wait', async () => {
  const { calls, options } = fakeInstaller([exited(0)])

  assert.equal(await ensureElectronBinary(options), 1)
  assert.deepEqual(calls.sleeps, [])
  assert.deepEqual(calls.logs, [])
})

test('a failed download is retried after the scheduled waits until one succeeds', async () => {
  // #319: GitHub answered HTTP 500 twice, 61 seconds apart, and the next
  // request after that went through.
  const { calls, options } = fakeInstaller([exited(1), exited(1), exited(0)])

  assert.equal(await ensureElectronBinary(options), 3)
  assert.deepEqual(calls.sleeps, [retryDelaysSeconds[0] * 1000, retryDelaysSeconds[1] * 1000])
  assert.equal(calls.logs.length, 2)
  // An annotation, so a run that only went green on a retry still says so.
  assert.match(calls.logs[0], /^::warning::第 1 次安装 Electron 二进制失败（安装脚本退出码 1）/)
})

test('it stops with a named error once every scheduled retry has failed', async () => {
  const { calls, options } = fakeInstaller([exited(1)])

  await assert.rejects(ensureElectronBinary(options), /装了 5 次 Electron 二进制都没成功（最后一次：安装脚本退出码 1）/)
  assert.equal(calls.installs, retryDelaysSeconds.length + 1)
  assert.deepEqual(calls.sleeps, retryDelaysSeconds.map((seconds) => seconds * 1000))
})

test('a stalled attempt is reported as a timeout rather than as an exit code', async () => {
  // What spawnSync hands back when its `timeout` kills install.js.
  const timedOut = { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
  const { calls, options } = fakeInstaller([timedOut, exited(0)])

  assert.equal(await ensureElectronBinary(options), 2)
  assert.match(calls.logs[0], /没在限时内装完，已中止/)
  assert.equal(describeAttempt({ status: null, signal: 'SIGKILL' }), '安装脚本被 SIGKILL 中止')
})

test('the waits outlast an outage like #319 and the worst case still ends before the step is cancelled', () => {
  const waited = retryDelaysSeconds.reduce((sum, seconds) => sum + seconds, 0)
  assert.ok(waited > 2 * 61, `the retries must keep going well past the 61 seconds #319 failed for, not ${waited}`)

  // Every attempt running into its time limit, plus every wait, has to fit
  // under the step cap, or the cap fires mid-retry and the job reports a
  // cancellation instead of the script's own error.
  const worstCaseSeconds = (retryDelaysSeconds.length + 1) * attemptTimeoutMs / 1000 + waited
  // The zip steps run the same schedule with the same per-attempt bound.
  const installSteps = allJobs().flatMap(({ label, steps }) => steps.filter((step) => step.run === installCommand || zipArch(step)).map((step) => ({ label, step })))
  assert.ok(installSteps.some(({ step }) => zipArch(step)))
  for (const { label, step } of installSteps) {
    assert.ok(step['timeout-minutes'] * 60 > worstCaseSeconds, `${label}: ${step['timeout-minutes']} minutes cannot hold ${worstCaseSeconds}s`)
  }
})

test('exactly the jobs that load Electron install it, between npm ci and the first command that needs it', () => {
  const needing = electronJobs()
  const offenders = needing.filter(({ job, steps }) => {
    const npmCi = steps.findIndex((step) => /^npm ci\b/.test(String(step.run || '').trim()))
    const install = installIndex(steps)
    const first = steps.findIndex((step) => stepCommands(job, step).some(needsElectronBinary))
    return !(npmCi !== -1 && npmCi < install && install < first)
  })
  assert.deepEqual(offenders.map(({ label }) => label), [])

  // The other way round, a job that never loads Electron only gains a download
  // that can fail. If this trips on a job that does load it, teach
  // needsElectronBinary the new command instead.
  const installing = allJobs().filter(({ steps }) => installIndex(steps) !== -1).map(({ label }) => label)
  assert.deepEqual(installing, needing.map(({ label }) => label))
})

test('the check still recognises every job known to load Electron', () => {
  const found = electronJobs().map(({ label }) => label)
  for (const known of [
    'quality.yml: windows-test',
    'quality.yml: windows-package',
    'quality.yml: macos-test',
    'quality.yml: linux-test',
    'publish-release.yml: windows-build',
    'publish-release.yml: macos-build',
    'publish-release.yml: linux-checks',
    'package-for-testing.yml: windows-package',
    'package-for-testing.yml: macos-package',
    'package-for-testing.yml: linux-checks',
  ]) {
    assert.ok(found.includes(known), `${known} loads Electron, but the check above no longer sees it`)
  }
})

test('only the Windows shards whose suites load Electron install it', () => {
  // The renderer-v2 browser shard is the pipeline's longest; a shard that does
  // not need the binary should not pay for unpacking it.
  const job = workflows.get('quality.yml').jobs['windows-test']
  const shards = job.strategy.matrix.include
  const flagged = shards.filter((entry) => entry.electron === true).map((entry) => entry.shard)

  assert.ok(flagged.length > 0)
  assert.deepEqual(flagged, shards.filter((entry) => needsElectronBinary(entry.command)).map((entry) => entry.shard))
  const install = installIndex(job.steps)
  for (const step of job.steps.slice(install - 1, install + 2)) {
    assert.match(String(step.if), /^matrix\.electron\b/, `${step.name} must run only on the shards that set electron`)
  }
})

test('quality restores the download by Electron version and only a push to main writes it back', () => {
  const qualityJobs = electronJobs().filter(({ file }) => file === 'quality.yml')
  assert.ok(qualityJobs.length > 0)

  for (const { name, job, steps } of qualityJobs) {
    const install = installIndex(steps)
    // Any zip steps sit between the install and the save, so the entry saved
    // holds every zip they put in the folder.
    let afterZips = install + 1
    while (zipArch(steps[afterZips])) afterZips += 1
    const zips = steps.slice(install + 1, afterZips).map(zipArch)
    assert.equal(steps.some((step, index) => zipArch(step) && (index <= install || index >= afterZips)), false, `${name}: zip steps must follow the install directly`)
    const [restore, save] = [steps[install - 1], steps[afterZips]]
    const cachePath = defaultElectronCache(job['runs-on'])

    assert.match(String(restore.uses), /^actions\/cache\/restore@[0-9a-f]{40}$/, `${name}: the restore must sit right before the install`)
    assert.match(String(save.uses), /^actions\/cache\/save@[0-9a-f]{40}$/, `${name}: the save must sit right after the install`)
    assert.equal(restore.uses.split('@')[1], save.uses.split('@')[1], `${name}: restore and save must come from one release`)
    assert.equal(restore.if, steps[install].if, `${name}: the restore must run exactly when the install does`)
    // Pointing install.js elsewhere would leave electron-builder, which only
    // looks in the default folder, downloading the same zip a second time.
    assert.equal(steps[install].env?.electron_config_cache, undefined, `${name}: the install must use the default download folder`)
    assert.notEqual(cachePath, null, `${name}: no known download folder for ${job['runs-on']}`)
    assert.equal(restore.with.path, cachePath, `${name}: the cache must hold @electron/get's own folder`)
    assert.equal(save.with.path, cachePath)
    // One entry per OS, architecture and Electron version: the zip changes
    // with nothing else. An entry that also holds other architectures' zips
    // names every architecture in it instead, so a runner of another
    // architecture can read it and no entry from before the zips were added
    // is mistaken for it.
    for (const zip of zips) {
      assert.ok(zipArchitectures.includes(zip))
      assert.equal(steps.find((step) => zipArch(step) === zip)['timeout-minutes'], steps[install]['timeout-minutes'], `${name}: the --zip ${zip} step gets the install's bound`)
    }
    if (zips.length === 0) {
      assert.equal(restore.with.key, `electron-\${{ runner.os }}-\${{ runner.arch }}-${electronVersionHash}`)
    } else {
      const host = runnerArch.get(job['runs-on'])
      assert.ok(host, `${name}: no known architecture for ${job['runs-on']}`)
      assert.ok(!zips.includes(host), `${name}: the install already caches the ${host} zip`)
      const held = [...new Set([host, ...zips])].sort()
      assert.equal(restore.with.key, `electron-\${{ runner.os }}-${held.join('-')}-${electronVersionHash}`)
    }
    assert.equal(save.with.key, `\${{ steps.${restore.id}.outputs.cache-primary-key }}`)
    // A pull request's cache can only be read by that pull request, so one
    // written there is a second copy nobody reuses.
    assert.match(String(save.if), new RegExp(`github\\.event_name == 'push' && steps\\.${restore.id}\\.outputs\\.cache-hit != 'true'$`))
  }
})

// CI-1: the packaging jobs that never load the binary still unpack Electron's
// zip. They read the entry their OS's install job keeps (linux-test,
// macos-test), which holds every architecture they package, and write
// nothing: only the install jobs, on a push to main, populate it.
// electron-builder checks whatever it finds against the locked checksums.json
// (scripts/electron-zip-checksums.cjs), so a stale or foreign file is
// downloaded again, not packaged. On #1600 macos-intel, which read no cache,
// went red when GitHub answered 504 for the darwin-arm64 zip for over four
// minutes.
test('the packaging-only jobs read the Electron download the install jobs keep, and never write it', () => {
  const quality = workflows.get('quality.yml')
  for (const [name, packagingCommand, keeper, packagedArchs] of [
    ['linux-package', /^npm run build:linux:ci$/, 'linux-test', ['x64', 'arm64']],
    ['macos-release-rehearsal', /^npm run test:mac:release-path$/, 'macos-test', ['arm64', 'x64']],
    ['macos-intel', /^node scripts\/run-macos-free-build\.cjs\b/, 'macos-test', ['arm64', 'x64']],
  ]) {
    const job = quality.jobs[name]
    const steps = job.steps
    const runners = String(job['runs-on']).includes('matrix.runner')
      ? job.strategy.matrix.include.map((entry) => entry.runner)
      : [job['runs-on']]
    const cachePath = defaultElectronCache(runners[0])
    assert.notEqual(cachePath, null, `${name}: no known download folder for ${runners[0]}`)
    assert.ok(runners.every((runner) => defaultElectronCache(runner) === cachePath), `${name}: every runner must share one download folder`)

    const restores = steps.filter((step) => String(step.uses || '').startsWith('actions/cache/restore@') && step.with?.path === cachePath)
    assert.equal(restores.length, 1, `${name} must restore the Electron download once`)
    const [restore] = restores
    assert.equal(restore.if, undefined)
    const npmCi = steps.findIndex((step) => /^npm ci\b/.test(String(step.run || '').trim()))
    const packaging = steps.findIndex((step) => packagingCommand.test(String(step.run || '').trim()))
    const restoreIndex = steps.indexOf(restore)
    // hashFiles reads node_modules, so the key only exists after npm ci.
    assert.ok(npmCi !== -1 && npmCi < restoreIndex && restoreIndex < packaging, `${name}: restore after npm ci and before packaging`)
    assert.equal(steps.some((step) => String(step.uses || '').startsWith('actions/cache/save@') && step.with?.path === cachePath), false, `${name} must not write the Electron download`)
    assert.equal(installIndex(steps), -1, `${name} does not load the binary and must not install it`)

    // The very entry the keeper saves, and it holds every zip this job packages.
    const keeperJob = quality.jobs[keeper]
    const keeperInstall = installIndex(keeperJob.steps)
    assert.equal(defaultElectronCache(keeperJob['runs-on']), cachePath)
    assert.equal(restore.with.key, keeperJob.steps[keeperInstall - 1].with.key, `${name}: the key must be the one ${keeper} saves`)
    const held = new Set([runnerArch.get(keeperJob['runs-on']), ...keeperJob.steps.map(zipArch).filter(Boolean)])
    for (const arch of packagedArchs) assert.ok(held.has(arch), `${keeper}'s entry must hold the ${arch} zip ${name} packages`)
  }
})

test('the zip mode takes only an architecture a packaging job uses', () => {
  assert.deepEqual(parseArguments([]), { mode: 'binary' })
  assert.deepEqual(parseArguments(['--zip', 'x64']), { mode: 'zip', arch: 'x64' })
  assert.deepEqual(parseArguments(['--zip', 'arm64']), { mode: 'zip', arch: 'arm64' })
  assert.deepEqual(parseArguments(['--download-zip', 'arm64']), { mode: 'download-zip', arch: 'arm64' })
  for (const argv of [['--zip'], ['--zip', 'ia32'], ['--zip', 'x64', '--zip', 'arm64'], ['x64'], ['--zip', '../x64']]) {
    assert.throws(() => parseArguments(argv), /参数不认识/, argv.join(' '))
  }
})

test('a zip download is retried on the same schedule and names the architecture', async () => {
  const { calls, options } = fakeInstaller([exited(1), exited(0)])
  assert.equal(await ensureElectronZip({ arch: 'x64', download: options.install, sleep: options.sleep, log: options.log }), 2)
  assert.deepEqual(calls.sleeps, [retryDelaysSeconds[0] * 1000])
  assert.match(calls.logs[0], /^::warning::第 1 次下载 x64 版 Electron 压缩包失败（下载脚本退出码 1），10 秒后重试/)

  const failing = fakeInstaller([exited(1)])
  await assert.rejects(ensureElectronZip({ arch: 'arm64', download: failing.options.install, sleep: failing.options.sleep, log: failing.options.log }),
    /下了 5 次 arm64 版 Electron 压缩包都没成功（最后一次：下载脚本退出码 1）/)
  assert.deepEqual(failing.calls.sleeps, retryDelaysSeconds.map((seconds) => seconds * 1000))
})

test('each zip attempt asks @electron/get for the default cache with the locked checksums', async () => {
  const packageDirectory = path.join(root, 'node_modules', 'electron')
  const { version } = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
  const requests = []
  const file = await downloadElectronZip({
    arch: 'arm64',
    platform: 'darwin',
    packageDirectory,
    async downloadArtifact(details) {
      requests.push(details)
      return '/cache/zip'
    },
  })

  assert.equal(file, '/cache/zip')
  // No cacheRoot: the folder the workflow caches and electron-builder reads.
  // With checksums, a cached zip is checked without a request and a fetched
  // one is checked before it is kept.
  assert.deepEqual(requests, [{ version, artifactName: 'electron', platform: 'darwin', arch: 'arm64', checksums: resolveLockedElectronZipChecksums() }])
})
