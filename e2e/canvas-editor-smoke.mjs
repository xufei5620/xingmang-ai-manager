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
const fixtureAudioAssetId = 'B'.repeat(43)
const fixtureVideoAssetId = 'C'.repeat(43)
const fixtureAudioPath = path.join(projectRoot, 'output', 'user-36', '2026-08-14', '8月14日.wav')
const fixtureVideoPath = path.join(projectRoot, 'output', 'user-36', '2026-08-14', '视频1.mp4')
const fixturePng = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA5SURBVBhXDcghAQAhAEPRxVkXzNXALAQNZjBXg37wxTNP/vYdCAp5EggKeREICvknEBTyIRD07PsAwFYxB4euEicAAAAASUVORK5CYII='
const viewports = [
  { name: 'compact', width: 960, height: 620 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1590, height: 875 },
  { name: '4k', width: 3840, height: 2160 },
]

await fs.rm(artifactRoot, { recursive: true, force: true })
await fs.mkdir(fixtureRoot, { recursive: true })
await fs.access(canvasIndex)
await fs.access(fixtureAudioPath)
await fs.access(fixtureVideoPath)
await fs.writeFile(fixturePreload, `
const { contextBridge } = require('electron')
const assetId = ${JSON.stringify(fixtureAssetId)}
const audioAssetId = ${JSON.stringify(fixtureAudioAssetId)}
const videoAssetId = ${JSON.stringify(fixtureVideoAssetId)}
const localUrl = 'xingmang-asset://image/' + assetId
let asset = {
  assetId,
  localUrl,
  thumbnailUrl: localUrl,
  mimeType: 'image/png',
  width: 800,
  height: 1000,
  fileName: 'visual-fixture.png',
  displayName: 'visual-fixture.png',
  createdAt: '2026-08-13T00:00:00.000Z',
  mediaType: 'image',
}
const audioAsset = {
  assetId: audioAssetId,
  localUrl: 'xingmang-asset://audio/' + audioAssetId,
  thumbnailUrl: 'xingmang-asset://audio/' + audioAssetId,
  mimeType: 'audio/wav',
  fileName: '8月14日.wav',
  displayName: '8月14日.wav',
  createdAt: '2026-08-14T00:01:00.000Z',
  mediaType: 'audio',
  durationSeconds: 2.113016,
}
const videoAsset = {
  assetId: videoAssetId,
  localUrl: 'xingmang-asset://video/' + videoAssetId,
  thumbnailUrl: 'xingmang-asset://video/' + videoAssetId,
  mimeType: 'video/mp4',
  fileName: '视频1.mp4',
  displayName: '视频1.mp4',
  createdAt: '2026-08-14T00:02:00.000Z',
  mediaType: 'video',
  width: 448,
  height: 672,
  durationSeconds: 5.041667,
}
let projects = []
let nextProjectId = 1
const emptyWorkflow = (name) => JSON.stringify({
  schemaVersion: 2,
  name,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
})
let startRunCallCount = 0
contextBridge.exposeInMainWorld('xingmangCanvasHost', {
  listGroups: async () => [
    { name: '生图分组', ratio: 1 },
    { name: 'grok', ratio: 1.2 },
  ],
  prepareGroup: async (group) => ({
    group,
    models: group === 'grok'
      ? [
          'grok-imagine-image-2.0', 'grok-imagine-video', 'grok-imagine-video-1.5',
          'minimax-h3-mini', 'minimax-h3-fast', 'minimax-h3-base',
        ]
      : ['gpt-image-2', 'gpt-image-1', 'jimeng_high_aes_general_v21_L'],
    keyCreated: false,
  }),
  listAssets: async (query = {}) => {
    const items = query.mediaType === 'image' ? [asset]
      : query.mediaType === 'audio' ? [audioAsset]
        : query.mediaType === 'video' ? [videoAsset] : [videoAsset, audioAsset, asset]
    return { items, offset: query.offset || 0, limit: query.limit || 24, total: items.length, hasMore: false }
  },
  listPromptPresets: async () => [],
  listRuns: async () => [],
  startRun: async () => {
    startRunCallCount += 1
    return { runId: 'smoke-run', graphRevision: 'smoke-revision' }
  },
  getStartRunCallCount: () => startRunCallCount,
  onRunEvent: () => undefined,
  showAssetMenu: async () => undefined,
  renameAsset: async ({ assetId: requestedAssetId, displayName }) => {
    if (requestedAssetId !== asset.assetId) throw new Error('素材不存在')
    asset = { ...asset, displayName }
    return { assetId: requestedAssetId, displayName }
  },
  inspectAssetReferences: async (requestedAssetId, currentProjectContent) => {
    const current = JSON.parse(currentProjectContent)
    const currentNodeIds = current.nodes.filter((node) => JSON.stringify(node.data).includes(requestedAssetId)).map((node) => node.id)
    const savedProjects = projects.filter((project) => project.content.includes(requestedAssetId)).map((project) => ({
      projectId: project.summary.id,
      projectName: project.summary.name,
      nodeIds: JSON.parse(project.content).nodes.filter((node) => JSON.stringify(node.data).includes(requestedAssetId)).map((node) => node.id),
      archived: Boolean(project.summary.archivedAt),
    }))
    return {
      assetId: requestedAssetId,
      inUse: currentNodeIds.length > 0 || savedProjects.length > 0,
      currentProject: { projectId: projects[0]?.summary.id || 'project', projectName: current.name, nodeIds: currentNodeIds },
      projects: savedProjects,
      runs: [],
    }
  },
  pickAsset: async () => asset,
  importAssetFile: async (file) => {
    const name = typeof file?.name === 'string' ? file.name.toLowerCase() : ''
    if (name.endsWith('.mp4')) return videoAsset
    if (name.endsWith('.wav')) return audioAsset
    return asset
  },
  listProjects: async () => projects.map((project) => project.summary),
  createProject: async (name) => {
    const now = new Date().toISOString()
    const project = {
      summary: {
        id: nextProjectId++ === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
        name, createdAt: now, updatedAt: now, lastOpenedAt: now, nodeCount: 0, assetCount: 0,
        workspaceName: name, workspaceConfigured: true, workspaceStatus: 'ready',
      },
      content: emptyWorkflow(name),
    }
    projects = [project, ...projects]
    return { project: project.summary, content: project.content }
  },
  openProject: async (projectId) => {
    const project = projects.find((entry) => entry.summary.id === projectId)
    if (!project) throw new Error('项目不存在')
    project.summary = { ...project.summary, lastOpenedAt: new Date().toISOString() }
    return { project: project.summary, content: project.content }
  },
  saveProject: async (projectId, content) => {
    const project = projects.find((entry) => entry.summary.id === projectId)
    if (!project) throw new Error('项目不存在')
    const parsed = JSON.parse(content)
    const acceptedAssets = parsed.nodes.map((node) => node.data?.result?.assetId).filter(Boolean)
    const previewResult = parsed.nodes.map((node) => node.data?.result).find((result) => result?.assetId && result?.kind)
    project.content = content
    project.summary = {
      ...project.summary,
      name: parsed.name,
      updatedAt: new Date().toISOString(),
      nodeCount: parsed.nodes.length,
      assetCount: new Set(acceptedAssets).size,
      ...(previewResult ? { previewAsset: { kind: previewResult.kind, assetId: previewResult.assetId, localUrl: previewResult.localUrl } } : {}),
    }
    return project.summary
  },
  renameProject: async (projectId, name) => {
    const project = projects.find((entry) => entry.summary.id === projectId)
    if (!project) throw new Error('项目不存在')
    const parsed = JSON.parse(project.content)
    parsed.name = name
    project.content = JSON.stringify(parsed)
    project.summary = { ...project.summary, name, updatedAt: new Date().toISOString() }
    return project.summary
  },
  duplicateProject: async (projectId, name) => {
    const source = projects.find((entry) => entry.summary.id === projectId)
    if (!source) throw new Error('项目不存在')
    const now = new Date().toISOString()
    const parsed = JSON.parse(source.content)
    parsed.name = name
    const duplicate = {
      content: JSON.stringify(parsed),
      summary: {
        ...source.summary,
        id: nextProjectId++ === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
        name, createdAt: now, updatedAt: now, lastOpenedAt: now, workspaceName: name,
      },
    }
    projects = [duplicate, ...projects]
    return { project: duplicate.summary, content: duplicate.content }
  },
  setProjectArchived: async (projectId, archived) => {
    const project = projects.find((entry) => entry.summary.id === projectId)
    if (!project) throw new Error('项目不存在')
    const { archivedAt: _archivedAt, ...summary } = project.summary
    project.summary = archived ? { ...summary, archivedAt: new Date().toISOString() } : summary
    return project.summary
  },
})
`, 'utf8')
await fs.writeFile(fixtureMain, `
const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

protocol.registerSchemesAsPrivileged([{ scheme: 'xingmang-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

app.whenReady().then(async () => {
  protocol.handle('xingmang-asset', async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'image' && url.pathname === '/${fixtureAssetId}') {
      return new Response(Buffer.from(${JSON.stringify(fixturePng)}, 'base64'), { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png' } })
    }
    const sourcePath = url.hostname === 'audio' && url.pathname === '/${fixtureAudioAssetId}'
      ? ${JSON.stringify(fixtureAudioPath)}
      : url.hostname === 'video' && url.pathname === '/${fixtureVideoAssetId}'
        ? ${JSON.stringify(fixtureVideoPath)}
        : null
    if (!sourcePath) return new Response(null, { status: 404 })
    const contentType = url.hostname === 'video' ? 'video/mp4' : 'audio/wav'
    const source = fs.readFileSync(sourcePath)
    const range = request.headers.get('range')
    if (!range) return new Response(source, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': contentType, 'Content-Length': String(source.length), 'Accept-Ranges': 'bytes' } })
    const match = range.match(/^bytes=(\\d*)-(\\d*)$/)
    if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + source.length } })
    const start = match[1] ? Number(match[1]) : Math.max(0, source.length - Number(match[2]))
    const end = match[1] ? Math.min(source.length - 1, match[2] ? Number(match[2]) : source.length - 1) : source.length - 1
    const body = source.subarray(start, end + 1)
    return new Response(body, { status: 206, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': contentType, 'Content-Length': String(body.length), 'Content-Range': 'bytes ' + start + '-' + end + '/' + source.length, 'Accept-Ranges': 'bytes' } })
  })
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

const result = { viewports: [], scaledViewports: [], externalRequests: [], consoleErrors: [], pageErrors: [] }

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
  await page.locator('.canvas-project-center').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await page.getByText('还没有画布项目', { exact: true }).count(), 1, '首次进入没有显示项目中心空状态')
  await page.screenshot({ path: path.join(artifactRoot, 'project-center-960x620.png') })
  await page.getByRole('textbox', { name: '新项目名称' }).fill('视觉回归项目')
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.locator('.canvas-app').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await page.getByText('视觉回归项目', { exact: true }).count(), 1, '项目名称没有进入画布顶栏')
  const mediaConfigurationTrigger = page.getByRole('button', { name: '生成配置', exact: true })
  await mediaConfigurationTrigger.click()
  const mediaConfiguration = page.getByRole('dialog', { name: '画布生成配置' })
  await mediaConfiguration.waitFor({ state: 'visible' })
  assert.equal(await mediaConfiguration.getByRole('combobox').count(), 2, '生成配置应分别提供生图与视频分组')
  await page.waitForFunction(() => document.querySelector('.canvas-media-config-panel')?.textContent?.includes('Grok Imagine Video'))
  assert.equal(await mediaConfiguration.evaluate((element) => element.contains(document.activeElement)), true, '打开配置后焦点应位于弹层内部')
  await page.keyboard.press('Escape')
  await mediaConfiguration.waitFor({ state: 'hidden' })
  assert.equal(await mediaConfigurationTrigger.evaluate((element) => element === document.activeElement), true, 'Escape 关闭配置后应把焦点还给触发按钮')
  await mediaConfigurationTrigger.click()
  await mediaConfiguration.waitFor({ state: 'visible' })
  const outsideTarget = page.getByRole('button', { name: '节点', exact: true })
  await outsideTarget.click()
  await mediaConfiguration.waitFor({ state: 'hidden' })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await outsideTarget.evaluate((element) => element === document.activeElement), true, '点击弹层外部控件后不应把焦点抢回生成配置按钮')
  await mediaConfigurationTrigger.click()
  await mediaConfiguration.waitFor({ state: 'visible' })
  const mediaConfigurationBounds = await mediaConfiguration.boundingBox()
  assert.ok(mediaConfigurationBounds, '生成配置弹层缺少可见边界')
  assert.ok(mediaConfigurationBounds.x >= 0 && mediaConfigurationBounds.y >= 0, '生成配置弹层超出窗口左侧或顶部')
  assert.ok(mediaConfigurationBounds.x + mediaConfigurationBounds.width <= 960, '生成配置弹层超出紧凑窗口右侧')
  assert.ok(mediaConfigurationBounds.y + mediaConfigurationBounds.height <= 620, '生成配置弹层超出紧凑窗口底部')
  await page.screenshot({ path: path.join(artifactRoot, 'media-configuration-960x620.png') })
  await page.getByRole('button', { name: '关闭生成配置', exact: true }).click()
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1590, 875)
  })
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('button', { name: /插入快速模板/ }).click()
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible', timeout: 10_000 })
  const libraryTabs = ['节点', '提示词', '模板', '素材']
  for (const label of libraryTabs) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expectSelectedLibraryTab(page, label)
  }
  await page.getByRole('button', { name: '提示词', exact: true }).click()
  const beforePromptPreset = await page.locator('.react-flow__node').count()
  await page.getByRole('button', { name: /商品棚拍/ }).click()
  await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__node').length === expected, beforePromptPreset + 1)
  await page.getByRole('button', { name: '节点', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '运行图像生成节点', exact: true }).count(), 1, '图像生成节点缺少可见运行按钮')
  assert.equal(await page.getByRole('button', { name: '运行全部', exact: true }).count(), 1, '顶部应明确表示当前运行范围')
  const videoInputNodesBeforeDrop = await page.locator('.react-flow__node-video-input').count()
  const videoDataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['video fixture'], '文件夹拖入测试.mp4', { type: 'video/mp4' }))
    return transfer
  })
  await page.locator('.react-flow__pane').dispatchEvent('drop', {
    dataTransfer: videoDataTransfer,
    clientX: 680,
    clientY: 360,
  })
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.react-flow__node-video-input').length === expected,
    videoInputNodesBeforeDrop + 1,
  )
  const droppedVideo = page.locator('.react-flow__node-video-input video').last()
  await droppedVideo.evaluate((video) => new Promise((resolve, reject) => {
    if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) return resolve(true)
    const timeout = window.setTimeout(() => reject(new Error('拖入视频元数据读取超时')), 10_000)
    video.addEventListener('loadedmetadata', () => { window.clearTimeout(timeout); resolve(true) }, { once: true })
    video.addEventListener('error', () => { window.clearTimeout(timeout); reject(new Error('拖入视频素材加载失败')) }, { once: true })
    video.load()
  }))
  const droppedVideoRatio = await droppedVideo.evaluate((video) => {
    const rect = video.getBoundingClientRect()
    return { rendered: rect.width / rect.height, source: video.videoWidth / video.videoHeight }
  })
  assert.ok(Math.abs(droppedVideoRatio.rendered - droppedVideoRatio.source) < 0.01, `竖屏视频预览比例错误：${JSON.stringify(droppedVideoRatio)}`)
  assert.equal(await page.locator('.react-flow__node-video-input .media-unavailable').count(), 0, '拖入的 MP4 被误判为不可用素材')
  const droppedVideoAppearance = await mediaNodeAppearance(page.locator('.react-flow__node-video-input').last())
  assert.equal(droppedVideoAppearance.width, 320, '视频素材节点没有使用元数据宽度')
  assert.equal(droppedVideoAppearance.height, 480, '竖屏视频素材节点没有保持原始比例')
  assertPureMediaNode(droppedVideoAppearance, '视频')
  await droppedVideo.evaluate((video) => new Promise((resolve, reject) => {
    video.muted = true
    video.currentTime = 0
    const timeout = window.setTimeout(() => reject(new Error('视频播放进度超时')), 5_000)
    const onTimeUpdate = () => {
      if (video.currentTime <= 0.05) return
      window.clearTimeout(timeout)
      video.removeEventListener('timeupdate', onTimeUpdate)
      resolve(true)
    }
    video.addEventListener('timeupdate', onTimeUpdate)
    void video.play().catch((error) => {
      window.clearTimeout(timeout)
      video.removeEventListener('timeupdate', onTimeUpdate)
      reject(error)
    })
  }))
  assert.ok(await droppedVideo.evaluate((video) => video.currentTime > 0.05), '视频素材无法在画布节点内预览播放')
  await droppedVideo.evaluate((video) => video.pause())

  const beforeContextCreate = await page.locator('.react-flow__node').count()
  const panePoint = await findEmptyPanePoint(page)
  await page.mouse.click(panePoint.x, panePoint.y, { button: 'right' })
  const contextQuickInsert = page.getByRole('dialog', { name: '快速创建' })
  await contextQuickInsert.waitFor({ state: 'visible' })
  await contextQuickInsert.getByRole('combobox', { name: '搜索现有节点、新节点或命令' }).fill('便签')
  await page.keyboard.press('Enter')
  await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__node').length === expected, beforeContextCreate + 1)
  assert.equal(await page.locator('.react-flow__node-note').count(), 1, '画布右键菜单没有创建便签节点')
  await page.getByRole('button', { name: '快速创建', exact: true }).click()
  const quickInsert = page.getByRole('dialog', { name: '快速创建' })
  await quickInsert.waitFor({ state: 'visible' })
  await quickInsert.getByRole('combobox').fill('图像生成')
  assert.ok(await quickInsert.getByRole('option', { name: /图像生成/ }).count() >= 1, '快速创建无法搜索节点')
  await page.screenshot({ path: path.join(artifactRoot, 'quick-insert-1590x875.png') })
  await page.keyboard.press('Escape')
  await quickInsert.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '快速创建', exact: true }).evaluate((element) => element === document.activeElement), true, '快速创建关闭后应恢复触发按钮焦点')
  const runScopeTrigger = page.getByRole('button', { name: '选择运行范围', exact: true })
  await runScopeTrigger.click()
  const runScopeMenu = page.getByRole('menu', { name: '运行范围' })
  assert.equal(await runScopeMenu.getByRole('menuitemradio').count(), 4, '运行范围菜单应提供四种范围')
  assert.equal(await runScopeMenu.getByRole('menuitemradio', { name: /运行全部/ }).getAttribute('aria-checked'), 'true')
  assert.equal(await runScopeMenu.evaluate((element) => element.contains(document.activeElement)), true, '运行范围菜单打开后应聚焦有效选项')
  await page.keyboard.press('Escape')
  await runScopeMenu.waitFor({ state: 'hidden' })
  assert.equal(await runScopeTrigger.evaluate((element) => element === document.activeElement), true, '运行范围菜单关闭后应恢复触发按钮焦点')
  await page.locator('.node-library-item').filter({ hasText: '图片素材' }).click()
  assert.ok(await page.getByRole('button', { name: '从文件选择', exact: true }).count() >= 1, '图片素材节点缺少文件选择入口')
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('button', { name: /打开素材库/ }).click()
  const fixtureAsset = page.getByRole('article', { name: /visual-fixture\.png/ })
  await fixtureAsset.waitFor({ state: 'visible' })
  await fixtureAsset.locator('.asset-tray-item-preview').click()
  const fixtureDetails = fixtureAsset.locator('.asset-tray-item-details')
  await fixtureDetails.waitFor({ state: 'visible' })
  assert.equal(await fixtureDetails.getByText('图片 · image/png', { exact: true }).count(), 1, '图片详情缺少类型')
  assert.equal(await fixtureDetails.getByText('800 × 1000', { exact: true }).count(), 1, '图片详情缺少分辨率')
  assert.equal(await fixtureDetails.locator('dd').filter({ hasText: 'visual-fixture.png' }).count(), 1, '图片详情缺少原文件名')
  assert.equal(await fixtureDetails.getByText(fixtureAssetId, { exact: true }).count(), 1, '图片详情缺少稳定资产 ID')
  await page.locator('.asset-tray > header').hover()
  await fixtureDetails.waitFor({ state: 'detached' })
  await page.waitForTimeout(160)
  const hiddenToolStyle = await fixtureAsset.locator('.asset-tray-item-tools').evaluate((element) => {
    const style = getComputedStyle(element)
    return { opacity: style.opacity, pointerEvents: style.pointerEvents }
  })
  assert.deepEqual(hiddenToolStyle, { opacity: '0', pointerEvents: 'none' }, '鼠标移出后素材操作没有恢复默认隐藏态')
  await fixtureAsset.locator('.asset-tray-item-preview').click()
  await fixtureDetails.waitFor({ state: 'visible' })
  await fixtureAsset.dragTo(page.locator('.wf-drop-target').last())
  const importedPreview = page.locator('.react-flow__node-image-input .wf-preview').last()
  await importedPreview.waitFor({ state: 'visible' })
  await importedPreview.dblclick()
  await page.getByRole('dialog', { name: '图片预览' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '关闭媒体预览' }).click()
  await fixtureAsset.locator('.asset-tray-item-preview').click()
  await fixtureDetails.waitFor({ state: 'visible' })
  await fixtureAsset.locator('.asset-tray-item-detail-head').getByRole('button', { name: '重命名素材：visual-fixture.png' }).click()
  const renameDialog = page.getByRole('dialog', { name: '重命名素材' })
  await renameDialog.getByRole('textbox', { name: '显示名称' }).fill('产品主视觉')
  await renameDialog.getByRole('button', { name: '保存', exact: true }).click()
  await renameDialog.waitFor({ state: 'detached' })
  await page.getByText('产品主视觉', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '刷新资产' }).click()
  const renamedAsset = page.getByRole('article', { name: /产品主视觉/ })
  await renamedAsset.waitFor({ state: 'visible' })
  await renamedAsset.locator('.asset-tray-item-preview').click()
  assert.equal(await renamedAsset.getByText('visual-fixture.png', { exact: true }).count(), 1, '重命名错误修改了原文件名')
  assert.equal(await renamedAsset.getByText(fixtureAssetId, { exact: true }).count(), 1, '重命名错误修改了资产 ID')
  await renamedAsset.getByRole('button', { name: '检查素材引用：产品主视觉' }).click()
  const referenceDialog = page.getByRole('dialog', { name: '素材引用检查' })
  await referenceDialog.waitFor({ state: 'visible' })
  assert.equal(await referenceDialog.getByText('素材仍被工作流引用', { exact: true }).count(), 1, '引用检查没有识别当前画布中的素材节点')
  assert.equal(await referenceDialog.getByText('本版本不会删除该素材', { exact: false }).count(), 1, '引用检查没有明确只读删除保护')
  await page.screenshot({ path: path.join(artifactRoot, 'asset-reference-guard.png') })
  await referenceDialog.getByRole('button', { name: '关闭', exact: true }).click()
  const imageNodesBeforeDuplicateReference = await page.locator('.react-flow__node-image-input').count()
  await renamedAsset.hover()
  await renamedAsset.getByRole('button', { name: '添加资产到画布：产品主视觉' }).click()
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.react-flow__node-image-input').length === expected,
    imageNodesBeforeDuplicateReference + 1,
  )
  const audioFixture = page.getByRole('article', { name: /8月14日\.wav/ })
  await audioFixture.locator('.asset-tray-item-preview').click()
  assert.equal(await audioFixture.getByText('音频 · audio/wav', { exact: true }).count(), 1, '音频详情缺少类型')
  assert.equal(await audioFixture.getByText('0:02', { exact: true }).count(), 1, '音频详情缺少时长')
  await audioFixture.hover()
  await audioFixture.getByRole('button', { name: '添加资产到画布：8月14日.wav' }).click()
  const audioPreview = page.locator('.react-flow__node-audio-input audio').last()
  await page.locator('.react-flow__node-audio-input .media-audio-player').last().waitFor({ state: 'visible' })
  await audioPreview.evaluate((audio) => new Promise((resolve, reject) => {
    if (audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) return resolve(true)
    const timeout = window.setTimeout(() => reject(new Error('音频元数据读取超时')), 10_000)
    audio.addEventListener('loadedmetadata', () => { window.clearTimeout(timeout); resolve(true) }, { once: true })
    audio.addEventListener('error', () => { window.clearTimeout(timeout); reject(new Error('音频素材加载失败')) }, { once: true })
    audio.load()
  }))
  const audioNode = page.locator('.react-flow__node-audio-input').last()
  const audioAppearance = await mediaNodeAppearance(audioNode)
  assert.equal(audioAppearance.width, 360, '音频素材节点宽度不稳定')
  assert.equal(audioAppearance.height, 104, '音频素材节点高度不稳定')
  assertPureMediaNode(audioAppearance, '音频')
  const decodedWaveform = audioNode.locator('.media-audio-waveform:not(.is-fallback)')
  await decodedWaveform.waitFor({ state: 'visible', timeout: 10_000 })
  const waveformPath = await decodedWaveform.locator('.media-audio-waveform-base').getAttribute('d')
  const waveformYValues = [...new Set((waveformPath?.match(/L [\d.]+ ([\d.]+)/g) ?? []).map((entry) => entry.split(' ')[2]))]
  assert.ok(waveformYValues.length > 4, '音频波形没有使用真实音频振幅')
  await audioNode.getByRole('button', { name: '播放音频' }).click()
  await page.waitForFunction((nodeId) => {
    const audio = document.querySelector(`.react-flow__node[data-id="${nodeId}"] audio`)
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.05
  }, await audioNode.getAttribute('data-id'))
  await audioNode.getByRole('button', { name: '暂停音频' }).click()
  await page.locator('.react-flow__node-audio-input').last().getByRole('button', { name: '放大音频预览' }).click()
  await page.getByRole('dialog', { name: '音频预览' }).waitFor({ state: 'visible' })
  assert.equal(await page.getByText('音频预览', { exact: true }).count(), 1, '音频双击没有进入大预览')
  await page.getByRole('button', { name: '关闭媒体预览' }).click()
  await page.getByRole('button', { name: '关闭资产栏' }).click()
  await page.getByRole('button', { name: '自动布局', exact: true }).click()
  await page.waitForTimeout(250)
  const assetNodeGeometry = await page.locator('.react-flow__node-image-input').last().evaluate((element) => {
    return { width: element.clientWidth, height: element.clientHeight }
  })
  assert.ok(Math.abs(assetNodeGeometry.width - 280) < 1, '图片素材节点宽度没有按素材比例约束')
  assert.ok(Math.abs(assetNodeGeometry.height - 350) < 1, '4:5 图片素材节点没有保持原始比例')
  assertPureMediaNode(await mediaNodeAppearance(page.locator('.react-flow__node-image-input').last()), '图片')

  const imageGenerateNode = page.locator('.react-flow__node-image-generate').first()
  const imageGenerateNodeId = await imageGenerateNode.getAttribute('data-id')
  assert.ok(imageGenerateNodeId, '图像生成节点缺少稳定标识')
  await page.locator('.react-flow__pane').click({ position: { x: 18, y: 18 } })
  assert.equal(await page.locator('.react-flow__node.selected').count(), 0, '搜索定位前未清空节点选择')
  const startRunCallsBeforeLocate = await page.evaluate(() => window.xingmangCanvasHost.getStartRunCallCount())
  await page.keyboard.press('Control+K')
  const existingNodeSearch = page.getByRole('dialog', { name: '快速创建' })
  await existingNodeSearch.waitFor({ state: 'visible' })
  await existingNodeSearch.getByRole('combobox', { name: '搜索现有节点、新节点或命令' }).fill(imageGenerateNodeId)
  const existingNodeOption = existingNodeSearch.getByRole('option').filter({ hasText: imageGenerateNodeId })
  assert.equal(await existingNodeOption.count(), 1, '命令面板没有按节点 ID 找到现有节点')
  await page.keyboard.press('Enter')
  await existingNodeSearch.waitFor({ state: 'hidden' })
  const nodeInspector = page.getByLabel('统一检查器')
  await nodeInspector.waitFor({ state: 'visible' })
  await page.waitForTimeout(280)
  assert.equal(await page.locator('.react-flow__node.selected').count(), 1, '搜索定位后没有单选目标节点')
  assert.equal(await imageGenerateNode.getAttribute('class').then((value) => value?.includes('selected')), true, '搜索定位选中了错误节点')
  const locatedGeometry = await Promise.all([
    imageGenerateNode.boundingBox(),
    page.locator('.react-flow').boundingBox(),
  ])
  assert.ok(locatedGeometry[0] && locatedGeometry[1], '搜索定位后缺少节点或画布边界')
  const nodeCenterX = locatedGeometry[0].x + locatedGeometry[0].width / 2
  const nodeCenterY = locatedGeometry[0].y + locatedGeometry[0].height / 2
  const flowCenterX = locatedGeometry[1].x + locatedGeometry[1].width / 2
  const flowCenterY = locatedGeometry[1].y + locatedGeometry[1].height / 2
  assert.ok(Math.abs(nodeCenterX - flowCenterX) <= locatedGeometry[1].width * 0.25, '搜索定位后节点没有水平居中')
  assert.ok(Math.abs(nodeCenterY - flowCenterY) <= locatedGeometry[1].height * 0.25, '搜索定位后节点没有垂直居中')
  assert.equal(await page.evaluate(() => window.xingmangCanvasHost.getStartRunCallCount()), startRunCallsBeforeLocate, '搜索定位错误触发了画布运行')
  assert.equal(await nodeInspector.getByLabel('节点参数').count(), 1, '节点检查器缺少参数区')
  assert.equal(await nodeInspector.getByLabel('节点端口').getByText('输入·文本', { exact: true }).count(), 1, '节点检查器缺少输入端口')
  assert.equal(await nodeInspector.getByRole('button', { name: '运行此节点' }).count(), 1, '节点检查器缺少单节点运行操作')
  await page.screenshot({ path: path.join(artifactRoot, 'node-inspector-1590x875.png') })
  await nodeInspector.getByRole('button', { name: '关闭节点检查器' }).click()
  await nodeInspector.waitFor({ state: 'hidden' })
  await page.waitForTimeout(120)
  assert.equal(await nodeInspector.count(), 0, '检查器关闭后在选择未变时自动重开')
  const qualityOptions = await imageGenerateNode.locator('select[aria-label="生成画质"] option').allTextContents()
  assert.deepEqual(qualityOptions, ['低', '中', '高'], '图像画质选项应只显示档位')
  assert.equal(/[¥$元]|quota|价格/i.test(qualityOptions.join(' ')), false, '图像画质仍显示价格估算')
  const imageSizeOptions = await imageGenerateNode.locator('select[aria-label="生成尺寸"] option').allTextContents()
  assert.ok(imageSizeOptions.includes('1:1 · 1024x1024'), '图片比例缺少 1:1')
  assert.ok(imageSizeOptions.includes('16:9 · 1280x720'), '图片比例缺少 16:9')
  await imageGenerateNode.locator('select[aria-label="生成尺寸"]').selectOption('1280x720')

  const beforeVideoGenerate = await page.locator('.react-flow__node-video-generate').count()
  await page.locator('.node-library-item').filter({ hasText: '视频生成' }).click()
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.react-flow__node-video-generate').length === expected,
    beforeVideoGenerate + 1,
  )
  const videoTargetId = await page.locator('.react-flow__node-video-generate').last().getAttribute('data-id')
  assert.ok(videoTargetId, '视频生成节点缺少稳定标识')
  const videoTarget = page.locator(`.react-flow__node[data-id="${videoTargetId}"]`)
  const videoRatioOptions = await videoTarget.locator('select[aria-label="视频比例"] option').allTextContents()
  assert.deepEqual(videoRatioOptions, ['16:9 · 横屏', '9:16 · 竖屏', '1:1 · 方形', '4:3 · 横屏', '3:4 · 竖屏'], '视频比例选项不完整')
  await videoTarget.locator('select[aria-label="视频比例"]').selectOption('720x1280')
  await videoTarget.locator('select[aria-label="视频模型"]').selectOption('minimax-h3-base')
  assert.equal(await videoTarget.locator('select[aria-label="MiniMax 生成模式"] option').count(), 6, 'MiniMax 缺少自动或显式生成模式')
  assert.deepEqual(
    await videoTarget.locator('select[aria-label="MiniMax 视频分辨率"] option').allTextContents(),
    ['480p · 省成本', '720p · 高清'],
    'MiniMax 分辨率选项不完整',
  )
  assert.equal(await videoTarget.locator('select[aria-label="MiniMax 视频比例"] option').count(), 9, 'MiniMax 比例选项不完整')
  assert.equal(await videoTarget.locator('select[aria-label="视频时长"] option').count(), 11, 'MiniMax 时长应覆盖 5 至 15 秒')
  assert.equal(await videoTarget.getByText('AI 优化 H3 提示词', { exact: true }).count(), 1, 'MiniMax 缺少提示词优化开关')
  await videoTarget.locator('select[aria-label="MiniMax 生成模式"]').selectOption('ref2va')
  await videoTarget.locator('select[aria-label="MiniMax 视频分辨率"]').selectOption('480p')
  await videoTarget.locator('select[aria-label="MiniMax 视频比例"]').selectOption('9:16')
  await videoTarget.getByText('AI 优化 H3 提示词', { exact: true }).locator('..').locator('input').check()

  const beforeImageEdit = await page.locator('.react-flow__node-image-edit').count()
  await page.locator('.node-library-item').filter({ hasText: '图像编辑' }).click()
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.react-flow__node-image-edit').length === expected,
    beforeImageEdit + 1,
  )
  const imageEditId = await page.locator('.react-flow__node-image-edit').last().getAttribute('data-id')
  assert.ok(imageEditId, '图像编辑节点缺少稳定标识')
  const imageEditTarget = page.locator(`.react-flow__node[data-id="${imageEditId}"]`)
  assert.equal(await imageEditTarget.locator('.react-flow__handle[data-handleid="in:images"]').count(), 1, '图像编辑缺少多图片输入端口')
  assert.equal(await imageEditTarget.locator('.react-flow__handle[data-handleid="in:videos"]').count(), 0, '图像编辑不应提供视频输入端口')
  assert.equal(await imageEditTarget.locator('.react-flow__handle[data-handleid="in:audios"]').count(), 0, '图像编辑不应提供音频输入端口')
  assert.equal(await videoTarget.locator('.react-flow__handle[data-handleid="in:images"]').count(), 1, '视频生成缺少多图片输入端口')
  assert.equal(await videoTarget.locator('.react-flow__handle[data-handleid="in:videos"]').count(), 1, '视频生成缺少多视频输入端口')
  assert.equal(await videoTarget.locator('.react-flow__handle[data-handleid="in:audios"]').count(), 1, '视频生成缺少多音频输入端口')

  await page.getByRole('button', { name: '自动布局', exact: true }).click()
  await page.waitForTimeout(240)
  await page.getByRole('banner').getByRole('button', { name: '适配全部内容', exact: true }).click()
  await page.waitForTimeout(240)
  const imageSources = page.locator('.react-flow__node-image-input')
  const imageSource = imageSources.last()
  const secondImageSource = imageSources.nth((await imageSources.count()) - 2)
  const videoSource = page.locator('.react-flow__node-video-input').last()
  const audioSource = page.locator('.react-flow__node-audio-input').last()
  await page.locator('.react-flow__pane').click({ position: { x: 18, y: 18 } })
  const connectionNodes = [imageSource, secondImageSource, videoSource, audioSource, imageGenerateNode, videoTarget, imageEditTarget]
  for (const [index, node] of connectionNodes.entries()) {
    await node.click({ position: { x: 8, y: 8 }, modifiers: index === 0 ? [] : ['Control'] })
  }
  await page.getByLabel('画布导航').getByRole('button', { name: '聚焦选中节点' }).click()
  await page.waitForTimeout(240)
  await connectCanvasNodes(page, imageSource, 'out:image', videoTarget, 'in:images')
  await connectCanvasNodes(page, secondImageSource, 'out:image', videoTarget, 'in:images')
  await connectCanvasNodes(page, videoSource, 'out:video', videoTarget, 'in:videos')
  await connectCanvasNodes(page, audioSource, 'out:audio', videoTarget, 'in:audios')
  await page.getByRole('banner').getByRole('button', { name: '适配全部内容', exact: true }).click()
  await page.waitForTimeout(240)
  await connectCanvasNodes(page, imageGenerateNode, 'out:image', videoTarget, 'in:images')
  await connectCanvasNodes(page, imageEditTarget, 'out:image', videoTarget, 'in:images')
  await connectCanvasNodes(page, imageSource, 'out:image', imageEditTarget, 'in:images')
  await connectCanvasNodes(page, secondImageSource, 'out:image', imageEditTarget, 'in:images')
  await videoTarget.locator('.wf-upstream-reference').nth(5).waitFor({ state: 'visible' })
  assert.equal(await videoTarget.locator('.wf-upstream-reference.is-image').count(), 4, '视频生成没有显示素材图片和生成节点的多图片上游')
  assert.equal(await videoTarget.locator('.wf-upstream-reference.is-video').count(), 1, '视频生成没有显示上游视频')
  assert.equal(await videoTarget.locator('.wf-upstream-reference.is-audio').count(), 1, '视频生成没有显示上游音频')
  assert.equal(await videoTarget.getByText('等待上游产物', { exact: true }).count(), 2, '图像生成或图像编辑节点没有作为等待产物的上游参考显示')
  assert.equal(await imageEditTarget.locator('.wf-upstream-reference.is-image').count(), 2, '图像编辑没有显示多张上游图片')
  assert.equal(await imageEditTarget.locator('.wf-upstream-reference.is-video, .wf-upstream-reference.is-audio').count(), 0, '图像编辑错误显示了视频或音频参考')
  const videoPrompt = videoTarget.locator('textarea[aria-label="视频生成提示词"]')
  await videoPrompt.fill('@')
  const mentionMenu = videoTarget.getByRole('listbox', { name: '已连接的上游素材' })
  await mentionMenu.waitFor({ state: 'visible' })
  assert.equal(await mentionMenu.getByRole('option').count(), 6, '@ 菜单没有列出图片、视频、音频和生成节点上游')
  const secondMention = await mentionMenu.getByRole('option').nth(1).locator('small').textContent()
  await videoPrompt.press('ArrowDown')
  await videoPrompt.press('Enter')
  assert.ok(secondMention && (await videoPrompt.inputValue()).includes(secondMention), '@ 菜单没有把键盘选中的素材插入提示词')
  await mentionMenu.waitFor({ state: 'detached' })

  const beforeAutoConnectNodes = await page.locator('.react-flow__node').count()
  const beforeAutoConnectEdges = await page.locator('.react-flow__edge').count()
  const emptyConnectionPoint = await findEmptyPanePoint(page)
  await dragHandleToPoint(page, imageSource, 'out:image', emptyConnectionPoint)
  const compatibleQuickInsert = page.getByRole('dialog', { name: '快速创建' })
  await compatibleQuickInsert.waitFor({ state: 'visible' })
  const compatibleSearch = compatibleQuickInsert.getByRole('combobox', { name: '搜索可连接节点' })
  await compatibleSearch.fill('视频生成')
  assert.equal(await compatibleQuickInsert.getByRole('option', { name: /视频生成/ }).count(), 1, '拖线落空没有提供兼容的视频生成节点')
  assert.equal(await compatibleQuickInsert.getByRole('option', { name: /提示词/ }).count(), 0, '拖线落空错误显示了不兼容节点')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    ({ nodes, edges }) => document.querySelectorAll('.react-flow__node').length === nodes && document.querySelectorAll('.react-flow__edge').length === edges,
    { nodes: beforeAutoConnectNodes + 1, edges: beforeAutoConnectEdges + 1 },
  )
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.waitForFunction(
    ({ nodes, edges }) => document.querySelectorAll('.react-flow__node').length === nodes && document.querySelectorAll('.react-flow__edge').length === edges,
    { nodes: beforeAutoConnectNodes, edges: beforeAutoConnectEdges },
  )
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await page.waitForFunction(
    ({ nodes, edges }) => document.querySelectorAll('.react-flow__node').length === nodes && document.querySelectorAll('.react-flow__edge').length === edges,
    { nodes: beforeAutoConnectNodes + 1, edges: beforeAutoConnectEdges + 1 },
  )

  const nodesBeforeEdgeDelete = await page.locator('.react-flow__node').count()
  const edgesBeforeDelete = await page.locator('.react-flow__edge').count()
  await page.locator('.react-flow__edge-interaction').last().click({ force: true })
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__edge.selected').length === 1)
  await page.keyboard.press('Delete')
  await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__edge').length === expected, edgesBeforeDelete - 1)
  assert.equal(await page.locator('.react-flow__node').count(), nodesBeforeEdgeDelete, '删除连线时误删了节点')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__edge').length === expected, edgesBeforeDelete)

  await page.getByRole('banner').getByRole('button', { name: '适配全部内容', exact: true }).click()
  await page.waitForTimeout(240)
  await page.locator('.react-flow__pane').click({ position: { x: 16, y: 16 } })
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
  const selectedCountForFlags = await page.locator('.react-flow__node.selected').count()
  assert.ok(selectedCountForFlags >= 2, '从空白区域拖动没有框选多个节点')
  const activeToastClose = page.getByRole('button', { name: '关闭提示' })
  if (await activeToastClose.count()) await activeToastClose.click()
  const selectionToolbar = page.getByRole('toolbar', { name: '选中节点操作' })
  await selectionToolbar.getByRole('button', { name: '锁定选中节点位置' }).click()
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.react-flow__node.selected .wf-node.wf-is-locked').length === expected,
    selectedCountForFlags,
  )
  assert.equal(await selectionToolbar.getByRole('button', { name: '解锁选中节点位置' }).getAttribute('aria-pressed'), 'true', '批量锁定后工具条状态未更新')
  const disableEligibleCount = await page.locator('.react-flow__node.selected .wf-node:not(.wf-category-structural)').count()
  assert.ok(disableEligibleCount > 0, '批量禁用测试缺少可运行节点')
  await selectionToolbar.getByRole('button', { name: '禁用选中节点' }).click()
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.react-flow__node.selected .wf-node.wf-is-disabled').length === expected,
    disableEligibleCount,
  )
  assert.equal(await selectionToolbar.getByRole('button', { name: '启用选中节点' }).getAttribute('aria-pressed'), 'true', '批量禁用后工具条状态未更新')
  await selectionToolbar.getByRole('button', { name: '启用选中节点' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node.selected .wf-node.wf-is-disabled').length === 0)
  await selectionToolbar.getByRole('button', { name: '解锁选中节点位置' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node.selected .wf-node.wf-is-locked').length === 0)
  await page.getByRole('button', { name: '选择运行范围', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /运行选中链路/ }).click()
  assert.equal(await page.locator('.canvas-run-main').isEnabled(), true, '有选中节点时选中链路应可运行')
  await page.locator('.react-flow__pane').click({ position: { x: 16, y: 16 } })
  assert.equal(await page.locator('.canvas-run-main').isDisabled(), true, '选区失效后主运行按钮仍可点击')
  await page.getByRole('button', { name: '选择运行范围', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /运行全部/ }).click()

  const boundMediaNode = page.locator('.react-flow__node-video-input').last()
  const boundMediaNodeId = await boundMediaNode.getAttribute('data-id')
  assert.ok(boundMediaNodeId, '纯媒体节点缺少稳定标识')
  await page.keyboard.press('Control+K')
  const mediaNodeSearch = page.getByRole('dialog', { name: '快速创建' })
  await mediaNodeSearch.getByRole('combobox', { name: '搜索现有节点、新节点或命令' }).fill(boundMediaNodeId)
  await page.keyboard.press('Enter')
  await mediaNodeSearch.waitFor({ state: 'hidden' })
  const mediaSelectionToolbar = page.getByRole('toolbar', { name: '选中节点操作' })
  await mediaSelectionToolbar.getByRole('button', { name: '锁定选中节点位置' }).click()
  await boundMediaNode.locator('.wf-media-bound.wf-is-locked').waitFor({ state: 'visible' })
  assert.equal(await boundMediaNode.getByText('已锁定', { exact: true }).count(), 1, '纯媒体节点没有显示锁定标记')
  await mediaSelectionToolbar.getByRole('button', { name: '禁用选中节点' }).click()
  await boundMediaNode.locator('.wf-media-bound.wf-is-disabled').waitFor({ state: 'visible' })
  assert.equal(await boundMediaNode.getByText('已禁用', { exact: true }).count(), 1, '纯媒体节点没有显示禁用标记')
  await page.screenshot({ path: path.join(artifactRoot, 'selection-flags-1590x875.png') })
  await mediaSelectionToolbar.getByRole('button', { name: '启用选中节点' }).click()
  await mediaSelectionToolbar.getByRole('button', { name: '解锁选中节点位置' }).click()
  await page.getByLabel('统一检查器').getByRole('button', { name: '关闭节点检查器' }).click()
  await page.locator('.react-flow__pane').click({ position: { x: 16, y: 16 } })
  await page.getByRole('banner').getByRole('button', { name: '适配全部内容', exact: true }).click()
  await page.waitForTimeout(240)

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
        if (Math.abs(red - 14) + Math.abs(green - 16) + Math.abs(blue - 19) > 18) changedFromCanvas += 1
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
    assert.equal(layout.rootBackground, 'rgb(14, 16, 19)')
    assert.equal(layout.bodyBackground, 'rgb(14, 16, 19)')
    assert.equal(pixels.width, viewport.width)
    assert.equal(pixels.height, viewport.height)
    assert.ok(pixels.averageLuminance < 90, `${viewport.name}: 画面不再是暗色系`)
    assert.ok(pixels.veryLightRatio < 0.08, `${viewport.name}: 画面出现大面积亮色`)
    assert.ok(pixels.nonCanvasRatio > 0.02, `${viewport.name}: 画面近似空白`)
    assert.ok(pixels.colorBuckets > 12, `${viewport.name}: 画面色彩层次不足`)

    result.viewports.push({ ...viewport, layout, pixels, screenshotPath })
  }

  await devtools.send('Emulation.clearDeviceMetricsOverride')

  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('button', { name: /打开运行历史/ }).click()
  await page.locator('.run-inspector').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('button', { name: /打开素材库/ }).click()
  await page.locator('.asset-tray').waitFor({ state: 'visible', timeout: 10_000 })

  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(960, 620)
    window.webContents.setZoomFactor(1)
  })
  await page.waitForTimeout(150)
  const compactAssetDrawer = await page.evaluate(() => {
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
      inspector: bounds('.canvas-inspector'),
      tabs: [...document.querySelectorAll('.canvas-inspector-tabs button')].map((button) => {
        const rect = button.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          clipped: button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1,
        }
      }),
    }
  })
  assert.ok(compactAssetDrawer.library && compactAssetDrawer.flow && compactAssetDrawer.assets && compactAssetDrawer.inspector)
  assert.equal(compactAssetDrawer.innerWidth, 960, '紧凑抽屉检查没有使用真实 960px CSS 视口')
  assert.equal(compactAssetDrawer.innerHeight, 620, '紧凑抽屉检查没有使用真实 620px CSS 视口')
  assert.ok(!compactAssetDrawer.runs || compactAssetDrawer.runs.width === 0, '打开素材抽屉后运行面板仍然可见')
  assert.ok(compactAssetDrawer.library.right <= compactAssetDrawer.flow.left + 1)
  assert.ok(compactAssetDrawer.assets.right <= compactAssetDrawer.innerWidth + 1, '素材抽屉越过窗口右边界')
  assert.ok(compactAssetDrawer.assets.left - compactAssetDrawer.flow.left >= 400, '960px 素材抽屉打开时画布可用宽度不足')
  assert.equal(compactAssetDrawer.tabs.length, 3, '紧凑检查器没有保留节点、素材、运行三个页签')
  assert.ok(compactAssetDrawer.tabs.every((tab) => tab.left >= compactAssetDrawer.inspector.left - 1 && tab.right <= compactAssetDrawer.inspector.right + 1), '紧凑检查器页签越过面板边界')
  assert.ok(compactAssetDrawer.tabs.every((tab) => tab.width >= 60 && tab.height >= 26 && !tab.clipped), '紧凑检查器页签文字被裁切或点击区域过小')
  await page.screenshot({ path: path.join(artifactRoot, 'canvas-asset-drawer-960x620.png') })

  await page.locator('.canvas-inspector-tabs').getByRole('button', { name: '运行', exact: true }).click()
  await page.locator('.run-inspector').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.asset-tray').waitFor({ state: 'detached', timeout: 10_000 })
  const compactRunDrawer = await page.evaluate(() => {
    const flow = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    const runs = document.querySelector('.run-inspector')?.getBoundingClientRect()
    return { innerWidth, flow, runs }
  })
  assert.ok(compactRunDrawer.flow && compactRunDrawer.runs)
  assert.ok(compactRunDrawer.runs.right <= compactRunDrawer.innerWidth + 1, '运行抽屉越过窗口右边界')
  assert.ok(compactRunDrawer.runs.left - compactRunDrawer.flow.left >= 400, '960px 运行抽屉打开时画布可用宽度不足')
  await page.screenshot({ path: path.join(artifactRoot, 'canvas-run-drawer-960x620.png') })

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
      toolbarHeight: document.querySelector('.canvas-toolbar')?.getBoundingClientRect().height ?? 0,
      toolbarControlsOutsideViewport: [...document.querySelectorAll('.canvas-toolbar button, .canvas-toolbar select')]
        .filter((element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.display !== 'none' && rect.width > 0 && rect.height > 0
            && (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1
              || element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
        })
        .map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim()),
      coreToolbarCommands: ['快速创建', '生成配置', '更多操作', '选择运行范围'].map((label) => {
        const element = document.querySelector(`.canvas-toolbar [aria-label="${label}"]`)
        const rect = element?.getBoundingClientRect()
        const style = element ? getComputedStyle(element) : null
        return {
          label,
          visible: Boolean(element && rect && style?.display !== 'none' && rect.width > 0 && rect.height > 0
            && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1),
          rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
        }
      }),
      runMainVisible: (() => {
        const element = document.querySelector('.canvas-run-main')
        const rect = element?.getBoundingClientRect()
        return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= innerWidth + 1)
      })(),
      visibleNodes: [...document.querySelectorAll('.react-flow__node')]
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        }).length,
    }))
    result.scaledViewports.push({ zoomFactor, ...scaledLayout })
    assert.ok(scaledLayout.innerWidth <= 1590 && scaledLayout.innerWidth >= 1000, `${zoomFactor * 100}%：CSS 视口未随缩放变化`)
    assert.ok(scaledLayout.innerHeight <= 875 && scaledLayout.innerHeight >= 580, `${zoomFactor * 100}%：CSS 视口高度异常`)
    assert.ok(scaledLayout.scrollWidth <= scaledLayout.innerWidth + 1, `${zoomFactor * 100}%：页面横向溢出`)
    assert.ok(scaledLayout.scrollHeight <= scaledLayout.innerHeight + 1, `${zoomFactor * 100}%：页面纵向溢出`)
    assert.ok(scaledLayout.toolbarHeight <= 108, `${zoomFactor * 100}%：工具栏占用高度过大`)
    assert.deepEqual(scaledLayout.toolbarControlsOutsideViewport, [], `${zoomFactor * 100}%：工具栏命令被裁到视口外`)
    assert.ok(scaledLayout.coreToolbarCommands.every((command) => command.visible), `${zoomFactor * 100}%：核心工具栏命令不可达 ${JSON.stringify(scaledLayout.coreToolbarCommands)}`)
    assert.equal(scaledLayout.runMainVisible, true, `${zoomFactor * 100}%：主运行按钮不可达`)
    assert.ok(scaledLayout.visibleNodes > 0, `${zoomFactor * 100}%：画布节点不可见`)
    await page.screenshot({ path: path.join(artifactRoot, `canvas-scale-${zoomFactor * 100}.png`) })
  }
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
  })

  await page.getByRole('button', { name: '关闭运行面板' }).click()
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1590, 875)
  })
  const savedVideoTargetTransform = await videoTarget.evaluate((element) => element.style.transform)
  await page.getByTitle('保存并返回项目中心').click()
  await page.locator('.canvas-project-center').waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(await page.getByText('工作目录就绪', { exact: true }).count(), 1, '项目中心没有显示工作目录健康状态')
  await page.getByRole('button', { name: '重命名项目：视觉回归项目' }).click()
  const renameProjectDialog = page.getByRole('dialog', { name: '重命名项目' })
  await renameProjectDialog.getByRole('textbox', { name: '项目名称' }).fill('视觉回归项目-已重命名')
  await renameProjectDialog.getByRole('button', { name: '保存名称' }).click()
  await page.getByRole('button', { name: '复制项目：视觉回归项目-已重命名' }).click()
  const duplicateProjectDialog = page.getByRole('dialog', { name: '复制项目' })
  await duplicateProjectDialog.getByRole('textbox', { name: '项目名称' }).fill('视觉回归项目副本')
  await duplicateProjectDialog.getByRole('button', { name: '选择文件夹并复制' }).click()
  await page.getByRole('button', { name: '归档项目：视觉回归项目副本' }).click()
  await page.getByRole('dialog', { name: '归档项目' }).getByRole('button', { name: '确认归档' }).click()
  await page.getByRole('button', { name: /已归档/ }).click()
  await page.getByRole('button', { name: '恢复项目：视觉回归项目副本' }).click()
  await page.getByRole('button', { name: /最近项目/ }).click()
  await page.screenshot({ path: path.join(artifactRoot, 'project-center-lifecycle-1590x875.png') })
  await page.getByRole('button', { name: '打开项目：视觉回归项目-已重命名' }).click()
  await page.locator('.canvas-app').waitFor({ state: 'visible', timeout: 10_000 })
  const reopenedImageGenerate = page.locator(`.react-flow__node[data-id="${imageGenerateNodeId}"]`)
  const reopenedVideoTarget = page.locator(`.react-flow__node[data-id="${videoTargetId}"]`)
  const reopenedPortraitVideo = page.locator('.react-flow__node-video-input').last()
  await reopenedVideoTarget.waitFor({ state: 'attached' })
  assert.equal(await reopenedImageGenerate.locator('select[aria-label="生成尺寸"]').inputValue(), '1280x720', '重新打开项目后图片比例没有保存')
  assert.equal(await reopenedVideoTarget.locator('select[aria-label="视频模型"]').inputValue(), 'minimax-h3-base', '重新打开项目后 MiniMax 模型没有保存')
  assert.equal(await reopenedVideoTarget.locator('select[aria-label="MiniMax 生成模式"]').inputValue(), 'ref2va', '重新打开项目后 MiniMax 模式没有保存')
  assert.equal(await reopenedVideoTarget.locator('select[aria-label="MiniMax 视频分辨率"]').inputValue(), '480p', '重新打开项目后 MiniMax 分辨率没有保存')
  assert.equal(await reopenedVideoTarget.locator('select[aria-label="MiniMax 视频比例"]').inputValue(), '9:16', '重新打开项目后 MiniMax 比例没有保存')
  assert.equal(await reopenedVideoTarget.getByText('AI 优化 H3 提示词', { exact: true }).locator('..').locator('input').evaluate((input) => input.checked), true, '重新打开项目后提示词优化开关没有保存')
  assert.equal(await reopenedVideoTarget.evaluate((element) => element.style.transform), savedVideoTargetTransform, '重新打开项目后节点布局没有保存')
  const reopenedPortraitAppearance = await mediaNodeAppearance(reopenedPortraitVideo)
  assert.equal(reopenedPortraitAppearance.width, 320, '重新打开项目后竖屏视频宽度没有保存')
  assert.equal(reopenedPortraitAppearance.height, 480, '重新打开项目后竖屏视频比例没有保存')
  const reopenedVideoRatio = await reopenedPortraitVideo.locator('video').evaluate((video) => {
    const rect = video.getBoundingClientRect()
    return { rendered: rect.width / rect.height, source: video.videoWidth / video.videoHeight }
  })
  assert.ok(Math.abs(reopenedVideoRatio.rendered - reopenedVideoRatio.source) < 0.01, `重新打开项目后竖屏视频预览比例错误：${JSON.stringify(reopenedVideoRatio)}`)
  const addPrompt = page.locator('.node-library-item').filter({ hasText: '提示词' }).first()
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
  const selected = await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed')
  assert.equal(selected, 'true', `创作库标签未切换：${label}`)
}

async function mediaNodeAppearance(node) {
  await node.waitFor({ state: 'attached' })
  return node.evaluate((element) => {
    const shell = element.querySelector('.wf-media-bound')
    const dropTarget = element.querySelector('.wf-drop-target')
    const preview = element.querySelector('.wf-input-preview')
    if (!(shell instanceof HTMLElement) || !(dropTarget instanceof HTMLElement) || !(preview instanceof HTMLElement)) {
      throw new Error('纯媒体节点结构不完整')
    }
    const borderWidth = (target) => {
      const style = getComputedStyle(target)
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    }
    const mediaRect = preview.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    return {
      width: element.clientWidth,
      height: element.clientHeight,
      shellBorder: borderWidth(shell),
      dropBorder: borderWidth(dropTarget),
      previewBorder: borderWidth(preview),
      shellWidth: shellRect.width,
      shellHeight: shellRect.height,
      previewWidth: mediaRect.width,
      previewHeight: mediaRect.height,
      headers: shell.querySelectorAll(':scope > header').length,
      actions: shell.querySelectorAll(':scope > .wf-actions').length,
      permanentLabels: shell.querySelectorAll(':scope > .wf-drop-target > span:not(.wf-input-preview)').length,
    }
  })
}

function assertPureMediaNode(appearance, label) {
  assert.deepEqual(appearance.shellBorder, ['1px', '1px', '1px', '1px'], `${label}节点外框不是 1px 窄边框`)
  assert.deepEqual(appearance.dropBorder, ['0px', '0px', '0px', '0px'], `${label}节点存在第二层投放边框`)
  assert.deepEqual(appearance.previewBorder, ['0px', '0px', '0px', '0px'], `${label}节点存在第二层预览边框`)
  assert.ok(Math.abs(appearance.shellWidth - appearance.previewWidth) <= 2.1, `${label}素材没有填满窄边框内的横向空间`)
  assert.ok(Math.abs(appearance.shellHeight - appearance.previewHeight) <= 2.1, `${label}素材没有填满窄边框内的纵向空间`)
  assert.equal(appearance.headers, 0, `${label}素材默认态仍显示标题栏`)
  assert.equal(appearance.actions, 0, `${label}素材默认态仍显示底部操作`)
  assert.equal(appearance.permanentLabels, 0, `${label}素材默认态仍显示说明文字`)
}

async function findEmptyPanePoint(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')
    if (!(pane instanceof HTMLElement || pane instanceof SVGElement)) throw new Error('找不到画布空白层')
    const bounds = pane.getBoundingClientRect()
    for (let y = bounds.top + 72; y < bounds.bottom - 72; y += 36) {
      for (let x = bounds.right - 72; x > bounds.left + 72; x -= 36) {
        if (document.elementFromPoint(x, y) === pane) return { x, y }
      }
    }
    throw new Error('画布内没有可用空白位置')
  })
}

async function connectCanvasNodes(page, sourceNode, sourceHandleId, targetNode, targetHandleId) {
  const edgeCount = await page.locator('.react-flow__edge').count()
  const sourceHandle = sourceNode.locator(`.react-flow__handle[data-handleid="${sourceHandleId}"]`)
  const targetHandle = targetNode.locator(`.react-flow__handle[data-handleid="${targetHandleId}"]`)
  const sourceBounds = await sourceHandle.boundingBox()
  const targetBounds = await targetHandle.boundingBox()
  assert.ok(sourceBounds, `源端口不可见：${sourceHandleId}`)
  assert.ok(targetBounds, `目标端口不可见：${targetHandleId}`)
  await page.mouse.move(sourceBounds.x + sourceBounds.width / 2, sourceBounds.y + sourceBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2, { steps: 12 })
  await page.waitForTimeout(80)
  await page.mouse.up()
  try {
    await page.waitForFunction((expected) => document.querySelectorAll('.react-flow__edge').length === expected, edgeCount + 1, { timeout: 10_000 })
  } catch {
    const diagnostic = await page.evaluate(({ source, target }) => {
      const describe = (point) => {
        const element = document.elementFromPoint(point.x, point.y)
        return element instanceof HTMLElement || element instanceof SVGElement
          ? { tag: element.tagName, className: element.getAttribute('class'), handleId: element.getAttribute('data-handleid') }
          : null
      }
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        source,
        target,
        sourceHit: describe(source),
        targetHit: describe(target),
        banner: document.querySelector('.canvas-banner')?.textContent ?? '',
        connectionLine: document.querySelectorAll('.react-flow__connection').length,
        nodes: [...document.querySelectorAll('.react-flow__node')].map((node) => {
          const bounds = node.getBoundingClientRect()
          return {
            id: node.getAttribute('data-id'),
            className: node.getAttribute('class'),
            x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height),
          }
        }),
      }
    }, {
      source: { x: sourceBounds.x + sourceBounds.width / 2, y: sourceBounds.y + sourceBounds.height / 2 },
      target: { x: targetBounds.x + targetBounds.width / 2, y: targetBounds.y + targetBounds.height / 2 },
    })
    throw new Error(`连线失败 ${sourceHandleId} -> ${targetHandleId}: ${JSON.stringify(diagnostic)}`)
  }
}

async function dragHandleToPoint(page, sourceNode, sourceHandleId, point) {
  const sourceHandle = sourceNode.locator(`.react-flow__handle[data-handleid="${sourceHandleId}"]`)
  await sourceHandle.hover()
  await page.mouse.down()
  await page.mouse.move(point.x, point.y, { steps: 12 })
  await page.mouse.up()
}
