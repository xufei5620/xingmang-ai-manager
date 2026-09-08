import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const output = path.join(root, '.project-surgeon/audits/20260907-auth-v2')
let server
let browser
let base
before(async () => {
  await fs.mkdir(output, { recursive: true })
  server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 }, esbuild: { jsx: 'automatic' } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') return route.abort()
    await route.continue()
  })
  await page.goto(`${base}/src/renderer-v2/features/auth/browser-fixture.html?${query}`)
  return page
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
    assert.equal(await page.getByTestId('register-email').getAttribute('placeholder'), 'name@example.com')
    await page.getByTestId('register-email').fill('person@163.com')
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
    await page.getByTestId('forgot-token').fill('https://example.test/reset?token=one&token=two')
    await page.getByTestId('forgot-reset').click()
    await page.getByTestId('auth-error').filter({ hasText: '多个重置码' }).waitFor()
    assert.deepEqual((await calls(page)).map((item) => item.method), ['send-reset'])
    await page.getByTestId('forgot-token').fill('https://example.test/reset?token=one%2Btwo')
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
    assert.deepEqual((await calls(page)).find((item) => item.method === 'reset').input, { email: 'person@gmail.com', token: 'one+two' })
  } finally { await page.close() }
})

test('chat guide keeps all four steps and never installs a runtime or tool', async () => {
  const page = await open('scenario=guide&loggedOut=1')
  try {
    assert.equal(await page.locator('input[type=radio]').count(), 6)
    assert.equal(await page.locator('input[type=radio]:checked').count(), 0)
    assert.equal(await page.getByTestId('guide-next').isDisabled(), true)
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

test('canceling CLI workspace selection keeps the guide on its ready step', async () => {
  const page = await open('scenario=guide&installed=1&connected=1&runtime=1&launchCancel=1')
  try {
    await page.getByTestId('guide-route-codex').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'ready')
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
    assert.deepEqual(await page.locator('.auth-guide-check-row strong').allTextContents(), ['Node.js 与 npm', 'Python', 'Gemini CLI'])
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
    await page.getByTestId('guide-next').click()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-step'), 'connect')
    assert.deepEqual((await calls(page)).map((item) => item.method), ['detect', 'runtime', 'python', 'install'])
  } finally { await page.close() }
})

test('guide pause resumes the chosen route and step without choosing for a fresh account', async () => {
  const page = await open('scenario=guide&resume=1&runtime=1&python=1&installed=1&connected=1&strict=1')
  try {
    assert.equal(await page.evaluate(() => localStorage.getItem('xingmang-ui-v2:guide:site%3A7')), null)
    assert.equal(await page.locator('input[type=radio]:checked').count(), 0)
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
    assert.equal(await page.locator('input[type=radio]:checked').count(), 0)
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
    assert.equal(await page.locator('input[type=radio]:checked').count(), 0)
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
    assert.deepEqual((await calls(page)).find((item) => item.method === 'login').input, { username: 'fixture-member', password: 'fixture-password' })
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
