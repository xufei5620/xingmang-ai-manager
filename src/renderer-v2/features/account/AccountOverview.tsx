import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, LogOut, Monitor, RefreshCw, Users, Zap } from 'lucide-react'
import { Button, Dialog, Pill } from '../../ui'
import { dollars, PlaceholderBar, ResultNotice, useOperation, useRefreshRequest, useResource } from '../../business-common'
import { accountSiteId, accountSupports } from '../../account-context'
import { accountSwitchAnchor, billingOptions, type AccountLanding } from '../../registry/business'
import type { V2Bridge } from '../../types'
import type { AccountSessionState } from '../../../../electron/ipc-contract'
import { isActiveProviderId } from '../../../../electron/catalog'
import { subscriptionEndDate, type UsableSubscription } from '../../../../electron/subscription-summary'
import { accountSources } from '../auth/state'
import { useSharedAccountBalance } from '../app/balance-context'
import type { BalanceRunway } from '../app/balance-runway'
import { balanceStatusText } from '../shell/balance-status'
import { useOnlineStatus } from '../shell/useOnlineStatus'
import {
  countAccountKeys,
  inviteRateText,
  keyCountText,
  localSpendDays,
  runwayDaysText,
  spendBarHeights,
  spendDayTitle,
  spendSegmentQuery,
  subscriptionOverview,
  subscriptionOverviewText,
} from './account-center'

type Profile = Awaited<ReturnType<V2Bridge['getAccountProfile']>>
type Balance = Awaited<ReturnType<V2Bridge['getAccountBalance']>>

/** 外壳手上那几样和首页同源的数：账号概览不另算，免得两处说的不一样。 */
export interface AccountSummary {
  /** 「按最近用量约还能用 N 天」（balance-runway）。 */
  runway?: BalanceRunway | null
  /** 能扣的订阅（余额下面那行「另有……」）。 */
  subscription?: UsableSubscription | null
  /** 最近 7 天花了多少美元；历史账号没有按天的数，只写这个合计。 */
  weekUsageUsd?: number | null
}

