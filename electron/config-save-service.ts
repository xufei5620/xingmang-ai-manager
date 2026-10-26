// 保存工具配置的那一段（#1070 第 3 步，从 system-service.ts 的 createSystemService 原样搬来）：保存配置、换型号、
// 刷新菜单、配置摘要和明文密钥，打开前的型号核对，开机补模板缺省项，Codex 随包型号名单的写入和收回，
// 写进各家工具的钩子和状态行（含 Grok 换终端后重写钩子），以及退役 Gemini 留下的接入清理。
//
// 各簇共用的那份在 system-service-context.ts（问中转能用哪些型号的 fetchAvailableModels 也在那里）；首页检测、
// 外部客户端、线路跟随、官方账号那几样由 createSystemService 传进来（ConfigSaveServiceDependencies）。
// 这里只 import system-service.ts 的类型。
import fs from 'node:fs'
import os from 'node:os'
import { activeProviderIds, type ProviderId, providerIds } from './catalog'
import { type CcSwitchLeftover, inspectCcSwitchInstalled, resolveCcSwitchLeftover } from './cc-switch-leftover'
import { buildClaudeStatusLineCommand } from './claude-status-line'
import {
  buildCliHookInvocation,
  cliHookEventsDirectory,
  type CliHookInvocation,
  cliHookTargetsStale,
  grokCliHookCommand,
  grokCliHookShellChanged,
  type GrokWindowsShell,
  resolveGrokWindowsShell,
} from './cli-hooks'
import { type CliModelHints, isRetiredCliModel } from './cli-model-defaults'
import { type CodexDesktopPackageProbe, inspectCodexDesktopPackage } from './codex-desktop-service'
import {
  buildCodexRelayModelCatalog,
  codexCliAcceptsModelCatalog,
  codexDesktopAcceptsModelCatalog,
  type CodexDesktopCatalogProbe,
  type CodexModelCatalog,
  codexModelCatalogContent,
  codexModelCatalogListsModel,
  codexModelCatalogRequiredCliVersion,
  type CodexModelCatalogVerdict,
  combineCodexModelCatalogVerdicts,
  parseCodexModelCatalog,
  type ParsedCodexModelCatalog,
  readBundledCodexModelCatalog,
} from './codex-model-catalog'
import {
  applyProviderModelReplace,
  applyProviderPickerRefresh,
  claudeModelPickerNeedsRefresh,
  codexModelCatalogNeedsRefresh,
  codexModelCatalogTargetUsable,
  codexOfficialAliasPending,
  fillRelayTemplateDefaults,
  inspectCodexModelCatalogOnDisk,
  inspectManagedCliHookTargets,
  inspectRetiredGeminiIntegrations,
  type NativeConfigInspection,
  type NativeConfigSummary,
  planProviderModelReplace,
  planProviderPickerRefresh,
  relayTemplateDefaultsPending,
  relayTemplateRevision,
  removeRetiredGeminiIntegrations,
  restoreCodexOfficialAlias,
  type RetiredGeminiIntegrations,
  rewriteManagedCliHooks,
  saveProviderConfig,
  takeBackCodexModelCatalog,
  toNativeConfigSummary,
} from './config-files'
import { ensureEditorClaudeLoginPromptDisabled } from './editor-claude-login-prompt'
import type { ExternalClientStatus } from './external-client-contract'
import type { ManagedKeyFollowTarget } from './external-client-route-service'
import type { MacosCodexAppInspection } from './macos-codex-app'
import { isReplacedManagedKey, type StoredManagedCliKey } from './managed-cli-key-store'
import {
  type RelayEndpointId,
  relayProviderBaseUrlEquals,
  relaySiteEndpointIdForBaseUrl,
  relaySiteForProviderBaseUrl,
} from './relay-sites'
import { emptyRunningToolsReport, type RunningToolsReport } from './running-tools'
import type { AppConfigSummary, CodexReadinessStatus, ConfigSavePayload, ToolStatus } from './system-service'
import { modelAccessCacheKey, sameNativeConfigSnapshot, type ServiceContext } from './system-service-context'
import type { ToolConfigOwnership, ToolTemplateFillResult } from './tool-config-ownership'
import type { CliInstallation } from './tool-installation'
import { createToolModelChecker, type ToolModelCheckTarget } from './tool-model-check'
import type { ToolRouteFollowRecord, ToolRouteFollowState } from './tool-route-follow-state'
import { withAppendedWindowsPath } from './windows-live-path'
import { resolveRememberedWorkspace } from './workspace-guard'

/**
 * 老版本写下的 Codex 配置把当前账号的服务放在 openai 这类内置名下，Codex 不认那张表，
 * 一打开就 401；这种配置往往没有归属记录，平常会被「来源未经确认就不自动改写」挡住。
 * 只在三件事都对得上时让开机那一轮自动修（yoyo 9-30 同意第十七批 1b）：地址是当前站、
 * 配置里的 Key 正是这次要写入的当前账号 Key、写入只把那张表搬到我们自己的连接名下。
 * 「被改过」（changed）和手动来源不在其列：那是用户动过的配置，照旧只给按钮。
 */
export function permitsShadowedCodexRepair(
  provider: ProviderId,
  before: Pick<NativeConfigInspection, 'hasApiKey' | 'matchesRelay' | 'apiKey' | 'codexProviderShadowed'>,
  previousOwnership: ToolConfigOwnership,
  apiKey: string,
): boolean {
  const key = apiKey.trim()
  return provider === 'codex' && previousOwnership === 'unknown' && before.codexProviderShadowed === true
    && before.hasApiKey && before.matchesRelay && key.length > 0 && before.apiKey === key
}

/** 看不出来就不带这个字段，旧的快照与测试夹具不用跟着改。 */
export function ccSwitchLeftoverField(leftover: CcSwitchLeftover | null): { ccSwitchLeftover?: CcSwitchLeftover } {
  return leftover ? { ccSwitchLeftover: leftover } : {}
}

/** 首页「提醒设置要修」那两项；「换了命令行」只在真换了时才带，旧快照和测试夹具不用跟着改。null = 引导预览，一律不报。 */
export function cliHooksSummaryFields(
  state: { stale: boolean; shellChanged: boolean; missing?: boolean } | null,
): { cliHooksStale: boolean; cliHooksShellChanged?: true; cliHooksMissing?: true } {
  if (!state) return { cliHooksStale: false }
  if (state.shellChanged) return { cliHooksStale: true, cliHooksShellChanged: true }
  return !state.stale && state.missing ? { cliHooksStale: false, cliHooksMissing: true } : { cliHooksStale: state.stale }
}

/**
 * Windows 上只装 Grok 时不装运行环境（#695），那时钩子写不出来，配置照写，Grok 于是少了做完提醒和
 * 防睡两项。只认本软件替当前账号写的那份（连着星芒、有 Key）；推到 cmd 本来就不写，不算缺。
 * Mac 上的 Grok 从 npm 装，没有运行环境装不上，不会走到这里。
 */
export function grokCliHooksMissing(input: {
  platform: NodeJS.Platform
  provider: ProviderId
  managedTargets: number
  relayConfigured: boolean
  shell: GrokWindowsShell | null
}): boolean {
  return input.platform === 'win32' && input.provider === 'grok' && input.managedTargets === 0
    && input.relayConfigured && input.shell !== null && input.shell !== 'cmd'
}

/**
 * 开机发现的旧钩子要不要不等客户点就改掉（第十八批 1b，yoyo 2026-09-30 同意）：只改本账号写的、
 * 这次启动还没试过的那份。别处来的配置、被改过的配置不自动动，首页照旧给「修好它」；
 * 试过一次没修好的也不再反复试，免得每次读配置都去改文件。
 */
export function shouldAutoRepairCliHooks(input: {
  stale: boolean
  ownership: ToolConfigOwnership
  attempted: boolean
}): boolean {
  return input.stale && !input.attempted && input.ownership === 'account'
}

/** 这次启动替用户改好了、而且现在确实不再指向旧位置，才带这个字段；旧快照和测试夹具不用跟着改。 */
export function cliHooksAutoRepairedField(autoRepaired: boolean, stale: boolean): { cliHooksAutoRepaired?: true } {
  return autoRepaired && !stale ? { cliHooksAutoRepaired: true } : {}
}

/**
 * Windows 上桌面端是哪一批：Appx 探测明确报了「没有」才算没装，报错、没下结论都算看不出
 * （同 codex-desktop-service.ts 判卸载干净的口径）。
 */
export function codexDesktopCatalogProbeFromPackage(probe: CodexDesktopPackageProbe): CodexDesktopCatalogProbe {
  if (probe.value) return { installed: true, version: probe.value.version }
  return probe.confirmedAbsent === true && !probe.error ? { installed: false, version: null } : { installed: null, version: null }
}

/** Mac 上同理：检测没跑完（detectionFailed）就是看不出，不当没装。 */
export function codexDesktopCatalogProbeFromMacosApp(inspection: MacosCodexAppInspection): CodexDesktopCatalogProbe {
  if (inspection.app) return { installed: true, version: inspection.app.version }
  return inspection.detectionFailed ? { installed: null, version: null } : { installed: false, version: null }
}

