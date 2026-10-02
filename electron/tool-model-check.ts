import { resolveDefaultCliModel } from './cli-model-defaults'
import type { ProviderId } from './catalog'

/**
 * 模型菜单和默认模型只在保存配置时写一次（system-service.ts 的 saveConfig），开机恢复
 * 登录也不会重写已经连好的工具。账号能用的型号之后变了——上了新型号、下架了旧的——
 * 工具里就还是老样子，默认模型一下架，每一轮都报错（第十二批候选 5）。
 *
 * 所以每天第一次打开工具时核对一次：菜单悄悄刷新，默认模型用不了就把换成什么交给
 * 界面去问，用户点了才换。核对失败绝不挡住打开，就当没核。
 *
 * 有菜单要刷新的是 Claude Code（settings.json 里的 /model 菜单，claude-model-picker.ts）
 * 和 Codex（本软件写的型号名单，命令行和桌面端共用，codex-model-catalog.ts）。
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
  /** Codex 要先问一遍命令行的版本才知道该不该写名单，所以可以是异步的。 */
  pickerOutdated(provider: ModelPickerProvider, models: readonly string[], model: string): boolean | Promise<boolean>
  /**
   * assertCurrent 要在真正落盘前再调一次：核对和写入之间隔着网络请求，账号随时会切走，
   * 写入那一刻认的必须还是开始核对时那个账号那份配置（#538）。
   */
  refreshPicker(provider: ModelPickerProvider, model: string, assertCurrent: () => void): Promise<void>
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  /** 模型接口最多等这么久；打开工具的人在等，不能按保存配置时那 12 秒算。 */
  listTimeoutMs?: number
}

export type ModelPickerProvider = 'claude' | 'codex'

const pickerNames: Record<ModelPickerProvider, string> = { claude: 'Claude Code', codex: 'Codex' }

export function hasModelPicker(provider: ProviderId): provider is ModelPickerProvider {
  return provider === 'claude' || provider === 'codex'
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

  // 模型列表是按开始时那个账号的 Key 拿的。等它回来这段时间里切了账号（或 Key、型号变了），
  // 这份结论就不属于现在这份配置：既不能拿去改新账号的菜单，也不能劝新账号换模型（#538）。
  function currentGuard(provider: ProviderId, identity: string) {
    function stillCurrent(): boolean {
      return deps.target(provider)?.identity === identity
    }
    function assertCurrent(): void {
      if (!stillCurrent()) throw new Error('账号已变化，这次核对作废')
    }
    return { stillCurrent, assertCurrent }
  }

  function logStale(provider: ProviderId): void {
    deps.log?.('info', 'tool-models.account-changed', '核对期间账号或配置变了，这次核对结果不用', { provider })
  }

  async function listModels(target: ToolModelCheckTarget): Promise<string[]> {
    return withTimeout(deps.listModels(target.apiKey), deps.listTimeoutMs ?? 5_000)
  }

  /** 菜单对不上就悄悄重写。读不出、写不成都只记日志：明天第一次打开（或下次开机）再试。 */
  async function refreshPickerIfOutdated(
    provider: ModelPickerProvider,
    target: ToolModelCheckTarget,
    models: readonly string[],
    guard: ReturnType<typeof currentGuard>,
  ): Promise<'refreshed' | 'unchanged' | 'stale'> {
    const name = pickerNames[provider]
    let outdated: boolean
    try {
      outdated = await deps.pickerOutdated(provider, models, target.model)
    } catch (error) {
      deps.log?.('warn', 'tool-models.picker-read-failed', `没能读取 ${name} 的模型菜单，这次不刷新`, { provider, reason: errorText(error) })
      return 'unchanged'
    }
    if (!outdated) return 'unchanged'
    if (!guard.stillCurrent()) return 'stale'
    try {
      await deps.refreshPicker(provider, target.model, guard.assertCurrent)
    } catch (error) {
      deps.log?.('warn', 'tool-models.picker-refresh-failed', `${name} 的模型菜单没能刷新`, { provider, reason: errorText(error) })
      return 'unchanged'
    }
    deps.log?.('info', 'tool-models.picker-refreshed', `${name} 的模型菜单已按当前账号能用的模型刷新`, { provider, models: models.length })
    return 'refreshed'
  }

  async function check(provider: ProviderId): Promise<ToolModelCheck> {
    const target = deps.target(provider)
    if (!target) return { status: 'skipped' }
    const key = `${provider}:${target.identity}`
    const guard = currentGuard(provider, target.identity)
    function staleResult(): ToolModelCheck {
      logStale(provider)
      return { status: 'skipped' }
    }
    const now = deps.now()
    if ((nextCheckAt.get(key) ?? 0) > now) return { status: 'skipped' }
    let models: string[]
    try {
      models = await listModels(target)
    } catch (error) {
      nextCheckAt.set(key, now + failedRetryMs)
      deps.log?.('warn', 'tool-models.check-failed', '打开前没能核对当前账号能用的模型，照常打开', { provider, reason: errorText(error) })
      return { status: 'skipped' }
    }
    if (!guard.stillCurrent()) return staleResult()
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
    if (!hasModelPicker(provider)) return { status: 'ok', pickerRefreshed: false }
    const refreshed = await refreshPickerIfOutdated(provider, target, models, guard)
    if (refreshed === 'stale') return staleResult()
    return { status: 'ok', pickerRefreshed: refreshed === 'refreshed' }
  }

  /**
   * 开机时只把菜单对一遍（system-service.ts）：客户升级后多半直接从开始菜单打开 Codex
   * 桌面端，不经过打开前那次核对，新型号就一直进不了菜单。这里不劝换模型、也不占当天
   * 那次核对，默认模型已经用不了的留给打开前那次去问。返回菜单是否真的刷新了。
   */
  async function syncPicker(provider: ProviderId): Promise<boolean> {
    if (!hasModelPicker(provider)) return false
    const target = deps.target(provider)
    if (!target) return false
    const guard = currentGuard(provider, target.identity)
    let models: string[]
    try {
      models = await listModels(target)
    } catch (error) {
      deps.log?.('warn', 'tool-models.sync-failed', '开机时没能核对当前账号能用的模型，菜单这次不动', { provider, reason: errorText(error) })
      return false
    }
    if (!guard.stillCurrent()) {
      logStale(provider)
      return false
    }
    if (models.length === 0 || !modelOffered(provider, target.model, models)) return false
    const refreshed = await refreshPickerIfOutdated(provider, target, models, guard)
    if (refreshed === 'stale') logStale(provider)
    return refreshed === 'refreshed'
  }

  return { check, syncPicker }
}
