import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Activity,
  ArrowLeft,
  BarChart3,
  BadgeDollarSign,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Eye,
  EyeOff,
  FileWarning,
  KeyRound,
  ListChecks,
  LoaderCircle,
  LogOut,
  MonitorSmartphone,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { DialogBackdrop } from '../Dialog'
import { errorMessage } from '../../error-message'
import { createLatestRequestTracker } from '../../latest-request'
import type {
  AccountBalance,
  AccountKey,
  AccountKeyCreateInput,
  AccountKeysPage,
  AccountLoginSession,
  AccountProfileDetail,
  AccountUsableGroup,
} from '../../types'
import { KeyEditorDialog } from './KeyEditorDialog'
import { AccountCommercePanels, type AccountCommerceTab } from './AccountCommercePanels'
import { AccountDashboardPanel } from './AccountDashboardPanel'
import { AccountTaskPanel } from './AccountTaskPanel'
import { AccountUsagePanel } from './AccountUsagePanel'
import { formatBalanceUsd } from './account-stub'
import { resolveAccountErrorMessage } from './account-errors'
import {
  accountKeyStatusLabel,
  formatAccountUsageDate,
  formatKeyQuotaUsd,
} from './account-center'
import { hasAccountFieldErrors, validateChangePasswordForm, type AccountFieldErrors } from './validation'
import type { ToastMessage } from '../Toast'

const KEYS_PAGE_SIZE = 8
const KEY_REVEAL_DURATION_MS = 30_000

export type AccountCenterPrimaryTab =
  | 'overview'
  | 'dashboard'
  | 'keys'
  | 'usage'
  | 'tasks'
  | 'wallet'
  | 'profile'

export type AccountCenterTab =
  | AccountCenterPrimaryTab
  | 'subscriptions'
  | 'topup'
  | 'orders'
  | 'redeem'
  | 'invite'
  | 'security'

type AccountCenterTabGroup = 'general' | 'personal'

interface AccountCenterTabDefinition {
  id: AccountCenterPrimaryTab
  label: string
  description: string
  icon: LucideIcon
  group: AccountCenterTabGroup
}

const TAB_GROUPS: ReadonlyArray<{ id: AccountCenterTabGroup; label: string }> = [
  { id: 'general', label: '常规' },
  { id: 'personal', label: '个人' },
]

const TABS: readonly AccountCenterTabDefinition[] = [
  { id: 'overview', label: '概览', description: '余额、累计用量与账户信息', icon: BadgeDollarSign, group: 'general' },
  { id: 'dashboard', label: '数据看板', description: '账户用量、吞吐与最近任务汇总', icon: BarChart3, group: 'general' },
  { id: 'keys', label: 'API 密钥', description: '密钥、分组、倍率与额度管理', icon: KeyRound, group: 'general' },
  { id: 'usage', label: '使用日志', description: '筛选模型调用、Token、缓存与费用明细', icon: Activity, group: 'general' },
  { id: 'tasks', label: '任务日志', description: '查看异步图片、视频和音频任务状态', icon: ListChecks, group: 'general' },
  { id: 'wallet', label: '钱包', description: '订阅、充值、订单、兑换与邀请返利', icon: Wallet, group: 'personal' },
  { id: 'profile', label: '个人资料', description: '账户资料、密码与登录设备', icon: UserRound, group: 'personal' },
]

const commerceTabs: readonly AccountCommerceTab[] = ['subscriptions', 'topup', 'orders', 'redeem', 'invite']

function primaryTabFor(section: AccountCenterTab): AccountCenterPrimaryTab {
  if (commerceTabs.includes(section as AccountCommerceTab)) return 'wallet'
  if (section === 'security') return 'profile'
  return section as AccountCenterPrimaryTab
}

function commerceTabFor(section: AccountCenterTab): AccountCommerceTab {
  return commerceTabs.includes(section as AccountCommerceTab) ? section as AccountCommerceTab : 'subscriptions'
}

/**
 * Confirm-before-revoke dialog for the Key 管理 tab (W4b) -- mirrors
 * PluginsPage.tsx's RemoveExtensionDialog exactly: the dialog owns only its
 * own local confirmError state, `onConfirm` is expected to throw on failure
 * (caught here and shown inline, dialog stays open for a retry) and resolve
 * silently on success (the parent closes the dialog itself, since only it
 * knows the mutation actually succeeded).
 */
