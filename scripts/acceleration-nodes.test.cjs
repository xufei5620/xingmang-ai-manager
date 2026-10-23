const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createHash, generateKeyPairSync, sign } = require('node:crypto')
const { test } = require('node:test')
const YAML = require('yaml')
const ts = require('typescript')
const {
  AccelerationNodesError,
  buildPayload,
  checkReleaseAgainstLive,
  describePlan,
  fetchLiveDocument,
  liveNodesUrl,
  parseArguments,
  planAccelerationNodes,
  readRepositoryProfile,
  signAccelerationNodes,
} = require('./acceleration-nodes.cjs')
const { projectAccelerationProfileSource } = require('./stage-acceleration-bundle.cjs')

const projectRoot = path.resolve(__dirname, '..')
const sourceModules = new Map()

// The client's own parser and verifier, transpiled from source so this test
// needs no prior compile and writes nothing into dist-electron.
function sourceModule(name) {
  if (sourceModules.has(name)) return sourceModules.get(name)
  const file = path.join(projectRoot, 'electron', `${name}.ts`)
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  sourceModules.set(name, module.exports)
  vm.compileFunction(compiled, ['require', 'module', 'exports'], { filename: file })(
    (id) => id.startsWith('./') ? sourceModule(id.slice(2)) : require(id), module, module.exports,
  )
  return module.exports
}

const runtime = { parser: sourceModule('acceleration-clash-config'), online: sourceModule('acceleration-online-nodes') }
const now = new Date('2026-10-22T03:00:00.000Z')

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}

const publisher = keyPair()
const pinnedKeys = [publisher.publicKey]

function liveDocument({ issuedAt = '2026-10-21T03:00:00.000Z', profile = 'proxies:\n  - name: 美国线路 1\n    type: hysteria2\n    server: old.example.test\n    port: 443\n    password: old-secret\n', privateKey = publisher.privateKey } = {}) {
  const digest = profile === null ? null : createHash('sha256').update(profile, 'utf8').digest('hex')
  const signature = sign(null, Buffer.from(buildPayload(issuedAt, digest), 'utf8'), privateKey).toString('base64')
  return JSON.stringify({ format: 1, issuedAt, profile, signature })
}

test('builds exactly the text the client verifies', () => {
  // 与 electron/acceleration-online-nodes.test.ts 的同名断言逐字一致；改一边必须改另一边。
  assert.equal(buildPayload('2026-10-22T03:00:00.000Z', 'a'.repeat(64)),
    `xingmang-acceleration-nodes/v1\nissuedAt=2026-10-22T03:00:00.000Z\nprofileSha256=${'a'.repeat(64)}\n`)
  assert.equal(buildPayload('2026-10-22T03:00:00.000Z', null),
    'xingmang-acceleration-nodes/v1\nissuedAt=2026-10-22T03:00:00.000Z\nprofileSha256=none\n')
  assert.throws(() => buildPayload('2026-10-22\nprofileSha256=none', null), AccelerationNodesError)
  assert.equal(runtime.online.buildAccelerationNodesPayload('2026-10-22T03:00:00.000Z', null), buildPayload('2026-10-22T03:00:00.000Z', null))
})

test('publishes the repository nodes as the same bytes the installer bundles', () => {
  const source = readRepositoryProfile()
  const plan = planAccelerationNodes({ profileSource: source, now, runtime, pinnedKeys })
  assert.equal(plan.profileSource, projectAccelerationProfileSource(runtime.parser.parseClashAccelerationProfile(source)))
  assert.equal(plan.issuedAt, '2026-10-22T03:00:00.000Z')
  const text = signAccelerationNodes(plan, { privateKey: publisher.privateKey, pinnedKeys, runtime })
  const verdict = runtime.online.parseSignedAccelerationNodes(text, { publicKeys: pinnedKeys })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.document.profile.nodes.map((node) => `${node.connection.server}:${node.connection.port}`), ['179.255.133.164:443'])
  assert.deepEqual(Object.keys(JSON.parse(text)), ['format', 'issuedAt', 'profile', 'signature'])
})

