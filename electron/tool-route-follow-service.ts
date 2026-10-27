// 换线路时定点改写命令行工具配置的那一段（#1070 第 3 步，从 system-service.ts 的 createSystemService 原样搬来）：
// 星芒账号换了线路以后，替当前账号写进各家工具的那份只改地址；改不动的过一会儿再试，改完一分钟回头看有没有被
// 别的程序改回去，要重开才生效的给首页一条提示（半小时内有效）。历史账号不走这里。
//
// 各簇共用的那份在 system-service-context.ts；哪些工具开着、撤掉外部客户端那边的定时由 createSystemService 传进来
// （ToolRouteFollowServiceDependencies）。这里只 import system-service.ts 的类型。
import type { AppSettings } from './app-settings'
import { activeProviderIds, type ProviderId } from './catalog'
import {
  applyProviderRouteFollow,
  type NativeConfigInspection,
  type NativeConfigSummary,
  planProviderRouteFollow,
} from './config-files'
import {
  type RelayEndpointId,
  relayProviderBaseUrlEquals,
  relaySiteEndpointIdForBaseUrl,
  relaySiteExactEndpointIdForBaseUrl,
} from './relay-sites'
import {
  emptyRunningToolsReport,
  type RunningToolsReport,
  type ToolRouteRestartHint,
  toolRouteRestartNeeds,
} from './running-tools'
import type { ToolRouteAccountHooks, ToolRouteFollowReport, ToolRouteFollowRequest } from './system-service'
import type { ServiceContext } from './system-service-context'
import { toolConfigIdentity } from './tool-config-ownership'
import {
  recordToolRouteRevert,
  type ToolRouteFollowRecord,
  toolRouteHintDue,
  toolRouteRetryAllowed,
  toolRouteRetryDelayMs,
} from './tool-route-follow-state'
import { followXingmangAiSkillRoute } from './xingmang-ai-skill'

/** 线路跟随要用、但归别处管的几样，由 createSystemService 传进来。 */
export interface ToolRouteFollowServiceDependencies {
  /** 哪些工具正开着（首页检测那边），决定改完要不要提示重开。 */
  inspectRunningTools: (providers: readonly ProviderId[]) => Promise<RunningToolsReport>
  /** 星芒退出时连外部客户端那边等着回头看的定时一起撤掉。 */
  cancelPendingExternalRouteRecheck: () => void
}

