import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const output = path.join(root, '.project-surgeon/audits/20260907-chat-v2')
let server, browser, base
before(async () => {
  await fs.mkdir(output, { recursive: true })
  server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 }, esbuild: { jsx: 'automatic' } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })
async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1064, height: 708 } })
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { if (location.search.includes('copyFail')) throw new Error('denied'); window.__copied = text } }, configurable: true }) })
  await page.route('**/*', async (route) => { if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort(); await route.continue() })
  await page.goto(`${base}/src/renderer-v2/features/chat/browser-fixture.html?${query}`)
  await page.getByTestId('chat-composer-input').waitFor()
  return page
}
async function ready(page) { await page.waitForFunction(() => { const select = document.querySelector('[data-testid=chat-model]'); return select && !select.disabled && select.value }) }
async function calls(page, method) { return page.evaluate((method) => window.chatHarness.calls.filter((item) => item.method === method), method) }
async function send(page, prompt = 'fixture prompt') { await ready(page); await page.getByTestId('chat-composer-input').fill(prompt); await page.getByTestId('chat-send').click(); await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start' || item.method === 'image')); return (await calls(page, 'start')).at(-1)?.input ?? (await calls(page, 'image')).at(-1)?.input }
async function emit(page, event) { await page.evaluate((event) => window.chatHarness.emit(event), event) }

test('group options show canonical names and native menus inherit the active theme', async () => {
  const page = await open('theme=dark&preferredGroup=1')
  try {
    const group = page.getByTestId('chat-group')
    assert.deepEqual(await group.locator('option').evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent }))), [
      { value: 'default', label: 'default' },
      { value: 'GPT-中转/订阅', label: 'GPT-中转/订阅' },
    ])
    await page.waitForFunction(() => document.querySelector('[data-testid=chat-group]')?.value === 'GPT-中转/订阅')
    assert.equal(await page.getByTestId('chat-mode').getByRole('button', { name: '文本对话', exact: true }).getAttribute('aria-pressed'), 'true', '首次进入聊天应默认文本对话')
    const styles = await group.evaluate((select) => {
      const option = select.options[0]
      return {
        selectScheme: getComputedStyle(select).colorScheme,
        optionScheme: getComputedStyle(option).colorScheme,
        optionColor: getComputedStyle(option).color,
        optionBackground: getComputedStyle(option).backgroundColor,
        height: getComputedStyle(select).height,
      }
    })
    assert.equal(styles.selectScheme, 'dark')
    assert.equal(styles.optionScheme, 'dark')
    assert.notEqual(styles.optionBackground, 'rgba(0, 0, 0, 0)')
    assert.notEqual(styles.optionColor, styles.optionBackground)
    assert.equal(styles.height, '28px')
    await ready(page)
    const model = page.getByTestId('chat-model')
    const geometry = await page.locator('.chat-model-select').evaluate((wrapper) => {
      const icon = wrapper.querySelector('.xm-brand').getBoundingClientRect()
      const select = wrapper.querySelector('select').getBoundingClientRect()
      return { iconLeft: icon.left, iconRight: icon.right, selectLeft: select.left, selectRight: select.right, selectWidth: select.width }
    })
    assert.ok(geometry.iconLeft >= geometry.selectLeft && geometry.iconRight <= geometry.selectRight)
    assert.equal(geometry.selectWidth, 240)
    assert.equal(await model.inputValue(), 'gpt-5.6-sol', '首次进入文本对话应选择截图中的默认模型')
    await model.selectOption('other-model')
    await page.getByText('自动 · 费用不可预测', { exact: true }).waitFor()
  } finally { await page.close() }
})

test('streams text and reasoning, stops without losing output, and ignores late content', async () => {
  const page = await open('strict=1')
  try {
    const request = await send(page, 'Explain the result')
    await emit(page, { type: 'reasoning', requestId: request.requestId, content: 'A short reasoning trace' })
    await emit(page, { type: 'content', requestId: request.requestId, content: '**Answer** with a code snippet.' })
    await page.getByText('思考过程', { exact: true }).waitFor()
    await page.getByTestId('chat-stop').click()
    await page.getByText('已停止生成，保留已返回的内容', { exact: true }).waitFor()
    await emit(page, { type: 'content', requestId: request.requestId, content: 'LATE OUTPUT MUST NOT APPEAR' })
    assert.equal(await page.getByText('LATE OUTPUT MUST NOT APPEAR').count(), 0)
    assert.equal(await page.getByText('Answer', { exact: true }).count(), 1)
    assert.equal((await calls(page, 'cancel')).length, 1)
  } finally { await page.close() }
})

