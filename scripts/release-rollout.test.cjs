const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')
const { RolloutInputError, describeRolloutChoice, parseRolloutChoice, planReleaseRollout } = require('./release-rollout.cjs')

const root = path.resolve(__dirname, '..')
const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-release.yml'), 'utf8'))
const rolloutInput = workflow.on.workflow_dispatch.inputs.rollout

function live(entries) {
  return new Map(Object.entries(entries))
}

function plan(options) {
  return planReleaseRollout({ version: '0.2.23', percent: 20, current: {}, publishing: ['latest.yml', 'latest-mac.yml'], live: live({}), ...options })
}

function manifestText(version, name = `XingMang-AI-Manager-${version}-Setup.exe`) {
  const sha512 = require('node:crypto').createHash('sha512').update(version).digest('base64')
  return YAML.stringify({ version, files: [{ url: name, sha512, size: 7 }], path: name, sha512, releaseDate: '2026-10-28T00:00:00.000Z' })
}

test('every option the publish workflow offers reads as a percentage, and the default is two in ten', () => {
  // 默认值就是「平时」：触发的人什么都不选，也是先放两成。
  assert.equal(parseRolloutChoice(rolloutInput.default), 20)
  assert.equal(rolloutInput.required, true)
  assert.equal(rolloutInput.type, 'choice')
  assert.deepEqual(rolloutInput.options.map(parseRolloutChoice), [20, 5, 50, 0, 100])
  // 全量那一项要在选项里就说清是给谁用的。
  assert.match(rolloutInput.options.find((option) => parseRolloutChoice(option) === 100), /快修/)
  // 从接口触发时只写数字也认。
  assert.equal(parseRolloutChoice('20'), 20)
  assert.equal(parseRolloutChoice(' 5% '), 5)
})

test('a percentage outside 0 to 100, or no percentage at all, stops the run', () => {
  for (const value of ['', '101', '-1', 'abc', '20.5', 'twenty: 两成', undefined]) {
    assert.throws(() => parseRolloutChoice(value), RolloutInputError, String(value))
  }
})

test('the approver sees how far the release reaches, with a warning only for a full push', () => {
  const usual = describeRolloutChoice('0.2.23', 20)
  assert.equal(usual.warning, null)
  assert.match(usual.lines.join('\n'), /0\.2\.23：先自动推给 20% 的电脑/)
  // 告诉批的人第二天在哪看建议、放开要做什么。
  assert.match(usual.lines.join('\n'), /rollout-health/)
  assert.match(usual.lines.join('\n'), /`none`/)

  assert.match(describeRolloutChoice('0.2.23', 0).lines.join('\n'), /先不自动推，只给自己点「检查更新」的人/)

  const full = describeRolloutChoice('v0.2.23', 100)
  assert.match(full.lines.join('\n'), /0\.2\.23：全部放开/)
  assert.match(full.warning, /快修通道/)
  assert.match(full.warning, /重新触发时选 20/)
  assert.throws(() => describeRolloutChoice('0.2', 20), RolloutInputError)
})

test('a first release of the version writes the chosen percentage, replacing whatever rollout was there', () => {
  assert.deepEqual(plan({}).input, '0.2.23 20')
  // 以前的做法是发布之前先跑 service-status，或者上一次触发写了、没发出去：这次选的为准。
  assert.equal(plan({ current: { rollout: { version: '0.2.23', percent: 0 } } }).input, '0.2.23 20')
  assert.equal(plan({ current: { rollout: { version: '0.2.22', percent: 20 } }, live: live({ 'latest.yml': '0.2.22' }) }).input, '0.2.23 20')
  assert.equal(plan({ percent: 0 }).input, '0.2.23 0')
  assert.match(plan({}).message, /先自动推给 20% 的电脑/)
})

test('a full push clears an old rollout and leaves a status file without one alone', () => {
  assert.equal(plan({ percent: 100, current: { rollout: { version: '0.2.22', percent: 20 } } }).input, 'none')
  const untouched = plan({ percent: 100, current: { badVersions: ['0.2.10'] } })
  assert.equal(untouched.input, null)
  assert.match(untouched.message, /不用改/)
})

test('a rerun of the same publish never touches the rollout, even one paused since', () => {
  // 收尾那一步红了、Re-run failed jobs：这期间有人填过 0 停住，重跑不能又放回两成。
  const rerun = plan({
    current: { rollout: { version: '0.2.23', percent: 0 } },
    live: live({ 'latest.yml': '0.2.23', 'latest-mac.yml': '0.2.23' }),
  })
  assert.equal(rerun.input, null)
  assert.match(rerun.message, /重跑/)
  assert.match(rerun.message, /0\.2\.23 先不自动推/)
  assert.equal(plan({ percent: 100, live: live({ 'latest.yml': 'v0.2.23', 'latest-mac.yml': '0.2.23' }) }).input, null)
})

