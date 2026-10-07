import { accountSiteId, type AccountSiteId } from '../../account-context'
import {
  providerIds,
  type AppConfigSummary,
  type AppSettingsV2,
  type ProviderId,
  type RelayEndpointId,
  type RendererLogLevel,
  type RunningToolsReport,
  type SystemSnapshot,
  type XingmangApi,
} from '../../../../electron/ipc-contract'
import { tools } from '../../registry/tools'
import { codexNeedsRepair, connectionReady, sourceFor } from './model'
import { userFacingErrorMessage } from '../../business-common'
import { networkBlockedFailures } from './online-resync'
import { keySyncFailureText } from './key-sync-failure'
import { relayProviderBaseUrls, relaySiteEndpointIdForBaseUrl } from '../../../../electron/relay-sites'
import { describeRunningTools } from '../../../../electron/running-tools'
import {
  applyManualSourceMarker,
  getSourceMarkerStorage,
  type SourceMarkerStorage,
} from './source-marker'

export type AccountBootstrapPhase =
  | 'syncing'
  | 'inspecting'
  | 'configuring'
  | 'verifying'
/**
 * `rewrite` 是用户点名某个工具按「重新写入 Key」时走的那一档：只有它会去覆盖
 * 一份「我们写过、之后被改动」的配置，登录和恢复这两档一律绕开，免得用户手改
 * 过的配置在下次开机时被悄悄改回去。
 */
export type AccountBootstrapMode = 'login' | 'restore' | 'rewrite'

export interface AccountBootstrapProgress {
  phase: AccountBootstrapPhase
  label: string
  percent: number
  /**
   * 开机恢复这一档问完服务端以后才填：已经连好的工具里，这一轮还要换 Key 的那几家
   * （Key 换了分组，或用户选的连接线路已重启生效）。没填 = 还不知道，或者是会重写已连好工具的登录、点名重写两档。
   */
  connectedKeyChanges?: ProviderId[]
}

/**
 * 开机检测还没跑完、首页摆着上次结果的那几秒里，账号这边还会不会换掉这个工具的 Key。
 * 会换、或者还说不准的，「打开」照旧等检测跑完：Key 同步写配置要等那一轮检测，抢在它
 * 前面打开，工具就带着旧 Key 起来了。登录还在恢复、或者同步还没开始的，都算说不准。
 */
export function accountKeyChangePending(
  account: {
    signedIn: boolean
    restoring: boolean
    bootstrap: (AccountBootstrapProgress & { result?: unknown; error?: string }) | null
  },
  provider: ProviderId,
): boolean {
  const { bootstrap } = account
  if (!bootstrap) return account.signedIn || account.restoring
  return accountKeyChangeInProgress(bootstrap, provider)
}

/**
 * 检测跑完以后：这一轮账号同步正在给这个工具换 Key、改线路，这时打开工具会读走旧配置。
 * 和上面不同，同步还没开始的不算——切完账号不再跑这一轮，开机恢复联不上时登录会一直搁着，
 * 照上面那样算「说不准」，这几种情况下工具就一直打不开，得重开星芒。
 */
export function accountKeyChangeInProgress(
  bootstrap: (AccountBootstrapProgress & { result?: unknown; error?: string }) | null,
  provider: ProviderId,
): boolean {
  if (!bootstrap || bootstrap.result || bootstrap.error) return false
  return bootstrap.connectedKeyChanges?.includes(provider) ?? true
}

export interface AccountBootstrapSkip {
  provider: ProviderId
  reason: 'not-installed' | 'detection-failed' | 'configured' | 'official' | 'manual' | 'unknown' | 'changed'
  message: string
}

/**
 * 点名重写某个工具，规划器却把它跳过了（手填、来源没确认、官方账号等）：这不是
 * 「没换成、再试一次」，再试还是跳过。单独一类，调用方据此给出真正的下一步（#478）。
 */
export class KeyRewriteSkippedError extends Error {
  constructor(readonly skipped: AccountBootstrapSkip[]) {
    super(skipped.map((entry) => entry.message).join('；'))
    this.name = 'KeyRewriteSkippedError'
  }
}

/** 点名重写的那几个工具里，被这一轮跳过、配置没动的（#478）。不点名的整轮修复不算。 */
export function skippedNamedProviders(result: Pick<AccountBootstrapResult, 'skipped'> | undefined, providers?: readonly ProviderId[]): AccountBootstrapSkip[] {
  if (!providers) return []
  return (result?.skipped ?? []).filter((entry) => providers.includes(entry.provider))
}

