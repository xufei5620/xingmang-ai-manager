import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { openFixturePage } from '../../../../e2e/fixture-readiness.mjs'
import { assertNoToast, recordToasts, waitForToast } from '../../../../e2e/toast-recording.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const output = path.join(root, '.project-surgeon/audits/20260907-chat-v2')
let server, browser, base
before(async () => {
  await fs.mkdir(output, { recursive: true })
  ;({ server, origin: base } = await createFixtureServer({ root, configFile: false, esbuild: { jsx: 'automatic' } }))
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
async function open(query = '', stored = {}, init) {
  const page = await browser.newPage({ viewport: { width: 1064, height: 708 } })
  await page.addInitScript(recordToasts)
  if (init) await page.addInitScript(init)
  if (Object.keys(stored).length) await page.addInitScript((records) => {
    if (sessionStorage.getItem('chat-storage-fixture-seeded')) return
    for (const [key, value] of Object.entries(records)) localStorage.setItem(key, value)
    sessionStorage.setItem('chat-storage-fixture-seeded', '1')
  }, stored)
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { if (location.search.includes('copyFail')) throw new Error('denied'); window.__copied = text } }, configurable: true }) })
  await page.route('**/*', async (route) => { if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort(); await route.continue() })
  // Mounting and asserting are two different waits. Vite transforms the module
  // graph on demand, so a cold open on a Windows runner can spend far longer
  // than Playwright's 30s action default before React commits anything - and
  // reports it as the composer failing to appear, which reads like a broken
  // chat surface rather than a slow start. Wait for the first commit on the
  // shared mount budget, then let the composer keep the default so a real
  // regression still fails in 30s.
  //
  // Five of the fourteen Windows browser-shard failures between 2026-09-19 and
  // 2026-09-21 were this open, and none of them was slow: the page never came
  // back at all. openFixturePage spends the same budget as up to three
  // navigations rather than one stare at a dead page.
  await openFixturePage(page, `${base}/src/renderer-v2/features/chat/browser-fixture.html?${query}`,
    (timeout) => page.locator('#root > *').first().waitFor({ timeout }), { label: 'chat fixture' })
  await page.getByTestId('chat-composer-input').waitFor()
  return page
}
async function ready(page) { await page.waitForFunction(() => { const button = document.querySelector('[data-testid=chat-model]'); return button && !button.disabled && button.dataset.model }) }
// 模型菜单按厂商分节列全部分组的模型，不选分组：按钮上带着当前的模型和按哪个分组计费（data-model / data-group），选项只在菜单打开时才有。
async function picked(page) { return page.getByTestId('chat-model').evaluate((button) => ({ group: button.dataset.group, model: button.dataset.model, label: button.querySelector('.chat-model-name').textContent })) }
async function modelMenu(page) {
  const menu = page.getByRole('menu', { name: '模型', exact: true })
  if (!await menu.count()) await page.getByTestId('chat-model').click()
  await menu.waitFor()
  return menu
}
async function closeMenu(page, menu) {
  if (await menu.count()) { await menu.locator('button:not(:disabled)').first().focus(); await page.keyboard.press('Escape') }
  await menu.waitFor({ state: 'detached' })
}
// 每节是一家厂商，选项是模型名，小字是选它以后按哪个分组计费。
async function vendorSections(menu) { return menu.getByRole('group').evaluateAll((sections) => sections.map((section) => ({ vendor: section.getAttribute('aria-label'), models: [...section.querySelectorAll('[role=menuitemradio]')].map((item) => ({ label: item.querySelector('.xm-menu-choice > span').textContent, hint: item.querySelector('.xm-menu-choice > small')?.textContent ?? '', checked: item.getAttribute('aria-checked') === 'true' })) }))) }
async function menuSections(page) { const menu = await modelMenu(page); const list = await vendorSections(menu); await closeMenu(page, menu); return list }
async function pickModel(page, name) { const menu = await modelMenu(page); await menu.getByRole('menuitemradio', { name, exact: true }).click(); await menu.waitFor({ state: 'detached' }) }
// 打开聊天时每个分组都准备一遍，等它们都读完（按钮上的 data-preparing 放下）。
async function allPrepared(page) { await page.waitForFunction(() => document.querySelector('[data-testid=chat-model]')?.dataset.preparing === 'false') }
async function preparedGroups(page, from = 0) { return (await calls(page, 'prepare')).slice(from).map((call) => call.input) }
async function pickChoice(page, testId, label, name) {
  await page.getByTestId(testId).click()
  const menu = page.getByRole('menu', { name: label, exact: true })
  await menu.getByRole('menuitemradio', { name, exact: true }).click()
  await menu.waitFor({ state: 'detached' })
}
async function calls(page, method) { return page.evaluate((method) => window.chatHarness.calls.filter((item) => item.method === method), method) }
async function send(page, prompt = 'fixture prompt') { await ready(page); await page.getByTestId('chat-composer-input').fill(prompt); await page.getByTestId('chat-send').click(); await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start' || item.method === 'image')); return (await calls(page, 'start')).at(-1)?.input ?? (await calls(page, 'image')).at(-1)?.input }
async function emit(page, event) { await page.evaluate((event) => window.chatHarness.emit(event), event) }

const storedChatKey = 'xingmang-ui-v2:chat:xm-account%3A7'
const legacyChatKey = 'xingmang-ai-chat:v1:7'
function storedWorkspace() {
  const settings = { mode: 'text', group: 'group-a', model: 'gpt-test', systemPrompt: '', parameters: {}, size: '1024x1024', quality: 'low', imageResolution: '1K' }
  const conversation = (id) => ({ id, title: '保存的对话', createdAt: 1, updatedAt: 1, draft: '', settings, messages: [] })
  return { version: 2, owner: 'xm-account:7', activeId: 'saved', conversations: [conversation('saved')], draftConversation: conversation('draft') }
}

async function saved(page, scope = 'xm-account:7') { return page.evaluate((scope) => window.chatHarness.savedWorkspace(scope), scope) }
// waitForFunction does not await an async predicate, and the saved files live
// behind an async store, so poll it here; the predicate runs in the page to
// avoid shipping megabytes of history back on every poll.
async function waitSaved(page, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!await page.evaluate(async (source) => {
    const workspace = await window.chatHarness.savedWorkspace('xm-account:7')
    return Boolean(workspace) && new Function('workspace', `return (${source})(workspace)`)(workspace)
  }, predicate.toString())) {
    if (Date.now() > deadline) throw new Error('chat history was not saved in time')
    await page.waitForTimeout(50)
  }
}

test('long localStorage history migrates into the file store and survives autosave and reload without truncation', async () => {
  const state = storedWorkspace()
  const content = `${'历史完整正文'.repeat(9000)}CONTENT-END`
  const reasoning = `${'历史完整思考'.repeat(9000)}REASONING-END`
  state.conversations[0].messages = [{ id: 'long-history', role: 'assistant', content, reasoning, status: 'complete', createdAt: 1 }]
  const raw = JSON.stringify(state)
  const page = await open('strict=1', { [storedChatKey]: raw })
  try {
    await ready(page)
    await page.getByTestId('chat-composer-input').fill('autosave trigger')
    await waitSaved(page, (workspace) => workspace.conversations[0].draft === 'autosave trigger')
    const message = (await saved(page)).conversations[0].messages[0]
    assert.equal(message.content, content)
    assert.equal(message.reasoning, reasoning)
    // Once the file store holds it, the old copy is removed so deleted chats do not linger there.
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storedChatKey), null)
    await page.reload()
    await page.getByTestId('chat-message-long-history').waitFor()
    assert.equal(await page.locator('.chat-bubble').innerText(), content)
    assert.equal(await page.locator('.chat-reasoning > div').textContent(), reasoning)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'autosave trigger')
  } finally { await page.close() }
})

// This used to pin the opposite: past 4 MB the page stopped saving, and
// anything said after that was gone once the window closed.
test('history past the former 4 MB limit keeps saving, and a reopened window has everything said after it', async () => {
  const state = storedWorkspace()
  // The large record sits in an older conversation: a single request has its
  // own size limit, which is not what this test is about.
  state.conversations.push({ ...state.conversations[0], id: 'older', title: '很长的旧对话', messages: [{ id: 'over-limit', role: 'assistant', content: 'x'.repeat(4 * 1024 * 1024), reasoning: '', status: 'complete', createdAt: 1 }] })
  const page = await open('strict=1', { [storedChatKey]: JSON.stringify(state) })
  try {
    const request = await send(page, 'asked after the limit')
    await emit(page, { type: 'reasoning', requestId: request.requestId, content: 'y'.repeat(4 * 1024 * 1024) })
    await emit(page, { type: 'content', requestId: request.requestId, content: 'ANSWER-AFTER-LIMIT' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByTestId('chat-composer-input').fill('draft after the limit')
    await waitSaved(page, (workspace) => workspace.conversations[0].draft === 'draft after the limit' && workspace.conversations[0].messages.at(-1).status === 'complete')
    assert.equal(await page.getByRole('alert').count(), 0)
    await page.reload()
    await page.getByText('ANSWER-AFTER-LIMIT', { exact: true }).waitFor()
    assert.equal(await page.locator('.chat-bubble').filter({ hasText: 'asked after the limit' }).count(), 1)
    assert.equal(await page.locator('.chat-reasoning > div').last().evaluate((element) => element.textContent.length), 4 * 1024 * 1024)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'draft after the limit')
    await page.locator('.chat-conversation-select').filter({ hasText: '很长的旧对话' }).click()
    assert.equal(await page.locator('[data-testid=chat-message-over-limit] .chat-bubble').evaluate((element) => element.textContent.length), 4 * 1024 * 1024)
  } finally { await page.close() }
})

test('legacy import completes before autosave and preserves long history under StrictMode', async () => {
  const content = `${'旧版内容'.repeat(11000)}LEGACY-END`
  const messages = Array.from({ length: 120 }, (_, index) => ({ id: `legacy-${index}`, role: index % 2 ? 'assistant' : 'user', content: index === 119 ? content : `message-${index}`, reasoning: '', status: 'complete', createdAt: index }))
  const raw = JSON.stringify({ version: 1, userId: '7', data: { group: 'group-a', model: 'gpt-test', messages } })
  const page = await open('strict=1', { [legacyChatKey]: raw })
  try {
    await page.getByTestId('chat-message-legacy-119').waitFor()
    await page.getByTestId('chat-composer-input').fill('post migration draft')
    await waitSaved(page, (workspace) => workspace.conversations[0].draft === 'post migration draft')
    const stored = await saved(page)
    assert.equal(stored.conversations[0].messages.length, 120)
    assert.equal(stored.conversations[0].messages.at(-1).content, content)
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), legacyChatKey), null)
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storedChatKey), null)
  } finally { await page.close() }
})

