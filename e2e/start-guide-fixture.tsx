import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StartGuide, type GuideRoute } from '../src/components/onboarding/StartGuide'
import { EmptyStatus } from '../src/app-shared'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import type { AppConfigSummary, ProviderConfigSummary, ProviderId } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

const search = new URLSearchParams(location.search)
const scenario = search.get('scenario') ?? 'missing'
const platform = platformCapabilitiesFor(search.get('platform') ?? 'win32', 'x64')
document.documentElement.dataset.theme = search.get('theme') ?? 'dark'
document.documentElement.dataset.skin = search.get('theme') === 'light' ? 'dawn' : 'obsidian'

declare global {
  interface Window {
    startGuideHarness: {
      calls: string[]
      release: (success: boolean) => void
      applyConfig: (source: 'relay' | 'official' | 'unknown' | 'missing') => void
    }
  }
}
window.startGuideHarness = { calls: [], release: () => {}, applyConfig: () => {} }
const initialSnapshot = EmptyStatus()
const allInstalled = ['installed', 'slow-complete', 'complete-failed', 'tool-probe-failed'].includes(scenario)
if (allInstalled) {
  for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) initialSnapshot.clis[provider].installed = true
  initialSnapshot.desktopApps.codex.installed = true
}
if (allInstalled || scenario === 'slow-install' || scenario === 'install-failed') {
  initialSnapshot.runtime.node = { ...initialSnapshot.runtime.node, installed: true, version: '24.0.0', path: 'C:\\node' }
  initialSnapshot.runtime.npm = { ...initialSnapshot.runtime.npm, installed: true, version: '11.0.0', path: 'C:\\npm' }
}
if (scenario === 'runtime-probe-failed') initialSnapshot.runtime.node.detectionFailed = true
if (scenario === 'tool-probe-failed') initialSnapshot.clis.claude = { ...initialSnapshot.clis.claude, installed: false, detectionFailed: true }

function configFor(source: 'relay' | 'official' | 'unknown' | 'missing'): AppConfigSummary {
  const entry: ProviderConfigSummary = { exists: source !== 'missing', baseUrl: 'https://xm.solov.cc', actualBaseUrl: source === 'unknown' ? 'https://custom.example.com' : 'https://xm.solov.cc', hasApiKey: source === 'relay' || source === 'unknown', matchesRelay: source === 'relay', codexAuthMode: source === 'official' ? 'chatgpt' : 'apikey', model: '', dataDirectory: '', dataDirectoryExists: true, files: [], updatedAt: null, apiKeyPreview: null }
  return { workspace: 'C:\\projects\\fixture', providers: Object.fromEntries(['codex', 'claude', 'gemini', 'grok'].map((provider) => [provider, { ...entry }])) as Record<ProviderId, ProviderConfigSummary> }
}

function Fixture() {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [config, setConfig] = useState<AppConfigSummary | null>(search.get('configured') === 'true' ? configFor('relay') : null)
  const [completed, setCompleted] = useState<GuideRoute | null>(null)
  const [cancelled, setCancelled] = useState(false)
  window.startGuideHarness.applyConfig = (source) => setConfig(configFor(source))
  const waitForRelease = () => new Promise<void>((resolve, reject) => {
    window.startGuideHarness.release = (success) => success ? resolve() : reject(new Error('Fixture task failed'))
  })

  return <>
    <StartGuide platform={platform} snapshot={snapshot} config={config} scanning={false} busy={false}
      onScan={async () => { window.startGuideHarness.calls.push('scan') }}
      onInstall={async (route) => {
        window.startGuideHarness.calls.push(`install:${route}`)
        if (scenario === 'slow-install') await waitForRelease()
        if (scenario === 'install-failed' && window.startGuideHarness.calls.filter((call) => call === `install:${route}`).length === 1) throw new Error('Fixture install failed')
        if (platform.codexDesktop.install === 'external' && route === 'codexDesktop') return
        setSnapshot((current) => route === 'codexDesktop'
          ? { ...current, desktopApps: { codex: { ...current.desktopApps.codex, installed: true } } }
          : route !== 'chat' ? { ...current, clis: { ...current.clis, [route]: { ...current.clis[route], installed: true } } } : current)
      }}
      onPrepareRuntime={async () => {
        window.startGuideHarness.calls.push('runtime')
        if (platform.nodeRuntimeInstall === 'external') return
        setSnapshot((current) => ({ ...current, runtime: { ...current.runtime, node: { ...current.runtime.node, installed: true, version: '24.0.0', path: 'C:\\node' }, npm: { ...current.runtime.npm, installed: true, version: '11.0.0', path: 'C:\\npm' } } }))
      }}
      onConfigure={(route) => { window.startGuideHarness.calls.push(`configure:${route}`) }}
      onComplete={async (route) => {
        window.startGuideHarness.calls.push(`complete:${route}`)
        if (scenario === 'slow-complete') await waitForRelease()
        if (scenario === 'complete-failed') throw new Error('Fixture launch failed')
        setCompleted(route)
      }}
      onCancel={() => { window.startGuideHarness.calls.push('cancel'); setCancelled(true) }}
    />
    <output hidden data-testid="completed-route">{completed}</output><output hidden data-testid="cancelled">{String(cancelled)}</output>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
