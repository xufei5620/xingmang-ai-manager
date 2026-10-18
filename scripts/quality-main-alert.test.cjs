const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ALERT_MARKER, ALERT_TITLE, gateOutcome, hasNewerVerdict, findMainAlertIssue, reportedJobs, buildMainAlertBody, buildRecoveryComment, planMainAlertAction,
  readMainAlertEnvironment, runMainAlert } = require('./quality-main-alert.cjs')

const REPOSITORY = 'xufei5620/xingmang-ai-manager'
const TOKEN = 'ghs_TESTTOKENVALUE'
const RUN_ID = 39127387999
const SHA = '081edd7c2f0e1a9b8d7c6b5a4f3e2d1c0b9a8f7e'

function env(gate, overrides = {}) {
  return { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_OWNER: 'xufei5620', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: String(RUN_ID),
    GITHUB_RUN_NUMBER: '2852', GITHUB_SHA: SHA, QUALITY_GATE_RESULT: gate, ...overrides }
}

function run(id, conclusion, createdAt, status = 'completed') {
  return { id, run_number: id % 100000, created_at: createdAt, status, conclusion }
}

function botIssue(number, body = `${ALERT_MARKER}\n旧内容`) {
  return { number, state: 'open', body, user: { login: 'github-actions[bot]', type: 'Bot' } }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const currentRun = run(RUN_ID, null, '2026-10-18T12:28:00Z', 'in_progress')
const failedJobs = [
  { name: 'changes', status: 'completed', conclusion: 'success' },
  { name: 'windows-test (vitest-1)', status: 'completed', conclusion: 'success' },
  { name: 'windows-test (vitest-2)', status: 'completed', conclusion: 'failure' },
  { name: 'test', status: 'completed', conclusion: 'failure' },
  { name: 'macos-intel', status: 'completed', conclusion: 'success' },
  { name: 'quality-gate', status: 'completed', conclusion: 'failure' },
  { name: 'main-alert', status: 'in_progress', conclusion: null },
]

function server({ runs = [currentRun], issues = [], jobs = failedJobs } = {}) {
  const calls = []
  async function fetchImpl(url, init) {
    const parsed = new URL(url)
    calls.push({ method: init.method, path: `${parsed.pathname}${parsed.search}`, body: init.body === undefined ? undefined : JSON.parse(init.body), init })
    if (init.method === 'GET' && parsed.pathname === `/repos/${REPOSITORY}/issues`) return json(issues)
    if (init.method === 'GET' && parsed.pathname === `/repos/${REPOSITORY}/actions/workflows/quality.yml/runs`) return json({ total_count: runs.length, workflow_runs: runs })
    if (init.method === 'GET' && parsed.pathname === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/jobs`) return json({ total_count: jobs.length, jobs })
    if (init.method === 'POST' && parsed.pathname === `/repos/${REPOSITORY}/issues`) return json({ number: 88 }, 201)
    if (init.method === 'POST' && /\/issues\/[0-9]+\/comments$/.test(parsed.pathname)) return json({ id: 1 }, 201)
    if (init.method === 'PATCH' && /\/issues\/[0-9]+$/.test(parsed.pathname)) return json({ number: 1 })
    return json({ message: 'unexpected' }, 404)
  }
  return { calls, fetchImpl }
}

test('the gate verdict decides the outcome, and a gate that never ran decides nothing', () => {
  assert.equal(gateOutcome('success'), 'success')
  assert.equal(gateOutcome('failure'), 'failure')
  // Only the gate job itself can be cancelled here: a cancelled run never starts this job.
  assert.equal(gateOutcome('cancelled'), 'failure')
  assert.equal(gateOutcome('skipped'), 'none')
})

test('only a newer run that finished with a verdict outranks this one, never one a later merge cancelled', () => {
  assert.equal(hasNewerVerdict([run(RUN_ID + 1, 'success', 'x'), currentRun], RUN_ID), true)
  assert.equal(hasNewerVerdict([run(RUN_ID + 1, 'failure', 'x'), currentRun], RUN_ID), true)
  assert.equal(hasNewerVerdict([run(RUN_ID + 2, 'cancelled', 'x'), run(RUN_ID + 1, null, 'x', 'queued'), currentRun, run(RUN_ID - 1, 'success', 'x')], RUN_ID), false)
  assert.equal(hasNewerVerdict([run(RUN_ID + 1, 'startup_failure', 'x'), currentRun], RUN_ID), false)
})

test('only an open bot issue that starts with the main alert marker counts as the alert', () => {
  const human = { ...botIssue(3), user: { login: 'github-actions[bot]', type: 'User' } }
  const pullRequest = { ...botIssue(4), pull_request: {} }
  const quoted = botIssue(5, `看这个：${ALERT_MARKER}`)
  const cosSync = botIssue(6, '<!-- xingmang-cos-sync-alert:sync-grok-cos.yml -->\n离线包')
  const closed = { ...botIssue(7), state: 'closed' }
  assert.equal(findMainAlertIssue([human, pullRequest, quoted, cosSync, closed]), null)
  assert.equal(findMainAlertIssue([botIssue(12), cosSync, botIssue(9)]).number, 9)
  assert.throws(() => findMainAlertIssue(null), /issue 列表/)
})

test('the aggregate checks are named only when nothing more specific failed', () => {
  assert.deepEqual(reportedJobs(['windows-test (vitest-2)', 'test', 'quality-gate']), ['windows-test (vitest-2)'])
  assert.deepEqual(reportedJobs(['test', 'quality-gate']), ['test', 'quality-gate'])
  assert.deepEqual(reportedJobs([]), [])
})

test('the alert body links the run and commit, gives Beijing time, and says cancelled runs do not count', () => {
  const body = buildMainAlertBody({ runNumber: 2852, runUrl: 'https://github.com/r/actions/runs/1', sha: SHA, commitUrl: `https://github.com/r/commit/${SHA}`,
    startedAt: '2026-10-18T12:28:00Z', failedJobs: ['windows-test (vitest-2)', 'linux-test'] })
  assert.ok(body.startsWith(`${ALERT_MARKER}\n`))
  assert.match(body, /\[第 2852 次运行\]\(https:\/\/github\.com\/r\/actions\/runs\/1\)/)
  assert.match(body, /提交 \[`081edd7`\]\(https:\/\/github\.com\/r\/commit\/081edd7/)
  assert.match(body, /北京时间 2026-10-18 20:28 开始/)
  assert.match(body, /`windows-test \(vitest-2\)`、`linux-test`/)
  assert.match(body, /被后来的合并取消的运行不算数/)
  assert.match(buildMainAlertBody({ runNumber: 1, runUrl: 'u', sha: SHA, commitUrl: 'c', startedAt: 'x', failedJobs: [] }), /没取到作业名/)
  assert.equal(buildRecoveryComment({ runNumber: 2853, runUrl: 'u', sha: SHA, commitUrl: 'c' }), '[第 2853 次运行](u)（提交 [`081edd7`](c)）在 main 上完整跑完并通过，自动关闭。')
})

test('the first red run opens the alert, later red runs edit it, and a green run closes it', () => {
  assert.deepEqual(planMainAlertAction({ outcome: 'failure', issue: null }), { type: 'create' })
  assert.deepEqual(planMainAlertAction({ outcome: 'failure', issue: { number: 4 } }), { type: 'update', number: 4 })
  assert.deepEqual(planMainAlertAction({ outcome: 'success', issue: { number: 4 } }), { type: 'close', number: 4 })
  assert.deepEqual(planMainAlertAction({ outcome: 'success', issue: null }), { type: 'none' })
  assert.deepEqual(planMainAlertAction({ outcome: 'none', issue: { number: 4 } }), { type: 'none' })
})

test('the environment must be a push to main of a repository on github.com', () => {
  assert.equal(readMainAlertEnvironment(env('failure')).sha, SHA)
  for (const overrides of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_REF: 'refs/heads/claude/x' },
    { GITHUB_API_URL: 'https://ghe.example.test/api/v3' }, { GITHUB_SERVER_URL: 'https://ghe.example.test' }, { GITHUB_REPOSITORY: 'xufei5620/../x' },
    { GITHUB_REPOSITORY_OWNER: 'someone-else' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: '1e3' }, { GITHUB_RUN_NUMBER: '' }, { GITHUB_SHA: 'main' },
    { GITHUB_SHA: SHA.toUpperCase() }, { QUALITY_GATE_RESULT: 'neutral' }, { QUALITY_GATE_RESULT: undefined }]) {
    assert.throws(() => readMainAlertEnvironment(env('failure', overrides)))
  }
})

