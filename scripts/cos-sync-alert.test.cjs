const assert = require('node:assert/strict')
const { test } = require('node:test')
const { FAILURE_THRESHOLD, RUN_PAGE_SIZE, alertMarker, summarizeNeeds, countPreviousFailures, findAlertIssue, failedJobNames,
  formatBeijingTime, buildAlertBody, planAlertAction, createGitHubClient, readAlertEnvironment, runCosSyncAlert } = require('./cos-sync-alert.cjs')

const REPOSITORY = 'xufei5620/xingmang-ai-manager'
const WORKFLOW = 'sync-claude-official-cos.yml'
const TOKEN = 'ghs_TESTTOKENVALUE'
const RUN_ID = 9001

function env(needs, overrides = {}) {
  return { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_OWNER: 'xufei5620', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: String(RUN_ID), GITHUB_RUN_NUMBER: '32', SYNC_WORKFLOW_FILE: WORKFLOW,
    SYNC_NEEDS: JSON.stringify(needs), ...overrides }
}

function run(id, conclusion, createdAt, status = 'completed') {
  return { id, run_number: id, created_at: createdAt, status, conclusion }
}

function botIssue(number, body = `${alertMarker(WORKFLOW)}\n旧内容`) {
  return { number, state: 'open', body, user: { login: 'github-actions[bot]', type: 'Bot' } }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function server({ runs = [], issues = [], jobs = [] } = {}) {
  const calls = []
  async function fetchImpl(url, init) {
    const parsed = new URL(url)
    calls.push({ method: init.method, path: `${parsed.pathname}${parsed.search}`, body: init.body === undefined ? undefined : JSON.parse(init.body), init })
    if (init.method === 'GET' && parsed.pathname === `/repos/${REPOSITORY}/issues`) return json(issues)
    if (init.method === 'GET' && parsed.pathname === `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs`) return json({ total_count: runs.length, workflow_runs: runs })
    if (init.method === 'GET' && parsed.pathname === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/jobs`) return json({ total_count: jobs.length, jobs })
    if (init.method === 'POST' && parsed.pathname === `/repos/${REPOSITORY}/issues`) return json({ number: 77 }, 201)
    if (init.method === 'POST' && /\/issues\/[0-9]+\/comments$/.test(parsed.pathname)) return json({ id: 1 }, 201)
    if (init.method === 'PATCH' && /\/issues\/[0-9]+$/.test(parsed.pathname)) return json({ number: 1 })
    return json({ message: 'unexpected' }, 404)
  }
  return { calls, fetchImpl }
}

const failedNeeds = { select: { result: 'success', outputs: { matrix: '{"include":[]}' } }, sync: { result: 'failure', outputs: {} } }
const passedNeeds = { select: { result: 'success', outputs: {} }, sync: { result: 'success', outputs: {} } }
const failedJobs = [
  { name: 'select', status: 'completed', conclusion: 'success' },
  { name: 'sync (windows, windows-latest)', status: 'completed', conclusion: 'success' },
  { name: 'sync (macos, macos-latest)', status: 'completed', conclusion: 'failure' },
  { name: 'alert', status: 'in_progress', conclusion: null },
]

test('a failed or cancelled job makes the run a failure and only a fully green run counts as success', () => {
  assert.equal(summarizeNeeds(JSON.stringify(failedNeeds)), 'failure')
  assert.equal(summarizeNeeds(JSON.stringify({ ...passedNeeds, sync: { result: 'cancelled' } })), 'failure')
  assert.equal(summarizeNeeds(JSON.stringify({ select: { result: 'success' }, sync: { result: 'failure' }, 'verify-index': { result: 'skipped' } })), 'failure')
  assert.equal(summarizeNeeds(JSON.stringify(passedNeeds)), 'success')
  assert.equal(summarizeNeeds(JSON.stringify({ select: { result: 'skipped' }, sync: { result: 'skipped' } })), 'skipped')
  assert.equal(summarizeNeeds(JSON.stringify({ select: { result: 'success' }, sync: { result: 'skipped' } })), 'skipped')
  for (const bad of [undefined, '', 'null', '[]', '{}', '{"sync":{"result":"neutral"}}', '{"sync":null}', ' '.repeat(64 * 1024 + 1)]) {
    assert.throws(() => summarizeNeeds(bad), /同步作业结果/)
  }
})

test('the streak counts only earlier finished runs and stops at the first one that did not fail', () => {
  const runs = [
    run(RUN_ID, null, '2026-10-10T12:52:00Z', 'in_progress'),
    run(31, 'failure', '2026-10-10T06:12:00Z'),
    run(30, 'cancelled', '2026-10-09T22:47:00Z'),
    run(29, 'success', '2026-10-09T13:38:00Z'),
    run(28, 'failure', '2026-10-09T06:28:00Z'),
  ]
  const streak = countPreviousFailures(runs, RUN_ID)
  assert.equal(streak.count, 2)
  assert.equal(streak.oldest.id, 30)
  assert.equal(streak.truncated, false)
  assert.equal(countPreviousFailures([run(RUN_ID, null, 'x', 'in_progress'), run(5, 'skipped', 'x'), run(4, 'failure', 'x')], RUN_ID).count, 0)
  assert.deepEqual(countPreviousFailures([], RUN_ID), { count: 0, oldest: null, truncated: false })
  const page = Array.from({ length: RUN_PAGE_SIZE }, (_, index) => run(index + 1, 'failure', '2026-10-01T00:00:00Z'))
  assert.equal(countPreviousFailures(page, RUN_ID).truncated, true)
})

test('only an open bot issue that starts with this workflow marker counts as the alert', () => {
  const human = { ...botIssue(3), user: { login: 'github-actions[bot]', type: 'User' } }
  const pullRequest = { ...botIssue(4), pull_request: {} }
  const quoted = botIssue(5, `看这个：${alertMarker(WORKFLOW)}`)
  const otherWorkflow = botIssue(6, alertMarker('sync-chatgpt-official-cos.yml'))
  const closed = { ...botIssue(7), state: 'closed' }
  assert.equal(findAlertIssue([human, pullRequest, quoted, otherWorkflow, closed], WORKFLOW), null)
  assert.equal(findAlertIssue([botIssue(12), otherWorkflow, botIssue(9)], WORKFLOW).number, 9)
  assert.throws(() => findAlertIssue(null, WORKFLOW), /issue 列表/)
})

test('failed job names are limited to finished failures and stripped before they reach Markdown', () => {
  assert.deepEqual(failedJobNames({ jobs: failedJobs }), ['sync (macos, macos-latest)'])
  assert.deepEqual(failedJobNames({ jobs: [{ name: 'sync [x](https://evil.test) `a`', status: 'completed', conclusion: 'cancelled' }] }), ['sync x(httpsevil.test) a'])
  assert.throws(() => failedJobNames({}), /作业列表/)
})

test('the alert body names the product, streak, Beijing time, run link and how to read the log', () => {
  const body = buildAlertBody({ workflowFile: WORKFLOW, product: 'Claude 桌面端', streak: 9, truncated: false, since: '2026-10-07T23:14:00Z',
    runNumber: 31, runUrl: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`, failedJobs: ['sync (macos, macos-latest)'] })
  assert.ok(body.startsWith(alertMarker(WORKFLOW)))
  assert.match(body, /\*\*Claude 桌面端离线包\*\*/)
  assert.match(body, /连续失败 \*\*9 次\*\*/)
  assert.match(body, /2026-10-08 07:14（北京时间）/)
  assert.match(body, /\[第 31 次运行\]\(https:\/\/github\.com\/xufei5620\/xingmang-ai-manager\/actions\/runs\/9001\)/)
  assert.match(body, /`sync \(macos, macos-latest\)`/)
  assert.match(body, /stage-failed/)
  assert.match(body, /自动更新和星芒一键安装都不经过 COS/)
  assert.match(buildAlertBody({ workflowFile: WORKFLOW, product: 'Codex 桌面端', streak: 51, truncated: true, since: 'bad', runNumber: 1, runUrl: 'u', failedJobs: [] }), /至少 \*\*51 次\*\*.*时间未知/)
  assert.equal(formatBeijingTime('2026-10-10T16:30:00Z'), '2026-10-11 00:30')
})

