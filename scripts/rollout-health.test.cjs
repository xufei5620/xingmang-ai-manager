const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')
const {
  CRASH_CEILING,
  LONG_OBSERVATION_HOURS,
  MIN_OBSERVATION_HOURS,
  assessRolloutHealth,
  planRolloutHealth,
  readActiveRollout,
  renderRolloutHealth,
  runRolloutHealth,
} = require('./rollout-health.cjs')
const { parseUsagePath } = require('./update-feed-stats.cjs')

const root = path.resolve(__dirname, '..')
const HOUR = 60 * 60 * 1000
const released = Date.parse('2026-11-03T04:00:00.000Z')
const rollout = { version: '0.2.24', percent: 20 }

function hoursLater(hours) {
  return new Date(released + hours * HOUR)
}

// 一条打卡照客户端发的地址解出来，再带上它折算成几台·天（weight）。
function checkIn({ app = '0.2.24', os = 'w11', update = 'ok', installs = '0', hangs = '0', weight = 1 } = {}) {
  const record = parseUsagePath(`/xingmang-manager/stats/v1/d-20261104/a-${app}/o-${os}/c-x64/k-xm/r-a2/u-1/s-${update}/t-cc~2.1.310_cx~0_gk~x_gm~0_cdx~0_cd~0_wb~0_oc~0/i-${installs}/f-0/h-${hangs}`)
  assert.ok(record, 'the check-in path must decode')
  return { ...record, weight }
}

function machines(count, options) {
  return Array.from({ length: count }, () => checkIn(options))
}

function assess(records, hours = 30, options = {}) {
  return assessRolloutHealth({ rollout, releasedAt: released, records, now: hoursLater(hours), ...options })
}

test('only a rollout still holding machines back is checked', () => {
  assert.equal(readActiveRollout({}), null)
  assert.equal(readActiveRollout({ rollout: { version: '0.2.24', percent: 100 } }), null)
  assert.equal(readActiveRollout({ rollout: { version: 'latest', percent: 20 } }), null)
  assert.equal(readActiveRollout({ rollout: { version: '0.2.24' } }), null)
  assert.deepEqual(readActiveRollout({ rollout: { version: 'v0.2.24', percent: 20 } }), { version: '0.2.24', percent: 20 })
  assert.deepEqual(readActiveRollout({ rollout: { version: '0.2.24', percent: 0, platforms: ['linux'] } }), { version: '0.2.24', percent: 0, platforms: ['linux'] })
})

test('the release time comes from the GitHub Release, the packaging time only as a stand-in', () => {
  const status = { rollout }
  const packaged = new Map([['0.2.24', released - 6 * HOUR]])
  const now = hoursLater(30)
  assert.equal(planRolloutHealth({ status: {}, publishedDates: packaged, releasedAt: released, now }).done.verdict, 'none')
  // 放量写的那一版还没上线（或者已经退回）：没有要体检的。
  const notLive = planRolloutHealth({ status, publishedDates: new Map([['0.2.23', released]]), releasedAt: Number.NaN, now })
  assert.match(notLive.done.headline, /线上更新清单不是这一版/)

  const fromRelease = planRolloutHealth({ status, publishedDates: packaged, releasedAt: released, now })
  assert.deepEqual(fromRelease, { rollout, releasedAt: released, approximate: false, from: released })
  // 第一次批准和第二次批准之间可能隔了一整天真机验收，出包时间只能顶一下，结论里要写明。
  const fromPackaging = planRolloutHealth({ status, publishedDates: packaged, releasedAt: Number.NaN, now })
  assert.equal(fromPackaging.releasedAt, released - 6 * HOUR)
  assert.equal(fromPackaging.approximate, true)
  // 放了很久没放开：只看最近 7 天。
  const late = planRolloutHealth({ status, publishedDates: packaged, releasedAt: released, now: hoursLater(24 * 10) })
  assert.equal(late.from, hoursLater(24 * 3).getTime())
})

test('a clearly worse new version is a stop, with the numbers that show it', () => {
  const records = [
    ...machines(30, { hangs: 'e~1' }),
    ...machines(100, {}),
    ...machines(100, { app: '0.2.23' }),
    ...machines(2, { app: '0.2.23', hangs: 'e~1' }),
  ]
  const result = assess(records)
  assert.equal(result.verdict, 'stop')
  assert.match(result.headline, /^建议停住 0\.2\.24：意外退出（闪退）：新版每 100 台·天 23\.1 次，还在旧版的 2\.0 次/)
  // 一个平台单独出问题，也要点出是哪个平台。
  assert.match(result.headline, /Windows 上意外退出/)
})