test('a red run on main opens one assigned issue that names the failing job', async () => {
  const github = server({ runs: [currentRun, run(RUN_ID - 9, 'cancelled', '2026-10-18T12:18:30Z'), run(RUN_ID - 20, 'success', '2026-10-18T04:45:47Z')] })
  const action = await runMainAlert({ env: env('failure'), fetchImpl: github.fetchImpl, log() {} })
  assert.deepEqual(action, { type: 'create' })
  const writes = github.calls.filter((call) => call.method !== 'GET')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, `/repos/${REPOSITORY}/issues`)
  assert.equal(writes[0].body.title, ALERT_TITLE)
  assert.deepEqual(writes[0].body.assignees, ['xufei5620'])
  assert.match(writes[0].body.body, /失败的作业：`windows-test \(vitest-2\)`。/)
  assert.match(writes[0].body.body, /北京时间 2026-10-18 20:28 开始/)
  assert.ok(github.calls[0].path.includes('creator=github-actions%5Bbot%5D'))
  assert.ok(github.calls[1].path.includes('branch=main&event=push'))
  assert.ok(github.calls[2].path.endsWith('/jobs?filter=latest&per_page=100'))
  assert.ok(github.calls.every((call) => call.init.headers['user-agent'] === 'xingmang-main-ci-alert'))
  assert.ok(github.calls.every((call) => !JSON.stringify(call.body || {}).includes(TOKEN)))
})

