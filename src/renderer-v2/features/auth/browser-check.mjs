import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { fixtureReadyTimeoutMs } from '../../../../e2e/fixture-readiness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const output = path.join(root, '.project-surgeon/audits/20260907-auth-v2')
let server
let browser
let base
before(async () => {
  await fs.mkdir(output, { recursive: true })
  ;({ server, origin: base } = await createFixtureServer({ root, configFile: false, esbuild: { jsx: 'automatic' } }))
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
async function open(query = '', app = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') return route.abort()
    await route.continue()
  })
  await page.goto(`${base}/src/renderer-v2/${app ? 'testing/app.html' : 'features/auth/browser-fixture.html'}?${query}`)
  // Vite transforms the module graph on demand, so first paint can take seconds on
  // a cold Windows runner. Assertions like count() and getAttribute() do not retry,
  // so a test whose first statement is one of them reads an empty page and fails on
  // the value rather than on a timeout. Wait for the mount before handing the page over.
  await page.locator('#root > *').first().waitFor({ timeout: fixtureReadyTimeoutMs })
  return page
}
// 「账号来源」默认收起：星芒账号不用点，历史账号先点底部那行（它会顺手选中历史账号）。
async function chooseAccountSource(page, label) {
  const segment = page.getByTestId('auth-source')
  if (!await segment.count()) {
    if (label === '星芒账号') return
    await page.getByTestId('auth-source-expand').click()
    await segment.waitFor()
    return
  }
  await segment.getByRole('button', { name: label, exact: true }).click()
}
async function calls(page) { return page.evaluate(() => JSON.parse(document.documentElement.dataset.calls || '[]')) }

test('login preserves drafts through legal documents and only authenticates after explicit agreement', async () => {
  const page = await open()
  try {
    await page.getByTestId('login-account').fill('fixture-member')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('login-submit').click()
    await page.getByTestId('auth-error').filter({ hasText: '请先同意' }).waitFor()
    assert.deepEqual(await calls(page), [])
    await page.getByTestId('auth-terms').click()
    await page.getByRole('heading', { name: 'Test Agreement' }).waitFor()
    await page.getByTestId('legal-document-close').click()
    assert.equal(await page.getByTestId('login-account').inputValue(), 'fixture-member')
    assert.equal(await page.getByTestId('login-password').inputValue(), 'fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-remember').check()
    await page.getByTestId('login-submit').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('authenticated'))
    assert.deepEqual((await calls(page)).map((item) => item.method), ['login', 'remember', 'authenticated'])
  } finally { await page.close() }
})

test('registration preserves its completed result when the following real login attempt fails', async () => {
  const page = await open('scenario=register&fail=1')
  try {
    assert.equal(await page.getByTestId('register-email').getAttribute('placeholder'), '常用邮箱（如 QQ 邮箱）')
    await page.getByTestId('register-email').fill('person@163.com')
    assert.equal(await page.getByTestId('register-user').inputValue(), 'person')
    await page.getByTestId('register-send-code').click()
    await page.getByTestId('register-send-code').filter({ hasText: '秒后重发' }).waitFor()
    assert.equal(await page.getByTestId('register-send-code').isDisabled(), true)
    await page.getByTestId('register-user').fill('fixture-member')
    await page.getByTestId('register-password').fill('fixture-password')
    await page.getByTestId('register-password-confirm').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('register-submit').click()
    await page.getByText('请填写邮件中的验证码', { exact: true }).waitFor()
    await page.getByTestId('register-code').fill('123456')
    await page.getByTestId('register-submit').click()
    await page.getByTestId('login-dialog').waitFor()
    assert.equal(await page.getByTestId('login-account').inputValue(), 'fixture-member')
    assert.equal(await page.getByTestId('login-password').inputValue(), '')
    assert.deepEqual((await calls(page)).map((item) => item.method), ['verification', 'register', 'login'])
  } finally { await page.close() }
})

test('recovery validates reset links and keeps the generated password available after clipboard failure', async () => {
  const page = await open('scenario=recovery&copyFail=1')
  try {
    assert.equal(await page.getByTestId('forgot-email').getAttribute('placeholder'), 'name@example.com')
    await page.getByTestId('forgot-email').fill('person@gmail.com')
    await page.getByTestId('forgot-send').click()
    await page.getByTestId('forgot-token').fill('https://xm.solov.cc/reset?token=one&token=two')
    await page.getByTestId('forgot-reset').click()
    await page.getByTestId('auth-error').filter({ hasText: '多个重置码' }).waitFor()
    assert.deepEqual((await calls(page)).map((item) => item.method), ['send-reset'])
    await page.getByTestId('forgot-token').fill('https://api.solov.cc/reset?token=one%2Btwo')
    await page.getByTestId('forgot-reset').click()
    await page.getByTestId('auth-error').filter({ hasText: '不属于所选账号来源' }).waitFor()
    assert.deepEqual((await calls(page)).map((item) => item.method), ['send-reset'])
    await page.getByTestId('forgot-token').fill('https://xm.solov.cc/reset?token=one%2Btwo')
    await page.getByTestId('forgot-reset').click()
    await page.getByTestId('forgot-new-password').waitFor()
    assert.equal(await page.getByTestId('forgot-new-password').getAttribute('type'), 'password')
    await page.getByTestId('forgot-copy-password').click()
    await page.getByTestId('auth-error').filter({ hasText: '手动复制' }).waitFor()
    assert.equal(await page.getByTestId('forgot-new-password').inputValue(), 'new-test-password')
    assert.equal(await page.getByTestId('forgot-new-password').getAttribute('type'), 'text')
    await page.getByTestId('forgot-finish').click()
    assert.equal(await page.getByTestId('login-account').inputValue(), 'person@gmail.com')
    assert.equal(await page.getByTestId('login-password').inputValue(), '')
    assert.equal(await page.getByTestId('forgot-new-password').count(), 0)
    assert.deepEqual((await calls(page)).find((item) => item.method === 'reset').input, { email: 'person@gmail.com', token: 'one+two', siteId: 'solov' })
  } finally { await page.close() }
})

