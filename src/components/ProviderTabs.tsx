import { useRef } from 'react'
import type { ProviderId } from '../types'

export const managementProviderIds = ['codex', 'claude', 'gemini', 'grok'] as const satisfies readonly ProviderId[]

export const managementProviderLabels: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok',
}

export interface ProviderTabsProps {
  value: ProviderId
  onChange(provider: ProviderId): void
  disabled?: boolean
  unavailable?: ReadonlySet<ProviderId>
  label?: string
}

export function providerTabKeyboardTarget(
  key: string,
  current: ProviderId,
  unavailable: ReadonlySet<ProviderId> = new Set(),
  disabled = false,
): ProviderId | null {
  if (disabled) return null
  const available = managementProviderIds.filter((provider) => !unavailable.has(provider))
  if (!available.length) return null
  if (key === 'Home') return available[0]
  if (key === 'End') return available[available.length - 1]
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const currentIndex = available.indexOf(current)
  const offset = key === 'ArrowRight' ? 1 : -1
  const baseIndex = currentIndex < 0 ? (offset > 0 ? -1 : 0) : currentIndex
  return available[(baseIndex + offset + available.length) % available.length]
}

export function ProviderTabs({
  value,
  onChange,
  disabled = false,
  unavailable,
  label = '选择 AI 工具',
}: ProviderTabsProps) {
  const tabRefs = useRef<Partial<Record<ProviderId, HTMLButtonElement | null>>>({})
  const selectedTabStop = managementProviderIds.includes(value) && !unavailable?.has(value)
    ? value
    : managementProviderIds.find((provider) => !unavailable?.has(provider))

  return (
    <div className="segmented-control provider-tabs" role="tablist" aria-label={label}>
      {managementProviderIds.map((provider) => {
        const isUnavailable = unavailable?.has(provider) === true
        return (
          <button
            key={provider}
            type="button"
            role="tab"
            ref={(element) => { tabRefs.current[provider] = element }}
            className={value === provider ? 'active' : ''}
            aria-selected={value === provider}
            tabIndex={!disabled && selectedTabStop === provider ? 0 : -1}
            disabled={disabled || isUnavailable}
            title={isUnavailable ? `${managementProviderLabels[provider]} 当前不可用` : undefined}
            onClick={() => onChange(provider)}
            onKeyDown={(event) => {
              const target = providerTabKeyboardTarget(event.key, provider, unavailable, disabled)
              if (!target) return
              event.preventDefault()
              onChange(target)
              tabRefs.current[target]?.focus()
            }}
          >
            <i className={`status-dot ${isUnavailable ? '' : 'configured'}`} aria-hidden="true" />
            {managementProviderLabels[provider]}
          </button>
        )
      })}
    </div>
  )
}