test('main still red edits the open alert instead of opening another', async () => {
  const github = server({ issues: [botIssue(41)] })
  assert.deepEqual(await runMainAlert({ env: env('cancelled'), fetchImpl: github.fetchImpl, log() {} }), { type: 'update', number: 41 })
  const writes = github.calls.filter((call) => call.method !== 'GET')
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), [`PATCH /repos/${REPOSITORY}/issues/41`])
  assert.deepEqual(Object.keys(writes[0].body), ['body'])
})

test('a green run on main comments on and closes the open alert', async () => {
  const github = server({ issues: [botIssue(41)] })
  assert.deepEqual(await runMainAlert({ env: env('success'), fetchImpl: github.fetchImpl, log() {} }), { type: 'close', number: 41 })
  assert.deepEqual(github.calls.map((call) => `${call.method} ${call.path.split('?')[0]}`), [
    `GET /repos/${REPOSITORY}/issues`,
    `GET /repos/${REPOSITORY}/actions/workflows/quality.yml/runs`,
    `POST /repos/${REPOSITORY}/issues/41/comments`,
    `PATCH /repos/${REPOSITORY}/issues/41`,
  ])
  assert.match(github.calls[2].body.body, /在 main 上完整跑完并通过，自动关闭/)
  assert.deepEqual(github.calls[3].body, { state: 'closed', state_reason: 'completed' })
})

test('re-running an older run neither opens, edits nor closes once a newer run on main has a verdict', async () => {
  const runs = [run(RUN_ID + 50, 'failure', '2026-10-18T13:10:00Z'), currentRun]
  for (const [gate, issues] of [['success', [botIssue(41)]], ['failure', [botIssue(41)]], ['failure', []]]) {
    const github = server({ issues, runs })
    assert.deepEqual(await runMainAlert({ env: env(gate), fetchImpl: github.fetchImpl, log() {} }), { type: 'none' })
    assert.ok(github.calls.every((call) => call.method === 'GET'))
  }
})

test('a green run with no alert open reads once, and a gate that never ran reads nothing', async () => {
  const quiet = server()
  assert.deepEqual(await runMainAlert({ env: env('success'), fetchImpl: quiet.fetchImpl, log() {} }), { type: 'none' })
  assert.deepEqual(quiet.calls.map((call) => call.method), ['GET'])
  const skipped = server({ issues: [botIssue(41)] })
  assert.deepEqual(await runMainAlert({ env: env('skipped'), fetchImpl: skipped.fetchImpl, log() {} }), { type: 'none' })
  assert.equal(skipped.calls.length, 0)
})
