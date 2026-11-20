const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// npm run verify:app (e2e/verify-app.mjs) only runs where a display and a
// compiled client exist. Its two pure halves are pinned here so every platform's
// npm test catches a broken step grammar, a fixture that starts answering a
// generation route, or a page table that drifted away from the renderer.
const root = path.resolve(__dirname, '..')
const fixture = require('../e2e/verify-app-fixture.cjs')
const planModule = import(pathToFileURL(path.join(root, 'e2e', 'verify-app-plan.mjs')).href)

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function rendererSources(directory = path.join(root, 'src', 'renderer-v2'), collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) rendererSources(candidate, collected)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) collected.push(fs.readFileSync(candidate, 'utf8'))
  }
  return collected
}

test('a run with no steps walks every sidebar page except the separate canvas window', async () => {
  const { parseVerifyArgs, verifyPages } = await planModule
  const plan = parseVerifyArgs([], { now: new Date(2026, 10, 17, 9, 5, 3) })
  assert.equal(plan.account, 'xm')
  assert.equal(plan.theme, 'light')
  assert.deepEqual(plan.size, { width: 1280, height: 820 })
  assert.equal(plan.out, 'output/verify-app/20261117-090503')
  assert.deepEqual(plan.steps.map((step) => step.page), verifyPages.filter((page) => page.id !== 'canvas').map((page) => page.id))
  assert.ok(plan.steps.every((step) => step.kind === 'page'))
})

test('options are read in both spellings and rejected with a Chinese reason', async () => {
  const { parseVerifyArgs, VerifyPlanError } = await planModule
  const plan = parseVerifyArgs(['--account', 'api', '--theme=dark', '--size', '980x680', '--balance', '0', '--installed', '--out', 'x', 'home'])
  assert.equal(plan.account, 'api')
  assert.equal(plan.theme, 'dark')
  assert.deepEqual(plan.size, { width: 980, height: 680 })
  assert.equal(plan.balance, 0)
  assert.equal(plan.installed, true)
  assert.equal(plan.out, 'x')
  assert.deepEqual(plan.steps, [{ kind: 'page', page: 'home', raw: 'home' }])
  for (const argv of [['--account', 'sub2api'], ['--theme', 'blue'], ['--size', '1280'], ['--size', '400x300'], ['--balance', '-1'],
    ['--balance'], ['--out'], ['--bogus'], ['nowhere'], ['click:a b'], ['sleep:61000'], ['fill:no-value'], ['account:Keys!'], ['tap:']]) {
    assert.throws(() => parseVerifyArgs(argv), (error) => error instanceof VerifyPlanError && /[\u4e00-\u9fff]/.test(error.message), argv.join(' '))
  }
})

test('signed out there is no sidebar, so only the welcome page can be captured', async () => {
  const { parseVerifyArgs, VerifyPlanError } = await planModule
  assert.deepEqual(parseVerifyArgs(['--account', 'none']).steps, [{ kind: 'shot', name: 'welcome', raw: 'shot:welcome' }])
  assert.deepEqual(parseVerifyArgs(['--account', 'none', 'tap:登录', 'shot:登录框']).steps.map((step) => step.kind), ['tap', 'shot'])
  assert.throws(() => parseVerifyArgs(['--account', 'none', 'settings']), VerifyPlanError)
})