test('legacy read failures cannot establish an empty history via autosave or unmount', async () => {
  const raw = JSON.stringify({ version: 1, userId: '8', data: { messages: [{ id: 'old', role: 'user', content: 'belongs to someone else' }] } })
  const page = await open('strict=1', { [legacyChatKey]: raw })
  try {
    // 原因只进日志，红条一律说同一句（W24）。
    await page.getByRole('alert').filter({ hasText: '以前的聊天记录暂时读不出来，原文件没动。现在聊的内容不会保存，关掉软件就没了。' }).waitFor()
    await page.getByTestId('chat-composer-input').fill('not persisted')
    await page.waitForTimeout(400)
    assert.equal(await saved(page), null)
    await page.evaluate(() => window.chatHarness.switchScope(8))
    await page.waitForFunction(() => document.querySelector('[data-testid=page-chat]')?.getAttribute('data-account-scope') === 'xm-account:8')
    assert.equal(await saved(page), null)
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), legacyChatKey), raw)
  } finally { await page.close() }
})

test('a failed save keeps the result in the window, reports it and leaves the saved files alone until a later save succeeds', async () => {
  const page = await open()
  try {
    const request = await send(page, 'retained question')
    await waitSaved(page, (workspace) => workspace.conversations[0]?.messages.length === 2)
    const previous = await saved(page)
    await page.evaluate(() => window.chatHarness.failHistoryWrites(true))
    await emit(page, { type: 'content', requestId: request.requestId, content: 'VISIBLE-UNSAVED-RESULT' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByRole('alert').filter({ hasText: '聊天记录没有保存到本机' }).waitFor()
    assert.equal(await page.getByText('VISIBLE-UNSAVED-RESULT', { exact: true }).count(), 1)
    assert.deepEqual(await saved(page), previous)
    await page.evaluate(() => window.chatHarness.failHistoryWrites(false))
    await page.getByTestId('chat-composer-input').fill('saved again')
    await waitSaved(page, (workspace) => workspace.conversations[0].messages.at(-1).content === 'VISIBLE-UNSAVED-RESULT')
    await page.getByRole('alert').filter({ hasText: '聊天记录没有保存到本机' }).waitFor({ state: 'detached' })
  } finally { await page.close() }
})

// 主进程每 50 毫秒推一段字，以前「停下 250 毫秒才存」一直被重置，整段说完之前一个字都不存（0.2.24 深查聊天页 C1）。
test('a reply that keeps streaming is saved every couple of seconds, not only once it ends', async () => {
  const page = await open()
  try {
    const request = await send(page, 'a long answer please')
    await waitSaved(page, (workspace) => workspace.conversations[0]?.messages.length === 2)
    // Four seconds of chunks with no pause the old 250 ms debounce could catch.
    await page.evaluate(async (requestId) => {
      for (let index = 0; index < 80; index += 1) {
        window.chatHarness.emit({ type: 'content', requestId, content: `chunk-${index} ` })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }, request.requestId)
    const reply = (await saved(page)).conversations[0].messages[1]
    assert.equal(reply.status, 'streaming')
    assert.ok(reply.content.startsWith('chunk-0 chunk-1 '), `saved reply so far: ${JSON.stringify(reply.content.slice(0, 40))}`)
  } finally { await page.close() }
})

test('quitting mid-reply saves what has arrived before answering the main process', async () => {
  const page = await open()
  try {
    const request = await send(page, 'quit while answering')
    await waitSaved(page, (workspace) => workspace.conversations[0]?.messages.length === 2)
    await emit(page, { type: 'reasoning', requestId: request.requestId, content: 'THINKING-BEFORE-QUIT' })
    await emit(page, { type: 'content', requestId: request.requestId, content: 'ARRIVED-BEFORE-QUIT' })
    // Read straight after the answer, well inside the 250 ms the autosave would still be waiting.
    const reply = await page.evaluate(async () => {
      await window.chatHarness.askBeforeQuit('quit-1')
      return (await window.chatHarness.savedWorkspace('xm-account:7')).conversations[0].messages[1]
    })
    assert.equal(reply.content, 'ARRIVED-BEFORE-QUIT')
    assert.equal(reply.reasoning, 'THINKING-BEFORE-QUIT')
    assert.deepEqual((await calls(page, 'flushed')).map((call) => call.input), ['quit-1'])
  } finally { await page.close() }
})

test('one menu lists the models of every group by vendor, each naming the group it bills to', async () => {
  const page = await open('theme=dark&preferredGroup=1')
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid=chat-model]')?.dataset.group === 'GPT')
    assert.equal(await page.getByTestId('chat-mode').getByRole('button', { name: '文本对话', exact: true }).getAttribute('aria-pressed'), 'true', '首次进入聊天应默认文本对话')
    await ready(page)
    assert.deepEqual(await picked(page), { group: 'GPT', model: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }, '首次进入文本对话应选择截图中的默认模型')
    await allPrepared(page)
    assert.deepEqual((await preparedGroups(page)).sort(), ['GPT', 'default'], 'opening chat reads the models of every group once')
    const menu = await modelMenu(page)
    // 没有分组那一节了；两个分组都有的 other-model 只列一次，小字写选它以后按哪个分组计费（正在用的分组有它就留在那个分组）。
    assert.deepEqual(await vendorSections(menu), [
      { vendor: 'OpenAI', models: [{ label: 'gpt-5.6-sol', hint: 'GPT分组', checked: true }] },
      { vendor: '其他', models: [{ label: 'other-model', hint: 'GPT分组', checked: false }] },
    ])
    assert.equal(await menu.getByRole('menuitemradio', { name: 'gpt-5.6-sol', exact: true }).getAttribute('title'), 'GPT分组')
    assert.equal(await menu.getByTestId('chat-group-prepare').textContent(), '刷新模型')
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector('.xm-menu-choice > span')?.textContent), 'gpt-5.6-sol', 'the menu opens on the chosen model')
    const surface = await menu.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }))
    assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)')
    assert.notEqual(surface.color, surface.background)
    await pickModel(page, 'other-model')
    assert.deepEqual(await picked(page), { group: 'GPT', model: 'other-model', label: 'other-model' })
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'chat-model', 'focus returns to the button after a pick')
    // 计费提示只留输入框下面那一句，右上角那个「自动 · 费用不可预测」去掉了。
    assert.equal(await page.getByTestId('chat-cost-note').textContent(), '按实际用量计费，回复越长花得越多。')
    assert.equal(await page.getByText('回答由模型生成，可能有误，重要内容请核对。', { exact: false }).count(), 1)
    assert.equal(await page.getByText('自动 · 费用不可预测', { exact: true }).count(), 0)
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