test('one failure stays quiet, the second opens the alert, later failures edit it and a success closes it', () => {
  assert.equal(FAILURE_THRESHOLD, 2)
  assert.deepEqual(planAlertAction({ outcome: 'failure', streak: 1, issue: null }), { type: 'none' })
  assert.deepEqual(planAlertAction({ outcome: 'failure', streak: 2, issue: null }), { type: 'create' })
  assert.deepEqual(planAlertAction({ outcome: 'failure', streak: 1, issue: { number: 4 } }), { type: 'update', number: 4 })
  assert.deepEqual(planAlertAction({ outcome: 'failure', streak: 5, issue: { number: 4 } }), { type: 'update', number: 4 })
  assert.deepEqual(planAlertAction({ outcome: 'success', streak: 0, issue: { number: 4 } }), { type: 'close', number: 4 })
  assert.deepEqual(planAlertAction({ outcome: 'success', streak: 0, issue: null }), { type: 'none' })
  assert.deepEqual(planAlertAction({ outcome: 'skipped', streak: 0, issue: { number: 4 } }), { type: 'none' })
})

test('the GitHub client stays on api.github.com under this repository, refuses redirects and bounds the response', async () => {
  const seen = []
  const client = createGitHubClient({ token: TOKEN, repository: REPOSITORY, fetchImpl: async (url, init) => { seen.push({ url, init }); return json([]) } })
  await client.request('GET', `/repos/${REPOSITORY}/issues?state=open`)
  assert.equal(seen[0].url, `https://api.github.com/repos/${REPOSITORY}/issues?state=open`)
  assert.equal(seen[0].init.redirect, 'error')
  assert.equal(seen[0].init.headers.authorization, `Bearer ${TOKEN}`)
  assert.ok(seen[0].init.signal instanceof AbortSignal)
  for (const path of ['/repos/other/repo/issues', `//evil.test/repos/${REPOSITORY}/issues`, `/repos/${REPOSITORY}/../../user`, 'https://evil.test/x', `/repos/${REPOSITORY}/issues\r\nx: y`]) {
    await assert.rejects(client.request('GET', path), /请求路径|请求地址/)
  }
  await assert.rejects(client.request('DELETE', `/repos/${REPOSITORY}/issues/1`), /请求路径/)
  assert.equal(seen.length, 1)

  const denied = createGitHubClient({ token: TOKEN, repository: REPOSITORY, fetchImpl: async () => json({ message: TOKEN }, 403) })
  await assert.rejects(denied.request('GET', `/repos/${REPOSITORY}/issues`), (error) => /HTTP 403/.test(error.message) && !error.message.includes(TOKEN))
  const huge = createGitHubClient({ token: TOKEN, repository: REPOSITORY,
    fetchImpl: async () => new Response('[]', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } }) })
  await assert.rejects(huge.request('GET', `/repos/${REPOSITORY}/issues`), /上限/)
  const streamed = createGitHubClient({ token: TOKEN, repository: REPOSITORY, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
  }), { status: 200 }) })
  await assert.rejects(streamed.request('GET', `/repos/${REPOSITORY}/issues`), /上限/)
  const offline = createGitHubClient({ token: TOKEN, repository: REPOSITORY, fetchImpl: async () => { throw new TypeError(`fetch failed ${TOKEN}`) } })
  await assert.rejects(offline.request('GET', `/repos/${REPOSITORY}/issues`), (error) => /连接失败/.test(error.message) && !error.message.includes(TOKEN))
  assert.throws(() => createGitHubClient({ token: '', repository: REPOSITORY }), /GITHUB_TOKEN/)
})

