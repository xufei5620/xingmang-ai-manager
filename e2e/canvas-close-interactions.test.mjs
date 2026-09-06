import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function withCanvas(run, search = '', openProject = true) {
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/e2e/canvas-close-fixture.html${search}`)
    if (openProject) {
      await page.getByRole('button', { name: '打开项目：关闭保护验收' }).click()
      await page.locator('.react-flow__node[data-id="prompt-1"]').waitFor()
    }
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
}

test('canvas project name drafts survive cancelling a native close request', async () => {
  await withCanvas(async (page) => {
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('未完成的新项目')
    await page.evaluate(() => window.canvasCloseHarness.close('draft'))
    const close = page.getByRole('dialog', { name: '还有未完成的项目操作' })
    await close.getByRole('button', { name: '返回画布' }).click()
    await close.waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), '未完成的新项目')
    assert.deepEqual(await page.evaluate(() => window.canvasCloseHarness.acknowledgements), [{ requestId: 'draft', allowed: false }])
  }, '', false)
})

test('canvas close awaits its real save call, preserves the document on failure, and stays retryable', async () => {
  await withCanvas(async (page) => {
    await page.evaluate(() => { window.canvasCloseHarness.holdSaves = true; window.canvasCloseHarness.close('save-failure') })
    await page.getByRole('dialog', { name: '正在保存画布' }).waitFor()
    await page.waitForFunction(() => window.canvasCloseHarness.pendingCount === 1)
    assert.equal(await page.locator('#root').getAttribute('inert'), '')
    assert.equal(await page.evaluate(() => window.canvasCloseHarness.acknowledgements.length), 0)
    await page.keyboard.press('Control+KeyA')
    await page.keyboard.press('Delete')
    await page.evaluate(() => window.canvasCloseHarness.settleSave(0, '磁盘空间不足'))
    await page.getByText('未关闭画布：磁盘空间不足', { exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.locator('#root').getAttribute('inert'), null)
    assert.equal(await page.locator('.react-flow__node[data-id="prompt-1"]').count(), 1)
    const saved = await page.evaluate(() => JSON.parse(window.canvasCloseHarness.saves[0]))
    assert.equal(saved.nodes[0].data.prompt, '保留项目内容')
    assert.deepEqual(await page.evaluate(() => window.canvasCloseHarness.acknowledgements), [{ requestId: 'save-failure', allowed: false }])
    await page.evaluate(() => window.canvasCloseHarness.close('retry'))
    await page.waitForFunction(() => window.canvasCloseHarness.pendingCount === 2)
    await page.evaluate(() => window.canvasCloseHarness.settleSave(1))
    await page.waitForFunction(() => window.canvasCloseHarness.acknowledgements.some((entry) => entry.requestId === 'retry' && entry.allowed))
  })
})

test('canvas close can be cancelled during work and stopping waits for terminal state before saving', async () => {
  await withCanvas(async (page) => {
    await page.evaluate(() => window.canvasCloseHarness.close('cancel-work'))
    const dialog = page.getByRole('dialog', { name: '画布还有进行中的任务' })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: '返回画布' }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.canvasCloseHarness.cancelCalls), 0)
    await page.evaluate(() => window.canvasCloseHarness.close('stop-work'))
    await dialog.getByRole('button', { name: '停止本地任务并保存' }).click()
    await page.getByRole('dialog', { name: '正在等待任务结束' }).waitFor()
    assert.equal(await page.evaluate(() => window.canvasCloseHarness.cancelCalls), 1)
    assert.equal(await page.evaluate(() => window.canvasCloseHarness.acknowledgements.some((entry) => entry.allowed)), false)
    await page.evaluate(() => window.canvasCloseHarness.finishRuns())
    await page.waitForFunction(() => window.canvasCloseHarness.acknowledgements.some((entry) => entry.requestId === 'stop-work' && entry.allowed))
  }, '?running=1')
})

test('canvas expires old close requests without accepting their late save results', async () => {
  await withCanvas(async (page) => {
    await page.evaluate(() => { window.canvasCloseHarness.holdSaves = true; window.canvasCloseHarness.close('expired') })
    await page.waitForFunction(() => window.canvasCloseHarness.pendingCount === 1)
    await page.evaluate(() => window.canvasCloseHarness.expire('expired'))
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.evaluate(() => window.canvasCloseHarness.settleSave(0))
    await page.waitForFunction(() => document.getElementById('root')?.hasAttribute('inert') === false)
    assert.equal(await page.evaluate(() => window.canvasCloseHarness.acknowledgements.length), 0)
    assert.equal(await page.locator('.react-flow__node[data-id="prompt-1"]').count(), 1)
  })
})

test('canvas applies four skins in both themes with live document and readable nonblank graph', async () => {
  await withCanvas(async (page) => {
    const output = path.join(root, '.project-surgeon/audits/20260906-ui-implementation/canvas')
    await fs.mkdir(output, { recursive: true })
    for (const theme of ['light', 'dark']) {
      for (const uiSkin of ['dawn', 'obsidian', 'mist', 'aurora']) {
        await page.evaluate(({ theme, uiSkin }) => window.canvasCloseHarness.appearance({ theme, uiSkin, reducedMotion: true }), { theme, uiSkin })
        await page.waitForFunction(({ theme, uiSkin }) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.skin === uiSkin, { theme, uiSkin })
        assert.equal(await page.locator('.react-flow__node[data-id="prompt-1"]').count(), 1)
        const state = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, background: getComputedStyle(document.querySelector('.canvas-app')).backgroundColor, graphBackground: getComputedStyle(document.querySelector('.react-flow')).backgroundColor, reducedMotion: document.documentElement.dataset.reducedMotion }))
        assert.equal(state.scrollWidth <= state.width, true)
        assert.equal(state.reducedMotion, 'true')
        assert.notEqual(state.background, 'rgba(0, 0, 0, 0)')
        assert.equal(state.graphBackground, state.background)
        if ((theme === 'light' && uiSkin === 'dawn') || (theme === 'dark' && uiSkin === 'obsidian')) await page.screenshot({ path: path.join(output, `${theme}-${uiSkin}.png`), fullPage: true })
      }
    }
  })
})
