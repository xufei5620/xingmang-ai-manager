const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const {
  HOSTS_BLOCK_BEGIN,
  HOSTS_BLOCK_END,
  addHostsBlock,
  collectProductionHosts,
  extractProductionHosts,
  isLoopbackAddress,
  productionDomains,
  removeHostsBlock,
  waitUntilBlocked,
} = require('./ci-block-production-hosts.cjs')

const root = path.resolve(__dirname, '..')
const workflowsDirectory = path.join(root, '.github', 'workflows')
const blockCommand = 'node scripts/ci-block-production-hosts.cjs'

// A step that starts the real client: a smoke under e2e/ (packaged or `electron .`), the
// page walk, the release gates (they run the packaged smokes) and the macOS rehearsals.
// Deliberately broad: a step that only looks like a launch costs one early hosts edit.
const clientLaunchPatterns = [
  /\bnode e2e\/[\w.-]+\.mjs\b/,
  /\bnpm run (?:verify:app|release:build(?::unsigned)?|test:mac:[\w:-]+)\b/,
  /\bscripts\/upgrade-smoke\.cjs\s+--old-installer\b/,
]

// Jobs that start the client without the hosts step, each with the reason it cannot
// take it. A key is `<workflow file>` for every job in it, or `<workflow file>#<job>`.
const exemptions = new Map([
  ['upgrade-smoke.yml', 'scripts/upgrade-smoke.cjs cuts the network itself before the first launch (Windows firewall, macOS hosts and pf) and proves it held.'],
  ['publish-release.yml', 'The release jobs read the live update directory (acceleration-nodes check, the release gate preflight) before they launch; those few launches per release carry the CI user agent marker.'],
  ['release-build.yml', 'The release gate reads the live update manifest first and launches the packaged smokes inside the same step; its launches carry the CI user agent marker.'],
  ['package-for-testing.yml#windows-package', 'release:build:unsigned reads the live update manifest in its preflight and launches the packaged smokes later in the same step; its launches carry the CI user agent marker.'],
])

function readWorkflows() {
  return fs.readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({ name, workflow: YAML.parse(fs.readFileSync(path.join(workflowsDirectory, name), 'utf8')) }))
}

function stepCommand(step) {
  return typeof step.run === 'string' ? step.run : ''
}

function jobCommands(job) {
  const matrix = job.strategy?.matrix?.include
  const matrixCommands = Array.isArray(matrix) ? matrix.map((entry) => String(entry.command ?? '')) : []
  return (job.steps || []).map((step) => {
    const command = stepCommand(step)
    return command.includes('matrix.command') ? `${command}\n${matrixCommands.join('\n')}` : command
  })
}

function firstLaunchIndex(job) {
  return jobCommands(job).findIndex((command) => clientLaunchPatterns.some((pattern) => pattern.test(command)))
}

function blockIndex(job) {
  return (job.steps || []).findIndex((step) => stepCommand(step).trim() === blockCommand)
}

function exemptionFor(workflowName, jobName) {
  return exemptions.get(`${workflowName}#${jobName}`) ?? exemptions.get(workflowName) ?? null
}

test('production hosts come from URLs and bare names under the production domains only', () => {
  const hosts = extractProductionHosts([
    "const a = 'https://XM.solov.cc/api/status'",
    "origin: 'https://xm-direct.solov.cc', aliases: ['https://38.147.105.28:8443']",
    "const feed = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'",
    "host: 'api-direct.solov.cc'",
    'https://registry.npmjs.org/ https://github.com/ https://example.com/',
    // A lookalike keeps its whole name instead of being cut down to a real one.
    "'https://xm.solov.cc.evil.example' 'evil-xm.solov.cc' 'notsolov.cc'",
  ])
  assert.deepEqual(hosts, ['api-direct.solov.cc', 'evil-xm.solov.cc', 'updatesnew.shenfengwl.fun', 'xm-direct.solov.cc', 'xm.solov.cc'])
  assert.deepEqual(productionDomains, ['solov.cc', 'shenfengwl.fun'])
})

