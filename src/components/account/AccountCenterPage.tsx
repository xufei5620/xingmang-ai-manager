import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Eye,
  EyeOff,
  ExternalLink,
  FileWarning,
  Inbox,
  KeyRound,
  LoaderCircle,
  Lock,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  UserRound,
  Users,
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
  AccountProfileDetail,
  AccountUsagePage,
} from '../../types'
import { KeyEditorDialog } from './KeyEditorDialog'
import { formatBalanceUsd } from './account-stub'
import { resolveAccountErrorMessage } from './account-errors'
import {
  accountKeyStatusLabel,
  accountUsageTypeLabel,
  buildAccountInviteLink,
  formatAccountUsageDate,
  formatKeyQuotaUsd,
  formatUsageCostUsd,
  WALLET_URL,
} from './account-center'
import { hasAccountFieldErrors, validateChangePasswordForm, type AccountFieldErrors } from './validation'
import type { ToastMessage } from '../Toast'

const USAGE_PAGE_SIZE = 8
// Same page size as usage above -- both share the "one screen, no scroll"
// constraint this page's tabs are all designed around, so both cap their row
// count identically.
const KEYS_PAGE_SIZE = 8

type AccountCenterTab = 'profile' | 'usage' | 'invite' | 'topup' | 'keys' | 'security'

const TABS: ReadonlyArray<{ id: AccountCenterTab; label: string; icon: LucideIcon }> = [
  { id: 'profile', label: '资料', icon: UserRound },
  { id: 'usage', label: '用量', icon: Activity },
  { id: 'invite', label: '邀请', icon: Users },
  { id: 'topup', label: '充值', icon: Wallet },
  { id: 'keys', label: 'Key 管理', icon: KeyRound },
  { id: 'security', label: '安全', icon: Lock },
]

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
  const [keysPageNumber, setKeysPageNumber] = useState(1)
  const [keys, setKeys] = useState<AccountKeysPage | null>(null)
  const [keysLoading, setKeysLoading] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)
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
  // T6: profile/usage/keys are all async page data that can outlive a tab
  // switch or a fast double-open; keyed by a fixed string per data kind, same
  // pattern App.tsx already uses for mcp/skills/plugins via pageDataTracker.
  const requestTracker = useRef(createLatestRequestTracker<'profile' | 'usage' | 'keys'>()).current
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

  // Lazy, same reasoning as loadUsage above.
  useEffect(() => {
    if (tab === 'keys') void loadKeys(keysPageNumber)
  }, [tab, keysPageNumber, loadKeys])

  useEffect(() => () => {
    requestTracker.invalidateAll()
    if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current)
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
        <div className="account-center-keys-head" aria-hidden="true">
          <span>名称</span><span>状态</span><span>额度</span><span>已用</span><span>创建时间</span><span>过期时间</span><span>操作</span>
        </div>
        <div className="account-center-keys-body" aria-busy={keysLoading}>
          {keys.keys.map((key) => (
            <div className="account-center-keys-row" key={key.id}>
              <strong title={key.name}>{key.name}</strong>
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
          ))}
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

  const renderSecurityTab = () => (
    <div className="account-center-security">
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
          {tab === 'keys' && renderKeysTab()}
          {tab === 'security' && renderSecurityTab()}
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
          quotaPerUnit={balance?.quotaPerUnit}
          onClose={() => setKeyEditor(null)}
          onSubmit={(values) => void submitKeyEditor(values)}
          isSubmitting={keyEditorBusy}
        />
      )}
    </div>
  )
}