test('web links in model output copy their address instead of opening, and other links stay inert', async () => {
  const page = await open()
  try {
    const request = await send(page, 'Give me a link')
    await emit(page, { type: 'content', requestId: request.requestId, content: 'See [the docs](https://example.com/guide), https://example.org/x and [mail](mailto:a@example.com).' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    const link = page.getByTestId('chat-link').first()
    await link.waitFor()
    assert.equal(await page.locator('.chat-bubble a').count(), 0)
    assert.equal(await link.evaluate((element) => element.tagName), 'BUTTON')
    assert.equal((await link.textContent())?.trim(), 'the docs（example.com）')
    assert.equal(await link.getAttribute('title'), '点一下复制网址')
    assert.equal((await page.getByTestId('chat-link').nth(1).textContent())?.trim(), 'https://example.org/x')
    const mail = page.getByText('mail', { exact: true })
    assert.equal(await mail.evaluate((element) => element.tagName), 'SPAN')
    assert.equal(await mail.getAttribute('title'), '链接不可直接打开：mailto:a@example.com')
    await link.click()
    await waitForToast(page, '网址已复制，粘贴到浏览器地址栏就能打开')
    assert.equal(await page.evaluate(() => window.__copied), 'https://example.com/guide')
  } finally { await page.close() }
})

test('link copy falls back to manual copy when the clipboard is unavailable', async () => {
  const page = await open('copyFail=1')
  try {
    const request = await send(page, 'Give me a link')
    await emit(page, { type: 'content', requestId: request.requestId, content: '[docs](https://example.com/guide)' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByTestId('chat-link').click()
    await page.getByTestId('chat-copy-fallback').waitFor()
    assert.equal(await page.getByTestId('chat-copy-fallback').getByRole('textbox').inputValue(), 'https://example.com/guide')
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
    // other-model 只有 group-b 有：选了它，这段对话就改按 group-b 计费。
    await pickModel(page, 'other-model')
    assert.deepEqual(await picked(page), { group: 'group-b', model: 'other-model', label: 'other-model' })
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
    await page.getByRole('button', { name: '编辑后重新发送', exact: true }).click()
    await page.getByTestId('chat-edit-input').fill('edited question')
    await page.getByTestId('chat-edit-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.filter((item) => item.method === 'start').length === 3)
    const edited = (await calls(page, 'start'))[2].input
    assert.deepEqual(edited.messages, [{ role: 'user', content: 'edited question' }])
    assert.equal(await page.locator('.chat-message[data-role=user]').count(), 1)
  } finally { await page.close() }
})

test('a late group preparation keeps the model picked meanwhile, and account stream results cannot replace a newer scope', async () => {
  const page = await open('deferPreparation=1')
  try {
    // group-a 还没读完，菜单先列已经读到的 group-b 的模型。
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-model"] .chat-model-name')?.textContent === '正在准备模型')
    await pickModel(page, 'other-model')
    await ready(page)
    await page.evaluate(() => window.chatHarness.finishPreparation())
    await allPrepared(page)
    assert.deepEqual(await picked(page), { group: 'group-b', model: 'other-model', label: 'other-model' })
    const request = await send(page, 'old account secret')
    await page.evaluate(() => window.chatHarness.switchScope(8))
    await page.waitForFunction(() => document.querySelector('[data-testid=page-chat]')?.getAttribute('data-account-scope') === 'xm-account:8')
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
    await allPrepared(page)
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).click()
    assert.equal((await picked(page)).model, 'gpt-image-2')
    // 生成图片时菜单只列出图的模型，两个分组的都在；gpt-image-1.5 不在可选之列。
    assert.deepEqual(await menuSections(page), [
      { vendor: 'OpenAI', models: [{ label: 'gpt-image-2', hint: 'group-a分组', checked: true }] },
      { vendor: 'Gemini', models: [{ label: 'gemini-3.1-flash-image', hint: 'group-a分组', checked: false }] },
      { vendor: 'Grok', models: [{ label: 'grok-imagine-image', hint: 'group-b分组', checked: false }] },
    ])
    assert.equal(await page.getByTestId('chat-image-quality').textContent(), '画质：低')
    await pickChoice(page, 'chat-image-quality', '画质', '高')
    assert.equal(await page.getByTestId('chat-image-quality').textContent(), '画质：高')
    await pickChoice(page, 'chat-image-resolution', '分辨率', '2K')
    assert.equal(await page.getByTestId('chat-image-resolution').textContent(), '分辨率：2K')
    assert.equal(await page.getByTestId('chat-cost-note').textContent(), '按实际用量计费。')
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

// 图片文件在外面被删了（D37）：预览、复制、另存都照实说图不在电脑上了，不再叫客户重试——怎么重试都不会成。
test('says the picture is gone from the computer, instead of asking to retry, when its file was removed outside the app', async () => {
  const gone = '这张图已经不在电脑上了，可能被移走或删掉了。'
  const page = await open('assetGone=1')
  try {
    await ready(page)
    await allPrepared(page)
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).click()
    const request = await send(page, 'A test scene')
    await page.evaluate((id) => window.chatHarness.completeImage(id), request.requestId)
    const preview = page.locator('.chat-asset-preview img[data-failed="true"]')
    await preview.waitFor()
    assert.equal(await preview.getAttribute('alt'), gone)
    const shown = page.locator('.chat-banner[data-tone="bad"] > span')
    await page.getByTestId('chat-asset-copy').click()
    await shown.waitFor()
    assert.equal(await shown.innerText(), gone)
    await page.getByRole('button', { name: '关闭提示' }).click()
    await shown.waitFor({ state: 'detached' })
    await page.getByTestId('chat-asset-save').click()
    await shown.waitFor()
    assert.equal(await shown.innerText(), gone)
    assert.equal(await page.getByText(/可以重试|请稍后重试/).count(), 0)
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
    // 滑块从「默认」起步，一动就有值：从 1 往左三格是 0.7。
    const temperature = page.getByTestId('chat-parameter-temperature')
    await temperature.focus()
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowLeft')
    assert.equal(await temperature.inputValue(), '0.7')
    await page.getByTestId('chat-parameter-maxTokens').fill('2048')
    await page.getByTestId('chat-system-prompt').fill('Be precise')
    await page.getByTestId('chat-parameters-apply').click()
    await page.getByTestId('chat-parameters').waitFor({ state: 'detached' })
    await waitForToast(page, '参数已应用到当前对话')
    const request = await send(page, 'test message')
    assert.deepEqual(request.parameters, { temperature: .7, maxTokens: 2048 })
    assert.deepEqual(request.messages[0], { role: 'system', content: 'Be precise' })
    await emit(page, { type: 'content', requestId: request.requestId, content: 'copy me' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.locator('.chat-message[data-role=assistant]').getByRole('button', { name: '复制回答', exact: true }).click()
    await page.getByTestId('chat-copy-fallback').waitFor()
    assert.equal(await page.getByTestId('chat-copy-fallback').getByRole('textbox').inputValue(), 'copy me')
  } finally { await page.close() }
})

test('each code block copies only its own text and inline code gets no button', async () => {
  const page = await open()
  try {
    const request = await send(page, 'how to install')
    await emit(page, { type: 'content', requestId: request.requestId, content: 'Run `npm` like this:\n\n```powershell\nnpm install -g demo\n```\n\nThen check:\n\n```\ndemo --version\n```\n' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    const assistant = page.locator('.chat-message[data-role=assistant]')
    const buttons = assistant.getByTestId('chat-code-copy')
    assert.equal(await buttons.count(), 2)
    // 代码块头上写语言；没写语言的就叫「代码」。
    assert.deepEqual(await assistant.locator('.chat-code-head > span').allTextContents(), ['powershell', '代码'])
    await buttons.first().click()
    await page.waitForFunction(() => document.querySelector('[data-testid=chat-code-copy]')?.textContent?.trim() === '已复制')
    assert.equal(await page.evaluate(() => window.__copied), 'npm install -g demo')
    await waitForToast(page, '代码已复制')
    await buttons.nth(1).click()
    await page.waitForFunction(() => window.__copied === 'demo --version')
    await page.waitForFunction(() => document.querySelector('[data-testid=chat-code-copy]')?.textContent?.trim() === '复制', undefined, { timeout: 5000 })
  } finally { await page.close() }
})

test('formulas in replies render as math while money, code and the user message stay as written', async () => {
  const page = await open('copyFail=1')
  try {
    const request = await send(page, 'what is $x^2$')
    const reply = '面积是 $\\frac{a}{b}$，余额只剩 $5，充 $10。\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n写错的 $\\frac{a$ 保留。\n\n```\necho $HOME$\n```'
    await emit(page, { type: 'content', requestId: request.requestId, content: reply })
    await emit(page, { type: 'complete', requestId: request.requestId })
    const assistant = page.locator('.chat-message[data-role=assistant]')
    await assistant.locator('math').first().waitFor()
    assert.equal(await assistant.locator('.chat-math math').count(), 2)
    assert.equal(await assistant.locator('.chat-math-block math[display=block]').count(), 1)
    assert.ok(await assistant.locator('mfrac').count() >= 1)
    assert.match((await assistant.locator('.chat-bubble').textContent()) ?? '', /余额只剩 \$5，充 \$10/)
    const broken = assistant.locator('.chat-math-raw')
    assert.equal((await broken.textContent())?.trim(), '$\\frac{a$')
    assert.equal(await broken.getAttribute('title'), '这个公式没能显示，保留原文')
    const size = await assistant.locator('.chat-math-block').evaluate((element) => element.getBoundingClientRect().height)
    assert.ok(size > 20, `display formula should be laid out as math, got ${size}px`)
    await assistant.getByTestId('chat-code-copy').click()
    await page.getByTestId('chat-copy-fallback').waitFor()
    assert.equal(await page.getByTestId('chat-copy-fallback').getByRole('textbox').inputValue(), 'echo $HOME$')
    await page.getByLabel('关闭', { exact: true }).click()
    await page.getByTestId('chat-copy-fallback').waitFor({ state: 'detached' })
    await assistant.getByRole('button', { name: '复制回答', exact: true }).click()
    await page.getByTestId('chat-copy-fallback').waitFor()
    assert.equal(await page.getByTestId('chat-copy-fallback').getByRole('textbox').inputValue(), reply)
    const user = page.locator('.chat-message[data-role=user]')
    assert.equal(await user.locator('math').count(), 0)
    assert.match((await user.textContent()) ?? '', /what is \$x\^2\$/)
  } finally { await page.close() }
})

test('code block copy falls back to manual copy when the clipboard is unavailable', async () => {
  const page = await open('copyFail=1')
  try {
    const request = await send(page, 'command please')
    await emit(page, { type: 'content', requestId: request.requestId, content: '```\necho hi\n```' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByTestId('chat-code-copy').click()
    await page.getByTestId('chat-copy-fallback').waitFor()
    assert.equal(await page.getByTestId('chat-copy-fallback').getByRole('textbox').inputValue(), 'echo hi')
    assert.equal((await page.getByTestId('chat-code-copy').textContent())?.trim(), '复制')
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
    await waitSaved(page, (workspace) => JSON.stringify(workspace).includes('unsent local draft'))
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
    await page.waitForFunction(() => document.querySelector('[data-testid=page-chat]')?.getAttribute('data-account-scope') === 'xm-account:8')
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

test('opening the model menu refreshes the group list, reads only a newly added group and keeps the draft and model; 刷新模型 reads every group again', async () => {
  const page = await open('preferredGroup=1')
  try {
    await ready(page)
    await allPrepared(page)
    await pickModel(page, 'other-model')
    await page.getByTestId('chat-composer-input').fill('keep this unsent draft')
    const before = (await calls(page, 'groups')).length
    const prepared = (await calls(page, 'prepare')).length
    await page.evaluate(() => {
      window.chatHarness.setGroups(['default', 'GPT', 'new-live-group'])
      window.chatHarness.deferGroupList()
    })
    const menu = await modelMenu(page)
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'groups').length > count, before)
    assert.equal((await calls(page, 'groups')).length, before + 1)
    assert.equal(await menu.isVisible(), true, 'background refresh must leave the open menu in place')
    assert.equal(await page.getByTestId('chat-model').isDisabled(), false)
    await page.evaluate(() => window.chatHarness.releaseGroupList())
    // 账号多了一个分组：只读这一个（这时给它签对话密钥），原来那两个不再读一遍。
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'prepare').length > count, prepared)
    await allPrepared(page)
    assert.deepEqual(await preparedGroups(page, prepared), ['new-live-group'])
    assert.deepEqual(await picked(page), { group: 'GPT', model: 'other-model', label: 'other-model' })
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'keep this unsent draft')
    assert.equal((await calls(page, 'start')).length + (await calls(page, 'image')).length, 0)
    // 菜单底部的「刷新模型」把每个分组的模型都再读一遍，菜单不关。
    await menu.getByTestId('chat-group-prepare').click()
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'prepare').length >= count + 4, prepared)
    assert.deepEqual((await preparedGroups(page, prepared + 1)).sort(), ['GPT', 'default', 'new-live-group'])
    await waitForToast(page, '已刷新：有 2 个模型可用')
    assert.equal(await menu.isVisible(), true)
    assert.equal((await picked(page)).model, 'other-model')
  } finally { await page.close() }
})

test('when the group of the current model goes away the model stays named and send and retry wait until the user picks another model', async () => {
  const page = await open()
  try {
    const request = await send(page, 'saved question')
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByTestId('chat-composer-input').fill('draft after revoked group')
    const prepared = (await calls(page, 'prepare')).length
    await page.evaluate(() => { window.chatHarness.setGroups(['group-b']); window.dispatchEvent(new Event('focus')) })
    await page.getByTestId('chat-group-unavailable').waitFor()
    assert.equal(await page.getByTestId('chat-group-unavailable').textContent(), '当前模型已不可用，请换一个模型。已保存的消息和草稿继续保留。')
    // 后台刷新不悄悄换模型：按钮上照旧写着 gpt-test，菜单里只剩还在的分组的模型。
    assert.deepEqual(await picked(page), { group: 'group-a', model: 'gpt-test', label: 'gpt-test' })
    assert.deepEqual(await menuSections(page), [{ vendor: '其他', models: [{ label: 'other-model', hint: 'group-b分组', checked: false }] }])
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '重新生成', exact: true }).isDisabled(), true)
    await page.getByTestId('chat-composer-input').press('Enter')
    assert.equal((await calls(page, 'start')).length, 1)
    // Enter follows the greyed-out send button: nothing is sent and no red line blames the group.
    assert.equal(await page.locator('.chat-banner').count(), 0)
    assert.equal((await calls(page, 'prepare')).length, prepared)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'draft after revoked group')
    assert.equal(await page.locator('.chat-message[data-role="user"]').getByText('saved question', { exact: true }).count(), 1)
    await pickModel(page, 'other-model')
    await ready(page)
    assert.deepEqual(await picked(page), { group: 'group-b', model: 'other-model', label: 'other-model' })
    assert.equal(await page.getByTestId('chat-group-unavailable').count(), 0)
    assert.equal(await page.getByTestId('chat-send').isDisabled(), false)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'draft after revoked group')
  } finally { await page.close() }
})

test('a remembered group the site has since removed falls back to the recommended one and says the billing group changed', async () => {
  const state = storedWorkspace()
  state.conversations[0].settings = { ...state.conversations[0].settings, group: 'retired-group' }
  const page = await open('', { [storedChatKey]: JSON.stringify(state) })
  try {
    await ready(page)
    assert.equal((await picked(page)).group, 'group-a')
    assert.equal(await page.locator('.chat-banner[data-tone="neutral"] > span').innerText(), '原来的分组「retired-group」已不可用，已换成「group-a」，之后按「group-a」分组计费。')
    assert.equal(await page.getByTestId('chat-group-unavailable').count(), 0)
    await page.getByTestId('chat-composer-input').fill('asked in the new group')
    await page.getByTestId('chat-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start'))
    assert.equal((await calls(page, 'start')).at(-1).input.group, 'group-a')
    assert.equal(await page.locator('.chat-banner').count(), 0)
  } finally { await page.close() }
})

test('regenerating before the group has its models says they are still being prepared', async () => {
  const state = storedWorkspace()
  state.conversations[0].messages = [
    { id: 'saved-question', role: 'user', content: 'saved question', reasoning: '', status: 'complete', createdAt: 1 },
    { id: 'saved-answer', role: 'assistant', content: 'saved answer', reasoning: '', status: 'complete', createdAt: 2 },
  ]
  const page = await open('deferPreparation=1', { [storedChatKey]: JSON.stringify(state) })
  try {
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'prepare'))
    await page.getByRole('button', { name: '重新生成', exact: true }).click()
    await page.getByTestId('chat-confirm').getByRole('button', { name: '重新生成', exact: true }).click()
    assert.equal(await page.locator('.chat-banner > span').innerText(), '正在准备模型，准备好再发送')
    assert.equal((await calls(page, 'start')).length, 0)
  } finally { await page.close() }
})