test('chat guide keeps all four steps and never installs a runtime or tool', async () => {
  const page = await open('scenario=guide&loggedOut=1')
  try {
    assert.equal(await page.locator('input[type=radio]').count(), 6)
    // 第十一批 1：默认选中推荐的 Codex 桌面端并排在第一位，「下一步」一开始就能点。
    assert.equal(await page.locator('input[type=radio]:checked').getAttribute('value'), 'codexDesktop')
    assert.equal(await page.locator('input[type=radio]').first().getAttribute('value'), 'codexDesktop')
    assert.equal(await page.getByTestId('guide-recommended').count(), 1)
    assert.equal(await page.getByText(/Node\.js|Python/).count(), 0)
    assert.equal(await page.getByTestId('guide-next').isEnabled(), true)
    await page.getByTestId('guide-route-chat').check()
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'prepare')
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('guide-next').isDisabled(), true)
    await page.getByTestId('guide-login').click()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-chat').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('complete'))
    assert.deepEqual((await calls(page)).map((item) => item.method), ['guide-login', 'launch', 'complete'])
  } finally { await page.close() }
})

test('desktop route avoids Node and unknown configuration requires an explicit configuration action', async () => {
  const page = await open('scenario=guide&installed=1&unknown=1')
  try {
    await page.getByTestId('guide-route-codexDesktop').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('guide-node').count(), 0)
    assert.equal(await page.getByTestId('guide-next').isDisabled(), true)
    assert.deepEqual((await calls(page)).map((item) => item.method), ['detect'])
    await page.getByTestId('guide-config').click()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-open-tool').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('complete'))
    assert.deepEqual((await calls(page)).map((item) => item.method), ['detect', 'configure', 'launch', 'complete'])
  } finally { await page.close() }
})

test('an official Codex that has not signed in cannot leave the connect step', async () => {
  const page = await open('scenario=guide&installed=1&official=1&runtime=1&officialLoginRequired=1')
  try {
    await page.getByTestId('guide-route-codex').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'connect')
    await page.getByTestId('guide-official-login').waitFor()
    assert.equal(await page.getByTestId('guide-next').isDisabled(), true)
    await page.getByTestId('guide-config').click()
    assert.equal(await page.getByTestId('guide-official-login').count(), 0)
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'ready')
  } finally { await page.close() }
})

test('canceling CLI workspace selection keeps the guide on its ready step', async () => {
  const page = await open('scenario=guide&installed=1&connected=1&runtime=1&launchCancel=1')
  try {
    await page.getByTestId('guide-route-codex').check()
    await page.getByTestId('guide-next').click()
    // 第十一批 3：Key 已经写好、连上了，「确认连接」这一步直接跳过。
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'ready')
    await page.getByTestId('guide-connected-note').waitFor()
    await page.getByTestId('guide-open-tool').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('launch'))
    await page.getByTestId('guide-open-tool').waitFor()
    assert.deepEqual((await calls(page)).map((item) => item.method), ['detect', 'launch'])
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'ready')
  } finally { await page.close() }
})

