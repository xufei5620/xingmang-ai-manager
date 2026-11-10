import type { CanvasAccountSummary } from '../host'

// 画布顶上的余额条（桌面仓画布完善第 2b 条）。宿主给什么就显示什么，内核只做两件事：
// 把宿主的回答收窄成能上屏的样子，写法跟桌面主窗口一样（$12.40，读不到写「—」）。

const siteLabelLimit = 16
const accountLabelLimit = 40
const subscriptionLabelLimit = 60
// A balance outside this range is a broken answer, not money anyone has.
const balanceLimitUsd = 1_000_000_000

/** Clicking again within this time reuses the answer that is on screen. */
export const accountSummaryClickIntervalMs = 3_000
/** Coming back to the canvas window asks again at most this often. */
export const accountSummaryFocusIntervalMs = 60_000

export type CanvasAccountSummaryView =
  | { state: 'loading' }
  | { state: 'failed' }
  /** refreshFailed: the last read failed, so the balance on screen is the one read before. */
  | { state: 'ready'; summary: CanvasAccountSummary; refreshFailed?: boolean }

/** view null: nobody is signed in, the chip is not shown. */
export interface CanvasAccountSummaryState {
  view: CanvasAccountSummaryView | null
  refreshing: boolean
}

// Control, zero-width and bidirectional characters can make a label read as
// something it is not; the host already masked the name, this only tidies it.
const hiddenCharacters = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

function boundedText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const characters = [...value.replace(hiddenCharacters, '').replace(/\s+/g, ' ').trim()]
  if (!characters.length) return null
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('')
}

/**
 * Reads the host's answer. Null means nobody is signed in; anything that is not
 * the documented shape throws, and the chip then says it could not read the balance.
 */
export function parseCanvasAccountSummary(value: unknown): CanvasAccountSummary | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号信息格式不对')
  const record = value as Record<string, unknown>
  const siteLabel = boundedText(record.siteLabel, siteLabelLimit)
  if (!siteLabel) throw new Error('账号信息格式不对')
  if (record.accountLabel !== null && typeof record.accountLabel !== 'string') throw new Error('账号信息格式不对')
  const balance = record.balanceUsd
  if (balance !== null && (typeof balance !== 'number' || !Number.isFinite(balance) || Math.abs(balance) > balanceLimitUsd)) throw new Error('账号信息格式不对')
  const readAt = record.readAt
  if (readAt !== null && (typeof readAt !== 'string' || !Number.isFinite(Date.parse(readAt)))) throw new Error('账号信息格式不对')
  if (record.subscriptionLabel !== undefined && record.subscriptionLabel !== null && typeof record.subscriptionLabel !== 'string') throw new Error('账号信息格式不对')
  return {
    siteLabel,
    accountLabel: boundedText(record.accountLabel, accountLabelLimit),
    balanceUsd: balance,
    subscriptionLabel: boundedText(record.subscriptionLabel, subscriptionLabelLimit),
    readAt: readAt === null ? null : new Date(readAt).toISOString(),
  }
}

/** Same writing as the desktop main window: thousands separators, two decimals, a dash when unknown. */
export function accountBalanceText(balanceUsd: number | null | undefined): string {
  return typeof balanceUsd === 'number' && Number.isFinite(balanceUsd)
    ? `$${balanceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
}

function readAgo(readAt: string | null, now: number): string | null {
  if (!readAt) return null
  const seconds = Math.max(0, Math.round((now - Date.parse(readAt)) / 1000))
  if (seconds < 60) return '刚刚读的'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前读的`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前读的`
  return '一天多以前读的'
}

function accountName(summary: CanvasAccountSummary): string {
  return summary.accountLabel ? `${summary.siteLabel} · ${summary.accountLabel}` : summary.siteLabel
}

/** The hover text: which account, the balance and how fresh it is, and what a click does. */
export function accountSummaryTitle(view: CanvasAccountSummaryView, now: number): string {
  if (view.state === 'loading') return '正在读余额'
  if (view.state === 'failed') return '余额暂时没有读到，点一下再试'
  const { summary } = view
  const ago = readAgo(summary.readAt, now)
  const balance = summary.balanceUsd === null
    ? '余额还没读到'
    : `余额 ${accountBalanceText(summary.balanceUsd)}${ago ? `（${ago}）` : ''}`
  const failed = view.refreshFailed ? '刚才重新读没读到，显示的是上次读到的' : null
  return [accountName(summary), balance, failed, summary.subscriptionLabel, '画布出图用的就是这个账号的额度，点一下重新读余额'].filter(Boolean).join('\n')
}

/** What a screen reader hears. */
export function accountSummaryAriaLabel(view: CanvasAccountSummaryView): string {
  if (view.state === 'loading') return '余额：正在读'
  if (view.state === 'failed') return '余额暂时没有读到，点一下再试'
  return `余额 ${accountBalanceText(view.summary.balanceUsd)}，${accountName(view.summary)}，点一下重新读`
}

/** Whether an automatic or clicked refresh should ask the host again. */
export function accountSummaryRefreshDue(lastAskedAt: number | null, now: number, intervalMs: number): boolean {
  return lastAskedAt === null || now - lastAskedAt >= intervalMs || now < lastAskedAt
}

export interface CanvasAccountSummaryController {
  /** Asks the host unless it was asked within intervalMs; 0 always asks, after any read already under way. */
  refresh(intervalMs: number): Promise<void>
  state(): CanvasAccountSummaryState
  dispose(): void
}

/**
 * Keeps one read at a time and drops answers that arrive after the canvas
 * workspace went away (it is rebuilt when the account changes, so a late
 * answer would show the previous account).
 */
export function createAccountSummaryController(options: {
  read: () => Promise<unknown>
  onChange: (state: CanvasAccountSummaryState) => void
  now?: () => number
}): CanvasAccountSummaryController {
  const now = options.now ?? Date.now
  let state: CanvasAccountSummaryState = { view: { state: 'loading' }, refreshing: false }
  let lastAskedAt: number | null = null
  let pending: Promise<void> | null = null
  let askAgain = false
  let disposed = false

  function publish(next: CanvasAccountSummaryState) {
    state = next
    if (!disposed) options.onChange(state)
  }

  async function read(): Promise<void> {
    let view: CanvasAccountSummaryView | null
    try {
      const summary = parseCanvasAccountSummary(await options.read())
      view = summary ? { state: 'ready', summary } : null
    } catch {
      view = state.view?.state === 'ready' ? { ...state.view, refreshFailed: true } : { state: 'failed' }
    }
    pending = null
    if (disposed) return
    publish({ view, refreshing: false })
    if (askAgain) {
      askAgain = false
      await refresh(0)
    }
  }

  function refresh(intervalMs: number): Promise<void> {
    if (disposed) return Promise.resolve()
    if (pending) {
      // A run that just ended must see a balance read after it ended.
      if (intervalMs === 0) askAgain = true
      return pending
    }
    const at = now()
    if (!accountSummaryRefreshDue(lastAskedAt, at, intervalMs)) return Promise.resolve()
    lastAskedAt = at
    publish({ ...state, refreshing: true })
    pending = read()
    return pending
  }

  return {
    refresh,
    state: () => state,
    dispose() { disposed = true },
  }
}
