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

  it('已配置但只装了一个: first CLI installed and configured, but only one tool total — still visible', () => {
    const snapshot = buildSnapshot(['codex'])
    const config = buildConfig(['codex'])
    const summary = computeNextSteps(snapshot, config, noNudge)
    expect(summary.steps[0]).toEqual({ id: 'install-first-cli', done: true })
    expect(summary.steps[1]).toEqual({ id: 'configure-first-cli', done: true })
    expect(summary.steps[3]).toEqual({ id: 'install-second-tool', done: false })
    expect(summary.visible).toBe(true)
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
    // Nudge completion alone must never hide the card — only the three
    // derivable milestones (installed / configured / second tool) do.
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

  it('prefers codex first when multiple providers qualify, matching the CLI grid order', () => {
    const snapshot = buildSnapshot(['codex', 'claude'])
    const config = buildConfig(['codex', 'claude'])
    expect(resolveLaunchableProvider(snapshot, config)).toBe('codex')
  })

  it('falls through to the next qualifying provider in display order when codex does not qualify', () => {
    const snapshot = buildSnapshot(['claude'])
    const config = buildConfig(['claude'])
    expect(resolveLaunchableProvider(snapshot, config)).toBe('claude')
  })
})
