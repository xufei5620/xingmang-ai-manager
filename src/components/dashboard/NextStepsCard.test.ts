import { describe, expect, it } from 'vitest'
import { EmptyStatus } from '../../app-shared'
import { providerIds, type AppConfigSummary, type ProviderConfigSummary, type ProviderId, type SystemSnapshot } from '../../types'
import { computeNextSteps, resolveLaunchableProvider, type NextStepsNudgeState } from './NextStepsCard'

const noNudge: NextStepsNudgeState = { triedLaunch: false, exploredMcp: false }

function buildSnapshot(installed: ProviderId[] = [], codexDesktopInstalled = false): SystemSnapshot {
  const snapshot = EmptyStatus()
  for (const id of installed) {
    snapshot.clis[id] = { ...snapshot.clis[id], installed: true }
  }
  if (codexDesktopInstalled) {
    snapshot.desktopApps = { ...snapshot.desktopApps, codex: { ...snapshot.desktopApps.codex, installed: true } }
  }
  return snapshot
}

function buildProviderConfig(overrides: Partial<ProviderConfigSummary> = {}): ProviderConfigSummary {
  return {
    baseUrl: 'https://xm.solov.cc',
    actualBaseUrl: 'https://xm.solov.cc',
    exists: false,
    hasApiKey: false,
    matchesRelay: false,
    model: '',
    dataDirectory: '',
    dataDirectoryExists: false,
    files: [],
    updatedAt: null,
    apiKeyPreview: null,
    ...overrides,
  }
}

function buildConfig(configured: ProviderId[] = []): AppConfigSummary {
  const providers = {} as Record<ProviderId, ProviderConfigSummary>
  for (const id of providerIds) {
    providers[id] = buildProviderConfig(
      configured.includes(id) ? { exists: true, hasApiKey: true, matchesRelay: true } : {},
    )
  }
  return { workspace: 'C:\\workspace', providers }
}

