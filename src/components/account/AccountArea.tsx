import { AlertTriangle, KeyRound, LogOut, RefreshCw, UserRound } from 'lucide-react'
import { formatBalanceUsd, type AccountAreaStatus, type AccountSnapshot } from './account-stub'

/**
 * True when a click/keydown on the identity row actually originated inside
 * one of its two nested `<button>`s (配置 Key / 登出) rather than on the row
 * itself or its avatar/nickname text. A plain `event.target !==
 * event.currentTarget` check would look equivalent but is stricter than
 * intended: clicking the nickname `<strong>` or the avatar `<span>` also
 * sets `target` to that child, not the row `<div>`, so it would silently
 * stop the row from opening 个人中心 on the exact area users are meant to
 * click there. Scoping the check to `closest('button')` blocks only the two
 * real buttons' bubbled events (mouse and keyboard alike) without that
 * side effect.
 */
function isNestedButtonEvent(event: { target: EventTarget | null }): boolean {
  return event.target instanceof Element && event.target.closest('button') !== null
}

/**
 * Sidebar-bottom account block. The account area has one canonical path for
 * every relay: register/login, then the active or low-balance identity row.
 * Manual-key entry is intentionally not rendered here; keeping one account
 * surface avoids a second credential flow being exposed from the shell.
 *
 * The identity wrapper remains a div so it can contain real button children;
 * a button cannot legally contain the logout/configure/recharge controls.
 * The wrapper therefore provides the same keyboard semantics with
 * role="button" and a guarded keydown handler.
 */
export function AccountArea({
  status,
  snapshot,
  onLogin,
  onLogout,
  onRecharge,
  onConfigureCliKey,
  onRefreshBalance,
  onOpenAccountCenter,
}: {
  status: AccountAreaStatus
  snapshot: AccountSnapshot
  onLogin: () => void
  onLogout: () => void
  onRecharge: () => void
  onConfigureCliKey: () => void
  /** 重新拉取余额(老板需求 2026-08-10:侧边栏一键看实时余额)。 */
  onRefreshBalance: () => void
  /** Identity row entry point into the 个人中心 overlay (W4a, App.tsx's 'account-center' appView). */
  onOpenAccountCenter: () => void
}) {
  if (status === 'guest') {
    return (
      <button
        type="button"
        className="account-area"
        data-sidebar-tooltip="登录"
        onClick={onLogin}
      >
        <span className="account-avatar" aria-hidden="true"><UserRound size={18} /></span>
        <span className="account-copy">
          <strong>登录</strong>
          <small>登录后就能用</small>
        </span>
      </button>
    )
  }

  const isLowBalance = status === 'low-balance'
  const balanceText = formatBalanceUsd(snapshot.quota, snapshot.quotaPerUnit)
  const identityTooltip = isLowBalance
    ? `${snapshot.nickname} · 余额告警 ${balanceText} · 点击进入个人中心`
    : `${snapshot.nickname} · 余额 ${balanceText} · 点击进入个人中心`
  const rechargeLabel = isLowBalance ? '立即充值 · 余额告警' : '充值'

  return (
    <>
      <div
        className="account-area"
        data-sidebar-tooltip={identityTooltip}
        title={identityTooltip}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          if (isNestedButtonEvent(event)) return
          onOpenAccountCenter()
        }}
        onKeyDown={(event) => {
          if (isNestedButtonEvent(event)) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onOpenAccountCenter()
        }}
      >
        <span className="account-avatar" aria-hidden="true"><UserRound size={18} /></span>
        <span className="account-copy">
          <strong>{snapshot.nickname}</strong>
        </span>
        <span className="account-actions" aria-label="账户快捷操作">
          <button
            type="button"
            className="account-configure-button"
            aria-label="配置星芒 Key 到已装 CLI"
            title="配置星芒 Key"
            onClick={(event) => { event.stopPropagation(); onConfigureCliKey() }}
          >
            <KeyRound size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="account-logout-button"
            aria-label="登出星芒账号"
            title="登出"
            onClick={(event) => { event.stopPropagation(); onLogout() }}
          >
            <LogOut size={14} aria-hidden="true" />
          </button>
        </span>
        <small className={isLowBalance ? 'account-balance account-balance-warning' : 'account-balance'}>
          <span className="account-balance-label">
            {isLowBalance && <AlertTriangle size={11} aria-hidden="true" />}
            余额
          </span>
          <strong
            className="account-balance-value"
            title={`完整余额：${balanceText}`}
            aria-label={`完整余额：${balanceText}`}
            data-full-balance={balanceText}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {balanceText}
          </strong>
          <button
            type="button"
            className="account-refresh-button"
            aria-label="刷新余额"
            title="刷新余额"
            onClick={(event) => { event.stopPropagation(); onRefreshBalance() }}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={isLowBalance ? 'account-recharge-button low-balance' : 'account-recharge-button'}
            title={rechargeLabel}
            onClick={(event) => { event.stopPropagation(); onRecharge() }}
          >
            充值
          </button>
        </small>
      </div>
    </>
  )
}