function RevokeKeyDialog({ target, busy, onConfirm, onCancel }: {
  target: AccountKey
  busy: boolean
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const confirm = async () => {
    setConfirmError(null)
    try {
      await onConfirm()
    } catch (error) {
      setConfirmError(resolveAccountErrorMessage(errorMessage(error)))
    }
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <section className="extension-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="revoke-key-title">
        <span className="extension-confirm-icon danger"><Trash2 size={20} /></span>
        <h2 id="revoke-key-title">撤销 Key「{target.name}」</h2>
        <p>撤销后使用该 Key 的 CLI 或画布将立即失效，确认撤销？</p>
        {confirmError && <div className="extension-error extension-confirm-error" role="alert">{confirmError}</div>}
        <div className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="danger-button" type="button" onClick={() => void confirm()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} 确认撤销
          </button>
        </div>
      </section>
    </DialogBackdrop>
  )
}

export interface AccountCenterPageProps {
  /** "返回工作台" — the page's only exit besides logging out. */
  onClose: () => void
  /** Reuses App.tsx's existing handleAccountLogout; this component owns no session state of its own. */
  onLogout: () => void
  notify?: (toast: ToastMessage) => void
  initialSection?: AccountCenterTab
}

function compactCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

export function sessionDeviceLabel(userAgent: string, current = false): string {
  if (current) return '星芒 AI 管理工具'
  const normalized = userAgent.toLocaleLowerCase('en-US')
  const system = normalized.includes('windows')
    ? 'Windows'
    : normalized.includes('mac os') || normalized.includes('macintosh')
      ? 'macOS'
      : normalized.includes('android')
        ? 'Android'
        : normalized.includes('iphone') || normalized.includes('ipad')
          ? 'iOS'
          : normalized.includes('linux')
            ? 'Linux'
            : '未知系统'
  const client = normalized.includes('electron')
    ? '星芒客户端'
    : normalized.includes('edg/')
      ? 'Edge'
      : normalized.includes('chrome/')
        ? 'Chrome'
        : normalized.includes('firefox/')
          ? 'Firefox'
          : normalized.includes('safari/')
            ? 'Safari'
            : '浏览器或客户端'
  return `${system} · ${client}`
}

export function AccountKeySecretCell({
  keyName,
  maskedKey,
  revealedSecret,
  copying,
  copied,
  revealing,
  copyDisabled,
  revealDisabled,
  onCopy,
  onToggleReveal,
}: {
  keyName: string
  maskedKey: string
  revealedSecret: string | null
  copying: boolean
  copied: boolean
  revealing: boolean
  copyDisabled: boolean
  revealDisabled: boolean
  onCopy: () => void
  onToggleReveal: () => void
}) {
  const revealed = revealedSecret !== null
  return (
    <div className={`account-key-secret${revealed ? ' revealed' : ''}`}>
      <button
        className="account-key-copy"
        type="button"
        title="点击复制完整 API Key"
        aria-label={`复制 API Key「${keyName}」`}
        disabled={copyDisabled}
        onClick={onCopy}
      >
        <code>{revealedSecret ?? (maskedKey || '点击复制')}</code>
        {copying
          ? <LoaderCircle className="spin" size={14} />
          : copied
            ? <Check size={14} />
            : <ClipboardCopy size={14} />}
      </button>
      <button
        className="icon-button compact account-key-reveal"
        type="button"
        title={revealed ? '隐藏完整 API Key' : '显示完整 API Key'}
        aria-label={`${revealed ? '隐藏' : '显示'} API Key「${keyName}」`}
        aria-pressed={revealed}
        disabled={revealDisabled}
        onClick={onToggleReveal}
      >
        {revealing
          ? <LoaderCircle className="spin" size={14} />
          : revealed
            ? <EyeOff size={14} />
            : <Eye size={14} />}
      </button>
    </div>
  )
}

export function AccountCenterPage({ onClose, onLogout, notify, initialSection = 'overview' }: AccountCenterPageProps) {
  const [primaryTab, setPrimaryTab] = useState<AccountCenterPrimaryTab>(() => primaryTabFor(initialSection))
  const [walletTab, setWalletTab] = useState<AccountCommerceTab>(() => commerceTabFor(initialSection))
  const [profileTab, setProfileTab] = useState<'profile' | 'security'>(() => initialSection === 'security' ? 'security' : 'profile')
  const [profile, setProfile] = useState<AccountProfileDetail | null>(null)
  const [balance, setBalance] = useState<AccountBalance | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [keysPageNumber, setKeysPageNumber] = useState(1)
  const [keys, setKeys] = useState<AccountKeysPage | null>(null)
  const [keysLoading, setKeysLoading] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)
  const [keyGroups, setKeyGroups] = useState<AccountUsableGroup[]>([])
  const [keyGroupsLoading, setKeyGroupsLoading] = useState(false)
  const [keyGroupsError, setKeyGroupsError] = useState<string | null>(null)
  const [copiedKeyId, setCopiedKeyId] = useState<number | null>(null)
  const [copyingKeyId, setCopyingKeyId] = useState<number | null>(null)
  const [revealedKeyId, setRevealedKeyId] = useState<number | null>(null)
  const [revealingKeyId, setRevealingKeyId] = useState<number | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<AccountKey | null>(null)
  // 添加/编辑 Key 弹窗(老板需求 2026-08-10)。null = 关闭。
  const [keyEditor, setKeyEditor] = useState<{ mode: 'create' } | { mode: 'edit'; key: AccountKey } | null>(null)
  const [keyEditorBusy, setKeyEditorBusy] = useState(false)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [originalPassword, setOriginalPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [showPasswordFields, setShowPasswordFields] = useState(false)
  const [passwordErrors, setPasswordErrors] = useState<AccountFieldErrors>({})
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [profileSubmitting, setProfileSubmitting] = useState(false)
  const [loginSessions, setLoginSessions] = useState<AccountLoginSession[] | null>(null)
  const [loginSessionsLoading, setLoginSessionsLoading] = useState(false)
  const [loginSessionsError, setLoginSessionsError] = useState<string | null>(null)
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null)
  const [revokingOtherSessions, setRevokingOtherSessions] = useState(false)
  const [sessionRevokeTarget, setSessionRevokeTarget] = useState<AccountLoginSession | 'others' | null>(null)
  // T6: profile/keys are async page data that can outlive a tab
  // switch or a fast double-open; keyed by a fixed string per data kind, same
  // pattern App.tsx already uses for mcp/skills/plugins via pageDataTracker.
  const requestTracker = useRef(createLatestRequestTracker<'profile' | 'keys' | 'groups'>()).current
  const copyResetTimer = useRef<number | null>(null)
  const revealedKeySecret = useRef<string | null>(null)
  const revealHideTimer = useRef<number | null>(null)
  const revealRequestId = useRef(0)
  const componentMounted = useRef(true)
  const currentTab = useRef(primaryTab)
  const activeTabDefinition = TABS.find((item) => item.id === primaryTab) ?? TABS[0]
  currentTab.current = primaryTab

  useEffect(() => {
    setPrimaryTab(primaryTabFor(initialSection))
    if (commerceTabs.includes(initialSection as AccountCommerceTab)) setWalletTab(initialSection as AccountCommerceTab)
    if (initialSection === 'profile' || initialSection === 'security') setProfileTab(initialSection)
  }, [initialSection])

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
      setDisplayName(nextProfile.displayName ?? '')
    } catch (error) {
      if (requestTracker.isCurrent('profile', requestId)) setProfileError(errorMessage(error))
    } finally {
      if (requestTracker.isCurrent('profile', requestId)) setProfileLoading(false)
    }
  }, [requestTracker])

  const loadLoginSessions = useCallback(async () => {
    setLoginSessionsLoading(true)
    setLoginSessionsError(null)
    try {
      const next = await window.xingmang.getAccountLoginSessions()
      if (!componentMounted.current) return
      setLoginSessions(next)
    } catch (error) {
      if (componentMounted.current) setLoginSessionsError(resolveAccountErrorMessage(errorMessage(error)))
    } finally {
      if (componentMounted.current) setLoginSessionsLoading(false)
    }
  }, [])

  useEffect(() => { void loadProfile() }, [loadProfile])

  const loadKeys = useCallback(async (page: number) => {
    const requestId = requestTracker.begin('keys')
    setKeysLoading(true)
    setKeysError(null)
    try {
      const next = await window.xingmang.getAccountKeys({ page, pageSize: KEYS_PAGE_SIZE })
      if (!requestTracker.isCurrent('keys', requestId)) return
      setKeys(next)
    } catch (error) {
      if (requestTracker.isCurrent('keys', requestId)) setKeysError(errorMessage(error))
    } finally {
      if (requestTracker.isCurrent('keys', requestId)) setKeysLoading(false)
    }
  }, [requestTracker])

  const loadKeyGroups = useCallback(async () => {
    const requestId = requestTracker.begin('groups')
    setKeyGroupsLoading(true)
    setKeyGroupsError(null)
    try {
      const next = await window.xingmang.getAccountUsableGroups()
      if (!requestTracker.isCurrent('groups', requestId)) return
      setKeyGroups(next)
    } catch (error) {
      if (requestTracker.isCurrent('groups', requestId)) {
        setKeyGroupsError(resolveAccountErrorMessage(errorMessage(error)))
      }
    } finally {
      if (requestTracker.isCurrent('groups', requestId)) setKeyGroupsLoading(false)
    }
  }, [requestTracker])

  // Lazy, same reasoning as loadUsage above.
  useEffect(() => {
    if (primaryTab === 'keys') void loadKeys(keysPageNumber)
  }, [primaryTab, keysPageNumber, loadKeys])

  useEffect(() => {
    if (primaryTab !== 'keys') return
    if (keyGroups.length === 0 && !keyGroupsLoading && !keyGroupsError) void loadKeyGroups()
  }, [primaryTab, loadKeyGroups, keyGroups.length, keyGroupsLoading, keyGroupsError])

  useEffect(() => {
    if (primaryTab === 'profile' && profileTab === 'security' && loginSessions === null && !loginSessionsLoading) void loadLoginSessions()
  }, [primaryTab, profileTab, loginSessions, loginSessionsLoading, loadLoginSessions])

  useEffect(() => {
    if (primaryTab === 'keys') return
    revealRequestId.current += 1
    revealedKeySecret.current = null
    setRevealedKeyId(null)
    setRevealingKeyId(null)
    if (revealHideTimer.current) {
      window.clearTimeout(revealHideTimer.current)
      revealHideTimer.current = null
    }
  }, [primaryTab])

  useEffect(() => {
    componentMounted.current = true
    return () => {
      componentMounted.current = false
      requestTracker.invalidateAll()
      revealRequestId.current += 1
      revealedKeySecret.current = null
      if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current)
      if (revealHideTimer.current) window.clearTimeout(revealHideTimer.current)
    }
  }, [requestTracker])

  // Mirrors PluginsPage.tsx's RemoveExtensionDialog usage: throws on failure
  // (RevokeKeyDialog's own confirm() wrapper catches it and shows it inline,
  // keeping the dialog open for a retry) and only reaches the
  // success-handling tail below when the revoke genuinely succeeded.
  const confirmRevokeKey = async () => {
    if (!revokeTarget) return
    const target = revokeTarget
    setRevokeBusy(true)
    try {
      await window.xingmang.revokeAccountKey(target.id)
    } finally {
      setRevokeBusy(false)
    }
    setRevokeTarget(null)
    notify?.({ type: 'success', message: `已撤销 Key「${target.name}」` })
    void loadKeys(keysPageNumber)
  }

  const submitKeyEditor = async (values: AccountKeyCreateInput) => {
    if (!keyEditor || keyEditorBusy) return
    setKeyEditorBusy(true)
    try {
      if (keyEditor.mode === 'create') {
        await window.xingmang.createAccountKey(values)
        notify?.({ type: 'success', message: `Key「${values.name}」已创建` })
      } else {
        await window.xingmang.updateAccountKey({ ...values, id: keyEditor.key.id })
        notify?.({ type: 'success', message: `Key「${values.name}」已更新` })
      }
      setKeyEditor(null)
      void loadKeys(keysPageNumber)
    } catch (error) {
      notify?.({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      setKeyEditorBusy(false)
    }
  }

  const clearPasswordError = (field: keyof AccountFieldErrors) => {
    setPasswordErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))
  }

  const submitChangePassword = async (event: FormEvent) => {
    event.preventDefault()
    if (passwordSubmitting) return
    const nextErrors = validateChangePasswordForm({ originalPassword, newPassword, confirmNewPassword })
    setPasswordErrors(nextErrors)
    if (hasAccountFieldErrors(nextErrors)) return
    setPasswordSubmitting(true)
    try {
      // The main process adopts the fresh session token this call returns
      // internally (electron/new-api-client.ts's changePassword) -- this
      // device's own session keeps working with no further action here;
      // only *other* signed-in devices/browsers get signed out server-side.
      await window.xingmang.changeAccountPassword({ originalPassword, newPassword })
      // 密码已变,「记住密码」里存的旧密码从此失效——清除而非更新:store 里
      // 的 identifier 未必属于当前登录账号(可能是另一账号的记住项),就地
      // 改写有串号风险,清掉最安全(复查发现)。
      void window.xingmang.setRememberedAccountLogin(null).catch(() => undefined)
      setOriginalPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      setPasswordErrors({})
      notify?.({ type: 'success', message: '密码修改成功' })
    } catch (error) {
      notify?.({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      setPasswordSubmitting(false)
    }
  }

  const submitProfile = async (event: FormEvent) => {
    event.preventDefault()
    if (profileSubmitting || !profile) return
    const nextDisplayName = displayName.trim()
    if (nextDisplayName.length > 20) {
      notify?.({ type: 'error', message: '显示名称不能超过 20 个字符' })
      return
    }
    setProfileSubmitting(true)
    try {
      await window.xingmang.updateAccountDisplayName({ displayName: nextDisplayName })
      await loadProfile()
      notify?.({ type: 'success', message: '个人资料已更新' })
    } catch (error) {
      notify?.({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      if (componentMounted.current) setProfileSubmitting(false)
    }
  }

  const revokeLoginSession = async (session: AccountLoginSession) => {
    if (revokingSessionId || revokingOtherSessions) return
    setRevokingSessionId(session.sid)
    try {
      const result = await window.xingmang.revokeAccountLoginSession(session.sid)
      if (result.current) {
        notify?.({ type: 'success', message: '当前设备已退出登录' })
        onLogout()
        return
      }
      notify?.({ type: 'success', message: '登录设备已撤销' })
      setSessionRevokeTarget(null)
      await loadLoginSessions()
    } catch (error) {
      notify?.({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      if (componentMounted.current) setRevokingSessionId(null)
    }
  }

  const revokeOtherLoginSessions = async () => {
    if (revokingSessionId || revokingOtherSessions) return
    setRevokingOtherSessions(true)
    try {
      const result = await window.xingmang.revokeOtherAccountLoginSessions()
      notify?.({ type: 'success', message: result.revokedCount > 0 ? `已退出其他 ${result.revokedCount} 个设备` : '没有其他登录设备' })
      setSessionRevokeTarget(null)
      await loadLoginSessions()
    } catch (error) {
      notify?.({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      if (componentMounted.current) setRevokingOtherSessions(false)
    }
  }

  const copyAccountKey = async (key: AccountKey) => {
    if (copyingKeyId !== null) return
    if (key.status !== 1) {
      notify?.({ type: 'error', message: '该 API Key 已失效或已撤销，请先创建新的 Key' })
      return
    }
    setCopyingKeyId(key.id)
    try {
      await window.xingmang.copyAccountKey(key.id)
      setCopiedKeyId(key.id)
      notify?.({ type: 'success', message: `API Key「${key.name}」已复制` })
      if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current)
      copyResetTimer.current = window.setTimeout(() => setCopiedKeyId(null), 1_600)
    } catch (error) {
      notify?.({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      setCopyingKeyId(null)
    }
  }

  const hideRevealedAccountKey = () => {
    revealRequestId.current += 1
    if (revealHideTimer.current) {
      window.clearTimeout(revealHideTimer.current)
      revealHideTimer.current = null
    }
    revealedKeySecret.current = null
    setRevealedKeyId(null)
  }

  const toggleAccountKeyReveal = async (key: AccountKey) => {
    if (key.status !== 1) {
      notify?.({ type: 'error', message: '该 API Key 已失效或已撤销，不能显示明文' })
      return
    }
    if (revealedKeyId === key.id) {
      hideRevealedAccountKey()
      return
    }
    if (revealingKeyId !== null) return

    hideRevealedAccountKey()
    const requestId = ++revealRequestId.current
    setRevealingKeyId(key.id)
    try {
      const secret = await window.xingmang.revealAccountKey(key.id)
      if (
        !componentMounted.current
        || currentTab.current !== 'keys'
        || revealRequestId.current !== requestId
      ) return
      revealedKeySecret.current = secret
      setRevealedKeyId(key.id)
      revealHideTimer.current = window.setTimeout(() => {
        revealHideTimer.current = null
        revealedKeySecret.current = null
        if (componentMounted.current) setRevealedKeyId(null)
      }, KEY_REVEAL_DURATION_MS)
    } catch (error) {
      if (componentMounted.current && revealRequestId.current === requestId) {
        notify?.({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
      }
    } finally {
      if (componentMounted.current && revealRequestId.current === requestId) setRevealingKeyId(null)
    }
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

  const renderKeysTab = () => {
    if (keysLoading && !keys) {
      return (
        <section className="workspace-empty" aria-live="polite">
          <div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div>
          <h2>正在读取 Key 列表</h2>
        </section>
      )
    }
    if (keysError && !keys) {
      return (
        <div className="session-error" role="alert">
          <FileWarning size={18} />
          <div><strong>Key 列表读取失败</strong><span>{keysError}</span></div>
          <button className="secondary-button" type="button" onClick={() => void loadKeys(keysPageNumber)}>重试</button>
        </div>
      )
    }
    if (!keys) return null
    const totalPages = Math.max(1, Math.ceil(keys.total / KEYS_PAGE_SIZE))
    if (keys.keys.length === 0) {
      return (
        <section className="workspace-empty">
          <div className="workspace-empty-icon"><KeyRound size={24} /></div>
          <h2>暂无 Key</h2>
          <p>「一键配置」写入 CLI 配置的星芒 Key 会显示在这里</p>
          <button className="primary-button" type="button" onClick={() => setKeyEditor({ mode: 'create' })}>
            <Plus size={15} aria-hidden="true" /> 添加 Key
          </button>
        </section>
      )
    }
    return (
      <div className="account-center-keys">
        <div className="account-center-keys-toolbar">
          <button className="secondary-button" type="button" onClick={() => setKeyEditor({ mode: 'create' })}>
            <Plus size={15} aria-hidden="true" /> 添加 Key
          </button>
        </div>
        <div className="account-center-keys-table">
          <div className="account-center-keys-head" aria-hidden="true">
            <span>名称</span><span>API 密钥</span><span>分组</span><span>倍率</span><span>状态</span><span>额度</span><span>已用</span><span>创建时间</span><span>过期时间</span><span className="account-center-keys-actions">操作</span>
          </div>
          <div className="account-center-keys-body" aria-busy={keysLoading}>
            {keys.keys.map((key) => {
              const group = keyGroups.find((entry) => entry.name === key.group)
              const keyIsRevealed = revealedKeyId === key.id && revealedKeySecret.current !== null
              return (
                <div className="account-center-keys-row" key={key.id}>
                  <strong title={key.name}>{key.name}</strong>
                  <AccountKeySecretCell
                    keyName={key.name}
                    maskedKey={key.maskedKey}
                    revealedSecret={keyIsRevealed ? revealedKeySecret.current : null}
                    copying={copyingKeyId === key.id}
                    copied={copiedKeyId === key.id}
                    revealing={revealingKeyId === key.id}
                    copyDisabled={copyingKeyId !== null}
                    revealDisabled={revealingKeyId !== null}
                    onCopy={() => void copyAccountKey(key)}
                    onToggleReveal={() => void toggleAccountKeyReveal(key)}
                  />
                  <span title={group?.description || key.group || '默认分组'}>{key.group || '默认分组'}</span>
                  <span>{group ? `${String(group.ratio)}x` : '—'}</span>
                  <span>{accountKeyStatusLabel(key.status)}</span>
                  <span>{key.unlimitedQuota ? '无限' : formatKeyQuotaUsd(key.remainQuota, balance?.quotaPerUnit)}</span>
                  <span>{formatKeyQuotaUsd(key.usedQuota, balance?.quotaPerUnit)}</span>
                  <span>{formatAccountUsageDate(key.createdAt)}</span>
                  <span>{key.expiredAt ? formatAccountUsageDate(key.expiredAt) : '永不过期'}</span>
                  <span className="account-center-keys-actions">
                    <button
                      className="icon-button compact"
                      type="button"
                      title="编辑"
                      aria-label={`编辑 Key「${key.name}」`}
                      onClick={() => setKeyEditor({ mode: 'edit', key })}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button compact"
                      type="button"
                      title="撤销"
                      aria-label={`撤销 Key「${key.name}」`}
                      onClick={() => setRevokeTarget(key)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
        <footer className="account-center-pagination">
          <span>共 {keys.total} 个</span>
          <div>
            <button
              className="icon-button compact"
              type="button"
              title="上一页"
              aria-label="上一页"
              disabled={keysPageNumber <= 1 || keysLoading}
              onClick={() => setKeysPageNumber((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span>{keysPageNumber} / {totalPages}</span>
            <button
              className="icon-button compact"
              type="button"
              title="下一页"
              aria-label="下一页"
              disabled={keysPageNumber >= totalPages || keysLoading}
              onClick={() => setKeysPageNumber((value) => value + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </footer>
      </div>
    )
  }

  const renderPersonalProfileTab = () => {
    if (profileLoading && !profile) return <section className="workspace-empty"><div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div><h2>正在读取个人资料</h2></section>
    if (!profile) return <div className="session-error" role="alert"><FileWarning size={18} /><div><strong>个人资料读取失败</strong><span>{profileError ?? '请稍后重试'}</span></div><button type="button" className="secondary-button" onClick={() => void loadProfile()}>重试</button></div>
    return (
      <div className="account-profile-settings">
        <section className="account-profile-identity">
          <span className="account-profile-avatar">{(profile.displayName || profile.username).slice(0, 1).toLocaleUpperCase('zh-CN')}</span>
          <div><strong>{profile.displayName || profile.username}</strong><span>用户 ID：{profile.userId}</span></div>
        </section>
        <form onSubmit={(event) => void submitProfile(event)}>
          <label className="field extension-field"><span>显示名称</span><input value={displayName} maxLength={20} placeholder="在软件内显示的名称" onChange={(event) => setDisplayName(event.target.value)} /><small className="field-hint">最多 20 个字符，不会修改登录用户名。</small></label>
          <div className="account-profile-readonly">
            <div><span>用户名</span><strong>{profile.username}</strong></div>
            <div><span>邮箱</span><strong>{profile.email || '未绑定邮箱'}</strong></div>
            <div><span>账户分组</span><strong>{profile.group || '默认分组'}</strong></div>
          </div>
          <button type="submit" className="primary-button" disabled={profileSubmitting || displayName.trim() === (profile.displayName ?? '')}>
            {profileSubmitting ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {profileSubmitting ? '正在保存…' : '保存资料'}
          </button>
        </form>
      </div>
    )
  }

  const renderSecurityTab = () => (
    <div className="account-security-layout">
      <section className="account-center-security">
        <header className="account-security-section-title"><ShieldCheck size={18} /><div><h3>修改密码</h3><p>更新密码后，其他浏览器和设备会话将失效。</p></div></header>
        <form onSubmit={(event) => void submitChangePassword(event)}>
        <label className="field extension-field">
          <span>原密码</span>
          <div className="input-with-action">
            <input
              type={showPasswordFields ? 'text' : 'password'}
              value={originalPassword}
              onChange={(event) => { setOriginalPassword(event.target.value); clearPasswordError('originalPassword') }}
              autoComplete="current-password"
            />
            <button
              type="button"
              title={showPasswordFields ? '隐藏密码' : '显示密码'}
              onClick={() => setShowPasswordFields((current) => !current)}
            >
              {showPasswordFields ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {passwordErrors.originalPassword && <small className="field-error" role="alert">{passwordErrors.originalPassword}</small>}
        </label>

        <label className="field extension-field">
          <span>新密码</span>
          <div className="input-with-action">
            <input
              type={showPasswordFields ? 'text' : 'password'}
              value={newPassword}
              onChange={(event) => { setNewPassword(event.target.value); clearPasswordError('password') }}
              placeholder="8-20 位"
              autoComplete="new-password"
            />
            <button
              type="button"
              title={showPasswordFields ? '隐藏密码' : '显示密码'}
              onClick={() => setShowPasswordFields((current) => !current)}
            >
              {showPasswordFields ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {passwordErrors.password && <small className="field-error" role="alert">{passwordErrors.password}</small>}
        </label>

        <label className="field extension-field">
          <span>确认新密码</span>
          <div className="input-with-action">
            <input
              type={showPasswordFields ? 'text' : 'password'}
              value={confirmNewPassword}
              onChange={(event) => { setConfirmNewPassword(event.target.value); clearPasswordError('confirmPassword') }}
              placeholder="再次输入新密码"
              autoComplete="new-password"
            />
            <button
              type="button"
              title={showPasswordFields ? '隐藏密码' : '显示密码'}
              onClick={() => setShowPasswordFields((current) => !current)}
            >
              {showPasswordFields ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {passwordErrors.confirmPassword && <small className="field-error" role="alert">{passwordErrors.confirmPassword}</small>}
        </label>

        <p className="field-hint">修改成功后本设备无需重新登录；其他已登录设备与浏览器会话将被登出。</p>

        <button type="submit" className="primary-button" disabled={passwordSubmitting}>
          {passwordSubmitting ? '提交中…' : '确认修改'}
        </button>
        </form>
      </section>
      <section className="account-login-sessions">
        <header className="account-security-section-title">
          <MonitorSmartphone size={18} />
          <div><h3>登录设备</h3><p>查看当前账号的活跃会话，并撤销不再使用的设备。</p></div>
          <button type="button" className="icon-button compact" title="刷新设备列表" aria-label="刷新设备列表" disabled={loginSessionsLoading} onClick={() => void loadLoginSessions()}>
            <RefreshCw size={15} className={loginSessionsLoading ? 'spin' : undefined} />
          </button>
        </header>
        {loginSessionsError && !loginSessions ? (
          <div className="session-error" role="alert"><FileWarning size={18} /><div><strong>设备列表读取失败</strong><span>{loginSessionsError}</span></div><button type="button" className="secondary-button" onClick={() => void loadLoginSessions()}>重试</button></div>
        ) : loginSessionsLoading && !loginSessions ? (
          <div className="account-sessions-loading"><LoaderCircle size={18} className="spin" />正在读取登录设备…</div>
        ) : (
          <>
            <div className="account-session-list">
              {(loginSessions ?? []).map((session) => (
                <article className={session.current ? 'is-current' : ''} key={session.sid}>
                  <span className="account-session-icon"><MonitorSmartphone size={17} /></span>
                  <div className="account-session-main">
                    <strong>{sessionDeviceLabel(session.userAgent, session.current)} {session.current && <em>当前设备</em>}</strong>
                    <span>{session.ip || 'IP 未知'} · {session.loginMethod || '账号登录'}</span>
                    <small>最近活动 {formatAccountUsageDate(session.lastActiveAt)} · 到期 {formatAccountUsageDate(session.expiresAt)}</small>
                  </div>
                  <button type="button" className={session.current ? 'secondary-button' : 'danger-button'} disabled={revokingSessionId !== null || revokingOtherSessions} onClick={() => setSessionRevokeTarget(session)}>
                    {revokingSessionId === session.sid ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}
                    {session.current ? '退出当前设备' : '撤销'}
                  </button>
                </article>
              ))}
              {!loginSessionsLoading && loginSessions?.length === 0 && <div className="account-sessions-loading">服务器未返回登录设备。</div>}
            </div>
            <footer className="account-session-footer">
              <span>撤销其他设备不会影响当前客户端。</span>
              <button type="button" className="secondary-button" disabled={revokingOtherSessions || revokingSessionId !== null || (loginSessions?.filter((session) => !session.current).length ?? 0) === 0} onClick={() => setSessionRevokeTarget('others')}>
                {revokingOtherSessions ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}退出其他设备
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  )

  return (
    <div className="account-center">
      <div className="account-center-inner">
        <header className="account-center-topbar">
          <div className="account-center-title">
            <span className="account-center-title-icon"><BadgeDollarSign size={20} /></span>
            <div>
              <div className="eyebrow">XINGMANG ACCOUNT</div>
              <h1>星芒 AI 账户</h1>
            </div>
          </div>
          <div className="header-actions page-toolbar">
            <button type="button" className="secondary-button" onClick={onClose}>
              <ArrowLeft size={15} />
              <span>工作台</span>
            </button>
            <button type="button" className="icon-button" title="登出星芒账号" aria-label="登出星芒账号" onClick={onLogout}>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <div className="account-center-layout">
          <aside className="account-center-navigation">
            <div className="account-center-identity">
              <span className="account-center-avatar" aria-hidden="true">
                {(profile?.displayName || profile?.username || '星').trim().slice(0, 1).toLocaleUpperCase('zh-CN')}
              </span>
              <div>
                <strong>{profile?.displayName || profile?.username || '星芒用户'}</strong>
                <span>{profile?.email || (profileLoading ? '正在读取账户…' : '未绑定邮箱')}</span>
              </div>
            </div>
            <nav aria-label="个人中心分区">
              {TAB_GROUPS.map((group) => (
                <div className="account-center-nav-group" key={group.id}>
                  <div className="account-center-nav-label">{group.label}</div>
                  {TABS.filter((item) => item.group === group.id).map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      aria-current={primaryTab === id ? 'page' : undefined}
                      className={primaryTab === id ? 'active' : ''}
                      onClick={() => setPrimaryTab(id)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{label}</span>
                      <ChevronRight size={14} className="account-center-nav-chevron" />
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <div className="account-center-balance-summary">
              <span>可用余额</span>
              <div>
                <strong>{balance ? formatBalanceUsd(balance.quota, balance.quotaPerUnit) : '—'}</strong>
                <button
                  type="button"
                  className="account-center-recharge-button"
                  onClick={() => {
                    setPrimaryTab('wallet')
                    setWalletTab('topup')
                  }}
                >
                  充值
                </button>
              </div>
            </div>
          </aside>

          <section className="account-center-workspace" aria-labelledby={`account-center-${primaryTab}-title`}>
            <header className="account-center-section-header">
              <div>
                <h2 id={`account-center-${primaryTab}-title`}>{activeTabDefinition.label}</h2>
                <p>{activeTabDefinition.description}</p>
              </div>
            </header>
            {primaryTab === 'wallet' && (
              <div className="account-center-subtabs" role="tablist" aria-label="钱包分区">
                {([
                  ['subscriptions', '我的订阅'],
                  ['topup', '充值 / 订阅'],
                  ['orders', '我的订单'],
                  ['redeem', '兑换'],
                  ['invite', '邀请返利'],
                ] as const).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={walletTab === id} className={walletTab === id ? 'active' : ''} onClick={() => setWalletTab(id)}>{label}</button>
                ))}
              </div>
            )}
            {primaryTab === 'profile' && (
              <div className="account-center-subtabs" role="tablist" aria-label="个人资料分区">
                <button type="button" role="tab" aria-selected={profileTab === 'profile'} className={profileTab === 'profile' ? 'active' : ''} onClick={() => setProfileTab('profile')}>基本资料</button>
                <button type="button" role="tab" aria-selected={profileTab === 'security'} className={profileTab === 'security' ? 'active' : ''} onClick={() => setProfileTab('security')}>安全与设备</button>
              </div>
            )}
            <div className="account-center-body" role="tabpanel">
              {primaryTab === 'overview' && renderProfileTab()}
              {primaryTab === 'dashboard' && <AccountDashboardPanel balance={balance} />}
              <AccountCommercePanels
                activeTab={primaryTab === 'wallet' ? walletTab : null}
                profile={profile}
                balance={balance}
                onRefreshAccount={loadProfile}
                notify={notify}
              />
              {primaryTab === 'usage' && <AccountUsagePanel quotaPerUnit={balance?.quotaPerUnit} />}
              {primaryTab === 'tasks' && <AccountTaskPanel quotaPerUnit={balance?.quotaPerUnit} />}
              {primaryTab === 'keys' && renderKeysTab()}
              {primaryTab === 'profile' && profileTab === 'profile' && renderPersonalProfileTab()}
              {primaryTab === 'profile' && profileTab === 'security' && renderSecurityTab()}
            </div>
          </section>
        </div>
      </div>

      {revokeTarget && (
        <RevokeKeyDialog
          target={revokeTarget}
          busy={revokeBusy}
          onConfirm={confirmRevokeKey}
          onCancel={() => setRevokeTarget(null)}
        />
      )}

      {keyEditor && (
        <KeyEditorDialog
          mode={keyEditor.mode}
          initial={keyEditor.mode === 'edit' ? keyEditor.key : undefined}
          groups={keyGroups}
          groupsLoading={keyGroupsLoading}
          groupsError={keyGroupsError}
          onRetryGroups={() => void loadKeyGroups()}
          quotaPerUnit={balance?.quotaPerUnit}
          onClose={() => setKeyEditor(null)}
          onSubmit={(values) => void submitKeyEditor(values)}
          isSubmitting={keyEditorBusy}
        />
      )}

      {sessionRevokeTarget && (
        <DialogBackdrop
          className="config-modal-backdrop extension-backdrop"
          onDismiss={revokingSessionId || revokingOtherSessions ? () => undefined : () => setSessionRevokeTarget(null)}
        >
          <section className="extension-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="revoke-session-title">
            <span className="extension-confirm-icon danger"><LogOut size={20} /></span>
            <h2 id="revoke-session-title">
              {sessionRevokeTarget === 'others'
                ? '退出所有其他设备'
                : sessionRevokeTarget.current
                  ? '退出当前设备'
                  : '撤销此登录设备'}
            </h2>
            <p>
              {sessionRevokeTarget === 'others'
                ? '其他浏览器和客户端将立即退出登录，当前客户端不受影响。'
                : sessionRevokeTarget.current
                  ? '当前客户端会立即清除登录状态，需要重新输入账号密码登录。'
                  : `${sessionDeviceLabel(sessionRevokeTarget.userAgent)}（${sessionRevokeTarget.ip || 'IP 未知'}）将立即退出登录。`}
            </p>
            <div className="extension-dialog-actions">
              <button type="button" className="secondary-button" disabled={Boolean(revokingSessionId) || revokingOtherSessions} onClick={() => setSessionRevokeTarget(null)}>取消</button>
              <button
                type="button"
                className="danger-button"
                disabled={Boolean(revokingSessionId) || revokingOtherSessions}
                onClick={() => {
                  if (sessionRevokeTarget === 'others') void revokeOtherLoginSessions()
                  else void revokeLoginSession(sessionRevokeTarget)
                }}
              >
                {(revokingSessionId || revokingOtherSessions) ? <LoaderCircle className="spin" size={16} /> : <LogOut size={16} />}
                确认退出
              </button>
            </div>
          </section>
        </DialogBackdrop>
      )}
    </div>
  )
}
