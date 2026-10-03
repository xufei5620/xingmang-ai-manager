const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'sync-chatgpt-official-cos.yml')
const source = fs.readFileSync(workflowPath, 'utf8')
const workflow = YAML.parse(source)
const job = workflow.jobs.sync
const claudeWorkflow = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'sync-claude-official-cos.yml'), 'utf8'))

test('Claude backup packages support official native runners and independent manual platform selection', () => {
  assert.deepEqual(Object.keys(claudeWorkflow.on).sort(), ['schedule', 'workflow_dispatch'])
  assert.equal(claudeWorkflow.on.schedule[0].cron, '31 */6 * * *')
  assert.deepEqual(claudeWorkflow.on.workflow_dispatch.inputs.platforms.options, ['all', 'windows', 'macos', 'linux'])
  assert.equal(claudeWorkflow.on.workflow_dispatch.inputs.platforms.default, 'all')
  const select = claudeWorkflow.jobs.select
  const matrixStep = select.steps[0]
  assert.equal(select['runs-on'], 'ubuntu-latest')
  assert.equal(select.env, undefined)
  assert.deepEqual(Object.keys(matrixStep.env), ['PLATFORM_REQUEST'])
  assert.equal(matrixStep.env.PLATFORM_REQUEST, "${{ inputs.platforms || 'all' }}")
  assert.match(matrixStep.run, /platform: 'windows', runner: 'windows-latest'/)
  assert.match(matrixStep.run, /platform: 'macos', runner: 'macos-latest'/)
  assert.match(matrixStep.run, /platform: 'linux', runner: 'ubuntu-latest'/)
  assert.doesNotMatch(matrixStep.run, /\$\{\{|COS_SECRET|shell:\s*true/)
})

test('Claude native jobs serialize the shared index and preserve repository branch and opt-in gates', () => {
  const expectedGate = "${{ github.repository == 'xufei5620/xingmang-ai-manager' && github.ref == 'refs/heads/main' && vars.XINGMANG_COS_SYNC_ENABLED == 'true' }}"
  assert.equal(claudeWorkflow.jobs.select.if, expectedGate)
  const sync = claudeWorkflow.jobs.sync
  assert.equal(sync.if, expectedGate)
  assert.equal(sync.needs, 'select')
  assert.equal(sync.environment, 'cos-sync')
  assert.equal(sync['runs-on'], '${{ matrix.runner }}')
  assert.equal(sync.strategy['max-parallel'], 1)
  assert.equal(sync.strategy['fail-fast'], false)
  assert.equal(sync.strategy.matrix, '${{ fromJSON(needs.select.outputs.matrix) }}')
  assert.deepEqual(claudeWorkflow.permissions, { contents: 'read' })
  assert.deepEqual(claudeWorkflow.concurrency, { group: 'cos-claude-official-publish', 'cancel-in-progress': false })
})

test('Claude upload credentials are scoped to the native verification and publication step', () => {
  const sync = claudeWorkflow.jobs.sync
  assert.equal(sync.env, undefined)
  const steps = sync.steps.filter(step => Object.keys(step.env || {}).some(key => key.startsWith('COS_SECRET_')))
  assert.equal(steps.length, 1)
  assert.equal(steps[0].run, 'node scripts/sync-claude-official-cos.cjs')
  assert.equal(steps[0].env.COS_SECRET_ID, '${{ secrets.COS_SECRET_ID }}')
  assert.equal(steps[0].env.COS_SECRET_KEY, '${{ secrets.COS_SECRET_KEY }}')
  assert.equal(steps[0].env.CLAUDE_SYNC_PLATFORMS, '${{ matrix.platform }}')
  assert.doesNotMatch(steps[0].run, /inputs\.|secrets\./)
  for (const step of sync.steps.filter(entry => entry.uses)) {
    assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/)
    assert.equal(step.env, undefined)
  }
})

test('official package synchronization supports a timer and manual retry without relying on manager releases', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch'])
  assert.equal(workflow.on.schedule.length, 1)
  assert.equal(workflow.on.schedule[0].cron, '17 */6 * * *')
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platforms.options, ['all', 'windows', 'macos', 'linux',
    'windows-x64', 'windows-arm64', 'macos-arm64', 'macos-x64', 'linux-deb-x64', 'linux-deb-arm64', 'linux-rpm-x64', 'linux-rpm-arm64'])
  assert.equal(workflow.on.workflow_dispatch.inputs.platforms.default, 'all')
})

test('official package writes require the enabled owner repository and default branch', () => {
  assert.equal(job.if, "${{ github.repository == 'xufei5620/xingmang-ai-manager' && github.ref == 'refs/heads/main' && vars.XINGMANG_COS_SYNC_ENABLED == 'true' }}")
  assert.equal(job.environment, 'cos-sync')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.concurrency, { group: 'cos-chatgpt-official-publish', 'cancel-in-progress': false })
})

test('Windows signature checks run on Windows and credentials are scoped to the upload step', () => {
  assert.equal(job['runs-on'], 'windows-latest')
  assert.equal(job['timeout-minutes'], 90)
  assert.equal(job.env, undefined)
  const credentialSteps = job.steps.filter((step) => Object.keys(step.env || {}).some((key) => key.startsWith('COS_SECRET_')))
  assert.equal(credentialSteps.length, 1)
  assert.equal(credentialSteps[0].run, 'node scripts/sync-chatgpt-official-cos.cjs')
  assert.equal(credentialSteps[0].env.COS_SECRET_ID, '${{ secrets.COS_SECRET_ID }}')
  assert.equal(credentialSteps[0].env.COS_SECRET_KEY, '${{ secrets.COS_SECRET_KEY }}')
  assert.equal(credentialSteps[0].env.CHATGPT_SYNC_PLATFORMS, '${{ matrix.platform }}')
  assert.doesNotMatch(credentialSteps[0].run, /inputs\.|secrets\./)
  for (const step of job.steps.filter((entry) => entry.uses)) {
    assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/)
    assert.equal(step.env, undefined)
  }
})

test('the CAM policy retains only the two previously authorized distribution prefixes', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'cos-sync-policy.json'), 'utf8'))
  assert.equal(policy.version, '2.0')
  assert.equal(policy.statement.length, 1)
  assert.equal(policy.statement[0].effect, 'allow')
  assert.deepEqual(policy.statement[0].action, ['name/cos:GetObject', 'name/cos:HeadObject', 'name/cos:PutObject'])
  assert.deepEqual(policy.statement[0].resource, [
    'qcs::cos:ap-shanghai:uid/1342302199:xingmang-downloads-1342302199/xingmang/*',
    'qcs::cos:ap-shanghai:uid/1342302199:xingmang-downloads-1342302199/chatgpt/*',
  ])
})
