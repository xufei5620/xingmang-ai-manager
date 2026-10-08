import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore, type RelayToolRouteStatus } from './app-settings'
import type { ProviderId } from './catalog'
import { inspectProviderConfig, providerConfigPaths, saveProviderConfig } from './config-files'
import { createRelayEndpointRoutingSnapshot, createToolRouteRoutingSnapshot, relayProviderBaseUrls, type RelayEndpointId } from './relay-sites'
import type { RunningToolsReport } from './running-tools'
import { createSystemService, type SystemServiceOptions, type ToolRouteFollowRequest } from './system-service'
import { ToolConfigOwnershipStore } from './tool-config-ownership'
import { toolRouteRetryDelayMs } from './tool-route-follow-state'

const primary = relayProviderBaseUrls('solov', 'primary')
const direct = relayProviderBaseUrls('solov', 'direct')
const owner = JSON.stringify(['solov', 9])
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

interface Timer {
  callback: () => void
  delayMs: number
}

async function fixture(options: {
  providers?: ProviderId[]
  owned?: boolean
  mode?: 'targeted' | 'merge'
  siteId?: string
  report?: RunningToolsReport
  log?: ReturnType<typeof vi.fn>
  /** xm 三线路：line 是工具线路，管理工具自己走的应用线路另给（appLine）。 */
  appLine?: RelayEndpointId
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-tool-route-'))
  temporaryDirectories.push(root)
  const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
  const ownership = new ToolConfigOwnershipStore(path.join(root, 'tool-config-ownership'))
  const providers = options.providers ?? ['codex']
  for (const provider of providers) {
    saveProviderConfig(provider, 'sk-route-fixture', 'fixture-model', 'reset', roots, {}, primary)
    if (options.owned !== false) await ownership.write(provider, inspectProviderConfig(provider, roots, primary), 'account', owner, 2)
  }
  const line: { current: RelayEndpointId } = { current: 'direct' }
  const toolStatus: { current: RelayToolRouteStatus | undefined } = { current: undefined }
  function applicationLines() {
    return createRelayEndpointRoutingSnapshot({}, () => ({ solov: { line: options.appLine ?? 'direct', settled: true } })).lines()
  }
  const timers: Timer[] = []
  const clock = { now: 1_000_000_000_000 }
  const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
  const followed = vi.fn()
  const report = options.report ?? { running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false }
  const service = createSystemService(new AppSettingsStore(path.join(root, 'settings.json'), root), {
    managerDataDirectory: root,
    providerRoots: roots,
    getExternalClientAccountId: () => owner,
    ...(options.siteId ? { getRelaySiteId: () => options.siteId as string } : {}),
    ...(options.appLine
      ? {
          relayEndpointRouting: createToolRouteRoutingSnapshot({}, () => applicationLines(), () => line.current),
          relayToolRouting: { applicationLines, status: () => toolStatus.current },
        }
      : { relayEndpointRouting: createRelayEndpointRoutingSnapshot({}, () => ({ solov: { line: line.current, settled: true } })) }),
    relayFetch,
    resolveCliInstallation: async () => null,
    inspectCodexDesktopForModelCatalog: async () => ({ installed: false, version: null }),
    inspectRunningToolsForRouteHint: async () => report,
    getToolRouteRewriteMode: () => options.mode ?? 'targeted',
    onToolRouteFollowed: followed,
    scheduleToolRoute: (callback, delayMs) => {
      const timer = { callback, delayMs }
      timers.push(timer)
      return () => { timers.splice(timers.indexOf(timer), 1) }
    },
    toolRouteNow: () => clock.now,
    ...(options.log ? { runtimeLog: { log: options.log } as unknown as SystemServiceOptions['runtimeLog'] } : {}),
  })
  function follow(request: ToolRouteFollowRequest) {
    if (!service.followToolRoutes) throw new Error('followToolRoutes missing')
    return service.followToolRoutes(request)
  }
  function read(provider: ProviderId = 'codex') {
    const file = providerConfigPaths(provider, roots)[provider === 'gemini' ? 1 : 0]
    return fs.readFileSync(file, 'utf8')
  }
  function overwrite(content: string, provider: ProviderId = 'codex') {
    fs.writeFileSync(providerConfigPaths(provider, roots)[provider === 'gemini' ? 1 : 0], content)
  }
  return { root, roots, service, follow, read, overwrite, ownership, line, timers, clock, relayFetch, followed, toolStatus }
}

describe('tool route follow', () => {
  it.each(['claude', 'codex', 'gemini', 'grok'] satisfies ProviderId[])(
    'moves an owned %s config to the current line without asking for models or touching the key', async (provider) => {
      const f = await fixture({ providers: [provider] })
      const before = f.read(provider)
      expect(await f.follow({ reason: 'route-changed' })).toEqual({ rewritten: [provider] })
      expect(f.read(provider)).toBe(before.split(primary[provider]).join(direct[provider]))
      expect(f.relayFetch).not.toHaveBeenCalled()
      const summary = f.service.getConfig(false).providers[provider]
      expect(summary.actualBaseUrl).toBe(direct[provider])
      expect(summary.configurationOwnership).toBe('account')
      expect(summary.relayLine).toBe('direct')
      // 模板版本号原样带过去，开机不会再当成模板落后补一遍。
      expect(f.ownership.templateRevision(provider, inspectProviderConfig(provider, f.roots, direct))).toBe(2)
      expect(f.followed).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps one whole backup of the original before the first rewrite only', async () => {
    const f = await fixture()
    const backup = vi.fn(async () => undefined)
    f.service.bindToolRouteAccount?.({ backup, ownedKeyIds: async () => new Set<number>() })
    await f.follow({ reason: 'route-changed' })
    f.line.current = 'primary'
    await f.follow({ reason: 'route-changed' })
    expect(backup).toHaveBeenCalledTimes(1)
    expect(backup).toHaveBeenCalledWith('codex')
  })

  it('does not touch a config the account did not write, and does not retry it', async () => {
    const f = await fixture({ owned: false })
    const before = f.read()
    expect(await f.follow({ reason: 'route-changed' })).toEqual({ rewritten: [] })
    expect(f.read()).toBe(before)
    expect(f.timers).toEqual([])
  })

  it('leaves everything to the old merge path when the service status says so', async () => {
    const f = await fixture({ mode: 'merge' })
    const before = f.read()
    expect(await f.follow({ reason: 'route-changed' })).toEqual({ rewritten: [] })
    expect(f.read()).toBe(before)
    expect(f.service.readStoredConfig().toolRouteRewrite).toBe('merge')
  })

  it('never acts for the legacy account site', async () => {
    const f = await fixture({ siteId: 'solov-api' })
    const before = f.read()
    expect(await f.follow({ reason: 'route-changed' })).toEqual({ rewritten: [] })
    expect(f.read()).toBe(before)
  })

  it('moves a reverted config again once, then stops after the second revert within a day', async () => {
    const log = vi.fn()
    const f = await fixture({ log })
    const original = f.read()
    await f.follow({ reason: 'route-changed' })
    const moved = f.read()
    f.overwrite(original)
    expect(await f.follow({ reason: 'verify', providers: ['codex'] })).toEqual({ rewritten: ['codex'] })
    expect(f.read()).toBe(moved)
    expect(log).toHaveBeenCalledWith('warn', 'config', 'route.reverted', expect.any(String), { provider: 'codex' })

    f.clock.now += 60_000
    f.overwrite(original)
    expect(await f.follow({ reason: 'verify', providers: ['codex'] })).toEqual({ rewritten: [] })
    expect(f.read()).toBe(original)
    expect(f.service.getConfig(false).providers.codex.relayRouteState).toBe('managed-elsewhere')
    expect(log).toHaveBeenCalledWith('warn', 'config', 'route.managed-elsewhere', expect.any(String), { provider: 'codex' })
  })

  it('counts a revert onto the current line as the account own config, not a fight', async () => {
    const f = await fixture()
    const original = f.read()
    await f.follow({ reason: 'route-changed' })
    f.line.current = 'primary'
    f.overwrite(original)
    expect(await f.follow({ reason: 'route-changed' })).toEqual({ rewritten: [] })
    const summary = f.service.getConfig(false).providers.codex
    expect(summary.configurationOwnership).toBe('account')
    expect(summary.relayRouteState).toBeUndefined()
  })

  it('checks back a minute after a rewrite', async () => {
    const f = await fixture()
    await f.follow({ reason: 'route-changed' })
    expect(f.timers.map((timer) => timer.delayMs)).toEqual([60_000])
  })

  it('retries a transient failure every five minutes and gives up after twelve', async () => {
    const log = vi.fn()
    const f = await fixture({ log })
    // 文件被别的程序占住、读不出来：这里用一个读不了的目录顶替配置文件。
    const [config] = providerConfigPaths('codex', f.roots)
    fs.rmSync(config)
    fs.mkdirSync(config)
    await f.follow({ reason: 'route-changed' })
    for (let attempt = 1; attempt < 12; attempt += 1) {
      expect(f.timers.map((timer) => timer.delayMs)).toEqual([toolRouteRetryDelayMs])
      const [timer] = f.timers.splice(0)
      timer.callback()
      await vi.waitFor(() => expect(log.mock.calls.filter((call) => call[2] === 'route.follow-failed')).toHaveLength(attempt + 1))
      await vi.waitFor(() => expect(f.timers.length + log.mock.calls.filter((call) => call[2] === 'route.retry-exhausted').length).toBe(1))
    }
    expect(f.timers).toEqual([])
    expect(log).toHaveBeenCalledWith('warn', 'config', 'route.retry-exhausted', expect.any(String), { provider: 'codex' })
  })

  it('asks open tools to restart after a fault switch, once a day per tool, then only tags them', async () => {
    const f = await fixture({ providers: ['claude', 'codex'], report: { running: ['codex'], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false } })
    await f.follow({ reason: 'route-changed', fault: true })
    const hint = f.service.readStoredConfig().toolRouteRestartHint
    expect(hint).toEqual({ id: f.clock.now, codex: { cli: true, desktop: null, canRestartDesktop: false } })

    f.clock.now += 10 * 60 * 1000
    f.line.current = 'primary'
    await f.follow({ reason: 'route-changed', fault: true })
    expect(f.service.readStoredConfig().toolRouteRestartHint).toEqual(hint)
    expect(f.service.getConfig(false).providers.codex.relayRouteState).toBe('restart')
    // Claude Code 每次请求都重读配置，不提示也不标。
    expect(f.service.getConfig(false).providers.claude.relayRouteState).toBeUndefined()

    // 提示只给界面半小时。
    f.clock.now += 20 * 60 * 1000
    expect(f.service.readStoredConfig().toolRouteRestartHint).toBeUndefined()
  })

  it('does not ask when the route moved by choice rather than a fault', async () => {
    const f = await fixture({ report: { running: ['codex'], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false } })
    await f.follow({ reason: 'route-changed' })
    expect(f.service.readStoredConfig().toolRouteRestartHint).toBeUndefined()
    expect(f.service.getConfig(false).providers.codex.relayRouteState).toBeUndefined()
  })

  it('only tags the tool when restart hints are turned off', async () => {
    const f = await fixture({ report: { running: ['codex'], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false } })
    await f.service.updateStoredConfig({ version: 2, toolRouteRestartHints: false })
    await f.follow({ reason: 'route-changed', fault: true })
    expect(f.service.readStoredConfig().toolRouteRestartHint).toBeUndefined()
    expect(f.service.getConfig(false).providers.codex.relayRouteState).toBe('restart')
  })
})

// xm 三线路：工具配置跟工具线路，设置快照里 relayRouteLines 照旧是管理工具自己那条。
describe('tool line separate from the app line', () => {
  it('moves the tools to the tool line while the app stays on its own line', async () => {
    const f = await fixture({ appLine: 'direct' })
    f.line.current = 'primary'
    // 配置本来就写在 CF：工具线路也是 CF，不用迁，期望地址就是 CF。
    expect(await f.follow({ reason: 'route-changed' })).toEqual({ rewritten: [] })
    expect(f.service.getConfig(false).providers.codex.baseUrl).toBe(primary.codex)
    f.line.current = 'direct'
    expect(await f.follow({ reason: 'route-changed' })).toEqual({ rewritten: ['codex'] })
    expect(f.service.getConfig(false).providers.codex.actualBaseUrl).toBe(direct.codex)
  })

  it('reports the app line, the tool line and the tool line status in the settings snapshot', async () => {
    const f = await fixture({ appLine: 'direct' })
    f.line.current = 'primary'
    let settings = f.service.readStoredConfig()
    expect(settings.relayRouteLines?.solov).toEqual({ line: 'direct', settled: true })
    expect(settings.relayToolRouteLines).toEqual({ solov: { line: 'primary', settled: true } })
    expect(settings).not.toHaveProperty('relayToolRouteStatus')
    f.toolStatus.current = { serverSwitching: true }
    settings = await f.service.updateStoredConfig({ version: 2, toolRouteRestartHints: false })
    expect(settings.relayToolRouteStatus).toEqual({ serverSwitching: true })
    // 只读快照不落盘。
    expect(fs.readFileSync(path.join(f.root, 'settings.json'), 'utf8')).not.toMatch(/relayToolRoute|relayRouteLines/)
  })

  it('keeps the old snapshot when no tool line is wired', async () => {
    const f = await fixture()
    expect(f.service.readStoredConfig()).not.toHaveProperty('relayToolRouteLines')
  })
})
