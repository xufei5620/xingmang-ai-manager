import { useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { Button, Input, SettingRow, Textarea } from '../../ui'
import { createParameterDraft, parameterFields, parseParameters, type ParameterDraft } from './parameters'
import type { ChatSettings } from './state'

export function ParametersPanel({ settings, onChange }: { settings: ChatSettings; onChange: (patch: Partial<ChatSettings>) => void }) {
  const [draft, setDraft] = useState(() => createParameterDraft(settings.parameters))
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt)
  const [errors, setErrors] = useState<Partial<Record<keyof ParameterDraft, string>>>({})
  const [saved, setSaved] = useState(false)
  const apply = () => {
    const result = parseParameters(draft)
    setErrors(result.errors)
    if (Object.keys(result.errors).length) return
    onChange({ parameters: result.parameters, systemPrompt }); setSaved(true)
  }
  return <div className="chat-parameters" data-testid="chat-parameters">
    {parameterFields.map((field) => <SettingRow key={field.key} title={field.label} description="" control={<Input type="number" aria-label={field.label} min={field.min} max={field.max} step={field.step} placeholder="默认" value={draft[field.key]} onChange={(event) => { setDraft((current) => ({ ...current, [field.key]: event.target.value })); setSaved(false); setErrors((current) => ({ ...current, [field.key]: undefined })) }} error={errors[field.key]} testId={`chat-parameter-${field.key}`} />} />)}
    <Textarea label="系统提示词" aria-label="系统提示词" value={systemPrompt} maxLength={40000} onChange={(event) => { setSystemPrompt(event.target.value); setSaved(false) }} rows={4} testId="chat-system-prompt" />
    <div className="chat-parameter-actions"><Button variant="ghost" icon={RotateCcw} size="sm" onClick={() => { setDraft(createParameterDraft({})); setSystemPrompt(''); setErrors({}); setSaved(false) }} testId="chat-parameters-reset">恢复默认</Button><Button variant="primary" icon={Check} size="sm" onClick={apply} testId="chat-parameters-apply">应用</Button></div>
    {saved && <p role="status" className="chat-hint">参数已应用到当前对话</p>}
  </div>
}