/** 右上角那种「用量账单 ›」小链接。 */
function MoreLink({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return <button type="button" className="v2-acct-more" onClick={onClick} data-testid={testId}>{label}<ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" /></button>
}

function Row({ label, value, muted }: { label: string; value: ReactNode; muted?: boolean }) {
  return <div className="v2-acct-kv"><span>{label}</span><span className={muted ? 'is-muted' : undefined}>{value}</span></div>
}

/** 近 7 天每天花了多少：只星芒账号有按天的数（supportsDashboardTrends），一天一段读。 */
function useWeekSpend(api: V2Bridge, enabled: boolean, quotaPerUnit: number, refreshRequest?: number) {
  const load = useCallback(async () => {
    if (!enabled) return null
    const days = localSpendDays(new Date())
    const totals = await Promise.all(days.map(async (day, index) =>
      (await api.getAccountDashboard(spendSegmentQuery(day, index === days.length - 1))).quota))
    return days.map((day, index) => ({ ...day, usd: quotaPerUnit > 0 ? totals[index] / quotaPerUnit : 0 }))
  }, [api, enabled, quotaPerUnit])
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  return resource
}

function WeekSpend({ days, totalUsd }: { days: Array<{ start: number; label: string; usd: number }> | null; totalUsd: number | null }) {
  if (!days) return totalUsd === null ? null : <div className="v2-acct-week"><div className="v2-acct-week-head"><span>近 7 天花费</span><b>{dollars(totalUsd)}</b></div></div>
  const heights = spendBarHeights(days.map((day) => day.usd))
  const total = days.reduce((sum, day) => sum + day.usd, 0)
  const last = days.length - 1
  return (
    <div className="v2-acct-week" data-testid="account-overview-week">
      <div className="v2-acct-week-head"><span>近 7 天花费</span><b>{dollars(total)}</b></div>
      <div className="v2-acct-week-bars" role="img" aria-label={days.map((day) => spendDayTitle(day, dollars(day.usd))).join('；')}>
        {days.map((day, index) => (
          <div key={day.start} className={`v2-acct-week-col${index === last ? ' is-today' : ''}`} title={spendDayTitle(day, dollars(day.usd))}>
            <div className="v2-acct-week-track">
              {index === last && <em style={{ bottom: `calc(${heights[index]}% + 4px)` }}>{dollars(day.usd)}</em>}
              <i style={{ height: `${heights[index]}%` }} />
            </div>
            <span>{day.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AccountOverview({
  api,
  profile,
  balance,
  session,
  summary,
  refreshRequest,
  devicesChanged,
  onNavigate,
  onSwitchAccount,
  active = true,
  changed,
}: {
  api: V2Bridge
  profile: Profile
  balance: Balance
  session: AccountSessionState
  summary?: AccountSummary
  refreshRequest?: number
  /** 「账号安全」里让设备下线的次数；变了就重读台数。缺省 = 只在刷新时读。 */
  devicesChanged?: number
  /** 卡片上的小链接要去的页签或落点。 */
  onNavigate: (landing: AccountLanding) => void
  /** 打开「切换账号」框；缺省 = 那颗按钮灰着。 */
  onSwitchAccount?: () => void
  /** 概览是不是现在那个页签；从别的页签切回来时重读密钥把数。缺省 = 一直算在前台、不重读。 */
  active?: boolean
  changed: () => void
}) {
  const { store: balanceStore, snapshot: balanceState } = useSharedAccountBalance()
  const { offline } = useOnlineStatus()
  const balanceHint = balanceStatusText({ balanceLoading: balanceState.loading, balanceUpdatedAt: balanceState.updatedAt, balanceError: balanceState.error, offline })
  const operation = useOperation()
  const [logout, setLogout] = useState(false)
  const siteId = accountSiteId(session)
  const supportsUsage = accountSupports(session, 'supportsUsage')
  const supportsBilling = accountSupports(session, 'supportsBilling')
  const supportsSubscriptions = accountSupports(session, 'supportsSubscriptions')
  const supportsKeys = accountSupports(session, 'supportsKeyManagement')
  const supportsDevices = accountSupports(session, 'supportsSessionManagement')
  const trends = accountSupports(session, 'supportsDashboardTrends')
  const week = useWeekSpend(api, trends, balance.quotaPerUnit, refreshRequest)
  // 订阅、密钥把数、登录设备台数各读各的，一样没读到只空着那一行，不挡别的卡。
  const subscriptionLoad = useCallback(async () => {
    if (!supportsSubscriptions) return null
    const [self, plans] = await Promise.all([api.getAccountSubscriptionSelf(), api.getAccountSubscriptionPlans().catch(() => [])])
    return subscriptionOverview(self, { now: Date.now(), quotaPerUnit: balance.quotaPerUnit, planNames: new Map(plans.map((plan) => [plan.id, plan.title])) })
  }, [api, supportsSubscriptions, balance.quotaPerUnit])
  const subscription = useResource(subscriptionLoad)
  const keysLoad = useCallback(async () => {
    if (!supportsKeys) return null
    return countAccountKeys((query) => api.getAccountKeys(query), (provider) => isActiveProviderId(provider))
  }, [api, supportsKeys])
  const keys = useResource(keysLoad)
  // 切到别的页签时概览藏着不卸：回到概览时重读密钥把数，在「密钥管理」里新建、撤销、配到工具以后这里才对得上。
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) void keys.reload()
    wasActive.current = active
  }, [active])
  const devicesLoad = useCallback(async () => supportsDevices ? (await api.getAccountLoginSessions()).length : null, [api, supportsDevices])
  const devices = useResource(devicesLoad)
  useRefreshRequest(refreshRequest, () => {
    void subscription.reload()
    void keys.reload()
    void devices.reload()
  })
  useRefreshRequest(devicesChanged, () => void devices.reload())
  const runway = summary?.runway
  const usable = summary?.subscription
  const plan = subscription.data
  // 读完了、没出错、也没有生效中的订阅：「没有订阅」。重读时手上那份先留着。
  const subscriptionSettled = !plan && !subscription.loading && !subscription.error
  const preference = plan && accountSupports(session, 'supportsSubscriptionPreference') && plan.preference
    ? billingOptions.find((option) => option.value === plan.preference)?.label
    : undefined
  return (
    <>
      <ResultNotice {...operation} />
      <div className="v2-acct-overview">
        <section className="v2-acct-card is-focus" data-testid="account-overview-balance">
          <div className="v2-acct-card-head">
            <h2>账户余额</h2>
            {supportsUsage && <MoreLink label="用量账单" onClick={() => onNavigate('usage')} />}
          </div>
          <div className="v2-acct-balance-top">
            <strong className={`v2-acct-amount${runway?.low ? ' is-low' : ''}`} data-testid="account-balance" title={balanceHint}>
              {dollars(balance.displayAmount)}
            </strong>
            {balanceStore && <Button variant="ghost" size="sm" icon={RefreshCw} aria-label="刷新余额" title="刷新余额" loading={balanceState.loading} onClick={() => void balanceStore.refresh('manual')} testId="account-balance-refresh" />}
            {supportsBilling && <Button variant="balance" size="sm" icon={Zap} onClick={() => onNavigate('recharge')}>充值</Button>}
          </div>
          {balanceState.error && <p role="status" className="v2-balance-error" title={balanceState.error}>更新失败，显示上次余额</p>}
          {!supportsUsage && <p className="v2-acct-note">这是当前账号的可用余额，消费记录可在官方网站查看。</p>}
          {usable?.name && usable.remainingUsd !== null && (
            <p className="v2-acct-note">另有{usable.name} {dollars(usable.remainingUsd)}，{subscriptionEndDate(usable.endsAt)}到期</p>
          )}
          {runway?.days !== null && runway?.days !== undefined && (
            <p className={`v2-acct-days${runway.low ? ' is-low' : ''}`}>{runwayDaysText(runway.days)}</p>
          )}
          <WeekSpend days={trends ? week.data ?? null : null} totalUsd={trends ? null : summary?.weekUsageUsd ?? null} />
        </section>
        {supportsSubscriptions && (
          <section className="v2-acct-card" data-testid="account-overview-subscription">
            <div className="v2-acct-card-head">
              <h2>我的订阅</h2>
              {plan ? <Pill tone={plan.short ? 'warn' : 'ok'}>{plan.short ? '快用完了' : '生效中'}</Pill>
                : subscriptionSettled && <Pill tone="neutral">没有订阅</Pill>}
            </div>
            {subscription.error ? (
              <ResultNotice error={subscription.error} retry={{ label: '重新加载', onClick: () => void subscription.reload() }} />
            ) : plan ? (
              <>
                <p className="v2-acct-plan">{subscriptionOverviewText(plan)}</p>
                {plan.usedUsd !== null && plan.totalUsd !== null && (
                  <>
                    <div className={`v2-acct-bar${plan.short ? ' is-warn' : ''}`}><i style={{ width: `${Math.round(plan.usedUsd / plan.totalUsd * 100)}%` }} /></div>
                    <Row label="已用额度" value={`${dollars(plan.usedUsd)} / ${dollars(plan.totalUsd)}`} />
                  </>
                )}
                {preference && <Row label="扣费顺序" value={preference} />}
              </>
            ) : subscriptionSettled ? (
              <p className="v2-acct-note">现在按用量从余额扣费。</p>
            ) : <PlaceholderBar width="12em" />}
            {supportsBilling && (plan || subscriptionSettled) && (
              <div className="v2-acct-links"><MoreLink label={plan ? plan.short ? '去续费' : '查看套餐' : '看看套餐'} onClick={() => onNavigate('recharge')} /></div>
            )}
          </section>
        )}
        <section className="v2-acct-well" data-testid="account-overview-security">
          <h2>密钥与设备</h2>
          {supportsKeys && <Row label="密钥" value={keys.data ? keyCountText(keys.data.total, keys.data.inUse) : keys.error ? '—' : <PlaceholderBar width="4em" />} />}
          <Row label="登录设备" value={!supportsDevices ? '这个账号不提供管理' : devices.data !== null ? `${devices.data} 台` : devices.error ? '—' : <PlaceholderBar width="3em" />} muted={!supportsDevices} />
          <div className="v2-acct-links">
            {supportsKeys && <MoreLink label="密钥管理" onClick={() => onNavigate('keys')} />}
            <MoreLink label="账号安全" onClick={() => onNavigate('security')} />
          </div>
        </section>
        {supportsBilling && (
          <section className="v2-acct-well" data-testid="account-overview-invite">
            <div className="v2-acct-well-head"><h2>邀请好友</h2><span>{inviteRateText(profile.affRebateRatePercent)}</span></div>
            <Row label="已邀请" value={`${profile.affCount} 人`} />
            <Row label="累计获得返利" value={balance.quotaPerUnit > 0 ? dollars(profile.affHistoryQuota / balance.quotaPerUnit) : '—'} />
            <div className="v2-acct-links"><MoreLink label="查看邀请码" onClick={() => onNavigate('invite')} /></div>
          </section>
        )}
      </div>
      <section className="v2-acct-well v2-acct-session" data-anchor={accountSwitchAnchor} data-testid="account-overview-session">
        <span className="v2-acct-tile" aria-hidden="true"><Monitor size={17} /></span>
        <div>
          <strong>当前登录</strong>
          <p>{accountSources[siteId].label}，在这台电脑上。退出后，配好的工具会保留。</p>
        </div>
        <Button size="sm" icon={Users} onClick={onSwitchAccount} disabled={!onSwitchAccount} testId="account-switch">切换账号</Button>
        <Button size="sm" variant="danger" icon={LogOut} onClick={() => setLogout(true)} testId="account-overview-logout">退出登录</Button>
      </section>
      <Dialog
        open={logout}
        title="退出登录？"
        onClose={() => setLogout(false)}
        busy={operation.busy === 'logout'}
        footer={
          <>
            <Button onClick={() => setLogout(false)} disabled={operation.busy === 'logout'}>取消</Button>
            <Button
              variant="danger"
              icon={LogOut}
              loading={operation.busy === 'logout'}
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
              退出
            </Button>
          </>
        }
      >
        <p>已配好的工具会保留。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </>
  )
}
