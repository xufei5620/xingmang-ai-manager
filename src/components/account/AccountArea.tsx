import { AlertTriangle, KeyRound, LogOut, UserRound, Wallet } from 'lucide-react'
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
 * Sidebar-bottom account block. Three states driven by `status`/`snapshot`
 * (see account-stub.ts) — guest is the pre-existing W1 button, unchanged;
 * active/low-balance render an identity row (now with a small "配置星芒 Key"
 * button alongside the logout icon in its corner -- W2/W2.5,
 * docs/ACCOUNT-PLAN.md) plus a separate recharge row so the recharge control
 * is a real `<button>` and never nested inside another button. Both corner
 * buttons nest fine: unlike the guest state, the identity wrapper here is a
 * plain `<div>`, not a `<button>` -- kept that way even now that it is
 * clickable (W4a) specifically so it can still contain two real `<button>`
 * children; a `<button>` cannot nest `<button>`s (the DOM would silently
 * hoist them out, breaking layout), so this div gets manual role="button" +
 * tabIndex + keydown handling instead. Both nested buttons still
 * stopPropagation their own onClick (harmless now, kept as belt-and-
 * suspenders), but the actual guard is isNestedButtonEvent() above, applied
 * to both onClick and onKeyDown -- stopPropagation alone never covered
 * keydown (the buttons have no keydown handler of their own), so
 * Tab-focusing either button and pressing Enter/Space used to bubble up and
 * fire onOpenAccountCenter instead of the button's own action. The row-wide
 * "cursor:pointer already applied to .account-area for both states" hover
 * affordance existed before W4a; W2.5's onConfigureCliKey button just got
 * there first. The configure button re-triggers the same
 * offerCliProvisioning gate the 下一步 task card's "一键配置" action uses
 * (App.tsx's handleConfigureCliKey) -- this is the "关了还能再来" entry point
 * for a user who dismissed the write-Key confirm dialog. Collapsed-sidebar
 * handling (avatar + tooltip only) is generic CSS already covering
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
  onOpenAccountCenter,
}: {
  status: AccountAreaStatus
  snapshot: AccountSnapshot
  onLogin: () => void
  onLogout: () => void
  onRecharge: () => void
  onConfigureCliKey: () => void
  /** Identity row entry point into the 个人中心 overlay (W4a, App.tsx's 'account-center' appView). */
  onOpenAccountCenter: () => void
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
