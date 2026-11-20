import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createSystemService, type SystemServiceOptions } from './system-service'
import type { ExternalClientRuntimeStatus } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'
import { ManagedCliKeyStore } from './managed-cli-key-store'

// external-client-service*.test.ts 四个文件共用的夹具：经 createSystemService 接上三家客户端真的配置读写，
// 客户端运行时、中转请求和换线路的定时器换成假的。四组用例原来挤在一个 138 条的文件里，Windows 跑道上一个文件
// 就占 270~300 秒，分片没法把它拆开发，跑道慢一阵就把那一片推过 15 分钟（#2006），所以按 describe 拆成四个文件。

const temporaryDirectories: string[] = []
export const selectedKey = 'sk-selected-external-client-key'
export const selectedModel = 'claude-sonnet-4-6'
export const hostPlatform = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

export function fixture(options: { site?: 'solov' | 'solov-api'; platform?: NodeJS.Platform; nativeClaudePaths?: boolean; snapshotCache?: boolean; managedKeys?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-client-service-'))
  temporaryDirectories.push(directory)
  const userHome = path.join(directory, 'user')
  const managerDataDirectory = path.join(directory, 'manager')
  const claudeProfileDirectory = path.join(userHome, 'claude-profile')
  let site: string = options.site ?? 'solov'
  let userId: number | null = 17
  const assertClaudeDesktopUnmanaged = vi.fn(async () => undefined)
  const inspectClaudeDesktopStoreVirtualization = vi.fn<NonNullable<SystemServiceOptions['inspectClaudeDesktopStoreVirtualization']>>(async () => ({
    localProfileVirtualized: true, roamingProfileVirtualized: true, roamingDeveloperVirtualized: true,
  }))
  // Claude Desktop 的自检照它网关的启动检查发 /v1/messages（connection-check.ts 的
  // gatewayMessagesShape），其余请求都是查模型清单。
  const relayFetch = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/v1/messages')
    ? Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: selectedModel,
      content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' })
    : Response.json({ data: [{ id: selectedModel }, { id: 'gpt-5.4' }] }))
  const store = new AppSettingsStore(path.join(directory, 'settings.json'), userHome)
  const runtimeStatuses: ExternalClientRuntimeStatus[] = (['workbuddy', 'claudeDesktop', 'opencode'] as const).map((tool) => ({
    tool, installed: tool === 'claudeDesktop', version: tool === 'claudeDesktop' ? '2.2553.1.0' : null,
    path: tool === 'claudeDesktop' ? path.join(directory, 'Claude', 'Claude.exe') : null,
    installDirectory: tool === 'claudeDesktop' ? path.join(directory, 'Claude') : null, running: false,
    installSupported: true, launchSupported: tool === 'claudeDesktop', detectionError: null, installHint: null,
  }))
  const runtime: NonNullable<SystemServiceOptions['externalClientRuntime']> = {
    scan: vi.fn(async () => structuredClone(runtimeStatuses)),
    scanOne: vi.fn(async (tool: ExternalToolId) => structuredClone(runtimeStatuses.find((status) => status.tool === tool)!)),
    install: vi.fn(async (tool, onProgress) => {
      onProgress?.({ tool, phase: 'installing', message: '正在安装', percent: null })
      return { ...runtimeStatuses.find((status) => status.tool === tool)!, installed: true, launchSupported: true, version: '1.2.3' }
    }),
    cancelInstall: vi.fn(() => ({ cancelled: false, reason: '这个工具当前没有正在进行的安装。' })),
    launch: vi.fn(async () => ({})),
    stillRunning: vi.fn(async (tool: ExternalToolId) => runtimeStatuses.find((status) => status.tool === tool)?.running ?? null),
  }
  // 外部客户端换线路的定时复查（C11）只记下来，由用例自己拨。
  const routeTimers: { callback: () => void; delayMs: number }[] = []
  const routeClock = { now: 1_000_000_000_000 }
  const routeFollowed = vi.fn()
  const runtimeLog = { log: vi.fn<NonNullable<SystemServiceOptions['runtimeLog']>['log']>() }
  // 托管 Key 缓存照真的那份加密存（#1113 要它记着的「被换掉的那几把」）；加密换成看得懂的假的。
  const keyStore = options.managedKeys ? new ManagedCliKeyStore(path.join(managerDataDirectory, 'managed-cli-keys.dat'), {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`fixture-cipher:${plainText}`),
    decryptString: (ciphertext) => ciphertext.toString('utf8').slice('fixture-cipher:'.length),
  }, options.site ?? 'solov') : null
  const serviceOptions: SystemServiceOptions = {
    providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
    managerDataDirectory, relayFetch, getRelaySiteId: () => site, platform: options.platform ?? hostPlatform,
    getExternalClientAccountId: () => userId === null ? null : JSON.stringify([site, userId]),
    claudeDesktopEnv: options.nativeClaudePaths ? {} : { CLAUDE_USER_DATA_DIR: claudeProfileDirectory },
    assertClaudeDesktopUnmanaged,
    inspectClaudeDesktopStoreVirtualization,
    externalClientRuntime: runtime,
    runtimeLog,
    scheduleToolRoute: (callback, delayMs) => {
      const timer = { callback, delayMs }
      routeTimers.push(timer)
      return () => { if (routeTimers.includes(timer)) routeTimers.splice(routeTimers.indexOf(timer), 1) }
    },
    toolRouteNow: () => routeClock.now,
    onToolRouteFollowed: routeFollowed,
    ...(options.snapshotCache ? { externalClientSnapshotCacheFile: path.join(managerDataDirectory, 'external-client-snapshot.json') } : {}),
    ...(keyStore ? {
      readCurrentManagedCliKeys: async () => userId === null ? [] : keyStore.read(userId),
      readOtherManagedCliKeyAccounts: async () => userId === null ? []
        : (await keyStore.readOtherAccounts(userId)).map((entry) => ({ owner: JSON.stringify([site, entry.userId]), keys: entry.keys })),
    } : {}),
  }
  return {
    directory, userHome, managerDataDirectory, claudeProfileDirectory, store, relayFetch, assertClaudeDesktopUnmanaged, inspectClaudeDesktopStoreVirtualization, runtime, runtimeStatuses, runtimeLog,
    routeTimers, routeClock, routeFollowed, keyStore,
    service: createSystemService(store, serviceOptions),
    restart: () => createSystemService(store, serviceOptions),
    setSite(next: string) { site = next },
    setUser(next: number | null) { userId = next },
  }
}

export function targetFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const entry = path.join(directory, item.name)
    return item.isDirectory() ? targetFiles(entry) : [entry]
  })
}

export function removeTemporaryDirectories() {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
}
