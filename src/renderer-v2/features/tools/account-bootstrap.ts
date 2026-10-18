import { accountScope, accountSiteId, type AccountSiteId } from '../../account-context'
import {
  type AccountSessionState,
  type AppConfigSummary,
  type AppSettingsV2,
  type ProviderId,
  type RelayEndpointId,
  type RendererLogLevel,
  type SystemSnapshot,
  type XingmangApi,
} from '../../../../electron/ipc-contract'
import { tools } from '../../registry/tools'
import { codexNeedsRepair, connectionReady, sourceFor } from './model'
import { userFacingErrorMessage } from '../../business-common'
import { certificateBlockedFailures, networkBlockedFailures } from './online-resync'
import { keySyncFailureText } from './key-sync-failure'
import { relayProviderBaseUrls, relaySiteEndpointIdForBaseUrl } from '../../../../electron/relay-sites'
import { activeProviderIds, isActiveProviderId, type ActiveProviderId } from '../../../../electron/catalog'
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
 * `rewrite` 是用户点名某个工具按「重新写入密钥」时走的那一档：只有它会去覆盖
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

/**
 * 订阅开通后那一轮的结论（App 的 applySubscriptionToTools）：换好的工具名单。该换 Key 的工具没换成
 * （新 Key 没签下来、写配置失败）就抛错，充值页据此说「工具还没换过去」，不说「不用重新设置」（#1079）。
 */
export function subscriptionSwitchResult(result: Pick<AccountBootstrapResult, 'regrouped' | 'keyChangeFailed'> | undefined): ActiveProviderId[] {
  const unswitched = result?.keyChangeFailed ?? []
  if (unswitched.length) throw new Error(`${unswitched.map((entry) => keySyncFailureText(entry.provider, entry.message)).join('；')}。`)
  return result?.regrouped ?? []
}

export interface AccountBootstrapPlan {
  /** 只会是还在用的工具：类型上就排除已下线的那几个，编译器不让它们被交给主进程写 Key。 */
  targets: ActiveProviderId[]
  skipped: AccountBootstrapSkip[]
  preferredModels: Partial<Record<ActiveProviderId, string>>
  /** targets 里那几个 Codex 认不出连接设置、没有归属记录也照样自动修的工具（第十七批 1b）。 */
  shadowRepairs?: ActiveProviderId[]
  /**
   * targets 里只因为换了连接线路才写、Key 沿用配置里那把的几家（#1159）：配置里那把既不是缓存里的托管 Key，
   * 也不是缓存换掉过的，是客户在密钥页、配置窗口自己选的。缺省 = 没有。
   */
  keepKeys?: ActiveProviderId[]
}

export interface AccountBootstrapResult {
  readyKeys: ActiveProviderId[]
  configured: ActiveProviderId[]
  failed: Array<{ provider: ActiveProviderId; message: string }>
  skipped: AccountBootstrapSkip[]
  warnings: string[]
  /**
   * 这一轮没写完，且拦住它的全是网络。断网启动时首页横幅要换一句话，联网之后
   * 还要据此补跑一次（online-resync.ts）。判定放在这里，是因为 Key 同步那一侧的
   * 失败（synchronized.failed）出了这个函数就被拼成 warnings 文本，调用方再想
   * 分辨哪条是网络问题就只能猜。
   */
  networkBlocked: boolean
  /** networkBlocked 里有证书被换掉的：电脑联着网，首页不说「联网后会自动补写」。缺省 = 没有。 */
  networkBlockedByCertificate?: boolean
  /** 这一轮顺手修好的「Codex 认不出」的配置，首页据此轻轻说一句。缺省 = 没有。 */
  repairedShadowed?: ActiveProviderId[]
  /**
   * 这一轮因为 Key 换了分组（买了订阅、订阅到期）而改写的工具，上一轮换了 Key 没写进配置、这一轮补上的
   * 也算（#1079）；缺省 = 没有。
   */
  regrouped?: ActiveProviderId[]
  /**
   * 这一轮该给已连好的工具换 Key（换了分组，或上一轮没写成）却没换成的（#1079）：新 Key 没签下来，
   * 或者写配置失败。订阅开通后据此说「工具还没换过去」，不再说「不用重新设置」。缺省 = 没有。
   */
  keyChangeFailed?: Array<{ provider: ActiveProviderId; message: string }>
  /**
   * 这一轮跟着连接线路改了配置的工具，开没开都算（#941）。只换了线路的那几个首页不说「已完成…」
   * （bootstrapOnlyFollowedRoute），运行日志照记。缺省 = 这一轮没改线路。
   */
  routeFollowed?: ActiveProviderId[]
  /**
   * 星芒画图没装进工具、只因为这台电脑没有 Node.js 时主进程给的那句。不放进 warnings：说不说要跟着
   * 首页运行环境卡对 Node.js 的说法走（Home 的 homeBootstrapWarnings）。缺省 = 没这回事。
   */
  drawingNeedsNode?: string
}

