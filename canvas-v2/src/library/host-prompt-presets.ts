// 提示词预设请求按宿主能力发（#4）：v2 时代的桌面名称最多 100 字，创建只认 name、prompt、tags，
// 更新只多一个 id，多带分组、简介或版本号就整单拒绝。
import type { CanvasCapabilityProfile } from '../host-capabilities'
import type { PromptPresetInput, PromptPresetUpdateInput } from './prompt-preset-contract'

/** Refused before any request, so the save is known not to have happened (status as a 422 reply). */
export class PromptPresetHostLimitError extends Error {
  readonly status = 422
  constructor(message: string) { super(message); this.name = 'PromptPresetHostLimitError' }
}

function assertNameFits(name: string | undefined, profile: CanvasCapabilityProfile): void {
  if (name !== undefined && name.trim().length > profile.promptPresets.nameMaxLength) throw new PromptPresetHostLimitError(`提示词名称最多 ${profile.promptPresets.nameMaxLength} 个字，请缩短后再保存。`)
}

/** The create request a host accepts; refused here, before any request, when the name is too long. */
export function promptPresetInputForHost(input: PromptPresetInput, profile: CanvasCapabilityProfile): PromptPresetInput {
  assertNameFits(input.name, profile)
  if (profile.features.promptPresetGroups) return input
  const { name, prompt, tags } = input
  return { name, prompt, ...(tags !== undefined ? { tags } : {}) }
}

/** The update request a host accepts. Desktop 000f913 and 14c2c76 take only id, name, prompt and tags, without a version. */
export function promptPresetUpdateForHost(input: PromptPresetUpdateInput, profile: CanvasCapabilityProfile): PromptPresetUpdateInput {
  assertNameFits(input.name, profile)
  if (profile.features.promptPresetGroups) return input
  const { id, name, prompt, tags } = input
  return { id, ...(name !== undefined ? { name } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(tags !== undefined ? { tags } : {}) }
}