test('focus and reactivation refresh groups without polling, and only a newly added group is read', async () => {
  const page = await open()
  try {
    await ready(page)
    await allPrepared(page)
    await page.clock.install()
    await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true }))
    await page.getByTestId('chat-composer-input').fill('persistent draft')
    const prepared = (await calls(page, 'prepare')).length
    const listed = (await calls(page, 'groups')).length
    await page.evaluate(() => { window.chatHarness.setGroups(['group-a', 'focus-group']); window.dispatchEvent(new Event('focus')) })
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'groups').length > count, listed)
    await page.evaluate(() => window.chatHarness.setActive(false))
    await page.getByTestId('page-chat').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.querySelector('[data-testid="page-chat"]').hidden)
    const inactive = (await calls(page, 'groups')).length
    await page.clock.fastForward(31000)
    assert.equal((await calls(page, 'groups')).length, inactive)
    await page.evaluate(() => { window.chatHarness.setGroups(['group-a', 'reactivated-group']); window.chatHarness.setActive(true) })
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'groups').length > count, inactive)
    const reactivated = (await calls(page, 'groups')).length
    await page.clock.fastForward(10 * 60_000)
    assert.equal((await calls(page, 'groups')).length, reactivated, 'a visible, focused chat page must not poll the group list')
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
    const hidden = (await calls(page, 'groups')).length
    await page.clock.fastForward(31000)
    assert.equal((await calls(page, 'groups')).length, hidden)
    await page.evaluate(() => {
      window.chatHarness.setGroups(['group-a', 'visible-group'])
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'groups').length > count, hidden)
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'prepare').length >= count + 3, prepared)
    // group-a 一直在，不再读；每次新冒出来的分组各读一次。
    assert.deepEqual(await preparedGroups(page, prepared), ['focus-group', 'reactivated-group', 'visible-group'])
    assert.equal((await calls(page, 'start')).length + (await calls(page, 'image')).length, 0)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'persistent draft')
  } finally { await page.close() }
})

test('a background list failure retains existing options and model while exposing an explicit retry', async () => {
  const page = await open()
  try {
    await ready(page)
    await allPrepared(page)
    await page.getByTestId('chat-composer-input').fill('offline draft')
    const prepared = (await calls(page, 'prepare')).length
    await page.evaluate(() => { window.chatHarness.failGroupList(); window.dispatchEvent(new Event('focus')) })
    await page.getByTestId('chat-groups-retry').waitFor()
    assert.deepEqual(await picked(page), { group: 'group-a', model: 'gpt-test', label: 'gpt-test' })
    assert.equal(await page.getByTestId('chat-model').isDisabled(), false)
    await page.evaluate(() => { window.chatHarness.resetGroupFailure(); window.chatHarness.setGroups(['group-a', 'recovered-group']) })
    await page.getByTestId('chat-groups-retry').click()
    await page.getByTestId('chat-groups-retry').waitFor({ state: 'detached' })
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'prepare').length > count, prepared)
    await allPrepared(page)
    assert.deepEqual(await preparedGroups(page, prepared), ['recovered-group'])
    assert.deepEqual(await menuSections(page), [
      { vendor: 'OpenAI', models: [{ label: 'gpt-test', hint: 'group-a分组', checked: true }] },
      { vendor: 'Claude', models: [{ label: 'claude-test', hint: 'group-a分组', checked: false }] },
      { vendor: '其他', models: [{ label: 'other-model', hint: 'recovered-group分组', checked: false }] },
    ])
    assert.deepEqual(await picked(page), { group: 'group-a', model: 'gpt-test', label: 'gpt-test' })
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'offline draft')
  } finally { await page.close() }
})

test('groups granted after an empty initial list are read on the next refresh and their models offered', async () => {
  const page = await open('emptyGroups=1')
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-model"] .chat-model-name')?.textContent === '暂无可用模型')
    assert.deepEqual(await menuSections(page), [{ vendor: '模型', models: [] }])
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
    await page.getByTestId('chat-composer-input').fill('draft before access granted')
    await page.evaluate(() => { window.chatHarness.setGroups(['group-a']); window.dispatchEvent(new Event('focus')) })
    await ready(page)
    await allPrepared(page)
    assert.deepEqual(await preparedGroups(page), ['group-a'])
    assert.deepEqual(await picked(page), { group: 'group-a', model: 'gpt-test', label: 'gpt-test' })
    assert.equal(await page.getByTestId('chat-send').isDisabled(), false)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'draft before access granted')
  } finally { await page.close() }
})

test('a group whose models were not read is mentioned under the composer, and 刷新模型 brings its models back', async () => {
  const page = await open('prepareFail=group-b')
  try {
    await ready(page)
    await allPrepared(page)
    assert.equal(await page.getByTestId('chat-groups-partly-failed').textContent(), '有几个分组的模型没读到，可以点模型菜单里的「刷新模型」再试。')
    const menu = await modelMenu(page)
    assert.deepEqual((await vendorSections(menu)).map((section) => section.vendor), ['OpenAI', 'Claude'])
    await page.evaluate(() => window.chatHarness.failPreparation(null))
    const prepared = (await calls(page, 'prepare')).length
    await menu.getByTestId('chat-group-prepare').click()
    await page.waitForFunction((count) => window.chatHarness.calls.filter((entry) => entry.method === 'prepare').length >= count + 2, prepared)
    await waitForToast(page, '已刷新：有 3 个模型可用')
    assert.deepEqual((await vendorSections(menu)).map((section) => section.vendor), ['OpenAI', 'Claude', '其他'])
    assert.equal(await page.getByTestId('chat-groups-partly-failed').count(), 0)
    assert.deepEqual(await picked(page), { group: 'group-a', model: 'gpt-test', label: 'gpt-test' })
  } finally { await page.close() }
})

test('when no group has its models read the menu says to refresh and nothing can be sent', async () => {
  const page = await open('prepareFail=all')
  try {
    await allPrepared(page)
    assert.equal((await picked(page)).label, '暂无可用模型')
    const menu = await modelMenu(page)
    assert.equal(await menu.locator('.xm-menu-empty').textContent(), '没读到模型，点「刷新模型」再试')
    await closeMenu(page, menu)
    assert.equal(await page.locator('.chat-composer .chat-message-error').count(), 1)
    await page.getByTestId('chat-composer-input').fill('cannot go out yet')
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
    assert.equal(await page.getByTestId('chat-groups-partly-failed').count(), 0)
  } finally { await page.close() }
})

test('hidden chat keeps its request and drafts', async () => {
  const page = await open()
  try {
    const request = await send(page, 'background request')
    await page.getByTestId('chat-composer-input').fill('next draft')
    assert.equal(await page.getByTestId('chat-stop').count(), 1)
    await page.evaluate(() => window.chatHarness.setActive(false))
    await page.getByTestId('page-chat').waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('page-chat').isVisible(), false)
    assert.equal((await calls(page, 'cancel')).length, 0)
    await emit(page, { type: 'content', requestId: request.requestId, content: 'background result' })
    await emit(page, { type: 'complete', requestId: request.requestId })
    await page.getByTestId('chat-send').waitFor({ state: 'attached' })
    await page.getByTestId('chat-composer-input').dispatchEvent('keydown', { key: 'Enter', bubbles: true })
    assert.equal((await calls(page, 'start')).length, 1)
    await page.evaluate(() => window.chatHarness.setActive(true))
    await page.getByTestId('page-chat').waitFor({ state: 'visible' })
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
    await page.getByTestId('page-chat').waitFor({ state: 'hidden' })
    assert.equal(await page.locator(':popover-open').count(), 0)
    assert.equal(await page.locator('dialog[open]').count(), 0)
    await page.evaluate(() => window.chatHarness.setActive(true))
    await page.getByTestId('page-chat').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('chat-parameters').count(), 0, 'the parameters dialog does not come back on its own')
    await page.getByTestId('chat-model').click()
    await page.getByRole('menu', { name: '模型', exact: true }).waitFor()
    await page.evaluate(() => window.chatHarness.setActive(false))
    await page.getByTestId('page-chat').waitFor({ state: 'hidden' })
    assert.equal(await page.locator(':popover-open').count(), 0)
    await page.evaluate(() => window.chatHarness.setActive(true))
    await page.getByTestId('page-chat').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '编辑后重新发送', exact: true }).click()
    await page.getByTestId('chat-edit-input').fill('preserved edited draft')
    await page.evaluate(() => window.chatHarness.setActive(false))
    await page.getByTestId('page-chat').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('dialog[open]').count(), 0)
    await page.evaluate(() => window.chatHarness.setActive(true))
    await page.getByTestId('page-chat').waitFor({ state: 'visible' })
    await page.getByTestId('chat-edit-dialog').waitFor()
    assert.equal(await page.getByTestId('chat-edit-input').inputValue(), 'preserved edited draft')
  } finally { await page.close() }
})

