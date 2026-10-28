const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const workflowDirectory = path.join(__dirname, '..', '.github', 'workflows')

// Which environment holds each stored secret. A job only receives an
// environment's secrets after that environment's protection rules pass: for
// `release` that is the required reviewers (the two approvals of a release) and
// the main-only deployment branch rule; for `cos-sync` it is the main-only rule
// (no reviewer, the scheduled syncs could not run otherwise), and `sentry` is the
// same main-only rule. Repository-level
// secrets have no such gate: any workflow pushed to any branch reads them.
//
// So the failure this file guards against is a two-step one. Someone adds a job
// that reads, say, R2_SECRET_ACCESS_KEY without `environment: release`; the job
// gets an empty value; the "fix" is to add a repository-level copy, and from then
// on the upload key is readable from every branch. Refusing the first step here
// keeps the second from ever looking necessary. Whether the copies on GitHub
// really are environment-level is a settings question this file cannot see; the
// check for that is in docs/RELEASING.md「release 环境要先配好」.
const environmentSecrets = new Map([
  ['CSC_NAME', 'release'],
  ['XINGMANG_MAC_SIGNING_P12_BASE64', 'release'],
  ['XINGMANG_MAC_SIGNING_P12_PASSWORD', 'release'],
  ['XINGMANG_MAC_SIGNING_SHA256', 'release'],
  ['R2_ACCOUNT_ID', 'release'],
  ['R2_BUCKET', 'release'],
  ['R2_ACCESS_KEY_ID', 'release'],
  ['R2_SECRET_ACCESS_KEY', 'release'],
  ['XINGMANG_UPDATE_SIGNING_KEY', 'release'],
  // release-build.yml is disabled until a CA certificate arrives, but it is still
  // dispatchable, so its signing secrets keep the same rule.
  ['WIN_CSC_LINK_BASE64', 'release'],
  ['WIN_CSC_KEY_PASSWORD', 'release'],
  ['XINGMANG_SIGNING_PUBLISHER', 'release'],
  ['COS_SECRET_ID', 'cos-sync'],
  ['COS_SECRET_KEY', 'cos-sync'],
  // G06：Sentry 组织令牌，只能建 release、传对照表。sentry 环境只放行 main、不设批准，
  // 跟 cos-sync 一样：挂 release 每次发版就要多批一次。
  ['SENTRY_AUTH_TOKEN', 'sentry'],
])

// 2026-10-18 yoyo 定：这两把照旧放仓库级（#1090）。访问统计令牌只有 Cloudflare
// 两项读权限；巡检密钥是额度很小的测试密钥，而且要在抬 CLI 版本的 PR 分支上实测，
// 挪进只给 main 的环境就测不了。往这张表里加名字等于放宽，要他亲手同意。
const repositoryLevelSecrets = ['CLOUDFLARE_ANALYTICS_TOKEN', 'XINGMANG_CLI_PATROL_KEY']

// The token GitHub mints for each run is not a stored secret and has its own
// `permissions:` scoping.
const automaticSecrets = ['GITHUB_TOKEN']

function readWorkflows() {
  return fs.readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ name, workflow: YAML.parse(fs.readFileSync(path.join(workflowDirectory, name), 'utf8')) }))
}

// Every place GitHub evaluates an expression: `${{ }}` inside any string, and
// `if:` values, which are expressions even without the wrapper. Comments are
// already gone after parsing, and plain text in a `run:` script is never
// evaluated, so `scan-new-commits-for-secrets.cjs` there is not a reference.
function collectExpressions(value, key, expressions) {
  if (typeof value === 'string') {
    if (key === 'if') expressions.push(value)
    for (const match of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) expressions.push(match[1])
  } else if (Array.isArray(value)) {
    for (const item of value) collectExpressions(item, null, expressions)
  } else if (value !== null && typeof value === 'object') {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      collectExpressions(entryKey, null, expressions)
      collectExpressions(entryValue, entryKey, expressions)
    }
  }
  return expressions
}

