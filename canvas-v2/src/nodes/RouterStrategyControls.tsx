import { canvasRouterStrategyPresentation, routerExecutionScopeNotice } from './router-strategy-presentation'
import type { CanvasRouterStrategy } from '../runtime/router-strategy'

export interface RouterStrategyControlsProps {
  settings?: Record<string, unknown>
  disabled?: boolean
  onChange(patch: Record<string, unknown>): void
}

export function RouterStrategyControls({ settings, disabled, onChange }: RouterStrategyControlsProps) {
  const presentation = canvasRouterStrategyPresentation(settings), blocked = disabled || presentation.state === 'invalid'
  function change(value: string) {
    if (blocked || value !== 'first-available' && value !== 'all') return
    const routerStrategy: CanvasRouterStrategy = { version: 1, strategy: value }
    // An explicit choice repairs an unrecognized historical field as well;
    // preserving it would keep the user's repaired node blocked on save.
    onChange({ routerStrategy, ...(presentation.repairLegacy ? { strategy: value } : {}) })
  }
  return <div className="wf-router-settings nodrag nowheel"><select className="wf-model" aria-label="路由策略" disabled={blocked} value={presentation.value} onChange={(event) => change(event.target.value)}>
    {presentation.state === 'legacy' && <option value="legacy-all" disabled>旧配置：保留全部输入（待明确选择）</option>}
    {presentation.state === 'invalid' && <option value="invalid" disabled>策略无法核对，原值保留</option>}
    <option value="first-available">每种媒体保留首个输入</option><option value="all">保留全部输入</option>
  </select><p className={presentation.state === 'invalid' ? 'wf-error is-validation' : 'wf-result-note'} role={presentation.state === 'invalid' ? 'alert' : undefined}>{presentation.description}</p><p className="wf-result-note">{routerExecutionScopeNotice}</p></div>
}