test('the environment must name a known sync workflow on github.com', () => {
  assert.equal(readAlertEnvironment(env(failedNeeds)).product, 'Claude 桌面端')
  assert.equal(readAlertEnvironment(env(failedNeeds, { SYNC_WORKFLOW_FILE: 'sync-chatgpt-official-cos.yml' })).product, 'Codex 桌面端')
  for (const overrides of [{ SYNC_WORKFLOW_FILE: 'quality.yml' }, { SYNC_WORKFLOW_FILE: undefined }, { GITHUB_API_URL: 'https://ghe.example.test/api/v3' },
    { GITHUB_SERVER_URL: 'https://ghe.example.test' }, { GITHUB_REPOSITORY: 'xufei5620/../x' }, { GITHUB_REPOSITORY_OWNER: 'someone-else' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: '1e3' }, { GITHUB_RUN_NUMBER: '' }]) {
    assert.throws(() => readAlertEnvironment(env(failedNeeds, overrides)))
  }
})

test('the first scheduled failure after a success only reads and opens nothing', async () => {
  const github = server({ runs: [run(RUN_ID, null, '2026-10-10T12:52:00Z', 'in_progress'), run(31, 'success', '2026-10-10T06:12:00Z')], jobs: failedJobs })
  const action = await runCosSyncAlert({ env: env(failedNeeds), fetchImpl: github.fetchImpl, log() {} })
  assert.deepEqual(action, { type: 'none' })
  assert.deepEqual(github.calls.map((call) => call.method), ['GET', 'GET'])
})