export function createToolRouteFollowService(context: ServiceContext, dependencies: ToolRouteFollowServiceDependencies) {
  const {
    store, serviceOptions, platform, providerRoots, runtimeLog, configOwnership, toolRouteFollow,
    serializeConfigWrite, relayRouting, activeRelaySite, inspectNativeProviderConfig, credentialFailureReason,
    toolLaunchedAt, toolRouteRestartPending, toolRouteNow, scheduleToolRouteTimer, untouchedSince,
  } = context
  const {
    inspectRunningTools,
    cancelPendingExternalRouteRecheck,
  } = dependencies

  // ---- 换线路时定点改写工具配置（xm 三线路 C9、C10、C11、C19） ----
  //
  // 只管星芒账号（solov）；历史账号照旧由渲染层 followRelayRoute 走整份写入，一行不改（重开提示见 noteRouteFollowRestart）。地址取的是
  // relayRouting 这次运行生效的线路（开机定下的偏好，设置里改了没重启的不算），所以「改了设置没重启」
  // 那段时间工具配置照样跟着当前生效的线路走（(f)）。和整份写入排同一个 serializeConfigWrite 队。
  let toolRouteAccount: ToolRouteAccountHooks | null = null
  let toolRouteRestartHint: ToolRouteRestartHint | null = null
  let toolRouteRestartHintAt = 0
  // 暂时性失败已经连着失败了几次；换线或重启从头算。
  const toolRouteFailures = new Map<ProviderId, number>()
  let cancelToolRouteRetry: (() => void) | null = null
  let cancelToolRouteVerify: (() => void) | null = null
  // 提示只在出来以后半小时内给界面：窗口晚开、重载时还能看到，过了就是旧事。
  const toolRouteHintTtlMs = 30 * 60 * 1000
  // 改完一分钟回头看一眼有没有被别的程序改回去（cc-switch 这类会在几秒内改回）。
  const toolRouteVerifyDelayMs = 60 * 1000

  function toolRouteRewriteMode(): 'targeted' | 'merge' {
    return serviceOptions.getToolRouteRewriteMode?.() === 'merge' ? 'merge' : 'targeted'
  }

  async function writeToolRouteRecord(provider: ProviderId, update: (record: ToolRouteFollowRecord) => ToolRouteFollowRecord): Promise<void> {
    try {
      const state = toolRouteFollow.read()
      state.providers[provider] = update(state.providers[provider] ?? {})
      await toolRouteFollow.write(state)
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.record-failed', '换线路的跟随记录没能写下，不影响工具使用', { provider, reason: credentialFailureReason(error) })
    }
  }

  type ToolRouteOutcome = 'rewritten' | 'on-target' | 'skipped' | 'retry'

  /** 一个工具。已经在 serializeConfigWrite 里。 */
  async function followProviderToolRoute(provider: ProviderId, owner: string, request: ToolRouteFollowRequest, attempt: number): Promise<ToolRouteOutcome> {
    if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) return 'skipped'
    if (store.read().officialProviders?.includes(provider)) return 'skipped'
    const site = activeRelaySite()
    if (site.id !== 'solov') return 'skipped'
    const before = inspectNativeProviderConfig(provider)
    const record = toolRouteFollow.read().providers[provider] ?? {}
    if (record.managedElsewhere) return 'skipped'
    const ownership = configOwnership.read(provider, before, owner)
    // 上回改完又变回改之前那一份（那一份当时确认是当前账号的）：多半是别的配置管理器在替客户维护它。
    const reverted = ownership === 'changed' && record.revertIdentity === toolConfigIdentity(before)
    // 来源不是当前账号（手填、被改过、看不出来）不自动改，重试多少次也一样，不排重试。
    if (!reverted && ownership !== 'account') return 'skipped'
    const templateRevision = configOwnership.templateRevision(provider, before)
    const target = site.providerBaseUrls[provider]
    let plan: ReturnType<typeof planProviderRouteFollow>
    try {
      plan = planProviderRouteFollow(provider, site.id, target, providerRoots)
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.follow-failed', '工具配置这次没读成，稍后再换线路', { provider, kind: 'tool', reason: credentialFailureReason(error), attempt })
      return 'retry'
    }
    if (plan.status === 'unlocated') {
      runtimeLog?.log('info', 'config', 'route.unlocated', '工具配置里找不到要改的那一处地址，这次不改', { provider })
    }
    if (reverted && plan.status === 'on-target') {
      // 改回去的那份正好就在现在的线路上（线路也切回来了）：不算拉锯，把来源记回当前账号。
      await configOwnership.write(provider, before, 'account', owner, templateRevision ?? undefined)
      return 'on-target'
    }
    if (plan.status !== 'rewrite') return plan.status === 'on-target' ? 'on-target' : 'skipped'
    if (reverted) {
      // 再改一次；24 小时内第二次就停手，首页标「由其他工具管理」。
      const next = recordToolRouteRevert(record, toolRouteNow())
      await writeToolRouteRecord(provider, () => next)
      if (next.managedElsewhere) {
        runtimeLog?.log('warn', 'config', 'route.managed-elsewhere', '工具配置被别的软件改回过两次，不再自动换线路', { provider })
        return 'skipped'
      }
      runtimeLog?.log('warn', 'config', 'route.reverted', '工具配置换完线路又被改了回去，再换一次', { provider })
    }
    // 迁移前原件：第一次定点改写之前整套备份一次，「设置 › 备份迁移」里能找回。备份不成照旧换线路（连不上
    // 的线路比少一份备份要紧），下回再补。
    let originalKept = record.originalKept === true
    if (!originalKept && toolRouteAccount) {
      try {
        await toolRouteAccount.backup(provider)
        originalKept = true
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'route.original-backup-failed', '换线路前的原件没能备份，下次再补', { provider, reason: credentialFailureReason(error) })
      }
    }
    // 同 saveConfig：写之前先记成「手动」，写到一半崩掉宁可多挡一次自动写入。模板版本号原样带回去，
    // 不然下次开机会当成模板落后，再整套备份、补一遍缺省项、弹一句「已补齐」。
    const restoreOwnership = configOwnership.remember(provider, before)
    async function putOwnershipBack(): Promise<void> {
      if (!restoreOwnership) return
      await restoreOwnership().catch((error: unknown) => {
        runtimeLog?.log('warn', 'config', 'ownership.restore-failed', '换线路没成功，工具配置的来源记录也没能原样放回', { provider, reason: credentialFailureReason(error) })
      })
    }
    await configOwnership.write(provider, before, 'manual', owner)
    const from = relaySiteEndpointIdForBaseUrl(site.id, provider, plan.from)
    const to = relaySiteEndpointIdForBaseUrl(site.id, provider, target)
    const detail = { provider, kind: 'tool', from, to, reason: request.reason, ...(request.fault ? { fault: true } : {}), mode: 'targeted', attempt }
    try {
      applyProviderRouteFollow(provider, plan, providerRoots)
    } catch (error) {
      if (untouchedSince(provider, before)) await putOwnershipBack()
      runtimeLog?.log('warn', 'config', 'route.follow-failed', '工具配置这次没换成线路，稍后再试', { ...detail, reason: credentialFailureReason(error) })
      return 'retry'
    }
    const after = inspectNativeProviderConfig(provider)
    if (!relayProviderBaseUrlEquals(after.actualBaseUrl, target)) {
      await putOwnershipBack()
      runtimeLog?.log('warn', 'config', 'route.followed', '工具配置写了，回读出来的地址不对，稍后再试', { ...detail, readback: false })
      return 'retry'
    }
    await configOwnership.write(provider, after, 'account', owner, templateRevision ?? undefined)
    await writeToolRouteRecord(provider, (current) => ({
      ...current, revertIdentity: toolConfigIdentity(before), ...(originalKept ? { originalKept: true } : {}),
    }))
    // 客服从日志看得出工具配置是什么时候、从哪条线路换到哪条的：只记线路 id，不记地址。
    runtimeLog?.log('info', 'config', 'route.followed', '工具配置已换到当前连接线路', { ...detail, readback: true })
    return 'rewritten'
  }

  async function followSkillToolRoute(): Promise<void> {
    const site = activeRelaySite()
    if (site.id !== 'solov' || !toolRouteAccount) return
    try {
      const rewritten = await followXingmangAiSkillRoute({
        userHome: providerRoots.userHome,
        siteId: site.id,
        baseUrl: new URL(site.providerBaseUrls.claude).origin,
        ownedKeyIds: await toolRouteAccount.ownedKeyIds(),
      })
      if (rewritten) runtimeLog?.log('info', 'config', 'route.followed', 'images 的连接地址已换到当前线路', { provider: 'skill', kind: 'tool', count: rewritten, mode: 'targeted' })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.follow-failed', 'images 的连接地址这次没换成', { provider: 'skill', kind: 'tool', reason: credentialFailureReason(error) })
    }
  }

  function scheduleToolRouteRetry(providers: readonly ProviderId[]): void {
    const due = providers.filter((provider) => {
      const failures = (toolRouteFailures.get(provider) ?? 0) + 1
      toolRouteFailures.set(provider, failures)
      if (toolRouteRetryAllowed(failures)) return true
      runtimeLog?.log('warn', 'config', 'route.retry-exhausted', '工具配置换线路连着失败了 12 次，等下次换线或重启再试', { provider })
      return false
    })
    if (!due.length || cancelToolRouteRetry) return
    cancelToolRouteRetry = scheduleToolRouteTimer(() => {
      cancelToolRouteRetry = null
      void followToolRoutes({ reason: 'retry', providers: [...toolRouteFailures.keys()] })
    }, toolRouteRetryDelayMs)
  }

  /**
   * 因为连不上换的线路，开着的工具要重开才走新线路（C10）。同一个工具 24 小时最多弹一次，之后、或者
   * 客户关了提示，只在首页标「需重开生效」。Claude Code 每次请求都重读配置，不提。
   * cause = payload-too-large：Codex 有个对话在线路 1 上太大、换到了线路 2（codex-payload-limit.ts），只说 Codex，
   * 不管 24 小时一次、也不管提示关没关：不说的话客户不知道那个对话为什么一直发不出去。
   */
  async function noteToolRouteRestart(rewritten: readonly ProviderId[], cause?: 'payload-too-large'): Promise<boolean> {
    const payload = cause === 'payload-too-large'
    const candidates = rewritten.filter((provider) => payload ? provider === 'codex' : provider !== 'claude')
    if (!candidates.length) return false
    let report: RunningToolsReport
    try {
      report = await (serviceOptions.inspectRunningToolsForRouteHint ?? inspectRunningTools)(candidates)
    } catch {
      report = { ...emptyRunningToolsReport, unknown: [...candidates], codexDesktopRunning: candidates.includes('codex') ? null : false }
    }
    const needs = toolRouteRestartNeeds(candidates, report, { geminiLaunched: toolLaunchedAt.has('gemini'), platform })
    const tools = (['codex', 'gemini', 'grok'] as const).filter((provider) => needs[provider] !== undefined)
    if (!tools.length) return false
    const now = toolRouteNow()
    const enabled = payload || store.read().toolRouteRestartHints !== false
    const records = toolRouteFollow.read().providers
    const hinted = tools.filter((provider) => enabled && (payload || toolRouteHintDue(records[provider], now)))
    for (const provider of tools) if (!hinted.includes(provider)) toolRouteRestartPending.add(provider)
    if (!hinted.length) return true
    // 渲染层按 id 只弹一次：紧跟着上一条出的也要分得开。
    const hint: ToolRouteRestartHint = { id: Math.max(now, (toolRouteRestartHint?.id ?? 0) + 1), ...(payload ? { cause } : {}) }
    if (hinted.includes('codex')) hint.codex = needs.codex
    if (hinted.includes('gemini')) hint.gemini = needs.gemini
    if (hinted.includes('grok')) hint.grok = needs.grok
    toolRouteRestartHint = hint
    toolRouteRestartHintAt = now
    for (const provider of hinted) await writeToolRouteRecord(provider, (current) => ({ ...current, hintAt: now }))
    runtimeLog?.log('info', 'config', 'route.restart-hint', payload ? 'Codex 有个对话太大、换到了线路2，提示客户重开 Codex' : '连接线路因为连不上换了，提示客户重开工具', {
      providers: hinted, tagged: tools.filter((provider) => !hinted.includes(provider)), ...(payload ? { cause } : {}),
    })
    return true
  }

  /**
   * Codex 有个对话在线路 1 上太大、换到（或者本来就在）线路 2 以后（codex-payload-limit.ts）：Codex 的配置真在线路 2
   * 上才提示「重开 Codex 接着聊」；不在（客户自己管的配置、切回了官方账号）返回 false，由那边改说「新开对话」。
   */
  async function noteCodexPayloadRestart(): Promise<boolean> {
    if (store.read().officialProviders?.includes('codex')) return false
    const site = activeRelaySite()
    const current = inspectNativeProviderConfig('codex')
    if (!current.actualBaseUrl || relaySiteExactEndpointIdForBaseUrl(site.id, 'codex', current.actualBaseUrl) !== 'direct') return false
    if (!await noteToolRouteRestart(['codex'], 'payload-too-large')) return false
    serviceOptions.onToolRouteFollowed?.()
    serviceOptions.onCodexPayloadRestart?.()
    return true
  }

  // 历史账号的工具配置跟应用线路走，换了以后由界面整份写入跟过去（saveConfig 的 followedRoute），不走上面的
  // 定点改写，以前因此一直不提示重开（#1061 第 2 条）。这一轮写完（noteRouteFollowRestart）再一次说完，只说这一轮
  // 自己写的那几家：同时跑着的另一轮（客户自己点的换来源、换账号）不会把它们提前说掉。记着是哪个账号写的：账号
  // 中途换了，那一轮整轮作废、走不到说完那一步，留下的不带到下一个账号那一轮。
  const accountRouteFollowed = new Map<ProviderId, string | null>()

  /**
   * 整份写入跟过去的这条线路，是不是半小时内「自动」换过来的那条、为什么换的：fault = 连不上；payload = Codex 有个
   * 对话在线路 1 上太大（codex-payload-limit.ts）。按换线时刻算、不按这次运行：上次运行刚换完线就退出、这次开机才
   * 跟过去的也算；更早的、写死线路的、切回先走那条的不算。
   */
  function accountRouteFollowCause(siteId: string, line: RelayEndpointId): 'fault' | 'payload' | null {
    // 星芒账号由 followToolRoutes 自己提示（R6 切回整份写入时它的工具线路也不在应用线路这里）。
    if (siteId !== 'solov-api') return null
    const change = serviceOptions.relayRouteLastChange?.(siteId)
    if (!change || change.to !== line) return null
    const cause = change.reason === 'health-failed' || change.reason === 'line-down' ? 'fault' as const
      : change.reason === 'payload-too-large' ? 'payload' as const : null
    const age = toolRouteNow() - change.at
    return cause && age >= 0 && age < toolRouteHintTtlMs ? cause : null
  }

  function accountRouteFaultFollowed(siteId: string, line: RelayEndpointId): boolean {
    return accountRouteFollowCause(siteId, line) !== null
  }

  async function noteRouteFollowRestart(written: readonly ProviderId[]): Promise<void> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const followed = written.filter((provider) => accountRouteFollowed.has(provider) && accountRouteFollowed.get(provider) === owner)
    for (const provider of written) accountRouteFollowed.delete(provider)
    if (!followed.length) return
    // 记进 accountRouteFollowed 的都跟的是最近那次换线（config-save-service.ts 按 accountRouteFaultFollowed 记）。
    const siteId = activeRelaySite().id
    const change = siteId === 'solov-api' ? serviceOptions.relayRouteLastChange?.(siteId) : null
    const payload = change ? accountRouteFollowCause(siteId, change.to) === 'payload' : false
    // 配置已经写好了：提示没出成只进日志，不能把这一轮写入算成失败。
    try {
      // Codex 对话太大换的线路只说 Codex（别的工具在线路 1 上本来就能用），Codex 这一轮没跟过去就不说。
      if (payload) {
        if (followed.includes('codex')) await noteCodexPayloadRestart()
      } else if (await noteToolRouteRestart(followed)) serviceOptions.onToolRouteFollowed?.()
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.restart-hint-failed', '换线路的重开提示这次没出成，不影响工具使用', { providers: followed, reason: credentialFailureReason(error) })
    }
  }

  async function followToolRoutes(request: ToolRouteFollowRequest): Promise<ToolRouteFollowReport> {
    if (activeRelaySite().id !== 'solov' || toolRouteRewriteMode() === 'merge') return { rewritten: [] }
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (!owner) return { rewritten: [] }
    if (request.reason === 'route-changed' || request.reason === 'startup') {
      toolRouteFailures.clear()
      cancelToolRouteRetry?.()
      cancelToolRouteRetry = null
    }
    const rewritten: ProviderId[] = []
    const failed: ProviderId[] = []
    for (const provider of request.providers ?? activeProviderIds) {
      const attempt = request.reason === 'retry' ? toolRouteFailures.get(provider) ?? 0 : 0
      let outcome: ToolRouteOutcome
      try {
        outcome = await serializeConfigWrite(() => followProviderToolRoute(provider, owner, request, attempt))
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'route.follow-failed', '工具配置这次没换成线路，稍后再试', { provider, kind: 'tool', reason: credentialFailureReason(error), attempt })
        outcome = 'retry'
      }
      if (outcome === 'retry') failed.push(provider)
      else toolRouteFailures.delete(provider)
      if (outcome === 'rewritten') {
        rewritten.push(provider)
        // 这回又改了一次，之前那句「需重开生效」说的是上一条线路：因故障换的下面再按这次的标。
        toolRouteRestartPending.delete(provider)
      }
    }
    await followSkillToolRoute()
    if (failed.length) scheduleToolRouteRetry(failed)
    const hinted = request.fault === true && rewritten.length > 0 && await noteToolRouteRestart(rewritten)
    if (rewritten.length) {
      cancelToolRouteVerify?.()
      const verify = [...rewritten]
      cancelToolRouteVerify = scheduleToolRouteTimer(() => {
        cancelToolRouteVerify = null
        void followToolRoutes({ reason: 'verify', providers: verify })
      }, toolRouteVerifyDelayMs)
    }
    if (rewritten.length || hinted) serviceOptions.onToolRouteFollowed?.()
    return { rewritten }
  }

  function toolRouteSummaryFields(provider: ProviderId, current: NativeConfigInspection, records: ReturnType<typeof toolRouteFollow.read>['providers']): Pick<NativeConfigSummary, 'relayLine' | 'relayRouteState'> {
    const site = activeRelaySite()
    if (site.id !== 'solov' || !current.actualBaseUrl || !current.matchesRelay) return {}
    if (store.read().officialProviders?.includes(provider)) return {}
    const relayLine = relaySiteExactEndpointIdForBaseUrl(site.id, provider, current.actualBaseUrl)
    const state = records[provider]?.managedElsewhere ? 'managed-elsewhere' as const
      : toolRouteRestartPending.has(provider) ? 'restart' as const : undefined
    return { relayLine, ...(state ? { relayRouteState: state } : {}) }
  }

  // relayRouteLines 一直是管理工具自己那条（应用线路）；接了工具线路时另给星芒账号写进工具配置的那条和它的状态。
  function routeLineSnapshotFields(): Pick<AppSettings, 'relayRouteLines' | 'relayToolRouteLines' | 'relayToolRouteStatus'> {
    const tool = serviceOptions.relayToolRouting
    if (!tool) return { relayRouteLines: relayRouting.lines() }
    const status = tool.status()
    return {
      relayRouteLines: tool.applicationLines(),
      relayToolRouteLines: { solov: relayRouting.lines().solov },
      ...(status ? { relayToolRouteStatus: status } : {}),
    }
  }

  function toolRouteSnapshotFields(): { toolRouteRestartHint?: ToolRouteRestartHint; toolRouteRewrite?: 'merge' } {
    const hint = currentToolRouteRestartHint()
    return { ...(hint ? { toolRouteRestartHint: hint } : {}), ...(toolRouteRewriteMode() === 'merge' ? { toolRouteRewrite: 'merge' as const } : {}) }
  }

  function disposeToolRoutes(): void {
    cancelToolRouteRetry?.()
    cancelToolRouteRetry = null
    cancelToolRouteVerify?.()
    cancelToolRouteVerify = null
    cancelPendingExternalRouteRecheck()
  }

  // 注册通道时挂上、撤通道时摘掉（ipc/handlers/config.ts）：迁移前那份备份带账号信息、生图技能认当前账号的 Key，都靠这两件。
  function bindToolRouteAccount(hooks: ToolRouteAccountHooks | null): void {
    toolRouteAccount = hooks
  }

  /** 设置快照里给界面的那条重开提示；过了半小时不再给。 */
  function currentToolRouteRestartHint(): ToolRouteRestartHint | undefined {
    if (!toolRouteRestartHint) return undefined
    const age = toolRouteNow() - toolRouteRestartHintAt
    return age >= 0 && age < toolRouteHintTtlMs ? toolRouteRestartHint : undefined
  }

  return {
    followToolRoutes,
    noteRouteFollowRestart,
    noteCodexPayloadRestart,
    accountRouteFollowed,
    accountRouteFaultFollowed,
    writeToolRouteRecord,
    toolRouteSummaryFields,
    routeLineSnapshotFields,
    toolRouteSnapshotFields,
    disposeToolRoutes,
    bindToolRouteAccount,
  }
}