/** 读本软件写的 Codex 型号名单的是哪几份 Codex：命令行、桌面端自带的那份，或两边都看。 */
type CodexModelCatalogReaders = 'cli' | 'desktop' | 'all'

type CodexModelCatalogGuardTrigger = 'cli-installed' | 'desktop-installed' | 'startup' | 'before-launch'

/** 收回读不进的名单时只看这次可能变了的那一边：装了命令行只看命令行，开机两边都看。 */
const codexModelCatalogGuardReaders: Record<CodexModelCatalogGuardTrigger, CodexModelCatalogReaders> = {
  'cli-installed': 'cli',
  'desktop-installed': 'desktop',
  startup: 'all',
  'before-launch': 'cli',
}

/**
 * 补设置这一轮看哪些：开机那轮（连同联网后、开通订阅后补跑的那几次）什么都看；渲染层
 * 隔一阵来补做（retry）时只看开机那轮因为工具可能开着而欠下的（第二十六批 E）。
 */
interface TemplateFillRound {
  retry: boolean
  providers: readonly ProviderId[]
  codexModelCatalog: boolean
}

/**
 * 等 start() 起的活落定，signal 一停就不等了（按停下的原因拒绝），活自己接着跑完、结果没人要；
 * 已经停了就不起。给只读的本机探测用：起出去的进程收不回来，放着跑完无害，等它的人不必陪着。
 */
