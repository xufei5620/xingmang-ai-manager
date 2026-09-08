import type { AiChatParametersInput } from '../../../../electron/ipc-contract'

export const parameterFields = [
  { key: 'temperature', label: '随机度', min: 0, max: 2, step: .1, integer: false },
  { key: 'topP', label: '采样范围', min: 0, max: 1, step: .05, integer: false },
  { key: 'maxTokens', label: '最大输出 Token', min: 1, max: 131072, step: 1, integer: true },
  { key: 'frequencyPenalty', label: '频率惩罚', min: -2, max: 2, step: .1, integer: false },
  { key: 'presencePenalty', label: '存在惩罚', min: -2, max: 2, step: .1, integer: false },
  { key: 'seed', label: '随机种子', min: -2147483648, max: 2147483647, step: 1, integer: true },
] as const
export type ParameterDraft = Record<typeof parameterFields[number]['key'], string>
export function createParameterDraft(value: AiChatParametersInput): ParameterDraft {
  return { temperature: value.temperature?.toString() ?? '', topP: value.topP?.toString() ?? '', maxTokens: value.maxTokens?.toString() ?? '', frequencyPenalty: value.frequencyPenalty?.toString() ?? '', presencePenalty: value.presencePenalty?.toString() ?? '', seed: value.seed?.toString() ?? '' }
}
export function parseParameters(draft: ParameterDraft): { parameters: AiChatParametersInput; errors: Partial<Record<keyof ParameterDraft, string>> } {
  const parameters: AiChatParametersInput = {}, errors: Partial<Record<keyof ParameterDraft, string>> = {}
  for (const field of parameterFields) {
    const text = draft[field.key].trim()
    if (!text) continue
    const value = Number(text)
    if (!Number.isFinite(value) || value < field.min || value > field.max || (field.integer && !Number.isInteger(value))) errors[field.key] = `请输入 ${field.min} 至 ${field.max} ${field.integer ? '之间的整数' : '之间的数值'}`
    else parameters[field.key] = value
  }
  return { parameters, errors }
}
