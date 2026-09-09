import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../canvas-v2')
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
let page
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.clock.install()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.addInitScript(() => {
    const state = window.__groupFixture = { reads: 0, prepared: [], runs: 0, saves: [], fail: false,
      groups: [{ name: 'GPT-image2', ratio: 1 }, { name: 'Gemini', ratio: 1 }] }
    const project = { id: '11111111-1111-4111-8111-111111111111', name: '分组实时刷新',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lastOpenedAt: '2026-09-01T00:00:00Z',
      nodeCount: 1, assetCount: 0, workspaceName: 'fixture', workspaceConfigured: true, workspaceStatus: 'ready' }
    const content = JSON.stringify({ schemaVersion: 2, name: project.name, viewport: { x: 0, y: 0, zoom: 1 },
      mediaGroups: { image: 'GPT-image2', imageModel: 'gpt-image-2', text: 'Gemini', textModel: 'gemini-3.7-flash' },
      nodes: [{ id: 'image-node', kind: 'image-generate', definitionVersion: 1, position: { x: 300, y: 200 },
        data: { label: '测试图片', prompt: '保留这段草稿', model: 'gpt-image-2', status: 'idle' } }], edges: [] })
    window.xingmangCanvasHost = {
      listProjects: async () => [project], openProject: async () => ({ project, content }),
      saveProject: async (_id, value) => { state.saves.push(JSON.parse(value)); return project },
      listGroups: async () => { state.reads++; if (state.fail) throw new Error('测试网络暂不可用'); return state.groups.map((group) => ({ ...group })) },
      prepareGroup: async (group) => { state.prepared.push(group); return { group, models: group.includes('Gemini')
        ? ['gemini-3.7-flash'] : ['gpt-image-2'], keyCreated: false } },
      listAssets: async () => ({ items: [], total: 0, offset: 0, limit: 24, hasMore: false, facets: { tags: [] } }),
      listPromptPresets: async () => [], listRuns: async () => [], onRunEvent: () => () => {},
      onAccountChange: () => () => {}, onThemeChange: () => () => {}, onAppearanceChange: () => () => {},
      onCloseRequested: () => () => {}, onCloseCancelled: () => () => {},
      startRun: async () => { state.runs++; throw new Error('This fixture must not generate') },
    }
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?siteId=solov-api`)
  await page.getByRole('button', { name: '打开项目：分组实时刷新' }).click()
  await page.getByRole('button', { name: '生成配置', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '画布生成配置' })
  const image = panel.getByRole('combobox', { name: '生图分组分组选择' })
  const video = panel.getByRole('combobox', { name: '视频分组分组选择' })
  const text = panel.getByRole('combobox', { name: '文字分组分组选择' })
  await expect(image).toHaveValue('GPT-image2')
  await expect(video).toHaveValue('')
  await expect(text).toHaveValue('Gemini')
  const initial = await page.evaluate(() => ({ prepared: [...window.__groupFixture.prepared], saves: window.__groupFixture.saves.length }))
  for (const [index, select] of [image, video, text].entries()) {
    await page.waitForTimeout(320)
    await page.evaluate((index) => { window.__groupFixture.groups.push({ name: `fresh-${index}`, ratio: 0.5 }) }, index)
    const before = await page.evaluate(() => window.__groupFixture.reads)
    await select.click()
    await expect(select.locator('option', { hasText: `fresh-${index}` })).toHaveCount(1)
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.__groupFixture.reads), before + 1)
  }
  await page.waitForTimeout(320)
  await page.evaluate(() => { window.__groupFixture.groups = window.__groupFixture.groups.filter((group) => group.name !== 'GPT-image2') })
  await image.focus()
  await image.press('Alt+ArrowDown')
  await expect(image.locator('option', { hasText: 'GPT-image2 · 不可用' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(image).toHaveValue('GPT-image2')
  await expect(panel.getByRole('combobox', { name: '生图默认模型' })).toHaveValue('gpt-image-2')
  assert.deepEqual(await page.evaluate(() => window.__groupFixture.prepared), initial.prepared)
  await page.waitForTimeout(320)
  await page.evaluate(() => { window.__groupFixture.fail = true; window.dispatchEvent(new Event('focus')) })
  await expect(panel.getByRole('button', { name: '重试刷新分组' })).toBeVisible()
  await expect(text).toHaveValue('Gemini')
  await page.evaluate(() => { window.__groupFixture.fail = false; window.__groupFixture.groups.push({ name: 'recovered', ratio: 2 }) })
  await panel.getByRole('button', { name: '重试刷新分组' }).click()
  await expect(text.locator('option', { hasText: 'recovered' })).toHaveCount(1)
  await panel.getByRole('button', { name: '关闭生成配置' }).click()
  await page.getByRole('button', { name: '运行全部', exact: true }).click()
  await expect(page.getByText('分组「GPT-image2」已不可用，请在生成配置中重新选择', { exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => window.__groupFixture.runs), 0)
  await expect(image).toHaveValue('GPT-image2')
  await image.selectOption('recovered')
  await expect(image).toHaveValue('recovered')
  await expect(text).toHaveValue('Gemini')
  await expect(video).toHaveValue('')
  assert.deepEqual(await page.evaluate(() => window.__groupFixture.prepared), [...initial.prepared, 'recovered'])
  assert.equal(await page.evaluate(() => window.__groupFixture.saves.every((saved) => saved.nodes[0].data.prompt === '保留这段草稿')), true)
  const beforePolling = await page.evaluate(() => window.__groupFixture.reads)
  await page.clock.fastForward(30001)
  await expect.poll(() => page.evaluate(() => window.__groupFixture.reads)).toBeGreaterThan(beforePolling)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }) })
  const hiddenReads = await page.evaluate(() => window.__groupFixture.reads)
  await page.clock.fastForward(60001)
  assert.equal(await page.evaluate(() => window.__groupFixture.reads), hiddenReads)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => page.evaluate(() => window.__groupFixture.reads)).toBeGreaterThan(hiddenReads)
  await panel.getByRole('button', { name: '关闭生成配置' }).click()
  const closedReads = await page.evaluate(() => window.__groupFixture.reads)
  await page.clock.fastForward(60001)
  assert.equal(await page.evaluate(() => window.__groupFixture.reads), closedReads)
  assert.deepEqual(await page.evaluate(() => window.__groupFixture.prepared), [...initial.prepared, 'recovered'])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ dropdownPointerRefresh: 3, keyboardRefresh: true, metadataOnly: true,
    selectionPreserved: true, unavailableBlocksRun: true, retry: true, foregroundPolling: true, backgroundPaused: true, generatedContent: false }))
} catch (error) {
  console.error(await page?.locator('body').innerText().catch(() => 'page unavailable'))
  throw error
} finally { await browser.close(); await server.close() }