export interface AccountBootstrapPlan {
  targets: ProviderId[]
  skipped: AccountBootstrapSkip[]
  preferredModels: Partial<Record<ProviderId, string>>
  /** targets 里那几个 Codex 认不出连接设置、没有归属记录也照样自动修的工具（第十七批 1b）。 */
  shadowRepairs?: ProviderId[]
}

export interface AccountBootstrapResult {
  readyKeys: ProviderId[]
  configured: ProviderId[]
  failed: Array<{ provider: ProviderId; message: string }>
  skipped: AccountBootstrapSkip[]
  warnings: string[]
  /**
   * 这一轮没写完，且拦住它的全是网络。断网启动时首页横幅要换一句话，联网之后
   * 还要据此补跑一次（online-resync.ts）。判定放在这里，是因为 Key 同步那一侧的
   * 失败（synchronized.failed）出了这个函数就被拼成 warnings 文本，调用方再想
   * 分辨哪条是网络问题就只能猜。
   */
  networkBlocked: boolean
  /** 这一轮顺手修好的「Codex 认不出」的配置，首页据此轻轻说一句。缺省 = 没有。 */
  repairedShadowed?: ProviderId[]
  /** 这一轮因为 Key 换了分组（买了订阅、订阅到期）而改写的工具；缺省 = 没有。 */
  regrouped?: ProviderId[]
  /**
   * 这一轮跟着连接线路改了配置、写完时还开着（或看不出开没开）的工具（#941）。配置照样改好了，
   * 只是开着的进程还拿着原来的地址，要重开才走新线路；首页据此提示。缺省 = 没有要重开的。
   */
  routeRestart?: RunningToolsReport
  /** 这一轮跟着连接线路改了配置的工具，开没开都算；nextRouteRestart 据此只换掉它们在上一句「要重开」里的说法。缺省 = 这一轮没改线路。 */
  routeFollowed?: ProviderId[]
}

export type AccountBootstrapBridge = Pick<
  XingmangApi,
  | 'syncManagedCliKeys'
  | 'scanSystem'
  | 'getConfig'
  | 'getSettings'
  | 'configureManagedCliKeys'
  | 'getAccountSession'
> & Partial<Pick<XingmangApi, 'inspectRunningTools'>>

