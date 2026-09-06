import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
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
  ReceiptText,
  Save,
  ShieldCheck,
  Trash2,
  UsersRound,
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
import { Button, Input, Password } from '../ui'
import './account-center-v3.css'

const KEYS_PAGE_SIZE = 8
const KEY_REVEAL_DURATION_MS = 30_000

export type AccountCenterPrimaryTab =
  | 'overview'
  | 'dashboard'
  | 'keys'
  | 'usage'
  | 'tasks'
  | 'recharge'
  | 'orders'
  | 'invite'
  | 'devices'

export type AccountCenterTab =
  | AccountCenterPrimaryTab
  | 'subscriptions'
  | 'topup'
  | 'redeem'
  | 'wallet'
  | 'profile'
  | 'security'

interface AccountCenterTabDefinition {
  id: AccountCenterPrimaryTab
  label: string
  description: string
  icon: LucideIcon
}

export const ACCOUNT_CENTER_TABS: readonly AccountCenterTabDefinition[] = [
  { id: 'overview', label: '我的账号', description: '身份、余额与账号安全', icon: UserRound },
  { id: 'dashboard', label: '用量看板', description: '消费趋势与模型用量', icon: BarChart3 },
  { id: 'keys', label: '密钥', description: '工具连接与调用凭据', icon: KeyRound },
  { id: 'usage', label: '调用明细', description: '逐次调用与费用', icon: Activity },
  { id: 'tasks', label: '异步任务', description: '图片、视频生成结果与进度', icon: ListChecks },
  { id: 'recharge', label: '充值与订阅', description: '余额充值、订阅与兑换', icon: Wallet },
  { id: 'orders', label: '我的订单', description: '订单记录与支付状态', icon: ReceiptText },
  { id: 'invite', label: '邀请返利', description: '邀请记录与奖励', icon: UsersRound },
  { id: 'devices', label: '登录设备', description: '当前设备与其他活跃会话', icon: MonitorSmartphone },
]

const commerceTabs: readonly AccountCommerceTab[] = ['subscriptions', 'topup', 'redeem']
const rechargeTabs = [['topup', '余额充值'], ['subscriptions', '订阅套餐'], ['redeem', '兑换码']] as const
const profileTabs = [['summary', '账号概览'], ['profile', '基本资料'], ['security', '修改密码']] as const
type ProfileTab = typeof profileTabs[number][0]

export function primaryTabFor(section: AccountCenterTab): AccountCenterPrimaryTab {
  if (section === 'wallet' || section === 'subscriptions' || section === 'topup' || section === 'redeem') return 'recharge'
  if (section === 'security' || section === 'profile') return 'overview'
  return section as AccountCenterPrimaryTab
}

