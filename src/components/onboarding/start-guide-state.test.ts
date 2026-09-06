import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EmptyStatus } from '../../app-shared'
import { platformCapabilitiesFor } from '../../../electron/platform-capabilities'
import type { AppConfigSummary, ProviderConfigSummary, ProviderId } from '../../types'
import { StartGuide } from './StartGuide'
import { availableGuideRoutes, guideNextStep, guideReadiness } from './start-guide-state'

const windows = platformCapabilitiesFor('win32', 'x64')
const linux = platformCapabilitiesFor('linux', 'x64')
function buildConfig(overrides: Partial<ProviderConfigSummary> = {}): AppConfigSummary {
  const entry: ProviderConfigSummary = { exists: true, baseUrl: 'https://xm.solov.cc', actualBaseUrl: 'https://xm.solov.cc', hasApiKey: true, matchesRelay: true, model: 'model', dataDirectory: '', dataDirectoryExists: true, files: [], updatedAt: null, apiKeyPreview: 'sk-***', ...overrides }
  return { workspace: '', providers: Object.fromEntries(['codex', 'claude', 'gemini', 'grok'].map((id) => [id, { ...entry }])) as Record<ProviderId, ProviderConfigSummary> }
}
function installedSnapshot() {
  const snapshot = EmptyStatus()
  snapshot.runtime.node = { ...snapshot.runtime.node, installed: true, version: '24.0.0', path: 'C:\\node' }
  snapshot.runtime.npm = { ...snapshot.runtime.npm, installed: true, version: '11.0.0', path: 'C:\\npm' }
  snapshot.clis.claude = { ...snapshot.clis.claude, installed: true, version: '1.2.3' }
  snapshot.clis.codex = { ...snapshot.clis.codex, installed: true, version: '1.2.3' }
  snapshot.desktopApps.codex = { ...snapshot.desktopApps.codex, installed: true }
  return snapshot
}

