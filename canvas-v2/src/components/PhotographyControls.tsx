import { useId, useState } from 'react'
import { Camera, ChevronDown, ChevronUp, Check } from 'lucide-react'
import { applyPhotographyPrompt, emptyPhotographyDraft, photographyFields, photographyPresets, photographyPromptBlock, readPhotographyDraft, type PhotographyDraft } from '../editor/photography-prompt'
import '../theme/photography-controls.css'

export function PhotographyControls({ prompt, disabled, onApply }: { prompt: string; disabled: boolean; onApply(prompt: string): void }) {
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<PhotographyDraft>(emptyPhotographyDraft)
  const [error, setError] = useState<string | null>(null)
  const applied = readPhotographyDraft(prompt)
  const preview = photographyPromptBlock(draft)
  function toggle() {
    if (!open) { setDraft(applied ?? emptyPhotographyDraft()); setError(null) }
    setOpen(!open)
  }
  function apply(values: PhotographyDraft) {
    try {
      onApply(applyPhotographyPrompt(prompt, values))
      setError(null)
      setOpen(false)
    } catch (error) { setError(error instanceof Error ? error.message : '摄影设定暂时无法应用') }
  }
  return <section className="photography-controls" aria-label="摄影控制">
    <button type="button" className="photography-toggle" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
      <Camera size={14} /><span>摄影控制</span>{applied && <small><Check size={11} />已应用</small>}{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
    </button>
    {open && <div id={panelId} className="photography-panel">
      <p>选择拍摄风格，预览后应用到提示词。此处不会发起生成。</p>
      <div className="photography-presets" role="group" aria-label="摄影场景预设">
        {photographyPresets.map((preset) => <button key={preset.name} type="button" disabled={disabled} onClick={() => { setDraft({ ...emptyPhotographyDraft(), ...preset.values }); setError(null) }}>{preset.name}</button>)}
      </div>
      <fieldset disabled={disabled} className="photography-fields">
        <legend className="sr-only">摄影参数</legend>
        {photographyFields.map((field) => <label key={field.key}><span>{field.label}</span><select aria-label={field.label} value={draft[field.key]} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}>
          <option value="">不指定</option>{field.options.map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>)}
      </fieldset>
      <div className="photography-preview"><strong>将写入提示词</strong><pre>{preview || '选择场景预设或参数后，在这里预览。'}</pre></div>
      <p>摄影参数用于描述画面风格，实际效果取决于模型。</p>
      {error && <p role="alert" className="photography-error">{error}</p>}
      <div className="photography-actions">
        <button type="button" onClick={() => { setDraft(emptyPhotographyDraft()); setError(null) }} disabled={disabled}>清空选择</button>
        {applied && <button type="button" onClick={() => apply(emptyPhotographyDraft())} disabled={disabled}>移除已应用设定</button>}
        <button type="button" className="is-primary" disabled={disabled || !preview} onClick={() => apply(draft)}>应用到提示词</button>
      </div>
    </div>}
  </section>
}
