export type ThemeCardValue = 'system' | 'light' | 'dark'

const themeCardLabels: Record<ThemeCardValue, string> = { system: '跟随系统', light: '浅色', dark: '深色' }

/**
 * 设置 › 外观显示的主题：每种一张小预览卡，点哪张用哪张。预览只画个大概（侧栏、两条字），
 * 颜色写死成两套配色的底色，不跟着当前主题变，否则「浅色」那张在深色下也是黑的。
 */
export function ThemeCards({
  options,
  value,
  onChange,
  testId,
}: {
  options: ReadonlyArray<{ value: ThemeCardValue; disabled?: boolean }>
  value: string
  onChange: (value: ThemeCardValue) => void
  testId?: string
}) {
  return (
    <div className="v2-theme-cards" role="group" aria-label="主题" data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="v2-theme-card"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          <span className={`v2-theme-card-preview is-${option.value}`} aria-hidden="true"><i /><b /><b /></span>
          <span className="v2-theme-card-label"><span className="v2-theme-card-radio" aria-hidden="true" />{themeCardLabels[option.value]}</span>
        </button>
      ))}
    </div>
  )
}
