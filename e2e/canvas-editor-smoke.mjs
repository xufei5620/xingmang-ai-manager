import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'

const projectRoot = path.resolve('.')
const canvasIndex = path.join(projectRoot, 'dist-canvas', 'index.html')
const artifactRoot = path.join(projectRoot, 'artifacts', 'canvas-editor-smoke')
const fixtureRoot = path.join(artifactRoot, 'fixture')
const fixtureMain = path.join(fixtureRoot, 'main.cjs')
const fixturePreload = path.join(fixtureRoot, 'preload.cjs')
const fixtureAssetId = 'A'.repeat(43)
const fixturePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const viewports = [
  { name: 'compact', width: 960, height: 620 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1590, height: 875 },
  { name: '4k', width: 3840, height: 2160 },
]

await fs.rm(artifactRoot, { recursive: true, force: true })
await fs.mkdir(fixtureRoot, { recursive: true })
await fs.access(canvasIndex)
await fs.writeFile(fixturePreload, `
const { contextBridge } = require('electron')
const assetId = ${JSON.stringify(fixtureAssetId)}
const localUrl = ${JSON.stringify(`data:image/png;base64,${fixturePng}`)}
const asset = {
  assetId,
  localUrl,
  thumbnailUrl: localUrl,
  mimeType: 'image/png',
  width: 1024,
  height: 1024,
  fileName: 'visual-fixture.png',
  createdAt: '2026-08-13T00:00:00.000Z',
  mediaType: 'image',
}
contextBridge.exposeInMainWorld('xingmangCanvasHost', {
  listGroups: async () => [],
  listAssets: async (query = {}) => ({ items: [asset], offset: query.offset || 0, limit: query.limit || 24, total: 1, hasMore: false }),
  listPromptPresets: async () => [],
  listRuns: async () => [],
  onRunEvent: () => undefined,
  showAssetMenu: async () => undefined,
  pickAsset: async () => asset,
})
`, 'utf8')
await fs.writeFile(fixtureMain, `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 960,
    height: 620,
    useContentSize: true,
    show: true,
    backgroundColor: '#111315',
    webPreferences: {
      preload: ${JSON.stringify(fixturePreload)},
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  })
  await window.loadFile(path.resolve(${JSON.stringify(canvasIndex)}))
})

app.on('window-all-closed', () => app.quit())
`, 'utf8')

const application = await electron.launch({
  args: [fixtureMain],
  env: {
    ...process.env,
    XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
  },
})

const result = { viewports: [], externalRequests: [], consoleErrors: [], pageErrors: [] }

