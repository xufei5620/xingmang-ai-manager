import { parseCanvasRouterStrategy, type CanvasRouterStrategy } from '../runtime/router-strategy'

export interface CanvasRouterStrategyPresentation {
  state: 'legacy' | 'known' | 'invalid'
  value: 'legacy-all' | 'invalid' | CanvasRouterStrategy['strategy']
  label: string
  description: string
  repairLegacy?: boolean
}

export const routerExecutionScopeNotice = '上游仍按原运行范围执行，可能产生费用；路由只选择已完成的输入，不提供失败容错。'

export function canvasRouterStrategyPresentation(settings: Record<string, unknown> | undefined): CanvasRouterStrategyPresentation {
  const repairLegacy = Boolean(settings && Object.hasOwn(settings, 'strategy') && settings.strategy !== 'first-available' && settings.strategy !== 'all')
  if (!settings || !Object.hasOwn(settings, 'routerStrategy')) {
    return { state: 'legacy', value: 'legacy-all', label: '旧配置：保留全部输入', description: repairLegacy ? '保存的旧策略字段无法核对，请明确选择策略后修复；不会自动启用首个输入。' : '旧配置实际保留全部输入；请明确选择后启用新策略。', ...(repairLegacy ? { repairLegacy: true } : {}) }
  }
  try {
    const config = parseCanvasRouterStrategy(settings.routerStrategy)
    const selection = config.strategy === 'first-available' ? '按保存的连线顺序，每种媒体保留首个输入：文字取首段非空文本，图像、视频、音频各取首个素材。' : '按保存的连线顺序，保留归一化后的全部文本及媒体输入。'
    return { state: 'known', value: config.strategy, label: config.strategy === 'first-available' ? '每种媒体保留首个输入' : '保留全部输入', description: `${selection}${repairLegacy ? '旧策略字段无法核对，请明确重新选择后修复再运行。' : ''}`, ...(repairLegacy ? { repairLegacy: true } : {}) }
  } catch (error) {
    return { state: 'invalid', value: 'invalid', label: '策略无法核对，禁止运行', description: error instanceof Error ? error.message : '路由策略无法核对，请刷新后检查原配置；不会改用其他策略。' }
  }
}