test('the approver sees the lines and the live state, never a password', () => {
  const source = readRepositoryProfile()
  const password = YAML.parse(source).proxies[0].password
  const summary = describePlan(planAccelerationNodes({ profileSource: source, currentText: liveDocument(), now, runtime, pinnedKeys })).join('\n')
  assert.match(summary, /一共 1 条线路/)
  assert.match(summary, /美国线路 1：179\.255\.133\.164:443/)
  assert.match(summary, /发布时间：2026-10-22 11:00（北京时间）/)
  assert.match(summary, /线上现在：2026-10-21 11:00（北京时间）发布的 1 条线路（美国线路 1：old\.example\.test:443）/)
  assert.ok(!summary.includes(password))
  assert.ok(!summary.includes('old-secret'))
  assert.match(describePlan(planAccelerationNodes({ profileSource: source, now, runtime, pinnedKeys })).join('\n'), /还没发布过在线节点/)
  const forged = describePlan(planAccelerationNodes({ profileSource: source, currentText: liveDocument({ privateKey: keyPair().privateKey }), now, runtime, pinnedKeys })).join('\n')
  assert.match(forged, /没通过客户端的校验（signature），客户端不会用它/)
})

test('refuses a run the client would ignore or that changes nothing', () => {
  const source = readRepositoryProfile()
  const live = signAccelerationNodes(planAccelerationNodes({ profileSource: source, now: new Date('2026-10-21T03:00:00.000Z'), runtime, pinnedKeys }), { privateKey: publisher.privateKey, pinnedKeys, runtime })
  assert.throws(() => planAccelerationNodes({ profileSource: source, currentText: live, now, runtime, pinnedKeys }), /一模一样/)
  assert.throws(() => planAccelerationNodes({ profileSource: source, currentText: liveDocument({ issuedAt: now.toISOString() }), now, runtime, pinnedKeys }), /不比现在早/)
  assert.throws(() => planAccelerationNodes({ withdraw: true, profileSource: null, now, runtime, pinnedKeys }), /不用撤回/)
  assert.throws(() => planAccelerationNodes({ withdraw: true, profileSource: null, currentText: liveDocument({ profile: null }), now, runtime, pinnedKeys }), /不用撤回/)
})

test('a withdrawal is signed as one and accepted by the client', () => {
  const plan = planAccelerationNodes({ withdraw: true, profileSource: null, currentText: liveDocument(), now, runtime, pinnedKeys })
  assert.match(describePlan(plan).join('\n'), /这次是\*\*撤回\*\*/)
  const text = signAccelerationNodes(plan, { privateKey: publisher.privateKey, pinnedKeys, runtime })
  assert.deepEqual(runtime.online.parseSignedAccelerationNodes(text, { publicKeys: pinnedKeys }), { ok: true, document: { issuedAt: plan.issuedAt, profile: null } })
})

test('refuses a signing key the client does not pin', () => {
  const plan = planAccelerationNodes({ profileSource: readRepositoryProfile(), now, runtime, pinnedKeys })
  assert.throws(() => signAccelerationNodes(plan, { privateKey: keyPair().privateKey, pinnedKeys, runtime }), /不在客户端内置名单里/)
})

test('only the pinned repository profile is ever published', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-acceleration-nodes-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'bundled-acceleration'))
  const source = fs.readFileSync(path.join(projectRoot, 'bundled-acceleration', 'profile.yaml'), 'utf8')
  fs.writeFileSync(path.join(root, 'bundled-acceleration', 'profile.yaml'), `${source}# changed\n`)
  fs.copyFileSync(path.join(projectRoot, 'bundled-acceleration', 'profile.sha256'), path.join(root, 'bundled-acceleration', 'profile.sha256'))
  assert.throws(() => readRepositoryProfile(root), /对不上/)
})