try {
  const page = await application.firstWindow()
  const devtools = await page.context().newCDPSession(page)
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) result.externalRequests.push(request.url())
  })
  page.on('console', (message) => {
    if (message.type() === 'error') result.consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => result.pageErrors.push(error.message))
  await page.locator('.canvas-app').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByRole('button', { name: '快速模板', exact: true }).click()
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible', timeout: 10_000 })
  const libraryTabs = ['节点', '提示词', '模板', '素材']
  for (const label of libraryTabs) {
    await page.getByRole('tab', { name: label, exact: true }).click()
    await expectSelectedLibraryTab(page, label)
  }
  await page.getByRole('tab', { name: '提示词', exact: true }).click()
  const beforePromptPreset = await page.locator('.react-flow__node').count()
  await page.getByRole('button', { name: /商品棚拍/ }).click()
  await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__node').length === expected, beforePromptPreset + 1)
  await page.getByRole('tab', { name: '节点', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '运行图像生成节点', exact: true }).count(), 1, '图像生成节点缺少可见运行按钮')
  assert.equal(await page.getByRole('button', { name: '运行工作流', exact: true }).count(), 1, '顶部应明确表示运行整个工作流')
  await page.locator('.node-library-item').filter({ hasText: '图片素材' }).click()
  assert.ok(await page.getByRole('button', { name: '从文件选择', exact: true }).count() >= 1, '图片素材节点缺少文件选择入口')
  await page.getByRole('button', { name: '资产', exact: true }).click()
  const fixtureAsset = page.getByRole('button', { name: '添加资产到画布：visual-fixture.png' })
  await fixtureAsset.waitFor({ state: 'visible' })
  await fixtureAsset.dragTo(page.locator('.wf-drop-target').last())
  const importedPreview = page.locator('.react-flow__node-image-input .wf-preview').last()
  await importedPreview.waitFor({ state: 'visible' })
  await importedPreview.dblclick()
  await page.getByRole('dialog', { name: '图片预览' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '关闭图片预览' }).click()
  await page.getByRole('button', { name: '关闭资产栏' }).click()
  const assetNodeGeometry = await page.locator('.react-flow__node-image-input').last().evaluate((element) => {
    return { width: element.clientWidth, height: element.clientHeight }
  })
  assert.ok(Math.abs(assetNodeGeometry.width - 280) < 1, '图片素材节点宽度没有按注册表约束')
  assert.ok(Math.abs(assetNodeGeometry.height - 340) < 1, '图片素材节点高度没有按注册表约束')

  const selectableNodes = page.locator('.react-flow__node')
  const firstRect = await selectableNodes.nth(0).boundingBox()
  const secondRect = await selectableNodes.nth(1).boundingBox()
  assert.ok(firstRect && secondRect, '框选测试缺少可见节点')
  await page.mouse.move(Math.min(firstRect.x, secondRect.x) - 12, Math.min(firstRect.y, secondRect.y) - 12)
  await page.mouse.down()
  await page.mouse.move(
    Math.max(firstRect.x + firstRect.width, secondRect.x + secondRect.width) + 12,
    Math.max(firstRect.y + firstRect.height, secondRect.y + secondRect.height) + 12,
    { steps: 8 },
  )
  await page.mouse.up()
  assert.ok(await page.locator('.react-flow__node.selected').count() >= 2, '从空白区域拖动没有框选多个节点')

  for (const viewport of viewports) {
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    })
    await page.waitForTimeout(150)

    const layout = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const rect = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const value = element.getBoundingClientRect()
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
      }
      const controls = [...document.querySelectorAll('.canvas-toolbar button, .canvas-toolbar select, .canvas-toolbar span')]
        .filter(visible)
      const clippedControls = controls.filter((element) => (
        element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1
      )).map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || element.tagName)
      const nodeLibrary = rect('.node-library')
      const flow = rect('.canvas-flow')
      const brightNodeShells = [...document.querySelectorAll('.react-flow__node')]
        .filter(visible)
        .filter((element) => {
          const color = getComputedStyle(element).backgroundColor
          const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
          return channels.length === 3 && channels.every((channel) => channel > 180)
        })
        .map((element) => element.className)
      const overlap = nodeLibrary && flow
        ? Math.max(0, Math.min(nodeLibrary.right, flow.right) - Math.max(nodeLibrary.left, flow.left))
          * Math.max(0, Math.min(nodeLibrary.bottom, flow.bottom) - Math.max(nodeLibrary.top, flow.top))
        : 0
      return {
        innerWidth,
        innerHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        rootBackground: getComputedStyle(document.documentElement).backgroundColor,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        canvasBackground: getComputedStyle(document.querySelector('.canvas-flow')).backgroundColor,
        clippedControls,
        brightNodeShells,
        nodeLibrary,
        flow,
        overlap,
        nodeCount: document.querySelectorAll('.react-flow__node').length,
      }
    })

    const screenshotPath = path.join(artifactRoot, `canvas-${viewport.name}-${viewport.width}x${viewport.height}.png`)
    const screenshot = await page.screenshot({ path: screenshotPath })
    const pixels = await application.evaluate(async ({ nativeImage }, input) => {
      const image = nativeImage.createFromBuffer(Buffer.from(input.bytes))
      const bitmap = image.toBitmap()
      const size = image.getSize()
      let luminance = 0
      let veryLight = 0
      let changedFromCanvas = 0
      const buckets = new Set()
      const pixelCount = bitmap.length / 4
      for (let offset = 0; offset < bitmap.length; offset += 4) {
        const blue = bitmap[offset]
        const green = bitmap[offset + 1]
        const red = bitmap[offset + 2]
        const light = red * 0.2126 + green * 0.7152 + blue * 0.0722
        luminance += light
        if (light > 235) veryLight += 1
        if (Math.abs(red - 17) + Math.abs(green - 19) + Math.abs(blue - 21) > 18) changedFromCanvas += 1
        if (offset % 64 === 0) buckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}`)
      }
      return {
        width: size.width,
        height: size.height,
        averageLuminance: luminance / pixelCount,
        veryLightRatio: veryLight / pixelCount,
        nonCanvasRatio: changedFromCanvas / pixelCount,
        colorBuckets: buckets.size,
      }
    }, { bytes: [...screenshot] })

    assert.equal(layout.innerWidth, viewport.width)
    assert.equal(layout.innerHeight, viewport.height)
    assert.ok(layout.bodyScrollWidth <= viewport.width + 1, `${viewport.name}: 页面横向溢出`)
    assert.ok(layout.bodyScrollHeight <= viewport.height + 1, `${viewport.name}: 页面纵向溢出`)
    assert.deepEqual(layout.clippedControls, [], `${viewport.name}: 工具栏控件文字被裁切`)
    assert.deepEqual(layout.brightNodeShells, [], `${viewport.name}: 节点外层出现亮色背景`)
    assert.equal(layout.overlap, 0, `${viewport.name}: 节点库与画布重叠`)
    assert.ok(layout.nodeCount >= 2, `${viewport.name}: 模板节点未渲染`)
    assert.equal(layout.rootBackground, 'rgb(17, 19, 21)')
    assert.equal(layout.bodyBackground, 'rgb(17, 19, 21)')
    assert.equal(pixels.width, viewport.width)
    assert.equal(pixels.height, viewport.height)
    assert.ok(pixels.averageLuminance < 90, `${viewport.name}: 画面不再是暗色系`)
    assert.ok(pixels.veryLightRatio < 0.08, `${viewport.name}: 画面出现大面积亮色`)
    assert.ok(pixels.nonCanvasRatio > 0.02, `${viewport.name}: 画面近似空白`)
    assert.ok(pixels.colorBuckets > 12, `${viewport.name}: 画面色彩层次不足`)

    result.viewports.push({ ...viewport, layout, pixels, screenshotPath })
  }

  await devtools.send('Emulation.clearDeviceMetricsOverride')

  await page.getByRole('button', { name: '运行历史', exact: true }).click()
  await page.locator('.run-inspector').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: '资产', exact: true }).click()
  await page.locator('.asset-tray').waitFor({ state: 'visible', timeout: 10_000 })

  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(960, 620)
    window.webContents.setZoomFactor(1)
  })
  await page.waitForTimeout(150)
  const combinedPanels = await page.evaluate(() => {
    const bounds = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect()
      return value ? { left: value.left, right: value.right, width: value.width } : null
    }
    return {
      innerWidth,
      innerHeight,
      library: bounds('.node-library'),
      flow: bounds('.canvas-flow'),
      assets: bounds('.asset-tray'),
      runs: bounds('.run-inspector'),
    }
  })
  assert.ok(combinedPanels.library && combinedPanels.flow && combinedPanels.assets && combinedPanels.runs)
  assert.equal(combinedPanels.innerWidth, 960, '组合面板检查没有使用真实 960px CSS 视口')
  assert.equal(combinedPanels.innerHeight, 620, '组合面板检查没有使用真实 620px CSS 视口')
  assert.ok(combinedPanels.flow.width >= 400, '960px 三侧栏同时打开时画布可用宽度不足')
  assert.ok(combinedPanels.library.right <= combinedPanels.flow.left + 1)
  assert.ok(combinedPanels.flow.right <= combinedPanels.assets.left + 1)
  assert.ok(combinedPanels.assets.right <= combinedPanels.runs.left + 1)
  await page.screenshot({ path: path.join(artifactRoot, 'canvas-combined-panels-960x620.png') })

  for (const zoomFactor of [1.25, 1.5]) {
    await application.evaluate(({ BrowserWindow }, factor) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1590, 875)
      window.webContents.setZoomFactor(factor)
    }, zoomFactor)
    await page.waitForTimeout(150)
    const scaledLayout = await page.evaluate(() => ({
      innerWidth,
      innerHeight,
      scrollWidth: document.body.scrollWidth,
      scrollHeight: document.body.scrollHeight,
      visibleNodes: [...document.querySelectorAll('.react-flow__node')]
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        }).length,
    }))
    assert.ok(scaledLayout.innerWidth <= 1590 && scaledLayout.innerWidth >= 1000, `${zoomFactor * 100}%：CSS 视口未随缩放变化`)
    assert.ok(scaledLayout.innerHeight <= 875 && scaledLayout.innerHeight >= 580, `${zoomFactor * 100}%：CSS 视口高度异常`)
    assert.ok(scaledLayout.scrollWidth <= scaledLayout.innerWidth + 1, `${zoomFactor * 100}%：页面横向溢出`)
    assert.ok(scaledLayout.scrollHeight <= scaledLayout.innerHeight + 1, `${zoomFactor * 100}%：页面纵向溢出`)
    assert.ok(scaledLayout.visibleNodes > 0, `${zoomFactor * 100}%：画布节点不可见`)
    await page.screenshot({ path: path.join(artifactRoot, `canvas-scale-${zoomFactor * 100}.png`) })
  }
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
  })

  await page.getByRole('button', { name: '关闭运行面板' }).click()
  await page.getByRole('button', { name: '关闭资产栏' }).click()
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1590, 875)
  })
  const addPrompt = page.getByRole('button', { name: '+ 提示词', exact: true })
  const beforeStress = await page.locator('.react-flow__node').count()
  const stressStartedAt = Date.now()
  for (let index = 0; index < 100; index += 1) await addPrompt.click()
  await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__node').length === expected, beforeStress + 100)
  await page.keyboard.press('Control+A')
  await page.waitForFunction(() => [...document.querySelectorAll('.react-flow__node')].every((node) => node.classList.contains('selected')))
  await page.keyboard.press('Delete')
  await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__node').length === expected, 0)
  const stressElapsedMs = Date.now() - stressStartedAt
  assert.ok(stressElapsedMs < 15_000, `100 节点交互耗时过长：${stressElapsedMs}ms`)
  result.hundredNodeInteraction = { created: 100, deleted: beforeStress + 100, elapsedMs: stressElapsedMs }

  assert.deepEqual(result.externalRequests, [], '画布视觉验收不得请求外部网络')
  assert.deepEqual(result.pageErrors, [])
  assert.deepEqual(result.consoleErrors, [])
} finally {
  await fs.writeFile(path.join(artifactRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await application.close()
}

console.log(JSON.stringify(result, null, 2))

async function expectSelectedLibraryTab(page, label) {
  const selected = await page.getByRole('tab', { name: label, exact: true }).getAttribute('aria-selected')
  assert.equal(selected, 'true', `创作库标签未切换：${label}`)
}