test('the second scheduled failure in a row opens one assigned issue that explains the outage', async () => {
  const github = server({ jobs: failedJobs, runs: [run(RUN_ID, null, '2026-10-10T12:52:00Z', 'in_progress'), run(31, 'failure', '2026-10-10T06:12:00Z'), run(30, 'success', '2026-10-09T22:47:00Z')] })
  const action = await runCosSyncAlert({ env: env(failedNeeds), fetchImpl: github.fetchImpl, log() {} })
  assert.deepEqual(action, { type: 'create' })
  const writes = github.calls.filter((call) => call.method !== 'GET')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, `/repos/${REPOSITORY}/issues`)
  assert.equal(writes[0].body.title, '离线包同步连续失败：Claude 桌面端')
  assert.deepEqual(writes[0].body.assignees, ['xufei5620'])
  assert.match(writes[0].body.body, /连续失败 \*\*2 次\*\*，最早一次是 2026-10-10 14:12/)
  assert.match(writes[0].body.body, /`sync \(macos, macos-latest\)`/)
  assert.ok(github.calls[0].path.includes('creator=github-actions%5Bbot%5D'))
  assert.ok(github.calls[1].path.includes('branch=main&event=schedule'))
  assert.ok(github.calls.every((call) => !JSON.stringify(call.body || {}).includes(TOKEN)))
})

test('a continuing failure edits the open alert instead of opening another', async () => {
  const github = server({ issues: [botIssue(41)], jobs: failedJobs, runs: [run(31, 'failure', '2026-10-10T06:12:00Z'), run(30, 'failure', '2026-10-09T22:47:00Z')] })
  const action = await runCosSyncAlert({ env: env(failedNeeds), fetchImpl: github.fetchImpl, log() {} })
  assert.deepEqual(action, { type: 'update', number: 41 })
  const writes = github.calls.filter((call) => call.method !== 'GET')
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), [`PATCH /repos/${REPOSITORY}/issues/41`])
  assert.deepEqual(Object.keys(writes[0].body), ['body'])
  assert.match(writes[0].body.body, /连续失败 \*\*3 次\*\*/)
})

test('a scheduled success comments on and closes the open alert without reading run history', async () => {
  const github = server({ issues: [botIssue(41)] })
  const action = await runCosSyncAlert({ env: env(passedNeeds), fetchImpl: github.fetchImpl, log() {} })
  assert.deepEqual(action, { type: 'close', number: 41 })
  assert.deepEqual(github.calls.map((call) => `${call.method} ${call.path.split('?')[0]}`), [
    `GET /repos/${REPOSITORY}/issues`,
    `POST /repos/${REPOSITORY}/issues/41/comments`,
    `PATCH /repos/${REPOSITORY}/issues/41`,
  ])
  assert.match(github.calls[1].body.body, /恢复正常更新/)
  assert.deepEqual(github.calls[2].body, { state: 'closed', state_reason: 'completed' })
})

test('a success with no alert open and a run whose jobs never ran both leave GitHub untouched', async () => {
  const quiet = server()
  assert.deepEqual(await runCosSyncAlert({ env: env(passedNeeds), fetchImpl: quiet.fetchImpl, log() {} }), { type: 'none' })
  assert.deepEqual(quiet.calls.map((call) => call.method), ['GET'])
  const skipped = server()
  assert.deepEqual(await runCosSyncAlert({ env: env({ select: { result: 'skipped' }, sync: { result: 'skipped' } }), fetchImpl: skipped.fetchImpl, log() {} }), { type: 'none' })
  assert.equal(skipped.calls.length, 0)
})