describe('start guide readiness', () => {
  it('offers every route equally and omits unavailable Desktop on Linux', () => {
    expect(new Set(availableGuideRoutes(windows))).toEqual(new Set(['codexDesktop', 'codex', 'claude', 'gemini', 'grok', 'chat']))
    expect(availableGuideRoutes(linux)).not.toContain('codexDesktop')
    expect(availableGuideRoutes(linux)).toHaveLength(5)
  })

  it('opens with no selected route and no implicit installation', () => {
    const install = vi.fn()
    const markup = renderToStaticMarkup(createElement(StartGuide, { platform: windows, snapshot: EmptyStatus(), config: null, scanning: false, busy: false, onScan: vi.fn(), onInstall: install, onPrepareRuntime: vi.fn(), onConfigure: vi.fn(), onComplete: vi.fn(), onCancel: vi.fn() }))
    expect(markup.match(/type="radio"/g)).toHaveLength(6)
    expect(markup).not.toContain('checked=""')
    expect(markup).toContain('data-guide-step="choose"')
    expect(markup).not.toContain('推荐')
    expect(install).not.toHaveBeenCalled()
  })

  it('keeps choose pending until the user picks a route', () => {
    expect(guideNextStep('choose', null, null)).toBe('choose')
  })

  it('allows direct chat without local runtime, config or probes', () => {
    const readiness = guideReadiness('chat', linux, EmptyStatus(), null)
    expect(readiness.prepared).toBe(true)
    expect(readiness.connected).toBe(true)
    expect(readiness.runtimeRequired).toBe(false)
    expect(guideNextStep('choose', 'chat', readiness)).toBe('ready')
  })

  it('prepares Desktop without Node or npm', () => {
    const snapshot = EmptyStatus()
    snapshot.desktopApps.codex.installed = true
    const readiness = guideReadiness('codexDesktop', windows, snapshot, buildConfig())
    expect(readiness.runtimeRequired).toBe(false)
    expect(readiness.prepared).toBe(true)
  })

  it('rejects Desktop on an unsupported platform even if a stale probe says installed', () => {
    const readiness = guideReadiness('codexDesktop', linux, installedSnapshot(), buildConfig())
    expect(readiness.supported).toBe(false)
    expect(readiness.prepared).toBe(false)
    expect(guideNextStep('choose', 'codexDesktop', readiness)).toBe('choose')
  })

  it.each([{ tooOld: true }, { versionStatus: 'unknown' as const }, { detectionFailed: true }])('does not bypass an unusable CLI runtime: %j', (override) => {
    const snapshot = installedSnapshot()
    snapshot.runtime.node = { ...snapshot.runtime.node, ...override }
    const readiness = guideReadiness('claude', windows, snapshot, buildConfig())
    expect(readiness.runtimeReady).toBe(false)
    expect(readiness.prepared).toBe(false)
    expect(guideNextStep('prepare', 'claude', readiness)).toBe('prepare')
  })

  it('requires npm and reports a failed probe distinctly from missing runtime', () => {
    const snapshot = installedSnapshot()
    snapshot.runtime.npm = { ...snapshot.runtime.npm, installed: false, detectionFailed: true }
    const readiness = guideReadiness('claude', windows, snapshot, buildConfig())
    expect(readiness.runtimeFailed).toBe(true)
    expect(readiness.runtimeReady).toBe(false)
  })

  it('does not interpret a failed tool probe as an installable missing tool', () => {
    const snapshot = installedSnapshot()
    snapshot.clis.claude = { ...snapshot.clis.claude, installed: false, detectionFailed: true }
    const readiness = guideReadiness('claude', windows, snapshot, buildConfig())
    expect(readiness.toolDetectionFailed).toBe(true)
    expect(readiness.prepared).toBe(false)
  })

  it('allows an independently confirmed Desktop install with an incomplete version probe', () => {
    const snapshot = installedSnapshot()
    snapshot.desktopApps.codex.detectionFailed = true
    expect(guideReadiness('codexDesktop', windows, snapshot, buildConfig()).prepared).toBe(true)
  })

  it('requires a real configuration read before continuing connection', () => {
    const readiness = guideReadiness('claude', windows, installedSnapshot(), null)
    expect(readiness.connection).toBe('unread')
    expect(guideNextStep('connect', 'claude', readiness)).toBe('connect')
  })

  it('retains unknown third-party sources and advances only after a verified source change', () => {
    const snapshot = installedSnapshot()
    const unknown = guideReadiness('claude', windows, snapshot, buildConfig({ matchesRelay: false }))
    expect(unknown.connection).toBe('unknown')
    expect(guideNextStep('connect', 'claude', unknown)).toBe('connect')
    const connected = guideReadiness('claude', windows, snapshot, buildConfig())
    expect(guideNextStep('connect', 'claude', connected)).toBe('ready')
  })

  it('requires actual ChatGPT login state and accepts it for both Codex entry points', () => {
    const snapshot = installedSnapshot()
    const signedOut = buildConfig({ hasApiKey: false, matchesRelay: false })
    expect(guideReadiness('codex', windows, snapshot, signedOut).connection).toBe('official-login-required')
    const signedIn = buildConfig({ hasApiKey: false, matchesRelay: false, codexAuthMode: 'chatgpt' })
    expect(guideReadiness('codex', windows, snapshot, signedIn).connected).toBe(true)
    expect(guideReadiness('codexDesktop', windows, snapshot, signedIn).connected).toBe(true)
  })

  it('preserves Claude/Google official sources but never offers Grok official login', () => {
    const config = buildConfig({ hasApiKey: false, matchesRelay: false })
    expect(guideReadiness('claude', windows, installedSnapshot(), config).connection).toBe('official')
    expect(guideReadiness('gemini', windows, installedSnapshot(), config).connection).toBe('official')
    expect(guideReadiness('grok', windows, installedSnapshot(), config).connected).toBe(false)
  })

  it('rechecks tool readiness before leaving connection', () => {
    const readiness = guideReadiness('claude', windows, EmptyStatus(), buildConfig())
    expect(readiness.connected).toBe(true)
    expect(guideNextStep('connect', 'claude', readiness)).toBe('connect')
  })
})