test('Gemini preparation unlocks Node then Python then CLI from confirmed snapshots', async () => {
  const page = await open('scenario=guide&pending=python')
  try {
    await page.getByTestId('guide-route-gemini').check()
    await page.getByTestId('guide-next').click()
    assert.deepEqual(await page.locator('.auth-guide-check-row strong').allTextContents(), ['运行环境', 'Python', 'Gemini CLI'])
    assert.equal(await page.getByTestId('guide-python').isDisabled(), true)
    assert.equal(await page.getByTestId('guide-install').isDisabled(), true)
    assert.equal(await page.getByTestId('guide-next').isDisabled(), true)
    await page.getByTestId('guide-node').click()
    assert.equal(await page.getByTestId('guide-python').isEnabled(), true)
    assert.equal(await page.getByTestId('guide-install').isDisabled(), true)
    await page.getByTestId('guide-python').click()
    assert.equal(await page.getByTestId('guide-install').isDisabled(), true)
    assert.equal(await page.getByTestId('guide-pause').isDisabled(), true)
    await page.evaluate(() => window.authHarness.release('python'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="guide-install"]').disabled)
    await page.getByTestId('guide-install').click()
    await page.locator('[data-guide-step="connect"]').waitFor()
    assert.deepEqual((await calls(page)).map((item) => item.method), ['detect', 'runtime', 'python', 'install'])
  } finally { await page.close() }
})

// 第十一批 2：能代装运行环境的平台上，「准备工具」这一步只剩一颗「安装」，
// Node.js 和 Python 两行只报状态；失败时说清是哪一段没装上，并给一颗「再试一次」。
test('Gemini installs with one button when the runtimes can be prepared automatically', async () => {
  const page = await open('scenario=guide&auto=1&installFail=1')
  try {
    await page.getByTestId('guide-route-gemini').check()
    await page.getByTestId('guide-next').click()
    assert.deepEqual(await page.locator('.auth-guide-check-row strong').allTextContents(), ['运行环境', 'Python', 'Gemini CLI'])
    assert.equal(await page.getByTestId('guide-node').count(), 0)
    assert.equal(await page.getByTestId('guide-python').count(), 0)
    assert.equal(await page.getByTestId('guide-install').isEnabled(), true)
    await page.getByTestId('guide-install').click()
    await page.getByTestId('guide-error').filter({ hasText: '运行环境没装上（下载超时），Gemini CLI 还没开始装' }).waitFor()
    await page.getByTestId('guide-retry').click()
    // 装好之后替用户点「下一步」；还没连上，所以停在「确认连接」。
    await page.locator('[data-guide-step="connect"]').waitFor()
    assert.equal(await page.getByTestId('guide-error').count(), 0)
    assert.equal(await page.getByTestId('guide-retry').count(), 0)
    assert.deepEqual((await calls(page)).map((item) => item.method), ['detect', 'install', 'install'])
  } finally { await page.close() }
})

// 全面检测 Q8：「打开工具」失败时说主进程给的原因，不借登录那套「输入已保留」，
// 并且和「安装」一样给一颗「再试一次」。
test('a failed tool launch in the guide keeps the real reason and can be retried', async () => {
  const page = await open('scenario=guide&installed=1&connected=1&runtime=1&launchFail=1')
  try {
    await page.getByTestId('guide-route-codex').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-open-tool').click()
    await page.getByTestId('guide-error').filter({ hasText: '请先确认账号连接，再打开工具。' }).waitFor()
    assert.doesNotMatch(await page.getByTestId('guide-error').textContent(), /输入已保留|星芒服务器/)
    await page.getByTestId('guide-retry').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('complete'))
    assert.deepEqual((await calls(page)).map((item) => item.method), ['detect', 'launch', 'launch', 'complete'])
  } finally { await page.close() }
})

// 全面检测 Q50：找到的版本比推荐的旧时不能只说「已经装好」。给一句建议和一颗
// 「更新」，但「下一步」照常能点；更完留在这一步，让人看到已经换成新版。
test('an old installed version is flagged with an update button that never blocks the next step', async () => {
  const page = await open('scenario=guide&installed=1&connected=1&runtime=1&outdated=1')
  try {
    await page.getByTestId('guide-route-claude').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-update').waitFor()
    assert.match(await page.locator('.auth-guide-lead').textContent(), /已经装好，但版本旧了，建议先点「更新」/)
    assert.match(await page.locator('.auth-guide-checklist').textContent(), /已找到 v2\.1\.42，新版是 2\.1\.277/)
    assert.equal(await page.getByTestId('guide-tool-status').textContent(), '可更新')
    assert.equal(await page.getByTestId('guide-next').isEnabled(), true)
    await page.getByTestId('guide-update').click()
    await page.getByTestId('guide-tool-status').filter({ hasText: '已安装' }).waitFor()
    assert.equal(await page.getByTestId('guide-update').count(), 0)
    assert.match(await page.locator('.auth-guide-checklist').textContent(), /已找到 v2\.1\.277/)
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'prepare')
    assert.deepEqual(await calls(page), [{ method: 'detect' }, { method: 'install', input: { route: 'claude', version: '2.1.277' } }])
  } finally { await page.close() }
})

test('an old version installed some other way gets a hint instead of an update button', async () => {
  const page = await open('scenario=guide&installed=1&connected=1&runtime=1&outdated=1&outdatedManual=1')
  try {
    await page.getByTestId('guide-route-claude').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-update-manual').waitFor()
    assert.equal(await page.getByTestId('guide-update').count(), 0)
    assert.match(await page.locator('.auth-guide-lead').textContent(), /建议先用它原来的方式更新/)
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'ready')
  } finally { await page.close() }
})