// Expression contexts and secret names are both case-insensitive on GitHub, so
// `Secrets.r2_bucket` reads R2_BUCKET. Anything other than a plain
// `secrets.NAME` (an index, `toJSON(secrets)`) reads a name this file cannot
// know, so it is reported as dynamic rather than guessed at.
function collectSecretReferences(value) {
  const names = new Set()
  let dynamic = false
  for (const expression of collectExpressions(value, null, [])) {
    for (const match of expression.matchAll(/(?<![\w.-])secrets\b(?:\s*\.\s*([A-Za-z_][\w-]*))?/gi)) {
      if (match[1]) names.add(match[1].toUpperCase())
      else dynamic = true
    }
  }
  return { names: [...names].sort(), dynamic }
}

function readEnvironmentName(environment) {
  const name = environment !== null && typeof environment === 'object' ? environment.name : environment
  return typeof name === 'string' ? name : null
}

function findSecretScopeViolations(workflowName, workflow) {
  const violations = []
  const { jobs = {}, ...outsideJobs } = workflow
  const topLevel = collectSecretReferences(outsideJobs)
  if (topLevel.names.length > 0 || topLevel.dynamic) {
    violations.push(`${workflowName}: reads secrets outside any job, where every job (and none of the environments) sees them`)
  }
  for (const [jobId, job] of Object.entries(jobs)) {
    const where = `${workflowName} job ${jobId}`
    if (job.secrets !== undefined) {
      violations.push(`${where}: passes secrets to a reusable workflow, which a caller job cannot put behind an environment`)
    }
    const environment = readEnvironmentName(job.environment)
    const { names, dynamic } = collectSecretReferences(job)
    if (dynamic) violations.push(`${where}: reads secrets by an expression this check cannot resolve to names`)
    for (const name of names) {
      if (automaticSecrets.includes(name) || repositoryLevelSecrets.includes(name)) continue
      const required = environmentSecrets.get(name)
      if (required === undefined) {
        violations.push(`${where}: reads ${name}, which is not registered with an environment in this file`)
      } else if (environment !== required) {
        violations.push(`${where}: reads ${name} but declares environment ${environment ?? '(none)'}, not ${required}`)
      }
    }
  }
  return violations
}

function readJobSecrets() {
  const reads = []
  for (const { name, workflow } of readWorkflows()) {
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      for (const secret of collectSecretReferences(job).names) reads.push(`${name} ${jobId} ${secret}`)
    }
  }
  return reads
}

test('every stored secret is read only by a job behind the environment that holds it', () => {
  const workflows = readWorkflows()
  assert.ok(workflows.length > 0, '.github/workflows must still hold the workflows')
  assert.deepEqual(workflows.flatMap(({ name, workflow }) => findSecretScopeViolations(name, workflow)), [])
})

test('the scan sees the secrets the release, sync and repository-level jobs really read', () => {
  const reads = readJobSecrets()
  for (const expected of [
    'publish-release.yml macos-build XINGMANG_MAC_SIGNING_P12_BASE64',
    'publish-release.yml publish R2_SECRET_ACCESS_KEY',
    'publish-release.yml publish XINGMANG_UPDATE_SIGNING_KEY',
    'publish-release.yml cos-sync COS_SECRET_KEY',
    'publish-release.yml sentry-sourcemaps SENTRY_AUTH_TOKEN',
    'rollback-release.yml rollback XINGMANG_UPDATE_SIGNING_KEY',
    'service-status.yml publish R2_ACCESS_KEY_ID',
    'acceleration-nodes.yml publish XINGMANG_UPDATE_SIGNING_KEY',
    'quality.yml cli-relay-probe XINGMANG_CLI_PATROL_KEY',
    'update-feed-stats.yml stats CLOUDFLARE_ANALYTICS_TOKEN',
  ]) {
    assert.ok(reads.includes(expected), `expected the scan to find: ${expected}`)
  }
  // The secret-scan job runs scan-new-commits-for-secrets.cjs; a text search for
  // "secrets." would count that file name as a secret called CJS.
  assert.equal(reads.some((read) => read.startsWith('quality.yml secret-scan ')), false)
})