test('IME Enter and Shift+Enter do not send while a plain Enter sends one request', async () => {
  const page = await open()
  try {
    await ready(page)
    const input = page.getByTestId('chat-composer-input')
    await input.fill('中文输入')
    await input.dispatchEvent('compositionstart')
    await input.press('Enter')
    assert.equal((await calls(page, 'start')).length, 0)
    await input.dispatchEvent('compositionend')
    await input.press('Shift+Enter')
    assert.equal((await calls(page, 'start')).length, 0)
    await input.press('Enter')
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start'))
    assert.equal((await calls(page, 'start')).length, 1)
  } finally { await page.close() }
})

test('retry reuses its original settings without duplicating a user message, edit rebuilds later history', async () => {
  const page = await open()
  try {
    const first = await send(page, 'original question')
    await emit(page, { type: 'error', requestId: first.requestId, message: 'network error' })
    await page.getByTestId('chat-group').selectOption('group-b')
    await ready(page)
    await page.getByRole('button', { name: '重新生成', exact: true }).click()
    await page.getByTestId('chat-confirm').getByRole('button', { name: '重新生成', exact: true }).click()
    await page.waitForFunction(() => window.chatHarness.calls.filter((item) => item.method === 'start').length === 2)
    const retried = (await calls(page, 'start'))[1].input
    assert.equal(retried.group, first.group)
    assert.equal(retried.model, first.model)
    assert.deepEqual(retried.messages, first.messages)
    assert.equal(await page.locator('.chat-message[data-role=user]').count(), 1)
    await emit(page, { type: 'content', requestId: retried.requestId, content: 'completed result' })
    await emit(page, { type: 'complete', requestId: retried.requestId })
    await page.getByRole('button', { name: '编辑消息', exact: true }).click()
    await page.getByTestId('chat-edit-input').fill('edited question')
    await page.getByTestId('chat-edit-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.filter((item) => item.method === 'start').length === 3)
    const edited = (await calls(page, 'start'))[2].input
    assert.deepEqual(edited.messages, [{ role: 'user', content: 'edited question' }])
    assert.equal(await page.locator('.chat-message[data-role=user]').count(), 1)
  } finally { await page.close() }
})

test('late group preparation and account stream results cannot replace a newer scope', async () => {
  const page = await open('deferPreparation=1')
  try {
    await page.getByTestId('chat-group').selectOption('group-b')
    await ready(page)
    await page.evaluate(() => window.chatHarness.finishPreparation())
    assert.equal(await page.getByTestId('chat-group').inputValue(), 'group-b')
    assert.equal(await page.getByTestId('chat-model').inputValue(), 'other-model')
    const request = await send(page, 'old account secret')
    await page.evaluate(() => window.chatHarness.switchScope(8))
    await page.waitForFunction(() => document.querySelector('[data-testid=page-chat]')?.getAttribute('data-account-scope') === 'site:8')
    await emit(page, { type: 'content', requestId: request.requestId, content: 'stale account content' })
    assert.equal(await page.getByText('old account secret', { exact: true }).count(), 0)
    assert.equal(await page.getByText('stale account content', { exact: true }).count(), 0)
    assert.ok((await calls(page, 'cancel')).some((item) => item.input === request.requestId))
  } finally { await page.close() }
})

test('image controls use real model capabilities and asset actions use opaque ids', async () => {
  const page = await open('saveCancel=1')
  try {
    await ready(page)
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).click()
    assert.equal(await page.getByTestId('chat-model').inputValue(), 'gpt-image-2')
    assert.equal(await page.getByTestId('chat-model').locator('option').filter({ hasText: 'gpt-image-1.5' }).count(), 0)
    await page.getByTestId('chat-image-quality').selectOption('high')
    await page.getByTestId('chat-image-resolution').selectOption('2K')
    const request = await send(page, 'A test scene')
    assert.equal(request.quality, 'high')
    assert.equal(request.imageResolution, '2K')
    await page.evaluate((id) => window.chatHarness.completeImage(id), request.requestId)
    await page.getByRole('button', { name: '查看生成图片' }).waitFor()
    await page.getByTestId('chat-asset-copy').click()
    await page.getByTestId('chat-asset-save').click()
    await page.getByTestId('chat-asset-menu').click()
    assert.equal((await calls(page, 'copy-asset'))[0].input, 'a'.repeat(43))
    assert.equal((await calls(page, 'save-asset'))[0].input, 'a'.repeat(43))
    assert.equal((await calls(page, 'menu-asset'))[0].input, 'a'.repeat(43))
    assert.equal(await page.getByText('图片已保存', { exact: true }).count(), 0)
    await page.screenshot({ path: path.join(output, 'image-result-light.png') })
  } finally { await page.close() }
})