test('a new version that holds up against the old one after a day is an open', () => {
  const records = [
    ...machines(40, {}),
    ...machines(2, { hangs: 's~2' }),
    ...machines(80, { app: '0.2.23' }),
    ...machines(4, { app: '0.2.23', hangs: 's~2' }),
    ...machines(25, { os: 'm15' }),
    ...machines(60, { app: '0.2.23', os: 'm15' }),
  ]
  const result = assess(records, 26)
  assert.equal(result.verdict, 'open')
  assert.match(result.headline, /^建议放开 0\.2\.24：发出去 26 小时，和还在旧版的电脑比，闪退、卡住、付款页、装工具都没有明显变差。$/)
  assert.deepEqual(result.table.map((scope) => scope.label), ['合计', 'Windows', 'Mac'])
  assert.deepEqual(result.notes, [])
})

test('the first hours are a wait, unless something is already plainly broken', () => {
  const healthy = [...machines(40, {}), ...machines(80, { app: '0.2.23' })]
  const early = assess(healthy, MIN_OBSERVATION_HOURS - 1)
  assert.equal(early.verdict, 'wait')
  assert.match(early.headline, /发出去才 19 小时/)
  assert.equal(assess(healthy, 0.5).headline.includes('不到 1 小时'), true)
  const broken = [...machines(30, { hangs: 'e~2' }), ...machines(80, { app: '0.2.23' })]
  assert.equal(assess(broken, 3).verdict, 'stop')
})

test('a thin sample waits for more, and after two days opens with a caveat', () => {
  const thin = [...machines(8, {}), ...machines(80, { app: '0.2.23' })]
  const waiting = assess(thin, 30)
  assert.equal(waiting.verdict, 'wait')
  assert.match(waiting.headline, /新版的打卡还不到 20 台·天/)
  const later = assess(thin, LONG_OBSERVATION_HOURS)
  assert.equal(later.verdict, 'open')
  assert.match(later.headline, /（样本少，只能粗看）/)
  // 一台电脑反复出错不算：样本不够就不拿来判停。
  assert.equal(assess([...machines(1, { hangs: 'e~9' }), ...machines(7, {}), ...machines(80, { app: '0.2.23' })], 30).verdict, 'wait')
})

test('without machines to compare against, only a plainly broken version is stopped', () => {
  // 0.2.23 自己放量时，它的上一版不打卡，对照组是空的。
  const own = { version: '0.2.23', percent: 20 }
  const calm = assessRolloutHealth({ rollout: own, releasedAt: released, records: [...machines(5, { app: '0.2.23', hangs: 'e~1' }), ...machines(95, { app: '0.2.23' })], now: hoursLater(30) })
  assert.equal(calm.verdict, 'open')
  assert.match(calm.headline, /只看新版自己/)
  assert.match(calm.notes.join('\n'), /没有可比的对照/)
  const crashing = assessRolloutHealth({ rollout: own, releasedAt: released, records: [...machines(12, { app: '0.2.23', hangs: 'e~1' }), ...machines(88, { app: '0.2.23' })], now: hoursLater(30) })
  assert.equal(crashing.verdict, 'stop')
  assert.match(crashing.headline, new RegExp(`平均每 ${CRASH_CEILING} 台电脑一天就闪退一次以上`))
})

test('machines that downloaded the new version but could not install it stop the rollout', () => {
  const records = [
    ...machines(40, {}),
    ...machines(70, { app: '0.2.23' }),
    ...machines(12, { app: '0.2.23', update: 'ff~0.2.24' }),
    ...machines(10, { app: '0.2.23', update: 'dl~0.2.24' }),
  ]
  const result = assess(records)
  assert.equal(result.verdict, 'stop')
  assert.match(result.headline, /升新版没装上：下好了新版、试着装过的电脑里 23% 还停在旧版/)
  // 装不上的是更早那一版的，不算这一版的账。
  assert.equal(assess([...machines(40, {}), ...machines(70, { app: '0.2.23', update: 'ff~0.2.23' })]).verdict, 'open')
})