export function unlessStopped<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const work = start()
    function stop(): void {
      reject(signal.reason)
    }
    signal.addEventListener('abort', stop, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/**
 * 同一个本机探测在 ttlMs 内复用上一次的结果（同时只跑一遍）；forget 之后下一次重新探。
 * probe 自己不该抛错：抛了也会被复用到过期为止。
 */
export function createCachedProbe<T>(probe: () => Promise<T>, ttlMs: number, now: () => number = () => Date.now()) {
  let cached: { at: number; result: Promise<T> } | null = null
  return {
    read(): Promise<T> {
      const at = now()
      // 系统时间往回拨过也重新探，不能让上一次的结论一直用下去。
      if (!cached || at - cached.at >= ttlMs || at < cached.at) cached = { at, result: probe() }
      return cached.result
    },
    forget(): void {
      cached = null
    },
  }
}

/** 保存配置要用、但归别处管的几样，由 createSystemService 传进来。 */
export interface ConfigSaveServiceDependencies {
  /** 首页检测那边：Codex 命令行装没装、哪一版（核型号名单用），哪些工具正开着（补设置、换型号前看）。 */
  inspectCliTool: (
    provider: ProviderId,
    npmExecutable?: string | null,
    npmGlobalRoot?: string | null,
    executablePath?: string | null,
  ) => Promise<{ status: ToolStatus; installation: CliInstallation | null }>
  inspectRunningTools: (providers: readonly ProviderId[]) => Promise<RunningToolsReport>
  /** 外部客户端那边：保存完替星芒换过 Key 的话，让三个外部客户端跟上。 */
  managedKeyFollowTarget: () => Promise<ManagedKeyFollowTarget | null>
  scanExternalClients: (force?: boolean) => Promise<ExternalClientStatus[]>
  /** 线路跟随那边：整份保存后记下这次写的是哪条线路，配置摘要里带上线路那两个字段。 */
  accountRouteFollowed: Map<ProviderId, string | null>
  accountRouteFaultFollowed: (siteId: string, line: RelayEndpointId) => boolean
  writeToolRouteRecord: (provider: ProviderId, update: (record: ToolRouteFollowRecord) => ToolRouteFollowRecord) => Promise<void>
  toolRouteSummaryFields: (
    provider: ProviderId,
    current: NativeConfigInspection,
    records: ToolRouteFollowState['providers'],
  ) => Pick<NativeConfigSummary, 'relayLine' | 'relayRouteState'>
  /** 官方账号那边：接中转时挪开 Claude Code 的官方 Console Key，写失败放回；Codex 跟着账号开关星芒AI技能。 */
  restoreOfficialCredentialsNow: () => boolean
  moveOfficialCredentialsAside: () => boolean
  withCredentialUndo: (error: unknown, undo: () => unknown, leftover: string) => unknown
  applyXingmangAiSkillForCodexAccount: (official: boolean) => Promise<void>
}

export function createConfigSaveService(context: ServiceContext, dependencies: ConfigSaveServiceDependencies) {
  const {
    store, serviceOptions, platform, providerRoots, runtimeLog, configOwnership, toolRouteFollow,
    serializeConfigWrite, relayRouting, activeRelaySite, providerRelaySite, inspectNativeProviderConfig,
    detectMacosCodexApp, findInstalledExecutable, credentialFailureReason, refreshWindowsLivePath,
    currentWindowsLivePath, untouchedSince, fetchAvailableModels,
  } = context
  const {
    inspectCliTool,
    inspectRunningTools,
    managedKeyFollowTarget,
    scanExternalClients,
    accountRouteFollowed,
    accountRouteFaultFollowed,
    writeToolRouteRecord,
    toolRouteSummaryFields,
    restoreOfficialCredentialsNow,
    moveOfficialCredentialsAside,
    withCredentialUndo,
    applyXingmangAiSkillForCodexAccount,
  } = dependencies

  // 这次启动替用户改过的钩子（第十八批 1b）：试过的不再试，改好的让首页说一句。只在内存里，重开软件从头算。
  const autoRepairAttemptedCliHooks = new Set<ProviderId>()
  const autoRepairCheckedOwners = new Set<string>()
  const autoRepairedCliHooks = new Set<ProviderId>()
  let autoRepairQueue: Promise<unknown> = Promise.resolve()

  /**
   * Windows 版 Grok 找得到 Git Bash 就改用它跑钩子，原来按 PowerShell 写的那几行会每一轮报红。
   * 所以星芒装好 Git 之后，把 Grok 配置里本软件那几条钩子按新的 shell 重写一遍（只动我们
   * 写过的那几条，原来没有就不补，同「修好它」那条路）。失败只记日志，不影响装 Git。
   */
  async function refreshGrokHooksForShellChange(): Promise<void> {
    try {
      const cliHook = await resolveCliHookInvocation()
      if (!cliHook) return
      await serializeConfigWrite(async () => {
        rewriteManagedCliHooks('grok', providerRoots, { cliHook })
      })
      runtimeLog?.log('info', 'config', 'grok-hooks.rewritten', '装好 Git 后按新的命令行重写了 Grok 的钩子', { shell: cliHook.grokWindowsShell ?? null })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'grok-hooks.rewrite-failed', '装好 Git 后重写 Grok 钩子没成功', { reason: credentialFailureReason(error) })
    }
  }

  /**
   * Windows 上只装 Grok 时没有运行环境，做完提醒和防睡的钩子写不出来（#695）。等这台电脑有了运行环境
   * （星芒装的、客户自己装的都算），就把那几条补上：装好运行环境后、打开 Grok 前、每次启动各看一眼。
   * 只补本软件替当前账号写的那份，其余设置一个字不动，写之前照旧备份。补不上只记日志，下次再看。
   */
  async function addMissingGrokHooks(trigger: 'runtime-installed' | 'before-launch' | 'startup'): Promise<boolean> {
    if (platform !== 'win32') return false
    try {
      await refreshWindowsLivePath()
      if (!managedCliHooksState('grok').missing) return false
      const owner = serviceOptions.getExternalClientAccountId?.() ?? null
      if (!owner || configOwnership.read('grok', inspectNativeProviderConfig('grok'), owner) !== 'account') return false
      const cliHook = await resolveCliHookInvocation()
      // 还是找不到运行环境：首页那句「缺什么」留着，不写文件。
      if (!cliHook || grokCliHookCommand(cliHook) === null) return false
      await serializeConfigWrite(async () => {
        rewriteManagedCliHooks('grok', providerRoots, { cliHook, addIfMissing: true })
      })
      const added = !managedCliHooksState('grok').missing
      runtimeLog?.log(added ? 'info' : 'warn', 'config', added ? 'grok-hooks.added' : 'grok-hooks.add-incomplete',
        added ? '有了运行环境，给 Grok 补上了做完提醒和防睡' : '给 Grok 补做完提醒和防睡没补上', { trigger, shell: cliHook.grokWindowsShell ?? null })
      return added
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'grok-hooks.add-failed', '给 Grok 补做完提醒和防睡没成功', { trigger, reason: credentialFailureReason(error) })
      return false
    }
  }

  function rememberedWorkspaceFor(workspace: string): string | null {
    return resolveRememberedWorkspace(workspace, {
      platform,
      home: providerRoots.userHome,
      defaultWorkspace: os.homedir(),
    })
  }

  function buildConfigSummary(previewOnboarding: boolean, cachedKeys: readonly StoredManagedCliKey[] = []): AppConfigSummary {
    const stored = store.read()
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const ccSwitchInstalled = inspectCcSwitchInstalled(providerRoots.userHome)
    const rememberedWorkspace = rememberedWorkspaceFor(stored.workspace)
    const routeRecords = toolRouteFollow.read().providers
    const result = {
      workspace: stored.workspace,
      ...(rememberedWorkspace ? { rememberedWorkspace } : {}),
      providers: Object.fromEntries(
        providerIds.map((id) => {
          const current = inspectNativeProviderConfig(id)
          const hooks = previewOnboarding ? null : managedCliHooksState(id)
          return [id, {
            ...toNativeConfigSummary(current),
            configurationOwnership: configOwnership.read(id, current, owner),
            configurationAccountMatched: Boolean(owner) && current.hasApiKey && current.matchesRelay
              && cachedKeys.some((entry) => entry.provider === id && entry.key === current.apiKey),
            configurationKeyReplaced: Boolean(owner) && current.hasApiKey && current.matchesRelay
              && isReplacedManagedKey(id, current.apiKey, cachedKeys),
            ...ccSwitchLeftoverField(resolveCcSwitchLeftover(current, ccSwitchInstalled)),
            ...cliHooksSummaryFields(hooks),
            ...cliHooksAutoRepairedField(!previewOnboarding && autoRepairedCliHooks.has(id), hooks?.stale === true),
            ...(previewOnboarding ? {} : toolRouteSummaryFields(id, current, routeRecords)),
          }]
        }),
      ) as Record<ProviderId, NativeConfigSummary>,
    }
    if (previewOnboarding) {
      result.providers.codex = {
        ...result.providers.codex,
        actualBaseUrl: '',
        exists: false,
        hasApiKey: false,
        matchesRelay: false,
        configurationAccountMatched: false,
        configurationKeyReplaced: false,
        ccSwitchLeftover: undefined,
        apiKeyPreview: null,
        officialAccountEmail: null,
        officialAccountPlan: null,
        officialAccountRenewsAt: null,
        codexAuthMode: null,
        codexProviderName: null,
        codexProviderShadowed: false,
        model: '',
        updatedAt: null,
        files: result.providers.codex.files.map((file) => ({ ...file, exists: false })),
      }
    }
    return result
  }

  function inspectCodexReadiness(previewOnboarding: boolean): CodexReadinessStatus {
    if (previewOnboarding) return { hasApiKey: false, matchesRelay: false }
    const codex = inspectNativeProviderConfig('codex')
    return { hasApiKey: codex.hasApiKey, matchesRelay: codex.matchesRelay }
  }

  function revealApiKey(provider: ProviderId, previewOnboarding: boolean): string {
    if (previewOnboarding) return ''
    return inspectNativeProviderConfig(provider).apiKey
  }

  /**
   * Claude Code 的状态行命令。解析不到托管 Node、脚本没随包拷进来、路径里带 shell
   * 元字符，一律返回 undefined——状态行是锦上添花，任何一环不成立都只是「这次不写
   * 状态行」，不能让整条配置写入失败。
   */
  async function resolveClaudeStatusLineCommand(provider: ProviderId): Promise<string | undefined> {
    if (provider !== 'claude') return undefined
    const scriptPath = serviceOptions.claudeStatusLineScriptPath
    if (!scriptPath) return undefined
    try {
      const nodeExecutable = await findInstalledExecutable('node')
      if (!nodeExecutable) return undefined
      return buildClaudeStatusLineCommand(nodeExecutable, scriptPath) ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * 终端里出错、做完、等人时通知星芒的钩子。与状态行同一个口径：哪一环不成立（没有
   * 托管 Node、脚本没随包、路径带 shell 元字符）都只是这次不写，配置照写。
   */
  async function resolveCliHookInvocation(): Promise<CliHookInvocation | undefined> {
    const scriptPath = serviceOptions.cliHookScriptPath
    const dataDirectory = serviceOptions.managerDataDirectory
    if (!scriptPath || !dataDirectory) return undefined
    try {
      const nodeExecutable = await findInstalledExecutable('node')
      if (!nodeExecutable) return undefined
      const invocation = buildCliHookInvocation(nodeExecutable, scriptPath, cliHookEventsDirectory(dataDirectory), platform)
      if (!invocation) return undefined
      if (platform === 'win32') {
        await refreshWindowsLivePath()
        invocation.grokWindowsShell = expectedGrokWindowsShell()
      }
      return invocation
    } catch {
      return undefined
    }
  }

  // 随包那份官方 Codex 型号名单同一次运行里不会变，只读一次；读不成（构建残留、被替换）
  // 也不必每次保存都再试，这次运行就不写名单。
  let bundledCodexModelCatalog: ParsedCodexModelCatalog | null | undefined

  function loadBundledCodexModelCatalog(): ParsedCodexModelCatalog | null {
    if (bundledCodexModelCatalog !== undefined) return bundledCodexModelCatalog
    bundledCodexModelCatalog = null
    const filePath = serviceOptions.bundledCodexModelCatalogPath
    if (!filePath) return null
    try {
      bundledCodexModelCatalog = readBundledCodexModelCatalog(filePath)
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.bundled-unreadable', '随包的 Codex 型号名单读不出来，这次运行不写型号名单', {
        reason: credentialFailureReason(error),
      })
      return null
    }
    if (bundledCodexModelCatalog.rejected.length) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.bundled-rejected', '随包的 Codex 型号名单里有 Codex 读不进去的型号，已经剔掉', {
        rejected: bundledCodexModelCatalog.rejected,
      })
    }
    return bundledCodexModelCatalog
  }

  // 读 xingmang-models.json 的不只命令行，还有桌面端自带的那份 Codex：两边是哪一版都在本机
  // 探（命令行读 npm 包的版本或跑一次 --version，桌面端 Windows 问 Appx 包、Mac 看应用包）。
  // 一次保存、开机那一轮会连着问好几遍，30 秒内复用上一次的结论；星芒自己装、卸、更新过
  // 之后作废。
  const codexCliForModelCatalog = createCachedProbe(async (): Promise<{ installed: boolean; version: string | null } | null> => {
    try {
      const { status } = await inspectCliTool('codex', null, null)
      return { installed: status.installed, version: status.version }
    } catch {
      return null
    }
  }, 30_000)
  const codexDesktopForModelCatalog = createCachedProbe(async (): Promise<CodexDesktopCatalogProbe> => {
    try {
      if (serviceOptions.inspectCodexDesktopForModelCatalog) return await serviceOptions.inspectCodexDesktopForModelCatalog()
      if (platform === 'win32') return codexDesktopCatalogProbeFromPackage(await inspectCodexDesktopPackage())
      if (platform === 'darwin') return codexDesktopCatalogProbeFromMacosApp(await detectMacosCodexApp())
      return { installed: false, version: null }
    } catch {
      return { installed: null, version: null }
    }
  }, 30_000)

  function forgetCodexModelCatalogReaders(): void {
    codexCliForModelCatalog.forget()
    codexDesktopForModelCatalog.forget()
  }

  /** 读这份名单的几份 Codex 合起来能不能用它（codex-model-catalog.ts），顺带各自的版本留给日志。 */
  async function codexModelCatalogReadersVerdict(catalog: CodexModelCatalog, readers: CodexModelCatalogReaders): Promise<{
    verdict: CodexModelCatalogVerdict
    detail: Record<string, unknown>
  }> {
    const verdicts: CodexModelCatalogVerdict[] = []
    const detail: Record<string, unknown> = { required: codexModelCatalogRequiredCliVersion(catalog) }
    if (readers !== 'desktop') {
      const cli = await codexCliForModelCatalog.read()
      const verdict = cli ? codexCliAcceptsModelCatalog(cli, catalog) : 'unknown'
      verdicts.push(verdict)
      Object.assign(detail, { cli: verdict, cliVersion: cli?.version ?? null })
    }
    if (readers !== 'cli') {
      const desktop = await codexDesktopForModelCatalog.read()
      const verdict = codexDesktopAcceptsModelCatalog(desktop)
      verdicts.push(verdict)
      Object.assign(detail, { desktop: verdict, desktopVersion: desktop.version })
    }
    return { verdict: combineCodexModelCatalogVerdicts(verdicts), detail }
  }

  /**
   * 这次要给 Codex 写的型号名单（codex-model-catalog.ts）：全文 = 照写；null = 收回本软件
   * 写的那一行（账号的型号随包名单里一个都没有、默认型号不在名单里、名单文件的位置被换成了
   * 链接、这台电脑上的命令行或桌面端太旧）；undefined = 原样不动（没有随包名单、看不出
   * 命令行或桌面端是哪一版），免得一次没读到就把菜单来回改。
   */
  async function resolveCodexModelCatalog(availableModels: readonly string[], model: string): Promise<string | null | undefined> {
    const official = loadBundledCodexModelCatalog()
    if (!official) return undefined
    const catalog = buildCodexRelayModelCatalog(official, availableModels)
    if (!catalog) {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.no-match', '当前账号能用的型号随包名单里都没有，Codex 用它自带的菜单', {
        models: availableModels.length,
      })
      return null
    }
    if (!codexModelCatalogListsModel(catalog, model)) {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.model-not-listed', 'Codex 的默认型号不在随包名单里，这次不写型号名单', { model })
      return null
    }
    if (!codexModelCatalogTargetUsable(providerRoots)) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.target-unsafe', 'Codex 型号名单的位置被换成了链接，这次不写型号名单')
      return null
    }
    const { verdict, detail } = await codexModelCatalogReadersVerdict(catalog, 'all')
    if (verdict === 'unknown') {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.reader-unknown', '看不出 Codex 命令行或桌面端是哪一版，型号名单这次不动', detail)
      return undefined
    }
    if (verdict === 'too-old') {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.reader-too-old', '这台电脑上的 Codex 命令行或桌面端太旧，读不进型号名单，这次不写', detail)
      return null
    }
    return codexModelCatalogContent(catalog)
  }

  /** Codex 那份型号名单按当前账号的型号重写会不会变；看不出该不该写的时候算没变。 */
  async function codexModelCatalogOutdated(availableModels: readonly string[], model: string): Promise<boolean> {
    const expected = await resolveCodexModelCatalog(availableModels, model)
    return expected !== undefined && codexModelCatalogNeedsRefresh(expected, providerRoots)
  }

  /**
   * 本软件写的名单该不该收回：名单文件丢了、读不进，或读它的命令行 / 桌面端太旧（只看这次
   * 可能变了的那一边）。不该收回是 null，该收回给出原因留给日志；看不出版本的算不该。
   */
  async function codexModelCatalogTakeBackReason(trigger: CodexModelCatalogGuardTrigger): Promise<Record<string, unknown> | null> {
    const onDisk = inspectCodexModelCatalogOnDisk(providerRoots)
    if (!onDisk.managed) return null
    let catalog: ParsedCodexModelCatalog | null = null
    try {
      catalog = onDisk.content === null ? null : parseCodexModelCatalog(onDisk.content)
    } catch {
      catalog = null
    }
    if (!catalog || catalog.rejected.length) return { reason: onDisk.content === null ? 'missing' : 'unreadable' }
    const readers = await codexModelCatalogReadersVerdict(catalog, codexModelCatalogGuardReaders[trigger])
    return readers.verdict === 'too-old' ? { reason: 'too-old', ...readers.detail } : null
  }

  /**
   * 不看账号、不联网，只看本机，读不进就收回 config.toml 里那一行（名单文件留着）：Codex 读
   * 不进名单整个起不来，这一步不能等联网核对，也不管工具开没开。失败只记日志。
   */
  async function takeBackUnreadableCodexModelCatalog(trigger: CodexModelCatalogGuardTrigger): Promise<void> {
    if (!serviceOptions.bundledCodexModelCatalogPath) return
    try {
      // 打开前那次有人在等：名单好好的（绝大多数时候）就不必排在别的写入后面。装完那两次
      // 不能这样省：正在进行的保存可能拿装之前探的版本写下那一行，要等它写完再看。
      if (trigger === 'before-launch' && !(await codexModelCatalogTakeBackReason(trigger))) return
      await serializeConfigWrite(async () => {
        if (trigger === 'cli-installed' || trigger === 'desktop-installed') {
          // 刚装完的那一边要重新探，不能用装之前那次的结论；当天那次核对说的「名单该不该写」
          // 也跟着作废，版本够了下次打开就补上。
          forgetCodexModelCatalogReaders()
          toolModelChecker.forget('codex')
        }
        // 进锁以后按同一套条件再判一次：排队期间配置可能刚被重写过。
        const detail = await codexModelCatalogTakeBackReason(trigger)
        if (detail && takeBackCodexModelCatalog(providerRoots)) {
          runtimeLog?.log('info', 'config', 'codex-model-catalog.taken-back', 'Codex 读不进本软件写的型号名单，已经收回 config.toml 里那一行', { trigger, ...detail })
        }
      })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.take-back-failed', '没能收回 Codex 读不进的型号名单', { trigger, reason: credentialFailureReason(error) })
    }
  }

  // 开机那次只做一遍：没登录的由 main.ts 在开机后调，登录状态下开机那轮按账号同步也先等它，
  // 两边共用这一次，不为同一件事问两遍命令行和桌面端。
  let startupCodexModelCatalogGuard: Promise<void> | null = null
  function guardCodexModelCatalogAtStartup(): Promise<void> {
    startupCodexModelCatalogGuard ??= takeBackUnreadableCodexModelCatalog('startup')
    return startupCodexModelCatalogGuard
  }

  /**
   * Gemini CLI 下线后，星芒以前写进它 settings.json 的做完提醒和画图工具没人跟着改了：星芒换了
   * 位置或被卸掉，Gemini 每一轮都会多报一行错。每次开机看一眼，有就收回（gemini-retired.ts 的
   * removeRetiredGeminiIntegrations），收过了就什么都不写。Gemini 开着时它可能正在写同一个文件，
   * 和补设置同一套规矩：开着或看不出开没开的这次不动。
   */
  async function reclaimRetiredToolIntegrations(): Promise<RetiredGeminiIntegrations> {
    const none: RetiredGeminiIntegrations = { hooks: false, imageMcp: false }
    try {
      const pending = inspectRetiredGeminiIntegrations(providerRoots)
      if (!pending.hooks && !pending.imageMcp) return none
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'retired-integrations.unreadable', 'Gemini CLI 的设置读不懂，星芒写进去的提醒和画图这次没收回', { reason: credentialFailureReason(error) })
      return none
    }
    let report: RunningToolsReport
    try {
      report = await (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(['gemini'])
    } catch {
      report = { ...emptyRunningToolsReport, unknown: ['gemini'] }
    }
    if (report.running.includes('gemini') || report.unknown.includes('gemini')) {
      runtimeLog?.log('info', 'config', 'retired-integrations.deferred', 'Gemini CLI 可能正开着，星芒写进去的提醒和画图下次开机再收回')
      return none
    }
    try {
      const removed = await serializeConfigWrite(async () => removeRetiredGeminiIntegrations(providerRoots))
      if (removed.hooks || removed.imageMcp) {
        runtimeLog?.log('info', 'config', 'retired-integrations.removed', '已收回星芒写进 Gemini CLI 的提醒和画图', { hooks: removed.hooks, imageMcp: removed.imageMcp })
      }
      return { hooks: removed.hooks, imageMcp: removed.imageMcp }
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'retired-integrations.failed', '收回星芒写进 Gemini CLI 的提醒和画图没有完成，下次开机再试', { reason: credentialFailureReason(error) })
      return none
    }
  }

  /**
   * Windows 版 Grok 现在会拿哪个 shell 跑钩子。PATH 用启动时快照再补上注册表里新加的那几段：
   * 客户新开的终端看得到的，这里也要看得到；从星芒打开 Grok 时也补上同样几段（launchProviderOperation），
   * 两边推出来的是同一个 shell。Git Bash 那三处本来就是实时看文件在不在。
   */
  function expectedGrokWindowsShell(): GrokWindowsShell {
    return resolveGrokWindowsShell(withAppendedWindowsPath(process.env, currentWindowsLivePath()), (candidate) => fs.existsSync(candidate))
  }

  /**
   * 本软件写进这家配置的钩子、状态行要不要重写：指向旧位置（cliHookTargetsStale），或 Windows 上 Grok 换了 shell；
   * 以及 Windows 上只装 Grok 时一条都没写上（grokCliHooksMissing）。读不出来按不用算。
   */
  function managedCliHooksState(provider: ProviderId): { stale: boolean; shellChanged: boolean; missing: boolean } {
    try {
      const targets = inspectManagedCliHookTargets(provider, providerRoots)
      const windowsGrok = provider === 'grok' && platform === 'win32'
      const shell = windowsGrok ? expectedGrokWindowsShell() : null
      const shellChanged = shell !== null && grokCliHookShellChanged(targets, shell)
      const moved = cliHookTargetsStale(targets, [serviceOptions.cliHookScriptPath, serviceOptions.claudeStatusLineScriptPath])
      let missing = false
      if (windowsGrok && targets.length === 0) {
        const current = inspectNativeProviderConfig(provider)
        missing = grokCliHooksMissing({
          platform,
          provider,
          managedTargets: targets.length,
          relayConfigured: current.hasApiKey && current.matchesRelay,
          shell,
        })
      }
      return { stale: moved || shellChanged, shellChanged, missing }
    } catch {
      return { stale: false, shellChanged: false, missing: false }
    }
  }

  function cliHooksStale(provider: ProviderId): boolean {
    return managedCliHooksState(provider).stale
  }

  /**
   * 打开 Grok 之前复核一遍星芒写的那几条钩子：Grok 换了 shell、或指向旧位置，就先修好再开，
   * 与 Codex「打开前先修」同一个路数。这是客户点了「打开」才做的，不是开机静默改文件；
   * 修不好只记日志，不挡打开。
   */
  async function repairGrokHooksBeforeLaunch(): Promise<void> {
    await refreshWindowsLivePath()
    const state = managedCliHooksState('grok')
    if (state.missing) {
      await addMissingGrokHooks('before-launch')
      return
    }
    if (!state.stale) return
    const shell = platform === 'win32' ? expectedGrokWindowsShell() : null
    try {
      await repairCliHooks('grok')
      runtimeLog?.log('info', 'config', state.shellChanged ? 'grok-hooks.shell-changed' : 'grok-hooks.repaired-before-launch',
        state.shellChanged ? 'Grok 换了命令行，打开前按新的命令行重写了钩子' : '打开 Grok 前把指向旧位置的钩子改好了', { shell })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'grok-hooks.repair-before-launch-failed', '打开 Grok 前修钩子没成功，照常打开', {
        shellChanged: state.shellChanged,
        shell,
        reason: credentialFailureReason(error),
      })
    }
  }

  async function repairCliHooks(provider: ProviderId): Promise<ReturnType<typeof saveProviderConfig>> {
    // 找 node 要读 PATH，放在排队之前；与 saveConfig 同一个次序。修完的复核也按最新的 PATH 推 Grok 的 shell。
    await refreshWindowsLivePath()
    const cliHook = await resolveCliHookInvocation()
    const claudeStatusLineCommand = await resolveClaudeStatusLineCommand(provider)
    return serializeConfigWrite(async () => {
      // 首页「补上」也走这里：Grok 一条没写过的，这次一并补上。
      const result = rewriteManagedCliHooks(provider, providerRoots, { cliHook, claudeStatusLineCommand, addIfMissing: provider === 'grok' })
      const after = managedCliHooksState(provider)
      if (after.stale) throw new Error('提醒设置没修好，原来的设置已备份，可以在「设置 › 备份迁移」里找回')
      if (cliHook && after.missing) throw new Error('做完提醒和防睡还没补上，先点首页的「补上」准备好运行环境再试')
      runtimeLog?.log('info', 'config', 'cli-hooks.repaired', '已把工具里的提醒设置改到这次安装的位置', {
        provider,
        rewritten: Boolean(cliHook),
      })
      return result
    })
  }

  /**
   * 开机后第一次读配置时，把本账号写的、指向旧位置的钩子和状态行直接改好（卸载后换文件夹重装、
   * 挪了软件、换装了 Node.js 之后），不用客户去首页点「修好它」。每个账号只查一遍、每家只试一次；
   * 修不好只记日志，首页照旧给「修好它」。串成一条队，同时来的几次读配置不会一起改同一份文件。
   */
  function autoRepairStaleCliHooks(): Promise<ProviderId[]> {
    const run = autoRepairQueue.then(repairStaleAccountCliHooks, repairStaleAccountCliHooks)
    autoRepairQueue = run.catch(() => [])
    return run
  }

  async function repairStaleAccountCliHooks(): Promise<ProviderId[]> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    // 每个账号这次启动只查一遍：读配置很频繁，不能每次都去翻四家的文件（Windows 上还要读注册表）。
    // Grok 换了命令行这种开着软件时才发生的事，交给打开 Grok 前那一道（repairGrokHooksBeforeLaunch）。
    if (!owner || autoRepairCheckedOwners.has(owner)) return []
    autoRepairCheckedOwners.add(owner)
    const repaired: ProviderId[] = []
    for (const provider of activeProviderIds) {
      if (provider === 'grok' && platform === 'win32') {
        // 只装 Grok 时缺的那几条：这台电脑后来有了运行环境就补上（addMissingGrokHooks 自己看归属）。
        if (await addMissingGrokHooks('startup')) repaired.push(provider)
      }
      let due = false
      try {
        due = shouldAutoRepairCliHooks({
          stale: managedCliHooksState(provider).stale,
          ownership: configOwnership.read(provider, inspectNativeProviderConfig(provider), owner),
          attempted: autoRepairAttemptedCliHooks.has(provider),
        })
      } catch {
        due = false
      }
      if (!due) continue
      autoRepairAttemptedCliHooks.add(provider)
      try {
        await repairCliHooks(provider)
        autoRepairedCliHooks.add(provider)
        repaired.push(provider)
        runtimeLog?.log('info', 'config', 'cli-hooks.auto-repaired', '打开软件时把指向旧位置的提醒设置改好了', { provider })
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'cli-hooks.auto-repair-failed', '打开软件时没能改好提醒设置，首页留着「修好它」', {
          provider,
          reason: credentialFailureReason(error),
        })
      }
    }
    return repaired
  }

  /**
   * 写完 Claude Code 配置顺手在 VS Code、Cursor 的用户设置里关掉 Claude Code 插件的登录页
   * （editor-claude-login-prompt.ts）。补不上只记日志，不算这次保存或补设置失败。
   */
  function disableEditorClaudeLoginPrompt(): void {
    try {
      for (const result of ensureEditorClaudeLoginPromptDisabled({ platform, userHome: providerRoots.userHome })) {
        if (result.outcome === 'added') {
          runtimeLog?.log('info', 'config', 'editor-login-prompt.disabled', '已在编辑器设置里关掉 Claude Code 插件的登录页', { editor: result.editor })
        } else if (result.outcome === 'unreadable') {
          runtimeLog?.log('info', 'config', 'editor-login-prompt.skipped', '编辑器设置读不懂，没有替 Claude Code 插件关登录页', { editor: result.editor })
        } else if (result.outcome === 'failed') {
          runtimeLog?.log('warn', 'config', 'editor-login-prompt.failed', '没能在编辑器设置里关掉 Claude Code 插件的登录页', {
            editor: result.editor,
            reason: credentialFailureReason(result.error),
          })
        }
      }
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'editor-login-prompt.failed', '没能在编辑器设置里关掉 Claude Code 插件的登录页', { reason: credentialFailureReason(error) })
    }
  }

  async function saveConfig(
    payload: ConfigSavePayload,
    previewOnboarding: boolean,
    assertBeforeWrite?: () => void,
    ownership?: { source: 'account'; automatic: boolean },
  ) {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const assertOwner = () => {
      assertBeforeWrite?.()
      if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，请重新配置')
    }
    let managedKeyReplaced = false
    const saved = await serializeConfigWrite(async () => {
      assertOwner()
      if (ownership?.source === 'account' && !owner) throw new Error('请先登录账号再配置账号密钥')
      const before = inspectNativeProviderConfig(payload.provider)
      const previousOwnership = configOwnership.read(payload.provider, before, owner)
      // `changed`（我们写过、之后被改动）同样不在放行之列：自动写入永远不覆盖
      // 用户或工具自己改出来的配置，首页只会提示，改不改由用户点。
      const shadowRepair = ownership?.automatic === true && permitsShadowedCodexRepair(payload.provider, before, previousOwnership, payload.apiKey)
      if (ownership?.automatic && previousOwnership !== 'account' && previousOwnership !== 'missing' && !shadowRepair) {
        throw new Error('已有工具配置的来源未经确认，已保留原配置；请在工具配置中明确选择账号密钥')
      }
      if (ownership?.automatic && store.read().officialProviders?.includes(payload.provider)) {
        throw new Error('工具已选择官方账号，已保留原配置')
      }
      const model = payload.model.trim()
      const activeSite = providerRelaySite(payload.provider, before)
      const previousRoute = relaySiteForProviderBaseUrl(activeSite.id, payload.provider, before.actualBaseUrl)
      // 线路换了、自动写入跟着换过去的那一笔（历史账号，和 R6 切回整份写入时的星芒账号）。工具开着也照样改
      // （#941）：开着的进程要重开才用上新地址；不改的话它会一直停在原来那条线路上。星芒账号平时不走这里，
      // 由 followToolRoutes 定点只改地址，重开提示也在那边（xm 三线路 C9、C10）。
      const followedRoute = ownership?.automatic === true && previousRoute !== null
        && previousRoute.providerBaseUrls[payload.provider] !== activeSite.providerBaseUrls[payload.provider]
        ? relayRouting.selection(activeSite.id)
        : undefined
      const assertUnchanged = () => {
        assertOwner()
        if (!sameNativeConfigSnapshot(before, inspectNativeProviderConfig(payload.provider))) {
          throw new Error('工具配置在模型检测期间发生变化，已保留现有配置，请重新检测')
        }
        if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，请重新配置')
      }
      // An empty key is an explicit renderer sentinel: reuse the main-process key.
      const configured = payload.apiKey.trim() ? null : before
      if (configured?.hasApiKey && !configured.matchesRelay) throw new Error('已保存的 Key 属于其他账号，请使用当前账号重新配置')
      const apiKey = payload.apiKey.trim() || configured?.apiKey || ''
      if (!apiKey) throw new Error('请先填写 API Key')
      const availableModels = await fetchAvailableModels(apiKey, { site: activeSite })
      if (!availableModels.includes(model)) throw new Error(`当前 API Key 不支持模型 ${model}，请重新检测并选择可用模型`)
      // 在 assertUnchanged 之前解析：找 node 要读 PATH，不该夹在「校验没变」和写入之间。
      const statusLineCommand = await resolveClaudeStatusLineCommand(payload.provider)
      const cliHook = await resolveCliHookInvocation()
      if (previewOnboarding && payload.provider === 'codex') return { backups: [], files: [] }
      // 同上：要问一遍 Codex 命令行是哪一版，也放在「校验没变」之前。
      const codexModelCatalog = payload.provider === 'codex' ? await resolveCodexModelCatalog(availableModels, model) : undefined
      assertUnchanged()
      // Invalidate previous consent before a write, including same-key manual
      // saves. A crash or persistence failure then leaves a protected source.
      const source = ownership?.source ?? (payload.apiKey.trim() ? 'manual'
        : previousOwnership === 'account' || previousOwnership === 'manual' ? previousOwnership : 'unknown')
      const restoreOwnership = configOwnership.remember(payload.provider, before)
      await configOwnership.write(payload.provider, before, 'manual', owner)
      let result: ReturnType<typeof saveProviderConfig>
      try {
        assertUnchanged()
        // 官方 Key 先挪、配置后写：挪不开就一个字都不写，写配置失败再把 Key 放回，
        // 不会留下「配置已是当前账号、官方 Key 还在抢道」的半切换状态（#477）。
        const movedConsoleKey = payload.provider === 'claude' && moveOfficialCredentialsAside()
        try {
          result = saveProviderConfig(payload.provider, apiKey, payload.model, payload.mode, providerRoots, {}, activeSite.providerBaseUrls, statusLineCommand, availableModels, cliHook, codexModelCatalog)
        } catch (error) {
          if (movedConsoleKey) throw withCredentialUndo(error, restoreOfficialCredentialsNow, '原来登录留下的官方 Key 暂时收在一边，切回官方账号时会放回')
          throw error
        }
      } catch (error) {
        // 上面那条「手动」防的是写到一半崩掉。没写成、配置也一点没动时（最常见的是工具开着、
        // 文件被占用）要原样放回：不然客户关掉工具再保存一次就成功了，可这一次把「手动」当成了
        // 原来的来源，「当前账号」从此变成「手动」，开机同步 Key、换账号、换连接线路都不再改它
        // （10-06 写 #899 真机清单时看到）。账号中途换了就照旧留着「手动」：那一刻是谁在操作已经
        // 说不清，宁可多挡一次自动写入。
        const sameOwner = (serviceOptions.getExternalClientAccountId?.() ?? null) === owner
        if (restoreOwnership && sameOwner && untouchedSince(payload.provider, before)) {
          await restoreOwnership().catch((restoreError: unknown) => {
            runtimeLog?.log('warn', 'config', 'ownership.restore-failed', '保存没成功，工具配置的来源记录也没能原样放回', {
              provider: payload.provider,
              reason: credentialFailureReason(restoreError),
            })
          })
        }
        throw error
      }
      // 整份模板刚按当前版本写过一遍，记下版本号，开机补缺省项那条路就不会再来一次。
      await configOwnership.write(payload.provider, inspectNativeProviderConfig(payload.provider), source, owner, relayTemplateRevision)
      if (payload.provider === 'claude' && !previewOnboarding) disableEditorClaudeLoginPrompt()
      if (shadowRepair) runtimeLog?.log('info', 'config', 'codex-provider.auto-repaired', '开机时把 Codex 认不出的连接设置改好了，原来的设置已备份', { provider: payload.provider })
      // 客服从日志看得出工具配置是什么时候、从哪条线路换到哪条的：只记线路 id，不记地址。
      if (followedRoute) {
        runtimeLog?.log('info', 'config', 'route.followed', '工具配置已换到当前连接线路', {
          provider: payload.provider,
          kind: 'tool',
          from: relaySiteEndpointIdForBaseUrl(activeSite.id, payload.provider, before.actualBaseUrl),
          to: followedRoute,
          mode: 'merge',
          readback: relayProviderBaseUrlEquals(inspectNativeProviderConfig(payload.provider).actualBaseUrl, activeSite.providerBaseUrls[payload.provider]),
        })
      }
      // 这一家刚写的这一笔是不是因为连不上换线、跟过去的：是就等这一轮写完提示重开，不是就把以前记下的作废。
      if (followedRoute && accountRouteFaultFollowed(activeSite.id, followedRoute)) accountRouteFollowed.set(payload.provider, owner)
      else accountRouteFollowed.delete(payload.provider)
      // 整份写过一遍、来源重新记成了这次的：之前「被别的软件改回过」的结论作废，换线路照常跟。
      if (toolRouteFollow.read().providers[payload.provider]?.managedElsewhere) {
        await writeToolRouteRecord(payload.provider, ({ managedElsewhere: _managedElsewhere, reverts: _reverts, ...rest }) => rest)
      }
      assertOwner()
      await store.setOfficialProvider(payload.provider, false)
      if (payload.provider === 'codex') await applyXingmangAiSkillForCodexAccount(false)
      managedKeyReplaced = ownership?.source === 'account' && apiKey !== before.apiKey
      return result
    })
    // #1113：星芒刚替这个工具换了 Key（撤销后换新、失效重签、换组），借它那把的外部客户端马上看一眼要不要
    // 跟着换，不等下次检测。不等它：换 Key 那一步出岔子只进日志，不算这次保存失败。
    if (managedKeyReplaced) {
      // 先只看缓存和工具配置：这台电脑上的托管 Key 从没被星芒换过时，不为它盘点一遍本机客户端。
      void managedKeyFollowTarget().then((target) => target ? scanExternalClients() : undefined).catch((error: unknown) => {
        runtimeLog?.log('warn', 'config', 'external-client.key.failed', '外部客户端的密钥这次没换成，下次检测再试', {
          provider: payload.provider, reason: credentialFailureReason(error),
        })
      })
    }
    return saved
  }

  /**
   * 开机换掉已下架的型号（tool-model-check.ts 的 replaceRetiredModel）：配置里只把 from 换成 to，Codex 客户
   * 自己定的 review_model、Grok 的出图地址、注释这些一个字不动（#1154 第 4 条）。以前走 saveConfig 的整份合并，
   * 模板里的每一项都按当前版本重写一遍。闸照自动写入那道：只认当前账号写的、没选官方账号的，账号确实能用
   * to 才写。来源记录不动：它认的是路径、地址和 Key（toolConfigIdentity），型号不在里面，换完照旧是「当前账号」。
   */
  async function replaceToolModel(provider: ProviderId, from: string, to: string, assertBeforeWrite: () => void): Promise<void> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    function assertOwner(): void {
      assertBeforeWrite()
      if (!owner || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，这次不换')
    }
    await serializeConfigWrite(async () => {
      assertOwner()
      if (store.read().officialProviders?.includes(provider)) throw new Error('工具已选择官方账号，已保留原配置')
      const before = inspectNativeProviderConfig(provider)
      if (configOwnership.read(provider, before, owner) !== 'account') throw new Error('已有工具配置的来源未经确认，已保留原配置')
      const apiKey = before.apiKey?.trim() ?? ''
      if (!before.matchesRelay || !apiKey) throw new Error('已保存的 Key 属于其他账号，已保留原配置')
      const activeSite = providerRelaySite(provider, before)
      const availableModels = await fetchAvailableModels(apiKey, { site: activeSite })
      if (!availableModels.includes(to)) throw new Error(`当前 API Key 不支持模型 ${to}`)
      // 要问一遍 Codex 命令行是哪一版，放在「校验没变」之前，同 saveConfig。
      const codexModelCatalog = provider === 'codex' ? await resolveCodexModelCatalog(availableModels, to) : undefined
      assertOwner()
      if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，这次不换')
      if (!sameNativeConfigSnapshot(before, inspectNativeProviderConfig(provider))) throw new Error('工具配置在模型检测期间发生变化，已保留现有配置')
      const plan = planProviderModelReplace(provider, from, to, providerRoots, codexModelCatalog)
      if (plan.status !== 'rewrite') throw new Error(plan.status === 'changed' ? '工具里的型号已经改了，这次不换' : '工具配置里找不到型号写在哪，这次不换')
      applyProviderModelReplace(provider, plan, providerRoots)
    })
  }

  /**
   * 打开前、开机核对时刷新型号菜单（tool-model-check.ts 的 refreshPickerIfOutdated）：只改菜单那几处，
   * Claude Code 的 modelPicker 和没写过的「Default」，Codex 的型号名单和指向它的那一行（#1154 后续）。以前走
   * saveConfig 的整份合并，Codex 客户自己定的 review_model、打开的检查更新、注释，Claude Code 放开的 deny 项
   * 和另指的「Default」都被改回模板的样子。闸同 replaceToolModel；来源记录、模板版本号都不动。
   */
  async function refreshToolPicker(provider: ProviderId, model: string, assertBeforeWrite: () => void): Promise<void> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    function assertOwner(): void {
      assertBeforeWrite()
      if (!owner || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，这次不刷新')
    }
    await serializeConfigWrite(async () => {
      assertOwner()
      if (store.read().officialProviders?.includes(provider)) throw new Error('工具已选择官方账号，已保留原配置')
      const before = inspectNativeProviderConfig(provider)
      if (configOwnership.read(provider, before, owner) !== 'account') throw new Error('已有工具配置的来源未经确认，已保留原配置')
      const apiKey = before.apiKey?.trim() ?? ''
      if (!before.matchesRelay || !apiKey) throw new Error('已保存的 Key 属于其他账号，已保留原配置')
      const activeSite = providerRelaySite(provider, before)
      const availableModels = await fetchAvailableModels(apiKey, { site: activeSite })
      if (!availableModels.includes(model)) throw new Error(`当前 API Key 不支持模型 ${model}`)
      const codexModelCatalog = provider === 'codex' ? await resolveCodexModelCatalog(availableModels, model) : undefined
      assertOwner()
      if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，这次不刷新')
      if (!sameNativeConfigSnapshot(before, inspectNativeProviderConfig(provider))) throw new Error('工具配置在模型检测期间发生变化，已保留现有配置')
      const plan = planProviderPickerRefresh(provider, model, availableModels, providerRoots, codexModelCatalog)
      if (plan.status === 'current') return
      if (plan.status !== 'rewrite') throw new Error(plan.status === 'changed' ? '工具里的型号已经改了，这次不刷新' : '工具配置里找不到型号菜单写在哪，这次不刷新')
      applyProviderPickerRefresh(provider, plan, providerRoots)
    })
  }

  // 打开前的模型核对（tool-model-check.ts）。只认本软件用当前账号写的配置：官方账号、
  // 手填、被改动过的都不碰；刷新菜单走 refreshToolPicker 定点改写，闸与开机同步 Key
  // 同一套所有权规则，写一半回滚（I9）也照旧。
  function modelCheckTarget(provider: ProviderId, accountOwnedOnly: boolean): ToolModelCheckTarget | null {
    if (store.read().officialProviders?.includes(provider)) return null
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (!owner) return null
    const config = inspectNativeProviderConfig(provider)
    const apiKey = config.apiKey?.trim() ?? ''
    const model = config.model.trim()
    if (!config.hasApiKey || !config.matchesRelay || !apiKey || !model) return null
    if (accountOwnedOnly && configOwnership.read(provider, config, owner) !== 'account') return null
    const site = activeRelaySite()
    return { apiKey, model, identity: `${site.id}:${owner}:${modelAccessCacheKey(apiKey)}:${model}` }
  }

  const toolModelChecker = createToolModelChecker({
    now: () => Date.now(),
    target: (provider) => modelCheckTarget(provider, true),
    // 写入当中认人时不看来源记录：来源是不是当前账号，由写入那道闸（refreshToolPicker、
    // replaceToolModel）进锁时自己把关。刷新以前走 saveConfig，写之前先把记录改成「手动」，
    // 按记录认人的话刷新永远在写到一半时作废，记录还留在「手动」（#562 起 Claude Code 的菜单
    // 就是这样一次没刷成过）。
    identity: (provider) => modelCheckTarget(provider, false)?.identity ?? null,
    listModels: (apiKey) => fetchAvailableModels(apiKey, { bypassCache: true }),
    pickerOutdated: (provider, models, model) => provider === 'claude'
      ? claudeModelPickerNeedsRefresh(models, model, providerRoots)
      : codexModelCatalogOutdated(models, model),
    refreshPicker: (provider, model, assertCurrent) => refreshToolPicker(provider, model, assertCurrent),
    replaceModel: (provider, from, to, assertCurrent) => replaceToolModel(provider, from, to, assertCurrent),
    ...(serviceOptions.cliModelHints ? { modelHints: serviceOptions.cliModelHints } : {}),
    upgradeOffered: (provider, model) => (store.read().offeredModelUpgrades ?? []).includes(`${provider}:${model}`),
    markUpgradeOffered: async (provider, model) => {
      await store.update({ version: 2, offeredModelUpgrades: [`${provider}:${model}`] })
    },
    log: (level, event, message, detail) => runtimeLog?.log(level, 'config', event, message, detail),
  })

  /**
   * 开机那轮因为工具可能开着而没做的（第二十六批 E）：哪几个工具的设置没补、Codex 的型号
   * 名单有没有按账号核对。客户升级后头一回开星芒时 Codex 多半正开着，以前要等下次开机；
   * 现在渲染层隔一阵来要一次（retry），只补这几样。记的是那一轮的账号，换了账号就作废。
   */
  let templateFillDebt: { owner: string; providers: readonly ProviderId[]; codexModelCatalog: boolean } | null = null

  /**
   * 换账号、退出、登录要先等跟账号有关的活都收尾（main.ts 的 quiesce 等 accountWork），补设置
   * 那次调用也算在里面。它动手前要在本机看工具开没开（Windows 上起 PowerShell），开机那次还要
   * 先等型号名单的本机核对；安全软件拖慢的电脑上这几步各自等到超时，加起来超过换账号肯等的
   * 30 秒，客户就看到「账号服务请求超时」，被引去查网络。这几步都只是看：换账号前叫停
   * （stopTemplateFillWaits）就不再等，还没看完的当成没看出来，不写、记成还欠着；已经在写的
   * 照常写完（都在本机，很快）。真换了账号，欠的就作废。
   * 每次调用开头拿当时那个 signal，叫停之后这次调用里后面的等待也都不等了。叫停一直管到换账号
   * 那段等待结束（调返回的函数）：已经进了门、晚一步才走到这里的那次（ipc.ts 要先读备份用的账号
   * 信息）也不等。上一次换账号超时了还在等、又来一次的，两次都放开才恢复。
   */
  let templateFillWaits = new AbortController()
  let templateFillHolds = 0
  function stopTemplateFillWaits(): () => void {
    templateFillHolds += 1
    templateFillWaits.abort()
    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      templateFillHolds -= 1
      if (!templateFillHolds) templateFillWaits = new AbortController()
    }
  }

  /**
   * 老客户的配置不跟着模板升级（第十七批第 2 条）：开机恢复账号只核对连没连上，一个字
   * 不写。这里对「来源确认是当前账号、记录的模板版本落后」的配置补一次缺省项
   * （fillRelayTemplateDefaults：只补缺的，用户写过的一律不动）。官方账号、手填、来源
   * 没确认、被改动过的都不碰；工具开着或看不出开没开的这次跳过，记进 pending 等渲染层
   * 再来要。失败只记日志，不打扰用户，版本号不前进，下次开机再试。
   * 官方账号上的 Codex 只补一样：这次以前切官方时删掉的、旧对话记着的那张表
   * （restoreCodexOfficialAlias），开着不补、先备份，与上面同一套规矩。
   */
  async function fillToolTemplateDefaults(backup: ((provider: ProviderId) => void) | undefined, round: TemplateFillRound, stopped: AbortSignal): Promise<ToolTemplateFillResult> {
    const filled: ProviderId[] = []
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (!owner) return { filled }
    function outdated(provider: ProviderId): boolean {
      if (store.read().officialProviders?.includes(provider)) return false
      const config = inspectNativeProviderConfig(provider)
      if (!config.hasApiKey || !config.matchesRelay) return false
      if (configOwnership.read(provider, config, owner) !== 'account') return false
      const revision = configOwnership.templateRevision(provider, config)
      return revision !== null && revision < relayTemplateRevision
    }
    function codexSiteBaseUrls(): Record<ProviderId, string> {
      return providerRelaySite('codex', inspectNativeProviderConfig('codex')).providerBaseUrls
    }
    function relayChatsStranded(provider: ProviderId): boolean {
      if (provider !== 'codex' || !store.read().officialProviders?.includes(provider)) return false
      try {
        return codexOfficialAliasPending(providerRoots, codexSiteBaseUrls())
      } catch {
        // 配置读不了是别处要报的事，这一项看不了就不补，不连累别的工具补设置。
        return false
      }
    }
    const due = round.providers.filter((provider) => outdated(provider) || relayChatsStranded(provider))
    if (!due.length) return { filled }
    let report: RunningToolsReport
    try {
      report = await unlessStopped(() => (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(due), stopped)
    } catch {
      return { filled, pending: due }
    }
    // 补做那几次在日志里标出来，客服看得出开机那轮之后又试过几回。
    const again = round.retry ? { retry: true } : {}
    const pending: ProviderId[] = []
    for (const provider of due) {
      const busy = report.running.includes(provider) || report.unknown.includes(provider)
        || (provider === 'codex' && report.codexDesktopRunning !== false)
      if (busy) {
        runtimeLog?.log('info', 'config', 'template-defaults.deferred', '工具可能正开着，这次先不补设置', { provider, ...again })
        pending.push(provider)
        continue
      }
      try {
        const wrote = await serializeConfigWrite(async () => {
          // 排队期间账号、配置都可能变了：进锁以后按同一套条件再判一次。
          if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) return false
          if (relayChatsStranded(provider)) {
            backup?.(provider)
            const restored = restoreCodexOfficialAlias(providerRoots, codexSiteBaseUrls()) !== null
            if (restored) runtimeLog?.log('info', 'config', 'codex.official-alias.restored', '已给官方账号上的 Codex 补回以前对话要用的线路表', round.retry ? { retry: true } : undefined)
            return restored
          }
          if (!outdated(provider)) return false
          const site = providerRelaySite(provider, inspectNativeProviderConfig(provider))
          // 已经齐了（多半是新模板写的，只是记录里还没有版本号）就只记版本号，不留备份。
          // 真要补才先做一份与保存配置同样的整套备份，「设置 › 备份迁移」里能找回补之前的样子；
          // 备份不成就不补。
          const pending = relayTemplateDefaultsPending(provider, providerRoots, site.providerBaseUrls)
          if (pending) backup?.(provider)
          const result = pending ? fillRelayTemplateDefaults(provider, providerRoots, site.providerBaseUrls) : null
          // 补的都是指纹之外的键，来源记录照旧是当前账号，只把版本号往前挪。
          await configOwnership.write(provider, inspectNativeProviderConfig(provider), 'account', owner, relayTemplateRevision)
          // 第 5 版：编辑器设置不在工具配置目录里，不算进上面的「补齐」，每份配置跟着版本号只做这一次。
          if (provider === 'claude') disableEditorClaudeLoginPrompt()
          return result !== null
        })
        if (wrote) {
          filled.push(provider)
          runtimeLog?.log('info', 'config', 'template-defaults.filled', '已按新版模板给工具补齐设置', { provider, ...again })
        }
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'template-defaults.failed', '给工具补齐设置没有完成，下次开机再试', { provider, reason: credentialFailureReason(error) })
      }
    }
    return pending.length ? { filled, pending } : { filled }
  }

  /**
   * 开机那一轮把 Codex 的型号名单对一遍：先在本机收回读不进的（不看账号），再按当前账号能用
   * 的型号补上或刷新（tool-model-check.ts 的 syncPicker）。老客户升级以后配置不会重写，多半
   * 也直接从开始菜单打开桌面端、不经过打开前那次核对，不在这里补，新型号就一直进不了菜单。
   * 按账号刷新与补设置同一套规矩：Codex 开着或看不出开没开的这次不动（桌面端自己也会写
   * config.toml），返回 true 记成还欠着；真要改先做一份与保存配置同样的备份，备份不成就不改。
   * 按账号核对要先问一遍中转，放到后台去做，不等它。失败只记日志。
   */
  async function syncCodexModelCatalog(backup: ((provider: ProviderId) => void) | undefined, round: TemplateFillRound, stopped: AbortSignal): Promise<boolean> {
    if (!serviceOptions.bundledCodexModelCatalogPath) return false
    try {
      await unlessStopped(guardCodexModelCatalogAtStartup, stopped)
    } catch {
      // 那次核对从不抛错，到这里只会是换账号叫停：核对照旧在后台做（main.ts 开机也起它）；欠不欠这次还没看，照原样记。
      return round.codexModelCatalog
    }
    // 不是当前账号写的 Codex 配置本来就不按账号刷新，谈不上欠着，不必起进程看它开没开。
    if (!round.codexModelCatalog || !modelCheckTarget('codex', true)) return false
    let report: RunningToolsReport
    try {
      report = await unlessStopped(() => (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(['codex']), stopped)
    } catch {
      return true
    }
    if (report.running.includes('codex') || report.unknown.includes('codex') || report.codexDesktopRunning !== false) {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.sync-deferred', 'Codex 可能正开着，型号名单这次先不按账号刷新', round.retry ? { retry: true } : undefined)
      return true
    }
    if (round.retry) runtimeLog?.log('info', 'config', 'codex-model-catalog.sync-resumed', 'Codex 已经关了，型号名单补做一次按账号核对')
    void toolModelChecker.syncPicker('codex', {
      // 问中转、问 Codex 版本那几秒里客户可能刚打开了它：写之前再看一眼，规矩同下面 Claude Code、Grok 那条（#1154）。
      beforeRefresh: async () => {
        const latest = await (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(['codex'])
        if (latest.running.includes('codex') || latest.unknown.includes('codex') || latest.codexDesktopRunning !== false) throw new Error('Codex 可能正开着，这次先不写')
        backup?.('codex')
      },
    }).catch(() => undefined)
    return false
  }

  /**
   * 开机那轮替 Claude Code、Grok 换掉已下架的默认型号（Codex 由上面的 syncPicker 连菜单一起管）。下架名单
   * 可以由服务状态文件加（cli-model-defaults.ts），站上下架一个型号不用等发版。只碰当前账号写的配置：
   * 配置里的型号不在名单上就什么都不做，不起进程看工具开没开；在名单上、工具开着或看不出开没开的这次不换，
   * 交回去记成还欠着，与补设置同一套规矩。真换由 toolModelChecker.replaceRetired 在后台做：先问一遍中转，
   * 账号确实不再列它、写之前再看一眼工具还关着才换，先备份。返回这次欠下的工具。
   */
  async function replaceRetiredCliModels(backup: ((provider: ProviderId) => void) | undefined, round: TemplateFillRound, stopped: AbortSignal): Promise<ProviderId[]> {
    const candidates = round.providers.filter((provider) => provider === 'claude' || provider === 'grok')
    if (!candidates.length) return []
    let hints: CliModelHints | null = null
    if (serviceOptions.cliModelHints) {
      const loadHints = serviceOptions.cliModelHints
      try {
        hints = await unlessStopped(() => loadHints().catch(() => null), stopped)
      } catch {
        // 换账号叫停：没看过就谈不上欠，下次开机再看。
        return []
      }
    }
    const due = candidates.filter((provider) => {
      const target = modelCheckTarget(provider, true)
      return target !== null && isRetiredCliModel(provider, target.model, hints)
    })
    if (!due.length) return []
    let report: RunningToolsReport
    try {
      report = await unlessStopped(() => (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(due), stopped)
    } catch {
      return due
    }
    const pending: ProviderId[] = []
    for (const provider of due) {
      if (report.running.includes(provider) || report.unknown.includes(provider)) {
        runtimeLog?.log('info', 'config', 'tool-models.retired-deferred', '工具可能正开着，已下架的默认模型这次先不换', { provider, ...(round.retry ? { retry: true } : {}) })
        pending.push(provider)
        continue
      }
      void toolModelChecker.replaceRetired(provider, {
        // 问中转那几秒里客户可能刚从终端打开工具：写之前再看一眼，开着或看不出就这次不写。这时开机那轮
        // 已经交了差，不再记成欠着；下次开机再换，从星芒打开的打开前那一问也会劝换。
        beforeReplace: async () => {
          const latest = await (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)([provider])
          if (latest.running.includes(provider) || latest.unknown.includes(provider)) throw new Error('工具可能正开着，这次先不换')
          backup?.(provider)
        },
      }).catch(() => undefined)
    }
    return pending
  }

  /**
   * 开机那次：先补设置，再在本机看 Codex 开没开、型号名单欠不欠，两样都算进 pending 交回去；
   * 按账号核对型号名单要先问一遍中转，补设置那句提示不等它。retry = 渲染层隔一阵来补做
   * （第二十六批 E）：只做开机那轮欠下的，换了账号就什么都不做。
   */
  async function fillToolTemplateDefaultsThenSyncPickers(backup?: (provider: ProviderId) => void, retry = false): Promise<ToolTemplateFillResult> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const debt = templateFillDebt?.owner === owner ? templateFillDebt : null
    if (retry && !debt) return { filled: [] }
    const round: TemplateFillRound = retry && debt
      ? { retry, providers: debt.providers, codexModelCatalog: debt.codexModelCatalog }
      : { retry: false, providers: activeProviderIds, codexModelCatalog: true }
    const stopped = templateFillWaits.signal
    let result: ToolTemplateFillResult
    try {
      result = await fillToolTemplateDefaults(backup, round, stopped)
    } catch (error) {
      void syncCodexModelCatalog(backup, round, stopped).catch(() => false)
      void replaceRetiredCliModels(backup, round, stopped).catch(() => [])
      throw error
    }
    const catalogOwed = await syncCodexModelCatalog(backup, round, stopped).catch(() => false)
    const retiredOwed = await replaceRetiredCliModels(backup, round, stopped).catch((): ProviderId[] => [])
    const skipped = [...new Set([...(result.pending ?? []), ...retiredOwed])]
    templateFillDebt = owner && (skipped.length || catalogOwed) ? { owner, providers: skipped, codexModelCatalog: catalogOwed } : null
    const pending = activeProviderIds.filter((provider) => skipped.includes(provider) || (provider === 'codex' && catalogOwed))
    // 客服看报告分得清是工具开着没补，还是给换账号让了路。
    if (stopped.aborted) runtimeLog?.log('info', 'config', 'template-defaults.stopped', '要换账号了，补设置不再等本机检测，没补的下次再补', { pending, ...(round.retry ? { retry: true } : {}) })
    return pending.length ? { filled: result.filled, pending } : { filled: result.filled }
  }

  return { refreshGrokHooksForShellChange, addMissingGrokHooks, takeBackUnreadableCodexModelCatalog, forgetCodexModelCatalogReaders, rememberedWorkspaceFor, repairGrokHooksBeforeLaunch, buildConfigSummary, inspectCodexReadiness, revealApiKey, saveConfig, repairCliHooks, autoRepairStaleCliHooks, toolModelChecker, guardCodexModelCatalogAtStartup, reclaimRetiredToolIntegrations, fillToolTemplateDefaultsThenSyncPickers, stopTemplateFillWaits }
}
