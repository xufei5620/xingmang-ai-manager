import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { AiAssetStore } from '../ai-asset-store'
import { aiOutputFolderName } from '../ai-output-location'
import type { RuntimeLogStore } from '../runtime-log'
import { createGlobalVideoAssetWriter, createRealmBusinesses, type RealmBusinessesOptions } from './ai-services'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: {},
  dialog: {},
  Menu: {},
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
}))

// The real run service starts reconciling the canvas store as soon as someone
// subscribes; these tests only care which realms a renderer listener reaches.
vi.mock('../canvas-run-service', () => ({
  createCanvasRunService: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
    shutdown: vi.fn(),
  })),
}))

const directories: string[] = []
// Each site tries a write into its output folder in the background as soon as
// it is built. Removing the folder while that write is still going fails with
// ENOTEMPTY now and then, so wait for those writes first.
const outputProbes = vi.spyOn(AiAssetStore.prototype, 'assertWritable')

afterEach(async () => {
  await Promise.allSettled(outputProbes.mock.results.map((result) => result.value))
  outputProbes.mockClear()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function create(overrides: Partial<RealmBusinessesOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ai-services-'))
  directories.push(root)
  const accounts = {
    client: {},
    getSiteId: () => 'solov' as const,
    assertReady: () => undefined,
  } as unknown as RealmBusinessesOptions['accounts']
  return createRealmBusinesses({
    managerDataDirectory: path.join(root, 'data'),
    projectRoot: root,
    accounts,
    mainWindow: () => null,
    credentialPersistence: 'durable',
    systemService: { fetchAvailableModels: vi.fn(async () => []) },
    readAccountGroupHints: async () => null,
    readDocumentsDirectory: () => null,
    runtimeLog: { log: vi.fn(), exception: vi.fn() } as unknown as RuntimeLogStore,
    sessionFetch: vi.fn() as unknown as typeof fetch,
    routedRelayFetch: vi.fn() as unknown as typeof fetch,
    ...overrides,
  })
}

describe('realm businesses', () => {
  it('builds each account site once, the first time it is asked for', () => {
    const { businesses, ensureBusiness } = create()
    expect(businesses.size).toBe(0)
    const solov = ensureBusiness('solov')
    expect(ensureBusiness('solov')).toBe(solov)
    const history = ensureBusiness('solov-api')
    expect(history).not.toBe(solov)
    expect([...businesses.entries()]).toEqual([['solov', solov], ['solov-api', history]])
  })

  it('keeps each site in its own data folder', () => {
    const { ensureBusiness } = create()
    expect(ensureBusiness('solov').aiOutputPlacement.root).not.toBe(ensureBusiness('solov-api').aiOutputPlacement.root)
  })

  it('turns video generation away for the history account site only', async () => {
    const { ensureBusiness } = create()
    for (const service of ['videoService', 'chatVideoService'] as const) {
      await expect(ensureBusiness('solov-api')[service].generate(1, {} as never)).rejects.toThrow('当前账号暂不支持视频生成')
      await expect(ensureBusiness('solov-api')[service].resumeVideoTask(1, 7, 'task')).rejects.toThrow('当前账号暂不支持视频生成')
      expect(ensureBusiness('solov')[service].generate).not.toBe(ensureBusiness('solov-api')[service].generate)
    }
  })

  // 画布那份按项目存，没选项目就在扣费前停下；主窗口出的视频没有项目，要的是另一份。
  it('gives the main window its own video service that does not need a canvas project', () => {
    const { ensureBusiness } = create()
    const solov = ensureBusiness('solov')
    expect(solov.chatVideoService).not.toBe(solov.videoService)
  })

  it('stores main-window clips in the global library and keeps a clip whose source note fails', async () => {
    const stored = { assetId: 'a'.repeat(43) }
    const images = { assertWritable: vi.fn(async () => undefined) }
    const videos = { storeMp4: vi.fn(async () => stored) }
    const media = { setSource: vi.fn(async () => { throw new Error('磁盘满了') }) }
    const references = {
      readImageDataUri: vi.fn(async () => 'data:image/png;base64,AA=='),
      readMediaOwned: vi.fn(async () => ({ bytes: Buffer.from('clip') })),
    }
    const log = { log: vi.fn() }
    const writer = createGlobalVideoAssetWriter({
      images, videos, media, references, log,
    } as unknown as Parameters<typeof createGlobalVideoAssetWriter>[0])

    expect(writer).not.toHaveProperty('prepareProject')
    await writer.assertWritable?.(7)
    expect(images.assertWritable).toHaveBeenCalledWith(7)
    const bytes = Buffer.from('mp4')
    await expect(writer.storeMp4(7, bytes, { taskId: 'video_1', prompt: '雨夜的猫' })).resolves.toBe(stored)
    expect(videos.storeMp4).toHaveBeenCalledWith(7, bytes, { taskId: 'video_1' })
    expect(media.setSource).toHaveBeenCalledWith(7, stored.assetId, 'generated', '雨夜的猫')
    expect(log.log).toHaveBeenCalledWith('warn', 'ai-chat', 'asset.source.persist.failed', expect.any(String),
      expect.objectContaining({ userId: 7, assetId: stored.assetId, reason: '磁盘满了' }))
    await writer.readImageDataUri(7, 'img')
    expect(references.readImageDataUri).toHaveBeenCalledWith(7, 'img')
  })

  it('attaches a canvas run listener to every site, including sites built after it subscribed', () => {
    const { ensureBusiness, subscribeCanvasRuns } = create()
    const solov = ensureBusiness('solov')
    const listener = vi.fn()
    const unsubscribe = subscribeCanvasRuns(listener)
    expect(solov.canvasRuns.subscribe).toHaveBeenCalledWith(listener)
    const history = ensureBusiness('solov-api')
    expect(history.canvasRuns.subscribe).toHaveBeenCalledWith(listener)

    unsubscribe()
    for (const business of [solov, history]) {
      const [detach] = vi.mocked(business.canvasRuns.subscribe).mock.results.map((result) => result.value as () => void)
      expect(detach).toHaveBeenCalledTimes(1)
    }
    // A second call is a no-op, like the dispatch it replaces.
    unsubscribe()
    for (const business of [solov, history]) {
      const [detach] = vi.mocked(business.canvasRuns.subscribe).mock.results.map((result) => result.value as () => void)
      expect(detach).toHaveBeenCalledTimes(1)
    }
  })

  // 决定单 D107：上次「文档」不让写、作品存到了个人文件夹，这次「文档」能写了，启动后在后台挪回来。
  it('moves works saved in the home folder back into documents once documents can be written', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ai-services-home-'))
    directories.push(home)
    const documents = path.join(home, 'Documents')
    fs.mkdirSync(documents)
    const work = path.join('user-7', '2026-11-05', `xingmang-${'b'.repeat(43)}.png`)
    fs.mkdirSync(path.dirname(path.join(home, aiOutputFolderName, work)), { recursive: true })
    fs.writeFileSync(path.join(home, aiOutputFolderName, work), 'png')
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home)
    // The electron mock above is a plain object; only this test pretends to be the installed app.
    const mockedApp: { isPackaged: boolean } = app
    mockedApp.isPackaged = true
    try {
      const runtimeLog = { log: vi.fn(), exception: vi.fn() }
      const { ensureBusiness } = create({ readDocumentsDirectory: () => documents, runtimeLog: runtimeLog as unknown as RuntimeLogStore })
      expect(ensureBusiness('solov').aiOutputPlacement.root).toBe(path.join(documents, aiOutputFolderName))

      await vi.waitFor(() => {
        expect(runtimeLog.log).toHaveBeenCalledWith('info', 'ai-chat', 'asset.output.moved-back-to-documents', expect.any(String), { moved: 1, kept: 0, failed: 0 })
      })
      expect(fs.readFileSync(path.join(documents, aiOutputFolderName, work), 'utf8')).toBe('png')
      expect(fs.existsSync(path.join(home, aiOutputFolderName))).toBe(false)
      expect(runtimeLog.exception).not.toHaveBeenCalled()
    } finally {
      mockedApp.isPackaged = false
      homedir.mockRestore()
    }
  })

  it('stops attaching a listener to new sites once it unsubscribed', () => {
    const { ensureBusiness, subscribeCanvasRuns } = create()
    ensureBusiness('solov')
    subscribeCanvasRuns(vi.fn())()
    expect(ensureBusiness('solov-api').canvasRuns.subscribe).not.toHaveBeenCalled()
  })
})