test('the client source names every account, line and update host the launches reach', () => {
  const hosts = collectProductionHosts()
  for (const host of ['xm.solov.cc', 'xm-direct.solov.cc', 'api.solov.cc', 'api-direct.solov.cc', 'updatesnew.shenfengwl.fun']) {
    assert.ok(hosts.includes(host), `${host} must be blocked`)
  }
  for (const host of hosts) {
    assert.ok(productionDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)), `${host} is not a production host`)
  }
})

test('hosts named only by tests and fixtures are left out of the block', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ci-hosts-test-'))
  try {
    const write = (relative, text) => {
      fs.mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true })
      fs.writeFileSync(path.join(fixture, relative), text)
    }
    write('electron/relay-sites.ts', "export const origin = 'https://xm.solov.cc'\n")
    write('electron/relay-sites.test.ts', "expect('https://only-in-a-test.solov.cc')\n")
    write('electron/update.browser.test.ts', "'https://only-in-a-browser-test.solov.cc'\n")
    write('src/renderer-v2/pages-home.tsx', "const docs = 'https://docs-new.solov.cc'\n")
    write('src/renderer-v2/testing/app-check.ts', "'https://fixture.solov.cc'\n")
    write('electron-builder.config.cjs', 'module.exports = {}\n')
    write('scripts/update-release-utils.cjs', "const NEW_UPDATE_URL = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'\n")
    assert.deepEqual(collectProductionHosts(fixture), ['docs-new.solov.cc', 'updatesnew.shenfengwl.fun', 'xm.solov.cc'])
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('the hosts block sends every name to both loopback addresses and replaces an earlier block', () => {
  const original = '127.0.0.1 localhost\r\n::1 localhost'
  const once = addHostsBlock(original, ['xm.solov.cc', 'xm-direct.solov.cc'])
  assert.equal(once, [
    '127.0.0.1 localhost',
    '::1 localhost',
    HOSTS_BLOCK_BEGIN,
    '127.0.0.1 xm.solov.cc',
    '::1 xm.solov.cc',
    '127.0.0.1 xm-direct.solov.cc',
    '::1 xm-direct.solov.cc',
    HOSTS_BLOCK_END,
    '',
  ].join('\n'))
  const twice = addHostsBlock(once, ['api.solov.cc'])
  assert.equal(twice.split(HOSTS_BLOCK_BEGIN).length, 2, 'a second run must not stack a second block')
  assert.ok(twice.includes('127.0.0.1 api.solov.cc\n::1 api.solov.cc\n'))
  assert.ok(!twice.includes('xm.solov.cc'))
  assert.equal(removeHostsBlock(twice), '127.0.0.1 localhost\n::1 localhost\n')
  assert.throws(() => removeHostsBlock(`${HOSTS_BLOCK_BEGIN}\n127.0.0.1 xm.solov.cc\n`), /没有结尾/)
})