test('default, empty and failed chat surfaces fit the fixed desktop content frame', async () => {
  for (const theme of ['light', 'dark']) for (const os of ['win', 'mac']) for (const mode of ['default', 'empty', 'failed']) {
    const page = await open(`theme=${theme}&os=${os}${mode === 'failed' ? '&groupFail=1' : ''}`)
    try {
      assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), undefined)
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


test('Sub2API opens with its Codex_pro group and gpt-5.6-sol model', async () => {
  const page = await open('sub2api=1&preferredGroup=1')
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-model"]')?.dataset.group === 'Codex_pro')
    await ready(page)
    assert.equal((await picked(page)).model, 'gpt-5.6-sol')
  } finally { await page.close() }
})

test('generating an image takes reference pictures and a generated one to keep editing, only with a model that edits', async () => {
  const page = await open()
  try {
    await ready(page)
    await allPrepared(page)
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).click()
    assert.equal((await picked(page)).model, 'gpt-image-2')
    const attach = page.getByTestId('chat-attach-image')
    assert.equal(await attach.getAttribute('title'), '加参考图（也可以直接粘贴截图）')
    await attach.click()
    await page.locator('.chat-draft-image').first().waitFor()
    assert.equal(await page.getByTestId('chat-cost-note').textContent(), '按实际用量计费，带参考图的会更贵一些。')
    // 光有参考图不够，要写上怎么改。
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
    await page.getByTestId('chat-composer-input').fill('把背景换成海边')
    await page.getByTestId('chat-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'image'))
    const request = (await calls(page, 'image')).at(-1).input
    assert.equal((await calls(page, 'pick-images')).length, 1)
    // 加进来的图只以主进程给的编号发出去。
    assert.equal(request.sourceAssetIds.length, 1)
    assert.match(request.sourceAssetIds[0], /^p0+\d+$/)
    assert.equal(await page.locator('[data-role="user"] .chat-asset-preview').count(), 1)
    await page.evaluate((id) => window.chatHarness.completeImage(id), request.requestId)
    await page.getByRole('button', { name: '查看生成图片' }).waitFor()
    // 用户自己发的参考图上没有「拿这张接着改」，生成的图上有。
    assert.equal(await page.locator('[data-role="user"]').getByTestId('chat-asset-reuse').count(), 0)
    // 切回文本对话再点它：回到「生成图片」，这张图放进输入框当参考图。
    await page.getByTestId('chat-mode').getByRole('button', { name: '文本对话' }).click()
    await page.locator('[data-role="assistant"]').getByTestId('chat-asset-reuse').click()
    await page.locator('.chat-draft-image').first().waitFor()
    assert.equal(await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).getAttribute('aria-pressed'), 'true')
    await page.getByTestId('chat-composer-input').fill('再加一只海鸥')
    await page.getByTestId('chat-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.filter((item) => item.method === 'image').length === 2)
    const second = (await calls(page, 'image')).at(-1).input
    assert.deepEqual(second.sourceAssetIds, ['a'.repeat(43)])
    await page.evaluate((id) => window.chatHarness.completeImage(id), second.requestId)
    // 换成不能改图的模型：参考图留着，说清楚为什么发不了。
    await page.locator('[data-role="assistant"]').getByTestId('chat-asset-reuse').first().click()
    await page.locator('.chat-draft-image').first().waitFor()
    await pickModel(page, 'gemini-3.1-flash-image')
    assert.equal(await page.getByTestId('chat-images-unsupported').textContent(), '这个模型不能照着图片改，请换一个能改图的模型，或者先把图片去掉')
    assert.equal(await attach.getAttribute('title'), '这个模型不能照着图片改，换一个能改图的模型才能加图片')
    await page.getByTestId('chat-composer-input').fill('还是那张图')
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
    await page.getByTestId('chat-draft-image-remove').click()
    assert.equal(await page.getByTestId('chat-send').isDisabled(), false)
  } finally { await page.close() }
})

test('a model that reads images takes picked and pasted screenshots and sends them as references', async () => {
  const page = await open()
  try {
    await ready(page)
    assert.equal(await page.getByTestId('chat-attach-image').isDisabled(), true, 'gpt-test cannot read images')
    await pickModel(page, 'claude-test')
    await page.getByTestId('chat-attach-image').click()
    await page.locator('.chat-draft-image').first().waitFor()
    assert.deepEqual((await calls(page, 'pick-images')).map((call) => call.input), [4])
    await page.getByTestId('chat-composer-input').evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.waitForFunction(() => document.querySelectorAll('.chat-draft-image').length === 2)
    assert.equal((await calls(page, 'paste-image')).length, 1)
    assert.equal(await page.getByTestId('chat-cost-note').textContent(), '按实际用量计费，带图片的提问会更贵一些。')
    assert.equal(await page.getByTestId('chat-send').isDisabled(), false, 'images alone are enough to send')
    await page.getByTestId('chat-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start'))
    const request = (await calls(page, 'start')).at(-1).input
    assert.equal(request.messages.at(-1).role, 'user')
    assert.equal(request.messages.at(-1).images.length, 2)
    assert.equal(await page.locator('.chat-draft-image').count(), 0)
    await page.locator('[data-role="user"] .chat-asset-preview').first().waitFor()
    await emit(page, { type: 'complete', requestId: request.requestId })
    await waitSaved(page, (workspace) => workspace.conversations[0]?.messages[0]?.assets?.length === 2)

    await pickModel(page, 'gpt-test')
    await page.getByTestId('chat-composer-input').evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.getByText('当前模型看不了图片').first().waitFor()
    assert.equal((await calls(page, 'paste-image')).length, 1, 'a model that cannot read images never reads the clipboard')
  } finally { await page.close() }
})

test('text files picked in a text conversation go out with the message and stay on its card after a reload', async () => {
  const page = await open()
  try {
    await ready(page)
    await page.evaluate(() => window.chatHarness.queueTextFiles([{ name: '报错日志.txt', size: 12_288, text: 'Error: boom', truncated: false }, { name: 'big.log', size: 9_000_000, text: 'x'.repeat(12_000), truncated: true }]))
    await page.getByTestId('chat-attach-file').click()
    await page.getByTestId('chat-draft-files').waitFor()
    assert.deepEqual((await calls(page, 'pick-text-files')).map((call) => call.input), [{ remainingFiles: 3, remainingChars: 30_000 }])
    assert.deepEqual(await page.locator('[data-testid=chat-draft-files] .chat-file').evaluateAll((cards) => cards.map((card) => card.textContent)), ['报错日志.txt· 12 KB', 'big.log· 8.6 MB · 只读了前 12,000 字'])
    await page.getByText('「big.log」太长，只读了前 12,000 个字。').waitFor()
    // Removing the long one and picking again asks only for what is left.
    await page.getByTestId('chat-draft-file-remove').nth(1).click()
    await page.evaluate(() => window.chatHarness.queueTextFiles('Error: 这个文件读不出来，可能正被别的软件占着，关掉它再试。'))
    await page.getByTestId('chat-attach-file').click()
    await page.getByText('这个文件读不出来，可能正被别的软件占着，关掉它再试。').waitFor()
    assert.deepEqual((await calls(page, 'pick-text-files')).at(-1).input, { remainingFiles: 2, remainingChars: 30_000 - 'Error: boom'.length })
    assert.equal(await page.locator('[data-testid=chat-draft-files] .chat-file').count(), 1)

    // A file alone is enough to send, and goes ahead of nothing.
    assert.equal(await page.getByTestId('chat-send').isDisabled(), false)
    await page.getByTestId('chat-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start'))
    const request = (await calls(page, 'start')).at(-1).input
    assert.deepEqual(request.messages.at(-1), { role: 'user', content: '<file name="报错日志.txt">\nError: boom\n</file>' })
    assert.equal(await page.getByTestId('chat-draft-files').count(), 0)
    await page.locator('[data-role="user"] [data-testid=chat-message-files] .chat-file').waitFor()
    await emit(page, { type: 'complete', requestId: request.requestId })
    await waitSaved(page, (workspace) => workspace.conversations[0]?.messages[0]?.files?.[0]?.name === '报错日志.txt')
    await page.reload()
    await page.locator('[data-role="user"] [data-testid=chat-message-files] .chat-file').waitFor()

    // Generating an image takes no files: the button goes and a file left in the draft blocks sending.
    await page.evaluate(() => window.chatHarness.queueTextFiles([{ name: 'a.txt', size: 3, text: 'abc', truncated: false }]))
    await ready(page)
    await page.getByTestId('chat-attach-file').click()
    await page.getByTestId('chat-draft-files').waitFor()
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片' }).click()
    assert.equal(await page.getByTestId('chat-attach-file').count(), 0)
    await page.getByTestId('chat-files-image-mode').waitFor()
    await page.getByTestId('chat-composer-input').fill('一只猫')
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
  } finally { await page.close() }
})

