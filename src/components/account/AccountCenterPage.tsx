import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  FileWarning,
  Inbox,
  LoaderCircle,
  LogOut,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { errorMessage } from '../../error-message'
import { createLatestRequestTracker } from '../../latest-request'
import type { AccountBalance, AccountProfileDetail, AccountUsagePage } from '../../types'
import { formatBalanceUsd } from './account-stub'
import { accountUsageTypeLabel, buildAccountInviteLink, formatAccountUsageDate, formatUsageCostUsd } from './account-center'
import type { ToastMessage } from '../Toast'

// Opens in the system browser (I12, href-exact-match allowlisted in
// electron/main.ts) -- the desktop session's cookies/access token never
// travel there, so the user authenticates again on the web the same way
// anyone would for an online payment; this app never handles card/payment
// details itself.
const WALLET_URL = 'https://xm.solov.cc/wallet'
const USAGE_PAGE_SIZE = 8

type AccountCenterTab = 'profile' | 'usage' | 'invite' | 'topup'

const TABS: ReadonlyArray<{ id: AccountCenterTab; label: string; icon: LucideIcon }> = [
  { id: 'profile', label: '资料', icon: UserRound },
  { id: 'usage', label: '用量', icon: Activity },
  { id: 'invite', label: '邀请', icon: Users },
  { id: 'topup', label: '充值', icon: Wallet },
]

export interface AccountCenterPageProps {
  /** "返回工作台" — the page's only exit besides logging out. */
  onClose: () => void
  /** Reuses App.tsx's existing handleAccountLogout; this component owns no session state of its own. */
  onLogout: () => void
  notify?: (toast: ToastMessage) => void
}

function compactCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

