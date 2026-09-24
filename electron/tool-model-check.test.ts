import { describe, expect, it, vi } from 'vitest'
import { createToolModelChecker, modelOffered, type ToolModelCheckDependencies, type ToolModelCheckTarget } from './tool-model-check'
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
    expect(deps.refreshPicker).toHaveBeenCalledWith('claude-opus-5')
  })

  it('only Claude Code has a menu to refresh', async () => {
    const { deps, checker } = setup({ pickerOutdated: vi.fn(() => true) }, { grok: { apiKey: 'sk', model: 'claude-opus-5', identity: 'g' } })
    await expect(checker.check('grok')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    expect(deps.pickerOutdated).not.toHaveBeenCalled()
  })

  it('still opens when the menu cannot be read or rewritten', async () => {
    const unreadable = setup({ pickerOutdated: vi.fn(() => { throw new Error('bad json') }) })
    await expect(unreadable.checker.check('claude')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
    const unwritable = setup({ pickerOutdated: vi.fn(() => true), refreshPicker: vi.fn(async () => { throw new Error('locked') }) })
    await expect(unwritable.checker.check('claude')).resolves.toEqual({ status: 'ok', pickerRefreshed: false })
  })

  it('accepts the Gemini -high spelling the config writer adds', () => {
    expect(modelOffered('gemini', 'gemini-3.8-flash-high', ['gemini-3.8-flash'])).toBe(true)
    expect(modelOffered('claude', 'claude-opus-5-high', ['claude-opus-5'])).toBe(false)
  })
})