test('each step kind parses its value and splits only on the first separator', async () => {
  const { parseVerifyStep } = await planModule
  assert.deepEqual(parseVerifyStep('account:keys'), { kind: 'page', page: 'account', section: 'keys', raw: 'account:keys' })
  assert.deepEqual(parseVerifyStep('click:nav-home'), { kind: 'click', testId: 'nav-home', raw: 'click:nav-home' })
  assert.deepEqual(parseVerifyStep('hover:tool-row-codex'), { kind: 'hover', testId: 'tool-row-codex', raw: 'hover:tool-row-codex' })
  assert.deepEqual(parseVerifyStep('wait:page-home'), { kind: 'wait', testId: 'page-home', raw: 'wait:page-home' })
  assert.deepEqual(parseVerifyStep('tap:只用线路2'), { kind: 'tap', text: '只用线路2', raw: 'tap:只用线路2' })
  assert.deepEqual(parseVerifyStep('expect:时间 12:30'), { kind: 'expect', text: '时间 12:30', raw: 'expect:时间 12:30' })
  assert.deepEqual(parseVerifyStep('look:安全证书'), { kind: 'look', text: '安全证书', raw: 'look:安全证书' })
  assert.deepEqual(parseVerifyStep('fill:login-account=a=b'), { kind: 'fill', testId: 'login-account', value: 'a=b', raw: 'fill:login-account=a=b' })
  assert.deepEqual(parseVerifyStep('key:Control+K'), { kind: 'key', key: 'Control+K', raw: 'key:Control+K' })
  assert.deepEqual(parseVerifyStep('sleep:500'), { kind: 'sleep', milliseconds: 500, raw: 'sleep:500' })
  assert.deepEqual(parseVerifyStep('shot:设置页'), { kind: 'shot', name: '设置页', raw: 'shot:设置页' })
})

test('screenshot names keep Chinese words and can never leave the output directory', async () => {
  const { screenshotName } = await planModule
  assert.equal(screenshotName(3, '个人中心-keys'), '03-个人中心-keys')
  assert.equal(screenshotName(12, '没过-tap:「现在重开」'), '12-没过-tap-现在重开')
  for (const hostile of ['../../etc/passwd', '..\\..\\Windows', 'a/b\\c', 'C:\\x', '...']) {
    const name = screenshotName(1, hostile)
    assert.doesNotMatch(name, /[/\\:]|\.\./, hostile)
  }
  assert.equal(screenshotName(1, '///'), '01-shot')
  assert.ok(screenshotName(1, '长'.repeat(200)).length <= 43)
})

test('screen text keeps its lines but drops layout whitespace', async () => {
  const { normaliseScreenText } = await planModule
  assert.equal(normaliseScreenText('  首页 \r\n\n\n\t设置\u00a0 页\n\n'), '首页\n\n设置 页')
})

test('the report passes only when every step passed and no page threw', async () => {
  const { buildVerifyReport, parseVerifyArgs, summariseOutcome } = await planModule
  const plan = parseVerifyArgs(['home', 'expect:余额'])
  const base = { plan, platform: 'Linux', commit: 'abc1234', startedAt: 's', finishedAt: 'f', unrouted: [], pageErrors: [], consoleErrors: [], fatal: null }
  const passing = [{ step: plan.steps[0], ok: true, files: ['01-首页.png', '01-首页.txt'], note: null },
    { step: plan.steps[1], ok: true, files: [], note: '找到了' }]
  const good = buildVerifyReport({ ...base, results: passing, actualSize: { width: 1280, height: 790 } })
  assert.equal(good.passed, true)
  assert.match(good.markdown, /全部通过/)
  assert.match(good.markdown, /1\. ✓ 进「首页」（`01-首页\.png`、`01-首页\.txt`）/)
  assert.match(good.markdown, /2\. ✓ 这一屏要有「余额」：找到了/)
  assert.match(good.markdown, /窗口 1280x820/)
  assert.match(good.markdown, /不是真机/)
  const small = buildVerifyReport({ ...base, results: passing, actualSize: { width: 1024, height: 700 } })
  assert.match(small.markdown, /屏幕只放得下 1024x700/)
  const failing = buildVerifyReport({ ...base, results: [{ ...passing[1], ok: false, error: '这一屏上找不到「余额」' }] })
  assert.equal(failing.passed, false)
  assert.match(failing.markdown, /✗ 这一屏要有「余额」[\s\S]*没过：这一屏上找不到「余额」/)
  assert.equal(buildVerifyReport({ ...base, results: passing, pageErrors: ['boom'] }).passed, false)
  assert.equal(buildVerifyReport({ ...base, results: passing, fatal: 'first window did not finish' }).passed, false)
  const calls = [
    { origin: 'https://xm.solov.cc', route: '/api/x', method: 'GET', outcome: 'unrouted' },
    { origin: 'https://xm.solov.cc', route: '/api/x', method: 'GET', outcome: 'unrouted' },
    { origin: 'https://xm.solov.cc', route: '/api/user/self', method: 'GET', outcome: 'served' },
    { origin: 'https://xm.solov.cc', route: '/v1/messages', method: 'POST', outcome: 'withheld' },
    { origin: 'https://registry.npmjs.org', route: '/', method: 'GET', outcome: 'refused' },
  ]
  const unrouted = summariseOutcome(calls, 'unrouted')
  const withheld = summariseOutcome(calls, 'withheld')
  assert.deepEqual(unrouted, [{ method: 'GET', origin: 'https://xm.solov.cc', route: '/api/x', count: 2 }])
  assert.deepEqual(withheld, [{ method: 'POST', origin: 'https://xm.solov.cc', route: '/v1/messages', count: 1 }])
  const listed = buildVerifyReport({ ...base, results: passing, unrouted, withheld }).markdown
  assert.match(listed, /假账号站没答的请求[\s\S]*GET https:\/\/xm\.solov\.cc\/api\/x × 2/)
  assert.match(listed, /故意不答的请求[\s\S]*POST https:\/\/xm\.solov\.cc\/v1\/messages × 1/)
  // A withheld generation request is not a gap to fill and does not fail the run.
  assert.doesNotMatch(listed.split('故意不答')[0], /\/v1\/messages/)
  assert.equal(buildVerifyReport({ ...base, results: passing, withheld }).passed, true)
})

