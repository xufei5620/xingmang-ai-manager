// 官方离线包定时同步连续失败时开一条 issue 报警，之后的失败只改这条 issue，下一次定时同步
// 成功就留言并关闭。2026-10 两条同步各自连红了好几天（Codex 17 次、Claude Mac 9 次以上）
// 都没人发现：失败只躺在 Actions 列表里。这里只用本次运行自带的 GITHUB_TOKEN（作业级
// actions: read + issues: write），不接任何外部服务。
const API_ORIGIN = 'https://api.github.com'
const SERVER_ORIGIN = 'https://github.com'
const BOT_LOGIN = 'github-actions[bot]'
const FAILURE_THRESHOLD = 2
const RUN_PAGE_SIZE = 50
const ISSUE_PAGE_SIZE = 100
const ISSUE_PAGES = 3
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_NEEDS_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 20000
const WORKFLOWS = Object.freeze({
  'sync-claude-official-cos.yml': Object.freeze({ product: 'Claude 桌面端' }),
  'sync-chatgpt-official-cos.yml': Object.freeze({ product: 'Codex 桌面端' }),
})
// A job that runs out of timeout-minutes is reported as cancelled, and a long
// upload stuck on a slow network is exactly the failure this alert is for.
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure'])
const JOB_RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function alertMarker(workflowFile) {
  return `<!-- xingmang-cos-sync-alert:${workflowFile} -->`
}

// `needs` only says how each job ended; any failed or cancelled job means this
// scheduled sync did not refresh every download button.
function summarizeNeeds(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_NEEDS_BYTES) throw new Error('同步作业结果缺失或过大')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('同步作业结果不是有效 JSON') }
  if (!isRecord(value) || !Object.keys(value).length
    || Object.values(value).some(function (job) { return !isRecord(job) || !JOB_RESULTS.has(job.result) })) throw new Error('同步作业结果格式无效')
  const results = Object.values(value).map(function (job) { return job.result })
  if (results.some(function (result) { return result === 'failure' || result === 'cancelled' })) return 'failure'
  if (results.every(function (result) { return result === 'success' })) return 'success'
  return 'skipped'
}

function validateRuns(value) {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs) || value.workflow_runs.length > RUN_PAGE_SIZE
    || value.workflow_runs.some(function (run) {
      return !isRecord(run) || !isPositiveInteger(run.id) || !isPositiveInteger(run.run_number) || typeof run.created_at !== 'string'
        || typeof run.status !== 'string' || run.conclusion !== null && typeof run.conclusion !== 'string'
    })) throw new Error('GitHub 返回的运行列表格式无效')
  return value.workflow_runs
}

// Runs come newest first. Only earlier, finished runs count; the first one that
// did not fail ends the streak, so a skipped or successful run resets it.
function countPreviousFailures(runs, currentRunId) {
  const finished = runs.filter(function (run) { return run.id !== currentRunId && run.status === 'completed' })
  let count = 0
  while (count < finished.length && FAILED_CONCLUSIONS.has(finished[count].conclusion)) count += 1
  return { count, oldest: count ? finished[count - 1] : null, truncated: count === finished.length && runs.length >= RUN_PAGE_SIZE }
}

function findAlertIssue(issues, workflowFile) {
  if (!Array.isArray(issues)) throw new Error('GitHub 返回的 issue 列表格式无效')
  const marker = alertMarker(workflowFile)
  const matches = issues.filter(function (issue) {
    return isRecord(issue) && isPositiveInteger(issue.number) && issue.state === 'open' && !Object.hasOwn(issue, 'pull_request')
      && isRecord(issue.user) && issue.user.login === BOT_LOGIN && issue.user.type === 'Bot'
      && typeof issue.body === 'string' && issue.body.startsWith(marker)
  })
  if (!matches.length) return null
  return matches.reduce(function (oldest, issue) { return issue.number < oldest.number ? issue : oldest })
}

function failedJobNames(value) {
  if (!isRecord(value) || !Array.isArray(value.jobs)) throw new Error('GitHub 返回的作业列表格式无效')
  return value.jobs
    .filter(function (job) { return isRecord(job) && job.status === 'completed' && FAILED_CONCLUSIONS.has(job.conclusion) && typeof job.name === 'string' })
    // Job names come from our own matrix, but they still land in Markdown.
    .map(function (job) { return job.name.replace(/[^A-Za-z0-9 ._(),-]/g, '').trim().slice(0, 80) })
    .filter(Boolean)
    .slice(0, 10)
}