test('arguments name a command, the live copy and, to build, an output', () => {
  assert.deepEqual(parseArguments(['preview', '--current', 'a.json', '--withdraw']), { command: 'preview', withdraw: true, '--current': 'a.json' })
  assert.throws(() => parseArguments(['build', '--current', 'a.json']), /--output/)
  assert.throws(() => parseArguments(['publish', '--current', 'a.json']), AccelerationNodesError)
  assert.throws(() => parseArguments(['preview', '--current', 'a.json', '--profile', 'other.yaml']), /参数不对/)
})

test('a release stops when the live online nodes would override the nodes it bundles', () => {
  const source = readRepositoryProfile()
  const same = signAccelerationNodes(planAccelerationNodes({ profileSource: source, now: new Date('2026-10-21T03:00:00.000Z'), runtime, pinnedKeys }), { privateKey: publisher.privateKey, pinnedKeys, runtime })
  assert.match(checkReleaseAgainstLive({ profileSource: source, currentText: same, runtime, pinnedKeys }).join('\n'), /跟这次安装包里的一样/)
  assert.throws(() => checkReleaseAgainstLive({ profileSource: source, currentText: liveDocument(), runtime, pinnedKeys }),
    (error) => error instanceof AccelerationNodesError && /跟这次安装包里的不一样/.test(error.message) && /acceleration-nodes/.test(error.message)
      && !error.message.includes('old-secret') && !error.message.includes('old.example.test'))
})

test('a release goes ahead when clients fall back to the nodes it bundles anyway', () => {
  const source = readRepositoryProfile()
  assert.match(checkReleaseAgainstLive({ profileSource: source, currentText: null, runtime, pinnedKeys }).join('\n'), /还没发布过/)
  assert.match(checkReleaseAgainstLive({ profileSource: source, currentText: liveDocument({ profile: null }), runtime, pinnedKeys }).join('\n'), /撤回过/)
  assert.match(checkReleaseAgainstLive({ profileSource: source, currentText: liveDocument({ privateKey: keyPair().privateKey }), runtime, pinnedKeys }).join('\n'), /没通过客户端的校验（signature）/)
  assert.match(checkReleaseAgainstLive({ profileSource: source, currentText: 'not a node list', runtime, pinnedKeys }).join('\n'), /没通过客户端的校验（malformed）/)
})

function liveResponse(status, body = '', headers = {}) {
  return new Response(status === 204 || status === 304 ? null : body, { status, headers })
}

test('the release check reads the live copy like a client does and stops on anything unclear', async () => {
  const seen = []
  const text = liveDocument()
  assert.equal(await fetchLiveDocument('https://feed.example.test/acceleration-nodes.json', async (url, init) => {
    seen.push({ url, redirect: init.redirect, signal: init.signal instanceof AbortSignal })
    return liveResponse(200, text)
  }), text)
  assert.deepEqual(seen, [{ url: 'https://feed.example.test/acceleration-nodes.json', redirect: 'error', signal: true }])
  assert.equal(await fetchLiveDocument('https://feed.example.test/x', async () => liveResponse(404, 'missing')), null)
  await assert.rejects(fetchLiveDocument('https://feed.example.test/x', async () => liveResponse(503, 'busy')), /HTTP 503/)
  await assert.rejects(fetchLiveDocument('https://feed.example.test/x', async () => { throw new TypeError('redirect') }), /读不到线上的在线加速节点（连不上）/)
  assert.equal(await fetchLiveDocument('https://feed.example.test/x', async () => liveResponse(200, 'x', { 'content-length': String(256 * 1024 + 1) })), 'not a node list')
  assert.equal(await fetchLiveDocument('https://feed.example.test/x', async () => liveResponse(200, 'x'.repeat(256 * 1024 + 1))), 'not a node list')
})

