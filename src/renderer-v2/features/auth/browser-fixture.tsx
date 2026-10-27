import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AccountStatus } from '../../../../electron/ipc-contract'
import { networkFailureMessages, toolCertificateMessages, type NetworkFailureReason } from '../../../../electron/network-failure'
import { AuthFlow } from './AuthFlow'
import { Welcome } from './Welcome'
import { StartGuide, type GuideRoute, type GuideToolState } from './StartGuide'
import { Splash } from './Splash'
import type { AuthApi } from './api'
import { ToastProvider } from '../../ui'
import './auth.css'

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') ?? 'light'
document.documentElement.dataset.os = query.get('os') ?? 'win'
// 与 App.tsx 一致：低配判定由主进程给出，挂在根节点上。
if (query.has('lowEnd')) document.documentElement.dataset.lowEnd = 'true'
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
// `turnstile` takes a site id, or `1` for both, so a per-site status can be exercised.
const turnstileSites = (query.get('turnstile') ?? '').split(',').filter(Boolean)
// Status reads stay out of `calls`: several checks assert that array exactly.
const statusSites: string[] = []
// `statusFail` makes the first `statusFailures` (default 1) status reads fail the way the main process reports that reason.
const statusFail = query.get('statusFail') as NetworkFailureReason | null
let statusFailuresLeft = Number(query.get('statusFailures') ?? '1')
// `loginFail` makes the first login fail the way the main process reports that network reason.
const loginFail = query.get('loginFail') as NetworkFailureReason | null
let loginFailuresLeft = 1
// 找回密码那几步按一个账号来演：重置后它认临时密码，改成功后认新密码，登录时核对密码。其余场景不设密码，来什么收什么。
let accountPassword: string | null = null
// 主进程此刻登着谁（account:get-session）。登录、两步验证成功就登上；sessionLost 让它一直说没登着，
// changeLost 演 2026-10-27 那一单：密码已经改好，这次登录却在改的半路被服务端结束了。
let session: { siteId: 'solov' | 'solov-api' } | null = null
let changeAttempted = false
// probeFail：改密码报错之后再拿新密码试登，按这种网络原因连不上。
const probeFail = query.get('probeFail') as NetworkFailureReason | null
// `keychainRefused` makes every login fail the way the main process reports a refused OS key store (Mac keychain prompt denied).
const keychainRefused = query.has('keychainRefused')
const api: AuthApi = {
  getStatus: async (siteId) => { statusSites.push(siteId); document.documentElement.dataset.statusSites = statusSites.join(','); await waitForRelease(`status-${siteId}`); if (statusFail && statusFailuresLeft > 0) { statusFailuresLeft--; throw new Error(`Error invoking remote method 'account:get-status': Error: ${networkFailureMessages[statusFail]}（账号服务状态查询失败）`) } return { ...status, systemName: `Test fixture ${siteId}`, turnstileCheckEnabled: turnstileSites.includes(siteId) || turnstileSites.includes('1') } },
  getRemembered: async (siteId) => { await waitForRelease(`remembered-${siteId}`); return query.has('remembered') ? { identifier: 'same@example.test', password: `${siteId}-remembered-password` } : null },
  setRemembered: async (input, siteId) => { document.documentElement.dataset.savedSite = siteId ?? '';  record('remember', input) },
  login: async (input) => { record('login', input); await waitForRelease('login'); if (query.has('twoFactor')) throw new Error('此账号需要双重验证，请先在官方网站完成验证'); if (query.has('totp') && input.siteId === 'solov') throw new Error("Error invoking remote method 'account:login': Error: 此账号需要双重验证，请先完成验证"); if (keychainRefused) throw new Error("Error invoking remote method 'account:login': RealmAccountError: 账号安全存储不可用：系统加密服务没有放行，原记录未修改"); if (query.has('fail')) throw new Error('invalid password'); if (loginFail && loginFailuresLeft > 0) { loginFailuresLeft--; throw new Error(`Error invoking remote method 'account:login': Error: ${networkFailureMessages[loginFail]}（账号登录请求失败）`) } if (probeFail && changeAttempted) throw new Error(`Error invoking remote method 'account:login': Error: ${networkFailureMessages[probeFail]}（账号登录请求失败）`); if (accountPassword !== null && input.password !== accountPassword) throw new Error("Error invoking remote method 'account:login': Error: 用户名或密码错误"); session = { siteId: input.siteId ?? 'solov' }; return { account: { userId: 7, username: input.username, quota: 0, usedQuota: 0, group: 'default', role: 1 }, accessExpiresAt: null, siteId: input.siteId ?? 'solov' } },
  session: async () => session && !query.has('sessionLost') ? { authenticated: true, account: { userId: 7, username: 'fixture-member', quota: 0, usedQuota: 0, group: 'default', role: 1 }, siteId: session.siteId } : { authenticated: false, account: null },
  // totp：当前账号开了两步验证。111111 当输错，totpExpired 模拟超过 5 分钟。
  submitTwoFactor: async (code) => { record('two-factor', code); await waitForRelease('two-factor'); if (query.has('totpExpired')) throw new Error('等太久了，请重新输入密码登录'); if (code === '111111') throw new Error('验证码不对或已过期，请看验证器里最新的数字再试'); session = { siteId: 'solov' }; return { account: { userId: 7, username: 'totp-user', quota: 0, usedQuota: 0, group: 'default', role: 1 }, accessExpiresAt: null, siteId: 'solov' } },
  register: async (input) => { record('register', input); await waitForRelease('register'); if (query.has('usernameTaken')) throw new Error('Username already exists'); if (query.has('emailTaken')) throw new Error('Email address is already in use') },
  sendVerification: async (input) => { record('verification', input) },
  sendReset: async (email, siteId) => { record('send-reset', { email, siteId }); await waitForRelease('send-reset') },
  reset: async (input, siteId) => { record('reset', { ...input, siteId }); await waitForRelease('reset'); accountPassword = 'new-test-password'; return { newPassword: 'new-test-password' } },
  // 用临时密码登上了，但换成新密码那一步报错：changeFail 说不清是什么错、密码其实没改；
  // changeRefused 是服务端明说不改；changeLost 是密码改好了、这次登录却被结束了。
  changePassword: async (input) => {
    record('change-password', input); changeAttempted = true; await waitForRelease('change-password')
    if (query.has('changeFail')) throw new Error('修改密码失败：服务暂时不可用')
    if (query.has('changeRefused')) throw new Error("Error invoking remote method 'account:change-password': Error: 请求太频繁，请稍后再试")
    if (accountPassword !== null) accountPassword = input.newPassword
    if (query.has('changeLost')) { session = null; throw new Error("Error invoking remote method 'account:change-password': Error: 账号上下文已变化，请重试") }
    return { changed: true }
  },
  getLegal: async (kind) => ({ kind, markdown: '# Test Agreement\n\nLocal fixture content.', fetchedAt: '2026-09-07T00:00:00Z' }),
  openExternal: async (input) => { record('external', input); return true },
  copyPassword: async (input) => { record('copy', input); await waitForRelease('copy'); if (query.has('copyFail')) throw new Error('denied') },
}
declare global { interface Window { authHarness: { release: (method: string) => void; reject: (method: string) => void; endSession: () => void; switchScope: (scope: string) => void; reopen: () => void; setTool: (tool: Exclude<GuideRoute, 'chat'>, patch: Partial<GuideToolState>) => void } } }
function Fixture() {
  const [motion, setMotion] = useState(!query.has('motion'))
  const [theme, setTheme] = useState<'light' | 'dark'>(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [signedIn, setSignedIn] = useState(!query.has('loggedOut'))
  const [tools, setTools] = useState<GuideToolState[]>(['claude', 'codex', 'codexDesktop', 'grok'].map((id) => ({ id: id as GuideToolState['id'], installed: query.has('installed'), configured: query.has('connected'), source: query.has('unknown') ? 'unknown' : query.has('official') ? 'official' : 'account', ...(query.has('unknown') && query.has('switchable') ? { keyState: 'otherSite' as const } : {}), runtimeReady: query.has('runtime'), officialLoginRequired: query.has('officialLoginRequired'), installMode: 'managed', runtimeAutoPrepare: query.has('auto'), ...(query.has('outdated') && id === 'claude' ? { version: '2.1.42', update: { version: '2.1.277', target: '2.1.277', newer: true, knownIssue: false, manualHint: query.has('outdatedManual') ? '该版本不是通过本工具安装的，更新请用它原本的安装方式' : null } } : {}), ...(query.has('keySyncFail') && id === 'claude' ? { configured: false, source: 'none' as const, keySyncFailure: { text: 'Claude Code：密钥没有写进去，点「重新同步」再试', retry: true } } : {}) })))
  const [resumeScope, setResumeScope] = useState('site:7')
  const [guideVisible, setGuideVisible] = useState(true)
  window.authHarness = { release: (method) => pending.get(method)?.resolve(), reject: (method) => pending.get(method)?.reject(new Error('fixture failed')), endSession: () => { session = null }, switchScope: setResumeScope, reopen: () => setGuideVisible(true), setTool: (tool, patch) => setTools((items) => items.map((item) => item.id === tool ? { ...item, ...patch } : item)) }
  const scenario = query.get('scenario') ?? 'login'
  const update = (id: GuideRoute, patch: Partial<GuideToolState>) => setTools((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  if (scenario === 'welcome') return <Welcome onLogin={() => record('login-entry')} onRegister={() => record('register-entry')} onSteps={() => record('steps')} onHelp={() => record('help')} onLegal={(kind) => record('legal', kind)} onHistoryLogin={() => record('history-login-entry')} theme={theme} onThemeToggle={() => { record('theme'); setTheme((value) => value === 'dark' ? 'light' : 'dark') }} reducedMotion={motion} onReducedMotionChange={setMotion} />
  if (scenario === 'splash') return <Splash phase="正在准备工作台" detail="检查本地环境" progress={42} />
  if (scenario === 'guide') return guideVisible ? <StartGuide platform={query.get('os') === 'mac' ? 'mac' : query.get('os') === 'linux' ? 'linux' : 'win'} tools={tools} signedIn={signedIn} walletEmpty={query.has('walletEmpty')} resumeKey={query.has('resume') ? resumeScope : undefined} onDetect={async () => { record('detect'); await waitForRelease('detect') }} onInstall={async (route, version) => { record('install', version ? { route, version } : route); if (query.has('installFail') && calls.filter((item) => item.method === 'install').length === 1) throw new Error('Node.js 运行环境没装上，Claude Code 还没开始安装。下载 Node.js 时 ETIMEDOUT'); if (query.has('certFail') && calls.filter((item) => item.method === 'install').length === 1) throw new Error(`Claude Code 安装失败：npm 官方源：SELF_SIGNED_CERT_IN_CHAIN。${toolCertificateMessages.outdatedNode}`); if (query.has('oddFail') && calls.filter((item) => item.method === 'install').length === 1) throw new Error('npm ERR! code E999 registry answered sk-abcdefghijklmnopqrstuvwxyz0123456789'); update(route, { installed: true, ...(version ? { version, update: null } : {}), ...(query.has('auto') ? { runtimeReady: true } : {}) }) }} onInstallRuntime={async () => { record('runtime'); setTools((items) => items.map((item) => ({ ...item, runtimeReady: true }))) }} onConfigure={async (route) => { record('configure', route); update(route, { configured: true, source: 'account', officialLoginRequired: false }) }} onLogin={() => { record('guide-login'); setSignedIn(true) }} onLaunch={async (route) => { record('launch', route); if (query.has('launchFail') && calls.filter((item) => item.method === 'launch').length === 1) throw new Error('请先确认账号连接，再打开工具。'); return query.has('launchCancel') ? false : undefined }} onComplete={(route) => record('complete', route)} onBack={() => { record('back'); setGuideVisible(false) }} onHelp={() => record('help')} onRegister={() => record('guide-register')} {...(query.has('keySyncFail') ? { onBootstrapRetry: async (route: Exclude<GuideRoute, 'chat'>) => { record('resync', route); if (query.has('keySyncFailAgain')) return false; update(route, { configured: true, source: 'account', keySyncFailure: undefined }); return true } } : {})} {...(query.has('switchable') ? { accountName: 'peaker', support: { signedIn: true, account: { userId: 7, username: 'peaker' }, version: '0.2.11', os: 'win' as const }, onFailure: (failure: { action?: string; reason?: string; detail?: string }) => { document.documentElement.dataset.guideFailure = JSON.stringify({ action: failure.action, reason: failure.reason, detail: failure.detail }) }, canReplaceNode: query.has('replaceNode'), onFailureAction: (action: string, retry?: () => void) => { record('exit', action); if (action === 'replaceNode') retry?.() }, onSwitchAccount: async (route: Exclude<GuideRoute, 'chat'>) => { record('switch', route); if (query.has('switchFail')) throw new Error('改用当前账号没有完成：分组不存在、不可用或名称重复。已恢复到切换前的配置。'); if (query.has('switchDenied') && calls.filter((item) => item.method === 'switch').length === 1) throw new Error("Codex CLI 改用当前账号没有完成：EPERM: operation not permitted, open 'C:\\Users\\peaker\\.codex\\config.toml'。已恢复到切换前的配置。"); update(route, { source: 'account', configured: true, keyState: undefined }); return { provider: route === 'codexDesktop' ? 'codex' as const : route, target: 'account' as const, backupId: 'fixture-backup', verified: !query.has('switchUnverified'), loginRequired: false, message: query.has('switchUnverified') ? '已改用当前账号，但当前账号余额不足，充值后就能用。' : '已改用当前账号，连接自检通过。' } } } : {})} /> : <p>引导已暂停</p>
  return <AuthFlow api={api} initialMode={scenario === 'register' ? 'register' : scenario === 'recovery' ? 'recovery' : 'login'} initialInviteCode={query.get('invite') ?? ''} onAuthenticated={(result, options) => { record('authenticated', result.account.username); if (options?.notice) record('notice', options.notice) }} onClose={() => record('close')} onHelp={() => record('help')} onRelaunch={() => record('relaunch')} />
}
createRoot(document.getElementById('root')!).render(query.has('strict') ? <StrictMode><ToastProvider><Fixture /></ToastProvider></StrictMode> : <ToastProvider><Fixture /></ToastProvider>)
