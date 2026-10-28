import { useRef } from 'react'
import { defaultImageLayerColorPresence, parseImageLayerColorPresence, type ImageLayerColorPresence } from './layer-color-presence'
import './layer-color-presence-controls.css'

export interface LayerColorPresenceControlsProps {
  value?: ImageLayerColorPresence
  disabled?: boolean
  onChange(value: ImageLayerColorPresence): void
}

function PresenceField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange(value: number): void }) {
  function change(next: number) { if (!disabled && Number.isFinite(next)) onChange(Math.max(-100, Math.min(100, Math.round(next)))) }
  return <label className="color-grade-field color-presence-field"><span>{label}</span><div><input type="range" aria-label={`${label}滑杆`} min={-100} max={100} step={1} value={value} disabled={disabled} onChange={(event) => change(event.currentTarget.valueAsNumber)} /><input type="number" aria-label={label} min={-100} max={100} step={1} value={value} disabled={disabled} onChange={(event) => change(event.currentTarget.valueAsNumber)} /></div></label>
}

export function LayerColorPresenceControls(props: LayerColorPresenceControlsProps) {
  const latest = useRef(props); latest.current = props
  const value = props.value ?? defaultImageLayerColorPresence(), disabled = props.disabled === true
  function patch(update: Partial<Omit<ImageLayerColorPresence, 'version'>>) {
    const current = latest.current
    if (current.disabled) return
    const next = current.value ? parseImageLayerColorPresence(current.value) : defaultImageLayerColorPresence()
    current.onChange(parseImageLayerColorPresence({ ...next, ...update }))
  }
  return <div className="color-presence-controls" aria-label="纹理、清晰度与去除薄雾">
    <label className="color-grade-checkbox"><input type="checkbox" aria-label="启用质感与去雾" checked={value.enabled} disabled={disabled} onChange={(event) => patch({ enabled: event.currentTarget.checked })} />启用质感与去雾</label>
    {!value.enabled && <p className="color-presence-note is-dormant">效果已停用，当前参数仍会保存；重新启用后继续使用。</p>}
    {([['texture', '纹理'], ['clarity', '清晰度'], ['dehaze', '去除薄雾']] as const).map(([key, label]) => <PresenceField key={key} label={label} value={value[key]} disabled={disabled} onChange={(next) => patch({ [key]: next })} />)}
    <p className="color-presence-note">本地像素处理。建议在 100% 视图查看细节，适配预览可能缩小效果。</p>
  </div>
}
