import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ImageLayerTextContent, ImageLayerTextWeight, ImageLayerTextWarpStyle } from './recipe'
import { defaultImageLayerTypography, imageLayerTextWarpStyles } from './layer-text-layout'
import { localTextFontAccessSupported, prepareLocalTextFont, requestLocalTextFontFamilies } from './local-text-fonts'
import { parseLayerTextNumberDraft, patchLayerTextTypography, resetLayerTextTypography, setLayerTextGenericFont, setLayerTextWarp, setLayerTextWeight } from './layer-text-controls'

export function LayerTextNumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void }) {
  const id = useId(), [draft, setDraft] = useState(String(value)), [error, setError] = useState('')
  const skipBlur = useRef(false)
  useEffect(() => { setDraft(String(value)); setError('') }, [value])
  function commit() {
    if (skipBlur.current) { skipBlur.current = false; return }
    const parsed = parseLayerTextNumberDraft(draft, min, max, step)
    if (parsed === null) { setError(`请输入 ${min}–${max} 之间的数值，原值未修改`); return }
    setDraft(String(parsed)); setError(''); if (parsed !== value) onChange(parsed)
  }
  return <label className="layer-text-number">{label}<input id={id} type="number" aria-label={label} value={draft} min={min} max={max} step={step} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => { skipBlur.current = false; setDraft(event.target.value); setError('') }} onBlur={commit} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(); skipBlur.current = true; event.currentTarget.blur() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipBlur.current = true; setDraft(String(value)); setError(''); event.currentTarget.blur() }
  }} />{error && <small id={`${id}-error`} role="alert">{error}</small>}</label>
}