test('guide pause resumes the chosen route and step without choosing for a fresh account', async () => {
  const page = await open('scenario=guide&resume=1&runtime=1&python=1&installed=1&strict=1')
  try {
    assert.equal(await page.evaluate(() => localStorage.getItem('xingmang-ui-v2:guide:site%3A7')), null)
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'codexDesktop')
    await page.getByTestId('guide-route-gemini').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-pause').click()
    assert.equal(await page.getByTestId('start-guide').count(), 0)
    await page.evaluate(() => window.authHarness.reopen())
    await page.getByTestId('start-guide').waitFor()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'gemini')
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'connect')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'guide-heading')
    await page.evaluate(() => window.authHarness.switchScope('site:8'))
    await page.getByTestId('guide-route-chat').waitFor()
    // 新账号拿到的是推荐项，不是上一个账号停在半路的 Gemini。
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'codexDesktop')
    assert.equal(await page.evaluate(() => localStorage.getItem('xingmang-ui-v2:guide:site%3A8')), null)
    await page.getByTestId('guide-route-chat').check()
    await page.evaluate(() => window.authHarness.switchScope('site:7'))
    await page.getByTestId('guide-config').waitFor()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'gemini')
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'connect')
    assert.equal((await calls(page)).filter((item) => ['runtime', 'python', 'install', 'configure'].includes(item.method)).length, 0)
  } finally { await page.close() }
})

test('a failed detection from the previous account cannot lock or report an error in the new guide', async () => {
  const page = await open('scenario=guide&resume=1&pending=detect')
  try {
    await page.getByTestId('guide-route-gemini').check()
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('aria-busy'), 'true')
    await page.evaluate(() => window.authHarness.switchScope('site:8'))
    await page.getByTestId('guide-route-chat').waitFor()
    await page.evaluate(() => window.authHarness.reject('detect'))
    assert.equal(await page.getByTestId('start-guide').getAttribute('aria-busy'), 'false')
    assert.equal(await page.getByTestId('guide-error').count(), 0)
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'codexDesktop')
  } finally { await page.close() }
})

test('the login form hides the historical source until asked and still logs in to the main account only', async () => {
  const page = await open()
  try {
    assert.equal(await page.getByTestId('auth-source').count(), 0)
    assert.equal(await page.getByTestId('login-remember').isChecked(), false)
    assert.equal(await page.getByTestId('auth-agree').isChecked(), false)
    await page.getByTestId('login-account').fill('fixture-member')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('authenticated'))
    assert.deepEqual((await calls(page)).find((item) => item.method === 'login').input, { username: 'fixture-member', password: 'fixture-password', siteId: 'solov' })
  } finally { await page.close() }
  const history = await open()
  try {
    await history.getByTestId('auth-source-expand').click()
    assert.equal(await history.getByTestId('auth-source').getByRole('button', { name: '历史账号' }).getAttribute('aria-pressed'), 'true')
    assert.equal(await history.getByTestId('auth-source-expand').count(), 0)
    // Switching back keeps the picker open: the user already knows it is there.
    await history.getByTestId('auth-source').getByRole('button', { name: '星芒账号' }).click()
    assert.equal(await history.getByTestId('auth-source').count(), 1)
  } finally { await history.close() }
})

test('registration fills the username from the email until the user edits it', async () => {
  const page = await open('scenario=register')
  try {
    await page.getByTestId('register-email').fill('12345678@qq.com')
    assert.equal(await page.getByTestId('register-user').inputValue(), '12345678')
    await page.getByTestId('register-email').fill('a.very.long.mailbox.name.here@example.test')
    assert.equal(await page.getByTestId('register-user').inputValue(), 'a.very.long.mailbox.')
    await page.getByTestId('register-user').fill('picked-name')
    await page.getByTestId('register-email').fill('other@example.test')
    assert.equal(await page.getByTestId('register-user').inputValue(), 'picked-name')
    await page.getByTestId('register-user').fill('')
    await page.getByTestId('register-email').fill('again@example.test')
    assert.equal(await page.getByTestId('register-user').inputValue(), 'again')
    assert.equal(await page.getByTestId('register-invite').count(), 0)
    await page.getByTestId('register-invite-toggle').click()
    await page.waitForFunction(() => document.activeElement?.id === 'register-invite')
    await page.getByTestId('register-invite').fill('6B4j')
    await page.getByTestId('register-code').fill('123456')
    await page.getByTestId('register-password').fill('fixture-password')
    await page.getByTestId('register-password-confirm').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('register-submit').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('authenticated'))
    assert.deepEqual((await calls(page)).find((item) => item.method === 'register').input, { email: 'again@example.test', username: 'again', password: 'fixture-password', verificationCode: '123456', affCode: '6B4j' })
  } finally { await page.close() }
})