export type AccountBootstrapBridge = Pick<
  XingmangApi,
  | 'syncManagedCliKeys'
  | 'scanSystem'
  | 'getConfig'
  | 'getSettings'
  | 'configureManagedCliKeys'
  | 'getAccountSession'
>

function activeEntries<T extends { provider: ProviderId }>(entries: readonly T[]): Array<T & { provider: ActiveProviderId }> {
  return entries.filter((entry): entry is T & { provider: ActiveProviderId } => isActiveProviderId(entry.provider))
}

function nameOf(provider: ProviderId) {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

/**
 * 这一轮写好的全是跟着连接线路换个地址的：Key 没换、客户也没点什么，首页就不说「已完成…」（yoyo 10-8：
 * 线路的事不要太多提示）。换了分组的不算，那是 Key 真换了。
 */
export function bootstrapOnlyFollowedRoute(result: Pick<AccountBootstrapResult, 'configured' | 'routeFollowed' | 'regrouped'>): boolean {
  return result.configured.length > 0
    && result.configured.every((provider) => result.routeFollowed?.includes(provider) && !result.regrouped?.includes(provider))
}

/**
 * 主进程说「会话变了」时，正在跑的那一轮 Key 同步还算不算数：还是同一个账号就接着算，换了账号、
 * 退出登录才作废。登录成功后主进程要把手上的事忙完才发这一条，常常晚于界面已经开跑的那一轮登录同步；
 * 以前一律作废，那一轮的结果被扔掉，引导页一直停在「正在同步账号专属密钥」、按钮全灰，要等别的事
 * 碰巧再跑一轮才解开。
 */
export function sessionChangeKeepsBootstrap(
  inFlightScope: string | null | undefined,
  next: Pick<AccountSessionState, 'authenticated' | 'account' | 'siteId' | 'realmId'>,
): boolean {
  return Boolean(inFlightScope && next.authenticated && next.account && accountScope(next) === inFlightScope)
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
  // 星芒账号的工具配置跟的是工具线路（xm 三线路），它可以和管理工具自己走的那条不一样；没有这一项的老主进程照旧。
  const route = siteId === 'solov' && settings.relayToolRouteLines ? settings.relayToolRouteLines.solov : settings.relayRouteLines?.[siteId]
  return route?.settled ? route.line : null
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
  // 星芒账号换线路由主进程定点只改地址（xm 三线路 C9，system-service 的 followToolRoutes），这里不再因为
  // 「线路不同」整份重写；服务状态文件切回老办法（R6）时照旧。历史账号不变。
  if (siteId === 'solov' && settings.toolRouteRewrite !== 'merge') return false
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
  return activeProviderIds.some((provider) => accountRouteMigrationNeeded(config.providers[provider], provider, settings, storage))
}

/**
 * 已连好的工具里，配置那把 Key 是本机缓存以前给它、后来换掉的那把（#1079）：上一轮换了分组（买了订阅、
 * 订阅到期、分组改名）或重签了 Key，新 Key 存进了缓存，写配置那一步却没成（拉型号时网络抖、写文件出错、
 * 写到一半关了软件）。下一轮缓存里的分组已经对上，主进程不再报「换了分组」，以前就一直当「已连好」
 * 跳过，工具拿着旧 Key 接着扣余额。
 * 只认星芒替当前账号写下、之后没人动过的配置（来源记录对得上）；手填、被改过的照旧不碰。「不是缓存里
 * 眼下那把」不够：客户在密钥页、配置窗口自己选的账号密钥也不是，那样会每次开机都被换回自动那把（#1153），
 * 所以要主进程认出它确实是缓存换掉过的（configurationKeyReplaced）。这一轮同步没跑成、缓存没存上、
 * 缓存里没有这家工具的 Key 时一概不认：那时读到的缓存说明不了配置旧了，认了会每次开机都重写一遍。
 */
export function staleAccountKeys(
  config: AppConfigSummary,
  synchronized: Pick<Awaited<ReturnType<AccountBootstrapBridge['syncManagedCliKeys']>>, 'ready' | 'storageWarning'> | null,
): ActiveProviderId[] {
  if (!synchronized || synchronized.storageWarning || config.ownershipPending) return []
  return activeProviderIds.filter((provider) => {
    const current = config.providers[provider]
    return current.configurationOwnership === 'account' && current.hasApiKey && current.matchesRelay
      && current.configurationKeyReplaced === true
      && synchronized.ready.some((entry) => entry.provider === provider)
  })
}

export function accountBootstrapPlan(
  system: SystemSnapshot,
  config: AppConfigSummary,
  settings: AppSettingsV2,
  mode: AccountBootstrapMode = 'login',
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
  keyChanges: readonly ProviderId[] = [],
): AccountBootstrapPlan {
  const explicitOfficial = new Set(settings.officialProviders ?? [])
  const targets: ActiveProviderId[] = []
  const skipped: AccountBootstrapSkip[] = []
  const preferredModels: Partial<Record<ActiveProviderId, string>> = {}
  const shadowRepairs: ActiveProviderId[] = []
  const keepKeys: ActiveProviderId[] = []

  // 已下线的工具（Gemini）配置里还留着，这里一概不碰：不签 Key、不写配置、不算「没装」。
  for (const provider of activeProviderIds) {
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
        message: `${nameOf(provider)} 尚未安装，密钥已保留在账号中`,
      })
      continue
    }

    const source = sourceFor(current, provider, storage)
    const official =
      explicitOfficial.has(provider) ||
      (provider === 'codex' && current.codexAuthMode === 'chatgpt') ||
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
        message: ready ? `${nameOf(provider)} 已经连着当前账号，这次没有改动` : `${nameOf(provider)} 保留已有账号配置，待手动补全`,
      })
      continue
    }
    // 已连好的工具开机时不重写，除非 Key 换了分组或上一轮没写成（keyChanges），或显式选择的线路已经重启生效。
    if (source === 'account' && mode === 'restore' && connectionReady(current, provider, storage)
      && !keyChanges.includes(provider)) {
      if (!accountRouteMigrationNeeded(current, provider, settings, storage)) {
        skipped.push({
          provider,
          reason: 'configured',
          message: `${nameOf(provider)} 已连接当前账号`,
        })
        continue
      }
      // 只为换线路写的这一轮，配置里那把不是自动签的（缓存里眼下那把、缓存换掉过的都不是）：客户在密钥页、
      // 配置窗口自己选的，Key 原样留着只换地址，不然额度上限、扣费分组跟着线路一换就悄悄变了（#1159）。
      // 换了分组的（keyChanges）不走这里，买了订阅照旧换进订阅分组。
      if (current.configurationAccountMatched !== true && current.configurationKeyReplaced !== true) keepKeys.push(provider)
    }

    targets.push(provider)
    const model = current.model.trim()
    if (model) preferredModels[provider] = model
  }

  return {
    targets,
    skipped,
    preferredModels,
    ...(shadowRepairs.length ? { shadowRepairs } : {}),
    ...(keepKeys.length ? { keepKeys } : {}),
  }
}

