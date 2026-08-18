import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountCommercePanels, type AccountCommerceTab } from '../src/components/account/AccountCommercePanels'
import { AccountCenterPage, type AccountCenterTab } from '../src/components/account/AccountCenterPage'
import { TutorialPage } from '../src/pages/TutorialPage'
import { Sidebar } from '../src/components/Sidebar'
import type {
  AccountBalance,
  AccountPaymentWindowTerminalEvent,
  AccountProfileDetail,
  XingmangApi,
} from '../src/types'
import type { RelaySite } from '../src/types'
import type { ToastMessage } from '../src/components/Toast'
import '../src/styles.css'

type Scenario = 'orders-retry' | 'redeem-retry' | 'profile-retry' | 'security' | 'tutorial' | 'visual' | 'sidebar'
type VisualSection = AccountCenterTab | 'tutorial'

interface HarnessState {
  orderCalls: number
  redeemCalls: number
  refreshCalls: number
  profileCalls: number
  profileUpdateCalls: number
  passwordCalls: number
  rememberedLoginClears: number
  sessionListCalls: number
  sessionRevokeCalls: number
  otherSessionRevokeCalls: number
  logoutCalls: number
  profileName: string
  revokedSessionIds: string[]
  navigationTarget: string | null
  supportCalls: number
  accountCenterCalls: number
  usageQueries: unknown[]
  taskQueries: unknown[]
  paymentWindowCloseCalls: number
}

declare global {
  interface Window {
    accountCommerceHarness: HarnessState
    releaseFirstOrderRequest: () => void
    emitPaymentWindowTerminal: (event: AccountPaymentWindowTerminalEvent) => void
  }
}

const search = new URLSearchParams(window.location.search)
const scenario = (search.get('scenario') ?? 'orders-retry') as Scenario
const theme = search.get('theme') === 'dark' ? 'dark' : 'light'
const visualSections = new Set<VisualSection>([
  'overview',
  'dashboard',
  'subscriptions',
  'topup',
  'orders',
  'redeem',
  'usage',
  'tasks',
  'keys',
  'invite',
  'profile',
  'security',
  'tutorial',
])
const requestedSection = search.get('section') as VisualSection | null
const visualSection: VisualSection = requestedSection && visualSections.has(requestedSection)
  ? requestedSection
  : 'overview'
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme
document.body.dataset.fixtureScenario = scenario
document.body.dataset.fixtureSection = visualSection

window.accountCommerceHarness = {
  orderCalls: 0,
  redeemCalls: 0,
  refreshCalls: 0,
  profileCalls: 0,
  profileUpdateCalls: 0,
  passwordCalls: 0,
  rememberedLoginClears: 0,
  sessionListCalls: 0,
  sessionRevokeCalls: 0,
  otherSessionRevokeCalls: 0,
  logoutCalls: 0,
  profileName: '交互测试用户',
  revokedSessionIds: [],
  navigationTarget: null,
  supportCalls: 0,
  accountCenterCalls: 0,
  usageQueries: [],
  taskQueries: [],
  paymentWindowCloseCalls: 0,
}

let paymentWindowTerminalListener: ((event: AccountPaymentWindowTerminalEvent) => void) | null = null
window.emitPaymentWindowTerminal = (event) => paymentWindowTerminalListener?.(event)

let releaseFirstOrderRequest: (() => void) | null = null
const firstOrderRequestGate = new Promise<void>((resolve) => {
  releaseFirstOrderRequest = resolve
})
window.releaseFirstOrderRequest = () => {
  releaseFirstOrderRequest?.()
  releaseFirstOrderRequest = null
}

const profileSnapshot = (): AccountProfileDetail => ({
  userId: 36,
  username: 'interaction-fixture',
  displayName: window.accountCommerceHarness.profileName,
  email: 'fixture@example.com',
  group: 'default',
  quota: 2_000_000,
  usedQuota: 100_000,
  requestCount: 12,
  affCode: 'FIXTURE',
  affCount: 0,
  affQuota: 0,
  affHistoryQuota: 0,
})

