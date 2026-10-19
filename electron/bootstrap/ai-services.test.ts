import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeLogStore } from '../runtime-log'
import { createRealmBusinesses, type RealmBusinessesOptions } from './ai-services'

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

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function create() {
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
    await expect(ensureBusiness('solov-api').videoService.generate(1, {} as never)).rejects.toThrow('当前账号暂不支持视频生成')
    await expect(ensureBusiness('solov-api').videoService.resumeVideoTask(1, 7, 'task')).rejects.toThrow('当前账号暂不支持视频生成')
    expect(ensureBusiness('solov').videoService.generate).not.toBe(ensureBusiness('solov-api').videoService.generate)
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

  it('stops attaching a listener to new sites once it unsubscribed', () => {
    const { ensureBusiness, subscribeCanvasRuns } = create()
    ensureBusiness('solov')
    subscribeCanvasRuns(vi.fn())()
    expect(ensureBusiness('solov-api').canvasRuns.subscribe).not.toHaveBeenCalled()
  })
})
