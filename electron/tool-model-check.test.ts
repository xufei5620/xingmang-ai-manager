import { describe, expect, it, vi } from 'vitest'
import { createToolModelChecker, hasModelPicker, modelOffered, type ToolModelCheckDependencies, type ToolModelCheckTarget } from './tool-model-check'
import type { ProviderId } from './catalog'

const hour = 60 * 60 * 1000

function setup(overrides: Partial<ToolModelCheckDependencies> = {}, targets: Partial<Record<ProviderId, ToolModelCheckTarget | null>> = {}) {
  let now = 1_000_000
  const deps = {
    now: () => now,
    target: vi.fn((provider: ProviderId) => provider in targets
      ? targets[provider] ?? null
      : { apiKey: 'sk-fixture', model: 'claude-opus-5', identity: `site:1:key:${provider}` }),
    listModels: vi.fn(async () => ['claude-opus-5', 'claude-sonnet-5', 'gpt-6-astra']),
    pickerOutdated: vi.fn(() => false),
    refreshPicker: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  }
  return { deps, checker: createToolModelChecker(deps), advance: (ms: number) => { now += ms } }
}

describe('tool model check', () => {
  it('skips tools that are not on a current-account config without asking the server', async () => {
    const { deps, checker } = setup({}, { claude: null })
    await expect(checker.check('claude')).resolves.toEqual({ status: 'skipped' })
    expect(deps.listModels).not.toHaveBeenCalled()
  })

  it('checks at most once a day for the same config', async () => {
    const { deps, checker, advance } = setup()
    await expect(checker.check('claude')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    advance(23 * hour)
    await expect(checker.check('claude')).resolves.toEqual({ status: 'skipped' })
    advance(2 * hour)
    await checker.check('claude')
    expect(deps.listModels).toHaveBeenCalledTimes(2)
  })

  it('checks again right away once the account, key or model behind the tool changes', async () => {
    const target = { apiKey: 'sk-fixture', model: 'claude-opus-5', identity: 'site:1:key:claude-opus-5' }
    const { deps, checker } = setup({}, { claude: target })
    await checker.check('claude')
    target.identity = 'site:2:key:claude-opus-5'
    await checker.check('claude')
    expect(deps.listModels).toHaveBeenCalledTimes(2)
  })

  it('offers the default replacement when the configured model is gone, and does not change anything itself', async () => {
    const { deps, checker } = setup({ listModels: vi.fn(async () => ['gpt-6-astra', 'gpt-6-sol']) }, { codex: { apiKey: 'sk-fixture', model: 'gpt-5-retired', identity: 'x' } })
    const result = await checker.check('codex')
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.model).toBe('gpt-5-retired')
    expect(['gpt-6-astra', 'gpt-6-sol']).toContain(result.replacement)
    expect(deps.refreshPicker).not.toHaveBeenCalled()
  })

  it('never blocks opening when the model list cannot be read, and retries an hour later instead of every open', async () => {
    const { deps, checker, advance } = setup({ listModels: vi.fn(async () => { throw new Error('offline') }) })
    await expect(checker.check('claude')).resolves.toEqual({ status: 'skipped' })
    await checker.check('claude')
    expect(deps.listModels).toHaveBeenCalledTimes(1)
    advance(hour + 1)
    await checker.check('claude')
    expect(deps.listModels).toHaveBeenCalledTimes(2)
    expect(deps.log).toHaveBeenCalledWith('warn', 'tool-models.check-failed', expect.any(String), expect.objectContaining({ provider: 'claude' }))
  })

  it('gives up waiting on a slow model list so the tool still opens', async () => {
    vi.useFakeTimers()
    try {
      const { checker } = setup({ listModels: vi.fn(() => new Promise<string[]>(() => undefined)), listTimeoutMs: 50 })
      const pending = checker.check('claude')
      await vi.advanceTimersByTimeAsync(60)
      await expect(pending).resolves.toEqual({ status: 'skipped' })
    } finally { vi.useRealTimers() }
  })

  it('does not tell the user to switch models when the list comes back empty', async () => {
    const { checker } = setup({ listModels: vi.fn(async () => []) })
    await expect(checker.check('claude')).resolves.toEqual({ status: 'skipped' })
  })

  it('quietly refreshes the Claude Code model menu when it no longer matches the account', async () => {
    const { deps, checker } = setup({ pickerOutdated: vi.fn(() => true) })
    await expect(checker.check('claude')).resolves.toEqual({ status: 'ok', pickerRefreshed: true })
    expect(deps.pickerOutdated).toHaveBeenCalledWith('claude', ['claude-opus-5', 'claude-sonnet-5', 'gpt-6-astra'], 'claude-opus-5')
    expect(deps.refreshPicker).toHaveBeenCalledWith('claude', 'claude-opus-5', expect.any(Function))
  })

  it('refreshes the Codex model catalog the same way, waiting for the version probe behind it', async () => {
    const codex = { apiKey: 'sk-fixture', model: 'gpt-6-astra', identity: 'site:1:key:codex' }
    const { deps, checker } = setup({ pickerOutdated: vi.fn(async () => true) }, { codex })
    await expect(checker.check('codex')).resolves.toEqual({ status: 'ok', pickerRefreshed: true })
    expect(deps.refreshPicker).toHaveBeenCalledWith('codex', 'gpt-6-astra', expect.any(Function))
    expect(deps.log).toHaveBeenCalledWith('info', 'tool-models.picker-refreshed', expect.stringContaining('Codex'), expect.objectContaining({ provider: 'codex' }))
  })

  it('only Claude Code and Codex have a menu to refresh', async () => {
    const { deps, checker } = setup({ pickerOutdated: vi.fn(() => true) }, { grok: { apiKey: 'sk', model: 'claude-opus-5', identity: 'g' } })
    await expect(checker.check('grok')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    expect(deps.pickerOutdated).not.toHaveBeenCalled()
    expect(['claude', 'codex', 'gemini', 'grok'].filter((provider) => hasModelPicker(provider as ProviderId))).toEqual(['claude', 'codex'])
  })

  it('still opens when the menu cannot be read or rewritten', async () => {
    const unreadable = setup({ pickerOutdated: vi.fn(() => { throw new Error('bad json') }) })
    await expect(unreadable.checker.check('claude')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    const unwritable = setup({ pickerOutdated: vi.fn(() => true), refreshPicker: vi.fn(async () => { throw new Error('locked') }) })
    await expect(unwritable.checker.check('claude')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    const probeFailed = setup({ pickerOutdated: vi.fn(async () => { throw new Error('codex --version failed') }) })
    await expect(probeFailed.checker.check('codex')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    expect(probeFailed.deps.log).toHaveBeenCalledWith('warn', 'tool-models.picker-read-failed', expect.stringContaining('Codex'), expect.objectContaining({ provider: 'codex' }))
  })

  it('drops a result that comes back after the account switched, even when the new account offers the same model', async () => {
    let finish!: (models: string[]) => void
    const target = { apiKey: 'sk-account-a', model: 'claude-opus-5', identity: 'site:A:key-a:claude-opus-5' }
    const { deps, checker } = setup({ listModels: vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve })), pickerOutdated: vi.fn(() => true) }, { claude: target })
    const pending = checker.check('claude')
    await Promise.resolve()
    target.apiKey = 'sk-account-b'
    target.identity = 'site:B:key-b:claude-opus-5'
    finish(['claude-opus-5'])
    await expect(pending).resolves.toEqual({ status: 'skipped' })
    expect(deps.refreshPicker).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith('info', 'tool-models.account-changed', expect.any(String), { provider: 'claude' })
  })

  it('does not ask the new account to swap models because of the old account\'s list', async () => {
    let finish!: (models: string[]) => void
    const target = { apiKey: 'sk-account-a', model: 'gpt-5-retired', identity: 'A' }
    const { checker } = setup({ listModels: vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve })) }, { codex: target })
    const pending = checker.check('codex')
    await Promise.resolve()
    target.identity = 'B'
    finish(['gpt-6-astra'])
    await expect(pending).resolves.toEqual({ status: 'skipped' })
  })

  it('hands the menu writer a guard that fails once the account has moved on', async () => {
    const target = { apiKey: 'sk-account-a', model: 'claude-opus-5', identity: 'A' }
    let guard!: () => void
    const { checker } = setup({ pickerOutdated: vi.fn(() => true), refreshPicker: vi.fn(async (_provider: string, _model: string, assertCurrent: () => void) => { guard = assertCurrent }) }, { claude: target })
    await checker.check('claude')
    expect(() => guard()).not.toThrow()
    target.identity = 'B'
    expect(() => guard()).toThrow('账号已变化')
  })

  it('keeps the guard on who owns the config, not on whether it may still be touched, once identity is given', async () => {
    const config = { apiKey: 'sk-account-a', model: 'claude-opus-5', identity: 'A' }
    const eligible = { current: true as boolean }
    let guard!: () => void
    const { checker } = setup({
      target: vi.fn(() => eligible.current ? config : null),
      identity: vi.fn(() => config.identity),
      pickerOutdated: vi.fn(() => true),
      refreshPicker: vi.fn(async (_provider: string, _model: string, assertCurrent: () => void) => { guard = assertCurrent }),
    })
    await checker.check('claude')
    // 写入那一步自己把来源记录改掉了：这不算换了人。
    eligible.current = false
    expect(() => guard()).not.toThrow()
    config.identity = 'B'
    expect(() => guard()).toThrow('账号已变化')
  })

  it('still drops the result before writing when the config stopped being the account\'s own during the fetch', async () => {
    let finish!: (models: string[]) => void
    const config = { apiKey: 'sk-account-a', model: 'claude-opus-5', identity: 'A' }
    const eligible = { current: true as boolean }
    const { deps, checker } = setup({
      target: vi.fn(() => eligible.current ? config : null),
      identity: vi.fn(() => config.identity),
      listModels: vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve })),
      pickerOutdated: vi.fn(() => true),
    })
    const pending = checker.check('claude')
    await Promise.resolve()
    // 同一把 Key 被用户手动保存了一遍：人没换，但已经不是本软件替账号写的配置。
    eligible.current = false
    finish(['claude-opus-5'])
    await expect(pending).resolves.toEqual({ status: 'skipped' })
    expect(deps.refreshPicker).not.toHaveBeenCalled()
  })

  it('checks a tool again on the next launch once its day\'s result is forgotten', async () => {
    const { deps, checker } = setup()
    await checker.check('codex')
    await checker.check('claude')
    await expect(checker.check('codex')).resolves.toEqual({ status: 'skipped' })
    checker.forget('codex')
    await expect(checker.check('codex')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    await expect(checker.check('claude')).resolves.toEqual({ status: 'skipped' })
    expect(deps.listModels).toHaveBeenCalledTimes(3)
  })

  it('syncs a menu at startup without asking the user anything or using up the day\'s check', async () => {
    const codex = { apiKey: 'sk-fixture', model: 'gpt-6-astra', identity: 'site:1:key:codex' }
    const { deps, checker } = setup({ pickerOutdated: vi.fn(async () => true) }, { codex })
    await expect(checker.syncPicker('codex')).resolves.toBe(true)
    expect(deps.refreshPicker).toHaveBeenCalledWith('codex', 'gpt-6-astra', expect.any(Function))
    // 开机那次不算当天的核对：随后打开 Codex 照样核一遍，默认模型下架了还能问到。
    await expect(checker.check('codex')).resolves.toEqual({ status: 'ok', pickerRefreshed: true })
    expect(deps.listModels).toHaveBeenCalledTimes(2)
  })

  it('runs the startup hook just before rewriting the menu, and skips the rewrite when that hook fails', async () => {
    const codex = { apiKey: 'sk-fixture', model: 'gpt-6-astra', identity: 'site:1:key:codex' }
    const order: string[] = []
    const backedUp = setup({
      pickerOutdated: vi.fn(async () => true),
      refreshPicker: vi.fn(async () => { order.push('refresh') }),
    }, { codex })
    await expect(backedUp.checker.syncPicker('codex', { beforeRefresh: () => { order.push('backup') } })).resolves.toBe(true)
    expect(order).toEqual(['backup', 'refresh'])

    const current = setup({}, { codex })
    const unused = vi.fn()
    await expect(current.checker.syncPicker('codex', { beforeRefresh: unused })).resolves.toBe(false)
    expect(unused).not.toHaveBeenCalled()

    const failed = setup({ pickerOutdated: vi.fn(async () => true) }, { codex })
    await expect(failed.checker.syncPicker('codex', { beforeRefresh: () => { throw new Error('备份失败') } })).resolves.toBe(false)
    expect(failed.deps.refreshPicker).not.toHaveBeenCalled()
    expect(failed.deps.log).toHaveBeenCalledWith('warn', 'tool-models.picker-refresh-failed', expect.any(String), { provider: 'codex', reason: '备份失败' })
  })

  it('leaves the menu alone at startup when the menu is current, the tool has none, or the model is gone', async () => {
    const current = setup()
    await expect(current.checker.syncPicker('codex')).resolves.toBe(false)
    expect(current.deps.refreshPicker).not.toHaveBeenCalled()

    const noMenu = setup({ pickerOutdated: vi.fn(() => true) })
    await expect(noMenu.checker.syncPicker('gemini')).resolves.toBe(false)
    expect(noMenu.deps.listModels).not.toHaveBeenCalled()

    const gone = setup({ pickerOutdated: vi.fn(() => true), listModels: vi.fn(async () => ['gpt-6-sol']) }, { codex: { apiKey: 'sk', model: 'gpt-5-retired', identity: 'x' } })
    await expect(gone.checker.syncPicker('codex')).resolves.toBe(false)
    expect(gone.deps.pickerOutdated).not.toHaveBeenCalled()

    const offline = setup({ pickerOutdated: vi.fn(() => true), listModels: vi.fn(async () => { throw new Error('offline') }) })
    await expect(offline.checker.syncPicker('codex')).resolves.toBe(false)
    expect(offline.deps.log).toHaveBeenCalledWith('warn', 'tool-models.sync-failed', expect.any(String), expect.objectContaining({ provider: 'codex' }))
  })

  it('drops a startup sync whose account switched while the model list was loading', async () => {
    let finish!: (models: string[]) => void
    const target = { apiKey: 'sk-account-a', model: 'gpt-6-astra', identity: 'A' }
    const { deps, checker } = setup({ listModels: vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve })), pickerOutdated: vi.fn(() => true) }, { codex: target })
    const pending = checker.syncPicker('codex')
    await Promise.resolve()
    target.identity = 'B'
    finish(['gpt-6-astra'])
    await expect(pending).resolves.toBe(false)
    expect(deps.refreshPicker).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith('info', 'tool-models.account-changed', expect.any(String), { provider: 'codex' })
  })

  it('accepts the Gemini -high spelling the config writer adds', () => {
    expect(modelOffered('gemini', 'gemini-3.8-flash-high', ['gemini-3.8-flash'])).toBe(true)
    expect(modelOffered('claude', 'claude-opus-5-high', ['claude-opus-5'])).toBe(false)
  })
})