test('the release check reads the same address the publish workflow writes and clients read', () => {
  const { resolveUpdateUrlForVersion } = require('./update-release-utils.cjs')
  const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(liveNodesUrl(), `${resolveUpdateUrlForVersion(version).replace(/\/+$/, '')}/acceleration-nodes.json`)
  assert.deepEqual(parseArguments(['check']), { command: 'check', withdraw: false })
  assert.deepEqual(parseArguments(['check', '--summary', 's.md']), { command: 'check', withdraw: false, '--summary': 's.md' })
  assert.throws(() => parseArguments(['check', '--current', 'a.json']), /参数不对/)
  assert.throws(() => parseArguments(['check', '--withdraw']), /参数不对/)
})

const workflow = YAML.parse(fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'acceleration-nodes.yml'), 'utf8'))
const releaseWorkflow = YAML.parse(fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'publish-release.yml'), 'utf8'))

test('both release builds check the live online nodes before they stage the bundled ones', () => {
  for (const name of ['windows-build', 'macos-build']) {
    const commands = releaseWorkflow.jobs[name].steps.map((step) => String(step.run || ''))
    const compile = commands.findIndex((command) => command.includes('tsc -p tsconfig.electron.json'))
    const check = commands.findIndex((command) => /acceleration-nodes\.cjs check\b/.test(command))
    const stage = commands.findIndex((command) => command.includes('prepare-acceleration-bundle.cjs'))
    assert.ok(compile >= 0 && compile < check && check < stage, name)
    const step = releaseWorkflow.jobs[name].steps[check]
    assert.equal(/secrets\./.test(JSON.stringify(step)), false, name)
    assert.doesNotMatch(commands[check], /\$\{\{/, name)
  }
})

test('only the approved publish job holds credentials, and only for main', () => {
  const { preview, publish } = workflow.jobs
  assert.equal(preview.environment, undefined)
  assert.equal(/secrets\./.test(JSON.stringify(preview)), false)
  assert.equal(publish.environment, 'release')
  assert.equal(publish.needs, 'preview')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  for (const job of [preview, publish]) {
    const [first] = job.steps
    assert.match(first.run, /refs\/heads\/main/)
    assert.equal(first.env.REF, '${{ github.ref }}')
  }
})

test('inputs and secrets are bound through the environment, and the signed file is never printed', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      const run = String(step.run || '')
      assert.doesNotMatch(run, /\$\{\{/, step.name)
      assert.doesNotMatch(run, /cat [^\n]*acceleration-nodes\.json/, step.name)
    }
  }
  const sign = workflow.jobs.publish.steps.find((step) => /acceleration-nodes\.cjs build/.test(String(step.run || '')))
  assert.equal(sign.env.XINGMANG_UPDATE_SIGNING_KEY, '${{ secrets.XINGMANG_UPDATE_SIGNING_KEY }}')
  assert.equal(sign.env.ACTION_CHOICE, '${{ inputs.action }}')
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.action.options.map((option) => option.split(':')[0]), ['publish', 'withdraw'])
})

test('the publish job compiles the client code before signing and verifies what customers read', () => {
  const commands = workflow.jobs.publish.steps.map((step) => String(step.run || ''))
  const compile = commands.findIndex((command) => command.includes('tsc -p tsconfig.electron.json'))
  const build = commands.findIndex((command) => command.includes('acceleration-nodes.cjs build'))
  const upload = commands.findIndex((command) => /aws s3 cp/.test(command))
  const verify = commands.findIndex((command) => /cmp -s/.test(command))
  assert.ok(compile >= 0 && compile < build && build < upload && upload < verify)
  assert.match(commands[upload], /\$OBJECT_PREFIX\/acceleration-nodes\.json/)
  assert.equal(workflow.jobs.publish.env.OBJECT_PREFIX, 'xingmang-manager')
})

test('every action is pinned to the same commits as the other feed writers', () => {
  const serviceStatus = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'service-status.yml'), 'utf8')
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps.filter((entry) => entry.uses)) {
      assert.match(step.uses, /@[a-f\d]{40}$/)
      assert.ok(serviceStatus.includes(step.uses), step.uses)
    }
  }
})
