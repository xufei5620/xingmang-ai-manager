import type { ToolModelCheck } from '../../../../electron/ipc-contract'

/**
 * 打开工具前主进程核对过一遍当前账号能用的模型（第十二批候选 5）。默认模型用不了、
 * 又挑得出能替的型号时，打开前问用户一句要不要换；挑不出来就照旧打开，让工具自己
 * 报错——那种情况下换什么都是瞎猜，不该替付费客户做主。
 */
export interface ModelSwapOffer {
  toolName: string
  model: string
  replacement: string
}

export type ModelSwapChoice = 'swap' | 'keep' | 'cancel'

export function modelSwapOffer(toolName: string, check: ToolModelCheck): ModelSwapOffer | null {
  if (check.status !== 'unavailable' || !check.replacement || check.replacement === check.model) return null
  return { toolName, model: check.model, replacement: check.replacement }
}

export function modelSwapQuestion(offer: ModelSwapOffer): string {
  return `${offer.toolName} 里设的「${offer.model}」这个模型，当前账号用不了了。换成「${offer.replacement}」再打开吗？`
}