test('canceling paid image work requires acknowledgement and ignores a late asset result', async () => {
  const page = await open('cancelReject=1')
  try {
    await ready(page)
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).click()
    const request = await send(page, 'A paid image')
    await page.getByTestId('chat-stop').click()
    const confirm = page.getByTestId('chat-confirm')
    assert.equal(await confirm.getByRole('button', { name: '停止等待', exact: true }).isDisabled(), true)
    await confirm.getByRole('checkbox').check()
    await confirm.getByRole('button', { name: '停止等待', exact: true }).click()
    await page.getByText('已停止等待，服务端仍可能处理并计费', { exact: true }).waitFor()
    await page.evaluate((id) => window.chatHarness.completeImage(id), request.requestId)
    assert.equal(await page.getByRole('button', { name: '查看生成图片' }).count(), 0)
    await page.getByRole('button', { name: '重新生成', exact: true }).click()
    assert.equal(await page.getByTestId('chat-confirm').getByRole('button', { name: '重新生成', exact: true }).isDisabled(), true)
  } finally { await page.close() }
})

test('parameters and system prompt are applied to the request and text copy has a manual fallback', async () => {
  const page = await open('copyFail=1')
  try {
    await ready(page)
    await page.getByTestId('chat-parameters-open').click()
    await page.getByTestId('chat-parameter-temperature').fill('0.7')
    await page.getByTestId('chat-parameter-maxTokens').fill('2048')
    await page.getByTestId('chat-system-prompt').fill('Be precise')
    await page.getByTestId('chat-parameters-apply').click()
    await page.keyboard.press('Escape')
    const request = await send(page, 'test message')
    assert.deepEqual(request.parameters, { temperature: .7, maxTokens: 2048 })
    assert.deepEqual(request.messages[0], { role: 'system', content: 'Be precise' })
    await emit(page, { type: 'content', requestId: request.requestId, content: 'copy me' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByRole('button', { name: '复制内容', exact: true }).last().click()
    await page.getByTestId('chat-copy-fallback').waitFor()
    assert.equal(await page.getByTestId('chat-copy-fallback').getByRole('textbox').inputValue(), 'copy me')
  } finally { await page.close() }
})

test('new conversations preserve unsent drafts and local history can be restored after reload', async () => {
  const page = await open()
  try {
    await ready(page)
    await page.getByTestId('chat-composer-input').fill('unsent local draft')
    await page.getByTestId('chat-conversation-new').click()
    await page.locator('.chat-conversation-select').filter({ hasText: 'unsent local draft' }).click()
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'unsent local draft')
    await page.waitForFunction(() => localStorage.getItem('xingmang-ui-v2:chat:site%3A7')?.includes('unsent local draft'))
    await page.reload()
    await ready(page)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'unsent local draft')
    const request = await send(page, 'stored conversation')
    await emit(page, { type: 'content', requestId: request.requestId, content: 'stored response' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByTestId('chat-conversation-clear').click()
    await page.getByTestId('chat-confirm').getByRole('button', { name: '确认删除' }).click()
    assert.equal(await page.locator('.chat-message').count(), 0)
  } finally { await page.close() }
})

test('a late image from a previous account does not appear in the current account', async () => {
  const page = await open()
  try {
    await ready(page)
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).click()
    const request = await send(page, 'old owner image')
    await page.evaluate(() => window.chatHarness.switchScope(8))
    await page.waitForFunction(() => document.querySelector('[data-testid=page-chat]')?.getAttribute('data-account-scope') === 'site:8')
    await page.evaluate((id) => window.chatHarness.completeImage(id), request.requestId)
    assert.equal(await page.getByRole('button', { name: '查看生成图片' }).count(), 0)
    assert.equal(await page.getByText('old owner image', { exact: true }).count(), 0)
  } finally { await page.close() }
})

test('group fetch failure can be retried without clearing the user draft', async () => {
  const page = await open('groupFail=1')
  try {
    await page.getByTestId('chat-groups-retry').waitFor()
    await page.getByTestId('chat-composer-input').fill('keep while offline')
    await page.evaluate(() => window.chatHarness.resetGroupFailure())
    await page.getByTestId('chat-groups-retry').click()
    await ready(page)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'keep while offline')
    assert.equal(await page.getByTestId('chat-groups-retry').count(), 0)
  } finally { await page.close() }
})

