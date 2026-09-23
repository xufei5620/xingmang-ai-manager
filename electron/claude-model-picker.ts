// Claude Code 的 /model 菜单写死了官方阵容：Default（Opus 5 · 1M 上下文）、Opus、Fable、
// Sonnet、Haiku……每一行还标着官方美元单价。接中转后这份菜单与当前账号实际能用的模型对不上：
// 选到分组里没有的型号就是一句「无可用渠道」，看到的价格也不是中转的计费。
//
// settings.json 的 modelPicker（沙箱实测 2.1.277）可以整份替换这些行：
//   { replaceBuiltInOptions: true, options: [{ model, label, description }] }
// 「Default」那一行删不掉，它指向 env.ANTHROPIC_DEFAULT_MODEL——不设时是带 1M beta 的
// Opus 5，所以一并写成当前选定的型号。settings.json 里写错或不认识的键 Claude Code 只忽略
// 那一个键，不会连带整份配置失效（同一次实测：modelPicker 写成字符串，Key 照常生效）。

export interface ClaudeModelPickerOption {
  model: string
  label: string
  description: string
}

export interface ClaudeModelPickerSetting {
  replaceBuiltInOptions: true
  options: ClaudeModelPickerOption[]
}

// 菜单是一屏选择列表，分组里型号再多也只放这么多，当前选定的那个永远在内。
const MAX_CLAUDE_PICKER_OPTIONS = 20

function isClaudeModelId(model: string): boolean {
  return /^claude-/i.test(model)
}

function capitalize(word: string): string {
  return word ? `${word[0].toUpperCase()}${word.slice(1)}` : word
}

/**
 * 把型号 id 变成菜单上的短名：claude-opus-5 → Opus 5，claude-sonnet-4-6 → Sonnet 4.6，
 * claude-haiku-4-5-20251001 → Haiku 4.5（日期后缀不进名字），claude-3-7-sonnet-20250219
 * → Sonnet 3.7。认不出来的形状原样用 id，宁可长也不能错。完整 id 另放在说明里。
 */
export function claudeModelLabel(model: string): string {
  const parts = model.replace(/^claude-/i, '').split('-').filter(Boolean)
  const words: string[] = []
  const version: string[] = []
  for (const part of parts) {
    if (/^\d{8}$/.test(part)) continue
    if (/^\d{1,2}$/.test(part)) version.push(part)
    else if (/^[a-z][a-z0-9]*$/i.test(part)) words.push(capitalize(part.toLowerCase()))
    else return model
  }
  if (words.length === 0) return model
  return [words[0], version.join('.'), ...words.slice(1)].filter(Boolean).join(' ')
}

/**
 * 从当前 Key 的可用模型里挑出 Claude 系列生成菜单。一个 Claude 型号都没有（分组配错、
 * 或者模型接口没回东西）时返回 null：宁可留着官方菜单，也不能写一份空菜单。
 */
export function buildClaudeRelayModelPicker(
  availableModels: readonly string[],
  currentModel: string,
): ClaudeModelPickerSetting | null {
  const unique = [...new Set(availableModels.map((model) => model.trim()).filter(isClaudeModelId))]
  if (unique.length === 0) return null
  const chosen = unique.includes(currentModel)
    ? [currentModel, ...unique.filter((model) => model !== currentModel)]
    : unique
  const options = chosen.slice(0, MAX_CLAUDE_PICKER_OPTIONS)
    .sort((left, right) => left.localeCompare(right))
    .map((model) => ({ model, label: claudeModelLabel(model), description: model }))
  return { replaceBuiltInOptions: true, options }
}

/**
 * 认出本软件写的菜单：每一行都恰好是 buildClaudeRelayModelPicker 会生成的样子。用户自己
 * 写的菜单（自己起的名字、自己的说明、没开 replaceBuiltInOptions）一律不认，不动它。
 */
export function isManagedClaudeModelPicker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.replaceBuiltInOptions !== true || !Array.isArray(record.options)) return false
  if (Object.keys(record).length !== 2 || record.options.length === 0) return false
  return record.options.every((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return false
    const entry = option as Record<string, unknown>
    return Object.keys(entry).length === 3
      && typeof entry.model === 'string'
      && entry.description === entry.model
      && entry.label === claudeModelLabel(entry.model)
  })
}

/**
 * 写菜单与 Default 指向。菜单只在「没写过」或「是本软件写的」时覆盖；Default 指向跟着
 * 当前选定的型号走，它和 ANTHROPIC_BASE_URL 一样是中转专属设置。
 */
export function applyClaudeRelayModelPicker(
  parsed: Record<string, unknown>,
  env: Record<string, unknown>,
  availableModels: readonly string[],
  currentModel: string,
): void {
  env.ANTHROPIC_DEFAULT_MODEL = currentModel
  const picker = buildClaudeRelayModelPicker(availableModels, currentModel)
  if (!picker) return
  if (parsed.modelPicker !== undefined && !isManagedClaudeModelPicker(parsed.modelPicker)) return
  parsed.modelPicker = picker
}

/** 切回官方 Claude 账号：官方菜单才是对的，收回本软件写的菜单与 Default 指向。 */
export function removeClaudeRelayModelPicker(parsed: Record<string, unknown>, env: Record<string, unknown> | null): void {
  if (isManagedClaudeModelPicker(parsed.modelPicker)) delete parsed.modelPicker
  if (env) delete env.ANTHROPIC_DEFAULT_MODEL
}
