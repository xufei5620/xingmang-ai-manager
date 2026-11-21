import type { ToolModelCheck } from '../../../../electron/ipc-contract'
import { claudeModelLabel } from '../../../../electron/claude-model-picker'

/**
 * 打开工具前主进程核对过一遍当前账号能用的模型（第十二批候选 5）。默认模型用不了、
 * 又挑得出能替的型号时，打开前问用户一句要不要换；挑不出来就照旧打开，让工具自己
 * 报错——那种情况下换什么都是瞎猜，不该替付费客户做主。
 *
 * 另一种是配置里还是本软件以前写的默认型号、当前账号已经能用新一代（第十五批 6）：
 * 同一个框问一次，换不换都由用户点。
 */
export interface ModelSwapOffer {
  kind: 'unavailable' | 'upgrade'
  toolName: string
  model: string
  replacement: string
}

export type ModelSwapChoice = 'swap' | 'keep' | 'cancel'

export function modelSwapOffer(toolName: string, check: ToolModelCheck): ModelSwapOffer | null {
  if (check.status !== 'unavailable' && check.status !== 'upgrade') return null
  if (!check.replacement || check.replacement === check.model) return null
  return { kind: check.status, toolName, model: check.model, replacement: check.replacement }
}

/** 升级提问用短名（Opus 5.5），id 认不出来的形状原样显示。 */
function modelName(model: string): string {
  return /^claude-/i.test(model) ? claudeModelLabel(model) : model
}

export function modelSwapTitle(offer: ModelSwapOffer): string {
  return offer.kind === 'upgrade' ? `${offer.toolName} 有更新的型号` : '默认模型已不可用'
}

export function modelSwapQuestion(offer: ModelSwapOffer): string {
  if (offer.kind === 'upgrade') {
    const next = modelName(offer.replacement)
    return `当前账号可使用 ${next}，比当前的 ${modelName(offer.model)} 更新。是否更换为 ${next}？之后可在「配置」中改回。`
  }
  return `${offer.toolName} 中设置的模型「${offer.model}」当前账号已无法使用。是否更换为「${offer.replacement}」后打开？`
}

export function modelSwapConfirmLabel(offer: ModelSwapOffer): string {
  return `更换为 ${offer.kind === 'upgrade' ? modelName(offer.replacement) : offer.replacement}`
}

export function modelSwapKeepLabel(offer: ModelSwapOffer): string {
  return offer.kind === 'upgrade' ? '暂不更换' : '照旧打开'
}