function nameOf(provider: ProviderId) {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

/**
 * 跟着换了连接线路的那几个工具写完以后还开着没有（#941）。开着的照样改了配置，只是要重开才走新地址：
 * 这里只回答该对谁说。问不出来就当「看不出来」，提示改成「如果还开着」；桥上没有这个能力（测试、
 * 旧调用方）就不提示，同 account-switch-sync.ts 的 inspectRunningAfterSwitch。都没开回 null。
 */
async function inspectRouteRestart(
  api: Partial<Pick<XingmangApi, 'inspectRunningTools'>>,
  followed: readonly ProviderId[],
): Promise<RunningToolsReport | null> {
  if (!api.inspectRunningTools) return null
  let report: RunningToolsReport
  try {
    report = await api.inspectRunningTools([...followed])
  } catch {
    report = { running: [], unknown: [...followed], codexDesktopRunning: followed.includes('codex') ? null : false, canRestartCodexDesktop: false }
  }
  return describeRunningTools(report, 'route') ? report : null
}

/** 合起来的名单照首页工具的顺序排，不然前后两轮拼起来会成「Codex CLI、Claude Code」。 */
function inToolOrder(providers: readonly ProviderId[]): ProviderId[] {
  const order = tools.map((tool) => tool.id)
  return [...providers].sort((left, right) => order.indexOf(left) - order.indexOf(right))
}

/**
 * 一轮同步做完以后首页该摆哪句「要重开」（#941）。这一轮跟着线路改了哪几个工具，就用这一轮问出来的
 * 结果换掉它们在上一句里的说法（关了的不再点名）；这一轮没碰的照上一句留着：后面几轮（联网后补跑、
 * 装完一个工具、重写 Key）往往只碰一两个、甚至一个不碰，上一句客户还没点「知道了」，那几个工具也还
 * 开着拿着旧地址，别让它们从提示里消失。
 */
export function nextRouteRestart(previous: RunningToolsReport | undefined, result: AccountBootstrapResult): RunningToolsReport | undefined {
  const followed = result.routeFollowed ?? []
  if (!followed.length) return previous
  const fresh = result.routeRestart
  if (!previous) return fresh
  const untouched = (providers: readonly ProviderId[]) => providers.filter((provider) => !followed.includes(provider))
  const merged: RunningToolsReport = {
    running: inToolOrder([...untouched(previous.running), ...(fresh?.running ?? [])]),
    unknown: inToolOrder([...untouched(previous.unknown), ...(fresh?.unknown ?? [])]),
    // 桌面端读的是 Codex 那份配置，跟着 Codex 走。
    codexDesktopRunning: followed.includes('codex') ? fresh?.codexDesktopRunning ?? false : previous.codexDesktopRunning,
    canRestartCodexDesktop: fresh?.canRestartCodexDesktop ?? previous.canRestartCodexDesktop,
  }
  return describeRunningTools(merged, 'route') ? merged : undefined
}

/** 替客户重开过 Codex 桌面端：它已经读到新地址，不再点它的名；别的都关了就整句收起。 */
export function afterCodexDesktopRestart(report: RunningToolsReport | undefined): RunningToolsReport | undefined {
  if (!report) return undefined
  const restarted = { ...report, codexDesktopRunning: false }
  return describeRunningTools(restarted, 'route') ? restarted : undefined
}

function installedState(system: SystemSnapshot, provider: ProviderId) {
  if (provider !== 'codex') {
    const status = system.clis[provider]
    return {
      installed: status.installed,
      detectionFailed: status.detectionFailed === true,
    }
  }
  const cli = system.clis.codex
  const desktop = system.desktopApps.codex
  return {
    installed: cli.installed || desktop.installed,
    detectionFailed:
      !cli.installed &&
      !desktop.installed &&
      (cli.detectionFailed === true || desktop.detectionFailed === true),
  }
}

function sameNativeRelayUrl(left: string, right: string): boolean {
  try { return new URL(left).href.replace(/\/+$/, '') === new URL(right).href.replace(/\/+$/, '') }
  catch { return false }
}

/**
 * 工具配置可以迁到的线路：设置里的选项已经重启生效，而且线路定下来了（写死一条，或者「自动」
 * 已经查出结论）。「自动」第一次开机还没查出来时不迁，认得出的旧地址原样留着。
 */
function settledRouteLine(settings: AppSettingsV2, siteId: 'solov' | 'solov-api'): RelayEndpointId | null {
  const preference = settings.relayEndpointIds?.[siteId] ?? 'auto'
  if (preference !== settings.activeRelayEndpointIds?.[siteId]) return null
  if (preference !== 'auto') return preference
  const route = settings.relayRouteLines?.[siteId]
  return route?.settled ? route.line : null
}

/**
 * 「自动」查出直连连不上、星芒已经改走默认线路（直连适配第六节第 4 条）。看的是这次运行生效的
 * 那一档：存了别的选项、还没重启时，跑的照旧是「自动」。
 */
export function relayFallbackActive(settings: AppSettingsV2 | null | undefined): boolean {
  const siteId = settings?.relaySiteId ?? 'solov'
  if (!settings || (siteId !== 'solov' && siteId !== 'solov-api')) return false
  const route = settings.relayRouteLines?.[siteId]
  return settings.activeRelayEndpointIds?.[siteId] === 'auto' && route?.settled === true && route.line === 'primary'
}

/** Alias recognition restores identity; only an applied, settled line permits migration. */
function accountRouteMigrationNeeded(
  current: AppConfigSummary['providers'][ProviderId],
  provider: ProviderId,
  settings: AppSettingsV2,
  storage: SourceMarkerStorage | null,
): boolean {
  if (current.configurationOwnership !== 'account' || sourceFor(current, provider, storage) !== 'account'
    || settings.officialProviders?.includes(provider)) return false
  const siteId = settings.relaySiteId ?? 'solov'
  if (siteId !== 'solov' && siteId !== 'solov-api') return false
  const selected = settledRouteLine(settings, siteId)
  if (!selected) return false
  const expected = relayProviderBaseUrls(siteId, selected)[provider]
  if (!sameNativeRelayUrl(current.baseUrl, expected)
    || relaySiteEndpointIdForBaseUrl(siteId, provider, current.actualBaseUrl) === null) return false
  // The retired IP test entry shares the direct id with the domain; the actual address must still migrate.
  return !sameNativeRelayUrl(current.actualBaseUrl, expected)
}

/**
 * 有没有星芒替当前账号写的工具配置还停在这个站另一条线路上、该迁过去（规矩同上）。「自动」
 * 换了线路时用它挑要不要跑一轮迁移：没有要迁的就不去同步 Key。没装的工具也算，多跑一轮不改什么。
 */
export function accountRoutesPending(
  config: AppConfigSummary,
  settings: AppSettingsV2,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): boolean {
  return providerIds.some((provider) => accountRouteMigrationNeeded(config.providers[provider], provider, settings, storage))
}

export function accountBootstrapPlan(
  system: SystemSnapshot,
  config: AppConfigSummary,
  settings: AppSettingsV2,
  mode: AccountBootstrapMode = 'login',
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
  regrouped: readonly ProviderId[] = [],
): AccountBootstrapPlan {
  const explicitOfficial = new Set(settings.officialProviders ?? [])
  const targets: ProviderId[] = []
  const skipped: AccountBootstrapSkip[] = []
  const preferredModels: Partial<Record<ProviderId, string>> = {}
  const shadowRepairs: ProviderId[] = []

  for (const provider of providerIds) {
    const local = installedState(system, provider)
    const current = config.providers[provider]
    if (local.detectionFailed) {
      skipped.push({
        provider,
        reason: 'detection-failed',
        message: `${nameOf(provider)} 的安装状态没有检测完成，暂未改动配置`,
      })
      continue
    }
    if (!local.installed) {
      skipped.push({
        provider,
        reason: 'not-installed',
        message: `${nameOf(provider)} 尚未安装，Key 已保留在账号中`,
      })
      continue
    }

    const source = sourceFor(current, provider, storage)
    const official =
      explicitOfficial.has(provider) ||
      (provider === 'codex' && current.codexAuthMode === 'chatgpt') ||
      (provider === 'gemini' && current.authType === 'oauth-personal') ||
      source === 'official'
    if (official) {
      skipped.push({
        provider,
        reason: 'official',
        message: `${nameOf(provider)} 保留官方账号连接`,
      })
      continue
    }
    if (source === 'manual') {
      skipped.push({
        provider,
        reason: 'manual',
        message: `${nameOf(provider)} 保留手动填写的密钥`,
      })
      continue
    }
    if (source === 'unknown') {
      skipped.push({
        provider,
        reason: 'unknown',
        message: `${nameOf(provider)} 保留来源尚未确认的已有配置`,
      })
      continue
    }
    // 配置被改动过的工具照旧不自动改写，只有用户在首页点名重写时才覆盖。
    if (source === 'changed') {
      if (mode !== 'rewrite') {
        skipped.push({
          provider,
          reason: 'changed',
          message: `${nameOf(provider)} 的配置被改动过，已保留现状`,
        })
        continue
      }
      targets.push(provider)
      const changedModel = current.model.trim()
      if (changedModel) preferredModels[provider] = changedModel
      continue
    }
    // 老配置把当前账号的服务写在 Codex 的内置名下：Codex 不认，打开就 401。地址是当前站、
    // Key 正是当前账号缓存里那把时，没有归属记录也替客户修，不用他点（yoyo 9-30 同意）。
    // 主进程 saveConfig 会再核一遍同样的条件（permitsShadowedCodexRepair），这里只是规划。
    if (source === 'account' && current.configurationOwnership === 'unknown'
      && current.configurationAccountMatched === true && codexNeedsRepair(current, provider)) {
      targets.push(provider)
      shadowRepairs.push(provider)
      const shadowedModel = current.model.trim()
      if (shadowedModel) preferredModels[provider] = shadowedModel
      continue
    }
    if (source === 'account' && current.configurationOwnership !== 'account') {
      // Matching a cached account key restores its badge, not permission to rewrite it.
      const ready = connectionReady(current, provider, storage)
      skipped.push({
        provider,
        reason: ready ? 'configured' : 'unknown',
        message: ready ? `${nameOf(provider)} 已连接星芒账号` : `${nameOf(provider)} 保留已有账号配置，待手动补全`,
      })
      continue
    }
    // 已连好的工具开机时不重写，除非 Key 换了分组，或显式选择的线路已经重启生效。
    if (source === 'account' && mode === 'restore' && connectionReady(current, provider, storage)
      && !regrouped.includes(provider) && !accountRouteMigrationNeeded(current, provider, settings, storage)) {
      skipped.push({
        provider,
        reason: 'configured',
        message: `${nameOf(provider)} 已连接星芒账号`,
      })
      continue
    }

    targets.push(provider)
    const model = current.model.trim()
    if (model) preferredModels[provider] = model
  }

  return { targets, skipped, preferredModels, ...(shadowRepairs.length ? { shadowRepairs } : {}) }
}

/**
 * 写入账号 Key 后复核不通过的原因。集中成一份，是因为同一个失败会在首页横幅、
 * 维护页和客服脚本里被原样引用，散在判断里写就会各说各话。文案以「当前账号」
 * 为主语：用户不需要知道背后连的是哪个站点。
 */
export const configurationFailureMessages = {
  missingKey: '配置文件里没有检测到密钥',
  relayMismatch: '服务地址尚未与当前账号匹配',
  routeMismatch: '连接线路尚未更新，请点「重新同步」',
  missingModel: '默认模型尚未写入配置',
  geminiAuthMode: 'Gemini 尚未切换到 API Key 模式',
  unconfirmedSource: '配置来源尚未确认属于当前账号',
  connectionIncomplete: '工具连接尚未完成',
} as const

export function configurationFailure(
  config: AppConfigSummary,
  provider: ProviderId,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): string | null {
  const current = config.providers[provider]
  if (!current.hasApiKey) return configurationFailureMessages.missingKey
  if (!current.matchesRelay) return configurationFailureMessages.relayMismatch
  if (!current.model.trim()) return configurationFailureMessages.missingModel
  if (provider === 'gemini' && current.authType !== 'gemini-api-key') return configurationFailureMessages.geminiAuthMode
  if (current.configurationOwnership !== 'account' || sourceFor(current, provider, storage) !== 'account') return configurationFailureMessages.unconfirmedSource
  return connectionReady(current, provider, storage) ? null : configurationFailureMessages.connectionIncomplete
}

export function shouldShowAccountBootstrap(config: AppConfigSummary): boolean {
  return providerIds.some(
    (provider) => sourceFor(config.providers[provider], provider) === 'missing',
  )
}

async function assertAccount(
  api: Pick<AccountBootstrapBridge, 'getAccountSession'>,
  expectedUserId: number,
  expectedSiteId?: AccountSiteId,
) {
  const session = await api.getAccountSession()
  if (!session.authenticated || session.account?.userId !== expectedUserId || (expectedSiteId !== undefined && accountSiteId(session) !== expectedSiteId)) {
    throw new Error('星芒账号已变化，已停止本次 Key 配置')
  }
  return accountSiteId(session)
}

export async function bootstrapAccountTools(
  api: AccountBootstrapBridge,
  expectedUserId: number,
  onProgress: (progress: AccountBootstrapProgress) => void = () => undefined,
  mode: AccountBootstrapMode = 'login',
  onlyProviders?: readonly ProviderId[],
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): Promise<AccountBootstrapResult> {
  const expectedSiteId = await assertAccount(api, expectedUserId)
  // Key sync may issue server tokens and update the bundled Skill. If the
  // existing config cannot be read, stop before either side effect; discard
  // this preview and read again after sync when planning local writes.
  await api.getConfig()
  await assertAccount(api, expectedUserId, expectedSiteId)
  onProgress({ phase: 'syncing', label: '正在同步账号专属 Key', percent: 15 })

  let synchronized: Awaited<ReturnType<AccountBootstrapBridge['syncManagedCliKeys']>> | null = null
  let syncError = ''
  try {
    synchronized = await api.syncManagedCliKeys()
  } catch (error) {
    // 这条不是给用户的主提示，而是拼进 warnings 的诊断行（「Key 同步阶段：…」已交代
    // 了场景），所以只脱敏、保留原文，不替换成一句通用文案。
    syncError = userFacingErrorMessage(error) || '账号专属 Key 没有同步完成'
  }

  await assertAccount(api, expectedUserId, expectedSiteId)
  // 先读本次启动的线路与新鲜配置，再宣布哪些工具能先打开，避免带着旧地址抢跑。
  const [config, settings] = await Promise.all([api.getConfig(), api.getSettings()])
  const routeChanges = providerIds.filter((provider) => accountRouteMigrationNeeded(config.providers[provider], provider, settings, storage))
  const keyChanges = mode === 'restore' ? { connectedKeyChanges: [...new Set([...(synchronized?.regrouped ?? []), ...routeChanges])] } : {}
  onProgress({ phase: 'inspecting', label: '正在检查已安装工具和连接来源', percent: 40, ...keyChanges })
  // scanSystem 从不缓存安装状态，无需强制清掉下载源与网络位置缓存。
  const system = await api.scanSystem()
  await assertAccount(api, expectedUserId, expectedSiteId)
  const planned = accountBootstrapPlan(system, config, settings, mode, storage, synchronized?.regrouped ?? [])
  const permitted = onlyProviders ? new Set(onlyProviders) : null
  const plan = permitted
    ? { ...planned, targets: planned.targets.filter((provider) => permitted.has(provider)) }
    : planned

  // 换了连接线路的工具开着也照样改（#941）：以前开着的先不改，客户不关工具、不点「重新同步」，它就一直
  // 停在原来那条线路上。开着的进程要重开才走新地址，写完以后再问它开没开、在首页提示。
  let outcome: Awaited<ReturnType<AccountBootstrapBridge['configureManagedCliKeys']>> = {
    configured: [],
    failed: [],
  }
  if (plan.targets.length) {
    onProgress({
      phase: 'configuring',
      label: `正在为 ${plan.targets.length} 个已安装工具写入 Key`,
      percent: 65,
      ...keyChanges,
    })
    outcome = await api.configureManagedCliKeys({
      providers: plan.targets,
      preferredModels: plan.preferredModels,
      // 被改动过的配置在主进程那一侧也受「来源未确认就不自动改写」拦着，
      // 用户点名的这一次要说清楚是他自己要求的，才能穿过那道闸。
      ...(mode === 'rewrite' ? { intent: 'explicit' as const } : {}),
    })
  }

  await assertAccount(api, expectedUserId, expectedSiteId)
  onProgress({ phase: 'verifying', label: '正在复核 Key、服务地址和模型', percent: 88, ...keyChanges })
  const verified = await api.getConfig()
  await assertAccount(api, expectedUserId, expectedSiteId)

  const configured: ProviderId[] = []
  const failed: Array<{ provider: ProviderId; message: string }> = []
  const markerWarnings: string[] = []
  for (const provider of plan.targets) {
    const reported = outcome.failed.find((entry) => entry.provider === provider)
    if (reported) {
      failed.push({ provider, message: reported.message || '账号 Key 配置失败' })
      continue
    }
    let problem = outcome.configured.includes(provider)
      ? configurationFailure(verified, provider, storage)
      : '账号 Key 配置未返回成功结果'
    if (!problem && routeChanges.includes(provider)
      && !sameNativeRelayUrl(verified.providers[provider].actualBaseUrl, config.providers[provider].baseUrl)) {
      problem = configurationFailureMessages.routeMismatch
    }
    if (problem) {
      failed.push({ provider, message: problem })
      continue
    }
    configured.push(provider)
    const markerWarning = applyManualSourceMarker(
      storage,
      verified.providers[provider].baseUrl,
      provider,
      false,
    )
    if (markerWarning) markerWarnings.push(`${nameOf(provider)}：${markerWarning}`)
  }
  const followed = configured.filter((provider) => routeChanges.includes(provider))
  const routeRestart = followed.length ? await inspectRouteRestart(api, followed) : null
  if (routeRestart) await assertAccount(api, expectedUserId, expectedSiteId)

  const readyKeys = synchronized?.ready.map((entry) => entry.provider) ?? []
  // 没装的工具 Key 签不下来，用户在首页什么也做不了，点「重新同步」也还是那句；
  // 等他真去装的时候，装完那一轮会只针对这个工具再写一次，失败原因在那时报。
  const notInstalled = new Set(
    plan.skipped.filter((entry) => entry.reason === 'not-installed').map((entry) => entry.provider),
  )
  const warnings = [
    ...(syncError ? [`Key 同步阶段：${syncError}`] : []),
    ...markerWarnings,
    ...(synchronized?.storageWarning
      ? [`本机加密缓存：${synchronized.storageWarning}`]
      : []),
    ...(synchronized?.imageSkillWarning
      ? [synchronized.imageSkillWarning]
      : []),
    ...(synchronized?.imageMcpWarning
      ? [synchronized.imageMcpWarning]
      : []),
    ...(synchronized?.failed ?? [])
      .filter(
        (entry) =>
          !notInstalled.has(entry.provider) &&
          !configured.includes(entry.provider) &&
          !failed.some((item) => item.provider === entry.provider),
      )
      .map((entry) => keySyncFailureText(entry.provider, entry.message)),
  ]

  // 只看「这次为什么没写成」的那几条：syncError（整次同步都没发出去）、逐个工具的
  // Key 签发失败、逐个工具的配置失败。加密缓存警告、来源标记警告和图片技能提示
  // 不在其列——它们换个网络也一样，拿来当断网证据会让补跑白跑。
  const failureSignals = [
    ...(syncError ? [syncError] : []),
    ...(synchronized?.failed ?? []).map((entry) => entry.message),
    ...failed.map((entry) => entry.message),
  ]

  const repairedShadowed = configured.filter((provider) => plan.shadowRepairs?.includes(provider))
  return {
    readyKeys,
    configured,
    failed,
    skipped: plan.skipped,
    warnings,
    networkBlocked: networkBlockedFailures(failureSignals),
    ...(repairedShadowed.length ? { repairedShadowed } : {}),
    ...(synchronized?.regrouped?.length
      ? { regrouped: configured.filter((provider) => synchronized?.regrouped?.includes(provider)) }
      : {}),
    ...(routeRestart ? { routeRestart } : {}),
    ...(followed.length ? { routeFollowed: followed } : {}),
  }
}

const bootstrapModeLabels: Record<AccountBootstrapMode, string> = {
  login: '登录后',
  restore: '开机或联网后恢复',
  rewrite: '点名重新写入',
}

const skipReasonLabels: Record<AccountBootstrapSkip['reason'], string> = {
  'not-installed': '未安装',
  'detection-failed': '安装状态没检测完',
  configured: '已连好',
  official: '官方账号',
  manual: '手填密钥',
  unknown: '来源未确认',
  changed: '配置被改动过',
}

export interface AccountBootstrapLogLine {
  level: RendererLogLevel
  message: string
}

/**
 * 「登录了但某个工具没配上」是账号侧最常见的工单，而「配不配」整段在渲染层决定，
 * 主进程那两条通道成功时不记日志。这里把一轮的结论排成一行交给运行日志：写好了
 * 哪几家、哪几家失败、哪几家跳过以及为什么。只写工具名、原因和主进程给的失败
 * 文案，不带 Key、地址或模型（I13）。
 */
export function describeAccountBootstrapResult(
  mode: AccountBootstrapMode,
  result: AccountBootstrapResult,
): AccountBootstrapLogLine {
  const parts = [
    `写好 ${result.configured.length ? result.configured.map(nameOf).join('、') : '无'}`,
  ]
  if (result.failed.length) {
    parts.push(`没写成 ${result.failed.map((entry) => `${nameOf(entry.provider)}（${entry.message}）`).join('、')}`)
  }
  if (result.skipped.length) {
    parts.push(`跳过 ${result.skipped.map((entry) => `${nameOf(entry.provider)}（${skipReasonLabels[entry.reason]}）`).join('、')}`)
  }
  if (result.repairedShadowed?.length) parts.push(`顺手修好 ${result.repairedShadowed.map(nameOf).join('、')} 认不出的连接设置`)
  if (result.routeRestart) parts.push(`跟着换了连接线路，提示重开：${describeRunningTools(result.routeRestart, 'route')}`)
  if (result.networkBlocked) parts.push('被网络拦住，联网后会自动补跑')
  return {
    level: result.failed.length || result.networkBlocked ? 'warn' : 'info',
    message: `Key 自动配置（${bootstrapModeLabels[mode]}）：${parts.join('；')}`,
  }
}

/** 整轮没跑完（账号中途变了、读配置失败）时的那一行。 */
export function describeAccountBootstrapFailure(mode: AccountBootstrapMode, reason: string): AccountBootstrapLogLine {
  return { level: 'warn', message: `Key 自动配置（${bootstrapModeLabels[mode]}）没有完成：${reason}` }
}
