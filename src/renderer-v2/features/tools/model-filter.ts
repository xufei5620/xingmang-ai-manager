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

/**
 * 「换用别家模型」弹窗里的单选列表：Codex 的默认型号排第一（说明里那句「拿不准就选默认的」
 * 指的就是它），后面是检测到的非 GPT 型号。默认型号这把密钥用不了就不列。
 */
export function otherModelChoices(models: readonly string[], defaultModel: string): string[] {
  const detected = [...new Set(models.filter(Boolean))]
  const others = detected.filter((model) => !isOpenAiModelId(model))
  return detected.includes(defaultModel) && !others.includes(defaultModel) ? [defaultModel, ...others] : others
}

export function otherModelSaveIssue(input: {
  models: readonly string[]
  defaultModel: string
  selectedModel: string
  detected: boolean
}): string | null {
  if (!input.detected) return '请先检测当前密钥的可用模型，再选择别家模型。'
  if (!input.models.some((model) => model && !isOpenAiModelId(model))) return '当前密钥没有别家模型可用。请更换有相应模型权限的密钥后重新检测。'
  if (!otherModelChoices(input.models, input.defaultModel).includes(input.selectedModel)) return '请选择本次检测到的别家模型后再保存。'
  return null
}