/**
 * 写入账号 Key 后复核不通过的原因。集中成一份，是因为同一个失败会在首页横幅、
 * 维护页和客服脚本里被原样引用，散在判断里写就会各说各话。文案以「当前账号」
 * 为主语：用户不需要知道背后连的是哪个站点。
 */
export const configurationFailureMessages = {
  missingKey: '配置文件里没有检测到密钥',
  relayMismatch: '服务地址尚未与当前账号匹配',
  missingModel: '默认模型尚未写入配置',
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
  if (current.configurationOwnership !== 'account' || sourceFor(current, provider, storage) !== 'account') return configurationFailureMessages.unconfirmedSource
  return connectionReady(current, provider, storage) ? null : configurationFailureMessages.connectionIncomplete
}

export function shouldShowAccountBootstrap(config: AppConfigSummary): boolean {
  return activeProviderIds.some(
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
    throw new Error('账号已变化，已停止本次密钥配置')
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
  onProgress({ phase: 'syncing', label: '正在同步账号专属密钥', percent: 15 })

  let synchronized: Awaited<ReturnType<AccountBootstrapBridge['syncManagedCliKeys']>> | null = null
  let syncError = ''
  try {
    synchronized = await api.syncManagedCliKeys()
  } catch (error) {
    // 这条不是给用户的主提示，而是拼进 warnings 的诊断行（「密钥同步阶段：…」已交代
    // 了场景），所以只脱敏、保留原文，不替换成一句通用文案。
    syncError = userFacingErrorMessage(error) || '账号专属密钥没有同步完成'
  }

  await assertAccount(api, expectedUserId, expectedSiteId)
  // 先读本次启动的线路与新鲜配置，再宣布哪些工具能先打开，避免带着旧地址抢跑。
  const [config, settings] = await Promise.all([api.getConfig(), api.getSettings()])
  const routeChanges = activeProviderIds.filter((provider) => accountRouteMigrationNeeded(config.providers[provider], provider, settings, storage))
  // 这一轮换了分组的，加上上一轮换了 Key 没写进配置的（#1079）：开机恢复时已连好也照样重写。登录、点名重写两档本来就重写。
  const stale = mode === 'restore' ? staleAccountKeys(config, synchronized) : []
  const keyChanges = [...new Set([...(synchronized?.regrouped ?? []), ...stale])]
  const connectedChanges = mode === 'restore' ? { connectedKeyChanges: [...new Set([...keyChanges, ...routeChanges])] } : {}
  onProgress({ phase: 'inspecting', label: '正在检查已安装工具和连接来源', percent: 40, ...connectedChanges })
  // scanSystem 从不缓存安装状态，无需强制清掉下载源与网络位置缓存。
  const system = await api.scanSystem()
  await assertAccount(api, expectedUserId, expectedSiteId)
  const planned = accountBootstrapPlan(system, config, settings, mode, storage, keyChanges)
  const permitted = onlyProviders ? new Set(onlyProviders) : null
  const plan = permitted
    ? {
        ...planned,
        targets: planned.targets.filter((provider) => permitted.has(provider)),
        keepKeys: planned.keepKeys?.filter((provider) => permitted.has(provider)),
      }
    : planned
  const keepKeys = plan.keepKeys?.length ? { keepKeys: plan.keepKeys } : {}

  // 换了连接线路的工具开着也照样改（#941）：以前开着的先不改，客户不关工具、不点「重新同步」，它就一直
  // 停在原来那条线路上。开着的进程重开以后就走新地址；线路的事不在首页提示（yoyo 10-8）。
  let outcome: Awaited<ReturnType<AccountBootstrapBridge['configureManagedCliKeys']>> = {
    configured: [],
    failed: [],
  }
  if (plan.targets.length) {
    onProgress({
      phase: 'configuring',
      label: `正在给 ${plan.targets.length} 个工具写入密钥`,
      percent: 65,
      ...connectedChanges,
    })
    outcome = await api.configureManagedCliKeys({
      providers: plan.targets,
      preferredModels: plan.preferredModels,
      // 被改动过的配置在主进程那一侧也受「来源未确认就不自动改写」拦着，
      // 用户点名的这一次要说清楚是他自己要求的，才能穿过那道闸。
      ...(mode === 'rewrite' ? { intent: 'explicit' as const } : {}),
      ...keepKeys,
    })
  }

  await assertAccount(api, expectedUserId, expectedSiteId)
  onProgress({ phase: 'verifying', label: '正在复核密钥、服务地址和模型', percent: 88, ...connectedChanges })
  const verified = await api.getConfig()
  await assertAccount(api, expectedUserId, expectedSiteId)

  const configured: ActiveProviderId[] = []
  const failed: Array<{ provider: ActiveProviderId; message: string }> = []
  const markerWarnings: string[] = []
  for (const provider of plan.targets) {
    const reported = outcome.failed.find((entry) => entry.provider === provider)
    if (reported) {
      failed.push({ provider, message: reported.message || '账号密钥配置失败' })
      continue
    }
    let problem = outcome.configured.includes(provider)
      ? configurationFailure(verified, provider, storage)
      : '账号密钥配置未返回成功结果'
    // 说是写好了、地址却还在原来那条线路上：照「服务地址没对上」说，不另提线路（yoyo 10-8）。
    if (!problem && routeChanges.includes(provider)
      && !sameNativeRelayUrl(verified.providers[provider].actualBaseUrl, config.providers[provider].baseUrl)) {
      problem = configurationFailureMessages.relayMismatch
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

  // 主进程不再替已下线的工具签 Key；万一回来的结果里还带着它，这里也不说、不算。
  const readyKeys = (synchronized?.ready ?? []).map((entry) => entry.provider).filter(isActiveProviderId)
  const syncFailed = activeEntries(synchronized?.failed ?? [])
  // 没装的工具 Key 签不下来，用户在首页什么也做不了，点「重新同步」也还是那句；
  // 等他真去装的时候，装完那一轮会只针对这个工具再写一次，失败原因在那时报。
  const notInstalled = new Set(
    plan.skipped.filter((entry) => entry.reason === 'not-installed').map((entry) => entry.provider),
  )
  const warnings = [
    ...(syncError ? [`密钥同步阶段：${syncError}`] : []),
    ...markerWarnings,
    ...(synchronized?.storageWarning
      ? [`本机加密缓存：${synchronized.storageWarning}`]
      : []),
    ...(synchronized?.imageSkillWarning
      ? [synchronized.imageSkillWarning]
      : []),
    ...(synchronized?.imageMcpWarning && !synchronized.imageMcpNeedsNode
      ? [synchronized.imageMcpWarning]
      : []),
    ...syncFailed
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
    ...syncFailed.map((entry) => entry.message),
    ...failed.map((entry) => entry.message),
  ]

  const repairedShadowed = configured.filter((provider) => plan.shadowRepairs?.includes(provider))
  const keyChangeFailed = [
    ...failed.filter((entry) => keyChanges.includes(entry.provider)),
    // 已连好、这一轮却签不出新 Key 的：缓存里没有能接着用的那把才会去签（换了分组、缓存丢了），配置里还是旧那把。
    ...syncFailed
      .filter((entry) => plan.skipped.some((skip) => skip.provider === entry.provider && skip.reason === 'configured'))
      .map(({ provider, message }) => ({ provider, message })),
  ]
  return {
    readyKeys,
    configured,
    failed,
    skipped: plan.skipped,
    warnings,
    networkBlocked: networkBlockedFailures(failureSignals),
    ...(certificateBlockedFailures(failureSignals) ? { networkBlockedByCertificate: true } : {}),
    ...(repairedShadowed.length ? { repairedShadowed } : {}),
    ...(keyChanges.length
      ? { regrouped: configured.filter((provider) => keyChanges.includes(provider)) }
      : {}),
    ...(keyChangeFailed.length ? { keyChangeFailed } : {}),
    ...(followed.length ? { routeFollowed: followed } : {}),
    ...(synchronized?.imageMcpWarning && synchronized.imageMcpNeedsNode
      ? { drawingNeedsNode: synchronized.imageMcpWarning }
      : {}),
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
  if (result.routeFollowed?.length) parts.push(`跟着换了连接线路：${result.routeFollowed.map(nameOf).join('、')}`)
  // 证书被换掉时电脑一直联着网，等不来「联网」事件，这一轮只能等客户点「重新同步」。
  if (result.networkBlocked) parts.push(result.networkBlockedByCertificate ? '被网络拦住（证书被换掉），等客户点「重新同步」' : '被网络拦住，联网后会自动补跑')
  return {
    level: result.failed.length || result.networkBlocked ? 'warn' : 'info',
    message: `Key 自动配置（${bootstrapModeLabels[mode]}）：${parts.join('；')}`,
  }
}

/** 整轮没跑完（账号中途变了、读配置失败）时的那一行。 */
export function describeAccountBootstrapFailure(mode: AccountBootstrapMode, reason: string): AccountBootstrapLogLine {
  return { level: 'warn', message: `Key 自动配置（${bootstrapModeLabels[mode]}）没有完成：${reason}` }
}