export function AccountCenterPage({ onClose, onLogout, notify }: AccountCenterPageProps) {
  const [tab, setTab] = useState<AccountCenterTab>('profile')
  const [profile, setProfile] = useState<AccountProfileDetail | null>(null)
  const [balance, setBalance] = useState<AccountBalance | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [usagePageNumber, setUsagePageNumber] = useState(1)
  const [usage, setUsage] = useState<AccountUsagePage | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [copiedField, setCopiedField] = useState<'code' | 'link' | null>(null)
  // T6: profile/usage are both async page data that can outlive a tab switch
  // or a fast double-open; keyed by a fixed string per data kind, same
  // pattern App.tsx already uses for mcp/skills/plugins via pageDataTracker.
  const requestTracker = useRef(createLatestRequestTracker<'profile' | 'usage'>()).current
  const copyResetTimer = useRef<number | null>(null)

  const loadProfile = useCallback(async () => {
    const requestId = requestTracker.begin('profile')
    setProfileLoading(true)
    setProfileError(null)
    try {
      // Promise.all, not allSettled: a half-populated panel (identity fields
      // rendered, balance fields blank because of an unrelated hiccup) reads
      // as more broken than a single retryable error banner -- and both
      // calls share the same authenticated session, so realistically they
      // fail together anyway. Mirrors getBalance()'s own internal Promise.all
      // in electron/new-api-client.ts.
      const [nextProfile, nextBalance] = await Promise.all([
        window.xingmang.getAccountProfile(),
        window.xingmang.getAccountBalance(),
      ])
      if (!requestTracker.isCurrent('profile', requestId)) return
      setProfile(nextProfile)
      setBalance(nextBalance)
    } catch (error) {
      if (requestTracker.isCurrent('profile', requestId)) setProfileError(errorMessage(error))
    } finally {
      if (requestTracker.isCurrent('profile', requestId)) setProfileLoading(false)
    }
  }, [requestTracker])

  useEffect(() => { void loadProfile() }, [loadProfile])

  const loadUsage = useCallback(async (page: number) => {
    const requestId = requestTracker.begin('usage')
    setUsageLoading(true)
    setUsageError(null)
    try {
      const next = await window.xingmang.getAccountUsage({ page, pageSize: USAGE_PAGE_SIZE })
      if (!requestTracker.isCurrent('usage', requestId)) return
      setUsage(next)
    } catch (error) {
      if (requestTracker.isCurrent('usage', requestId)) setUsageError(errorMessage(error))
    } finally {
      if (requestTracker.isCurrent('usage', requestId)) setUsageLoading(false)
    }
  }, [requestTracker])

  // Lazy, like App.tsx's mcp/skills/plugins pages: only fetched once the
  // user actually opens the 用量 tab, and again whenever the page changes.
  useEffect(() => {
    if (tab === 'usage') void loadUsage(usagePageNumber)
  }, [tab, usagePageNumber, loadUsage])

  useEffect(() => () => {
    requestTracker.invalidateAll()
    if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current)
  }, [requestTracker])

  const copyText = async (field: 'code' | 'link', value: string) => {
    if (!navigator.clipboard) {
      notify?.({ type: 'error', message: '当前环境不支持自动复制，请手动选中复制' })
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current)
      copyResetTimer.current = window.setTimeout(() => setCopiedField(null), 1_600)
    } catch {
      notify?.({ type: 'error', message: '复制失败，请手动选中复制' })
    }
  }

  const openWallet = () => {
    void window.xingmang.openExternal(WALLET_URL).catch((error: unknown) => {
      notify?.({ type: 'error', message: errorMessage(error) })
    })
  }

  const renderProfileTab = () => {
    if (profileLoading && !profile) {
      return (
        <section className="workspace-empty" aria-live="polite">
          <div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div>
          <h2>正在读取账号资料</h2>
        </section>
      )
    }
    if (profileError && !profile) {
      return (
        <div className="session-error" role="alert">
          <FileWarning size={18} />
          <div><strong>账号资料读取失败</strong><span>{profileError}</span></div>
          <button className="secondary-button" type="button" onClick={() => void loadProfile()}>重试</button>
        </div>
      )
    }
    if (!profile) return null
    return (
      <div className="account-center-panel">
        <div className="account-center-stats">
          <div className="account-center-stat">
            <span className="account-center-stat-label">账户余额</span>
            <strong className="account-center-stat-value">
              {balance ? formatBalanceUsd(balance.quota, balance.quotaPerUnit) : '—'}
            </strong>
          </div>
          <div className="account-center-stat">
            <span className="account-center-stat-label">已用额度</span>
            <strong className="account-center-stat-value">
              {balance ? formatBalanceUsd(balance.usedQuota, balance.quotaPerUnit) : '—'}
            </strong>
          </div>
          <div className="account-center-stat">
            <span className="account-center-stat-label">调用次数</span>
            <strong className="account-center-stat-value">{compactCount(profile.requestCount)}</strong>
          </div>
        </div>

        <div className="account-center-info-grid">
          <div className="account-center-info-item">
            <span>用户名</span>
            <strong title={profile.username}>{profile.username}</strong>
          </div>
          <div className="account-center-info-item">
            <span>邮箱</span>
            <strong title={profile.email ?? undefined}>{profile.email ?? '未绑定'}</strong>
          </div>
          <div className="account-center-info-item">
            <span>分组</span>
            <strong>{profile.group ?? '默认分组'}</strong>
          </div>
          <div className="account-center-info-item">
            <span>已邀请</span>
            <strong>{compactCount(profile.affCount)} 人</strong>
          </div>
        </div>
      </div>
    )
  }

  const renderUsageTab = () => {
    if (usageLoading && !usage) {
      return (
        <section className="workspace-empty" aria-live="polite">
          <div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div>
          <h2>正在读取用量明细</h2>
        </section>
      )
    }
    if (usageError && !usage) {
      return (
        <div className="session-error" role="alert">
          <FileWarning size={18} />
          <div><strong>用量明细读取失败</strong><span>{usageError}</span></div>
          <button className="secondary-button" type="button" onClick={() => void loadUsage(usagePageNumber)}>重试</button>
        </div>
      )
    }
    if (!usage) return null
    const totalPages = Math.max(1, Math.ceil(usage.total / USAGE_PAGE_SIZE))
    if (usage.records.length === 0) {
      return (
        <section className="workspace-empty">
          <div className="workspace-empty-icon"><Inbox size={24} /></div>
          <h2>暂无用量记录</h2>
          <p>开始使用后，这里会显示每一次调用的明细</p>
        </section>
      )
    }
    return (
      <div className="account-center-usage">
        <div className="account-center-usage-head" aria-hidden="true">
          <span>时间</span><span>模型</span><span>输入 tokens</span><span>输出 tokens</span><span>类型</span><span>费用</span>
        </div>
        <div className="account-center-usage-body" aria-busy={usageLoading}>
          {usage.records.map((record) => (
            <div className="account-center-usage-row" key={record.id}>
              <span>{formatAccountUsageDate(record.createdAt)}</span>
              <strong title={record.modelName || '未知模型'}>{record.modelName || '未知模型'}</strong>
              <span>{compactCount(record.promptTokens)}</span>
              <span>{compactCount(record.completionTokens)}</span>
              <span>{accountUsageTypeLabel(record.type)}</span>
              <span>{formatUsageCostUsd(record.quota, balance?.quotaPerUnit)}</span>
            </div>
          ))}
        </div>
        <footer className="account-center-pagination">
          <span>共 {usage.total} 条记录</span>
          <div>
            <button
              className="icon-button compact"
              type="button"
              title="上一页"
              aria-label="上一页"
              disabled={usagePageNumber <= 1 || usageLoading}
              onClick={() => setUsagePageNumber((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span>{usagePageNumber} / {totalPages}</span>
            <button
              className="icon-button compact"
              type="button"
              title="下一页"
              aria-label="下一页"
              disabled={usagePageNumber >= totalPages || usageLoading}
              onClick={() => setUsagePageNumber((value) => value + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </footer>
      </div>
    )
  }

  const renderInviteTab = () => {
    if (profileLoading && !profile) {
      return (
        <section className="workspace-empty" aria-live="polite">
          <div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div>
          <h2>正在读取邀请信息</h2>
        </section>
      )
    }
    if (!profile?.affCode) {
      return (
        <section className="workspace-empty">
          <div className="workspace-empty-icon"><Users size={24} /></div>
          <h2>暂无邀请码</h2>
          <p>{profileError ?? '请稍后重试，或联系客服'}</p>
        </section>
      )
    }
    const inviteLink = buildAccountInviteLink(profile.affCode)
    return (
      <div className="account-center-invite">
        <p className="account-center-invite-stat">
          已通过邀请码邀请 <strong>{compactCount(profile.affCount)}</strong> 人注册
        </p>
        <div className="field">
          <span>邀请码</span>
          <div className="input-with-action">
            <input readOnly value={profile.affCode} onFocus={(event) => event.currentTarget.select()} />
            <button
              type="button"
              title={copiedField === 'code' ? '已复制' : '复制邀请码'}
              onClick={() => void copyText('code', profile.affCode as string)}
            >
              {copiedField === 'code' ? <Check size={16} /> : <ClipboardCopy size={16} />}
            </button>
          </div>
        </div>
        <div className="field">
          <span>邀请链接</span>
          <div className="input-with-action">
            <input readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()} />
            <button
              type="button"
              title={copiedField === 'link' ? '已复制' : '复制邀请链接'}
              onClick={() => void copyText('link', inviteLink)}
            >
              {copiedField === 'link' ? <Check size={16} /> : <ClipboardCopy size={16} />}
            </button>
          </div>
          <small className="field-hint">好友通过此链接注册后自动关联邀请关系</small>
        </div>
        {/* TODO(后续任务): 返佣记录列表 -- 本波（W4a）不做，见任务范围说明 */}
      </div>
    )
  }

  const renderTopupTab = () => (
    <div className="account-center-topup">
      <p>
        充值在浏览器完成：点击下方按钮会打开系统默认浏览器访问星芒账号后台的充值页面。
        桌面客户端的登录状态不会带过去，请在网页端登录后完成充值——这与其他在线支付一致。
      </p>
      <p>充值到账后，回到本页「资料」标签刷新即可看到最新余额。</p>
      <button type="button" className="primary-button" onClick={openWallet}>
        <ExternalLink size={16} />
        去充值
      </button>
    </div>
  )

  return (
    <div className="account-center">
      <div className="account-center-inner">
        <header className="page-header account-center-header">
          <div>
            <div className="eyebrow">ACCOUNT CENTER</div>
            <h1>个人中心</h1>
          </div>
          <div className="header-actions page-toolbar">
            <button type="button" className="secondary-button" onClick={onClose}>
              <ArrowLeft size={15} />
              <span>返回工作台</span>
            </button>
            <button type="button" className="icon-button" title="登出星芒账号" aria-label="登出星芒账号" onClick={onLogout}>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <div className="segmented-control account-center-tabs" role="tablist" aria-label="个人中心分区">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              <Icon size={14} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <div className="account-center-body">
          {tab === 'profile' && renderProfileTab()}
          {tab === 'usage' && renderUsageTab()}
          {tab === 'invite' && renderInviteTab()}
          {tab === 'topup' && renderTopupTab()}
        </div>
      </div>
    </div>
  )
}
