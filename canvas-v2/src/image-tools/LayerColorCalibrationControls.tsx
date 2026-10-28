import { useRef } from 'react'
import { defaultImageLayerColorCalibration, parseImageLayerColorCalibration, type ImageLayerColorCalibration } from './layer-color-calibration'
import './layer-color-calibration-controls.css'

export interface LayerColorCalibrationControlsProps {
  value?: ImageLayerColorCalibration
  disabled?: boolean
  onChange(value: ImageLayerColorCalibration): void
}

function CalibrationField({ label, name = label, value, disabled, onChange }: { label: string; name?: string; value: number; disabled: boolean; onChange(value: number): void }) {
  function change(next: number) { if (!disabled && Number.isFinite(next)) onChange(Math.max(-100, Math.min(100, Math.round(next)))) }
  return <label className="color-grade-field color-calibration-field"><span>{label}</span><div><input type="range" aria-label={`${name}滑杆`} min={-100} max={100} step={1} value={value} disabled={disabled} onChange={(event) => change(event.currentTarget.valueAsNumber)} /><input type="number" aria-label={name} min={-100} max={100} step={1} value={value} disabled={disabled} onChange={(event) => change(event.currentTarget.valueAsNumber)} /></div></label>
}

export function LayerColorCalibrationControls(props: LayerColorCalibrationControlsProps) {
  const latest = useRef(props); latest.current = props
  const value = props.value ?? defaultImageLayerColorCalibration(), disabled = props.disabled === true
  function patch(update: Partial<Omit<ImageLayerColorCalibration, 'version'>>) {
    const current = latest.current
    if (current.disabled) return
    const previous = current.value ? parseImageLayerColorCalibration(current.value) : defaultImageLayerColorCalibration()
    current.onChange(parseImageLayerColorCalibration({ ...previous, ...update }))
  }
  return <div className="color-calibration-controls" aria-label="阴影色调与 RGB 原色校准">
    <label className="color-grade-checkbox"><input type="checkbox" aria-label="启用校准" checked={value.enabled} disabled={disabled} onChange={(event) => patch({ enabled: event.currentTarget.checked })} />启用校准</label>
    {!value.enabled && <p className="color-calibration-note is-dormant">校准已停用，当前参数仍会保存；重新启用后继续使用。</p>}
    <CalibrationField label="阴影色调" value={value.shadowTint} disabled={disabled} onChange={(shadowTint) => patch({ shadowTint })} />
    {([['红原色', 'redHue', 'redSaturation'], ['绿原色', 'greenHue', 'greenSaturation'], ['蓝原色', 'blueHue', 'blueSaturation']] as const).map(([label, hue, saturation]) => <fieldset className="color-calibration-primary" key={hue}><legend>{label}</legend><CalibrationField label="色相" name={`${label}色相`} value={value[hue]} disabled={disabled} onChange={(next) => patch({ [hue]: next })} /><CalibrationField label="饱和度" name={`${label}饱和度`} value={value[saturation]} disabled={disabled} onChange={(next) => patch({ [saturation]: next })} /></fieldset>)}
    <p className="color-calibration-note">阴影与原色参数在本地处理。不同软件的校准算法可能不同；完整开关与参数请保存 JSON 预设。</p>
  </div>
}
