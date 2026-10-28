import { useRef } from 'react'
import { defaultImageLayerColorDetail, parseImageLayerColorDetail, type ImageLayerColorDetail } from './layer-color-detail'
import './layer-color-detail-controls.css'

export interface LayerColorDetailControlsProps {
  value?: ImageLayerColorDetail
  disabled?: boolean
  onChange(value: ImageLayerColorDetail): void
}

function DetailField({ label, value, min = 0, max = 100, step = 1, disabled, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; disabled: boolean; onChange(value: number): void }) {
  function change(value: number) {
    if (!disabled && Number.isFinite(value)) onChange(Math.max(min, Math.min(max, Math.round(value / step) * step)))
  }
  return <label className="color-grade-field color-detail-field"><span>{label}</span><div><input type="range" aria-label={`${label}滑杆`} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => change(event.currentTarget.valueAsNumber)} /><input type="number" aria-label={label} min={min} max={max} step={step} value={Number(value.toFixed(4))} disabled={disabled} onChange={(event) => change(event.currentTarget.valueAsNumber)} /></div></label>
}

export function LayerColorDetailControls(props: LayerColorDetailControlsProps) {
  const latest = useRef(props); latest.current = props
  const value = props.value ?? defaultImageLayerColorDetail(), disabled = props.disabled === true
  function patch(update: (value: ImageLayerColorDetail) => void) {
    const current = latest.current
    if (current.disabled) return
    const next = current.value ? parseImageLayerColorDetail(current.value) : defaultImageLayerColorDetail()
    update(next); current.onChange(parseImageLayerColorDetail(next))
  }
  return <div className="color-detail-controls">
    <label className="color-grade-checkbox"><input type="checkbox" aria-label="启用细节与降噪" checked={value.enabled} disabled={disabled} onChange={(event) => { const enabled = event.currentTarget.checked; patch((next) => { next.enabled = enabled }) }} />启用细节与降噪</label>
    <p className="color-detail-note">本地像素处理。建议在 100% 视图查看纹理和噪点；适配预览可能缩小细节。</p>
    {!value.enabled && <p className="color-detail-dormant" role="status">效果已停用，当前参数仍会保存，可继续编辑后重新启用。</p>}
    <div className="color-detail-group" role="group" aria-label="锐化参数">
      <DetailField label="锐化数量" value={value.sharpening.amount} max={150} disabled={disabled} onChange={(amount) => patch((next) => { next.sharpening.amount = amount })} />
      <details><summary>锐化高级参数</summary>
        <DetailField label="锐化半径" value={value.sharpening.radius} min={.5} max={3} step={.1} disabled={disabled} onChange={(radius) => patch((next) => { next.sharpening.radius = radius })} />
        <DetailField label="锐化细节" value={value.sharpening.detail} disabled={disabled} onChange={(detail) => patch((next) => { next.sharpening.detail = detail })} />
        <DetailField label="锐化蒙版" value={value.sharpening.masking} disabled={disabled} onChange={(masking) => patch((next) => { next.sharpening.masking = masking })} />
      </details>
    </div>
    <div className="color-detail-group" role="group" aria-label="明亮度降噪参数">
      <DetailField label="明亮度降噪" value={value.luminance.amount} disabled={disabled} onChange={(amount) => patch((next) => { next.luminance.amount = amount })} />
      <details><summary>明亮度高级参数</summary>
        <DetailField label="明亮度细节" value={value.luminance.detail} disabled={disabled} onChange={(detail) => patch((next) => { next.luminance.detail = detail })} />
        <DetailField label="明亮度对比度" value={value.luminance.contrast} disabled={disabled} onChange={(contrast) => patch((next) => { next.luminance.contrast = contrast })} />
      </details>
    </div>
    <div className="color-detail-group" role="group" aria-label="颜色降噪参数">
      <DetailField label="颜色降噪" value={value.color.amount} disabled={disabled} onChange={(amount) => patch((next) => { next.color.amount = amount })} />
      <details><summary>颜色高级参数</summary>
        <DetailField label="颜色细节" value={value.color.detail} disabled={disabled} onChange={(detail) => patch((next) => { next.color.detail = detail })} />
        <DetailField label="颜色平滑度" value={value.color.smoothness} disabled={disabled} onChange={(smoothness) => patch((next) => { next.color.smoothness = smoothness })} />
      </details>
    </div>
    <small>数量为 0 时该组不改变像素；半径和细节参数仍保留。调整采用本地算法，不代表其他软件的相同数值会产生相同画面。</small>
  </div>
}
