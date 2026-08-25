import { RefreshCw } from 'lucide-react'
import type { OfficialChatGptAccount } from '../../types'
import {
  formatOfficialDateTime,
  formatOfficialResetLabel,
  shortOfficialWindowLabel,
} from '../../official-chatgpt-display'

export function OfficialChatGptMeter({
  planLabel,
  renewsAt,
  usage,
  refreshing = false,
  onRefresh,
}: {
  planLabel?: string | null
  renewsAt?: string | null
  usage?: OfficialChatGptAccount | null
  refreshing?: boolean
  onRefresh?: () => void
}) {
  const plan = usage?.planLabel ?? planLabel ?? null
  const renews = usage?.renewsAt ?? renewsAt ?? null
  const resetCredits = usage?.resetCredits ?? null
  const windows = usage?.windows ?? []
  if (!plan && !renews && resetCredits === null && windows.length === 0 && !onRefresh) return null

  return (
    <div className="official-chatgpt-meter">
      <div className="official-chatgpt-badges">
        {plan ? <span className="official-chatgpt-badge plan">套餐 {plan}</span> : null}
        {renews ? (
          <span className="official-chatgpt-badge" title={formatOfficialDateTime(renews) ?? undefined}>
            续期 {formatOfficialResetLabel(renews) ?? ''}
          </span>
        ) : null}
        {resetCredits !== null ? (
          <span className="official-chatgpt-badge">重置 {resetCredits}</span>
        ) : null}
        {onRefresh ? (
          <button
            type="button"
            className="official-chatgpt-refresh"
            onClick={onRefresh}
            disabled={refreshing}
            title="刷新 ChatGPT 额度"
            aria-label="刷新额度"
          >
            <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
            {refreshing ? '刷新中' : '刷新额度'}
          </button>
        ) : null}
      </div>
      {windows.length > 0 ? (
        <div className="official-chatgpt-windows">
          {windows.map((window) => {
            const shortLabel = shortOfficialWindowLabel(window.label)
            const reset = formatOfficialResetLabel(window.resetAt)
            const detail = [
              window.label,
              `${window.remainingPercent}%`,
              formatOfficialDateTime(window.resetAt),
            ].filter(Boolean).join(' · ')
            const tone = window.remainingPercent < 10
              ? 'low'
              : window.remainingPercent < 30
                ? 'caution'
                : ''
            return (
              <div className="official-chatgpt-window" key={window.id} title={detail}>
                <span className="official-chatgpt-window-name">{shortLabel}</span>
                <div className={tone ? `official-chatgpt-bar ${tone}` : 'official-chatgpt-bar'} aria-hidden="true">
                  <i style={{ width: `${window.remainingPercent}%` }} />
                </div>
                <strong>{window.remainingPercent}%</strong>
                {reset ? <span className="official-chatgpt-window-reset">{reset}</span> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
