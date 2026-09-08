import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AccountStatus } from '../../../../electron/ipc-contract'
import { AuthFlow } from './AuthFlow'
import { Welcome } from './Welcome'
import { StartGuide, type GuideRoute, type GuideToolState } from './StartGuide'
import { Splash } from './Splash'
import type { AuthApi } from './api'
import '../../ui'
import './auth.css'

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') ?? 'light'
document.documentElement.dataset.skin = query.get('skin') ?? (document.documentElement.dataset.theme === 'dark' ? 'obsidian' : 'dawn')
document.documentElement.dataset.os = query.get('os') ?? 'win'
document.body.style.margin = '0'
document.body.style.fontFamily = 'var(--font)'
document.body.style.background = 'var(--bg)'
document.body.style.height = '100vh'
document.getElementById('root')!.style.height = '100%'
const calls: Array<{ method: string; input?: unknown }> = []
function record(method: string, input?: unknown) { calls.push({ method, input }); document.documentElement.dataset.calls = JSON.stringify(calls) }
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
function waitForRelease(method: string): Promise<void> { return query.getAll('pending').includes(method) ? new Promise<void>((resolve, reject) => pending.set(method, { resolve, reject })) : Promise.resolve() }
const status: AccountStatus = { systemName: 'Test fixture', version: '1', setupComplete: true, quotaPerUnit: 1, quotaDisplayType: 'USD', usdExchangeRate: 1, registerEnabled: true, passwordRegisterEnabled: true, emailVerificationEnabled: true, turnstileCheckEnabled: false }
const api: AuthApi = {
  getStatus: async () => status,
  getRemembered: async () => null,
  setRemembered: async (input) => { record('remember', input) },
  login: async (input) => { record('login', input); if (query.has('fail')) throw new Error('invalid password'); return { account: { userId: 7, username: input.username, quota: 0, usedQuota: 0, group: 'default', role: 1 }, accessExpiresAt: null } },
  register: async (input) => { record('register', input); await waitForRelease('register') },
  sendVerification: async (input) => { record('verification', input) },
  sendReset: async (input) => { record('send-reset', input); await waitForRelease('send-reset') },
  reset: async (input) => { record('reset', input); await waitForRelease('reset'); return { newPassword: 'new-test-password' } },
  getLegal: async (kind) => ({ kind, markdown: '# Test Agreement\n\nLocal fixture content.', fetchedAt: '2026-09-07T00:00:00Z' }),
  openExternal: async (input) => { record('external', input); return true },
  copyPassword: async (input) => { record('copy', input); await waitForRelease('copy'); if (query.has('copyFail')) throw new Error('denied') },
}
declare global { interface Window { authHarness: { release: (method: string) => void; reject: (method: string) => void; switchScope: (scope: string) => void; reopen: () => void } } }
function Fixture() {
  const [motion, setMotion] = useState(true)
  const [signedIn, setSignedIn] = useState(!query.has('loggedOut'))
  const [tools, setTools] = useState<GuideToolState[]>(['claude', 'codex', 'codexDesktop', 'gemini', 'grok'].map((id) => ({ id: id as GuideToolState['id'], installed: query.has('installed'), configured: query.has('connected'), source: query.has('unknown') ? 'unknown' : query.has('official') ? 'official' : 'account', runtimeReady: query.has('runtime'), pythonReady: query.has('python'), installMode: 'managed' })))
  const [resumeScope, setResumeScope] = useState('site:7')
  const [guideVisible, setGuideVisible] = useState(true)
  window.authHarness = { release: (method) => pending.get(method)?.resolve(), reject: (method) => pending.get(method)?.reject(new Error('fixture failed')), switchScope: setResumeScope, reopen: () => setGuideVisible(true) }
  const scenario = query.get('scenario') ?? 'login'
  const update = (id: GuideRoute, patch: Partial<GuideToolState>) => setTools((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  if (scenario === 'welcome') return <Welcome onLogin={() => record('login-entry')} onRegister={() => record('register-entry')} onSteps={() => record('steps')} onHelp={() => record('help')} onLegal={(kind) => record('legal', kind)} reducedMotion={motion} onReducedMotionChange={setMotion} />
  if (scenario === 'splash') return <Splash phase="正在准备工作台" detail="检查本地环境" progress={42} />
  if (scenario === 'guide') return guideVisible ? <StartGuide platform={query.get('os') === 'mac' ? 'mac' : query.get('os') === 'linux' ? 'linux' : 'win'} tools={tools} signedIn={signedIn} resumeKey={query.has('resume') ? resumeScope : undefined} onDetect={async () => { record('detect'); await waitForRelease('detect') }} onInstall={async (route) => { record('install', route); update(route, { installed: true }) }} onInstallRuntime={async () => { record('runtime'); setTools((items) => items.map((item) => ({ ...item, runtimeReady: true }))) }} onInstallPython={async () => { record('python'); await waitForRelease('python'); setTools((items) => items.map((item) => ({ ...item, pythonReady: true }))) }} onConfigure={async (route) => { record('configure', route); update(route, { configured: true, source: 'account' }) }} onLogin={() => { record('guide-login'); setSignedIn(true) }} onLaunch={async (route) => { record('launch', route); return query.has('launchCancel') ? false : undefined }} onComplete={(route) => record('complete', route)} onBack={() => { record('back'); setGuideVisible(false) }} onHelp={() => record('help')} /> : <p>引导已暂停</p>
  return <AuthFlow api={api} initialMode={scenario === 'register' ? 'register' : scenario === 'recovery' ? 'recovery' : 'login'} onAuthenticated={(result) => record('authenticated', result.account.username)} onClose={() => record('close')} />
}
createRoot(document.getElementById('root')!).render(query.has('strict') ? <StrictMode><Fixture /></StrictMode> : <Fixture />)