test('a platform where no machine got the new version installed is stopped, not averaged away by the others (R29-05)', () => {
  const windows = [...machines(200, {}), ...machines(100, { app: '0.2.23' })]
  const result = assess([...windows, ...machines(30, { app: '0.2.23', os: 'm15', update: 'ff~0.2.24' })])
  assert.equal(result.verdict, 'stop')
  assert.match(result.headline, /^建议停住 0\.2\.24：Mac 上升新版没装上：下好了新版、试着装过的电脑全都还停在旧版，一台都没升上去。$/)
  // Mac 一条新版打卡都没有，照样单列一格，表里看得到它装不上。
  assert.deepEqual(result.table.map((scope) => [scope.label, scope.installShare]), [['合计', 30 / 230], ['Windows', 0], ['Mac', 1]])
  assert.match(renderRolloutHealth(result, hoursLater(30)), /升新版没装上\*\*.*：合计 13\.0%、Windows 0\.0%、Mac 100\.0%/)

  // 全没装上的不用攒够 20 台·天，3 台·天就停住，发出去头几个小时也一样。
  assert.equal(assess([...windows, ...machines(3, { app: '0.2.23', os: 'm15', update: 'ff~0.2.24' })], 3).verdict, 'stop')
  // 还有人升上去的，照旧要试过的够 20 台·天才拿比例判停。
  const mixed = assess([...windows, ...machines(3, { os: 'm15' }), ...machines(6, { app: '0.2.23', os: 'm15', update: 'ff~0.2.24' })])
  assert.equal(mixed.verdict, 'wait')
})

test('too few tries on a platform waits instead of letting the other platforms vouch for it (R29-05)', () => {
  const windows = [...machines(200, {}), ...machines(100, { app: '0.2.23' })]
  const failedOnly = [...windows, ...machines(2, { app: '0.2.23', os: 'm15', update: 'ff~0.2.24' })]
  const waiting = assess(failedOnly)
  assert.equal(waiting.verdict, 'wait')
  assert.match(waiting.headline, /^再等等，0\.2\.24 先不放开：Mac 上有电脑下好了新版没装上，试着装过的还不到 20 台·天，看不出是个别电脑的问题还是都装不上。$/)
  // 一台都没升上去的，等多久都不拿 Windows 升得好来放开。
  assert.equal(assess(failedOnly, LONG_OBSERVATION_HOURS + 24).verdict, 'wait')

  // 有升上去的，满 44 小时照「样本少」那样放开，写明是哪个平台只能粗看。
  const someInstalled = [...windows, ...machines(5, { os: 'm15' }), ...machines(1, { app: '0.2.23', os: 'm15', update: 'ff~0.2.24' })]
  assert.equal(assess(someInstalled).verdict, 'wait')
  const later = assess(someInstalled, LONG_OBSERVATION_HOURS)
  assert.equal(later.verdict, 'open')
  assert.match(later.headline, /（Mac 上试着装新版的还少，装不装得上只能粗看）。$/)

  // 没人试着装过、也没装不上的平台照旧：正常的各平台统计不受影响。
  assert.equal(assess([...windows, ...machines(5, { os: 'm15' }), ...machines(40, { app: '0.2.23', os: 'm15' })]).verdict, 'open')
})

test('a rollout held to some platforms is judged on those platforms, not on the ones already fully released (R29-05)', () => {
  const macOnly = { version: '0.2.24', percent: 20, platforms: ['mac-arm64'] }
  function assessMac(records, hours = 30) {
    return assessRolloutHealth({ rollout: macOnly, releasedAt: released, records, now: hoursLater(hours) })
  }
  const windows = [...machines(200, {}), ...machines(100, { app: '0.2.23' })]
  const thin = assessMac([...windows, ...machines(5, { os: 'm15' }), ...machines(60, { app: '0.2.23', os: 'm15' })])
  assert.equal(thin.verdict, 'wait')
  assert.match(thin.headline, /Mac 上新版的打卡还不到 20 台·天/)
  assert.deepEqual(thin.table.map((scope) => scope.label), ['合计', 'Windows', 'Mac'])
  assert.match(assessMac([...windows, ...machines(5, { os: 'm15' })], LONG_OBSERVATION_HOURS).headline, /（Mac 上样本少，只能粗看）。$/)

  // 管着的平台一条新版打卡都没有：表里照样有这一格，两天后说看不出，不拿 Windows 顶。
  const silent = assessMac(windows, LONG_OBSERVATION_HOURS + 1)
  assert.equal(silent.verdict, 'unknown')
  assert.match(silent.headline, /Mac 上新版一条打卡都没收到/)
  assert.deepEqual(silent.table.map((scope) => scope.label), ['合计', 'Windows', 'Mac'])

  assert.equal(assessMac([...windows, ...machines(25, { os: 'm15' }), ...machines(60, { app: '0.2.23', os: 'm15' })]).verdict, 'open')
})

