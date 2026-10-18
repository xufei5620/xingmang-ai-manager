// main 上的 quality 完整跑完却没过时开一条 issue 报警，main 再红只改这条 issue，下一次在 main
// 上完整跑完并通过就留言并关闭。以前真跑完变红的那次只躺在 Actions 列表里，没人知道（#1090
// 第 5 条）。main 上开跑的运行不再被后来的合并取消（quality.yml 开头的 concurrency），还没开跑
// 就被更新的合并顶掉的、有人手动取消的，这里一律不算。只用本次运行自带的 GITHUB_TOKEN（作业级
// actions: read + issues: write），GitHub 客户端和 issue 列表与 cos-sync-alert.cjs 共用。
const { createGitHubClient, failedJobNames, formatBeijingTime, listOpenBotIssues, validateRuns, RUN_PAGE_SIZE } = require('./cos-sync-alert.cjs')

const SERVER_ORIGIN = 'https://github.com'
const API_ORIGIN = 'https://api.github.com'
const BOT_LOGIN = 'github-actions[bot]'
const WORKFLOW_FILE = 'quality.yml'
const ALERT_JOB = 'main-alert'
const ALERT_MARKER = `<!-- xingmang-main-ci-alert:${WORKFLOW_FILE} -->`
const ALERT_TITLE = 'main 上的 CI（quality）没过'
// These two only fold other jobs together, so they are red whenever anything
// else is; naming them next to the job that actually failed adds nothing.
const AGGREGATE_JOBS = new Set(['quality-gate', 'test'])
// A run that a newer merge cancelled has no verdict, and neither has one that
// never started: only these outrank the run reporting now.
const VERDICTS = new Set(['success', 'failure', 'timed_out'])
const GATE_RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

// `cancelled` here is the gate job alone running out of its own
// timeout-minutes; when the whole run is cancelled this job does not run at
// all (`!cancelled()` in quality.yml). A skipped gate means the run never got
// that far, so it says nothing either way.
function gateOutcome(result) {
  if (result === 'success') return 'success'
  if (result === 'failure' || result === 'cancelled') return 'failure'
  return 'none'
}

// A re-run keeps its run ID. When a newer push to main has already finished
// with a verdict, this one is history and must not open or close the alert
// over what that newer run said.
function hasNewerVerdict(runs, currentRunId) {
  return runs.some(function (run) { return run.id > currentRunId && run.status === 'completed' && VERDICTS.has(run.conclusion) })
}

function findMainAlertIssue(issues) {
  if (!Array.isArray(issues)) throw new Error('GitHub 返回的 issue 列表格式无效')
  const matches = issues.filter(function (issue) {
    return isRecord(issue) && isPositiveInteger(issue.number) && issue.state === 'open' && !Object.hasOwn(issue, 'pull_request')
      && isRecord(issue.user) && issue.user.login === BOT_LOGIN && issue.user.type === 'Bot'
      && typeof issue.body === 'string' && issue.body.startsWith(ALERT_MARKER)
  })
  if (!matches.length) return null
  return matches.reduce(function (oldest, issue) { return issue.number < oldest.number ? issue : oldest })
}

function reportedJobs(names) {
  const specific = names.filter(function (name) { return !AGGREGATE_JOBS.has(name) })
  return specific.length ? specific : names
}

function buildMainAlertBody({ runNumber, runUrl, sha, commitUrl, startedAt, failedJobs }) {
  const jobs = failedJobs.length ? failedJobs.map(function (name) { return `\`${name}\`` }).join('、') : '（没取到作业名，打开运行页面看）'
  return [
    ALERT_MARKER,
    `**main 上的 CI 没过**：PR 合进 main 以后，\`${WORKFLOW_FILE}\` 在 main 上又完整跑了一遍，没过。`,
    '',
    `**最近一次**：[第 ${runNumber} 次运行](${runUrl})，提交 [\`${sha.slice(0, 7)}\`](${commitUrl})，北京时间 ${formatBeijingTime(startedAt)} 开始。失败的作业：${jobs}。`,
    '',
    '**为什么要管**：每个 PR 合进来之前都按「当时合进 main 以后的样子」检查过，所以 main 红了多半是几个 PR 各自没问题、合到一起才出问题，也可能是偶发失败。修好之前，之后开的 PR 可能跟着红；从 main 出测试包或发版之前要先弄清原因。',
    '',
    '**怎么处理**：打开上面的链接，看红色的作业。是真问题，开 PR 修；是偶发的，main 上要是已经有更新的运行在跑，等它跑完就行，它通过了会自动关掉这条；没有的话，点「Re-run failed jobs」重跑。',
    '',
    `这条 issue 由 \`${WORKFLOW_FILE}\` 的 \`${ALERT_JOB}\` 作业自动开：main 再红只更新这段文字，不另开新的；main 下一次完整跑完并通过（重跑通过也算）会自动留言并关闭。被后来的合并取消的运行不算数。`,
  ].join('\n')
}

function buildRecoveryComment({ runNumber, runUrl, sha, commitUrl }) {
  return `[第 ${runNumber} 次运行](${runUrl})（提交 [\`${sha.slice(0, 7)}\`](${commitUrl})）在 main 上完整跑完并通过，自动关闭。`
}

