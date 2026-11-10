import { Wallet } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { hostBridge } from '../host'
import {
  accountBalanceText,
  accountSummaryAriaLabel,
  accountSummaryClickIntervalMs,
  accountSummaryFocusIntervalMs,
  accountSummaryTitle,
  createAccountSummaryController,
  type CanvasAccountSummaryController,
  type CanvasAccountSummaryState,
} from '../runtime/account-summary'

/**
 * The balance chip's state; only mounted where the host offers
 * getAccountSummary. Asks the host when the workspace opens (it is rebuilt on
 * every account switch), whenever refreshSignal changes (a run ended), when the
 * window comes back into focus at most once a minute, and on click. It starts
 * no timer of its own: the host decides how often it really asks its server.
 */
export function useCanvasAccountSummary(refreshSignal: number) {
  const [state, setState] = useState<CanvasAccountSummaryState>({ view: { state: 'loading' }, refreshing: false })
  // The clock the hover text's "N 分钟前读的" counts from: taken when an answer
  // arrives and again when the pointer or focus reaches the chip, never in render.
  const [now, setNow] = useState(0)
  const controllerRef = useRef<CanvasAccountSummaryController | null>(null)
  useEffect(() => {
    const bridge = hostBridge()
    const controller = createAccountSummaryController({
      read: () => bridge.getAccountSummary ? bridge.getAccountSummary() : Promise.resolve(null),
      onChange: (next) => { setState(next); setNow(Date.now()) },
    })
    controllerRef.current = controller
    void controller.refresh(0)
    function onFocus() { void controller.refresh(accountSummaryFocusIntervalMs) }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])
  useEffect(() => {
    if (refreshSignal > 0) void controllerRef.current?.refresh(0)
  }, [refreshSignal])
  return {
    state,
    now,
    touch: () => setNow(Date.now()),
    refresh: () => { void controllerRef.current?.refresh(accountSummaryClickIntervalMs) },
  }
}

export function AccountBalanceChipView({ state, now, onRefresh, onTouch }: { state: CanvasAccountSummaryState; now: number; onRefresh: () => void; onTouch?: () => void }) {
  const { view, refreshing } = state
  if (!view) return null
  const summary = view.state === 'ready' ? view.summary : null
  const unread = view.state === 'failed' || view.state === 'ready' && (view.refreshFailed || view.summary.balanceUsd === null)
  return (
    <button
      type="button"
      className={`canvas-icon-command canvas-account-balance${unread ? ' is-unread' : ''}`}
      title={accountSummaryTitle(view, now)}
      aria-label={accountSummaryAriaLabel(view)}
      aria-busy={refreshing || undefined}
      data-testid="canvas-account-balance"
      onClick={onRefresh}
      onPointerEnter={onTouch}
      onFocus={onTouch}
    >
      <Wallet size={15} aria-hidden="true" />
      {summary && <span className="canvas-account-balance-site">{summary.siteLabel}</span>}
      {summary?.accountLabel && <span className="canvas-account-balance-name">{summary.accountLabel}</span>}
      <strong>{accountBalanceText(summary?.balanceUsd)}</strong>
    </button>
  )
}

export function AccountBalanceChip({ refreshSignal }: { refreshSignal: number }) {
  const { state, now, touch, refresh } = useCanvasAccountSummary(refreshSignal)
  return <AccountBalanceChipView state={state} now={now} onRefresh={refresh} onTouch={touch} />
}