// The walk reaches pages through the sidebar and signs in through the welcome
// page. A renamed page or test id would otherwise surface only when somebody
// runs the tool and it stops on a step nobody can explain.
test('the page table and the sign-in path still match the renderer', async () => {
  const { verifyPages } = await planModule
  const registry = read('src/renderer-v2/registry/pages.ts')
  const registryIds = [...registry.matchAll(/\{ id: '([a-z-]+)', label: '([^']+)'/g)].map((match) => ({ id: match[1], label: match[2] }))
  const aliases = ['acceleration', 'backups', 'updates', 'maintenance']
  assert.ok(aliases.every((id) => registryIds.some((page) => page.id === id)), 'the alias pages moved; revisit verifyPages')
  assert.deepEqual(verifyPages.map((page) => page.id), registryIds.filter((page) => !aliases.includes(page.id)).map((page) => page.id),
    'every sidebar page belongs in verifyPages, in registry order')
  for (const page of verifyPages) assert.equal(page.label, registryIds.find((entry) => entry.id === page.id).label)
  const sources = rendererSources().join('\n')
  const shell = read('src/renderer-v2/features/shell/Shell.tsx')
  assert.match(shell, /data-testid=\{`nav-\$\{id\}`\}/)
  for (const page of verifyPages) {
    if (page.window === 'canvas') continue
    assert.ok(sources.includes(`data-testid="page-${page.id}"`) || (page.id === 'mcp' || page.id === 'skills' || page.id === 'plugins'),
      `page-${page.id} is gone from renderer-v2`)
  }
  assert.match(read('src/renderer-v2/features/extensions/ExtensionsPage.tsx'), /data-testid=\{`page-\$\{page\}`\}/)
  assert.match(read('src/renderer-v2/pages-account.tsx'), /id=\{`v2-account-tab-\$\{tab\}`\}/)
  // login-dialog is built from the dialog mode.
  assert.match(read('src/renderer-v2/features/auth/AuthFlow.tsx'), /: mode\}-dialog`/)
  for (const testId of ['sidebar-account-open', 'welcome-page', 'welcome-login', 'login-account', 'login-password',
    'auth-agree', 'login-submit', 'start-guide', 'guide-pause', 'auth-source', 'auth-source-expand', 'page-viewport',
    // The canvas window and a new film open from the start page of 「创作」.
    'chat-conversation-new', 'chat-empty', 'create-card-canvas', 'create-card-video']) {
    assert.ok(sources.includes(`"${testId}"`) || sources.includes(`'${testId}'`), `${testId} is gone from renderer-v2`)
  }
})

test('the fixture answers exactly the account-site origins the client knows', () => {
  const relaySites = read('electron/relay-sites.ts')
  const endpoints = [...relaySites.matchAll(/id: '(?:primary|direct)' as const, origin: '(https:\/\/[^']+)'/g)].map((match) => match[1])
  assert.deepEqual([...fixture.accountOrigins.xm, ...fixture.accountOrigins.api].sort(), [...endpoints].sort())
  assert.equal(fixture.siteOf('https://xm.solov.cc.evil.example'), null)
  assert.equal(fixture.siteOf('https://registry.npmjs.org'), null)
  // The temporary IP entry is an alias the client only migrates away from.
  assert.equal(fixture.siteOf('https://38.147.105.28:8443'), null)
})

test('the fixture signs in only with its own password and reports the balance in quota units', () => {
  const state = fixture.createFixtureState({ balance: 12.5, groups: ['Claude-MAX', 'GPT'] })
  const xm = 'https://xm-direct.solov.cc'
  const login = (origin, password, route) => fixture.answerAccountRequest(state, { origin, method: 'POST', route, body: { username: fixture.loginAccount, password } })
  const ok = login(xm, fixture.loginPassword, '/api/user/login')
  assert.equal(ok.status, 200)
  assert.match(ok.cookie, /^refresh_token=/)
  assert.equal(ok.payload.data.user.quota, 12.5 * fixture.quotaPerUnit)
  assert.equal(login(xm, 'wrong', '/api/user/login').status, 401)
  assert.equal(login('https://api.solov.cc', fixture.loginPassword, '/api/v1/auth/login').payload.data.user.balance, 12.5)
  assert.equal(login('https://api.solov.cc', 'wrong', '/api/v1/auth/login').status, 401)
  assert.deepEqual(Object.keys(fixture.answerAccountRequest(state, { origin: xm, route: '/api/user/self/groups' }).payload.data), ['Claude-MAX', 'GPT'])
  // An empty notice keeps the announcement dialog off every screenshot.
  assert.equal(fixture.answerAccountRequest(state, { origin: xm, route: '/api/notice' }).payload.data, '')
  assert.equal(fixture.answerAccountRequest(state, { origin: xm, route: '/xm-route-status.json' }).status, 404)
})

test('the fixture issues keys the way the client reads them back', () => {
  const state = fixture.createFixtureState({ balance: 1, groups: ['GPT'] })
  const xm = 'https://xm.solov.cc'
  fixture.answerAccountRequest(state, { origin: xm, method: 'POST', route: '/api/token/', body: { name: 'codex', group: 'GPT' } })
  assert.deepEqual(fixture.answerAccountRequest(state, { origin: xm, route: '/api/token/' }).payload.data.items.map((key) => [key.id, key.group, key.key]),
    [[1, 'GPT', 'sk-****']])
  assert.match(fixture.answerAccountRequest(state, { origin: xm, method: 'POST', route: '/api/token/1/key' }).payload.data.key, /^sk-verify-app-xm-1-/)
  const api = 'https://api.solov.cc'
  const created = fixture.answerAccountRequest(state, { origin: api, method: 'POST', route: '/api/v1/keys', body: { name: 'claude', group_id: 1 } })
  assert.equal(fixture.answerAccountRequest(state, { origin: api, route: `/api/v1/keys/${created.payload.data.id}` }).payload.data.key, 'sk-verify-app-api-1')
  assert.equal(fixture.answerAccountRequest(state, { origin: api, route: '/api/v1/keys/99' }).status, 404)
})

test('the fixture never answers a generation route or a route it does not know', () => {
  const state = fixture.createFixtureState({ balance: 100, groups: [] })
  for (const origin of [...fixture.accountOrigins.xm, ...fixture.accountOrigins.api]) {
    for (const route of ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/images/generations', '/v1/videos', '/api/not-a-route']) {
      assert.equal(fixture.answerAccountRequest(state, { origin, method: 'POST', route }), null, `${origin}${route}`)
    }
  }
  assert.equal(fixture.answerAccountRequest(state, { origin: 'https://registry.npmjs.org', route: '/api/status' }), null)
})

test('verify:app is reachable from npm and documented where threads look', () => {
  const packageJson = JSON.parse(read('package.json'))
  assert.equal(packageJson.scripts['verify:app'], 'node e2e/verify-app.mjs')
  assert.match(read('docs/CLOUD-SANDBOX.md'), /npm run verify:app/)
  assert.match(read('docs/COLLABORATION.md'), /机器能核[\s\S]*必须真机/)
})
