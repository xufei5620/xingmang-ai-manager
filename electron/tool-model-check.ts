import { resolveDefaultCliModel } from './cli-model-defaults'
import type { ProviderId } from './catalog'

/**
 * 模型菜单和默认模型只在保存配置时写一次（system-service.ts 的 saveConfig），开机恢复
 * 登录也不会重写已经连好的工具。账号能用的型号之后变了——上了新型号、下架了旧的——
 * 工具里就还是老样子，默认模型一下架，每一轮都报错（第十二批候选 5）。
 *
 * 所以每天第一次打开工具时核对一次：菜单悄悄刷新，默认模型用不了就把换成什么交给
 * 界面去问，用户点了才换。核对失败绝不挡住打开，就当没核。
 */
export type ToolModelCheck =
  | { status: 'skipped' }
  | { status: 'ok'; pickerRefreshed: boolean }
  /** replacement = null：这个账号一个能替的型号都挑不出来，界面只能照旧打开。 */
  | { status: 'unavailable'; model: string; replacement: string | null }

export interface ToolModelCheckTarget {
  apiKey: string
  model: string
  /** 同一个工具换了账号、Key 或型号就是另一次核对：当天核过的结论只对原来那份配置算数。 */
  identity: string
}

export interface ToolModelCheckDependencies {
  now(): number
  /** 只核本软件用当前账号写的配置；官方账号、手填、被改动过的一律 null，不碰。 */
  target(provider: ProviderId): ToolModelCheckTarget | null
  listModels(apiKey: string): Promise<string[]>
  /** 只有 Claude Code 有菜单要刷新。 */
  pickerOutdated(models: readonly string[], model: string): boolean
  refreshPicker(model: string): Promise<void>
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  /** 模型接口最多等这么久；打开工具的人在等，不能按保存配置时那 12 秒算。 */
  listTimeoutMs?: number
}

const checkIntervalMs = 24 * 60 * 60 * 1000
/** 核对没成（断网、接口慢）时隔一小时再试，免得每次打开都白等一遍超时。 */
const failedRetryMs = 60 * 60 * 1000

/**
 * 写配置时 Gemini 的 3.7 / 3.8 flash 会补成 `-high`（config-files.ts 的
 * geminiCliCompatibleModel），读回来的名字和模型列表里的对不上，两种写法都算数。
 */
export function modelOffered(provider: ProviderId, model: string, models: readonly string[]): boolean {
  if (models.includes(model)) return true
  return provider === 'gemini' && models.includes(model.replace(/-high$/i, ''))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('模型列表读取超时')), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createToolModelChecker(deps: ToolModelCheckDependencies) {
  const nextCheckAt = new Map<string, number>()

  async function check(provider: ProviderId): Promise<ToolModelCheck> {
    const target = deps.target(provider)
    if (!target) return { status: 'skipped' }
    const key = `${provider}:${target.identity}`
    const now = deps.now()
    if ((nextCheckAt.get(key) ?? 0) > now) return { status: 'skipped' }
    let models: string[]
    try {
      models = await withTimeout(deps.listModels(target.apiKey), deps.listTimeoutMs ?? 5_000)
    } catch (error) {
      nextCheckAt.set(key, now + failedRetryMs)
      deps.log?.('warn', 'tool-models.check-failed', '打开前没能核对当前账号能用的模型，照常打开', { provider, reason: errorText(error) })
      return { status: 'skipped' }
    }
    // 一个都没列出来多半是接口或分组的问题，不是型号全下架了：不能据此劝用户换。
    if (models.length === 0) {
      nextCheckAt.set(key, now + failedRetryMs)
      return { status: 'skipped' }
    }
    nextCheckAt.set(key, now + checkIntervalMs)
    if (!modelOffered(provider, target.model, models)) {
      const replacement = resolveDefaultCliModel(provider, models)
      deps.log?.('warn', 'tool-models.unavailable', '工具里的默认模型当前账号已经用不了', { provider, model: target.model, replacement })
      return { status: 'unavailable', model: target.model, replacement }
    }
    if (provider !== 'claude') return { status: 'ok', pickerRefreshed: false }
    let outdated: boolean
    try {
      outdated = deps.pickerOutdated(models, target.model)
    } catch (error) {
      deps.log?.('warn', 'tool-models.picker-read-failed', '没能读取 Claude Code 的模型菜单，这次不刷新', { reason: errorText(error) })
      return { status: 'ok', pickerRefreshed: false }
    }
    if (!outdated) return { status: 'ok', pickerRefreshed: false }
    try {
      await deps.refreshPicker(target.model)
    } catch (error) {
      // 没刷成照样打开；明天第一次打开再试。
      deps.log?.('warn', 'tool-models.picker-refresh-failed', 'Claude Code 的模型菜单没能刷新', { reason: errorText(error) })
      return { status: 'ok', pickerRefreshed: false }
    }
    deps.log?.('info', 'tool-models.picker-refreshed', 'Claude Code 的模型菜单已按当前账号能用的模型刷新', { models: models.length })
    return { status: 'ok', pickerRefreshed: true }
  }

  return { check }
}