test('a taken username points at the username field instead of a generic failure', async () => {
  const page = await open('scenario=register&usernameTaken=1')
  try {
    await page.getByTestId('register-email').fill('common@example.test')
    await page.getByTestId('register-code').fill('123456')
    await page.getByTestId('register-password').fill('fixture-password')
    await page.getByTestId('register-password-confirm').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('register-submit').click()
    await page.getByText('这个用户名已经有人用了，换一个试试', { exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.id === 'register-user')
    assert.equal(await page.getByTestId('auth-error').count(), 0)
    assert.equal(await page.getByTestId('register-password').inputValue(), 'fixture-password')
    // The name the user now types is theirs; changing the email must not take it back.
    await page.getByTestId('register-user').fill('common2')
    await page.getByTestId('register-email').fill('common@example.org')
    assert.equal(await page.getByTestId('register-user').inputValue(), 'common2')
  } finally { await page.close() }
})

test('an invitation link opens the registration with the invitation field already shown', async () => {
  const page = await open('scenario=register&invite=6B4j')
  try {
    assert.equal(await page.getByTestId('register-invite').inputValue(), '6B4j')
    assert.equal(await page.getByTestId('register-invite-toggle').count(), 0)
  } finally { await page.close() }
})

test('pending registration blocks close and mode changes then focuses the password on return to login', async () => {
  const page = await open('scenario=register&pending=register&fail=1')
  try {
    await page.getByTestId('register-email').fill('fixture@example.test')
    await page.getByTestId('register-code').fill('123456')
    await page.getByTestId('register-user').fill('fixture-member')
    await page.getByTestId('register-password').fill('fixture-password')
    await page.getByTestId('register-password-confirm').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('register-submit').click()
    assert.equal(await page.getByTestId('register-cancel').isDisabled(), true)
    assert.equal(await page.getByTestId('register-login').isDisabled(), true)
    assert.equal(await page.getByTestId('auth-terms').isDisabled(), true)
    assert.equal(await page.getByTestId('register-dialog').locator('[data-modal-close]').isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByTestId('register-dialog').count(), 1)
    assert.equal((await calls(page)).filter((item) => item.method === 'close').length, 0)
    await page.evaluate(() => window.authHarness.release('register'))
    await page.getByTestId('login-dialog').waitFor()
    await page.waitForFunction(() => document.activeElement?.id === 'login-password')
    assert.equal(await page.getByTestId('login-submit').isEnabled(), true)
  } finally { await page.close() }
})

test('registration authenticates through a separate login request before reporting success', async () => {
  const page = await open('scenario=register')
  try {
    await page.getByTestId('register-email').fill('fixture@example.test')
    await page.getByTestId('register-code').fill('123456')
    await page.getByTestId('register-user').fill('fixture-member')
    await page.getByTestId('register-password').fill('fixture-password')
    await page.getByTestId('register-password-confirm').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('register-submit').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('authenticated'))
    assert.deepEqual((await calls(page)).map((item) => item.method), ['register', 'login', 'authenticated'])
    assert.deepEqual((await calls(page)).find((item) => item.method === 'login').input, { username: 'fixture-member', password: 'fixture-password', siteId: 'solov' })
  } finally { await page.close() }
})

test('recovery requests block closing and focus each next field only after completion', async () => {
  const page = await open('scenario=recovery&pending=send-reset&pending=reset&pending=copy')
  try {
    await page.getByTestId('forgot-email').fill('fixture@example.test')
    await page.getByTestId('forgot-send').click()
    assert.equal(await page.getByTestId('forgot-back-login').isDisabled(), true)
    assert.equal(await page.getByTestId('forgot-password-dialog').locator('[data-modal-close]').isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByTestId('forgot-password-dialog').count(), 1)
    await page.evaluate(() => window.authHarness.release('send-reset'))
    await page.waitForFunction(() => document.activeElement?.id === 'forgot-token')
    await page.getByTestId('forgot-token').fill('a-valid-reset-token')
    await page.getByTestId('forgot-reset').click()
    assert.equal(await page.getByTestId('forgot-change-email').isDisabled(), true)
    assert.equal(await page.getByTestId('forgot-back-login').isDisabled(), true)
    await page.evaluate(() => window.authHarness.release('reset'))
    await page.waitForFunction(() => document.activeElement?.id === 'forgot-new-password')
    await page.getByTestId('forgot-copy-password').click()
    assert.equal(await page.getByTestId('forgot-finish').isDisabled(), true)
    await page.evaluate(() => window.authHarness.release('copy'))
    await page.getByTestId('forgot-finish').click()
    await page.waitForFunction(() => document.activeElement?.id === 'login-password')
    assert.equal(await page.getByTestId('login-account').inputValue(), 'fixture@example.test')
    assert.equal((await calls(page)).filter((item) => item.method === 'close').length, 0)
  } finally { await page.close() }
})