test('only the two keys agreed on 2026-10-18 live at repository level, and both are still in use', () => {
  assert.deepEqual([...repositoryLevelSecrets].sort(), ['CLOUDFLARE_ANALYTICS_TOKEN', 'XINGMANG_CLI_PATROL_KEY'])
  for (const name of repositoryLevelSecrets) {
    assert.equal(environmentSecrets.has(name), false, `${name} cannot be both repository-level and environment-level`)
  }
  // A repository-level key nothing reads any more should be deleted on GitHub
  // and dropped from the list, not kept around readable from every branch.
  const read = new Set(readJobSecrets().map((entry) => entry.split(' ')[2]))
  assert.deepEqual(repositoryLevelSecrets.filter((name) => !read.has(name)), [])
})

test('a job reading a protected secret outside its environment is reported', () => {
  function violations(job, extra = {}) {
    return findSecretScopeViolations('probe.yml', { on: { push: {} }, ...extra, jobs: { probe: { 'runs-on': 'ubuntu-latest', ...job } } })
  }
  function step(env) {
    return { steps: [{ run: 'true', env }] }
  }

  assert.deepEqual(violations({ environment: 'release', ...step({ KEY: '${{ secrets.R2_SECRET_ACCESS_KEY }}' }) }), [])
  assert.deepEqual(violations({ environment: { name: 'release', url: 'https://example.invalid' }, ...step({ KEY: '${{ secrets.R2_BUCKET }}' }) }), [])
  assert.deepEqual(violations({ environment: 'cos-sync', ...step({ KEY: '${{ secrets.COS_SECRET_ID }}' }) }), [])
  assert.deepEqual(violations(step({ KEY: '${{ secrets.CLOUDFLARE_ANALYTICS_TOKEN }}', TOKEN: '${{ secrets.GITHUB_TOKEN }}' })), [])
  assert.deepEqual(violations({ steps: [{ run: 'node scripts/scan-new-commits-for-secrets.cjs' }] }), [])
  assert.deepEqual(violations(step({ VALUE: '${{ github.event.inputs.secrets }}' })), [])

  assert.match(violations(step({ KEY: '${{ secrets.R2_SECRET_ACCESS_KEY }}' })).join('\n'), /reads R2_SECRET_ACCESS_KEY but declares environment \(none\), not release/)
  assert.match(violations({ environment: 'cos-sync', ...step({ KEY: '${{ secrets.XINGMANG_UPDATE_SIGNING_KEY }}' }) }).join('\n'), /declares environment cos-sync, not release/)
  assert.match(violations({ environment: 'release', ...step({ KEY: '${{ secrets.COS_SECRET_KEY }}' }) }).join('\n'), /declares environment release, not cos-sync/)
  assert.match(violations({ environment: '${{ inputs.target }}', ...step({ KEY: '${{ secrets.R2_BUCKET }}' }) }).join('\n'), /not release/)
  assert.match(violations(step({ KEY: '${{ Secrets.r2_bucket }}' })).join('\n'), /reads R2_BUCKET/)
  assert.match(violations({ steps: [{ if: "secrets.R2_BUCKET != ''", run: 'true' }] }).join('\n'), /reads R2_BUCKET/)
  assert.match(violations(step({ KEY: '${{ secrets.NEW_TOKEN }}' })).join('\n'), /reads NEW_TOKEN, which is not registered/)
  assert.match(violations({ environment: 'release', ...step({ ALL: '${{ toJSON(secrets) }}' }) }).join('\n'), /cannot resolve to names/)
  assert.match(violations({ environment: 'release', ...step({ KEY: "${{ secrets['R2_BUCKET'] }}" }) }).join('\n'), /cannot resolve to names/)
  assert.match(violations({ uses: './.github/workflows/other.yml', secrets: 'inherit' }).join('\n'), /reusable workflow/)
  assert.match(violations({ steps: [{ run: 'true' }] }, { env: { KEY: '${{ secrets.R2_BUCKET }}' } }).join('\n'), /outside any job/)
})
