import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'
import { createBrowserFixture } from './harness.mjs'
import { openFixturePage, waitForFixtureMount } from './fixture-readiness.mjs'

// Exercise the real canvas and persisted graph with an in-page host double.
// No credentials, production endpoints, paid generation or Electron IPC.
const fixture = createBrowserFixture({ root: path.resolve('canvas-v2'), configFile: path.resolve('canvas-v2/vite.config.ts'), actionTimeoutMs: 8_000 })
let origin
const errors = []
const externalRequests = []
const artifactRoot = path.resolve('artifacts/canvas-composer')

before(async () => {
  process.env.XINGMANG_RENDERER = 'v2'
  await fixture.start()
  origin = fixture.baseUrl
  await fs.mkdir(artifactRoot, { recursive: true })
})
after(async () => {
  await fixture.stop()
  fixture.assertNoPageErrors()
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
})

function installHost({ withReference = false } = {}) {
  const now = '2026-10-03T00:00:00.000Z'
  const project = { id: '11111111-1111-4111-8111-111111111111', name: '输入栏验收', createdAt: now, updatedAt: now, lastOpenedAt: now, nodeCount: 2, assetCount: 0, workspaceConfigured: true, workspaceStatus: 'ready', workspaceName: 'Mock workspace' }
  const initial = { schemaVersion: 2, name: project.name, viewport: { x: 0, y: 0, zoom: 1 }, mediaGroups: { image: '生图分组', video: 'grok', imageModel: 'gpt-image-2', videoModel: 'minimax-h3-mini' }, nodes: [
    { id: 'image', kind: 'image-generate', definitionVersion: 1, position: { x: 120, y: 70 }, data: { prompt: '', model: 'gpt-image-2', quality: 'low', imageResolution: '1K', size: '1024x1024', status: 'idle' } },
    { id: 'video', kind: 'video-generate', definitionVersion: 1, position: { x: 470, y: 70 }, data: { prompt: '缓慢推进的镜头', model: 'minimax-h3-mini', size: '1280x720', seconds: '6', settings: { videoMode: 'auto', videoResolution: '720p', videoAspectRatio: '16:9', promptOptimization: false }, status: 'idle' } },
  ], edges: [] }
  if (withReference) {
    initial.nodes.push({ id: 'reference', kind: 'image-input', definitionVersion: 1, position: { x: 850, y: 70 }, data: { prompt: '', model: '', status: 'idle' } })
    initial.edges.push({ id: 'reference-to-image', source: 'reference', sourceHandle: 'out:image', target: 'image', targetHandle: 'in:image' })
  }
  const key = 'canvas-composer-fixture-document'
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(initial))
  const listeners = new Set()
  window.__composerFixture = { starts: [], presets: [], cancels: [], saves: 0, saved: () => JSON.parse(localStorage.getItem(key)), emit: (event) => listeners.forEach((listener) => listener(event)) }
  window.xingmangCanvasHost = {
    listProjects: async () => [project],
    openProject: async () => ({ project, content: localStorage.getItem(key) }),
    saveProject: async (_id, content) => { localStorage.setItem(key, content); window.__composerFixture.saves += 1; return project },
    listGroups: async () => [{ name: '生图分组', description: 'Mock image group', ratio: 1 }, { name: 'grok', description: 'Mock video group', ratio: 1 }],
    prepareGroup: async (group) => ({ group, models: group === '生图分组' ? ['gpt-image-2', 'gpt-image-1', 'jimeng_high_aes_general_v21_L'] : ['grok-imagine-video', 'minimax-h3-mini'], keyCreated: false }),
    listAssets: async () => ({ items: [], offset: 0, limit: 24, total: 0, hasMore: false, facets: { tags: [] } }),
    listPromptPresets: async () => [],
    createPromptPreset: async (input) => { const preset = { ...input, id: 'preset-1', createdAt: now, updatedAt: now }; window.__composerFixture.presets.push(preset); return preset },
    listRuns: async () => [],
    startRun: async (input) => {
      window.__composerFixture.starts.push(structuredClone(input))
      return { runId: `run-${window.__composerFixture.starts.length}`, graphRevision: input.graph.revision || 'fixture-revision' }
    },
    cancelRun: async (id) => { window.__composerFixture.cancels.push(id); return true },
    onRunEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    onAccountChange: () => () => {},
    onThemeChange: () => () => {},
    onAppearanceChange: () => () => {},
  }
}

async function openPage(viewport = { width: 1366, height: 768 }, theme = 'dark', withReference = false) {
  const page = await fixture.newPage({ viewport })
  page.setDefaultTimeout(8_000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    externalRequests.push(route.request().url())
    return route.abort()
  })
  await page.addInitScript(installHost, { withReference })
  await openFixturePage(page, `${origin}/?theme=${theme}`, (timeout) => page.getByRole('button', { name: '打开项目：输入栏验收' }).waitFor({ timeout }), { label: 'canvas composer fixture' })
  await page.getByRole('button', { name: '打开项目：输入栏验收' }).click()
  await page.locator('.react-flow__node[data-id="image"]').click()
  await expect(page.locator('.canvas-composer-dock')).toBeVisible()
  return page
}