test('welcome renders the final star orbit and real brand assets in the dark/light platform matrix', async () => {
  for (const theme of ['light', 'dark']) for (const os of ['win', 'mac']) {
    const page = await open(`scenario=welcome&theme=${theme}&os=${os}`)
    try {
      await page.getByTestId('welcome-orbit-scene').waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), theme === 'dark' ? 'obsidian' : 'dawn')
      assert.equal(await page.locator('.auth-orbit-satellite').count(), 4)
      assert.equal(await page.locator('.frame,.ptile,.welcome-preview-workbench').count(), 0)
      await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
      const pixels = await page.getByTestId('welcome-starfield').evaluate((canvas) => {
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
        let visible = 0
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) visible++
        return visible
      })
      assert.ok(pixels > 2000, `starfield contains painted pixels for ${theme}/${os}`)
      assert.equal(await page.getByTestId('welcome-page').getAttribute('data-motion-paused'), 'true')
      assert.ok(await page.locator('.auth-orbit-ring').evaluateAll((items) => items.every((item) => getComputedStyle(item).animationPlayState === 'paused')))
      const geometry = await page.evaluate(() => ({ width: document.querySelector('.auth-welcome').getBoundingClientRect().width, logo: document.querySelector('.auth-welcome-brand img').getBoundingClientRect().height, footer: document.querySelector('.auth-welcome-foot').getBoundingClientRect().bottom, hud: document.querySelector('.auth-orbit-hud').getBoundingClientRect().right }))
      assert.equal(geometry.width, 1280)
      assert.equal(geometry.logo, 128)
      assert.ok(geometry.footer <= 900, 'welcome feature strip remains visible')
      assert.ok(geometry.hud <= 1280, 'orbit status labels remain inside the viewport')
      const titlebar = await page.getByTestId('window-titlebar').evaluate((element) => ({ height: element.getBoundingClientRect().height, drag: getComputedStyle(element).getPropertyValue('-webkit-app-region') }))
      assert.equal(titlebar.height, os === 'mac' ? 46 : 36)
      assert.equal(titlebar.drag, 'drag')
      await page.screenshot({ path: path.join(output, `welcome-${theme}-${os}.png`) })
    } finally { await page.close() }
  }
})

test('welcome stops every animation when motion is reduced, and on a low-end computer', async () => {
  function running(page) {
    // Only keyframe animations: the clicked button's hover transition is not what this is about.
    return page.evaluate(() => document.getAnimations().filter((animation) => animation instanceof CSSAnimation && animation.playState === 'running').length)
  }
  const page = await open('scenario=welcome&motion')
  try {
    await page.getByTestId('welcome-orbit-scene').waitFor()
    assert.equal(await page.getByTestId('welcome-page').getAttribute('data-motion-paused'), 'false')
    assert.ok(await running(page) > 0, 'the orbit animates when nothing asks it to stop')
    await page.getByTestId('welcome-motion').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="welcome-page"]')?.dataset.motionPaused === 'true')
    // A rule more specific than the pause rule used to keep one ellipse breathing.
    assert.equal(await running(page), 0)
  } finally { await page.close() }
  const lowEnd = await open('scenario=welcome&motion&lowEnd')
  try {
    await lowEnd.getByTestId('welcome-orbit-scene').waitFor()
    assert.equal(await lowEnd.getByTestId('welcome-page').getAttribute('data-motion-paused'), 'true')
    assert.equal(await running(lowEnd), 0)
    // Nothing to switch on or off there, so the switch is not offered.
    assert.equal(await lowEnd.getByTestId('welcome-motion').count(), 0)
  } finally { await lowEnd.close() }
})

test('auth and guide default surfaces fit the fixed desktop frame in both themes', async () => {
  for (const theme of ['light', 'dark']) for (const scenario of ['login', 'register', 'recovery', 'guide', 'splash']) {
    const page = await open(`scenario=${scenario}&theme=${theme}`)
    try {
      await page.locator(scenario === 'guide' ? '.auth-guide-frame' : scenario === 'splash' ? '.auth-splash' : '.auth-form').waitFor()
      const overflow = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('button,input')].filter((item) => item.getBoundingClientRect().width > 0)
        return visible.filter((item) => { const rect = item.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight }).map((item) => item.getAttribute('data-testid') || item.textContent)
      })
      assert.deepEqual(overflow, [], `${scenario}/${theme} controls stay reachable`)
      if (['guide', 'splash'].includes(scenario)) assert.equal(await page.getByTestId('window-titlebar').count(), 1)
      await page.screenshot({ path: path.join(output, `${scenario}-${theme}.png`) })
    } finally { await page.close() }
  }
})


test('source selection restores only that source credentials and makes login explicit', async () => {
  const page = await open('remembered=1&turnstile=1')
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="login-password"]')?.value === 'solov-remembered-password')
    assert.equal(await page.getByTestId('login-account').inputValue(), 'same@example.test')
    await chooseAccountSource(page, '历史账号')
    await page.waitForFunction(() => document.querySelector('[data-testid="login-password"]')?.value === 'solov-api-remembered-password')
    assert.doesNotMatch(await page.getByTestId('login-dialog').innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov/i)
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('authenticated'))
    const login = (await calls(page)).find((entry) => entry.method === 'login').input
    assert.deepEqual(login, { username: 'same@example.test', password: 'solov-api-remembered-password', siteId: 'solov-api' })
    assert.equal(await page.evaluate(() => document.documentElement.dataset.savedSite), 'solov-api')
    await page.screenshot({ path: path.join(output, 'login-source-selected.png') })
  } finally { await page.close() }
})

