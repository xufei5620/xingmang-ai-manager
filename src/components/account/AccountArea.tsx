import { AlertTriangle, KeyRound, LogOut, UserRound, Wallet } from 'lucide-react'
import { formatBalanceUsd, type AccountAreaStatus, type AccountSnapshot } from './account-stub'

/**
 * Sidebar-bottom account block. Three states driven by `status`/`snapshot`
 * (see account-stub.ts) — guest is the pre-existing W1 button, unchanged;
 * active/low-balance render an identity row (now with a small "配置星芒 Key"
 * button alongside the logout icon in its corner -- W2/W2.5,
 * docs/ACCOUNT-PLAN.md) plus a separate recharge row so the recharge control
 * is a real `<button>` and never nested inside another button. Both corner
 * buttons nest fine: unlike the guest state, the identity wrapper here is a
 * plain `<div>`, not a `<button>`. The configure button just re-triggers the
 * same offerCliProvisioning gate the 下一步 task card's "一键配置" action uses
 * (App.tsx's handleConfigureCliKey) -- this is the "关了还能再来" entry point
 * for a user who dismissed the write-Key confirm dialog. A full account menu
 * (profile/billing/etc.) is W4's job; this is deliberately just enough.
 * Collapsed-sidebar handling (avatar + tooltip only) is generic CSS already
 * covering
 * `.account-area`/`.account-recharge-button`/`.account-logout-button`/
 * `.account-configure-button`/`[data-sidebar-tooltip]` — see styles.css.
 */
export function AccountArea({
  status,
  snapshot,
  onLogin,
  onLogout,
  onRecharge,
  onConfigureCliKey,
}: {
  status: AccountAreaStatus
  snapshot: AccountSnapshot
  onLogin: () => void
  onLogout: () => void
  onRecharge: () => void
  onConfigureCliKey: () => void
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
          className="account-configure-button"
          aria-label="配置星芒 Key 到已装 CLI"
          title="配置星芒 Key"
          onClick={onConfigureCliKey}
        >
          <KeyRound size={14} aria-hidden="true" />
        </button>
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
