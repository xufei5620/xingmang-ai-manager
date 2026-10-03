const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const { attemptTimeoutMs, describeAttempt, ensureElectronBinary, retryDelaysSeconds } = require('./ci-ensure-electron-binary.cjs')

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
  const installSteps = allJobs().flatMap(({ label, steps }) => steps.filter((step) => step.run === installCommand).map((step) => ({ label, step })))
  assert.ok(installSteps.length > 0)
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
    const [restore, save] = [steps[install - 1], steps[install + 1]]
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
    // with nothing else.
    assert.equal(restore.with.key, "electron-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('node_modules/electron/package.json') }}")
    assert.equal(save.with.key, `\${{ steps.${restore.id}.outputs.cache-primary-key }}`)
    // A pull request's cache can only be read by that pull request, so one
    // written there is a second copy nobody reuses.
    assert.match(String(save.if), new RegExp(`github\\.event_name == 'push' && steps\\.${restore.id}\\.outputs\\.cache-hit != 'true'$`))
  }
})
