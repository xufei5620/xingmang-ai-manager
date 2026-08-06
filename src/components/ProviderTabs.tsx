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

export function ProviderTabs({
  value,
  onChange,
  disabled = false,
  unavailable,
  label = '选择 AI 工具',
}: ProviderTabsProps) {
  return (
    <div className="segmented-control provider-tabs" role="tablist" aria-label={label}>
      {managementProviderIds.map((provider) => {
        const isUnavailable = unavailable?.has(provider) === true
        return (
          <button
            key={provider}
            type="button"
            role="tab"
            className={value === provider ? 'active' : ''}
            aria-selected={value === provider}
            disabled={disabled}
            title={isUnavailable ? `${managementProviderLabels[provider]} 当前不可用` : undefined}
            onClick={() => onChange(provider)}
          >
            <i className={`status-dot ${isUnavailable ? '' : 'configured'}`} aria-hidden="true" />
            {managementProviderLabels[provider]}
          </button>
        )
      })}
    </div>
  )
}