describe('computeNextSteps', () => {
  it('全新未配置: nothing installed or configured — all derivable steps pending, card visible', () => {
    const summary = computeNextSteps(buildSnapshot(), null, noNudge)
    expect(summary.visible).toBe(true)
    expect(summary.steps).toEqual([
      { id: 'install-first-cli', done: false },
      { id: 'configure-first-cli', done: false },
      { id: 'try-launch', done: false },
      { id: 'install-second-tool', done: false },
      { id: 'explore-mcp', done: false },
    ])
  })

  it('已装未配置: one CLI installed but its config has no working key — step 1 done, step 2 still pending', () => {
    const snapshot = buildSnapshot(['codex'])
    // A config file can exist without ever having a valid 星芒 relay key.
    const config = buildConfig([])
    const summary = computeNextSteps(snapshot, config, noNudge)
    expect(summary.steps[0]).toEqual({ id: 'install-first-cli', done: true })
    expect(summary.steps[1]).toEqual({ id: 'configure-first-cli', done: false })
    expect(summary.steps[3]).toEqual({ id: 'install-second-tool', done: false })
    expect(summary.visible).toBe(true)
  })

  it('hides after the first configured tool without requiring a second tool', () => {
    const snapshot = buildSnapshot(['codex'])
    const config = buildConfig(['codex'])
    const summary = computeNextSteps(snapshot, config, noNudge)
    expect(summary.steps[0]).toEqual({ id: 'install-first-cli', done: true })
    expect(summary.steps[1]).toEqual({ id: 'configure-first-cli', done: true })
    expect(summary.steps[3]).toEqual({ id: 'install-second-tool', done: false })
    expect(summary.visible).toBe(false)
  })

  it('disappears once every derivable milestone is met, regardless of nudge state', () => {
    const snapshot = buildSnapshot(['codex', 'claude'])
    const config = buildConfig(['codex'])
    const summary = computeNextSteps(snapshot, config, noNudge)
    expect(summary.steps[0].done).toBe(true)
    expect(summary.steps[1].done).toBe(true)
    expect(summary.steps[3].done).toBe(true)
    expect(summary.visible).toBe(false)
  })

  it('counts the Codex desktop app toward the second-tool milestone additively', () => {
    const snapshot = buildSnapshot(['codex'], true)
    const config = buildConfig(['codex'])
    const summary = computeNextSteps(snapshot, config, noNudge)
    expect(summary.steps[3]).toEqual({ id: 'install-second-tool', done: true })
  })

  it('reflects nudge memory directly for the two non-derivable steps, independent of snapshot/config', () => {
    const summary = computeNextSteps(buildSnapshot(), null, { triedLaunch: true, exploredMcp: false })
    expect(summary.steps[2]).toEqual({ id: 'try-launch', done: true })
    expect(summary.steps[4]).toEqual({ id: 'explore-mcp', done: false })
    // Nudge completion alone must never hide missing tool preparation.
    expect(summary.visible).toBe(true)
  })

  it('keeps the card visible even when both nudges are done but a derivable milestone is not', () => {
    const summary = computeNextSteps(buildSnapshot(), null, { triedLaunch: true, exploredMcp: true })
    expect(summary.visible).toBe(true)
  })

  it('treats a config with hasApiKey but a mismatched relay URL as not configured', () => {
    const snapshot = buildSnapshot(['codex'])
    const providers = buildConfig([]).providers
    providers.codex = { ...providers.codex, exists: true, hasApiKey: true, matchesRelay: false }
    const summary = computeNextSteps(snapshot, { workspace: '', providers }, noNudge)
    expect(summary.steps[1]).toEqual({ id: 'configure-first-cli', done: false })
  })

  it('accepts a configured desktop app without requiring a CLI or Node runtime', () => {
    const summary = computeNextSteps(buildSnapshot([], true), buildConfig(['codex']), noNudge)
    expect(summary.steps[0].done).toBe(true)
    expect(summary.steps[1].done).toBe(true)
    expect(summary.visible).toBe(false)
  })

  it('keeps the official ChatGPT account ready without asking for a relay key', () => {
    const config = buildConfig()
    config.providers.codex = buildProviderConfig({ exists: true, codexAuthMode: 'chatgpt' })
    expect(computeNextSteps(buildSnapshot([], true), config, noNudge).visible).toBe(false)
    expect(resolveLaunchableProvider(buildSnapshot(['codex']), config)).toBe('codex')
  })

  it('does not count configuration belonging only to an uninstalled tool', () => {
    const summary = computeNextSteps(buildSnapshot(['claude']), buildConfig(['codex']), noNudge)
    expect(summary.steps[1].done).toBe(false)
    expect(summary.visible).toBe(true)
  })

  it('does not treat Grok without an API key as an official account', () => {
    const config = buildConfig()
    config.providers.grok = buildProviderConfig({ exists: true })
    expect(computeNextSteps(buildSnapshot(['grok']), config, noNudge).steps[1].done).toBe(false)
  })
})

describe('resolveLaunchableProvider', () => {
  it('returns null when config has not loaded yet', () => {
    expect(resolveLaunchableProvider(buildSnapshot(['codex']), null)).toBeNull()
  })

  it('returns null when nothing is both installed and configured', () => {
    const snapshot = buildSnapshot(['codex'])
    const config = buildConfig(['claude']) // configured but not installed
    expect(resolveLaunchableProvider(snapshot, config)).toBeNull()
  })

  it('prefers Claude first when multiple providers qualify, matching the prototype grid order', () => {
    const snapshot = buildSnapshot(['codex', 'claude'])
    const config = buildConfig(['codex', 'claude'])
    expect(resolveLaunchableProvider(snapshot, config)).toBe('claude')
  })

  it('falls through to the next qualifying provider in display order when codex does not qualify', () => {
    const snapshot = buildSnapshot(['claude'])
    const config = buildConfig(['claude'])
    expect(resolveLaunchableProvider(snapshot, config)).toBe('claude')
  })
})