export function LayerTextControls({ content, disabled, colorField, onChange, onBegin, onFinish, onFontReady }: { content: ImageLayerTextContent; disabled?: boolean; colorField: ReactNode; onChange(content: ImageLayerTextContent): void; onBegin(): void; onFinish(cancel?: boolean): void; onFontReady?(): void }) {
  const [families, setFamilies] = useState<readonly string[]>([]), [loading, setLoading] = useState(false), [fontError, setFontError] = useState('')
  const current = useRef({ content, disabled, onChange }), alive = useRef(true), request = useRef(0), dragging = useRef(false)
  current.current = { content, disabled, onChange }
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++ } }, [])
  const typography = content.typography ?? defaultImageLayerTypography()
  const weight = typography.fontWeight ?? content.fontWeight
  const familyValue = typography.fontFamily ? `local:${typography.fontFamily}` : content.fontFamily
  const availableFamilies = typography.fontFamily && !families.includes(typography.fontFamily) ? [typography.fontFamily, ...families] : families
  async function loadFonts() {
    const id = ++request.current, original = current.current.content
    setLoading(true); setFontError('')
    try {
      const values = await requestLocalTextFontFamilies()
      if (alive.current && request.current === id) {
        setFamilies(values)
        const family = original.typography?.fontFamily
        if (family && values.includes(family)) {
          await prepareLocalTextFont(family, original.typography?.fontWeight ?? original.fontWeight)
        }
      }
    } catch (cause) { if (alive.current && request.current === id) setFontError(cause instanceof Error ? cause.message : '无法读取本机字体，请使用通用字体') }
    finally { if (alive.current && request.current === id) { setLoading(false); onFontReady?.() } }
  }
  async function selectFont(value: string) {
    const id = ++request.current, original = current.current.content
    if (current.current.disabled) return
    setFontError('')
    if (value === 'sans-serif' || value === 'serif' || value === 'monospace') {
      setLoading(false); current.current.onChange(setLayerTextGenericFont(original, value)); return
    }
    const family = value.slice(6)
    if (!value.startsWith('local:') || !families.includes(family)) { setFontError('请先加载并选择已授权的本机字体'); return }
    setLoading(true)
    try {
      await prepareLocalTextFont(family, original.typography?.fontWeight ?? original.fontWeight)
      if (alive.current && request.current === id && current.current.content === original && !current.current.disabled) { current.current.onChange(patchLayerTextTypography(original, { fontFamily: family, fontSource: 'local' })); onFontReady?.() }
    } catch (cause) { if (alive.current && request.current === id) setFontError(cause instanceof Error ? cause.message : '字体不可用，已保留原字体') }
    finally { if (alive.current && request.current === id) setLoading(false) }
  }
  function beginBend() { if (!dragging.current) { dragging.current = true; onBegin() } }
  function finishBend(cancel = false) { if (dragging.current) { dragging.current = false; onFinish(cancel) } }
  return <fieldset className="layer-text-controls" disabled={!!disabled}><legend>文字排版</legend>
    <label>内容<textarea aria-label="图层文字内容" maxLength={2000} rows={4} value={content.text} onFocus={onBegin} onBlur={() => onFinish()} onChange={(event) => onChange({ ...current.current.content, text: event.target.value })} /></label>
    <div className="layer-editor-fields">
      <LayerTextNumberField label="文字字号（像素）" value={content.fontSize} min={1} max={512} onChange={(fontSize) => onChange({ ...current.current.content, fontSize })} />
      <label>字重<select aria-label="图层字重" value={weight} onChange={(event) => onChange(setLayerTextWeight(current.current.content, Number(event.target.value) as ImageLayerTextWeight))}>{[100, 200, 300, 400, 500, 600, 700, 800, 900].map((value) => <option key={value} value={value}>{value}{value === 400 ? ' 常规' : value === 700 ? ' 粗体' : ''}</option>)}</select></label>
      <LayerTextNumberField label="字距（像素）" value={typography.letterSpacing} min={-20} max={100} step={0.1} onChange={(letterSpacing) => onChange(patchLayerTextTypography(current.current.content, { letterSpacing }))} />
      <LayerTextNumberField label="行高（倍）" value={typography.lineHeight} min={0.5} max={3} step={0.05} onChange={(lineHeight) => onChange(patchLayerTextTypography(current.current.content, { lineHeight }))} />
    </div>
    <label>字体<select aria-label="图层字体" value={familyValue} onChange={(event) => void selectFont(event.target.value)}><optgroup label="通用字体"><option value="sans-serif">无衬线</option><option value="serif">衬线</option><option value="monospace">等宽</option></optgroup>{availableFamilies.length > 0 && <optgroup label="本机字体">{availableFamilies.map((family) => <option key={family} value={`local:${family}`}>{family}</option>)}</optgroup>}</select></label>
    <div className="layer-text-font-access"><button type="button" disabled={loading || !localTextFontAccessSupported()} onClick={() => void loadFonts()}>{loading ? '正在准备字体…' : '加载本机字体'}</button><small>本机字体需浏览器授权；请确认使用许可。不会上传字体文件。</small></div>
    {!localTextFontAccessSupported() && <small>当前浏览器不支持读取本机字体，可选择通用字体。</small>}
    {typography.fontFamily && <small>此配方使用本机字体“{typography.fontFamily}”。其他设备需安装相同字体；缺失时请明确改选通用字体。</small>}
    {fontError && <p className="layer-text-error" role="alert">{fontError}</p>}
    <label>文字对齐<select aria-label="文字对齐" value={content.align} onChange={(event) => onChange({ ...current.current.content, align: event.target.value as 'left' | 'center' | 'right' })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
    {colorField}
    <div className="layer-text-warp-heading"><strong>文字变形</strong><button type="button" disabled={!typography.warp} onClick={() => onChange(setLayerTextWarp(current.current.content, 'none'))}>复位变形</button></div>
    <label>样式<select aria-label="文字变形样式" value={typography.warp?.style ?? 'none'} onChange={(event) => onChange(setLayerTextWarp(current.current.content, event.target.value as ImageLayerTextWarpStyle | 'none'))}><option value="none">无</option>{imageLayerTextWarpStyles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
    {typography.warp && <div className="layer-text-bend"><LayerTextNumberField label="弯曲度（%）" value={typography.warp.bend} min={-100} max={100} onChange={(bend) => { const active = current.current.content; if (active.typography?.warp) onChange(patchLayerTextTypography(active, { warp: { ...active.typography.warp, bend } })) }} /><input aria-label="弯曲度滑块" type="range" min={-100} max={100} step={1} value={typography.warp.bend} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); beginBend() }} onChange={(event) => { const active = current.current.content; if (active.typography?.warp) onChange(patchLayerTextTypography(active, { warp: { ...active.typography.warp, bend: Number(event.target.value) } })) }} onPointerUp={() => finishBend()} onPointerCancel={() => finishBend(true)} onLostPointerCapture={() => finishBend()} onBlur={() => finishBend()} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishBend(true) } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) { event.stopPropagation(); beginBend() } }} onKeyUp={() => finishBend()} /></div>}
    <button type="button" className="layer-text-reset" disabled={!content.typography} onClick={() => onChange(resetLayerTextTypography(current.current.content))}>恢复默认排版与字体</button>
    <small>回车换行；排版与变形在图层范围内显示，超出区域会裁切。复位排版保留文字、字号、颜色与对齐。非零变形支持图层边长不超过 4096 像素、面积不超过 4,194,304 像素。</small>
  </fieldset>
}