const sessionFixtures = [
  {
    sid: 'current-session', current: true, loginMethod: 'password', ip: '10.0.0.1',
    userAgent: 'Electron Windows', createdAt: '2026-08-15T09:00:00+08:00',
    lastActiveAt: '2026-08-15T12:00:00+08:00', expiresAt: '2026-08-22T12:00:00+08:00',
  },
  {
    sid: 'remote-a', current: false, loginMethod: 'password', ip: '10.0.0.2',
    userAgent: 'Chrome Windows', createdAt: '2026-08-14T09:00:00+08:00',
    lastActiveAt: '2026-08-15T11:00:00+08:00', expiresAt: '2026-08-21T12:00:00+08:00',
  },
  {
    sid: 'remote-b', current: false, loginMethod: 'password', ip: '10.0.0.3',
    userAgent: 'Safari Macintosh', createdAt: '2026-08-13T09:00:00+08:00',
    lastActiveAt: '2026-08-15T10:00:00+08:00', expiresAt: '2026-08-20T12:00:00+08:00',
  },
]

const api = {
  async getAccountProfile() {
    window.accountCommerceHarness.profileCalls += 1
    return profileSnapshot()
  },
  async getAccountBalance() {
    return balance
  },
  async getAccountTopupOrders() {
    window.accountCommerceHarness.orderCalls += 1
    if (scenario === 'orders-retry' && window.accountCommerceHarness.orderCalls === 1) {
      await firstOrderRequestGate
      throw new Error('订单服务暂时不可用')
    }
    await wait(80)
    return {
      page: 1,
      pageSize: 10,
      total: 1,
      orders: [{
        id: 17,
        amount: 50,
        money: 48,
        tradeNo: 'XM-ORDER-20260815',
        paymentMethod: '支付宝',
        paymentProvider: 'epay',
        createdAt: '2026-08-15T12:00:00+08:00',
        completedAt: '2026-08-15T12:01:00+08:00',
        status: 'success' as const,
      }],
    }
  },
  async redeemAccountTopupCode() {
    window.accountCommerceHarness.redeemCalls += 1
    await wait(120)
    if (scenario === 'redeem-retry' && window.accountCommerceHarness.redeemCalls === 1) {
      throw new Error('兑换码无效或已使用')
    }
    return { quotaAdded: 500_000 }
  },
  async updateAccountDisplayName(input: { displayName: string }) {
    window.accountCommerceHarness.profileUpdateCalls += 1
    await wait(100)
    if (scenario === 'profile-retry' && window.accountCommerceHarness.profileUpdateCalls === 1) {
      throw new Error('资料服务暂时不可用')
    }
    window.accountCommerceHarness.profileName = input.displayName
    return { updated: true as const }
  },
  async changeAccountPassword() {
    window.accountCommerceHarness.passwordCalls += 1
    await wait(100)
    return { changed: true as const }
  },
  async setRememberedAccountLogin(value: unknown) {
    if (value === null) window.accountCommerceHarness.rememberedLoginClears += 1
  },
  async getAccountLoginSessions() {
    window.accountCommerceHarness.sessionListCalls += 1
    return sessionFixtures.filter((entry) => !window.accountCommerceHarness.revokedSessionIds.includes(entry.sid))
  },
  async revokeAccountLoginSession(sid: string) {
    window.accountCommerceHarness.sessionRevokeCalls += 1
    window.accountCommerceHarness.revokedSessionIds.push(sid)
    return { revokedSid: sid, current: sid === 'current-session' }
  },
  async revokeOtherAccountLoginSessions() {
    window.accountCommerceHarness.otherSessionRevokeCalls += 1
    const remaining = sessionFixtures.filter((entry) => !entry.current && !window.accountCommerceHarness.revokedSessionIds.includes(entry.sid))
    window.accountCommerceHarness.revokedSessionIds.push(...remaining.map((entry) => entry.sid))
    return { revokedCount: remaining.length }
  },
  async getAccountTopupInfo() {
    return {
      onlineTopupEnabled: true,
      stripeTopupEnabled: false,
      creemTopupEnabled: false,
      waffoPancakeTopupEnabled: false,
      redemptionEnabled: true,
      paymentComplianceConfirmed: true,
      paymentComplianceTermsVersion: '2026-08',
      paymentMethods: [{
        name: '支付宝',
        type: 'alipay',
        provider: 'epay' as const,
        color: '#1677ff',
        icon: null,
        minTopup: 1,
      }],
      minTopup: 1,
      amountOptions: [10, 50, 100, 200],
      discounts: { alipay: 1 },
      topupLink: null,
    }
  },
  async quoteAccountTopupAmount(input: { amount: number }) {
    return { amount: input.amount, payableAmount: input.amount }
  },
  async createAccountTopupPayment() {
    return { opened: true as const, tradeNo: 'XM-VISUAL-PAYMENT' }
  },
  async closeAccountPaymentWindow() {
    window.accountCommerceHarness.paymentWindowCloseCalls += 1
  },
  onAccountPaymentWindowTerminal(listener: (event: AccountPaymentWindowTerminalEvent) => void) {
    paymentWindowTerminalListener = listener
    return () => {
      if (paymentWindowTerminalListener === listener) paymentWindowTerminalListener = null
    }
  },
  async getAccountSubscriptionPlans() {
    return [{
      id: 1,
      title: '星芒专业版',
      subtitle: '适合持续使用多模型能力的个人用户',
      priceAmount: 29,
      currency: 'CNY',
      durationUnit: 'month' as const,
      durationValue: 1,
      customSeconds: 0,
      allowBalancePay: true,
      allowWalletOverflow: true,
      maxPurchasePerUser: 3,
      totalAmount: 5_000_000,
      upgradeGroup: 'vip',
      downgradeGroup: 'default',
      quotaResetPeriod: 'monthly' as const,
      quotaResetCustomSeconds: 0,
      stripePriceId: null,
      creemProductId: null,
      waffoPancakeProductId: null,
    }]
  },
  async getAccountSubscriptionSelf() {
    const subscription = {
      id: 7,
      planId: 1,
      status: 'active',
      source: 'balance',
      amountTotal: 5_000_000,
      amountUsed: 750_000,
      startedAt: '2026-08-01T00:00:00+08:00',
      endsAt: '2026-09-01T00:00:00+08:00',
      nextResetAt: '2026-09-01T00:00:00+08:00',
    }
    return {
      billingPreference: 'subscription_first' as const,
      activeSubscriptions: [subscription],
      allSubscriptions: [subscription],
    }
  },
  async updateAccountSubscriptionPreference(preference: 'subscription_first' | 'wallet_first' | 'subscription_only' | 'wallet_only') {
    return preference
  },
  async createAccountSubscriptionPayment() {
    return { opened: true as const, tradeNo: 'XM-VISUAL-SUBSCRIPTION', expiresAt: '2026-08-15T13:30:00+08:00' }
  },
  async purchaseAccountSubscriptionWithBalance() {
    return { purchased: true as const }
  },
  async transferAccountAffiliateQuota() {
    return undefined
  },
  async getAccountUsage(input?: { page?: number; pageSize?: number }) {
    window.accountCommerceHarness.usageQueries.push(input ?? {})
    const emptyDetails = {
      cacheTokens: 120, cacheCreationTokens: 30, cacheCreationTokens5m: 20, cacheCreationTokens1h: 10,
      firstResponseTimeMs: 680, reasoningEffort: 'high', modelRatio: 1, completionRatio: 1, modelPrice: null,
      groupRatio: 1.2, userGroupRatio: 1, cacheRatio: 0.1, cacheCreationRatio: 1.25,
      cacheCreationRatio5m: 1.25, cacheCreationRatio1h: 2, billingMode: 'token', matchedTier: 'standard',
      upstreamModelName: 'upstream-fixture', streamStatus: null,
    }
    return {
      page: input?.page ?? 1,
      pageSize: input?.pageSize ?? 20,
      total: 43,
      records: [
        { id: 1, createdAt: '2026-08-15T12:10:00+08:00', type: 2, modelName: 'gpt-5.4', promptTokens: 1250, completionTokens: 680, quota: 21_000, isStream: true, tokenName: 'Codex-Pro 主密钥', group: 'codex-pro', useTimeSeconds: 2.4, content: '调用成功', requestId: 'req-fixture-1', upstreamRequestId: 'up-fixture-1', details: emptyDetails },
        { id: 2, createdAt: '2026-08-15T11:42:00+08:00', type: 2, modelName: 'claude-opus-4-1', promptTokens: 860, completionTokens: 340, quota: 18_000, isStream: true, tokenName: 'Claude 日常调用', group: 'Claude-MAX', useTimeSeconds: 3.1, content: '', requestId: 'req-fixture-2', upstreamRequestId: '', details: { ...emptyDetails, reasoningEffort: '', cacheTokens: 0 } },
        { id: 3, createdAt: '2026-08-15T10:08:00+08:00', type: 6, modelName: 'gemini-2.5-pro', promptTokens: 430, completionTokens: 0, quota: 0, isStream: false, tokenName: 'Gemini 自动创建', group: 'Gemini', useTimeSeconds: 1.2, content: '已退款', requestId: 'req-fixture-3', upstreamRequestId: '', details: { ...emptyDetails, billingMode: 'refund', cacheTokens: 0 } },
      ],
      stats: { quota: 39_000, rpm: 12, tpm: 8_640 },
    }
  },
  async getAccountDashboard(input: { startTimestamp: number; endTimestamp: number }) {
    const hour = 60 * 60
    return {
      ...input,
      records: [
        { createdAt: input.endTimestamp - 5 * hour, modelName: 'gpt-5.6-sol', tokenUsed: 188_000, count: 96, quota: 62_000 },
        { createdAt: input.endTimestamp - 4 * hour, modelName: 'gpt-5.6-sol', tokenUsed: 246_000, count: 128, quota: 85_000 },
        { createdAt: input.endTimestamp - 4 * hour, modelName: 'gpt-5.6-terra', tokenUsed: 72_000, count: 36, quota: 21_000 },
        { createdAt: input.endTimestamp - 3 * hour, modelName: 'gpt-5.6-sol', tokenUsed: 163_000, count: 84, quota: 57_000 },
        { createdAt: input.endTimestamp - 2 * hour, modelName: 'gpt-5.6-terra', tokenUsed: 118_000, count: 61, quota: 38_000 },
        { createdAt: input.endTimestamp - hour, modelName: 'grok-4.6', tokenUsed: 24_000, count: 12, quota: 8_000 },
      ],
    }
  },
  async getAccountTasks(input?: { page?: number; pageSize?: number }) {
    window.accountCommerceHarness.taskQueries.push(input ?? {})
    return {
      page: input?.page ?? 1, pageSize: input?.pageSize ?? 20, total: 22,
      tasks: [
        { id: 11, taskId: 'task_fixture_video', platform: '55', group: 'Sora', quota: 125_000, action: 'video', status: 'SUCCESS', failReason: '', resultUrl: 'https://example.test/video.mp4', submitAt: '2026-08-15T12:00:00+08:00', startAt: '2026-08-15T12:00:03+08:00', finishAt: '2026-08-15T12:01:12+08:00', progress: '100%', originModelName: 'sora-2', upstreamModelName: 'sora-2-pro' },
        { id: 12, taskId: 'task_fixture_image', platform: 'gemini', group: 'Gemini', quota: 25_000, action: 'image', status: 'FAILURE', failReason: '上游服务暂时不可用', resultUrl: '', submitAt: '2026-08-15T11:00:00+08:00', startAt: '2026-08-15T11:00:01+08:00', finishAt: '2026-08-15T11:00:09+08:00', progress: '80%', originModelName: 'gemini-2.5-flash-image', upstreamModelName: 'gemini-image' },
      ],
    }
  },
  async getAccountKeys() {
    return {
      page: 1,
      pageSize: 8,
      total: 3,
      keys: [
        { id: 1, name: 'Codex-Pro 主密钥', maskedKey: 'sk-****codex', group: 'codex-pro', status: 1, remainQuota: 1_500_000, unlimitedQuota: false, usedQuota: 500_000, createdAt: '2026-08-01T08:00:00+08:00', expiredAt: null, accessedAt: '2026-08-15T12:00:00+08:00' },
        { id: 2, name: 'Claude 日常调用', maskedKey: 'sk-****claude', group: 'Claude-MAX(不限制客户端)-5m', status: 1, remainQuota: 0, unlimitedQuota: true, usedQuota: 820_000, createdAt: '2026-08-02T08:00:00+08:00', expiredAt: null, accessedAt: '2026-08-15T11:30:00+08:00' },
        { id: 3, name: 'Gemini 自动创建', maskedKey: 'sk-****gemini', group: 'Gemini', status: 2, remainQuota: 250_000, unlimitedQuota: false, usedQuota: 50_000, createdAt: '2026-08-03T08:00:00+08:00', expiredAt: '2026-12-31T23:59:59+08:00', accessedAt: null },
      ],
    }
  },
  async getAccountUsableGroups() {
    return [
      { name: 'codex-pro', description: 'Codex 专用分组', ratio: 1 },
      { name: 'Claude-MAX(不限制客户端)-5m', description: 'Claude 高性能分组', ratio: 1.5 },
      { name: 'Gemini', description: 'Gemini 模型分组', ratio: 0.8 },
    ]
  },
  async copyAccountKey() {
    return true
  },
  async revealAccountKey(id: number) {
    return 'sk-visual-' + id + '-plaintext'
  },
  async revokeAccountKey() {
    return undefined
  },
  async createAccountKey() {
    return undefined
  },
  async updateAccountKey() {
    return undefined
  },
} as unknown as XingmangApi
window.xingmang = api

