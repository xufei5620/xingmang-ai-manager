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
  if (input.officialSource) return '别家模型要用星芒账号或自己填写的密钥。请换一个账号来源后再检测模型。'
  if (input.automaticKey) return '看别家模型时，请先选择已有密钥或自己填写密钥，再检测模型。'
  if (!input.detected) return '请先检测当前密钥的可用模型，再选择别家模型。'
  const { candidates } = codexModelChoices(input.models, input.filter, input.selectedModel)
  if (!candidates.length) return '当前密钥没有别家模型可用。请更换有相应模型权限的密钥后重新检测。'
  if (!candidates.includes(input.selectedModel)) return '请选择本次检测到的别家模型后再保存。'
  return null
}