export function commerceTabFor(section: AccountCenterTab): AccountCommerceTab {
  return commerceTabs.includes(section as AccountCommerceTab) ? section as AccountCommerceTab : section === 'wallet' ? 'subscriptions' : 'topup'
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
  /** Return to the caller's workspace context. */
  onClose: () => void
  /** Reuses App.tsx's existing handleAccountLogout; this component owns no session state of its own. */
  onLogout: () => void
  notify?: (toast: ToastMessage) => void
  initialSection?: AccountCenterTab
  onSwitchAccount?: () => void
  paymentReturn?: { sequence: number; order: string | null }
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

export function AccountCenterPage({ onClose, onLogout, notify, initialSection = 'overview', paymentReturn, onSwitchAccount }: AccountCenterPageProps) {
  const [primaryTab, setPrimaryTab] = useState<AccountCenterPrimaryTab>(() => primaryTabFor(initialSection))
  const [walletTab, setWalletTab] = useState<AccountCommerceTab>(() => commerceTabFor(initialSection))
  const [profileTab, setProfileTab] = useState<ProfileTab>(() => initialSection === 'security' ? 'security' : initialSection === 'profile' ? 'profile' : 'summary')
  const [visitedTabs, setVisitedTabs] = useState(() => new Set<AccountCenterPrimaryTab>([primaryTabFor(initialSection)]))
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
  const [passwordErrors, setPasswordErrors] = useState<AccountFieldErrors>({})
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const confirmedDisplayName = useRef<string | null>(null)
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
  const requestTracker = useRef(createLatestRequestTracker<'profile' | 'keys' | 'groups' | 'sessions'>()).current
  const copyResetTimer = useRef<number | null>(null)
  const revealedKeySecret = useRef<string | null>(null)
  const revealHideTimer = useRef<number | null>(null)
  const revealRequestId = useRef(0)
  const componentMounted = useRef(true)
  const currentTab = useRef(primaryTab)
  const bodyRef = useRef<HTMLDivElement>(null)
  const focusContentOnChange = useRef(false)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const scrollPositions = useRef(new Map<string, number>())
  const activeTabDefinition = ACCOUNT_CENTER_TABS.find((item) => item.id === primaryTab) ?? ACCOUNT_CENTER_TABS[0]
  const contentKey = primaryTab === 'overview' ? `overview-${profileTab}` : primaryTab === 'recharge' ? `recharge-${walletTab}` : primaryTab
  currentTab.current = primaryTab

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = scrollPositions.current.get(contentKey) ?? 0
    if (focusContentOnChange.current) {
      focusContentOnChange.current = false
      bodyRef.current?.focus({ preventScroll: true })
    }
  }, [contentKey])

  useEffect(() => {
    setVisitedTabs((current) => current.has(primaryTab) ? current : new Set([...current, primaryTab]))
  }, [primaryTab])

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, ids: readonly string[], current: string) => {
    const index = ids.indexOf(current)
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % ids.length : event.key === 'ArrowLeft' ? (index - 1 + ids.length) % ids.length : null
    if (nextIndex === null) return
    event.preventDefault()
    tabRefs.current.get(ids[nextIndex])?.focus()
  }

  useEffect(() => {
    setPrimaryTab(primaryTabFor(initialSection))
    if (primaryTabFor(initialSection) === 'recharge') setWalletTab(commerceTabFor(initialSection))
    if (initialSection === 'profile' || initialSection === 'security') setProfileTab(initialSection)
    else if (initialSection === 'overview') setProfileTab('summary')
  }, [initialSection])

  const loadProfile = useCallback(async (preserveDraft = true) => {
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
      const previousDisplayName = confirmedDisplayName.current
      const nextDisplayName = nextProfile.displayName ?? ''
      setDisplayName((current) => !preserveDraft || previousDisplayName === null || current === previousDisplayName ? nextDisplayName : current)
      confirmedDisplayName.current = nextDisplayName
    } catch (error) {
      if (requestTracker.isCurrent('profile', requestId)) setProfileError(errorMessage(error))
    } finally {
      if (requestTracker.isCurrent('profile', requestId)) setProfileLoading(false)
    }
  }, [requestTracker])

  const loadLoginSessions = useCallback(async () => {
    const requestId = requestTracker.begin('sessions')
    setLoginSessionsLoading(true)
    setLoginSessionsError(null)
    try {
      const next = await window.xingmang.getAccountLoginSessions()
      if (!requestTracker.isCurrent('sessions', requestId)) return
      setLoginSessions(next)
    } catch (error) {
      if (requestTracker.isCurrent('sessions', requestId)) setLoginSessionsError(resolveAccountErrorMessage(errorMessage(error)))
    } finally {
      if (requestTracker.isCurrent('sessions', requestId)) setLoginSessionsLoading(false)
    }
  }, [requestTracker])

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
    if (primaryTab === 'devices' && loginSessions === null && !loginSessionsLoading && !loginSessionsError) void loadLoginSessions()
  }, [primaryTab, loginSessions, loginSessionsLoading, loginSessionsError, loadLoginSessions])

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
    if (hasAccountFieldErrors(nextErrors)) {
      const firstError = nextErrors.originalPassword ? 'account-original-password' : nextErrors.password ? 'account-new-password' : 'account-confirm-password'
      document.getElementById(firstError)?.focus()
      return
    }
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
      await loadProfile(false)
      notify?.({ type: 'success', message: '资料已更新' })
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
        <div className="account-overview-actions">
          <Button icon={Pencil} size="sm" onClick={() => { focusContentOnChange.current = true; setProfileTab('profile') }}>编辑资料</Button>
          <Button icon={ShieldCheck} size="sm" onClick={() => { focusContentOnChange.current = true; setProfileTab('security') }}>修改密码</Button>
          <Button icon={MonitorSmartphone} size="sm" onClick={() => { focusContentOnChange.current = true; setPrimaryTab('devices') }}>管理登录设备</Button>
        </div>
      </div>
    )
  }

  const renderOverviewSide = () => (
    <aside className="account-overview-side">
      <section className="account-overview-card account-balance-card" aria-labelledby="account-balance-title">
        <header><h3 id="account-balance-title">账户余额（美元）</h3><span>星芒按量消费</span></header>
        <strong className="account-overview-balance">{balance ? formatBalanceUsd(balance.quota, balance.quotaPerUnit) : '—'}</strong>
        <p>每次调用的费用以实际记录为准。</p>
        <div className="account-overview-card-actions">
          <Button size="sm" icon={BarChart3} onClick={() => setPrimaryTab('dashboard')}>看用量</Button>
        </div>
      </section>
      <section className="account-overview-card account-saved-accounts" aria-labelledby="saved-accounts-title">
        <header><h3 id="saved-accounts-title">已保存的账号</h3><span>当前账号</span></header>
        <div className="account-saved-account-row">
          <span className="account-saved-avatar" aria-hidden="true">{(profile?.displayName || profile?.username || '星').slice(0, 1)}</span>
          <div><strong>{profile?.displayName || profile?.username || '星芒用户'}</strong><span>{profile?.email || '未绑定邮箱'}</span></div>
        </div>
        {onSwitchAccount && <Button size="sm" icon={UsersRound} onClick={onSwitchAccount}>切换账号</Button>}
        <p>各账号的余额、订单、Key 和聊天记录分别保存。</p>
      </section>
    </aside>
  )

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
        <div className="account-center-keys-table" role="table" aria-label="API 密钥" aria-colcount={10}>
          <div className="account-center-keys-head" role="row">
            <span role="columnheader">名称</span><span role="columnheader">密钥</span><span role="columnheader">分组</span><span role="columnheader">倍率</span><span role="columnheader">状态</span><span role="columnheader">额度</span><span role="columnheader">已用</span><span role="columnheader">创建时间</span><span role="columnheader">过期时间</span><span role="columnheader" className="account-center-keys-actions">操作</span>
          </div>
          <div className="account-center-keys-body" role="rowgroup" aria-busy={keysLoading}>
            {keys.keys.map((key) => {
              const group = keyGroups.find((entry) => entry.name === key.group)
              const keyIsRevealed = revealedKeyId === key.id && revealedKeySecret.current !== null
              return (
                <div className="account-center-keys-row" key={key.id} role="row">
                  <strong role="cell" title={key.name}>{key.name}</strong>
                  <div className="ui-table-cell" role="cell">
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
                  </div>
                  <span role="cell" title={group?.description || key.group || '默认分组'}>{key.group || '默认分组'}</span>
                  <span role="cell">{group ? `${String(group.ratio)}x` : '—'}</span>
                  <span role="cell">{accountKeyStatusLabel(key.status)}</span>
                  <span role="cell">{key.unlimitedQuota ? '无限' : formatKeyQuotaUsd(key.remainQuota, balance?.quotaPerUnit)}</span>
                  <span role="cell">{formatKeyQuotaUsd(key.usedQuota, balance?.quotaPerUnit)}</span>
                  <span role="cell">{formatAccountUsageDate(key.createdAt)}</span>
                  <span role="cell">{key.expiredAt ? formatAccountUsageDate(key.expiredAt) : '永不过期'}</span>
                  <span role="cell" className="account-center-keys-actions">
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
    if (profileLoading && !profile) return <section className="workspace-empty"><div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div><h2>正在读取资料</h2></section>
    if (!profile) return <div className="session-error" role="alert"><FileWarning size={18} /><div><strong>资料读取失败</strong><span>{profileError ?? '请稍后重试'}</span></div><button type="button" className="secondary-button" onClick={() => void loadProfile()}>重试</button></div>
    return (
      <div className="account-profile-settings">
        <section className="account-profile-identity">
          <span className="account-profile-avatar">{(profile.displayName || profile.username).slice(0, 1).toLocaleUpperCase('zh-CN')}</span>
          <div><strong>{profile.displayName || profile.username}</strong><span>用户 ID：{profile.userId}</span></div>
        </section>
        <form onSubmit={(event) => void submitProfile(event)}>
          <Input label="显示名称" value={displayName} maxLength={20} placeholder="在软件内显示的名称" onChange={(event) => setDisplayName(event.target.value)} hint="最多 20 个字符，不会修改登录用户名。" disabled={profileSubmitting} />
          <div className="account-profile-readonly">
            <div><span>用户名</span><strong>{profile.username}</strong></div>
            <div><span>邮箱</span><strong>{profile.email || '未绑定邮箱'}</strong></div>
            <div><span>账户分组</span><strong>{profile.group || '默认分组'}</strong></div>
          </div>
          <Button type="submit" variant="primary" icon={Save} loading={profileSubmitting} disabled={displayName.trim() === (profile.displayName ?? '')}>保存资料</Button>
        </form>
      </div>
    )
  }

  const renderSecurityTab = () => (
      <section className="account-center-security">
        <header className="account-security-section-title"><ShieldCheck size={18} /><div><h3>修改密码</h3><p>更新密码后，其他浏览器和设备会话将失效。</p></div></header>
        <form onSubmit={(event) => void submitChangePassword(event)}>
        <Password id="account-original-password" label="原密码" value={originalPassword} autoComplete="current-password"
          onChange={(event) => { setOriginalPassword(event.target.value); clearPasswordError('originalPassword') }}
          error={passwordErrors.originalPassword} disabled={passwordSubmitting} showLabel="显示原密码" hideLabel="隐藏原密码" />
        <Password id="account-new-password" label="新密码" value={newPassword} autoComplete="new-password" placeholder="8-20 位"
          onChange={(event) => { setNewPassword(event.target.value); clearPasswordError('password') }}
          error={passwordErrors.password} disabled={passwordSubmitting} showLabel="显示新密码" hideLabel="隐藏新密码" />
        <Password id="account-confirm-password" label="确认新密码" value={confirmNewPassword} autoComplete="new-password" placeholder="再次输入新密码"
          onChange={(event) => { setConfirmNewPassword(event.target.value); clearPasswordError('confirmPassword') }}
          error={passwordErrors.confirmPassword} disabled={passwordSubmitting} showLabel="显示确认密码" hideLabel="隐藏确认密码" />

        <p className="field-hint">修改成功后本设备无需重新登录；其他已登录设备与浏览器会话将被登出。</p>

        <Button type="submit" variant="primary" icon={ShieldCheck} loading={passwordSubmitting}>确认修改</Button>
        </form>
      </section>
  )

  const renderDevicesTab = () => (
      <section className="account-login-sessions">
        <header className="account-security-section-title">
          <MonitorSmartphone size={18} />
          <div><h3>登录设备</h3><p>查看当前账号的活跃会话，并撤销不再使用的设备。</p></div>
          <button type="button" className="icon-button compact" title="刷新设备列表" aria-label="刷新设备列表" disabled={loginSessionsLoading} onClick={() => void loadLoginSessions()}>
            <RefreshCw size={15} className={loginSessionsLoading ? 'spin' : undefined} />
          </button>
        </header>
        {loginSessionsError && (
          <div className="session-error" role="alert"><FileWarning size={18} /><div><strong>设备列表读取失败</strong><span>{loginSessionsError}</span></div><button type="button" className="secondary-button" onClick={() => void loadLoginSessions()}>重试</button></div>
        )}
        {loginSessionsLoading && !loginSessions ? (
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
  )

  return (
    <div className="account-center account-center-v3" data-page-id="account-center">
      <div className="account-center-inner">
        <header className="account-center-topbar">
          <div className="account-center-title">
            <button type="button" className="account-center-back-button" aria-label="返回首页" title="返回首页" onClick={onClose}><ArrowLeft size={16} aria-hidden="true" /></button>
            <span className="account-center-title-icon"><BadgeDollarSign size={20} /></span>
            <div>
              <h1>个人中心</h1>
              <p className="page-lead">余额、Key、用量与订单都在这里。</p>
            </div>
          </div>
          <div className="account-center-header-identity">
            <span className="account-center-avatar" aria-hidden="true">{(profile?.displayName || profile?.username || '星').slice(0, 1)}</span>
            <div><strong>{profile?.displayName || profile?.username || '星芒用户'}</strong><span>{profile?.email || (profileLoading ? '正在读取账户…' : '未绑定邮箱')}</span></div>
          </div>
          <div className="header-actions page-toolbar">
            <button type="button" className="account-center-recharge-button" onClick={() => { setPrimaryTab('recharge'); setWalletTab('topup') }}><Wallet size={15} aria-hidden="true" />充值</button>
            <button type="button" className="icon-button" title="登出星芒账号" aria-label="登出星芒账号" onClick={onLogout}>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <div className="account-center-layout">
          <div className="account-center-navigation">
            <nav aria-label="个人中心分区" role="tablist" aria-orientation="horizontal">
              {ACCOUNT_CENTER_TABS.map(({ id, label }) => (
                <button key={id} type="button" role="tab" id={`account-tab-${id}`} data-account-tab={id}
                  ref={(element) => { if (element) tabRefs.current.set(id, element); else tabRefs.current.delete(id) }}
                  aria-controls="account-center-panel" aria-selected={primaryTab === id}
                  aria-current={primaryTab === id ? 'page' : undefined} tabIndex={primaryTab === id ? 0 : -1}
                  className={primaryTab === id ? 'active' : ''}
                  onClick={() => setPrimaryTab(id)} onKeyDown={(event) => navigateTabs(event, ACCOUNT_CENTER_TABS.map((item) => item.id), id)}>
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          </div>

          <section className="account-center-workspace" role="tabpanel" id="account-center-panel" aria-labelledby={`account-tab-${primaryTab}`} tabIndex={0}>
            <header className="account-center-section-header">
              <div>
                <h2 id={`account-center-${primaryTab}-title`}>{activeTabDefinition.label}</h2>
              </div>
            </header>
            {primaryTab === 'recharge' && (
              <div className="account-center-subtabs" role="tablist" aria-label="充值与订阅分区">
                {rechargeTabs.map(([id, label]) => (
                  <button key={id} type="button" role="tab" id={`account-subtab-${id}`} data-account-subtab={id}
                    ref={(element) => { if (element) tabRefs.current.set(id, element); else tabRefs.current.delete(id) }}
                    aria-controls={`account-content-${contentKey}`} aria-selected={walletTab === id} tabIndex={walletTab === id ? 0 : -1}
                    className={walletTab === id ? 'active' : ''} onClick={() => setWalletTab(id)}
                    onKeyDown={(event) => navigateTabs(event, rechargeTabs.map(([value]) => value), id)}>{label}</button>
                ))}
              </div>
            )}
            {primaryTab === 'overview' && (
              <div className="account-center-subtabs" role="tablist" aria-label="我的账号分区">
                {profileTabs.map(([id, label]) => <button key={id} type="button" role="tab" id={`account-subtab-${id}`} data-account-subtab={id}
                  ref={(element) => { if (element) tabRefs.current.set(id, element); else tabRefs.current.delete(id) }}
                  aria-controls={`account-content-${contentKey}`} aria-selected={profileTab === id} tabIndex={profileTab === id ? 0 : -1}
                  className={profileTab === id ? 'active' : ''} onClick={() => setProfileTab(id)}
                  onKeyDown={(event) => navigateTabs(event, profileTabs.map(([value]) => value), id)}>{label}</button>)}
              </div>
            )}
            <div className="account-center-body" ref={bodyRef} id={`account-content-${contentKey}`}
              role={primaryTab === 'overview' || primaryTab === 'recharge' ? 'tabpanel' : undefined}
              aria-labelledby={primaryTab === 'overview' ? `account-subtab-${profileTab}` : primaryTab === 'recharge' ? `account-subtab-${walletTab}` : undefined}
              tabIndex={0} onScroll={(event) => scrollPositions.current.set(contentKey, event.currentTarget.scrollTop)}>
              {primaryTab === 'overview' && profileTab === 'summary' && <div className="account-overview-grid"><div>{renderProfileTab()}</div>{renderOverviewSide()}</div>}
              {(primaryTab === 'dashboard' || visitedTabs.has('dashboard')) && <div hidden={primaryTab !== 'dashboard'}><AccountDashboardPanel balance={balance} /></div>}
              <AccountCommercePanels
                paymentReturn={paymentReturn}
                activeTab={primaryTab === 'recharge' ? walletTab : primaryTab === 'orders' || primaryTab === 'invite' ? primaryTab : null}
                profile={profile}
                balance={balance}
                onRefreshAccount={loadProfile}
                notify={notify}
              />
              {(primaryTab === 'usage' || visitedTabs.has('usage')) && <div hidden={primaryTab !== 'usage'}><AccountUsagePanel quotaPerUnit={balance?.quotaPerUnit} /></div>}
              {(primaryTab === 'tasks' || visitedTabs.has('tasks')) && <div hidden={primaryTab !== 'tasks'}><AccountTaskPanel quotaPerUnit={balance?.quotaPerUnit} /></div>}
              {primaryTab === 'keys' && renderKeysTab()}
              {primaryTab === 'overview' && profileTab === 'profile' && renderPersonalProfileTab()}
              {primaryTab === 'overview' && profileTab === 'security' && renderSecurityTab()}
              {primaryTab === 'devices' && renderDevicesTab()}
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