test('a paste past 40000 characters keeps its tail, says how long it is under the composer counting picked files, and greys out sending until it is cut down', async () => {
  const page = await open()
  try {
    await ready(page)
    const input = page.getByTestId('chat-composer-input')
    // A picked file counts toward the limit too, the same way the message is put together when it goes out.
    const attached = { name: 'a.txt', size: 30_000, text: 'f'.repeat(30_000), truncated: false }
    await page.evaluate((file) => window.chatHarness.queueTextFiles([file]), attached)
    await page.getByTestId('chat-attach-file').click()
    await page.getByTestId('chat-draft-files').waitFor()
    const typed = 'y'.repeat(10_000)
    await input.fill(typed)
    const together = `<file name="a.txt">\n${attached.text}\n</file>\n\n${typed}`.length
    assert.ok(together > 40000 && typed.length < 40000)
    assert.equal(await page.getByTestId('chat-draft-too-long').textContent(), `最多 40000 字，现在 ${together} 字，删掉一些再发。`)
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
    await page.getByTestId('chat-draft-file-remove').click()
    assert.equal(await page.getByTestId('chat-draft-too-long').count(), 0)
    assert.equal(await page.getByTestId('chat-send').isDisabled(), false)
    await input.fill('')
    // An error log whose last line is the one that matters (D42): it used to be cut off silently.
    const log = 'x'.repeat(44990) + '\n最后一行才是真正的报错'
    await input.focus()
    await page.keyboard.insertText(log)
    assert.equal(await input.inputValue(), log, 'nothing is cut off the end')
    const notice = page.getByTestId('chat-draft-too-long')
    assert.equal(await notice.textContent(), `最多 40000 字，现在 ${log.length} 字，删掉一些再发。`)
    assert.equal(await input.getAttribute('aria-describedby'), await notice.getAttribute('id'))
    assert.equal(await page.getByTestId('chat-send').isDisabled(), true)
    await input.press('Enter')
    await page.getByTestId('chat-send').click({ force: true })
    assert.equal((await calls(page, 'start')).length, 0, 'neither Enter nor the greyed button sends it')
    assert.equal(await page.locator('.chat-banner').count(), 0, 'no red bar on top of the sentence under the composer')
    await input.fill(log.slice(-40000))
    assert.equal(await notice.count(), 0)
    assert.equal(await input.getAttribute('aria-describedby'), null)
    await page.getByTestId('chat-send').click()
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start'))
    const sent = (await calls(page, 'start'))[0].input
    assert.equal(sent.messages.at(-1).content, log.slice(-40000))
    await emit(page, { type: 'content', requestId: sent.requestId, content: 'answer' })
    await emit(page, { type: 'complete', requestId: sent.requestId })
    // Editing a sent message and sending it again has the same limit, said the same way under its box.
    await page.getByRole('button', { name: '编辑后重新发送', exact: true }).click()
    const edit = page.getByTestId('chat-edit-input')
    await edit.fill('')
    await page.keyboard.insertText(log)
    assert.equal(await edit.inputValue(), log)
    assert.equal(await page.getByTestId('chat-edit-dialog').getByRole('alert').textContent(), `最多 40000 字，现在 ${log.length} 字，删掉一些再发。`)
    assert.equal(await page.getByTestId('chat-edit-send').isDisabled(), true)
    await edit.fill('shorter question')
    assert.equal(await page.getByTestId('chat-edit-dialog').getByRole('alert').count(), 0)
    assert.equal(await page.getByTestId('chat-edit-send').isDisabled(), false)
  } finally { await page.close() }
})

// Excel and WPS copy cells as text plus a picture of the table. The composer
// used to take every such paste as a screenshot and drop the text.
test('pasting spreadsheet cells keeps the text instead of reading a screenshot', async () => {
  const page = await open()
  try {
    await ready(page)
    function pasteCells(element) {
      const data = new DataTransfer()
      data.setData('text/plain', '姓名\t金额\n张三\t12\n')
      data.setData('text/html', '<table><tr><td>姓名</td><td>金额</td></tr></table>')
      data.items.add(new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }))
      return element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }
    // A synthetic paste never inserts text, so "not cancelled" is what shows the browser keeps its own paste.
    assert.equal(await page.getByTestId('chat-composer-input').evaluate(pasteCells), true, 'a model that cannot read images still gets the text')
    assert.equal(await page.getByText('当前模型看不了图片').count(), 0)
    await pickModel(page, 'claude-test')
    assert.equal(await page.getByTestId('chat-composer-input').evaluate(pasteCells), true, 'a model that reads images still gets the text, not a picture of it')
    assert.equal((await calls(page, 'paste-image')).length, 0)
    assert.equal(await page.locator('.chat-draft-image').count(), 0)
  } finally { await page.close() }
})

// A long conversation used to re-parse every message's markdown on each key
// typed into the composer. Counting renders instead of timing them keeps this
// steady on a slow runner: React's development build stamps actualStartTime on
// every fiber that runs in a commit, so a row that skipped leaves no stamp.
test('typing in the composer does not re-render the markdown of existing messages', async () => {
  const state = storedWorkspace()
  state.conversations[0].messages = Array.from({ length: 40 }, (_, index) => index % 2
    ? { id: `m${index}`, role: 'assistant', content: `**回复 ${index}**\n\n- 一\n- 二\n\n\`\`\`bash\necho ${index}\n\`\`\``, reasoning: '', status: 'complete', createdAt: index }
    : { id: `m${index}`, role: 'user', content: `问题 ${index}`, status: 'complete', createdAt: index })
  const page = await open('', { [storedChatKey]: JSON.stringify(state) }, () => {
    window.__markdownRenders = 0
    let lastCommit = 0
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject: () => 1, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id, root) {
        const stack = [root.current]
        while (stack.length) {
          const fiber = stack.pop()
          if (typeof fiber.type === 'function' && fiber.type.name === 'Markdown' && fiber.actualStartTime > lastCommit) window.__markdownRenders++
          if (fiber.sibling) stack.push(fiber.sibling)
          if (fiber.child) stack.push(fiber.child)
        }
        lastCommit = performance.now()
      } }
  })
  try {
    await page.getByTestId('chat-message-m39').waitFor()
    assert.ok(await page.evaluate(() => window.__markdownRenders) >= 40, 'the probe sees the rows render when they mount')
    const before = await page.evaluate(() => window.__markdownRenders)
    await page.getByTestId('chat-composer-input').pressSequentially('打字不卡')
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), '打字不卡')
    assert.equal(await page.evaluate(() => window.__markdownRenders) - before, 0)
  } finally { await page.close() }
})

test('an empty chat says where conversations go, and its examples only fill the composer', async () => {
  const page = await open()
  try {
    await ready(page)
    assert.equal(await page.getByTestId('chat-conversation-empty').textContent(), '聊过的对话会存在这里')
    assert.equal(await page.getByText('还没有对话', { exact: true }).count(), 0)
    const empty = page.getByTestId('chat-empty')
    await empty.getByRole('heading', { name: '有什么想问的？', exact: true }).waitFor()
    await empty.getByText('不开终端，直接和模型对话。额度与工具共用同一个账号。', { exact: true }).waitFor()
    assert.deepEqual(await empty.getByRole('button').allTextContents(), ['帮我把这段话改得更通顺', '把下面的内容翻译成英文', '帮我写一条朋友圈文案，卖的是……', '这个 Excel 公式怎么写：我想……', '帮我写一个批量重命名文件的脚本', '这段报错是什么意思'])
    await page.getByTestId('chat-example-3').click()
    const input = page.getByTestId('chat-composer-input')
    // 半句话的示例填进去时不带省略号，光标在末尾，接着打就是客户自己的话。
    assert.equal(await input.inputValue(), '帮我写一条朋友圈文案，卖的是')
    assert.equal(await input.evaluate((element) => element === document.activeElement), true)
    await page.waitForFunction(() => { const element = document.querySelector('#chatIn'); return element instanceof HTMLTextAreaElement && element.selectionStart === element.value.length && element.selectionEnd === element.value.length })
    assert.equal((await calls(page, 'start')).length, 0, 'an example is never sent on its own')
    // 输入框里有字了就不再摆例句：再点一颗会把打的字换掉。
    assert.equal(await empty.getByRole('button').count(), 0)
    await input.fill('')
    await page.getByTestId('chat-mode').getByRole('button', { name: '生成图片', exact: true }).click()
    await empty.getByText('不开终端，直接和模型对话。额度与工具共用同一个账号。', { exact: true }).waitFor()
    assert.equal(await empty.getByRole('button').count(), 0, 'the examples are questions, not pictures')
  } finally { await page.close() }
})

