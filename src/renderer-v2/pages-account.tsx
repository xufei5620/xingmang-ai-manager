import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Copy,
  ArrowLeft,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Zap,
} from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
  Dialog,
  Drawer,
  Empty,
  Input,
  ListRow,
  Menu,
  Notice,
  PageHead,
  Pill,
  SearchInput,
  Select,
  SettingRow,
  Switch,
  Table,
  Tabs,
  Textarea,
  Toolbar,
} from './ui'
import {
  displayDate,
  dollars,
  ListState,
  Pagination,
  ResultNotice,
  useOperation,
  useResource,
} from './business-common'
import {
  accountTabs,
  billingOptions,
  keyStates,
  orderStates,
  taskStates,
  taskFilterFields,
  usageFilterFields,
} from './registry/business'
import { tools } from './registry/tools'
import type { V2Bridge } from './types'
import { SavedAccounts } from './SavedAccounts'
import { accountOrigin, accountSiteId, accountSupports, visibleAccountTab, accountKeyQuota, type AccountSiteId } from './account-context'
import type { AccountSessionState } from '../../electron/ipc-contract'
import { AccountFilters, accountTimeRange } from './AccountFilters'
import { platformApi } from './platform-api'
import {
  resolveRelaySite,
  type AccountPaymentWindowTerminalEvent,
} from '../../electron/ipc-contract'
import { LocalAvatar, LocalAvatarDialog } from './LocalAvatar'
import type { AvatarIdentity } from './local-avatar'
import {
  getSourceMarkerStorage,
  writeManualSourceMarker,
} from './features/tools/source-marker'
type Profile = Awaited<ReturnType<V2Bridge['getAccountProfile']>>
type Balance = Awaited<ReturnType<V2Bridge['getAccountBalance']>>
type AccountKey = Awaited<
  ReturnType<V2Bridge['getAccountKeys']>
>['keys'][number]
type Usage = Awaited<ReturnType<V2Bridge['getAccountUsage']>>['records'][number]
type Task = Awaited<ReturnType<V2Bridge['getAccountTasks']>>['tasks'][number]
type Plan = Awaited<ReturnType<V2Bridge['getAccountSubscriptionPlans']>>[number]
type PaymentMethod = Awaited<
  ReturnType<V2Bridge['getAccountTopupInfo']>
>['paymentMethods'][number]
type TopupInfo = Awaited<ReturnType<V2Bridge['getAccountTopupInfo']>>
type SubscriptionPaymentInput = Parameters<
  V2Bridge['createAccountSubscriptionPayment']
>[0]
type AccountTab = (typeof accountTabs)[number]['value']
type Provider = Parameters<V2Bridge['saveConfigWithAccountKey']>[0]['provider']
const isProvider = (id: string): id is Provider =>
  ['claude', 'codex', 'gemini', 'grok'].includes(id)
const quotaMoney = (
  quota: number | null | undefined,
  balance: Balance | null,
) =>
  balance && balance.quotaPerUnit > 0 && typeof quota === 'number'
    ? dollars(quota / balance.quotaPerUnit)
    : '暂未读到'

export function subscriptionPaymentMethods(
  plan: Plan,
  methods: PaymentMethod[],
  availability?: Pick<
    TopupInfo,
    | 'onlineTopupEnabled'
    | 'stripeTopupEnabled'
    | 'creemTopupEnabled'
    | 'waffoPancakeTopupEnabled'
  >,
) {
  return methods.filter(
    (method) => {
      const enabled = !availability
        || (method.provider === 'epay' && availability.onlineTopupEnabled)
        || (method.provider === 'stripe' && availability.stripeTopupEnabled)
        || (method.provider === 'creem' && availability.creemTopupEnabled)
        || (method.provider === 'waffo-pancake' && availability.waffoPancakeTopupEnabled)
      return enabled && (
        method.provider === 'epay' ||
        (method.provider === 'stripe' && Boolean(plan.stripePriceId)) ||
        (method.provider === 'creem' && Boolean(plan.creemProductId)) ||
        (method.provider === 'waffo-pancake' &&
          Boolean(plan.waffoPancakeProductId))
      )
    },
  )
}

/**
 * The IPC contract accepts a payment method only for the epay adapter. Stripe,
 * Creem, and Waffo-Pancake identify their checkout channel by provider alone.
 */
export function buildSubscriptionPaymentInput(
  planId: number,
  method: Pick<PaymentMethod, 'provider' | 'type'>,
): SubscriptionPaymentInput {
  if (method.provider === 'waffo') {
    throw new Error('该支付渠道暂不支持订阅。')
  }
  return method.provider === 'epay'
    ? { planId, provider: 'epay', paymentMethod: method.type }
    : { planId, provider: method.provider }
}

export function paymentTerminalPresentation(
  status: AccountPaymentWindowTerminalEvent['status'],
): { tone: 'neutral' | 'warn' | 'bad'; title: string; body: string } {
  if (status === 'expired') {
    return {
      tone: 'warn',
      title: '支付已超时',
      body: '支付窗口已过期，订单没有自动取消。请刷新订单状态后再决定是否重新支付。',
    }
  }
  if (status === 'failed') {
    return {
      tone: 'bad',
      title: '支付没有完成',
      body: '支付渠道返回失败，订单状态请以订单页为准。',
    }
  }
  return {
    tone: 'neutral',
    title: '支付窗口已关闭',
    body: '关闭支付窗口不会取消订单，请刷新订单状态确认结果。',
  }
}

export function validateTopupAmount(value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('充值数量必须是大于 0 的整数。')
  }
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    throw new Error('当前支付渠道的最低充值金额无效。')
  }
  if (value < minimum) {
    throw new Error(`充值数量不能低于 ${minimum}。`)
  }
  return value
}

export function resetTopupQuoteForMethod(
  amount: string,
  method: Pick<PaymentMethod, 'minTopup'>,
  globalMinimum: number,
): { amount: string; quoteInvalidated: true } {
  const minimum = Math.max(globalMinimum, method.minTopup)
  const parsed = Number(amount)
  return {
    amount:
      Number.isSafeInteger(parsed) && parsed >= minimum
        ? amount
        : String(minimum),
    quoteInvalidated: true,
  }
}

/** Build the share link from the active relay site's public origin. */
export function buildAccountInviteLink(
  websiteUrl: string,
  affCode: string | null | undefined,
): string {
  const code = affCode?.trim()
  if (!code) return ''
  try {
    const url = new URL('/register', websiteUrl)
    url.searchParams.set('aff', code)
    return url.href
  } catch {
    return ''
  }
}