const balance: AccountBalance = {
  quota: 2_000_000,
  usedQuota: 100_000,
  quotaPerUnit: 500_000,
  quotaDisplayType: 'USD',
  usdExchangeRate: 1,
  displayAmount: 4,
}

const sidebarRelaySite: RelaySite = {
  id: 'fixture',
  label: '星芒AI',
  providerBaseUrls: {
    codex: 'https://xm.solov.cc/v1',
    claude: 'https://xm.solov.cc',
    gemini: 'https://xm.solov.cc',
    grok: 'https://xm.solov.cc/v1',
  },
  websiteUrl: 'https://xm.solov.cc',
  keysPageUrl: 'https://xm.solov.cc/keys',
  accountBackend: 'new-api',
  accountBaseUrl: 'https://xm.solov.cc',
}

function SidebarFixture() {
  const [collapsed, setCollapsed] = useState(search.get('collapsed') === 'true')
  const [moreExpanded, setMoreExpanded] = useState(search.get('more') === 'true')
  return (
    <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`} data-testid="sidebar-shell">
      <Sidebar
        activePage="overview"
        collapsed={collapsed}
        theme={theme}
        updateState={null}
        relaySite={sidebarRelaySite}
        moreExpanded={moreExpanded}
        accountStatus="active"
        accountSnapshot={{
          loggedIn: true,
          nickname: '侧栏验收用户',
          quota: 6_172_835_000,
          quotaPerUnit: 500_000,
          usdExchangeRate: 7.3,
        }}
        onNavigate={() => undefined}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
        onToggleTheme={() => undefined}
        onToggleMoreExpanded={() => setMoreExpanded((current) => !current)}
        onAccountLogin={() => undefined}
        onAccountLogout={() => undefined}
        onRecharge={() => undefined}
        onConfigureCliKey={() => undefined}
        onRefreshBalance={() => undefined}
        onOpenAccountCenter={() => undefined}
        onOpenTutorialDocs={() => undefined}
        onOpenSupport={() => undefined}
        onPasteKey={() => undefined}
        onOpenKeysPage={() => undefined}
      />
      <main className="main-content" aria-label="侧栏验收内容" />
    </div>
  )
}

function Fixture() {
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const commerceTab: AccountCommerceTab | null = scenario === 'orders-retry'
    ? 'orders'
    : scenario === 'redeem-retry'
      ? 'redeem'
      : null
  return (
    <>
      {scenario === 'sidebar' ? (
        <SidebarFixture />
      ) : commerceTab ? (
        <main className="account-center-workspace fixture-workspace">
          <div className="account-center-body">
            <AccountCommercePanels
              activeTab={commerceTab}
              profile={profileSnapshot()}
              balance={balance}
              onRefreshAccount={async () => {
                window.accountCommerceHarness.refreshCalls += 1
                setRefreshVersion((current) => current + 1)
              }}
              notify={setToast}
            />
          </div>
        </main>
      ) : scenario === 'tutorial' || (scenario === 'visual' && visualSection === 'tutorial') ? (
        <TutorialPage
          onNavigate={(pageId) => { window.accountCommerceHarness.navigationTarget = pageId }}
          onOpenSupport={() => { window.accountCommerceHarness.supportCalls += 1 }}
          onOpenAccountCenter={() => { window.accountCommerceHarness.accountCenterCalls += 1 }}
        />
      ) : (
        <AccountCenterPage
          initialSection={scenario === 'visual'
            ? visualSection as AccountCenterTab
            : scenario === 'profile-retry'
              ? 'profile'
              : 'security'}
          onClose={() => undefined}
          onLogout={() => { window.accountCommerceHarness.logoutCalls += 1 }}
          notify={setToast}
        />
      )}
      <output data-testid="toast" data-type={toast?.type ?? ''}>{toast?.message ?? ''}</output>
      <output data-testid="refresh-version">{refreshVersion}</output>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  search.get('strict') === 'true'
    ? <StrictMode><Fixture /></StrictMode>
    : <Fixture />,
)