test('saved phrases fill the composer without sending, survive a reload and can be deleted', async () => {
  const page = await open()
  try {
    await ready(page)
    const input = page.getByTestId('chat-composer-input')
    await input.fill('帮我看看这段话')
    await page.getByTestId('chat-phrases-open').click()
    const dialog = page.getByTestId('chat-phrases-dialog')
    await dialog.getByTestId('chat-phrases-empty').waitFor()
    assert.equal(await dialog.getByTestId('chat-phrases-empty').textContent(), '还没有存过常用的话。把经常要说的话存在这里，下次一点就填好。')
    // 打开时把输入框里写好的字带进来，点「存下来」就存。
    const phraseInput = dialog.getByTestId('chat-phrase-input')
    assert.equal(await phraseInput.inputValue(), '帮我看看这段话')
    await phraseInput.fill('回答尽量简短，用大白话')
    await dialog.getByTestId('chat-phrase-save').click()
    assert.equal(await phraseInput.inputValue(), '')
    assert.equal(await dialog.getByTestId('chat-phrase-save').isDisabled(), true)
    assert.deepEqual(await dialog.locator('.chat-phrase-text').allTextContents(), ['回答尽量简短，用大白话'])
    await dialog.getByTestId('chat-phrase-use').click()
    await dialog.waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.activeElement?.id === 'chatIn')
    assert.equal(await input.inputValue(), '帮我看看这段话\n回答尽量简短，用大白话')
    assert.equal(await input.evaluate((element) => element.selectionStart === element.value.length), true)
    assert.equal((await calls(page, 'start')).length, 0, 'a saved phrase is never sent on its own')
    await waitSaved(page, (workspace) => workspace.phrases?.[0] === '回答尽量简短，用大白话')

    await page.reload()
    await page.getByTestId('chat-composer-input').waitFor()
    await ready(page)
    await page.getByTestId('chat-phrases-open').click()
    const reopened = page.getByTestId('chat-phrases-dialog')
    assert.deepEqual(await reopened.locator('.chat-phrase-text').allTextContents(), ['回答尽量简短，用大白话'])
    await reopened.getByTestId('chat-phrase-remove').click()
    await reopened.getByTestId('chat-phrases-empty').waitFor()
    await waitSaved(page, (workspace) => !workspace.phrases)
    await reopened.getByTestId('chat-phrases-close').click()
    await reopened.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('history that cannot be read is left alone, and reading it again brings it back with what was said meanwhile', async () => {
  const page = await open()
  try {
    const first = await send(page, 'said before')
    await emit(page, { type: 'content', requestId: first.requestId, content: 'earlier answer' })
    await emit(page, { type: 'complete', requestId: first.requestId })
    await waitSaved(page, (workspace) => workspace.conversations[0]?.messages.length === 2)
    const before = await saved(page)
    await page.goto(`${base}/src/renderer-v2/features/chat/browser-fixture.html?historyReadFail=1`)
    await page.getByTestId('chat-composer-input').waitFor()
    const banner = page.getByRole('alert').filter({ hasText: '以前的聊天记录暂时读不出来，原文件没动。现在聊的内容不会保存，关掉软件就没了。' })
    await banner.waitFor()
    assert.equal(await page.getByTestId('chat-conversation-empty').textContent(), '以前的对话暂时读不出来')
    const meanwhile = await send(page, 'said meanwhile')
    await emit(page, { type: 'content', requestId: meanwhile.requestId, content: 'answer meanwhile' })
    await emit(page, { type: 'complete', requestId: meanwhile.requestId })
    await page.waitForTimeout(400)
    assert.deepEqual(await saved(page), before, 'nothing is written over a record that could not be read')
    // 还是读不出来：红条和按钮都留着，记录照旧不碰；读不出来的原因再提示一次，看得出确实读过了。
    await assertNoToast(page, '以前的聊天记录暂时读不出来，原文件没动')
    await page.getByTestId('chat-history-reload').click()
    await page.waitForFunction(() => window.chatHarness.calls.filter((item) => item.method === 'read-history').length === 2)
    await waitForToast(page, '以前的聊天记录暂时读不出来，原文件没动')
    await page.getByTestId('chat-history-reload').waitFor()
    await banner.waitFor()
    await page.evaluate(() => window.chatHarness.failHistoryReads(false))
    await page.getByTestId('chat-history-reload').click()
    await banner.waitFor({ state: 'detached' })
    assert.equal(await page.getByTestId('chat-history-reload').count(), 0)
    await assertNoToast(page, '以前的聊天记录暂时读不出来，原文件没动')
    assert.equal(await page.locator('.chat-conversation-select').count(), 2)
    await page.getByText('answer meanwhile', { exact: true }).waitFor()
    await waitSaved(page, (workspace) => workspace.conversations.length === 2)
    const merged = await saved(page)
    assert.deepEqual(merged.conversations.map((conversation) => conversation.messages[0].content), ['said meanwhile', 'said before'])
  } finally { await page.close() }
})

// 0.2.24 深查聊天页 C2：以前一段对话的文件坏了，整份记录读不出来，以后聊的也全都不存，「重新读取」永远读不出来。
test('one broken conversation file is set aside on its own while the rest keep loading and saving', async () => {
  const page = await open()
  try {
    for (const [index, prompt] of ['first topic', 'second topic', 'third topic'].entries()) {
      if (index) await page.getByTestId('chat-conversation-new').click()
      await ready(page)
      await page.getByTestId('chat-composer-input').fill(prompt)
      await page.getByTestId('chat-send').click()
      await page.waitForFunction((count) => window.chatHarness.calls.filter((item) => item.method === 'start').length === count, index + 1)
      const request = (await calls(page, 'start')).at(-1).input
      await emit(page, { type: 'content', requestId: request.requestId, content: `answer to ${prompt}` })
      await emit(page, { type: 'complete', requestId: request.requestId })
    }
    await waitSaved(page, (workspace) => workspace.conversations.length === 3 && workspace.conversations.every((conversation) => conversation.messages.length === 2))
    const brokenKey = await page.evaluate(() => window.chatHarness.breakConversation(1, 'truncate'))

    await page.reload()
    await page.getByTestId('chat-composer-input').waitFor()
    await page.getByRole('status').filter({ hasText: '有 1 段对话读不出来，已经单独留着，其余照常。' }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0, 'the rest still saves, so there is no red bar')
    assert.equal(await page.getByTestId('chat-history-reload').count(), 0)
    assert.equal(await page.locator('.chat-conversation-select').count(), 2)
    const logged = (await calls(page, 'log')).map((call) => call.input)
    assert.ok(logged.some((entry) => entry.context === 'chat-history' && entry.level === 'warn' && entry.message.includes(`c-${brokenKey}.json 读不出来`)), JSON.stringify(logged))

    // Saving goes on, and the broken file is moved aside exactly as it was instead of being deleted.
    await page.getByTestId('chat-composer-input').fill('typed after the broken file')
    await waitSaved(page, (workspace) => workspace.conversations.length === 2 && JSON.stringify(workspace).includes('typed after the broken file'))
    const aside = await page.evaluate(() => window.chatHarness.asideFiles())
    assert.deepEqual(aside.map((file) => file.key), [brokenKey])
    assert.throws(() => JSON.parse(aside[0].content), 'the copy kept aside is the truncated file, untouched')

    await page.reload()
    await page.getByTestId('chat-composer-input').waitFor()
    await page.locator('.chat-conversation-select').nth(1).waitFor()
    assert.equal(await page.locator('.chat-conversation-select').count(), 2)
    assert.equal(await page.getByText('读不出来', { exact: false }).count(), 0, 'once set aside it is not reported again')
  } finally { await page.close() }
})

test('the first read of the history shows the page-loading block instead of a blank page', async () => {
  const page = await open()
  try {
    await page.goto(`${base}/src/renderer-v2/features/chat/browser-fixture.html?historyReadHold=1`)
    const loading = page.getByTestId('page-chat').getByTestId('route-loading')
    await loading.waitFor()
    assert.equal(await loading.textContent(), '正在加载页面…')
    assert.equal(await page.getByTestId('page-chat').getAttribute('aria-busy'), 'true')
    assert.equal(await page.getByTestId('chat-composer-input').count(), 0, 'nothing can be typed over a record that is still being read')
    await page.evaluate(() => window.chatHarness.releaseHistoryReads())
    await page.getByTestId('chat-composer-input').waitFor()
    assert.equal(await page.getByTestId('route-loading').count(), 0)
  } finally { await page.close() }
})

test('a reply that fails before any text shows only its reason, with no empty bubble', async () => {
  const page = await open()
  try {
    const request = await send(page, 'will fail')
    await emit(page, { type: 'error', requestId: request.requestId, message: 'network error' })
    const reply = page.locator('.chat-message[data-role=assistant]')
    const reason = reply.locator('.chat-message-error')
    await reason.waitFor()
    assert.equal(await reply.locator('.chat-bubble').count(), 0)
    assert.equal(await page.locator('.chat-message[data-role=user] .chat-bubble').count(), 1)
    // 红字放在气泡的位置：和头像挨着、顶边对齐。
    const [avatar, line] = await Promise.all([reply.locator('.chat-avatar').boundingBox(), reason.boundingBox()])
    assert.ok(Math.abs(line.y - avatar.y) <= 4, `the reason sits beside the avatar (${line.y} vs ${avatar.y})`)
  } finally { await page.close() }
})

test('the composer starts one line high, grows with the text and scrolls inside past about eight lines', async () => {
  const page = await open()
  try {
    await ready(page)
    const input = page.getByTestId('chat-composer-input')
    const size = () => input.evaluate((element) => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), scrolls: element.scrollHeight > element.clientHeight }))
    const one = await size()
    assert.ok(Math.abs(one.height - (one.line + 6)) <= 1, `one line high (${one.height})`)
    await input.fill('一\n二\n三')
    assert.ok(Math.abs((await size()).height - (3 * one.line + 6)) <= 1)
    await input.fill(Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
    const full = await size()
    assert.ok(Math.abs(full.height - (8 * one.line + 6)) <= 1, `stops at eight lines (${full.height})`)
    assert.equal(full.scrolls, true)
  } finally { await page.close() }
})

test('the conversation list groups by day, finds by title and clears everything after one confirmation', async () => {
  const state = storedWorkspace()
  const settings = state.conversations[0].settings
  const noon = new Date(); noon.setHours(12, 0, 0, 0)
  const conversation = (id, title, updatedAt, messages = []) => ({ id, title, createdAt: updatedAt, updatedAt, draft: '', settings, messages })
  state.conversations = [
    conversation('today', '今天聊的', Date.now(), [{ id: 't1', role: 'user', content: '你好', status: 'complete', createdAt: 1 }, { id: 't2', role: 'assistant', content: '你好呀', reasoning: '', status: 'complete', createdAt: 2 }]),
    conversation('yesterday', '昨天聊的', noon.getTime() - 86_400_000),
    conversation('older', '很久以前聊的', noon.getTime() - 10 * 86_400_000),
  ]
  state.activeId = 'today'
  state.draftConversation.draft = '还没发出去的话'
  const page = await open('', { [storedChatKey]: JSON.stringify(state) })
  try {
    const list = page.getByRole('navigation', { name: '已保存的对话' })
    await list.getByTestId('chat-conversation-older').waitFor()
    assert.deepEqual(await list.locator('.chat-conversation-day').allTextContents(), ['今天', '昨天', '更早'])
    assert.equal(await page.getByTestId('chat-conversation-today').textContent(), '今天聊的2 条消息')
    assert.equal(await page.getByTestId('chat-conversation-older').textContent(), '很久以前聊的0 条消息')
    // 搜索框一直在，搜不到时说搜的是什么。
    await page.getByTestId('chat-conversation-search').fill('昨天')
    assert.deepEqual(await list.locator('.chat-conversation-select strong').allTextContents(), ['昨天聊的'])
    await page.getByTestId('chat-conversation-search').fill('没有这个')
    assert.equal(await page.getByTestId('chat-conversation-search-empty').textContent(), '没有找到「没有这个」相关的对话')
    await page.getByTestId('chat-conversation-search').fill('')
    await page.getByRole('button', { name: '「今天聊的」更多操作', exact: true }).click()
    const menu = page.getByRole('menu', { name: '对话操作', exact: true })
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['改名', '置顶', '导出这段对话', '删除这段对话…'])
    await menu.getByRole('menuitem', { name: '导出这段对话', exact: true }).click()
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'export-text'))
    assert.equal((await calls(page, 'export-text'))[0].input.title, '今天聊的')
    await page.getByRole('button', { name: '「昨天聊的」更多操作', exact: true }).click()
    await menu.getByRole('menuitem', { name: '删除这段对话…', exact: true }).click()
    const confirm = page.getByTestId('chat-confirm')
    await confirm.getByRole('heading', { name: '删除「昨天聊的」？', exact: true }).waitFor()
    await confirm.getByText('这段对话会从这台电脑上删掉，找不回来。已产生的用量不会改变。', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByTestId('chat-conversation-yesterday').waitFor({ state: 'detached' })
    // 页头的「导出这段对话」导出正在看的这一段。
    await page.getByTestId('chat-conversation-export').click()
    await page.waitForFunction(() => window.chatHarness.calls.filter((item) => item.method === 'export-text').length === 2)
    await page.getByTestId('chat-conversations-clear').click()
    await confirm.getByRole('heading', { name: '清空全部对话？', exact: true }).waitFor()
    await confirm.getByText('聊天记录会从这台电脑上全部删掉，找不回来。用量账单不受影响。', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: '全部清空', exact: true }).click()
    await waitForToast(page, '对话已清空')
    assert.equal(await list.locator('.chat-conversation-select').count(), 0)
    assert.equal(await page.getByTestId('chat-conversations-clear').count(), 0)
    // 没发出去的草稿也算本机记录，清空后不会再冒出来。
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), '')
    await waitSaved(page, (workspace) => workspace.conversations.length === 0 && workspace.draftConversation.draft === '' && workspace.draftConversation.settings.model === 'gpt-test')
  } finally { await page.close() }
})

