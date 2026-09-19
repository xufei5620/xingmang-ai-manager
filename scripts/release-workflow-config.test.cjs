const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const root = path.resolve(__dirname, '..')
const workflow = YAML.parse(
  fs.readFileSync(path.join(root, '.github', 'workflows', 'release-build.yml'), 'utf8'),
)
const installerJob = workflow.jobs['windows-installer']
const testSigningOnly = '${{ inputs.test_signing }}'

function stepsRunning(pattern) {
  return installerJob.steps.filter((step) => pattern.test(String(step.run || '')))
}

test('only a test-signed build may plant the signing certificate in the runner trust stores', () => {
  // P-03: Get-AuthenticodeSignature reports Valid only when the chain is
  // trusted, so importing the signing certificate into LocalMachine\Root makes
  // the release gate assert a conclusion it manufactured one step earlier. A
  // production certificate must prove its own chain on a clean Windows — a
  // missing intermediate CA or an unreachable timestamp service has to fail
  // here rather than on the customer's machine.
  const rootImports = stepsRunning(/Cert:\\LocalMachine\\Root/)
  assert.equal(rootImports.length, 1, 'exactly one step may write to the runner root store')
  assert.equal(rootImports[0].if, testSigningOnly, 'the root store import must be gated on test_signing')

  const certificateImports = stepsRunning(/Import-PfxCertificate/)
  assert.ok(certificateImports.length > 0, 'the self-signed test path must keep its certificate import')
  for (const step of certificateImports) {
    assert.equal(step.if, testSigningOnly, `${step.name} must be gated on test_signing`)
  }
})

test('the release build runs inside the protected release environment', () => {
  // P-06: workflow_dispatch accepts an arbitrary ref, so repository-level
  // secrets stay readable from a throwaway branch pushed by anyone with write
  // access. The environment is what scopes them; its protection rules live in
  // the repository settings (see docs/RELEASING.md).
  assert.equal(installerJob.environment, 'release')
  assert.equal(workflow.permissions.contents, 'read')
})

test('a dispatch input never reaches a PowerShell script as source text', () => {
  // P-26: `${{ ... }}` inside a run block is substituted into the script before
  // PowerShell parses it, so an input holding a single quote closes the string
  // literal and executes the rest — on the one runner that can read the signing
  // certificate. Anyone with write access can dispatch this workflow, so the
  // inputs have to arrive as environment bindings and be read back as $env:.
  for (const step of installerJob.steps) {
    const script = String(step.run || '')
    if (!script) continue
    assert.doesNotMatch(
      script,
      /\$\{\{\s*inputs\./,
      `${step.name || step.uses}: bind the input under env: and read $env: instead`,
    )
  }

  const confirmStep = installerJob.steps.find((step) => /ConvertFrom-Json\)\.version/.test(String(step.run || '')))
  assert.ok(confirmStep, 'the version confirmation must survive the rewrite')
  assert.equal(confirmStep.env.CONFIRM_VERSION, '${{ inputs.confirm_version }}')
  assert.match(confirmStep.run, /\$env:CONFIRM_VERSION/)

  const updateFeedStep = installerJob.steps.find((step) => /自签名构建必须显式指定 update_url/.test(String(step.run || '')))
  assert.ok(updateFeedStep, 'the production-feed refusal must survive the rewrite')
  assert.equal(updateFeedStep.env.UPDATE_URL, '${{ inputs.update_url }}')
  assert.match(updateFeedStep.run, /\$env:UPDATE_URL/)
})

test('the signing path is still exercised end to end', () => {
  // The hardening above must not become "stop signing": the release gate and
  // the three secrets it consumes have to stay wired up.
  const buildStep = installerJob.steps.find((step) => step.run === 'npm run release:build')

  assert.ok(buildStep, 'the installer must still be produced through the release gate')
  assert.equal(buildStep.env.WIN_CSC_LINK, '${{ secrets.WIN_CSC_LINK_BASE64 }}')
  assert.equal(buildStep.env.WIN_CSC_KEY_PASSWORD, '${{ secrets.WIN_CSC_KEY_PASSWORD }}')
  assert.equal(buildStep.env.XINGMANG_SIGNING_PUBLISHER, '${{ secrets.XINGMANG_SIGNING_PUBLISHER }}')
  assert.doesNotMatch(JSON.stringify(workflow.jobs), /dl:publish|--publish always/)
})
