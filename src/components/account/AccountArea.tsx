import { AlertTriangle, LogOut, UserRound, Wallet } from 'lucide-react'
import { formatBalanceUsd, type AccountAreaStatus, type AccountSnapshot } from './account-stub'

/**
 * Sidebar-bottom account block. Three states driven by `status`/`snapshot`
 * (see account-stub.ts) — guest is the pre-existing W1 button, unchanged;
 * active/low-balance render an identity row (now with a small logout icon
 * button in its corner -- W2, docs/ACCOUNT-PLAN.md) plus a separate recharge
 * row so the recharge control is a real `<button>` and never nested inside
 * another button. The logout button nests fine: unlike the guest state, the
 * identity wrapper here is a plain `<div>`, not a `<button>`. A full account
 * menu (profile/billing/etc.) is W4's job; this is deliberately just enough
 * to get back to signed-out. Collapsed-sidebar handling (avatar + tooltip
 * only) is generic CSS already covering
 * `.account-area`/`.account-recharge-button`/`.account-logout-button`/
 * `[data-sidebar-tooltip]` — see styles.css.
 */
export function AccountArea({
  status,
  snapshot,
  onLogin,
  onLogout,
  onRecharge,
}: {
  status: AccountAreaStatus
  snapshot: AccountSnapshot
  onLogin: () => void
  onLogout: () => void
  onRecharge: () => void
}) {
  if (status === 'guest') {
    return (
      <button
        type="button"
        className="account-area"
        data-sidebar-tooltip="登录 / 注册"
        onClick={onLogin}
      >
        <span className="account-avatar" aria-hidden="true"><UserRound size={18} /></span>
        <span className="account-copy">
          <strong>登录 / 注册</strong>
          <small>登录后查看余额与充值</small>
        </span>
      </button>
    )
  }

  const isLowBalance = status === 'low-balance'
  const balanceText = formatBalanceUsd(snapshot.quota, snapshot.quotaPerUnit)
  const identityTooltip = isLowBalance
    ? `${snapshot.nickname} · 余额告警 ${balanceText}`
    : `${snapshot.nickname} · 余额 ${balanceText}`
  const rechargeLabel = isLowBalance ? '立即充值 · 余额告警' : '充值'

  return (
    <>
      <div className="account-area" data-sidebar-tooltip={identityTooltip} title={identityTooltip}>
        <span className="account-avatar" aria-hidden="true"><UserRound size={18} /></span>
        <span className="account-copy">
          <strong>{snapshot.nickname}</strong>
          <small className={isLowBalance ? 'account-balance account-balance-warning' : 'account-balance'}>
            {isLowBalance && <AlertTriangle size={11} aria-hidden="true" />}
            余额 {balanceText}
          </small>
        </span>
        <button
          type="button"
          className="account-logout-button"
          aria-label="登出星芒账号"
          title="登出"
          onClick={onLogout}
        >
          <LogOut size={14} aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        className={isLowBalance ? 'account-recharge-button low-balance' : 'account-recharge-button'}
        data-sidebar-tooltip={rechargeLabel}
        title={rechargeLabel}
        onClick={onRecharge}
      >
        <span className="account-recharge-icon" aria-hidden="true"><Wallet size={16} /></span>
        <span>{rechargeLabel}</span>
      </button>
    </>
  )
}
