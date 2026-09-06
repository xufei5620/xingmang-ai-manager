import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EmptyStatus } from '../src/app-shared'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import { Dashboard } from '../src/components/dashboard/Dashboard'
import { WelcomePage } from '../src/components/welcome/WelcomePage'
import type { AppConfigSummary, ProviderConfigSummary, ProviderId, XingmangApi } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

const search = new URLSearchParams(window.location.search)
const theme = search.get('theme') === 'dark' ? 'dark' : 'light'
const scenario = search.get('scenario') ?? 'welcome'
document.documentElement.dataset.theme = theme
document.documentElement.dataset.skin = search.get('skin') ?? (theme === 'dark' ? 'obsidian' : 'dawn')
document.body.style.margin = '0'

declare global { interface Window { primaryViewActions: string[] } }
window.primaryViewActions = []
const record = (action: string) => () => { window.primaryViewActions.push(action) }
window.xingmang = {
  getLegalDocument: async (kind: string) => ({ kind, markdown: '# 用户协议\n\n测试文档', updatedAt: null }),
} as unknown as XingmangApi

const snapshot = EmptyStatus()
const configured = { exists: true, hasApiKey: true, matchesRelay: true, model: 'gpt-test', baseUrl: 'https://xm.solov.cc', actualBaseUrl: 'https://xm.solov.cc', dataDirectory: '', dataDirectoryExists: true, files: [], updatedAt: null, apiKeyPreview: 'sk-***' } satisfies ProviderConfigSummary
const providerConfig: Record<ProviderId, ProviderConfigSummary> = { codex: { ...configured }, claude: { ...configured }, gemini: { ...configured }, grok: { ...configured } }
const config: AppConfigSummary = { workspace: 'C:\\fixture', providers: providerConfig }
if (scenario !== 'missing') {
  for (const id of ['codex', 'claude', 'gemini', 'grok'] as const) snapshot.clis[id] = { ...snapshot.clis[id], installed: true, version: '1.2.3', updateAvailable: id === 'claude', latestVersion: '1.3.0', updateState: id === 'claude' ? 'available' : 'latest' }
  snapshot.desktopApps.codex = { ...snapshot.desktopApps.codex, installed: true, version: '26.803.1', running: true }
  snapshot.runtime.node = { ...snapshot.runtime.node, installed: true, version: '24.0.0', path: 'C:\\node' }
  snapshot.runtime.npm = { ...snapshot.runtime.npm, installed: true, version: '11.0.0', path: 'C:\\npm' }
}
if (scenario === 'official') {
  config.providers.codex = { ...configured, hasApiKey: false, matchesRelay: false, codexAuthMode: 'chatgpt', officialAccountEmail: 'official@example.com', officialAccountPlan: 'Pro', model: '' }
  config.providers.claude = { ...configured, hasApiKey: false, matchesRelay: false }
}
if (scenario === 'third-party') config.providers.claude = { ...configured, matchesRelay: false, actualBaseUrl: 'https://custom.example.com' }
if (scenario === 'failed') snapshot.clis.grok = { ...snapshot.clis.grok, installed: false, detectionFailed: true, detectionError: 'Fixture detection failed' }

function Fixture() {
  const [reducedMotion, setReducedMotion] = useState(false)
  return scenario === 'welcome'
    ? <WelcomePage theme={theme} reducedMotion={reducedMotion} onReducedMotionChange={setReducedMotion} onRegister={record('register')} onLogin={record('login')} onOpenSupport={record('support')} onOpenGuide={record('guide')} />
    : <Dashboard platform={platformCapabilitiesFor('win32', 'x64')} snapshot={snapshot} config={config} scanning={false} installing={new Set()} cliLaunching={null} codexLaunchPhase="idle"
      codexDesktopInstalling={false} codexDesktopInstallProgress={null} nodeRuntimeInstalling={false} nodeRuntimeInstallProgress={null} pythonRuntimeInstalling={false} pythonRuntimeInstallProgress={null}
      runtimeReady={scenario !== 'missing'} installedCliCount={scenario === 'missing' ? 0 : 4} installedToolCount={scenario === 'missing' ? 0 : 5} nextStepsNudge={{ triedLaunch: false, exploredMcp: false }}
      onScan={record('scan')} onInstallNode={record('node')} onInstallPython={record('python')} onOpenNodeGuide={record('node-guide')} onInstall={(id) => record(`install:${id}`)()} onInstallAll={record('install-all')}
      onConfigure={(id) => record(`configure:${id}`)()} onConfigureCodexDesktop={record('configure:desktop')} onInstallCodexDesktop={record('install:desktop')}
      onLaunch={(id) => record(`launch:${id}`)()} onLaunchCodexDesktop={record('launch:desktop')} onNextStepsConfigureFirstCli={record('connect')} onNextStepsTryLaunch={record('launch-next')}
      onNextStepsGoMaintenance={record('maintenance')} onNextStepsExploreMcp={record('mcp')} onRefreshOfficialUsage={record('official-usage')}
      accountSummary={{ label: '测试账号', balanceLabel: '$ 4.00', usageLabel: '已使用 $ 0.20' }} onOpenAccount={record('account')} onOpenHistory={record('history')} />
}

createRoot(document.getElementById('root')!).render(<Fixture />)