function formatBeijingTime(iso) {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '时间未知'
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function buildAlertBody({ workflowFile, product, streak, truncated, since, runNumber, runUrl, failedJobs }) {
  const jobs = failedJobs.length ? failedJobs.map(function (name) { return `\`${name}\`` }).join('、') : '（没取到作业名，打开运行页面看）'
  return [
    alertMarker(workflowFile),
    `**${product}离线包**往腾讯云 COS 的定时同步已经连续失败 ${truncated ? '至少 ' : ''}**${streak} 次**，最早一次是 ${formatBeijingTime(since)}（北京时间）。`,
    '',
    `**影响**：教程页上 ${product}的下载按钮停在上一次同步成功的版本。客户的自动更新和星芒一键安装都不经过 COS，不受影响。`,
    '',
    `**最近一次失败**：[第 ${runNumber} 次运行](${runUrl})，失败的作业：${jobs}。`,
    '',
    '**怎么看原因**：打开上面的链接，点红色的作业，在日志里搜 `stage-failed`：`stage` 是卡在哪一步，`failure.code` 是原因。只有一个平台的作业红时，只是那个平台没更新，其它平台照常。',
    '',
    `这条 issue 由 \`${workflowFile}\` 自动开：之后每次失败只更新这段文字，不另开新的；下一次定时同步成功会自动留言并关闭。`,
  ].join('\n')
}

function planAlertAction({ outcome, streak, issue }) {
  if (outcome === 'failure') {
    if (issue) return { type: 'update', number: issue.number }
    return streak >= FAILURE_THRESHOLD ? { type: 'create' } : { type: 'none' }
  }
  if (outcome === 'success' && issue) return { type: 'close', number: issue.number }
  return { type: 'none' }
}

async function readBoundedText(response) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error('GitHub API 响应声明大小超过上限')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(function () {})
      throw new Error('GitHub API 响应超过大小上限')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function createGitHubClient({ token, repository, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token || /[\r\n\s]/.test(token)) throw new Error('缺少 GITHUB_TOKEN')
  const prefix = `/repos/${repository}/`
  async function request(method, path, body) {
    if (!['GET', 'POST', 'PATCH'].includes(method) || typeof path !== 'string' || !path.startsWith(prefix) || /[\r\n#]|\.\./.test(path)) throw new Error('GitHub API 请求路径无效')
    const url = new URL(path, API_ORIGIN)
    if (url.origin !== API_ORIGIN) throw new Error('GitHub API 请求地址无效')
    let response
    try {
      response = await fetchImpl(url.href, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'xingmang-cos-sync-alert',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // The token must never follow a redirect to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' ? `GitHub API ${method} 超时` : `GitHub API ${method} 连接失败`)
    }
    const text = await readBoundedText(response)
    if (response.status < 200 || response.status > 299) throw new Error(`GitHub API ${method} 返回 HTTP ${response.status}`)
    if (!text) return null
    try { return JSON.parse(text) } catch { throw new Error('GitHub API 响应不是有效 JSON') }
  }
  return { request }
}

function readAlertEnvironment(env) {
  const workflowFile = env.SYNC_WORKFLOW_FILE
  if (typeof workflowFile !== 'string' || !Object.hasOwn(WORKFLOWS, workflowFile)) throw new Error('SYNC_WORKFLOW_FILE 不是受支持的同步工作流')
  if (typeof env.GITHUB_REPOSITORY !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(env.GITHUB_REPOSITORY)) throw new Error('GITHUB_REPOSITORY 无效')
  if (typeof env.GITHUB_REPOSITORY_OWNER !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(env.GITHUB_REPOSITORY_OWNER)
    || !env.GITHUB_REPOSITORY.startsWith(`${env.GITHUB_REPOSITORY_OWNER}/`)) throw new Error('GITHUB_REPOSITORY_OWNER 无效')
  if (env.GITHUB_API_URL !== undefined && env.GITHUB_API_URL !== API_ORIGIN || env.GITHUB_SERVER_URL !== undefined && env.GITHUB_SERVER_URL !== SERVER_ORIGIN) throw new Error('只支持 github.com 上的仓库')
  const runId = Number(env.GITHUB_RUN_ID)
  const runNumber = Number(env.GITHUB_RUN_NUMBER)
  if (!/^[0-9]{1,16}$/.test(env.GITHUB_RUN_ID || '') || !isPositiveInteger(runId) || !/^[0-9]{1,10}$/.test(env.GITHUB_RUN_NUMBER || '') || !isPositiveInteger(runNumber)) throw new Error('GITHUB_RUN_ID 或 GITHUB_RUN_NUMBER 无效')
  return { workflowFile, product: WORKFLOWS[workflowFile].product, repository: env.GITHUB_REPOSITORY, owner: env.GITHUB_REPOSITORY_OWNER,
    runId, runNumber, token: env.GITHUB_TOKEN, needs: env.SYNC_NEEDS }
}

async function listOpenBotIssues(client, repository) {
  const issues = []
  for (let page = 1; page <= ISSUE_PAGES; page += 1) {
    const batch = await client.request('GET', `/repos/${repository}/issues?state=open&creator=${encodeURIComponent(BOT_LOGIN)}&per_page=${ISSUE_PAGE_SIZE}&page=${page}`)
    if (!Array.isArray(batch)) throw new Error('GitHub 返回的 issue 列表格式无效')
    issues.push(...batch)
    if (batch.length < ISSUE_PAGE_SIZE) break
  }
  return issues
}

async function runCosSyncAlert({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const config = readAlertEnvironment(env)
  const outcome = summarizeNeeds(config.needs)
  if (outcome === 'skipped') {
    log('[cos-sync-alert] 本次同步作业没有完整运行，不改报警')
    return { type: 'none' }
  }
  const client = createGitHubClient({ token: config.token, repository: config.repository, fetchImpl })
  const issue = findAlertIssue(await listOpenBotIssues(client, config.repository), config.workflowFile)
  let streak = 0
  let previous = { count: 0, oldest: null, truncated: false }
  let current = null
  if (outcome === 'failure') {
    const runs = validateRuns(await client.request('GET', `/repos/${config.repository}/actions/workflows/${config.workflowFile}/runs?branch=main&event=schedule&per_page=${RUN_PAGE_SIZE}`))
    previous = countPreviousFailures(runs, config.runId)
    current = runs.find(function (run) { return run.id === config.runId }) || null
    streak = previous.count + 1
  }
  const action = planAlertAction({ outcome, streak, issue })
  const runUrl = `${SERVER_ORIGIN}/${config.repository}/actions/runs/${config.runId}`
  if (action.type === 'create' || action.type === 'update') {
    const failedJobs = failedJobNames(await client.request('GET', `/repos/${config.repository}/actions/runs/${config.runId}/jobs?filter=latest&per_page=100`))
    const since = previous.oldest?.created_at || current?.created_at || new Date().toISOString()
    const body = buildAlertBody({ workflowFile: config.workflowFile, product: config.product, streak, truncated: previous.truncated,
      since, runNumber: config.runNumber, runUrl, failedJobs })
    if (action.type === 'create') {
      const created = await client.request('POST', `/repos/${config.repository}/issues`, {
        title: `离线包同步连续失败：${config.product}`, body, assignees: [config.owner] })
      log(`[cos-sync-alert] 连续失败 ${streak} 次，已开 issue #${created?.number}`)
    } else {
      await client.request('PATCH', `/repos/${config.repository}/issues/${action.number}`, { body })
      log(`[cos-sync-alert] 连续失败 ${streak} 次，已更新 issue #${action.number}`)
    }
  } else if (action.type === 'close') {
    await client.request('POST', `/repos/${config.repository}/issues/${action.number}/comments`, {
      body: `[第 ${config.runNumber} 次定时同步](${runUrl})成功，${config.product}离线包恢复正常更新，自动关闭。` })
    await client.request('PATCH', `/repos/${config.repository}/issues/${action.number}`, { state: 'closed', state_reason: 'completed' })
    log(`[cos-sync-alert] 同步已恢复，已关闭 issue #${action.number}`)
  } else {
    log(outcome === 'failure' ? `[cos-sync-alert] 连续失败 ${streak} 次，未到 ${FAILURE_THRESHOLD} 次，先不开 issue` : '[cos-sync-alert] 同步成功，没有要关闭的报警')
  }
  return action
}

if (require.main === module) {
  runCosSyncAlert().catch(function (error) {
    console.error(`[cos-sync-alert] ${error instanceof Error ? error.message : '报警失败'}`)
    process.exitCode = 1
  })
}

module.exports = { FAILURE_THRESHOLD, RUN_PAGE_SIZE, alertMarker, summarizeNeeds, countPreviousFailures, findAlertIssue, failedJobNames,
  formatBeijingTime, buildAlertBody, planAlertAction, createGitHubClient, readAlertEnvironment, runCosSyncAlert }