test('only loopback answers count as blocked', () => {
  for (const address of ['127.0.0.1', '127.0.1.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true, address)
  for (const address of ['38.147.105.28', '104.21.0.1', '0.0.0.0', '::', '2606:4700::1']) assert.equal(isLoopbackAddress(address), false, address)
})

test('the block is proven by resolving every name, rewritten while a name still leaks, and fails past its budget', async () => {
  let clock = 0
  const sleep = async (milliseconds) => { clock += milliseconds }
  const now = () => clock

  const immediate = await waitUntilBlocked(['xm.solov.cc'], {
    resolve: async () => ['127.0.0.1', '::1'], retry: () => assert.fail('nothing leaked'), sleep, budgetMs: 60_000, pollMs: 2_000, now,
  })
  assert.deepEqual(immediate, { retries: 0, elapsedMs: 0 })

  // A name the system cannot resolve at all reaches nothing either.
  const unresolved = await waitUntilBlocked(['xm.solov.cc'], {
    resolve: async () => [], retry: () => assert.fail('nothing leaked'), sleep, budgetMs: 60_000, pollMs: 2_000, now,
  })
  assert.equal(unresolved.retries, 0)

  const rewrites = []
  let answers = 0
  const settled = await waitUntilBlocked(['xm.solov.cc', 'api.solov.cc'], {
    resolve: async (host) => (host === 'api.solov.cc' && answers++ < 2 ? ['104.21.0.1'] : ['127.0.0.1']),
    retry: (leaking) => rewrites.push(leaking),
    sleep, budgetMs: 60_000, pollMs: 2_000, now,
  })
  assert.deepEqual(rewrites, [['api.solov.cc'], ['api.solov.cc']])
  assert.equal(settled.retries, 2)

  clock = 0
  await assert.rejects(waitUntilBlocked(['xm.solov.cc', 'xm-direct.solov.cc'], {
    resolve: async (host) => (host === 'xm-direct.solov.cc' ? ['38.147.105.28'] : ['127.0.0.1']),
    retry: () => undefined, sleep, budgetMs: 10_000, pollMs: 2_000, now,
  }), /xm-direct\.solov\.cc/)
})

test('the script refuses to edit a hosts file outside a GitHub-hosted runner', () => {
  const { spawnSync } = require('node:child_process')
  const environment = { ...process.env }
  delete environment.GITHUB_ACTIONS
  delete environment.RUNNER_ENVIRONMENT
  const result = spawnSync(process.execPath, [path.join(__dirname, 'ci-block-production-hosts.cjs')], { env: environment, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /只能在 GitHub 托管的一次性 runner 上跑/)
})

test('every CI job that starts the client cuts the production hosts first', () => {
  const missing = []
  for (const { name, workflow } of readWorkflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
      const launch = firstLaunchIndex(job)
      if (launch === -1 || exemptionFor(name, jobName)) continue
      const block = blockIndex(job)
      if (block === -1 || block > launch) missing.push(`${name}#${jobName}`)
    }
  }
  assert.deepEqual(missing, [], `Add a step running \`${blockCommand}\` before the first launch in these jobs, or exempt them here with the reason`)
})

test('the quality jobs that start the client are the ones covered', () => {
  const { workflow } = readWorkflows().find((entry) => entry.name === 'quality.yml')
  const launching = Object.entries(workflow.jobs).filter(([, job]) => firstLaunchIndex(job) !== -1).map(([name]) => name).sort()
  assert.deepEqual(launching, ['linux-package', 'macos-intel', 'macos-release-rehearsal', 'macos-test', 'windows-package'])
  for (const name of launching) assert.notEqual(blockIndex(workflow.jobs[name]), -1, name)
  // The relay probe has to reach the production relay; it must never inherit the block.
  assert.equal(blockIndex(workflow.jobs['cli-relay-probe']), -1)
})

test('every exemption still names a job that starts the client', () => {
  const workflows = new Map(readWorkflows().map((entry) => [entry.name, entry.workflow]))
  for (const [key, reason] of exemptions) {
    assert.ok(reason.length > 40, `${key} needs a reason`)
    const [workflowName, jobName] = key.split('#')
    const workflow = workflows.get(workflowName)
    assert.ok(workflow, `${workflowName} no longer exists`)
    const jobs = jobName ? [workflow.jobs[jobName]] : Object.values(workflow.jobs)
    assert.ok(jobs.every(Boolean), `${key} no longer exists`)
    assert.ok(jobs.some((job) => firstLaunchIndex(job) !== -1), `${key} no longer starts the client; drop the exemption`)
  }
})

test('the client marks its user agent before anything can reach the network', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8')
  const marker = main.indexOf('ensureCiUserAgentMarker(app, process.env)')
  assert.ok(marker !== -1, 'main.ts must mark the CI user agent')
  for (const later of ['createCrashReporter({', 'app.whenReady()', 'protocol.registerSchemesAsPrivileged(']) {
    const index = main.indexOf(later)
    assert.ok(index !== -1, `${later} moved; recheck the marker's position`)
    assert.ok(marker < index, `the CI user agent marker must come before ${later}`)
  }
  const source = fs.readFileSync(path.join(root, 'electron', 'ci-user-agent.ts'), 'utf8')
  assert.match(source, /export const ciUserAgentMarker = ' ci'/)
})