test('late credentials from another source cannot overwrite a typed password', async () => {
  const page = await open('remembered=1&pending=remembered-solov&pending=remembered-solov-api')
  try {
    await chooseAccountSource(page, '历史账号')
    await page.getByTestId('login-account').fill('typed@example.test')
    await page.getByTestId('login-password').fill('typed-password')
    await page.evaluate(() => { window.authHarness.release('remembered-solov'); window.authHarness.release('remembered-solov-api') })
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('authenticated'))
    assert.deepEqual((await calls(page)).find((entry) => entry.method === 'login').input, { username: 'typed@example.test', password: 'typed-password', siteId: 'solov-api' })
  } finally { await page.close() }
})

test('a pending explicit login locks its source and 2FA retains its source without retrying elsewhere', async () => {
  const page = await open('pending=login&twoFactor=1')
  try {
    await chooseAccountSource(page, '历史账号')
    await page.getByTestId('login-account').fill('same@example.test')
    await page.getByTestId('login-password').fill('test-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    assert.equal(await page.getByTestId('auth-source').getByRole('button', { name: '星芒账号' }).isDisabled(), true)
    assert.equal(await page.getByTestId('login-forgot').isDisabled(), true)
    assert.equal(await page.getByTestId('login-cancel').isDisabled(), true)
    await page.keyboard.press('Enter')
    await page.evaluate(() => window.authHarness.release('login'))
    await page.getByTestId('auth-error').filter({ hasText: '双重验证' }).waitFor()
    assert.equal(await page.getByTestId('login-password').inputValue(), 'test-password')
    assert.equal(await page.getByTestId('auth-source').getByRole('button', { name: '历史账号' }).getAttribute('aria-pressed'), 'true')
    await page.getByTestId('auth-open-website').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('external'))
    assert.deepEqual((await calls(page)).map((entry) => entry.method), ['login', 'external'])
    assert.equal((await calls(page))[1].input, 'https://api.solov.cc')
  } finally { await page.close() }
})

test('historical account recovery opens its official source and never sends a reset to the primary source', async () => {
  const page = await open()
  try {
    await chooseAccountSource(page, '历史账号')
    await page.getByTestId('login-account').fill('same@example.test')
    await page.getByTestId('login-forgot').click()
    await page.getByTestId('forgot-official-help').waitFor()
    assert.equal(await page.getByTestId('forgot-send').count(), 0)
    assert.equal(await page.getByTestId('forgot-token').count(), 0)
    await page.getByTestId('forgot-open-website').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('external'))
    assert.deepEqual(await calls(page), [{ method: 'external', input: 'https://api.solov.cc' }])
    await page.getByTestId('forgot-back-login').click()
    assert.equal(await page.getByTestId('auth-source').getByRole('button', { name: '历史账号' }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByTestId('login-account').inputValue(), 'same@example.test')
    await page.getByTestId('login-forgot').click()
    await chooseAccountSource(page, '星芒账号')
    await page.getByTestId('forgot-send').click()
    await page.getByTestId('forgot-token').waitFor()
    assert.deepEqual((await calls(page)).at(-1), { method: 'send-reset', input: { email: 'same@example.test', siteId: 'solov' } })
    await page.getByTestId('forgot-token').fill('old-source-token')
    await chooseAccountSource(page, '历史账号')
    await chooseAccountSource(page, '星芒账号')
    assert.equal(await page.getByTestId('forgot-token').count(), 0)
    assert.equal(await page.getByTestId('forgot-email').inputValue(), 'same@example.test')
  } finally { await page.close() }
})

test('the actual add-account flow preserves the current login on failure and accepts either explicit source', async () => {
  for (const target of ['solov-api', 'solov']) {
    const page = await open(target === 'solov' ? 'sub2api=1' : '', true)
    try {
      await page.getByTestId('tool-row-codex').waitFor()
      const previous = await page.evaluate(() => window.xingmang.getAccountSession())
      await page.getByRole('button', { name: '切换账号', exact: true }).click()
      await page.getByTestId('account-add').click()
      await chooseAccountSource(page, target === 'solov' ? '星芒账号' : '历史账号')
      await page.getByTestId('login-account').fill('same@example.test')
      await page.getByTestId('login-password').fill('same-test-password')
      await page.getByTestId('auth-agree').check()
      await page.evaluate(() => { window.v2Test.fail = 'loginAccount' })
      await page.getByTestId('login-submit').click()
      await page.getByTestId('auth-error').waitFor()
      assert.deepEqual(await page.evaluate(() => window.xingmang.getAccountSession()), previous)
      assert.equal(await page.getByTestId('login-account').inputValue(), 'same@example.test')
      await page.evaluate(() => { window.v2Test.fail = '' })
      await page.getByTestId('login-submit').click()
      await page.getByTestId('login-dialog').waitFor({ state: 'hidden' })
      const current = await page.evaluate(() => window.xingmang.getAccountSession())
      assert.equal(current.siteId, target)
      assert.equal(current.authenticated, true)
      assert.deepEqual(await page.evaluate(() => window.v2Test.unexpected), [])
    } finally { await page.close() }
  }
})

