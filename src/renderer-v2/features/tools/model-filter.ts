export type CodexModelFilter = 'all' | 'non-gpt'

/** A display filter only. Model names do not establish wire-protocol support. */
export function isOpenAiModelId(model: string): boolean {
  const segments = model.trim().toLowerCase().split(/[/:]/)
  return segments.some((part) => part === 'openai'
    || /^(?:gpt(?:[-_.]|\d|$)|chatgpt(?:[-_.]|\d|$)|codex(?:[-_.]|\d|$)|o\d+(?:[-_.]|$))/.test(part))
}

/**
 * Codex 的型号列表里藏掉的别家型号。grok-4.6 写不对 Codex 改文件用的补丁格式，选了改不成文件
 * （服务端 2026-10-16 实测，Grok 只放 grok-4.7）；yoyo 同日定列表里不显示、不加字。只管 Codex：
 * Grok 命令行用它自己的改文件工具，默认型号就是 grok-4.6。已经配上的不动，只是不再列出来。
 */
export function isHiddenCodexModel(model: string): boolean {
  return model.trim().toLowerCase().split(/[/:]/).some((part) => /^grok-4\.6(?:$|[-_])/.test(part))
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

function isOtherVendorChoice(model: string): boolean {
  return !isOpenAiModelId(model) && !isHiddenCodexModel(model)
}

/**
 * 「换用别家模型」弹窗里的单选列表：Codex 的默认型号排第一（说明里那句「拿不准就选默认的」
 * 指的就是它），后面是检测到的非 GPT 型号。默认型号这把密钥用不了就不列。
 */
export function otherModelChoices(models: readonly string[], defaultModel: string): string[] {
  const detected = [...new Set(models.filter(Boolean))]
  const others = detected.filter(isOtherVendorChoice)
  return detected.includes(defaultModel) && !others.includes(defaultModel) ? [defaultModel, ...others] : others
}

export function otherModelSaveIssue(input: {
  models: readonly string[]
  defaultModel: string
  selectedModel: string
  detected: boolean
}): string | null {
  if (!input.detected) return '请先检测当前密钥的可用模型，再选择别家模型。'
  if (!input.models.some((model) => model && isOtherVendorChoice(model))) return '当前密钥没有别家模型可用。请更换有相应模型权限的密钥后重新检测。'
  if (!otherModelChoices(input.models, input.defaultModel).includes(input.selectedModel)) return '请选择本次检测到的别家模型后再保存。'
  return null
}