function planMainAlertAction({ outcome, issue }) {
  if (outcome === 'failure') return issue ? { type: 'update', number: issue.number } : { type: 'create' }
  if (outcome === 'success' && issue) return { type: 'close', number: issue.number }
  return { type: 'none' }
}

function readMainAlertEnvironment(env) {
  if (typeof env.GITHUB_REPOSITORY !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(env.GITHUB_REPOSITORY)) throw new Error('GITHUB_REPOSITORY 无效')
  if (typeof env.GITHUB_REPOSITORY_OWNER !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(env.GITHUB_REPOSITORY_OWNER)
    || !env.GITHUB_REPOSITORY.startsWith(`${env.GITHUB_REPOSITORY_OWNER}/`)) throw new Error('GITHUB_REPOSITORY_OWNER 无效')
  if (env.GITHUB_API_URL !== undefined && env.GITHUB_API_URL !== API_ORIGIN || env.GITHUB_SERVER_URL !== undefined && env.GITHUB_SERVER_URL !== SERVER_ORIGIN) throw new Error('只支持 github.com 上的仓库')
  // The job's `if` already says this; repeating it here keeps a loosened
  // condition from ever reporting a pull request's merge commit as main.
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('只在推到 main 的运行里报警')
  const runId = Number(env.GITHUB_RUN_ID)
  const runNumber = Number(env.GITHUB_RUN_NUMBER)
  if (!/^[0-9]{1,16}$/.test(env.GITHUB_RUN_ID || '') || !isPositiveInteger(runId) || !/^[0-9]{1,10}$/.test(env.GITHUB_RUN_NUMBER || '') || !isPositiveInteger(runNumber)) throw new Error('GITHUB_RUN_ID 或 GITHUB_RUN_NUMBER 无效')
  if (typeof env.GITHUB_SHA !== 'string' || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA)) throw new Error('GITHUB_SHA 无效')
  if (!GATE_RESULTS.has(env.QUALITY_GATE_RESULT)) throw new Error('QUALITY_GATE_RESULT 无效')
  return { repository: env.GITHUB_REPOSITORY, owner: env.GITHUB_REPOSITORY_OWNER, runId, runNumber, sha: env.GITHUB_SHA, token: env.GITHUB_TOKEN,
    gateResult: env.QUALITY_GATE_RESULT }
}

async function runMainAlert({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const config = readMainAlertEnvironment(env)
  const outcome = gateOutcome(config.gateResult)
  if (outcome === 'none') {
    log('[main-alert] 这次 quality 没有跑到出结论，不改报警')
    return { type: 'none' }
  }
  const client = createGitHubClient({ token: config.token, repository: config.repository, fetchImpl, userAgent: 'xingmang-main-ci-alert' })
  const issue = findMainAlertIssue(await listOpenBotIssues(client, config.repository))
  if (outcome === 'success' && !issue) {
    log('[main-alert] main 通过，没有要关闭的报警')
    return { type: 'none' }
  }
  const runs = validateRuns(await client.request('GET', `/repos/${config.repository}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&event=push&per_page=${RUN_PAGE_SIZE}`))
  if (hasNewerVerdict(runs, config.runId)) {
    log('[main-alert] main 上已有更新的运行出了结论，报警以它为准，不改')
    return { type: 'none' }
  }
  const action = planMainAlertAction({ outcome, issue })
  const runUrl = `${SERVER_ORIGIN}/${config.repository}/actions/runs/${config.runId}`
  const commitUrl = `${SERVER_ORIGIN}/${config.repository}/commit/${config.sha}`
  if (action.type === 'create' || action.type === 'update') {
    const jobs = await client.request('GET', `/repos/${config.repository}/actions/runs/${config.runId}/jobs?filter=latest&per_page=100`)
    const current = runs.find(function (run) { return run.id === config.runId })
    const body = buildMainAlertBody({ runNumber: config.runNumber, runUrl, sha: config.sha, commitUrl,
      startedAt: current?.created_at || new Date().toISOString(), failedJobs: reportedJobs(failedJobNames(jobs)) })
    if (action.type === 'create') {
      const created = await client.request('POST', `/repos/${config.repository}/issues`, { title: ALERT_TITLE, body, assignees: [config.owner] })
      log(`[main-alert] main 没过，已开 issue #${created?.number}`)
    } else {
      await client.request('PATCH', `/repos/${config.repository}/issues/${action.number}`, { body })
      log(`[main-alert] main 还是没过，已更新 issue #${action.number}`)
    }
  } else if (action.type === 'close') {
    await client.request('POST', `/repos/${config.repository}/issues/${action.number}/comments`, {
      body: buildRecoveryComment({ runNumber: config.runNumber, runUrl, sha: config.sha, commitUrl }) })
    await client.request('PATCH', `/repos/${config.repository}/issues/${action.number}`, { state: 'closed', state_reason: 'completed' })
    log(`[main-alert] main 已恢复，已关闭 issue #${action.number}`)
  }
  return action
}

if (require.main === module) {
  runMainAlert().catch(function (error) {
    console.error(`[main-alert] ${error instanceof Error ? error.message : '报警失败'}`)
    process.exitCode = 1
  })
}

module.exports = { ALERT_MARKER, ALERT_TITLE, ALERT_JOB, gateOutcome, hasNewerVerdict, findMainAlertIssue, reportedJobs, buildMainAlertBody, buildRecoveryComment,
  planMainAlertAction, readMainAlertEnvironment, runMainAlert }