test('account settings follow the selected source so the verification entry matches that site', async () => {
  const page = await open('turnstile=solov-api')
  try {
    await page.getByTestId('login-dialog').waitFor()
    await page.waitForFunction(() => document.documentElement.dataset.statusSites === 'solov')
    assert.equal(await page.getByTestId('auth-verification-help').count(), 0)
    await chooseAccountSource(page, '历史账号')
    await page.getByTestId('auth-verification-help').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.statusSites), 'solov,solov-api')
    assert.doesNotMatch(await page.getByTestId('login-dialog').innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov|站点/i)
    await page.getByTestId('auth-verification-help').click()
    await page.waitForFunction(() => document.documentElement.dataset.calls?.includes('help'))
    await chooseAccountSource(page, '星芒账号')
    await page.waitForFunction(() => document.querySelector('[data-testid="auth-verification-help"]') === null)
  } finally { await page.close() }
})

test('a slow status read from the previous source cannot overwrite the selected one', async () => {
  const page = await open('turnstile=solov&pending=status-solov')
  try {
    await page.getByTestId('login-dialog').waitFor()
    await chooseAccountSource(page, '历史账号')
    await page.waitForFunction(() => document.documentElement.dataset.statusSites === 'solov,solov-api')
    await page.evaluate(() => window.authHarness.release('status-solov'))
    // A round trip through the legal document proves the released promise already settled.
    await page.getByTestId('auth-terms').click()
    await page.getByRole('heading', { name: 'Test Agreement' }).waitFor()
    await page.getByTestId('legal-document-close').click()
    await page.getByTestId('login-dialog').waitFor()
    assert.equal(await page.getByTestId('auth-verification-help').count(), 0)
  } finally { await page.close() }
})

// Playwright's keyboard only tracks Shift/Control/Alt/Meta, so the lock has to be
// stated on the event itself. Chromium fills getModifierState from these flags,
// which is exactly what the field reads.
async function typeWithCapsLock(page, testId, on) {
  await page.getByTestId(testId).evaluate((node, locked) => {
    for (const type of ['keydown', 'keyup']) node.dispatchEvent(new KeyboardEvent(type, { key: 'a', bubbles: true, modifierCapsLock: locked }))
  }, on)
}

test('password fields warn while Caps Lock is on and stop warning once it is off or the field is left', async () => {
  const page = await open()
  try {
    await page.getByTestId('login-password').fill('fixture-password')
    assert.equal(await page.getByTestId('login-password-caps').count(), 0)
    await page.getByTestId('login-password').focus()
    await typeWithCapsLock(page, 'login-password', true)
    await page.getByTestId('login-password-caps').waitFor()
    assert.equal((await page.getByTestId('login-password-caps').textContent()).trim(), '大写锁定已开启')
    // The warning has to reach the field itself, or a screen reader user hears nothing.
    assert.match(String(await page.getByTestId('login-password').getAttribute('aria-describedby')), /-caps(\s|$)/)
    assert.doesNotMatch(await page.getByTestId('login-dialog').innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov|站点/i)
    await typeWithCapsLock(page, 'login-password', false)
    await page.waitForFunction(() => document.querySelector('[data-testid="login-password-caps"]') === null)
    await typeWithCapsLock(page, 'login-password', true)
    await page.getByTestId('login-password-caps').waitFor()
    await page.getByTestId('login-account').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="login-password-caps"]') === null)
    // The account field is not a password field, so the lock stays its own business there.
    await typeWithCapsLock(page, 'login-account', true)
    assert.equal(await page.getByTestId('login-account-caps').count(), 0)
    // The login draft survives the warning appearing and disappearing.
    assert.equal(await page.getByTestId('login-password').inputValue(), 'fixture-password')
  } finally { await page.close() }
})

test('the historical account source and the registration passwords carry the same Caps Lock warning', async () => {
  const page = await open()
  try {
    await chooseAccountSource(page, '历史账号')
    // Switching the source refocuses the empty account field on the next frame;
    // focusing the password before that lands would lose the warning to the blur.
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'login-account')
    await page.getByTestId('login-password').focus()
    await typeWithCapsLock(page, 'login-password', true)
    await page.getByTestId('login-password-caps').waitFor()
  } finally { await page.close() }
  const registration = await open('scenario=register')
  try {
    await registration.getByTestId('register-password').focus()
    await typeWithCapsLock(registration, 'register-password', true)
    await registration.getByTestId('register-password-caps').waitFor()
    await registration.getByTestId('register-password-confirm').focus()
    await typeWithCapsLock(registration, 'register-password-confirm', true)
    await registration.getByTestId('register-password-confirm-caps').waitFor()
    // Each field answers for itself: the one being left stops warning, and the
    // one taking focus warns again from its own first key.
    await registration.getByTestId('register-password').focus()
    await registration.waitForFunction(() => document.querySelector('[data-testid="register-password-confirm-caps"]') === null)
    await typeWithCapsLock(registration, 'register-password', true)
    await registration.getByTestId('register-password-caps').waitFor()
  } finally { await registration.close() }
})