test('a platform published later joins the rollout already running, or is rolled out on its own', () => {
  const linux = { publishing: ['latest-linux.yml', 'latest-linux-arm64.yml'] }
  const shipped = live({ 'latest.yml': '0.2.23', 'latest-mac.yml': '0.2.23' })
  // 这一版还在分批（可能正停着）：补发的平台照它走，不改。
  const joining = plan({ ...linux, live: shipped, current: { rollout: { version: '0.2.23', percent: 0 } } })
  assert.equal(joining.input, null)
  assert.match(joining.message, /照线上的放量走/)
  // 已经全部放开了：只对补发的平台分批，已经全放的平台不被拉回两成。
  const alone = plan({ ...linux, live: shipped })
  assert.equal(alone.input, '0.2.23 20@linux')
  assert.match(alone.message, /已经发出去的平台不受影响/)
  assert.equal(plan({ publishing: ['latest-mac.yml'], live: live({ 'latest.yml': '0.2.23' }) }).input, '0.2.23 20@mac')
  // 补发选了全部放开：本来就全放了，不用改。
  assert.equal(plan({ ...linux, live: shipped, percent: 100 }).input, null)
})

test('the plan refuses what it cannot reason about', () => {
  assert.throws(() => plan({ percent: 101 }), RolloutInputError)
  assert.throws(() => plan({ publishing: [] }), RolloutInputError)
  assert.throws(() => plan({ version: 'latest' }), RolloutInputError)
})

// 发布作业里那样跑一遍命令行：产物目录、线上清单目录、线上状态文件，写出新的状态文件。
function runPlan({ rollout = '20: 先推给两成电脑（平时都选这个）', artifacts = ['latest.yml'], liveManifests = {}, current = null }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-release-rollout-'))
  const artifactsDirectory = path.join(workspace, 'release-artifacts')
  const liveDirectory = path.join(workspace, 'live')
  fs.mkdirSync(artifactsDirectory)
  fs.mkdirSync(liveDirectory)
  for (const name of artifacts) fs.writeFileSync(path.join(artifactsDirectory, name), manifestText('0.2.23'))
  for (const [name, version] of Object.entries(liveManifests)) fs.writeFileSync(path.join(liveDirectory, name), manifestText(version))
  const currentPath = path.join(workspace, 'current.json')
  if (current !== null) fs.writeFileSync(currentPath, current)
  const outputPath = path.join(workspace, 'next.json')
  const summaryPath = path.join(workspace, 'summary.md')
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'release-rollout.cjs'), 'plan',
    '--version', '0.2.23', '--rollout', rollout,
    '--artifacts', artifactsDirectory, '--live', liveDirectory,
    '--current', currentPath, '--output', outputPath, '--summary', summaryPath,
  ], { encoding: 'utf8' })
  const next = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null
  const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : ''
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, output: result.stdout + result.stderr, next, summary }
}

test('the command line writes the new rollout and keeps every other switch as it was', () => {
  const current = JSON.stringify({ badVersions: ['0.2.10'], minimumVersion: '0.2.22', updatedAt: '2026-10-27T04:22:00.000Z' })
  const run = runPlan({ current, liveManifests: { 'latest.yml': '0.2.22' } })
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(run.next.rollout, { version: '0.2.23', percent: 20 })
  assert.deepEqual(run.next.badVersions, ['0.2.10'])
  assert.equal(run.next.minimumVersion, '0.2.22')
  assert.notEqual(run.next.updatedAt, '2026-10-27T04:22:00.000Z')
  assert.match(run.output, /分批放量：0\.2\.23 先给 20% 的电脑/)
  assert.match(run.summary, /### 分批放量/)

  // 线上还没有状态文件（404，工作流删掉了那份）：从空白开始。
  const first = runPlan({})
  assert.equal(first.status, 0, first.output)
  assert.deepEqual(Object.keys(first.next).sort(), ['rollout', 'updatedAt'])
})

test('the command line writes nothing on a rerun, and stops on a status file it cannot read', () => {
  const rerun = runPlan({ current: JSON.stringify({ rollout: { version: '0.2.23', percent: 0 } }), liveManifests: { 'latest.yml': '0.2.23' } })
  assert.equal(rerun.status, 0, rerun.output)
  assert.equal(rerun.next, null)

  // 缓存回了一张网页：硬写会抹掉撤回名单这些，停在换清单之前。
  const unreadable = runPlan({ current: '<html>cached</html>' })
  assert.equal(unreadable.status, 1)
  assert.equal(unreadable.next, null)
  assert.match(unreadable.output, /::error::线上的状态文件读回来不是有效的 JSON 对象/)

  const noManifest = runPlan({ artifacts: [] })
  assert.equal(noManifest.status, 1)
  assert.match(noManifest.output, /::error::产物里没有任何更新清单/)

  const bad = runPlan({ rollout: '120' })
  assert.equal(bad.status, 1)
  assert.match(bad.output, /::error::「上传以后先推给多少」要选一个 0 到 100 的比例/)
})
