export type CodexModelFilter = 'all' | 'non-gpt'

/** A display filter only. Model names do not establish wire-protocol support. */
export function isOpenAiModelId(model: string): boolean {
  const segments = model.trim().toLowerCase().split(/[/:]/)
  return segments.some((part) => part === 'openai'
    || /^(?:gpt(?:[-_.]|\d|$)|chatgpt(?:[-_.]|\d|$)|codex(?:[-_.]|\d|$)|o\d+(?:[-_.]|$))/.test(part))
}

export function codexModelChoices(models: readonly string[], filter: CodexModelFilter, selectedModel: string) {
  const detected = [...new Set(models.filter(Boolean))]
  const candidates = filter === 'non-gpt' ? detected.filter((model) => !isOpenAiModelId(model)) : detected
  const selectedOutsideFilter = Boolean(selectedModel && !candidates.includes(selectedModel))
  const options = candidates.map((model) => ({ value: model, label: model, disabled: false }))
  if (selectedOutsideFilter) {
    options.unshift({
      value: selectedModel,
      label: filter === 'non-gpt'
        ? `${selectedModel}（当前选择 · ${isOpenAiModelId(selectedModel) ? '不符合筛选' : '本次未检测到'}）`
        : selectedModel,
      disabled: filter === 'non-gpt',
    })
  }
  return { candidates, options }
}

export function codexModelFilterSaveIssue(input: {
  filter: CodexModelFilter
  models: readonly string[]
  selectedModel: string
  detected: boolean
  automaticKey: boolean
  officialSource?: boolean
}): string | null {
  if (input.filter !== 'non-gpt') return null
  if (input.officialSource) return '非 GPT 模型需使用星芒账号或自行填写密钥。请切换账号来源后检测模型。'
  if (input.automaticKey) return '非 GPT 模式请先选择已有密钥或自行填写密钥，再检测模型。'
  if (!input.detected) return '请先检测当前密钥的可用模型，再选择非 GPT 模型。'
  const { candidates } = codexModelChoices(input.models, input.filter, input.selectedModel)
  if (!candidates.length) return '当前密钥未返回非 GPT 模型。请更换有相应模型权限的密钥后重新检测。'
  if (!candidates.includes(input.selectedModel)) return '请选择本次检测到的非 GPT 模型后再保存。'
  return null
}
