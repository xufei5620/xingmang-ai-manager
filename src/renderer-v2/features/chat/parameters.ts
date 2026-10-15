import type { AiChatParametersInput } from '../../../../electron/ipc-contract'

type ParameterKey = keyof Required<AiChatParametersInput>
interface ParameterField { key: ParameterKey; label: string; min: number; max: number; step: number; integer: boolean }
// 滑块没动过就是「默认」：不发这一项，用模型自己的默认值。fallback 只是滑块停的位置。
export interface SliderField extends ParameterField { fallback: number; hint: string }
export interface NumberField extends ParameterField { placeholder: string; invalid: string }

const temperature: SliderField = { key: 'temperature', label: '随机度', min: 0, max: 2, step: .1, integer: false, fallback: 1, hint: '越高越有创意，越低越稳定' }
const topP: SliderField = { key: 'topP', label: '采样范围', min: 0, max: 1, step: .05, integer: false, fallback: 1, hint: '一般不用改' }
const maxTokens: NumberField = { key: 'maxTokens', label: '最大输出 Token', min: 1, max: 131072, step: 1, integer: true, placeholder: '不限', invalid: '最大输出 Token 要填整数，比如 4096' }
const frequencyPenalty: SliderField = { key: 'frequencyPenalty', label: '频率惩罚', min: -2, max: 2, step: .1, integer: false, fallback: 0, hint: '调高可以减少重复用词' }
const presencePenalty: SliderField = { key: 'presencePenalty', label: '存在惩罚', min: -2, max: 2, step: .1, integer: false, fallback: 0, hint: '调高会更愿意换话题' }
const seed: NumberField = { key: 'seed', label: '随机种子', min: -2147483648, max: 2147483647, step: 1, integer: true, placeholder: '不填则每次随机', invalid: '随机种子要填整数' }

export const parameterFields: ReadonlyArray<SliderField | NumberField> = [temperature, topP, maxTokens, frequencyPenalty, presencePenalty, seed]
export const sliderFields: readonly SliderField[] = [temperature, topP, frequencyPenalty, presencePenalty]
export const numberFields: readonly NumberField[] = [maxTokens, seed]
export type ParameterDraft = Record<ParameterKey, string>
export function createParameterDraft(value: AiChatParametersInput): ParameterDraft {
  return { temperature: value.temperature?.toString() ?? '', topP: value.topP?.toString() ?? '', maxTokens: value.maxTokens?.toString() ?? '', frequencyPenalty: value.frequencyPenalty?.toString() ?? '', presencePenalty: value.presencePenalty?.toString() ?? '', seed: value.seed?.toString() ?? '' }
}
export function parseParameters(draft: ParameterDraft): { parameters: AiChatParametersInput; errors: Partial<Record<keyof ParameterDraft, string>> } {
  const parameters: AiChatParametersInput = {}, errors: Partial<Record<keyof ParameterDraft, string>> = {}
  for (const field of parameterFields) {
    const text = draft[field.key].trim()
    if (!text) continue
    const value = Number(text)
    // 填的不是整数时说该填什么；是整数、只是超出范围时才说范围。
    const notWhole = field.integer && !Number.isInteger(value)
    if (notWhole && 'invalid' in field) errors[field.key] = field.invalid
    else if (!Number.isFinite(value) || value < field.min || value > field.max || notWhole) errors[field.key] = `请输入 ${field.min} 至 ${field.max} ${field.integer ? '之间的整数' : '之间的数值'}`
    else parameters[field.key] = value
  }
  return { parameters, errors }
}