async function parameters(page) {
  const button = page.getByRole('button', { name: /^生成参数：/ })
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  return page.getByRole('region', { name: '生成参数', exact: true })
}

async function save(page) {
  // Typing updates the autosave document without relying on blur or Ctrl+S.
  await expect(page.locator('.canvas-autosave')).toHaveText('已自动保存')
  await expect.poll(() => page.evaluate(() => window.__composerFixture.saves)).toBeGreaterThan(0)
  return page.evaluate(() => window.__composerFixture.saved())
}

test('inline settings, tools and keyboard preserve the draft and map to one confirmed run', async () => {
  const page = await openPage()
  const composer = page.locator('.canvas-composer-dock')
  const prompt = composer.getByRole('textbox')
  await expect(composer.getByRole('combobox')).toHaveCount(1)
  await prompt.fill('雨夜的城市，暖色灯光')
  await parameters(page)
  await page.getByLabel('生成画质', { exact: true }).selectOption('high')
  await page.getByLabel('生成清晰度', { exact: true }).selectOption('2K')
  await page.getByLabel('生成尺寸', { exact: true }).selectOption('1280x720')
  await expect(page.getByRole('button', { name: '生成参数：16:9 · 2K · 极高', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '更多生成工具', exact: true }).click()
  await expect(page.getByRole('region', { name: '生成参数', exact: true })).toHaveCount(0)
  await expect(prompt).toHaveValue('雨夜的城市，暖色灯光')
  await page.getByRole('button', { name: '保存为提示词预设', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__composerFixture.presets[0].prompt), '雨夜的城市，暖色灯光')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '更多生成工具', exact: true })).toBeFocused()
  await prompt.focus()
  await prompt.press('End')
  await prompt.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  await prompt.dispatchEvent('compositionstart')
  // A synthetic composition event does not start the browser's native IME.
  // Keep the composing keystroke synthetic too; this is not native IME QA.
  await prompt.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true })
  await expect(page.getByRole('dialog', { name: '运行前检查' })).toHaveCount(0)
  await prompt.dispatchEvent('compositionend')
  await expect(prompt).toHaveValue('雨夜的城市，暖色灯光')
  await prompt.press('Enter')
  assert.equal(await page.evaluate(() => window.__composerFixture.starts.length), 0)
  await prompt.press('Control+Enter')
  await expect(page.getByRole('dialog', { name: '运行前检查' })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(prompt).toHaveValue('雨夜的城市，暖色灯光\n')
  await expect.poll(() => page.evaluate(() => window.__composerFixture.saved().nodes.find((node) => node.id === 'image').data.quality)).toBe('high')
  const saved = await save(page)
  const image = saved.nodes.find((node) => node.id === 'image')
  assert.equal(image.data.size, '1280x720')
  assert.equal(image.data.imageResolution, '2K')
  assert.equal(image.data.quality, 'high')
  await composer.getByRole('button', { name: '生成', exact: true }).dblclick()
  const confirm = page.getByRole('button', { name: '确认运行', exact: true })
  await confirm.evaluate((button) => { button.click(); button.click() })
  await expect.poll(() => page.evaluate(() => window.__composerFixture.starts.length)).toBe(1)
  const request = await page.evaluate(() => window.__composerFixture.starts[0])
  const requestNode = request.graph.nodes.find((node) => node.id === 'image').data
  assert.equal(requestNode.prompt.trim(), '雨夜的城市，暖色灯光')
  assert.equal(requestNode.size, '1280x720')
  assert.equal(requestNode.imageResolution, '2K')
  assert.equal(requestNode.quality, 'high')
  await page.close()
})

