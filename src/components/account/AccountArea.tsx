import { AlertTriangle, KeyRound, LogOut, RefreshCw, UserRound } from 'lucide-react'
import { formatBalanceUsd, shouldShowManualKeyEntry, type AccountAreaStatus, type AccountSnapshot } from './account-stub'
import type { RelaySite } from '../../types'

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
 * docs/ACCOUNT-PLAN.md) plus a compact recharge button in the balance row.
 * The identity wrapper remains a div so all shortcut controls stay valid.
 * buttons nest fine: unlike the guest state, the identity wrapper here is a
 * plain `<div>`, not a `<button>` -- kept that way even now that it is
 * clickable (W4a) specifically so it can still contain real `<button>`
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
 * there first. The refresh button sits left of 充值 so it stays visible
 * with the amount, while the configure
 * button re-triggers the same
 * offerCliProvisioning gate the 下一步 task card's "一键配置" action uses
 * (App.tsx's handleConfigureCliKey) -- this is the "关了还能再来" entry point
 * for a user who dismissed the write-Key confirm dialog. Collapsed-sidebar
 * handling (avatar + tooltip only) is generic CSS already covering
 * `.account-area`/`.account-recharge-button`/`.account-logout-button`/
 * `.account-refresh-button`/`.account-configure-button`/
 * `[data-sidebar-tooltip]` — see styles.css.
 *
 * W3b adds a fourth, site-driven branch ahead of all three above:
 * shouldShowManualKeyEntry(relaySite.accountBackend) short-circuits to a
 * "粘贴 Key" entry point for a manual-key site (sub2api today), regardless
 * of `status`/`snapshot`. This deliberately does not log the user out of
 * whatever new-api session they may still be holding from the solov site --
 * App.tsx never calls account:logout on a site switch (least surprise: the
 * identity/balance UI reappears unchanged the moment the user switches back).
 */
export function AccountArea({
  status,
  snapshot,
  relaySite,
  onLogin,
  onLogout,
  onRecharge,
  onConfigureCliKey,
  onRefreshBalance,
  onOpenAccountCenter,
  onPasteKey,
  onOpenKeysPage,
}: {
  status: AccountAreaStatus
  snapshot: AccountSnapshot
  relaySite: RelaySite
  onLogin: () => void
  onLogout: () => void
  onRecharge: () => void
  onConfigureCliKey: () => void
  /** 重新拉取余额(老板需求 2026-08-10:侧边栏一键看实时余额)。 */
  onRefreshBalance: () => void
  /** Identity row entry point into the 个人中心 overlay (W4a, App.tsx's 'account-center' appView). */
  onOpenAccountCenter: () => void
  /** Opens the 粘贴 Key dialog (W3b) -- only reachable on a manual-key site. */
  onPasteKey: () => void
  /** openExternal(relaySite.keysPageUrl) -- already I12 allowlisted (relaySiteExternalUrls). */
  onOpenKeysPage: () => void
}) {
  if (shouldShowManualKeyEntry(relaySite.accountBackend)) {
    return (
      <>
        <button
          type="button"
          className="account-area"
          data-sidebar-tooltip="粘贴 Key"
          onClick={onPasteKey}
        >
          <span className="account-avatar" aria-hidden="true"><KeyRound size={18} /></span>
          <span className="account-copy">
            <strong>粘贴 Key</strong>
            <small>{relaySite.label} 不提供账号登录，点击粘贴 Key</small>
          </span>
        </button>
        <p className="account-manual-key-hint">
          还没有 Key？
          <button type="button" className="inline-link" onClick={onOpenKeysPage}>去获取 Key</button>
        </p>
      </>
    )
  }

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
          <strong className="account-balance-value">{balanceText}</strong>
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