test('hidden chat keeps its request and drafts while exposing native close protection flags', async () => {
  const page = await open()
  try {
    const request = await send(page, 'background request')
    await page.getByTestId('chat-composer-input').fill('next draft')
    assert.equal(await page.getByTestId('page-chat').getAttribute('data-busy'), 'true')
    assert.equal(await page.getByTestId('page-chat').getAttribute('data-unsaved'), 'true')
    await page.evaluate(() => window.chatHarness.setActive(false))
    assert.equal(await page.getByTestId('page-chat').isVisible(), false)
    assert.equal((await calls(page, 'cancel')).length, 0)
    await emit(page, { type: 'content', requestId: request.requestId, content: 'background result' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    assert.equal(await page.getByTestId('page-chat').getAttribute('data-busy'), 'false')
    await page.getByTestId('chat-composer-input').dispatchEvent('keydown', { key: 'Enter', bubbles: true })
    assert.equal((await calls(page, 'start')).length, 1)
    await page.evaluate(() => window.chatHarness.setActive(true))
    await page.getByText('background result', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'next draft')
  } finally { await page.close() }
})

test('hidden chat removes native popup surfaces and preserves an edited message draft', async () => {
  const page = await open()
  try {
    const request = await send(page, 'initial message')
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByTestId('chat-parameters-open').click()
    await page.getByTestId('chat-parameters').waitFor()
    await page.evaluate(() => window.chatHarness.setActive(false))
    assert.equal(await page.locator(':popover-open').count(), 0)
    await page.evaluate(() => window.chatHarness.setActive(true))
    await page.getByRole('button', { name: '编辑消息', exact: true }).click()
    await page.getByTestId('chat-edit-input').fill('preserved edited draft')
    assert.equal(await page.getByTestId('page-chat').getAttribute('data-unsaved'), 'true')
    await page.evaluate(() => window.chatHarness.setActive(false))
    assert.equal(await page.locator('dialog[open]').count(), 0)
    await page.evaluate(() => window.chatHarness.setActive(true))
    await page.getByTestId('chat-edit-dialog').waitFor()
    assert.equal(await page.getByTestId('chat-edit-input').inputValue(), 'preserved edited draft')
  } finally { await page.close() }
})

test('default, empty and failed chat surfaces fit the fixed desktop content frame', async () => {
  for (const theme of ['light', 'dark']) for (const os of ['win', 'mac']) for (const mode of ['default', 'empty', 'failed']) {
    const page = await open(`theme=${theme}&os=${os}${mode === 'failed' ? '&groupFail=1' : ''}`)
    try {
      assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), theme === 'dark' ? 'obsidian' : 'dawn')
      if (mode === 'default') {
        const request = await send(page, '测试聊天布局')
        await emit(page, { type: 'content', requestId: request.requestId, content: '已经收到你的问题。\n\n这是一段本地测试回复。' })
        await emit(page, { type: 'complete', requestId: request.requestId })
      } else if (mode === 'empty') await ready(page)
      else await page.getByTestId('chat-groups-retry').waitFor()
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.chat-page button,.chat-page input,.chat-page textarea,.chat-page select')].filter((item) => { const box = item.getBoundingClientRect(); return box.width && (box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight) }).map((item) => item.getAttribute('aria-label') || item.textContent))
      assert.deepEqual(overflow, [])
      await page.screenshot({ path: path.join(output, `chat-${theme}-${os}-${mode}.png`) })
    } finally { await page.close() }
  }
})