test('model changes reconcile persisted settings and reload matches the visible configuration', async () => {
  const page = await openPage()
  await parameters(page)
  await page.getByLabel('生成清晰度', { exact: true }).selectOption('4K')
  await page.getByLabel('生成尺寸', { exact: true }).selectOption('1280x720')
  await page.getByLabel('图像模型', { exact: true }).selectOption('gpt-image-1')
  await expect(page.getByLabel('生成清晰度', { exact: true })).toHaveValue('1K')
  await expect(page.getByLabel('生成尺寸', { exact: true })).toHaveValue('1024x1024')
  await page.getByLabel('图像模型', { exact: true }).selectOption('jimeng_high_aes_general_v21_L')
  await expect(page.getByLabel('生成尺寸', { exact: true })).toHaveCount(0)
  await page.locator('.canvas-composer-dock textarea').fill('模型切换后保留的草稿')
  await expect.poll(() => page.evaluate(() => window.__composerFixture.saved().nodes.find((node) => node.id === 'image').data.prompt)).toBe('模型切换后保留的草稿')
  let saved = await save(page)
  assert.equal(saved.nodes.find((node) => node.id === 'image').data.size, '1024x1024')
  await page.reload()
  await waitForFixtureMount(page)
  await page.getByRole('button', { name: '打开项目：输入栏验收' }).click()
  await page.locator('.react-flow__node[data-id="image"]').click()
  await expect(page.locator('.canvas-composer-dock textarea')).toHaveValue('模型切换后保留的草稿')
  await expect(page.getByLabel('图像模型', { exact: true })).toHaveValue('jimeng_high_aes_general_v21_L')
  await page.locator('.react-flow__node[data-id="video"]').click()
  await parameters(page)
  await page.getByLabel('MiniMax 视频比例', { exact: true }).selectOption('9:16')
  await page.getByLabel('MiniMax 视频分辨率', { exact: true }).selectOption('480p')
  await page.getByRole('checkbox', { name: 'AI 优化 H3 提示词' }).check()
  await page.getByLabel('视频模型', { exact: true }).selectOption('grok-imagine-video')
  await expect(page.getByLabel('视频时长', { exact: true })).toHaveValue('6')
  await page.getByLabel('视频时长', { exact: true }).selectOption('2')
  await page.getByLabel('视频模型', { exact: true }).selectOption('minimax-h3-mini')
  await expect(page.getByLabel('视频时长', { exact: true })).toHaveValue('5')
  await expect(page.getByLabel('MiniMax 视频比例', { exact: true })).toHaveValue('9:16')
  await expect.poll(() => page.evaluate(() => window.__composerFixture.saved().nodes.find((node) => node.id === 'video').data.seconds)).toBe('5')
  saved = await save(page)
  assert.equal(saved.nodes.find((node) => node.id === 'video').data.seconds, '5')
  assert.equal(saved.nodes.find((node) => node.id === 'video').data.settings.videoResolution, '480p')
  await page.close()
})

test('docked controls remain inside the visible canvas across themes, panels and viewports', async () => {
  for (const theme of ['dark', 'light']) {
    const page = await openPage({ width: 1366, height: 768 }, theme)
    for (const [width, height] of [[960, 620], [1366, 768], [1590, 875], [3840, 2160]]) {
      await page.setViewportSize({ width, height })
      await parameters(page)
      const bounds = await page.locator('.canvas-composer-dock').boundingBox()
      const canvas = await page.locator('.canvas-flow').boundingBox()
      assert.ok(bounds.x >= canvas.x && bounds.x + bounds.width <= canvas.x + canvas.width + 1)
      assert.ok(bounds.y >= canvas.y && bounds.y + bounds.height <= canvas.y + canvas.height)
      await expect(page.locator('.wf-composer-send')).toBeInViewport()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (width === 960) {
        await page.getByRole('button', { name: '更多操作', exact: true }).click()
        await page.getByRole('button', { name: '打开运行历史', exact: true }).click()
        const inspector = await page.locator('.canvas-inspector').boundingBox()
        const dock = await page.locator('.canvas-composer-dock').boundingBox()
        assert.ok(dock.x + dock.width <= inspector.x)
        await expect(page.locator('.wf-composer-send')).toBeInViewport()
      }
      await page.screenshot({ path: path.join(artifactRoot, `${theme}-${width}x${height}.png`) })
    }
    await page.close()
  }
})


test('reference mentions remain available and removing a reference preserves its node and draft', async () => {
  const page = await openPage({ width: 960, height: 620 }, 'dark', true)
  const composer = page.locator('.canvas-composer-dock')
  const prompt = composer.getByRole('textbox')
  await expect(composer.locator('.wf-composer-chip.is-image')).toHaveCount(1)
  await prompt.fill('参考 @')
  const suggestions = composer.getByRole('listbox', { name: '已连接的上游素材' })
  await expect(suggestions).toBeVisible()
  await expect(suggestions).toBeInViewport()
  await suggestions.getByRole('option').first().click()
  const draft = await prompt.inputValue()
  assert.match(draft, /@图片素材-图片-/)
  await parameters(page)
  await page.getByRole('button', { name: '更多生成工具', exact: true }).click()
  await expect(prompt).toHaveValue(draft)
  await expect(composer.locator('.wf-composer-chip.is-image')).toHaveCount(1)
  await composer.locator('.wf-composer-chip.is-image button').click()
  await expect(composer.locator('.wf-composer-chip.is-image')).toHaveCount(0)
  await expect(prompt).toHaveValue(draft)
  await expect(page.locator('.react-flow__node[data-id="reference"]')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => window.__composerFixture.saved().edges.length)).toBe(0)
  const saved = await page.evaluate(() => window.__composerFixture.saved())
  assert.ok(saved.nodes.some((node) => node.id === 'reference'))
  assert.equal(saved.nodes.find((node) => node.id === 'image').data.prompt, draft)
  assert.equal(await page.evaluate(() => window.__composerFixture.starts.length), 0)
  await page.close()
})