/** Convert an API ISO timestamp into the local value accepted by datetime-local. */
export function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function orderStateFor(value: string) {
  return orderStates[value as keyof typeof orderStates] ?? {
    label: '待确认',
    tone: 'neutral' as const,
  }
}
function PaymentOptions({
  methods,
  value,
  onChange,
}: {
  methods: PaymentMethod[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="支付方式"
      className="v2-business-payments"
    >
      {methods.map((method) => (
        <label
          className={`v2-business-payment${value === method.type ? ' is-selected' : ''}`}
          key={method.type}
        >
          <BrandIcon
            tool={
              method.provider === 'stripe'
                ? 'stripe'
                : /ali/i.test(method.type)
                  ? 'alipay'
                  : /wechat|wxpay/i.test(method.type)
                    ? 'wechat'
                    : method.provider
            }
            size={28}
          />
          <span>
            <strong>{method.name}</strong>
            <small>支付金额以渠道页面为准</small>
          </span>
          <Input
            type="radio"
            aria-label={method.name}
            name="account-payment"
            value={method.type}
            checked={value === method.type}
            onChange={() => onChange(method.type)}
          />
        </label>
      ))}
    </div>
  )
}
export function AccountPage({
  api,
  initialTab,
  paymentReturn,
  onLogin,
  onAccountChanged,
  onBack,
}: {
  api: V2Bridge
  initialTab?: AccountTab
  paymentReturn?: { sequence: number; order: string | null }
  onLogin?: () => void
  onAccountChanged?: () => void
  onBack?: () => void
}) {
  const [tab, setTab] = useState<AccountTab>(initialTab ?? 'overview')
  const [visited, setVisited] = useState<AccountTab[]>([
    initialTab ?? 'overview',
  ])
  useEffect(() => {
    setVisited((values) => (values.includes(tab) ? values : [...values, tab]))
  }, [tab])
  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])
  const load = useCallback(async () => {
    const session = await api.getAccountSession()
    if (!session.authenticated) return null
    const [profile, balance] = await Promise.all([
      api.getAccountProfile(),
      api.getAccountBalance(),
    ])
    const site = resolveRelaySite(accountSiteId(session))
    return {
      profile,
      balance,
      session,
      origin: accountOrigin(session),
      inviteBaseUrl: site.websiteUrl,
      providerBaseUrls: site.providerBaseUrls,
    }
  }, [api])
  const resource = useResource(load)
  const availableTabs = accountTabs.filter((item) => resource.data && visibleAccountTab(item.value, resource.data.session))
  const activeTab = availableTabs.some((item) => item.value === tab) ? tab : 'overview'
  const changed = () => {
    void resource.reload()
    onAccountChanged?.()
  }
  return (
    <section
      className="v2-page v2-business-account"
      data-page-id="account"
      data-testid="page-account"
    >
      <div className="v2-business-account-heading">
        <Button
          variant="ghost"
          icon={ArrowLeft}
          aria-label="返回首页"
          title="返回"
          onClick={onBack}
          disabled={!onBack}
          testId="account-back"
        />
        <PageHead
          title="个人中心"
          lead="管理你的星芒账号、余额与 Key。"
          actions={
            <Menu
              label="账号操作"
              anchor={
                <Button
                  variant="ghost"
                  aria-label="账号操作"
                  testId="account-identity-menu"
                >
                  <span className="v2-business-account-identity">
                    <LocalAvatar
                      identity={
                        resource.data
                          ? {
                              origin: resource.data.origin,
                              userId: resource.data.profile.userId,
                            }
                          : null
                      }
                      name={
                        resource.data?.profile.displayName ||
                        resource.data?.profile.username ||
                        '星'
                      }
                    />
                    <span>
                      <strong>
                        {resource.data?.profile.displayName ||
                          resource.data?.profile.username ||
                          '星芒账号'}
                      </strong>
                      <small>{resource.data?.profile.email || ''}</small>
                    </span>
                  </span>
                </Button>
              }
              items={[
                {
                  label: '刷新账号资料',
                  icon: RefreshCw,
                  disabled: resource.loading,
                  onSelect: () => void resource.reload(),
                },
              ]}
            />
          }
        />
      </div>
      {!resource.loading && !resource.data && !resource.error ? (
        <Empty
          icon={UserRound}
          title="登录后查看个人中心"
          description="工具里已经写入的配置会继续保留。"
          action={
            <Button variant="primary" icon={UserRound} onClick={onLogin}>
              登录账号
            </Button>
          }
        />
      ) : (
        <>
          <Tabs
            items={availableTabs}
            value={activeTab}
            onChange={(value) => {
              if (availableTabs.some((item) => item.value === value))
                setTab(value as AccountTab)
            }}
            testId="account-tabs"
          />
          <ResultNotice error={resource.error} />
          {resource.loading && !resource.data ? (
            <p role="status">正在读取账号…</p>
          ) : (
            resource.data &&
            [...new Set([...visited, activeTab])].filter((panel) => visibleAccountTab(panel, resource.data!.session)).map((panel) => {
              const account = resource.data
              if (!account) return null
              return (
                <div
                  className="v2-business-account-panel"
                  role="tabpanel"
                  key={`${account.origin}:${account.profile.userId}-${panel}`}
                  hidden={panel !== activeTab}
                >
                  {panel === 'overview' && (
                    <AccountOverview
                      api={api}
                      profile={account.profile}
                      balance={account.balance}
                      changed={changed}
                      navigateTab={setTab}
                      onLogin={onLogin}
                      identity={{
                        origin: account.origin,
                        userId: account.profile.userId,
                      }}
                      session={account.session}
                    />
                  )}
                  {panel === 'dashboard' && (
                    <AccountDashboard api={api} balance={account.balance} />
                  )}
                  {panel === 'keys' && (
                    <AccountKeys
                      api={api}
                      balance={account.balance}
                      providerBaseUrls={account.providerBaseUrls}
                      siteId={accountSiteId(account.session)}
                    />
                  )}
                  {panel === 'usage' && (
                    <AccountUsage api={api} balance={account.balance} />
                  )}
                  {panel === 'tasks' && (
                    <AccountTasks
                      api={api}
                      balance={account.balance}
                      accountScope={`${account.origin}:${account.profile.userId}`}
                    />
                  )}
                  {panel === 'recharge' && (
                    <AccountRecharge
                      api={api}
                      balance={account.balance}
                      changed={changed}
                    />
                  )}
                  {panel === 'orders' && (
                    <AccountOrders api={api} paymentReturn={paymentReturn} />
                  )}
                  {panel === 'invite' && (
                    <AccountInvite
                      api={api}
                      profile={account.profile}
                      balance={account.balance}
                      changed={changed}
                      inviteBaseUrl={account.inviteBaseUrl}
                    />
                  )}
                  {panel === 'devices' && (
                    <AccountDevices api={api} changed={changed} />
                  )}
                </div>
              )
            })
          )}
        </>
      )}
    </section>
  )
}
function AccountOverview({
  api,
  profile,
  balance,
  changed,
  navigateTab,
  onLogin,
  identity,
  session,
}: {
  api: V2Bridge
  profile: Profile
  balance: Balance
  changed: () => void
  navigateTab: (tab: AccountTab) => void
  onLogin?: () => void
  identity: AvatarIdentity
  session: AccountSessionState
}) {
  const [name, setName] = useState(profile.displayName ?? '')
  const profileNameRef = useRef(profile.displayName ?? '')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [originalPassword, setOriginal] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirm] = useState('')
  const operation = useOperation()
  const accountsLoad = useCallback(
    async () => ({ devices: accountSupports(session, 'supportsSessionManagement') ? await api.getAccountLoginSessions() : [] }),
    [api, session],
  )
  const accounts = useResource(accountsLoad)
  const [logout, setLogout] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  useEffect(() => {
    const nextName = profile.displayName ?? ''
    // Preserve an in-progress edit while a sibling action refreshes the
    // account. If the field still contains the previously loaded value,
    // accept an external profile change.
    setName((current) =>
      current === profileNameRef.current ? nextName : current,
    )
    profileNameRef.current = nextName
  }, [profile.displayName])
  return (
    <>
      <ResultNotice {...operation} />
      <div className="v2-business-profile-grid">
        <Card title="基本资料">
          <div className="v2-business-profile-avatar">
            <LocalAvatar
              identity={identity}
              name={profile.displayName || profile.username}
              size={72}
              testId="account-profile-avatar"
            />
            <div>
              <strong>{profile.displayName || profile.username}</strong>
              <p>你的账户资料与余额</p>
              <Button
                size="sm"
                icon={Pencil}
                onClick={() => setAvatarOpen(true)}
                testId="account-avatar-change"
              >
                更换头像
              </Button>
            </div>
          </div>
          <div
            className="v2-business-profile-fields"
            data-unsaved={
              name !== (profile.displayName ?? '') ? 'true' : undefined
            }
          >
            <Input
              label="显示名称"
              value={name}
              maxLength={20}
              onChange={(event) => setName(event.target.value)}
              testId="account-display"
            />
            <Input
              label="用户名"
              readOnly
              value={profile.username}
              hint="登录时使用，暂不支持修改。"
            />
            <Input
              label="邮箱"
              readOnly
              value={profile.email || ''}
              hint="用于找回密码和接收通知。"
            />
            <div className="v2-business-control">
              <Button
                variant="primary"
                icon={Pencil}
                loading={operation.busy === 'profile'}
                disabled={!accountSupports(session, 'supportsProfileUpdate')}
                onClick={() =>
                  void operation.execute(
                    'profile',
                    async () => {
                      await api.updateAccountDisplayName({
                        displayName: name.trim(),
                      })
                      changed()
                    },
                    '显示名称已保存',
                  )
                }
              >
                保存资料
              </Button>
              <Button icon={ShieldCheck} onClick={() => setPasswordOpen(true)}>
                修改密码
              </Button>
            </div>
          </div>
        </Card>
        <aside className="v2-business-profile-aside">
          <Card title="账户余额（美元）">
            <strong
              className="v2-business-amount"
              data-testid="account-balance"
            >
              {dollars(balance.displayAmount)}
            </strong>
            <p>{accountSupports(session, 'supportsUsage') ? '用于星芒账号的按量消费。每次调用的费用可在明细里查看。' : '这是当前账号的可用余额，消费记录可在官方网站查看。'}</p>
            <div className="v2-business-control">
              {accountSupports(session, 'supportsBilling') && <Button
                variant="balance"
                size="sm"
                icon={Zap}
                onClick={() => navigateTab('recharge')}
              >
                充值
              </Button>}
              {accountSupports(session, 'supportsUsage') && <Button
                size="sm"
                icon={RefreshCw}
                onClick={() => navigateTab('dashboard')}
              >
                看用量
              </Button>}
            </div>
          </Card>
          <Card title="已保存的账号" padding="none">
            <SavedAccounts
              api={api}
              onAccountChanged={changed}
              onLogin={onLogin}
            />
          </Card>
          <Card title="登录与设备">
            <p>
              {!accountSupports(session, 'supportsSessionManagement') ? '当前账号暂不提供登录设备管理。' : accounts.data
                ? `${accounts.data.devices.length} 台已登录设备`
                : '正在读取登录设备…'}
            </p>
            <div className="v2-business-control">
              {accountSupports(session, 'supportsSessionManagement') && <Button
                size="sm"
                icon={Users}
                onClick={() => navigateTab('devices')}
              >
                管理设备
              </Button>}
              <Button
                size="sm"
                variant="ghost"
                icon={Trash2}
                onClick={() => setLogout(true)}
              >
                退出当前账号
              </Button>
            </div>
          </Card>
        </aside>
      </div>
      {avatarOpen && (
        <LocalAvatarDialog
          key={`${identity.origin}:${identity.userId}`}
          identity={identity}
          name={profile.displayName || profile.username}
          onClose={() => setAvatarOpen(false)}
        />
      )}
      <Dialog
        open={logout}
        title="退出当前账号？"
        onClose={() => setLogout(false)}
        footer={
          <>
            <Button onClick={() => setLogout(false)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() =>
                void operation.execute(
                  'logout',
                  async () => {
                    await api.logoutAccount()
                    setLogout(false)
                    changed()
                  },
                  '',
                )
              }
            >
              退出登录
            </Button>
          </>
        }
      >
        <p>工具里已写入的配置继续保留。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
      <Dialog
        open={passwordOpen}
        title="修改密码"
        onClose={() => {
          if (!operation.busy) setPasswordOpen(false)
        }}
        dirty={Boolean(operation.busy)}
        footer={
          <>
            <Button
              onClick={() => setPasswordOpen(false)}
              disabled={Boolean(operation.busy)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={operation.busy === 'password'}
              icon={ShieldCheck}
              onClick={() =>
                void operation.execute(
                  'password',
                  async () => {
                    const minimum = accountSiteId(session) === 'solov-api' ? 6 : 8
                    const maximum = accountSiteId(session) === 'solov-api' ? 256 : 20
                    if (password.length < minimum)
                      throw new Error(`新密码至少需要 ${minimum} 个字符。`)
                    if (password.length > maximum)
                      throw new Error(`新密码不能超过 ${maximum} 个字符。`)
                    if (password !== confirmPassword)
                      throw new Error('两次填写的新密码不一致。')
                    await api.changeAccountPassword({
                      originalPassword,
                      newPassword: password,
                    })
                    setOriginal('')
                    setPassword('')
                    setConfirm('')
                    setPasswordOpen(false)
                    changed()
                  },
                  '密码已修改',
                )
              }
            >
              确认修改
            </Button>
          </>
        }
      >
        <ResultNotice error={operation.error} />
        {accountSiteId(session) === 'solov-api' && <p>修改密码后当前登录会失效，请使用新密码重新登录。</p>}
        <Input
          label="当前密码"
          password
          value={originalPassword}
          onChange={(event) => setOriginal(event.target.value)}
          autoComplete="current-password"
        />
        <Input
          label="新密码"
          password
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
        <Input
          label="确认新密码"
          password
          value={confirmPassword}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
        />
      </Dialog>
    </>
  )
}
function AccountKeys({
  api,
  balance,
  providerBaseUrls,
  siteId,
}: {
  api: V2Bridge
  balance: Balance
  providerBaseUrls: Record<Provider, string>
  siteId: AccountSiteId
}) {
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const load = useCallback(
    async () => ({
      page: await api.getAccountKeys({ page, pageSize: 20 }),
    }),
    [api, page],
  )
  const resource = useResource(load)
  const operation = useOperation()
  const [editing, setEditing] = useState<AccountKey | 'new' | null>(null)
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [groups, setGroups] = useState<Awaited<ReturnType<V2Bridge['getAccountUsableGroups']>>>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState('')
  const groupsRequest = useRef(0)
  const groupsPending = useRef<{ request: number; promise: Promise<void> } | null>(null)
  const groupsRequestedAt = useRef(0)
  const [quota, setQuota] = useState('10')
  const [unlimited, setUnlimited] = useState(false)
  const [expires, setExpires] = useState('')
  const [removing, setRemoving] = useState<AccountKey | null>(null)
  const [revealed, setRevealed] = useState('')
  const [selected, setSelected] = useState<AccountKey | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const modelRequest = useRef(0)
  useEffect(() => () => { groupsRequest.current++ }, [api, siteId])
  const refreshGroups = (force = false): Promise<void> => {
    if (operation.busy === 'save-key') return Promise.resolve()
    if (groupsPending.current?.request === groupsRequest.current) return groupsPending.current.promise
    // Pointer and focus are two events from one opening gesture. Share their
    // request instead of issuing two authenticated requests to the server.
    if (!force && Date.now() - groupsRequestedAt.current < 500) return Promise.resolve()
    groupsRequestedAt.current = Date.now()
    const request = ++groupsRequest.current
    setGroupsLoading(true)
    setGroupsError('')
    const promise = (async () => {
      try {
        const latest = await api.getAccountUsableGroups()
        if (groupsRequest.current !== request) return
        setGroups(latest)
        // Keep a user's selection during refresh. If it was removed, require
        // another explicit choice instead of silently changing the billed group.
        setGroup((selected) => selected || latest[0]?.name || '')
      } catch {
        if (groupsRequest.current === request) setGroupsError('分组读取失败，请刷新后重试。')
      } finally {
        if (groupsRequest.current === request) setGroupsLoading(false)
        if (groupsPending.current?.request === request) groupsPending.current = null
      }
    })()
    groupsPending.current = { request, promise }
    return promise
  }
  const refreshGroupsRef = useRef(refreshGroups)
  refreshGroupsRef.current = refreshGroups
  useEffect(() => {
    if (!editing) return
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void refreshGroupsRef.current()
    }
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    const interval = window.setInterval(refreshVisible, 30_000)
    return () => {
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
      window.clearInterval(interval)
    }
  }, [editing])
  const closeEditor = () => {
    groupsRequest.current++
    setEditing(null)
  }
  const edit = (key: AccountKey | 'new') => {
    setEditing(key)
    setName(key === 'new' ? '' : key.name)
    setGroup(key === 'new' ? '' : key.group)
    setGroups([])
    setUnlimited(key !== 'new' && key.unlimitedQuota)
    setQuota(
      key === 'new' ? '10' : String(key.remainQuota / balance.quotaPerUnit),
    )
    setExpires(
      key === 'new' ? '' : toDateTimeLocalValue(key.expiredAt),
    )
    operation.clear()
    void refreshGroups(true)
  }
  const selectedGroupAvailable = groups.some((entry) => entry.name === group)
  const save = () =>
    void operation.execute(
      'save-key',
      async () => {
        const amount = Number(quota)
        if (groupsLoading || groupsError || groupsPending.current?.request === groupsRequest.current) throw new Error('请先获取最新的可用分组。')
        if (!name.trim()) throw new Error('请填写密钥名称。')
        if (!group.trim() || !selectedGroupAvailable)
          throw new Error('当前没有可用分组，暂时无法保存密钥。')
        const expiredTime = expires
          ? Math.floor(new Date(expires).getTime() / 1000)
          : -1
        if (
          expires &&
          (!Number.isFinite(expiredTime) || expiredTime <= Date.now() / 1000)
        )
          throw new Error('到期时间必须晚于现在。')
        const input = {
          name: name.trim(),
          group,
          remainQuota: accountKeyQuota(amount, balance.quotaPerUnit, siteId, unlimited),
          unlimitedQuota: unlimited,
          expiredTime,
        }
        if (editing && editing !== 'new')
          await api.updateAccountKey({ ...input, id: editing.id })
        else await api.createAccountKey(input)
        closeEditor()
        await resource.reload()
      },
      '密钥已保存',
    )
  const list =
    resource.data?.page.keys.filter((key) =>
      `${key.name} ${key.group}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? []
  return (
    <>
      <Toolbar
        search={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="搜索密钥或分组"
            testId="keys-search"
          />
        }
        right={
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => edit('new')}
            testId="account-key-add"
          >
            新建密钥
          </Button>
        }
      />
      <ResultNotice {...operation} />
      <Card padding="none">
        <ListState
          page="keys"
          noun="密钥"
          loading={resource.loading}
          error={resource.error}
          count={list.length}
          filtered={Boolean(query)}
          retry={() => void resource.reload()}
          clear={() => setQuery('')}
          action={
            <Button icon={Plus} onClick={() => edit('new')}>
              新建密钥
            </Button>
          }
        >
          {list.map((key) => {
            const status = keyStates[key.status as keyof typeof keyStates] ?? {
              label: '待确认',
              tone: 'neutral' as const,
            }
            return (
              <ListRow
                key={key.id}
                icon={KeyRound}
                title={key.name}
                badge={<Pill tone={status.tone}>{status.label}</Pill>}
                desc={
                  <>
                    <code>{key.maskedKey}</code> · {key.group || '默认分组'}
                    <span className="v2-business-path">
                      {key.unlimitedQuota
                        ? '不限额度'
                        : `剩余 ${quotaMoney(key.remainQuota, balance)}`}{' '}
                      ·{' '}
                      {key.expiredAt
                        ? `到期 ${displayDate(key.expiredAt)}`
                        : '永不过期'}
                    </span>
                  </>
                }
                actions={
                  <>
                    <Button
                      size="sm"
                      icon={Copy}
                      disabled={Boolean(operation.busy)}
                      onClick={() =>
                        void operation.execute(
                          'copy',
                          () => api.copyAccountKey(key.id),
                          '密钥已复制',
                        )
                      }
                    >
                      复制
                    </Button>
                    <Menu
                      anchor={<MoreHorizontal size={18} />}
                      items={[
                        {
                          label: '编辑密钥',
                          icon: Pencil,
                          onSelect: () => edit(key),
                        },
                        {
                          label: '显示密钥',
                          icon: Eye,
                          onSelect: () =>
                            void operation.execute(
                              'reveal',
                              async () =>
                                setRevealed(await api.revealAccountKey(key.id)),
                              '',
                            ),
                        },
                        {
                          label: '配置到工具',
                          icon: KeyRound,
                          disabled: Boolean(operation.busy),
                          onSelect: () => {
                            setSelected(key)
                            setModels([])
                            setModel('')
                            const requestId = ++modelRequest.current
                            void operation.execute(
                              'models',
                              async () => {
                                const values = await api.listAccountKeyModels(
                                  key.id,
                                )
                                if (requestId !== modelRequest.current) return
                                setModels(values)
                                setModel(values[0] ?? '')
                              },
                              '',
                            )
                          },
                        },
                        {
                          label: '撤销密钥',
                          icon: Trash2,
                          danger: true,
                          onSelect: () => setRemoving(key),
                        },
                      ]}
                    />
                  </>
                }
              />
            )
          })}
        </ListState>
      </Card>
      <Pagination
        page={page}
        total={resource.data?.page.total ?? 0}
        onChange={setPage}
      />
      <Dialog
        open={Boolean(editing)}
        title={editing === 'new' ? '新建密钥' : '编辑密钥'}
        onClose={closeEditor}
        busy={operation.busy === 'save-key'}
        footer={
          <>
            <Button onClick={closeEditor} disabled={operation.busy === 'save-key'}>取消</Button>
            <Button
              variant="primary"
              icon={KeyRound}
              loading={operation.busy === 'save-key'}
              disabled={groupsLoading || Boolean(groupsError) || !selectedGroupAvailable}
              onClick={save}
            >
              保存密钥
            </Button>
          </>
        }
      >
        <ResultNotice error={operation.error} />
        <ResultNotice error={groupsError} />
        <Input
          label="名称"
          value={name}
          maxLength={50}
          onChange={(event) => setName(event.target.value)}
        />
        <Select
          label="分组"
          testId="account-key-group"
          aria-label="密钥分组"
          disabled={!groups.length || operation.busy === 'save-key'}
          aria-busy={groupsLoading}
          onFocus={() => void refreshGroups()}
          onPointerDown={() => void refreshGroups()}
          onKeyDown={(event) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'F4'].includes(event.key)) void refreshGroups()
          }}
          options={
            [
              ...(!group ? [{ value: '', label: groupsLoading ? '正在读取分组…' : '暂无可用分组', disabled: true }]
                : !selectedGroupAvailable ? [{ value: group, label: `${group}（${groupsLoading ? '确认中' : '已不可用'}）`, disabled: true }] : []),
              ...groups.map((value) => ({
                value: value.name,
                label: value.name,
              })),
            ]
          }
          value={group}
          onChange={(event) => setGroup(event.target.value)}
        />
        <Button variant="ghost" size="sm" icon={RefreshCw} testId="account-key-groups-refresh"
          loading={groupsLoading} disabled={groupsLoading || operation.busy === 'save-key'} onClick={() => void refreshGroups(true)}>
          刷新分组
        </Button>
        {groupsLoading && <p role="status">正在获取最新分组…</p>}
        {!groupsLoading && !groupsError && group && !selectedGroupAvailable && <p role="alert">原分组已不可用，请重新选择；已填写的内容仍保留。</p>}
        <Switch label="不限额度" checked={unlimited} onChange={setUnlimited} />
        {!unlimited && (
          <Input
            label="可用额度（USD）"
            type="number"
            min="0"
            step="0.01"
            value={quota}
            onChange={(event) => setQuota(event.target.value)}
          />
        )}
        <Input
          label="到期时间（留空为永不过期）"
          type="datetime-local"
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
        />
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        title="撤销这把密钥？"
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'revoke'}
              onClick={() => {
                if (removing)
                  void operation.execute(
                    'revoke',
                    async () => {
                      await api.revokeAccountKey(removing.id)
                      setRemoving(null)
                      await resource.reload()
                    },
                    '密钥已撤销',
                  )
              }}
            >
              确认撤销
            </Button>
          </>
        }
      >
        <p>使用这把密钥的工具会停止请求，需要重新配置有效密钥。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
      <Dialog
        open={Boolean(revealed)}
        title="密钥"
        onClose={() => setRevealed('')}
      >
        <Notice
          tone="warn"
          title="妥善保管密钥"
          body="不要把完整密钥发送给他人或放入反馈报告。"
        />
        <Input label="完整密钥" value={revealed} readOnly mono />
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        title="配置到工具"
        onClose={() => {
          ++modelRequest.current
          setSelected(null)
        }}
        footer={
          <>
            <Button onClick={() => { ++modelRequest.current; setSelected(null) }}>取消</Button>
            <Button
              variant="primary"
              icon={KeyRound}
              disabled={!model}
              loading={operation.busy === 'configure'}
              onClick={() => {
                if (selected)
                  void operation.execute(
                    'configure',
                    async () => {
                      await api.saveConfigWithAccountKey({
                        keyId: selected.id,
                        provider,
                        model,
                        mode: 'merge',
                      })
                      writeManualSourceMarker(
                        getSourceMarkerStorage(),
                        providerBaseUrls[provider],
                        provider,
                        false,
                      )
                      setSelected(null)
                    },
                    '密钥已写入工具配置',
                  )
              }}
            >
              保存配置
            </Button>
          </>
        }
      >
        <ResultNotice error={operation.error} />
        <Select
          aria-label="选择工具"
          options={tools
            .filter((tool) => tool.kind === 'cli')
            .map((tool) => ({ value: tool.id, label: tool.name }))}
          value={provider}
          onChange={(event) => {
            if (isProvider(event.target.value)) setProvider(event.target.value)
          }}
        />
        <Select
          aria-label="选择模型"
          options={models.map((value) => ({ value, label: value }))}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        <p>会写入所选工具的连接配置。Codex CLI 与桌面端共用同一份配置。</p>
      </Dialog>
    </>
  )
}
function AccountUsage({ api, balance }: { api: V2Bridge; balance: Balance }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [filter, setFilter] = useState<
    Parameters<V2Bridge['getAccountUsage']>[0]
  >({})
  const [selected, setSelected] = useState<Usage | null>(null)
  const load = useCallback(
    () => api.getAccountUsage({ ...filter, page, pageSize }),
    [api, page, pageSize, filter],
  )
  const resource = useResource(load)
  return (
    <>
      <AccountFilters
        fields={usageFilterFields}
        onApply={(values) => {
          setFilter({
            ...accountTimeRange(values.start, values.end),
            modelName: values.modelName,
            group: values.group,
            tokenName: values.tokenName,
            requestId: values.requestId,
            upstreamRequestId: values.upstreamRequestId,
            ...(values.type ? { type: Number(values.type) } : {}),
          })
          setPage(1)
        }}
      />
      <Toolbar
        left={
          <>
            <Pill>消耗 {quotaMoney(resource.data?.stats.quota, balance)}</Pill>
            <Pill>RPM {resource.data?.stats.rpm ?? '—'}</Pill>
            <Pill>TPM {resource.data?.stats.tpm ?? '—'}</Pill>
          </>
        }
        right={
          <Select
            aria-label="每页日志数量"
            options={[10, 20, 50, 100].map((size) => ({
              value: String(size),
              label: `${size} 条 / 页`,
            }))}
            value={String(pageSize)}
            onChange={(event) => {
              setPageSize(Number(event.target.value))
              setPage(1)
            }}
          />
        }
      />
      <ResultNotice error={resource.error} />
      <Card padding="none">
        <Table
          columns={[
            { key: 'when', label: '时间' },
            { key: 'model', label: '模型 / 分组' },
            { key: 'tokens', label: '输入 / 输出' },
            { key: 'amount', label: '消耗（USD）' },
            { key: 'duration', label: '耗时' },
            { key: 'action', label: '' },
          ]}
          rows={
            resource.data?.records.map((row) => ({
              id: String(row.id),
              when: displayDate(row.createdAt),
              model: (
                <>
                  {row.modelName}
                  <small>{row.group}</small>
                </>
              ),
              tokens: `${row.promptTokens} / ${row.completionTokens}`,
              amount: quotaMoney(row.quota, balance),
              duration: `${row.useTimeSeconds} 秒`,
              action: (
                <Button size="sm" icon={Eye} onClick={() => setSelected(row)}>
                  详情
                </Button>
              ),
            })) ?? []
          }
          rowKey={(row) => String(row.id)}
          empty={resource.loading ? '正在读取调用明细…' : '暂无调用明细'}
          label="调用明细"
        />
      </Card>
      <Pagination
        page={page}
        size={pageSize}
        total={resource.data?.total ?? 0}
        onChange={setPage}
      />
      <Drawer
        open={Boolean(selected)}
        title="调用详情"
        onClose={() => setSelected(null)}
      >
        {selected && (
          <dl className="v2-business-kv">
            <dt>模型</dt>
            <dd>{selected.modelName}</dd>
            <dt>请求编号</dt>
            <dd>{selected.requestId || '未提供'}</dd>
            <dt>上游请求</dt>
            <dd>{selected.upstreamRequestId || '未提供'}</dd>
            <dt>耗时</dt>
            <dd>{selected.useTimeSeconds} 秒</dd>
            <dt>首字响应</dt>
            <dd>{selected.details.firstResponseTimeMs ?? '未提供'} ms</dd>
            <dt>缓存读取</dt>
            <dd>{selected.details.cacheTokens}</dd>
            <dt>缓存写入</dt>
            <dd>{selected.details.cacheCreationTokens}</dd>
            <dt>说明</dt>
            <dd>{selected.content || '无'}</dd>
          </dl>
        )}
      </Drawer>
    </>
  )
}
function AccountDashboard({
  api,
  balance,
}: {
  api: V2Bridge
  balance: Balance
}) {
  const [days, setDays] = useState('7')
  const range = useMemo(() => {
    const endTimestamp = Math.floor(Date.now() / 1000)
    return { startTimestamp: endTimestamp - Number(days) * 86400, endTimestamp }
  }, [days])
  const load = useCallback(() => api.getAccountDashboard(range), [api, range])
  const resource = useResource(load)
  const max = Math.max(
    1,
    ...(resource.data?.buckets.map((bucket) => bucket.quota) ?? []),
  )
  return (
    <>
      <Toolbar
        left={
          <Select
            aria-label="统计时间"
            options={[
              { value: '1', label: '最近 24 小时' },
              { value: '7', label: '最近 7 天' },
              { value: '30', label: '最近 30 天' },
            ]}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        }
        right={
          <Button icon={RefreshCw} onClick={() => void resource.reload()}>
            刷新
          </Button>
        }
      />
      <ResultNotice error={resource.error} />
      <div className="v2-business-stat-grid">
        <Card title="消耗">
          <strong className="v2-business-amount">
            {quotaMoney(resource.data?.quota, balance)}
          </strong>
        </Card>
        <Card title="请求次数">
          <strong className="v2-business-amount">
            {resource.data?.count.toLocaleString() ?? '暂未读到'}
          </strong>
        </Card>
        <Card title="Token 数">
          <strong className="v2-business-amount">
            {resource.data?.tokens.toLocaleString() ?? '暂未读到'}
          </strong>
        </Card>
      </div>
      <Card title="用量趋势">
        <div className="v2-business-chart" aria-label="用量趋势">
          {resource.data?.buckets.length ? (
            resource.data.buckets.map((bucket) => (
              <div
                key={bucket.timestamp}
                className="v2-business-chart-column"
                title={`${displayDate(bucket.timestamp)}：${quotaMoney(bucket.quota, balance)}`}
              >
                <div
                  style={{
                    height: `${Math.max(2, (bucket.quota / max) * 100)}%`,
                  }}
                />
                <small>
                  {new Date(bucket.timestamp * 1000).toLocaleDateString(
                    'zh-CN',
                    { month: 'numeric', day: 'numeric' },
                  )}
                </small>
              </div>
            ))
          ) : (
            <p>{resource.loading ? '正在读取用量…' : '这个时间段还没有用量'}</p>
          )}
        </div>
      </Card>
      <Card padding="none">
        <Table
          columns={[
            { key: 'model', label: '模型' },
            { key: 'count', label: '请求' },
            { key: 'tokens', label: 'Token' },
            { key: 'quota', label: '消耗（USD）' },
          ]}
          rows={
            resource.data?.models.map((row) => ({
              model: row.model,
              count: row.count,
              tokens: row.tokens,
              quota: quotaMoney(row.quota, balance),
            })) ?? []
          }
          rowKey={(row) => String(row.model)}
          empty="暂无模型统计"
        />
      </Card>
    </>
  )
}
function AccountTasks({
  api,
  balance,
  accountScope,
}: {
  api: V2Bridge
  balance: Balance
  accountScope: string
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [filter, setFilter] = useState<
    Parameters<V2Bridge['getAccountTasks']>[0]
  >({})
  const [selected, setSelected] = useState<Task | null>(null)
  const operation = useOperation()
  const load = useCallback(
    () => api.getAccountTasks({ ...filter, page, pageSize }),
    [api, page, pageSize, filter],
  )
  const resource = useResource(load)
  const observedStatuses = useRef(new Map<number, string>())
  useEffect(() => {
    for (const task of resource.data?.tasks ?? []) {
      const previous = observedStatuses.current.get(task.id)
      observedStatuses.current.set(task.id, task.status)
      if (previous && previous !== 'SUCCESS' && task.status === 'SUCCESS') {
        void platformApi()
          ?.notifyActivity(
            'task',
            `${accountScope}:${task.id}:${Date.parse(task.finishAt) || 0}`,
          )
          .catch(() => undefined)
      }
    }
    while (observedStatuses.current.size > 200)
      observedStatuses.current.delete(
        observedStatuses.current.keys().next().value!,
      )
  }, [resource.data, accountScope])
  return (
    <>
      <AccountFilters
        fields={taskFilterFields}
        onApply={(values) => {
          setFilter({
            ...accountTimeRange(values.start, values.end),
            platform: values.platform,
            taskId: values.taskId,
            status: values.status,
            action: values.action,
          })
          setPage(1)
        }}
      />
      <Toolbar
        left={
          <Select
            aria-label="每页任务数量"
            options={[10, 20, 50, 100].map((size) => ({
              value: String(size),
              label: `${size} 条 / 页`,
            }))}
            value={String(pageSize)}
            onChange={(event) => {
              setPageSize(Number(event.target.value))
              setPage(1)
            }}
          />
        }
        right={
          <Button icon={RefreshCw} onClick={() => void resource.reload()}>
            刷新任务
          </Button>
        }
      />
      <ResultNotice error={resource.error || operation.error} />
      <Card padding="none">
        <Table
          columns={[
            { key: 'task', label: '任务' },
            { key: 'model', label: '模型' },
            { key: 'status', label: '状态' },
            { key: 'cost', label: '消耗（USD）' },
            { key: 'action', label: '' },
          ]}
          rows={
            resource.data?.tasks.map((task) => ({
              id: task.id,
              task: task.taskId,
              model: task.originModelName || task.platform,
              status: (
                <Pill tone={taskStates[task.status]?.tone ?? 'neutral'}>
                  {taskStates[task.status]?.label ?? '待确认'} {task.progress}
                </Pill>
              ),
              cost: quotaMoney(task.quota, balance),
              action: (
                <Button size="sm" icon={Eye} onClick={() => setSelected(task)}>
                  详情
                </Button>
              ),
            })) ?? []
          }
          rowKey={(row) => String(row.id)}
          empty={resource.loading ? '正在读取异步任务…' : '暂无异步任务'}
          label="异步任务"
        />
      </Card>
      <Pagination
        page={page}
        total={resource.data?.total ?? 0}
        size={pageSize}
        onChange={setPage}
      />
      <Drawer
        open={Boolean(selected)}
        title="任务详情"
        onClose={() => setSelected(null)}
        footer={
          selected?.resultUrl && (
            <Button
              icon={ExternalLink}
              onClick={() =>
                void operation.execute(
                  'open-task',
                  () => api.openExternal(selected.resultUrl),
                  '',
                )
              }
            >
              查看结果
            </Button>
          )
        }
      >
        {selected && (
          <dl className="v2-business-kv">
            <dt>任务编号</dt>
            <dd>{selected.taskId}</dd>
            <dt>创建时间</dt>
            <dd>{displayDate(selected.submitAt)}</dd>
            <dt>完成时间</dt>
            <dd>{displayDate(selected.finishAt)}</dd>
            <dt>操作</dt>
            <dd>{selected.action}</dd>
            <dt>状态</dt>
            <dd>{selected.status}</dd>
            <dt>失败原因</dt>
            <dd>{selected.failReason || '无'}</dd>
          </dl>
        )}
      </Drawer>
    </>
  )
}
function AccountOrders({
  api,
  paymentReturn,
}: {
  api: V2Bridge
  paymentReturn?: { sequence: number; order: string | null }
}) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState(paymentReturn?.order ?? '')
  const load = useCallback(
    () => api.getAccountTopupOrders({ page, pageSize: 20, keyword }),
    [api, page, keyword],
  )
  const resource = useResource(load)
  useEffect(() => {
    if (!paymentReturn) return
    const order = paymentReturn.order ?? ''
    if (page === 1 && keyword === order) void resource.reload()
    else {
      setKeyword(order)
      setPage(1)
    }
  }, [paymentReturn?.sequence])
  return (
    <>
      <Toolbar
        search={
          <SearchInput
            value={keyword}
            onChange={(value) => {
              setKeyword(value)
              setPage(1)
            }}
            placeholder="搜索订单号"
          />
        }
        right={
          <Button icon={RefreshCw} onClick={() => void resource.reload()}>
            查询订单
          </Button>
        }
      />
      <ResultNotice error={resource.error} />
      <Card padding="none">
        <Table
          columns={[
            { key: 'trade', label: '订单号' },
            { key: 'amount', label: '充值数量' },
            { key: 'paid', label: '支付金额' },
            { key: 'method', label: '支付方式' },
            { key: 'time', label: '创建时间' },
            { key: 'status', label: '状态' },
          ]}
          rows={
            resource.data?.orders.map((order) => ({
              id: order.id,
              trade: order.tradeNo,
              amount: order.amount,
              paid: order.money.toFixed(2),
              method: order.paymentMethod,
              time: displayDate(order.createdAt),
              status: (
                <Pill tone={orderStateFor(order.status).tone}>
                  {orderStateFor(order.status).label}
                </Pill>
              ),
            })) ?? []
          }
          rowKey={(row) => String(row.id)}
          empty={resource.loading ? '正在查询订单…' : '还没有订单'}
          label="我的订单"
        />
      </Card>
      <Pagination
        page={page}
        total={resource.data?.total ?? 0}
        onChange={setPage}
      />
    </>
  )
}
function AccountRecharge({
  api,
  balance,
  changed,
}: {
  api: V2Bridge
  balance: Balance
  changed: () => void
}) {
  const load = useCallback(async () => {
    const [info, plans, subscriptions] = await Promise.all([
      api.getAccountTopupInfo(),
      api.getAccountSubscriptionPlans(),
      api.getAccountSubscriptionSelf(),
    ])
    return { info, plans, subscriptions }
  }, [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [amount, setAmount] = useState('10')
  const [method, setMethod] = useState('')
  const [code, setCode] = useState('')
  const [quote, setQuote] = useState<Awaited<
    ReturnType<V2Bridge['quoteAccountTopupAmount']>
  > | null>(null)
  const [purchase, setPurchase] = useState<Plan | null>(null)
  const [purchaseMethod, setPurchaseMethod] = useState('balance')
  const [redeemOpen, setRedeemOpen] = useState(false)
  const [payment, setPayment] = useState<{
    tradeNo: string | null
    kind: 'topup' | 'subscription'
    expiresAt: string | null
  } | null>(null)
  const [paymentTerminal, setPaymentTerminal] =
    useState<AccountPaymentWindowTerminalEvent | null>(null)
  const paymentRef = useRef(payment)
  useEffect(() => {
    paymentRef.current = payment
  }, [payment])
  useEffect(() => {
    const available = resource.data?.info.paymentMethods ?? []
    setMethod((current) =>
      available.some((item) => item.type === current)
        ? current
        : available[0]?.type ?? '',
    )
  }, [resource.data?.info.paymentMethods])
  useEffect(
    () =>
      api.onAccountPaymentWindowTerminal((event) => {
        const current = paymentRef.current
        if (!current) return
        if (
          event.tradeNo &&
          current.tradeNo &&
          event.tradeNo !== current.tradeNo
        )
          return
        setPayment(null)
        setPaymentTerminal(event)
        changed()
        void resource.reload()
      }),
    [api, resource.reload],
  )
  const methods = resource.data?.info.paymentMethods ?? []
  const paymentMethod =
    methods.find((item) => item.type === method) ?? methods[0]
  const topupMinimum = Math.max(
    resource.data?.info.minTopup ?? 1,
    paymentMethod?.minTopup ?? 0,
  )
  const quoteTopup = () =>
    void operation.execute(
      'quote',
      async () => {
        const value = validateTopupAmount(Number(amount), topupMinimum)
        if (!paymentMethod) throw new Error('暂时没有可用的支付渠道。')
        setQuote(await api.quoteAccountTopupAmount({ amount: value }))
      },
      '',
    )
  const pay = () => {
    if (!quote || !paymentMethod) return
    void operation.execute(
      'payment',
      async () => {
        const result = await api.createAccountTopupPayment({
          amount: quote.amount,
          paymentMethod: paymentMethod.type,
        })
        setPaymentTerminal(null)
        setPayment({ ...result, kind: 'topup', expiresAt: null })
        setQuote(null)
      },
      '支付窗口已打开，到账状态请查询订单',
    )
  }
  const purchasePlan = () => {
    if (!purchase) return
    void operation.execute(
      'subscribe',
      async () => {
        if (purchaseMethod === 'balance') {
          await api.purchaseAccountSubscriptionWithBalance(purchase.id)
        } else {
          const payMethod = methods.find((item) => item.type === purchaseMethod)
          if (!payMethod || payMethod.provider === 'waffo')
            throw new Error('该支付渠道暂不支持订阅。')
          const result = await api.createAccountSubscriptionPayment(
            buildSubscriptionPaymentInput(purchase.id, payMethod),
          )
          setPaymentTerminal(null)
          setPayment({ ...result, kind: 'subscription' })
        }
        setPurchase(null)
        await resource.reload()
        changed()
      },
      purchaseMethod === 'balance'
        ? '订阅购买完成'
        : '支付窗口已打开，请在支付后刷新订阅',
    )
  }
  return (
    <>
      <ResultNotice
        error={resource.error || operation.error}
        message={operation.message}
      />
      <div className="v2-business-recharge-grid">
        <Card
          title="充值到账户余额"
          meta={`当前余额 ${dollars(balance.displayAmount)}`}
        >
          <div className="v2-business-suggestions-label">快捷金额</div>
          <div className="v2-business-suggestions">
            {(resource.data?.info.amountOptions ?? [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]).map((value) => (
              <Button size="sm" key={value} onClick={() => { setAmount(String(value)); setQuote(null) }}>{value}</Button>
            ))}
          </div>
          <Input
            label="自定义金额"
            type="number"
            min={topupMinimum}
            step="1"
            inputMode="numeric"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value)
              setQuote(null)
            }}
          />
          <PaymentOptions
            methods={methods}
            value={paymentMethod?.type ?? ''}
            onChange={(next) => {
              const nextMethod = methods.find((item) => item.type === next)
              setMethod(next)
              setQuote(null)
              if (nextMethod) {
                setAmount(
                  resetTopupQuoteForMethod(amount, nextMethod, resource.data?.info.minTopup ?? 1).amount,
                )
              }
            }}
          />
          <Button
            variant="balance"
            icon={CreditCard}
            disabled={!paymentMethod || resource.loading}
            loading={operation.busy === 'quote'}
            onClick={quoteTopup}
          >
            查看报价
          </Button>
          {!methods.length && !resource.loading && (
            <Notice
              tone="neutral"
              title="暂时没有可用的支付渠道"
              body="请稍后重试或联系支持。"
            />
          )}
        </Card>
        <Card title="兑换充值码">
          <Input
            label="充值码"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
          />
          <Button
            icon={Zap}
            disabled={
              !code.trim() || resource.data?.info.redemptionEnabled === false
            }
            onClick={() => setRedeemOpen(true)}
          >
            兑换
          </Button>
          <p>兑换成功后，余额会自动更新。</p>
        </Card>
      </div>
      {(payment || paymentTerminal) && (
        <Notice
          tone={paymentTerminal ? paymentTerminalPresentation(paymentTerminal.status).tone : 'neutral'}
          title={paymentTerminal ? paymentTerminalPresentation(paymentTerminal.status).title : '等待支付结果'}
          body={paymentTerminal
            ? `${paymentTerminalPresentation(paymentTerminal.status).body}${paymentTerminal.tradeNo ? ` 订单 ${paymentTerminal.tradeNo}。` : ''}`
            : `${payment?.kind === 'subscription' ? '订阅订单' : '订单'} ${payment?.tradeNo || '待生成'}。关闭支付窗口不会取消订单。`}
          actions={
            <>
              <Button
                size="sm"
                icon={RefreshCw}
                onClick={() => {
                  changed()
                  void resource.reload()
                }}
              >
                刷新余额与订阅
              </Button>
              {payment ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void operation.execute(
                      'close-payment',
                      async () => {
                        await api.closeAccountPaymentWindow()
                        setPayment(null)
                      },
                      '',
                    )
                  }
                >
                  关闭支付窗口
                </Button>
              ) : (
                <Button size="sm" onClick={() => setPaymentTerminal(null)}>
                  收起提示
                </Button>
              )}
            </>
          }
        />
      )}
      <Card title="我的订阅">
        <SettingRow
          title="扣费偏好"
          description="决定请求优先使用订阅还是账户余额"
          control={
            <Select
              aria-label="扣费偏好"
              options={billingOptions}
              value={
                resource.data?.subscriptions.billingPreference ??
                'subscription_first'
              }
              onChange={(event) => {
                const preference = event.target.value
                if (
                  preference === 'subscription_first' ||
                  preference === 'wallet_first' ||
                  preference === 'subscription_only' ||
                  preference === 'wallet_only'
                )
                  void operation.execute(
                    'preference',
                    async () => {
                      await api.updateAccountSubscriptionPreference(preference)
                      await resource.reload()
                    },
                    '扣费偏好已保存',
                  )
              }}
            />
          }
        />
        {resource.data?.subscriptions.allSubscriptions.length ? (
          resource.data.subscriptions.allSubscriptions.map((subscription) => (
            <ListRow
              key={subscription.id}
              icon={Zap}
              title={
                resource.data?.plans.find(
                  (plan) => plan.id === subscription.planId,
                )?.title ?? `订阅 ${subscription.planId}`
              }
              badge={
                <Pill
                  tone={subscription.status === 'active' ? 'ok' : 'neutral'}
                >
                  {subscription.status === 'active'
                    ? '生效中'
                    : subscription.status}
                </Pill>
              }
              desc={`剩余 ${quotaMoney(Math.max(0, subscription.amountTotal - subscription.amountUsed), balance)} · 到期 ${displayDate(subscription.endsAt)}`}
            />
          ))
        ) : (
          <p>还没有订阅</p>
        )}
      </Card>
      <Card title="选择订阅">
        {resource.data?.plans.map((plan) => (
          <ListRow
            key={plan.id}
            icon={Zap}
            title={plan.title}
            desc={plan.subtitle}
            meta={`${plan.currency} ${plan.priceAmount.toFixed(2)}`}
            actions={
              <Button
                icon={CreditCard}
                size="sm"
                onClick={() => {
                  setPurchase(plan)
                  setPurchaseMethod(
                    plan.allowBalancePay
                      ? 'balance'
                        : (subscriptionPaymentMethods(plan, methods, resource.data?.info)[0]?.type ??
                            ''),
                  )
                }}
              >
                购买
              </Button>
            }
          />
        ))}
      </Card>
      <Dialog
        open={Boolean(quote)}
        title="确认充值报价"
        onClose={() => setQuote(null)}
        footer={
          <>
            <Button onClick={() => setQuote(null)}>取消</Button>
            <Button
              variant="balance"
              icon={CreditCard}
              loading={operation.busy === 'payment'}
              onClick={pay}
            >
              打开支付窗口
            </Button>
          </>
        }
      >
        <p>充值数量：{quote?.amount}</p>
        <p>
          应付金额：{quote?.payableAmount.toFixed(2)}
          （支付渠道币种以支付页面为准）
        </p>
        <p>支付方式：{paymentMethod?.name}</p>
        <ResultNotice error={operation.error} />
      </Dialog>
      <Dialog
        open={redeemOpen}
        title="确认兑换到当前账号？"
        onClose={() => setRedeemOpen(false)}
        footer={
          <>
            <Button onClick={() => setRedeemOpen(false)}>取消</Button>
            <Button
              variant="primary"
              icon={Zap}
              loading={operation.busy === 'redeem'}
              onClick={() =>
                void operation.execute(
                  'redeem',
                  async () => {
                    await api.redeemAccountTopupCode(code.trim())
                    setCode('')
                    setRedeemOpen(false)
                    changed()
                  },
                  '充值码已兑换，余额已刷新',
                )
              }
            >
              确认兑换
            </Button>
          </>
        }
      >
        <p>兑换成功后会增加当前账号的可用余额。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
      <Dialog
        open={Boolean(purchase)}
        title={`购买 ${purchase?.title ?? '订阅'}`}
        onClose={() => setPurchase(null)}
        footer={
          <>
            <Button onClick={() => setPurchase(null)}>取消</Button>
            <Button
              variant="balance"
              icon={CreditCard}
              loading={operation.busy === 'subscribe'}
              disabled={!purchaseMethod}
              onClick={purchasePlan}
            >
              {purchaseMethod === 'balance' ? '确认购买' : '打开支付窗口'}
            </Button>
          </>
        }
      >
        <p>
          {purchase?.currency} {purchase?.priceAmount.toFixed(2)}
        </p>
        <Select
          aria-label="订阅支付方式"
          options={[
            ...(purchase?.allowBalancePay
              ? [{ value: 'balance', label: '账户余额' }]
              : []),
            ...(purchase
              ? subscriptionPaymentMethods(purchase, methods, resource.data?.info)
              : []
            ).map((item) => ({ value: item.type, label: item.name })),
          ]}
          value={purchaseMethod}
          onChange={(event) => setPurchaseMethod(event.target.value)}
        />
        <ResultNotice error={operation.error} />
      </Dialog>
    </>
  )
}
function AccountInvite({
  api,
  profile,
  balance,
  changed,
  inviteBaseUrl,
}: {
  api: V2Bridge
  profile: Profile
  balance: Balance
  changed: () => void
  inviteBaseUrl: string
}) {
  const operation = useOperation()
  const [transfer, setTransfer] = useState(false)
  const [amount, setAmount] = useState(
    String(profile.affQuota / balance.quotaPerUnit),
  )
  const invite = buildAccountInviteLink(inviteBaseUrl, profile.affCode)
  return (
    <>
      <ResultNotice {...operation} />
      <div className="v2-business-stat-grid">
        <Card title="我的返利比例">
          <strong className="v2-business-amount">{profile.affRebateRatePercent ?? 0}%</strong>
          <small>被邀请用户每次充值后可获得的返利比例</small>
        </Card>
        <Card title="已邀请">
          <strong className="v2-business-amount">{profile.affCount} 人</strong>
        </Card>
        <Card title="可转余额">
          <strong className="v2-business-amount">
            {quotaMoney(profile.affQuota, balance)}
          </strong>
        </Card>
        <Card title="累计返利">
          <strong className="v2-business-amount">
            {quotaMoney(profile.affHistoryQuota, balance)}
          </strong>
        </Card>
      </div>
      <Card title="邀请链接">
        <p className="v2-business-help">分享邀请码或邀请链接。好友注册并充值后，返利会计入可转额度，可随时转入账户余额。</p>
        <Input label="分享邀请链接" readOnly value={invite} />
        <Button
          icon={Copy}
          disabled={!invite}
          onClick={() =>
            void operation.execute(
              'copy',
              () => navigator.clipboard.writeText(invite),
              '邀请链接已复制',
            )
          }
        >
          复制链接
        </Button>
        <Button
          icon={Zap}
          disabled={profile.affQuota <= 0}
          onClick={() => setTransfer(true)}
        >
          转入账户余额
        </Button>
      </Card>
      <Card title="已邀请用户">
        {profile.invitees?.length ? <div className="v2-business-table"><div className="v2-business-table-row v2-business-table-head"><span>邮箱</span><span>用户名</span><span>累计返利</span></div>{profile.invitees.map((item) => <div className="v2-business-table-row" key={item.userId}><span>{item.email}</span><span>{item.username || '-'}</span><span>{quotaMoney(item.totalRebate, balance)}</span></div>)}</div> : <p>暂时还没有已邀请用户。</p>}
      </Card>
      <Dialog
        open={transfer}
        title="转入账户余额"
        onClose={() => setTransfer(false)}
        footer={
          <>
            <Button onClick={() => setTransfer(false)}>取消</Button>
            <Button
              variant="primary"
              icon={Zap}
              loading={operation.busy === 'transfer'}
              onClick={() =>
                void operation.execute(
                  'transfer',
                  async () => {
                    const quota = Math.round(
                      Number(amount) * balance.quotaPerUnit,
                    )
                    if (
                      !Number.isFinite(quota) ||
                      quota <= 0 ||
                      quota > profile.affQuota
                    )
                      throw new Error('转入金额不能超过可用返利。')
                    await api.transferAccountAffiliateQuota({ quota })
                    setTransfer(false)
                    changed()
                  },
                  '返利已转入余额',
                )
              }
            >
              确认转入
            </Button>
          </>
        }
      >
        <Input
          label="转入金额（USD）"
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <ResultNotice error={operation.error} />
      </Dialog>
    </>
  )
}
function AccountDevices({
  api,
  changed,
}: {
  api: V2Bridge
  changed: () => void
}) {
  const load = useCallback(() => api.getAccountLoginSessions(), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [revoke, setRevoke] = useState<string | 'others' | null>(null)
  return (
    <>
      <Toolbar
        right={
          <Button
            variant="danger"
            icon={Trash2}
            disabled={!resource.data?.some((session) => !session.current)}
            onClick={() => setRevoke('others')}
          >
            退出其他设备
          </Button>
        }
      />
      <ResultNotice {...operation} />
      <Card padding="none">
        <ListState
          page="devices"
          noun="登录设备"
          loading={resource.loading}
          error={resource.error}
          count={resource.data?.length ?? 0}
          retry={() => void resource.reload()}
        >
          {resource.data?.map((session) => (
            <ListRow
              key={session.sid}
              icon={Users}
              title={session.userAgent || '未知设备'}
              badge={session.current && <Pill tone="ok">当前设备</Pill>}
              desc={`${session.ip || '地址未提供'} · 最近活动 ${displayDate(session.lastActiveAt)}`}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Trash2}
                  onClick={() => setRevoke(session.sid)}
                >
                  退出登录
                </Button>
              }
            />
          ))}
        </ListState>
      </Card>
      <Dialog
        open={Boolean(revoke)}
        title={revoke === 'others' ? '退出其他设备？' : '退出这台设备？'}
        onClose={() => setRevoke(null)}
        footer={
          <>
            <Button onClick={() => setRevoke(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'revoke'}
              onClick={() =>
                void operation.execute(
                  'revoke',
                  async () => {
                    if (revoke === 'others')
                      await api.revokeOtherAccountLoginSessions()
                    else if (revoke) await api.revokeAccountLoginSession(revoke)
                    setRevoke(null)
                    changed()
                    await resource.reload()
                  },
                  '登录状态已更新',
                )
              }
            >
              确认退出
            </Button>
          </>
        }
      >
        <p>
          该设备需要重新登录才能查看账户信息。工具里已经写入的 API Key
          不受影响。
        </p>
        <ResultNotice error={operation.error} />
      </Dialog>
    </>
  )
}