test('two days without a single check-in from the new version says it cannot tell', () => {
  const result = assess(machines(80, { app: '0.2.23' }), LONG_OBSERVATION_HOURS + 1)
  assert.equal(result.verdict, 'unknown')
  assert.match(result.headline, /新版一条打卡都没收到/)
})

test('the report leads with the verdict and the next step, and never gives machine counts', () => {
  const stop = assess([...machines(37, { hangs: 'e~1' }), ...machines(100, {}), ...machines(100, { app: '0.2.23' })])
  const report = renderRolloutHealth(stop, new Date('2026-11-04T04:17:00.000Z'))
  const [first] = report.split('\n')
  assert.match(first, /^\*\*放量体检（北京时间 11-04 12:17）：建议停住。\*\* 建议停住 0\.2\.24：/)
  assert.match(report, /「分批放量」填 `0\.2\.24 0` 停住/)
  assert.match(report, /\| 每 100 台·天几次 \| 合计 新版 \| 合计 还在旧版 \| Windows 新版 \| Windows 还在旧版 \|/)
  assert.match(report, /\| 样本 \| 够 \| 够 \| 够 \| 够 \|/)
  assert.match(report, /Sentry/)
  // 仓库公开：137、100、237 这些台·天数不能出现在报告里。
  assert.doesNotMatch(report, /\b(?:137|237)\b/)

  const open = renderRolloutHealth(assess([...machines(40, {}), ...machines(80, { app: '0.2.23' })]), hoursLater(30))
  assert.match(open, /「分批放量」填 `none`/)
  const paused = renderRolloutHealth(assessRolloutHealth({ rollout: { version: '0.2.24', percent: 0, platforms: ['linux'] }, releasedAt: released, records: [], now: hoursLater(2) }), hoursLater(2))
  assert.match(paused, /现在线上：0\.2\.24 先不自动推，只给自己点「检查更新」的人（只管 linux）。/)
  assert.match(renderRolloutHealth({ verdict: 'none', headline: '现在没有在分批放量。' }, hoursLater(2)), /^\*\*放量体检（北京时间 .+）：现在没有在分批放量。\*\*\n$/)
})

test('the check only asks Cloudflare when there is a live rollout old enough to have check-ins', async () => {
  const asked = []
  function collectUsage(from, now) {
    asked.push({ from, now })
    return Promise.resolve({ usage: { records: [...machines(40, {}), ...machines(80, { app: '0.2.23' })], sampleInterval: 3 } })
  }
  const publishedDates = new Map([['0.2.24', released]])
  const none = await runRolloutHealth({ status: {}, publishedDates, releasedAt: released, now: hoursLater(30), collectUsage })
  assert.equal(none.verdict, 'none')
  const fresh = await runRolloutHealth({ status: { rollout }, publishedDates, releasedAt: released, now: hoursLater(0.5), collectUsage })
  assert.equal(fresh.verdict, 'wait')
  assert.equal(asked.length, 0)

  const checked = await runRolloutHealth({ status: { rollout }, publishedDates, releasedAt: released, now: hoursLater(30), collectUsage })
  assert.equal(checked.verdict, 'open')
  assert.deepEqual(asked, [{ from: released, now: hoursLater(30) }])
  assert.match(checked.report, /最多每 3 次记 1 次/)

  const pathless = await runRolloutHealth({ status: { rollout }, publishedDates, releasedAt: released, now: hoursLater(30), collectUsage: async () => ({ usage: null }) })
  assert.equal(pathless.verdict, 'unknown')
  assert.match(pathless.report, /不能按请求路径分/)
})