// Fable 第二轮 Y2：聊多了找不到、重要的被挤下去，所以能改名、能置顶。改名不挪位置，置顶的排在最上面单独一段。
test('a conversation can be renamed and pinned to the top, and both survive a reload', async () => {
  const state = storedWorkspace()
  const settings = state.conversations[0].settings
  const noon = new Date(); noon.setHours(12, 0, 0, 0)
  const message = (id) => [{ id: `${id}-q`, role: 'user', content: '问题', status: 'complete', createdAt: 1 }, { id: `${id}-a`, role: 'assistant', content: '回答', reasoning: '', status: 'complete', createdAt: 2 }]
  const conversation = (id, title, updatedAt) => ({ id, title, createdAt: updatedAt, updatedAt, draft: '', settings, messages: message(id) })
  state.conversations = [conversation('today', '今天聊的', Date.now()), conversation('older', '很久以前聊的', noon.getTime() - 10 * 86_400_000)]
  state.activeId = 'today'
  const page = await open('', { [storedChatKey]: JSON.stringify(state) })
  try {
    const list = page.getByRole('navigation', { name: '已保存的对话' })
    await list.getByTestId('chat-conversation-older').waitFor()
    const menu = page.getByRole('menu', { name: '对话操作', exact: true })
    await page.getByRole('button', { name: '「很久以前聊的」更多操作', exact: true }).click()
    await menu.getByRole('menuitem', { name: '改名', exact: true }).click()
    const dialog = page.getByTestId('chat-rename-dialog')
    await dialog.getByRole('heading', { name: '给这段对话改个名', exact: true }).waitFor()
    const input = page.getByTestId('chat-rename-input')
    assert.equal(await input.inputValue(), '很久以前聊的')
    assert.equal(await input.evaluate((element) => element === document.activeElement), true)
    // 没改或者删空了，「保存」是灰的。
    assert.equal(await page.getByTestId('chat-rename-save').isDisabled(), true)
    await input.fill('   ')
    assert.equal(await page.getByTestId('chat-rename-save').isDisabled(), true)
    await input.fill('  年终总结  ')
    await input.press('Enter')
    await dialog.waitFor({ state: 'detached' })
    await list.getByText('年终总结', { exact: true }).waitFor()
    // 改名不挪位置：还在「更早」里。
    assert.deepEqual(await list.locator('.chat-conversation-day').allTextContents(), ['今天', '更早'])
    await page.getByRole('button', { name: '「年终总结」更多操作', exact: true }).click()
    await menu.getByRole('menuitem', { name: '置顶', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-conversation-day')].map((item) => item.textContent).join() === '置顶,今天')
    assert.deepEqual(await list.locator('.chat-conversation-select strong').allTextContents(), ['年终总结', '今天聊的'])
    await waitSaved(page, (workspace) => workspace.conversations.some((item) => item.id === 'older' && item.pinned === true && item.renamed === true && item.title === '年终总结'))
    await page.reload()
    await list.getByTestId('chat-conversation-older').waitFor()
    assert.deepEqual(await list.locator('.chat-conversation-day').allTextContents(), ['置顶', '今天'])
    await page.getByRole('button', { name: '「年终总结」更多操作', exact: true }).click()
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['改名', '取消置顶', '导出这段对话', '删除这段对话…'])
    await menu.getByRole('menuitem', { name: '取消置顶', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-conversation-day')].map((item) => item.textContent).join() === '今天,更早')
    // 取消也能退出改名框，不改名字。
    await page.getByRole('button', { name: '「今天聊的」更多操作', exact: true }).click()
    await menu.getByRole('menuitem', { name: '改名', exact: true }).click()
    await input.fill('不要了')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await list.getByText('今天聊的', { exact: true }).waitFor()
    assert.equal(await page.locator('.chat-bar strong').textContent(), '今天聊的')
  } finally { await page.close() }
})

test('a conversation that could not be saved says whether to pick another folder or free up the disk', async () => {
  // D16：没权限、盘满了跟设置页导出同一套说法；认不出原因的照旧说可以重试。
  const expected = {
    denied: '这个位置不让星芒存文件，换个文件夹（比如「下载」）再导出。',
    full: '这块盘满了，清出一些空间，或者换一块盘再导出。',
    other: '这段对话没有导出成功，可以重试',
  }
  const state = storedWorkspace()
  state.conversations[0].messages = [{ id: 'm1', role: 'user', content: '你好', status: 'complete', createdAt: 1 }, { id: 'm2', role: 'assistant', content: '你好呀', reasoning: '', status: 'complete', createdAt: 2 }]
  for (const [failure, banner] of Object.entries(expected)) {
    const page = await open(`exportFail=${failure}`, { [storedChatKey]: JSON.stringify(state) })
    try {
      await ready(page)
      await page.getByTestId('chat-conversation-export').click()
      await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'export-text'))
      const shown = page.locator('.chat-banner[data-tone="bad"] > span')
      await shown.waitFor()
      assert.equal(await shown.innerText(), banner)
    } finally { await page.close() }
  }
})

test('a message typed while offline stays in the composer and goes out from the banner once the network is back', async () => {
  const page = await open()
  try {
    await ready(page)
    await page.context().setOffline(true)
    await page.getByTestId('chat-composer-input').fill('sent after reconnecting')
    await page.getByTestId('chat-send').click()
    await page.getByRole('alert').filter({ hasText: '没发出去：现在连不上网。网络恢复后点「重试」。' }).waitFor()
    assert.equal((await calls(page, 'start')).length, 0)
    assert.equal(await page.getByTestId('chat-composer-input').inputValue(), 'sent after reconnecting')
    await page.context().setOffline(false)
    await page.getByTestId('chat-send-retry').click()
    await page.waitForFunction(() => window.chatHarness.calls.some((item) => item.method === 'start'))
    assert.deepEqual((await calls(page, 'start'))[0].input.messages.at(-1), { role: 'user', content: 'sent after reconnecting' })
    assert.equal(await page.getByTestId('chat-send-retry').count(), 0)
  } finally { await page.close() }
})

test('a reply still coming in when the network drops says so under it and can be stopped (D43)', async () => {
  const page = await open()
  try {
    const request = await send(page, 'network drops midway')
    await emit(page, { type: 'content', requestId: request.requestId, content: 'half of the answer' })
    await page.getByText('half of the answer', { exact: true }).waitFor()
    const notice = page.locator('.chat-message[data-role=assistant] [data-testid=chat-message-offline]')
    assert.equal(await notice.count(), 0)
    await page.context().setOffline(true)
    await notice.waitFor()
    assert.equal(await notice.innerText(), '网络断了，这条回复可能接不上，可以先停止。')
    // 3 分钟的时限照旧，界面不替它先停：字还留着、停止按钮还在，只是告诉人可以先停。
    assert.equal(await page.getByTestId('chat-stop').count(), 1)
    assert.equal((await calls(page, 'cancel')).length, 0)
    await page.context().setOffline(false)
    await notice.waitFor({ state: 'detached' })
    await page.context().setOffline(true)
    await notice.waitFor()
    await page.getByTestId('chat-stop').click()
    await page.getByText('已停止生成，保留已返回的内容', { exact: true }).waitFor()
    assert.equal(await notice.count(), 0)
    assert.equal(await page.getByText('half of the answer', { exact: true }).count(), 1)
    assert.equal((await calls(page, 'cancel')).length, 1)
  } finally { await page.context().setOffline(false); await page.close() }
})

test('the parameters dialog starts every slider at the model default, explains bad numbers and only changes the conversation on apply', async () => {
  const page = await open('openParameters=1')
  try {
    // 顶部搜索的「聊天参数设置」一进聊天页就打开这个对话框。
    const dialog = page.getByTestId('chat-parameters')
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('heading', { name: '参数设置', exact: true }).count(), 1)
    assert.deepEqual(await dialog.locator('.xm-slider b').allTextContents(), ['默认', '默认', '默认', '默认'])
    assert.deepEqual(await dialog.locator('.xm-slider small').allTextContents(), ['越高越有创意，越低越稳定', '一般不用改', '调高可以减少重复用词', '调高会更愿意换话题'])
    assert.equal(await page.getByTestId('chat-parameter-maxTokens').getAttribute('placeholder'), '不限')
    assert.equal(await page.getByTestId('chat-parameter-seed').getAttribute('placeholder'), '不填则每次随机')
    assert.equal(await page.getByTestId('chat-system-prompt').getAttribute('placeholder'), '比如：你是一位耐心的编程老师，回答尽量简短')
    await page.getByTestId('chat-parameter-topP').focus()
    await page.keyboard.press('ArrowLeft')
    assert.equal(await dialog.locator('.xm-slider b').nth(1).textContent(), '0.95')
    await page.getByTestId('chat-parameter-maxTokens').fill('1.5')
    await page.getByTestId('chat-parameters-apply').click()
    await dialog.getByText('要填整数，比如 4096（不填就是不限）', { exact: true }).waitFor()
    await page.getByTestId('chat-parameters-reset').click()
    assert.deepEqual(await dialog.locator('.xm-slider b').allTextContents(), ['默认', '默认', '默认', '默认'])
    assert.equal(await page.getByTestId('chat-parameter-maxTokens').inputValue(), '')
    await page.getByTestId('chat-parameter-seed').fill('42')
    await page.getByTestId('chat-parameters-cancel').click()
    await dialog.waitFor({ state: 'detached' })
    await page.evaluate(() => window.chatHarness.openParameters())
    await dialog.waitFor()
    assert.equal(await page.getByTestId('chat-parameter-seed').inputValue(), '', 'canceling keeps nothing')
    await page.getByTestId('chat-parameter-seed').fill('42')
    await page.getByTestId('chat-parameters-apply').click()
    await dialog.waitFor({ state: 'detached' })
    const request = await send(page, 'seeded')
    assert.deepEqual(request.parameters, { seed: 42 })
  } finally { await page.close() }
})
