import { useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { Button, Dialog, Input, Slider, Textarea } from '../../ui'
import { createParameterDraft, numberFields, parseParameters, sliderFields, type ParameterDraft } from './parameters'
import type { ChatSettings } from './state'

// 参数按对话存：打开时拿当前对话的那一份，「应用」才写回去；没应用就关，什么都不变。
export function ParametersDialog({ settings, onApply, onClose }: { settings: ChatSettings; onApply: (patch: Pick<ChatSettings, 'parameters' | 'systemPrompt'>) => void; onClose: () => void }) {
  const [initial] = useState(() => ({ draft: createParameterDraft(settings.parameters), systemPrompt: settings.systemPrompt }))
  const [draft, setDraft] = useState(initial.draft)
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt)
  const [errors, setErrors] = useState<Partial<Record<keyof ParameterDraft, string>>>({})
  const dirty = systemPrompt !== initial.systemPrompt || (Object.keys(draft) as Array<keyof ParameterDraft>).some((key) => draft[key] !== initial.draft[key])
  const change = (key: keyof ParameterDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }
  const apply = () => {
    const result = parseParameters(draft)
    setErrors(result.errors)
    if (!Object.keys(result.errors).length) onApply({ parameters: result.parameters, systemPrompt })
  }
  const reset = () => { setDraft(createParameterDraft({})); setSystemPrompt(''); setErrors({}) }
  return <Dialog open title="参数设置" width={480} dirty={dirty} onClose={onClose} testId="chat-parameters" footer={<><Button variant="ghost" icon={RotateCcw} onClick={reset} testId="chat-parameters-reset">恢复默认</Button><span className="chat-parameter-gap" /><Button onClick={onClose} testId="chat-parameters-cancel">取消</Button><Button variant="primary" icon={Check} onClick={apply} testId="chat-parameters-apply">应用</Button></>}>
    <div className="chat-parameters" data-unsaved={dirty}>
      <Textarea label="系统提示词" value={systemPrompt} maxLength={40000} rows={3} placeholder="比如：你是一位耐心的编程老师，回答尽量简短" onChange={(event) => setSystemPrompt(event.target.value)} testId="chat-system-prompt" />
      <div className="chat-parameter-grid">{sliderFields.map((field) => <Slider key={field.key} label={field.label} value={draft[field.key]} fallback={field.fallback} min={field.min} max={field.max} step={field.step} hint={field.hint} placeholder="默认" onChange={(value) => change(field.key, value)} testId={`chat-parameter-${field.key}`} />)}</div>
      <div className="chat-parameter-grid">{numberFields.map((field) => <Input key={field.key} label={field.label} type="number" mono min={field.min} max={field.max} step={field.step} placeholder={field.placeholder} value={draft[field.key]} onChange={(event) => change(field.key, event.target.value)} error={errors[field.key]} testId={`chat-parameter-${field.key}`} />)}</div>
    </div>
  </Dialog>
}