test('the workflow learns which version is rolling out from the status file', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rollout-health-'))
  const status = path.join(workspace, 'service-status.json')
  function version(file) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'rollout-health.cjs'), 'rollout-version', '--status', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  fs.writeFileSync(status, JSON.stringify({ rollout: { version: '0.2.24', percent: 20 } }))
  assert.equal(version(status), '0.2.24')
  fs.writeFileSync(status, JSON.stringify({ badVersions: ['0.2.10'] }))
  assert.equal(version(status), '')
  // 404 时工作流删掉了这个文件。
  assert.equal(version(path.join(workspace, 'missing.json')), '')
  fs.writeFileSync(status, '<html>cached</html>')
  const unreadable = spawnSync(process.execPath, [path.join(__dirname, 'rollout-health.cjs'), 'check', '--status', status, '--published-dates', '', '--released-at', ''], { encoding: 'utf8' })
  assert.equal(unreadable.status, 1)
  assert.match(unreadable.stderr, /::error::线上的状态文件读回来不是有效的 JSON 对象/)
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('the health workflow only reads, at noon Beijing time or on demand, with the read-only analytics token', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'rollout-health.yml'), 'utf8'))
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch'])
  // 北京时间中午 12:17：新版装上那天的打卡要第二天上午才到，早上 6:17 看不到。
  assert.deepEqual(workflow.on.schedule, [{ cron: '17 4 * * *' }])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const [job] = Object.values(workflow.jobs)
  assert.equal(job.if, "${{ github.event_name != 'schedule' || github.repository == 'xufei5620/xingmang-ai-manager' }}")
  // 只给建议：不挂 release 环境、不碰发布凭据和更新目录。
  assert.equal(job.environment, undefined)
  assert.equal(job.permissions, undefined)
  assert.ok(job['timeout-minutes'] <= 15)
  const source = JSON.stringify(job)
  assert.doesNotMatch(source, /aws s3|R2_|XINGMANG_UPDATE_SIGNING_KEY|npm ci/)
  for (const step of job.steps) {
    // 取值都经 env 传进脚本，不在 shell 解析之前替换进去（P-26）。
    assert.doesNotMatch(String(step.run || ''), /\$\{\{/, step.name)
  }
  const check = job.steps.find((step) => String(step.run || '').includes('scripts/rollout-health.cjs check'))
  assert.equal(check.env.CLOUDFLARE_ANALYTICS_TOKEN, '${{ secrets.CLOUDFLARE_ANALYTICS_TOKEN }}')
  assert.equal(check.env.RELEASED_AT, '${{ steps.release.outputs.published }}')
  assert.match(check.run, /GITHUB_STEP_SUMMARY/)
  // 状态文件读不到（404 以外）就停下，不把「读不到」说成「没在放量」。
  const live = job.steps.find((step) => step.id === 'live')
  assert.match(live.run, /404\) echo "线上还没有状态文件，没在放量"/)
  assert.match(live.run, /\*\) echo "::error::读取线上状态文件失败/)
  assert.ok(live.run.includes('for manifest in latest.yml latest-mac.yml latest-linux.yml latest-linux-arm64.yml; do'))
  const release = job.steps.find((step) => step.id === 'release')
  assert.equal(release.env.GH_TOKEN, '${{ github.token }}')
  assert.equal(release.if, "${{ steps.live.outputs.version != '' }}")
})

test('only a plain release time from GitHub reaches the check, anything else falls back to the packaging time', { skip: process.platform === 'win32' && '这个作业只在 ubuntu-latest 上跑' }, () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'rollout-health.yml'), 'utf8'))
  const step = Object.values(workflow.jobs)[0].steps.find((entry) => entry.id === 'release')
  function lookup(ghOutput, ghStatus = 0) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rollout-release-'))
    const bin = path.join(workspace, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash\nprintf '%s' ${JSON.stringify(ghOutput)}\nexit ${ghStatus}\n`)
    fs.chmodSync(path.join(bin, 'gh'), 0o755)
    const output = path.join(workspace, 'github-output')
    const result = spawnSync('/bin/bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'xufei5620/xingmang-ai-manager', VERSION: '0.2.24', GH_TOKEN: 'stub' },
    })
    const written = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''
    fs.rmSync(workspace, { recursive: true, force: true })
    assert.equal(result.status, 0, result.stderr)
    return written
  }
  assert.equal(lookup('2026-11-03T04:00:12Z'), 'published=2026-11-03T04:00:12Z\n')
  assert.equal(lookup('{"message":"Not Found","status":"404"}', 1), 'published=\n')
  assert.equal(lookup('2026-11-03T04:00:12Z\nmore'), 'published=\n')
})
