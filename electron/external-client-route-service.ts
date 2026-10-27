// 三个外部桌面客户端（Claude Desktop、WorkBuddy、OpenCode）的那一段（#1070 第 3 步，从 system-service.ts 的
// createSystemService 原样搬来）：盘点、安装、打开、测试连接，写配置和切回官方账号，以及换线路、换 Key 以后
// 替当前账号写进去的那份跟着换（客户端开着就等它退出再换）。写配置的几件事排同一个队（queueExternalConfigWork）。
//
// 各簇共用的那份在 system-service-context.ts；查当前密钥能用哪些型号由 createSystemService 传进来
// （ExternalClientRouteServiceDependencies）。这里只 import system-service.ts 的类型。
import os from 'node:os'
import path from 'node:path'
import { cliCatalog, isRetiredProviderId, type ProviderId } from './catalog'
import { createClaudeDesktopConfigService } from './claude-desktop-config'
import { inspectClaudeDesktopStoreVirtualization } from './claude-desktop-manifest'
import { resolveClaudeDesktopPaths } from './claude-desktop-paths'
import { assertClaudeDesktopUnmanaged } from './claude-desktop-policy'
import { resolveClaudeDesktopModels } from './claude-desktop-models'
import { buildGatewayMessagesProbe, runConnectionProbe } from './connection-check'
import { type ExternalClientCheckResult, runExternalClientCheck } from './external-client-connection'
import {
  type DesktopAppUpdateRequest,
  type ExternalClientConfigResult,
  type ExternalClientInstallProgress,
  externalClientNames,
  type ExternalClientRuntimeStatus,
  type ExternalClientSourceSwitchResult,
  type ExternalClientStatus,
} from './external-client-contract'
import type { ExternalClientKeySource } from './external-client-ownership'
import {
  createExternalClientRuntime,
  type ExternalClientDetectionErrorDetail,
  type ExternalClientMacVerificationFailure,
  type ExternalClientRegistryFailure,
} from './external-client-runtime'
import { createExternalClientSnapshotCache } from './external-client-snapshot-cache'
import {
  type ExternalToolConfigOptions,
  type ExternalToolId,
  type ExternalToolProbeCredential,
  followExternalToolKey,
  followExternalToolRoute,
  inspectExternalToolConnection,
  resolveExternalToolProbeCredential,
  saveExternalToolConfig,
} from './external-tool-config'
import { isReplacedManagedKey, type StoredManagedCliKey } from './managed-cli-key-store'
import { type RelayEndpointId, type RelaySite, relaySiteProviderBaseUrlVariants } from './relay-sites'
import { redactHomeDirectory } from './startup-log'
import type { RendererMessageTarget } from './system-service'
import type { ServiceContext } from './system-service-context'

/** 读不出来的安装记录进运行日志时的那几项：原因里万一带着主目录，按主目录脱敏。 */
export function buildExternalClientRegistryLogDetail(failures: ExternalClientRegistryFailure[], userHome: string) {
  return { failures: failures.map((failure) => ({ ...failure, reason: redactHomeDirectory(failure.reason, userHome) })) }
}

/** 苹果没放行时进运行日志的那几项：应用包可能在主目录下的「应用程序」里，原话里也会带着这个路径。 */
export function buildExternalClientMacVerificationLogDetail(failure: ExternalClientMacVerificationFailure, userHome: string) {
  return { ...failure, path: redactHomeDirectory(failure.path, userHome), output: redactHomeDirectory(failure.output, userHome) }
}

/** 检测失败时 PowerShell 的原话进运行日志的那几项：读签名报的错里常带着客户端的完整路径。 */
export function buildExternalClientDetectionErrorLogDetail(failure: ExternalClientDetectionErrorDetail, userHome: string) {
  return { ...failure, message: redactHomeDirectory(failure.message, userHome) }
}

/**
 * 外部客户端要跟上的那几把（#1113）：星芒替哪几个工具换过 Key、它们自己也已经换上了缓存里那把，连同读出来的缓存。
 * 换了账号的（已知37）另交两样：工具现在用的就是当前账号缓存里那把的（inUse），和这台电脑上同一个站别的账号缓存过的
 * 托管 Key（previousAccounts）。主进程内部专用（I3）。
 */
export interface ManagedKeyFollowTarget {
  owner: string
  keys: readonly { provider: ProviderId; apiKey: string }[]
  cachedKeys: readonly StoredManagedCliKey[]
  inUse: readonly { provider: ProviderId; apiKey: string }[]
  previousAccounts: readonly { owner: string; keys: readonly StoredManagedCliKey[] }[]
}

/** 这把是不是这个账号缓存里给 provider 的托管 Key：眼下那把，或者以前缓存过、后来被换掉的那几把。 */
function isAccountManagedKey(provider: ProviderId, key: string, cachedKeys: readonly StoredManagedCliKey[]): boolean {
  return cachedKeys.some((entry) => entry.provider === provider && entry.key === key) || isReplacedManagedKey(provider, key, cachedKeys)
}

/** 星芒写进客户端、现在正用着的那一份（externalClientKeyCredential）。主进程内部专用（I3）。 */
interface ExternalClientKeyCredential {
  route: { endpointId: RelayEndpointId; baseUrl: string }
  baseUrl: string
  apiKey: string
  model: string | null
}

/** 比两个线路地址时不计末尾的斜杠：Claude Desktop 设置窗口里存的地址可能带一个。 */
function sameRouteUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
}

// 保存 Claude Desktop 配置时试一个型号最多等多久。试的那几个不通只是菜单里少一个，不值得照自检默认的 20 秒等。
const claudeDesktopModelProbeTimeoutMs = 8_000

/** 外部客户端要用、但归别处管的那一样，由 createSystemService 传进来。 */
export interface ExternalClientRouteServiceDependencies {
  /** 查这把密钥在当前站能用哪些型号（带缓存；保存配置前要绕过缓存现查）。 */
  fetchAvailableModels: (
    apiKeyInput: string,
    options?: { bypassCache?: boolean; site?: RelaySite; routed?: boolean },
  ) => Promise<string[]>
}

export function createExternalClientRouteService(context: ServiceContext, dependencies: ExternalClientRouteServiceDependencies) {
  const {
    serviceOptions, windowsExecutionMode, platform, providerRoots, runtimeLog, externalOwnership, relayRouting,
    activeRelaySite, inspectNativeProviderConfig, executeCommand, downloadFetch, installationQueue,
    desktopBucketDownloads, latestMacosDesktopVersions, assertInstallDiskSpace, withDownloadAcceleration, credentialFailureReason, toolRouteNow,
    scheduleToolRouteTimer,
  } = context
  const {
    fetchAvailableModels,
  } = dependencies

  // 从星芒打开过的客户端装在哪：之后问它还在不在跑要用。没打开成记 null（当它不在），还在打开就没有这一项。
  const launchedClientPaths = new Map<ExternalToolId, string | null>()
  const externalClientRuntime = serviceOptions.externalClientRuntime ?? createExternalClientRuntime({
    installationQueue, platform, userHome: providerRoots.userHome, runCommand: executeCommand, windowsExecutionMode,
    // Mac 上一键装桌面端自己下官方包：和命令行工具一样走系统代理、临时加速，下之前先看盘。
    fetch: downloadFetch,
    withDownloadRoute: (operation) => withDownloadAcceleration(null, operation),
    bucketDownloads: desktopBucketDownloads,
    ...(latestMacosDesktopVersions ? { latestMacosDesktopVersions } : {}),
    assertDiskSpace: assertInstallDiskSpace,
    onWingetUnavailable: (reason) => runtimeLog?.log('warn', 'install', 'external-client.winget-unavailable', '桌面客户端无法一键安装：系统 winget 不可用', { reason }),
    // 首页只说「部分软件安装记录无法读取」；是哪几条、为什么，客服在反馈报告里看这一行。
    onRegistryIncomplete: (failures) => runtimeLog?.log('warn', 'system', 'external-client.registry-incomplete', '部分软件安装记录无法读取，桌面客户端检测不完整',
      buildExternalClientRegistryLogDetail(failures, providerRoots.userHome)),
    onMacVerificationFailed: (failure) => runtimeLog?.log('warn', 'system', 'external-client.mac-verification-failed', '桌面客户端没通过苹果的签名核对',
      buildExternalClientMacVerificationLogDetail(failure, providerRoots.userHome)),
    // 首页只说「无法读取客户端数字签名」这类前半句中文（已知3），系统给的原话客服在反馈报告里看这一行。
    onDetectionErrorDetail: (failure) => runtimeLog?.log('warn', 'system', 'external-client.detection-error-detail', '桌面客户端检测失败时系统给的原话',
      buildExternalClientDetectionErrorLogDetail(failure, providerRoots.userHome)),
    // 客户说「打开还是慢」，客服在反馈报告里看这一行：慢在排队、PowerShell 启动、读安装记录、核签名，还是交出去以后客户端自己慢。
    onLaunchTiming: (timing) => runtimeLog?.log('info', 'system', 'external-client.launch-timing', '打开桌面客户端前各段用时', { ...timing }),
    onLaunched: (tool, clientPath) => { launchedClientPaths.set(tool, clientPath) },
  })

  let externalConfigQueue: Promise<unknown> = Promise.resolve()
  // 写配置、切回官方账号、跟着换线路换 Key，改的都是这三家客户端的同一批文件，排同一个队。前一件失败不挡
  // 后一件（then 的两支都接 work）；队尾吞掉失败只为接着排，调用方照样拿到自己那件的结果或错误。
  function queueExternalConfigWork<T>(work: () => Promise<T>): Promise<T> {
    const task = externalConfigQueue.then(work, work)
    externalConfigQueue = task.catch(() => undefined)
    return task
  }
  let latestExternalClients: ExternalClientStatus[] | null = null
  const externalClientCache = serviceOptions.externalClientSnapshotCacheFile
    ? createExternalClientSnapshotCache({
        filePath: serviceOptions.externalClientSnapshotCacheFile,
        onWarning: (code, message) => runtimeLog?.log('warn', 'system', code, '上次客户端检测结果没有读写成功', { error: message }),
      })
    : null
  let externalScansStarted = 0
  let newestExternalScanSaved = 0
  // 这次运行里替客户端换成过几回 Key（#1113、已知37）：保存配置后台那一眼换成了，界面要重读。
  let externalKeysFollowed = 0
  // 保存配置后台那一眼正在跑的那一轮，和跑着时又有人叫过（见 followManagedKeysNow）。
  let followingManagedKeys: Promise<void> | null = null
  let followManagedKeysAgain = false
  // 这次运行里替哪个账号的哪个客户端换过线路，记着原来的地址和那把 Key（只在主进程内存里）：
  // 换完又回到原来那份（推测是客户端退出时把旧配置写了回去），要能在日志里说出来。
  const externalRoutesFollowed = new Map<string, { from: RelayEndpointId; baseUrl: string; apiKey: string }>()
  async function claudeDesktopConfig(status: ExternalClientRuntimeStatus, assertBeforeWrite?: () => void) {
    if (status.detectionError) throw new Error('Claude Desktop 安装位置无法确认，请重新检测')
    const env = serviceOptions.claudeDesktopEnv ?? (providerRoots.userHome === os.homedir() ? process.env : {})
    const installationPath = status.path ?? undefined
    const storeVirtualization = env.CLAUDE_USER_DATA_DIR ? undefined
      : await (serviceOptions.inspectClaudeDesktopStoreVirtualization ?? inspectClaudeDesktopStoreVirtualization)({ platform, installationPath })
    assertBeforeWrite?.()
    const roots = resolveClaudeDesktopPaths({ platform, userHome: providerRoots.userHome, env, installationPath, storeVirtualization })
    return createClaudeDesktopConfigService({
      dataDirectory: serviceOptions.managerDataDirectory ?? path.join(providerRoots.userHome, '.xingmang-ai-manager'),
      ...roots,
      assertBeforeWrite,
      assertUnmanaged: serviceOptions.assertClaudeDesktopUnmanaged ?? (() => assertClaudeDesktopUnmanaged({ platform, userHome: providerRoots.userHome })),
    })
  }
  /**
   * 「这个客户端该对哪个地址、用谁的账号对账」只算一次：检测、连接自检与保存
   * 后的复测读的必须是同一份，否则换过站点或换过账号的用户会在三处拿到三种
   * 说法。
   */
  function externalClientContext(tool: ExternalToolId) {
    const activeSite = activeRelaySite()
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const baseUrl = tool === 'claudeDesktop' ? activeSite.providerBaseUrls.claude : activeSite.providerBaseUrls.codex
    // 归属按配置所在那条线路的地址认：平时就是当前线路，Claude Desktop 从官方登录切回时也认这个站的别的线路（#1112）。
    const ownedOnRoute = (apiKey: string, routeBaseUrl: string) => owner !== null
      && serviceOptions.getExternalClientAccountId?.() === owner
      && activeRelaySite().id === activeSite.id
      && externalOwnership.matches(tool, owner, routeBaseUrl, apiKey)
    const belongsToCurrentAccount = (apiKey: string) => ownedOnRoute(apiKey, baseUrl)
    return { activeSite, owner, baseUrl, belongsToCurrentAccount, ownedOnRoute }
  }
  async function describeExternalClient(status: ExternalClientRuntimeStatus): Promise<ExternalClientStatus> {
    const { baseUrl, belongsToCurrentAccount } = externalClientContext(status.tool)
    if (status.tool === 'claudeDesktop') {
      try {
        return { ...status, ...await (await claudeDesktopConfig(status)).inspectConnection(baseUrl, belongsToCurrentAccount) }
      } catch {
        return { ...status, configured: false, model: null, configurationSource: 'unknown',
          configurationError: 'Claude Desktop 本地配置目录无法确认，请重新检测。' }
      }
    }
    const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
    if (xdgConfig && !path.isAbsolute(xdgConfig)) return { ...status, configured: false, model: null,
      configurationSource: 'unknown', configurationError: 'XDG_CONFIG_HOME 必须是绝对路径。' }
    const externalPlatform = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
    return { ...status, ...inspectExternalToolConnection(status.tool, externalPlatform, {
      userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
    }, baseUrl, belongsToCurrentAccount) }
  }
  /**
   * 客户端配置里那把密钥。**只在主进程内部用**：它要被拿去发一次真实请求，
   * 永远不跨 IPC（I3）。取不出来（没配、不是当前账号写的、文件读不了）一律
   * 回 null，由调用方按「未配置 / 本地配置」去说。
   */
  async function externalClientProbeCredential(
    status: ExternalClientRuntimeStatus,
    baseUrl: string,
    belongsToCurrentAccount: (apiKey: string) => boolean,
  ): Promise<ExternalToolProbeCredential | null> {
    try {
      if (status.tool === 'claudeDesktop') {
        return await (await claudeDesktopConfig(status)).inspectGatewayCredential(baseUrl, belongsToCurrentAccount)
      }
      const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
      if (xdgConfig && !path.isAbsolute(xdgConfig)) return null
      const externalPlatform = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
      return resolveExternalToolProbeCredential(status.tool, externalPlatform, {
        userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
      }, baseUrl, belongsToCurrentAccount)
    } catch {
      // 读不出来不是自检失败，是「本地配置」层的结论，由 describeExternalClient
      // 那一份已经算出来的 configurationSource 去说。
      return null
    }
  }
  /**
   * 外部客户端的连接自检。「检查」页与保存后的复测走同一条路，所以两处永远
   * 给同一句结论。
   */
  async function checkExternalClientConnection(
    tool: ExternalToolId,
    knownStatus?: ExternalClientRuntimeStatus | null,
  ): Promise<ExternalClientCheckResult> {
    const { activeSite, baseUrl, belongsToCurrentAccount } = externalClientContext(tool)
    // 装没装这件事只在 Windows 上要跑一轮 PowerShell 盘点。调用方手里已经有一份
    // 时就用那份：保存配置之后顺手自检不该为此再盘点一次机器。
    const status = knownStatus ?? (await externalClientRuntime.scan()).find((entry) => entry.tool === tool) ?? null
    const described = status ? await describeExternalClient(status) : null
    const credential = status && described?.configurationSource === 'xingmang'
      ? await externalClientProbeCredential(status, baseUrl, belongsToCurrentAccount)
      : null
    return runExternalClientCheck({
      tool,
      installed: status?.installed === true,
      baseUrl,
      configurationSource: described?.configurationSource ?? 'unknown',
      configurationError: described?.configurationError ?? null,
      model: credential?.model ?? described?.model ?? null,
      apiKey: credential?.apiKey ?? null,
      ...(credential?.startupCheckModel ? { startupCheckModel: credential.startupCheckModel } : {}),
      ...(described?.officialAccount ? { officialAccount: true } : {}),
    }, activeSite.id, { fetch: serviceOptions.relayFetch })
  }
  async function scanExternalClients(force = false): Promise<ExternalClientStatus[]> {
    const started = ++externalScansStarted
    // 本机盘点几分钟内复用（见 external-client-runtime 的缓存），配置每次都重读：
    // 保存配置之后那次刷新要看到的正是刚写下去的那份。
    const clients = await followExternalClientRoutes(await externalClientRuntime.scan({ force }))
    // 反馈报告要答「客户端装没装、什么版本、配置指没指向当前账号」，而生成报告
    // 时不该再发一轮探测（同 latestTraySystem 的取舍）。这份快照就是那一段的
    // 数据源：只在用户自己点检测时更新。
    latestExternalClients = clients
    // 下次开机首页先摆它（已知13）。强制重扫与普通扫描可能交错完成，落盘只让后开始的那一轮
    // 覆盖先开始的，同 CLI 那份快照。
    if (started > newestExternalScanSaved) {
      newestExternalScanSaved = started
      void externalClientCache?.save(clients)
    }
    return clients
  }
  async function cachedExternalClients(): Promise<ExternalClientStatus[]> {
    if (latestExternalClients || !externalClientCache) return []
    const cached = await externalClientCache.load()
    // 读文件这几毫秒里真的检测可能已经回来了，那就不必再给旧的。
    return latestExternalClients || !cached ? [] : cached
  }
  /** 反馈报告用的上一份客户端快照；还没检测过时为 null，那一段写「未能读取」。 */
  function getLastExternalClients(): ExternalClientStatus[] | null {
    return latestExternalClients
  }
  async function installExternalClient(tool: ExternalToolId, target: RendererMessageTarget, request?: DesktopAppUpdateRequest): Promise<ExternalClientStatus> {
    function forward(event: ExternalClientInstallProgress) {
      if (!target.isDestroyed()) {
        try { target.send('external-clients:install-progress', event) } catch { /* Installation continues if the renderer exits. */ }
      }
    }
    const status = await (request ? externalClientRuntime.install(tool, forward, request) : externalClientRuntime.install(tool, forward))
    const described = await describeExternalClient(status)
    // 就地替换而不是追加：这份快照的顺序就是反馈报告与界面读到的顺序。
    latestExternalClients = latestExternalClients?.some((entry) => entry.tool === tool)
      ? latestExternalClients.map((entry) => entry.tool === tool ? described : entry)
      : [...(latestExternalClients ?? []), described]
    return described
  }
  const cancelExternalClientInstall = (tool: ExternalToolId) => externalClientRuntime.cancelInstall(tool)
  async function launchedClientRunning(tool: ExternalToolId): Promise<boolean | null> {
    const clientPath = launchedClientPaths.get(tool)
    if (clientPath === undefined) return null
    if (clientPath === null) return false
    return await externalClientRuntime.stillRunning?.(tool, clientPath) ?? null
  }
  async function launchExternalClient(tool: ExternalToolId): Promise<void> {
    // Claude Desktop 第一次用、每次自己升级以后都要从官网下 1GB 多的组件，国内直连下不动：先在后台替他连上
    // 加速（#1373）。连不上照常打开（它永不抛错，这里再兜一层）。
    if (tool === 'claudeDesktop' && serviceOptions.prepareClaudeDesktopLaunch) {
      await serviceOptions.prepareClaudeDesktopLaunch({ isDesktopRunning: () => launchedClientRunning('claudeDesktop') }).catch(() => undefined)
    }
    try {
      await externalClientRuntime.launch(tool)
    } catch (error) {
      if (tool === 'claudeDesktop') launchedClientPaths.set(tool, null)
      throw error
    }
  }
  /**
   * 保存之后立刻回读一遍并自检。这一步问出来的比保存时那次模型清单校验多两件
   * 事：写下去的配置本机能不能原样读回来、读回来的那把密钥在客户端真正会打的
   * 那个地址上还认不认。自检本身出岔子不该把「已经写成功了」变成失败，所以整
   * 段吞掉异常，只是结果变成 null（界面照实说「这次没测成」）。
   */
  async function verifySavedExternalClient(
    tool: ExternalToolId,
    knownStatus?: ExternalClientRuntimeStatus | null,
  ): Promise<ExternalClientCheckResult | null> {
    try {
      return await checkExternalClientConnection(tool, knownStatus)
    } catch {
      return null
    }
  }
  function configureExternalTool(
    tool: ExternalToolId,
    requested: ExternalToolConfigOptions,
    assertBeforeWrite?: () => void,
    keySource?: ExternalClientKeySource,
  ): Promise<ExternalClientConfigResult> {
    const work = async (): Promise<ExternalClientConfigResult> => {
      assertBeforeWrite?.()
      const activeSite = activeRelaySite()
      const owner = serviceOptions.getExternalClientAccountId?.() ?? null
      const apiKey = requested.apiKey?.trim() ?? ''
      const model = requested.model?.trim() ?? ''
      if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('请选择有效模型')
      const models = await fetchAvailableModels(apiKey, { bypassCache: true })
      const assertContext = () => {
        assertBeforeWrite?.()
        if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，请重新配置')
        if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，请重新配置')
      }
      assertContext()
      if (!models.includes(model)) throw new Error('当前密钥不支持所选模型，请重新检测')
      if (tool === 'claudeDesktop') {
        const status = (await externalClientRuntime.scan()).find((entry) => entry.tool === tool)
        assertContext()
        if (!status?.installed) throw new Error('请先安装 Claude Desktop，再保存第三方推理配置')
        // Claude Desktop 的型号菜单就是写进去的那份清单。选中的排第一当默认，其余 Claude 型号照它开机检查那条
        // 请求各发一个字，试通了才放进去（claude-desktop-models.ts）：0.2.12 把列着的全写进去（#685），里面有发不
        // 通的，客户那边就型号被拒、发消息没回复；#746 起只写一个，客户又在 Claude Desktop 里换不了型号。
        const baseUrl = activeSite.providerBaseUrls.claude
        const selection = await resolveClaudeDesktopModels(model, models, async (candidate) => (await runConnectionProbe(
          buildGatewayMessagesProbe(externalClientNames.claudeDesktop, baseUrl, candidate, apiKey),
          { fetch: serviceOptions.relayFetch, timeoutMs: claudeDesktopModelProbeTimeoutMs },
        )).ok)
        assertContext()
        runtimeLog?.log('info', 'config', 'external-client.claude-desktop.models', 'Claude Desktop 型号菜单只放试通了的型号', {
          models: selection.models.length, rejected: selection.rejected,
        })
        const gateway = await claudeDesktopConfig(status, assertContext)
        const input = { baseUrl, apiKey, authScheme: 'bearer' as const, models: selection.models }
        const result = await gateway.saveGateway(input)
        assertContext()
        if (owner) await externalOwnership.write(tool, owner, baseUrl, apiKey, keySource)
        const connection = await verifySavedExternalClient(tool, status)
        return { tool, model, path: result.path, files: result.files, backups: result.backups,
          outcome: 'configured', message: result.warnings.join(' '),
          restartRequired: result.restartRequired,
          connectionVerified: connection?.ok === true, connection }
      }
      const externalPlatform = platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'linux'
      const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
      if (xdgConfig && !path.isAbsolute(xdgConfig)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径')
      const result = await saveExternalToolConfig(tool, externalPlatform, {
        userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
      }, { apiKey, model, baseUrl: activeSite.providerBaseUrls.codex,
        protocol: tool === 'workbuddy' ? 'chat-completions' : requested.protocol ?? 'responses',
      }, { beforeReplace: assertContext })
      assertContext()
      if (owner) await externalOwnership.write(tool, owner, activeSite.providerBaseUrls.codex, apiKey, keySource)
      const connection = await verifySavedExternalClient(tool, latestExternalClients?.find((entry) => entry.tool === tool))
      return { tool, model, path: result.path, files: result.files, backups: result.backups, outcome: 'configured',
        message: tool === 'workbuddy' ? '配置已写入 WorkBuddy 桌面端。重新进入“设置 → 模型”选择此模型；列表未刷新时请重启 WorkBuddy。'
          : '全局配置与默认模型已保存。重新打开 OpenCode 后使用；项目配置或环境变量可能覆盖全局设置。',
        restartRequired: tool === 'opencode',
        connectionVerified: connection?.ok === true, connection }
    }
    return queueExternalConfigWork(work)
  }
  /**
   * 首页 Claude Desktop 卡上「切回官方账号 / 改用当前账号」。和保存配置排同一个队：两件事改的是同一个
   * 文件。切回当前账号只认星芒替当前账号写的、地址是这个站登记过的线路的那一份，用不上就回 reconnect，
   * 界面接着打开「连接 Claude Desktop」重新保存。官方登录期间换过线路的（#1112），归属按原来那条线路的
   * 地址认，切回时换到当前线路、归属跟着记过来，同换线路。
   */
  function switchExternalClientSource(
    tool: ExternalToolId,
    target: 'account' | 'official',
    assertBeforeWrite?: () => void,
  ): Promise<ExternalClientSourceSwitchResult> {
    const work = async (): Promise<ExternalClientSourceSwitchResult> => {
      if (tool !== 'claudeDesktop') throw new Error('未知的外部客户端类型')
      assertBeforeWrite?.()
      const { activeSite, owner, baseUrl, belongsToCurrentAccount, ownedOnRoute } = externalClientContext(tool)
      const status = (await externalClientRuntime.scan()).find((entry) => entry.tool === tool)
      assertBeforeWrite?.()
      if (!status?.installed) throw new Error(`还没有检测到 ${externalClientNames[tool]}`)
      const gateway = await claudeDesktopConfig(status, assertBeforeWrite)
      if (target === 'official') {
        const result = await gateway.useOfficialLogin(belongsToCurrentAccount)
        runtimeLog?.log('info', 'config', 'external-client.source-switched', 'Claude Desktop 已切回官方登录', { target, running: status.running })
        return { tool, target, outcome: 'switched', backups: result.backups,
          message: '已切回官方账号，原来的配置已备份。下次打开 Claude Desktop 时用你自己的 Claude 账号登录；现在开着的话，要完全退出再打开。用星芒时的聊天记录不会删，切回当前账号还能看到。' }
      }
      const routes = relaySiteProviderBaseUrlVariants(activeSite.id, 'claude')
      const result = await gateway.useGatewayLogin(baseUrl, ownedOnRoute, routes.map((route) => route.baseUrl))
      const moved = result.outcome === 'switched' ? result.moved : undefined
      // 换过线路的记一笔原来是哪条线路，日志里不记地址（同 external-client.route.*）。
      runtimeLog?.log('info', 'config', 'external-client.source-switched', result.outcome === 'switched' ? 'Claude Desktop 已改用当前账号' : 'Claude Desktop 原来那份配置用不上，要重新连接', {
        target, outcome: result.outcome, running: status.running,
        ...(moved ? { from: routes.find((route) => route.baseUrl === moved.from)?.endpointId ?? null } : {}),
      })
      if (result.outcome === 'reconnect') return { tool, target, outcome: 'reconnect' }
      if (moved && owner !== null) {
        // 归属按账号分开记，这一笔记的就是写进去的那个账号，中途换了账号也照记。地址已经换好、归属没记上的，
        // 下次检测换线路那边补记（external-client.route.recorded）。
        try {
          await externalOwnership.rewrite(tool, owner, baseUrl, moved.apiKey)
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'external-client.route.failed', 'Claude Desktop 已换到当前连接线路，归属没记上，下次检测补记', {
            tool, reason: credentialFailureReason(error),
          })
        }
      }
      return { tool, target, outcome: 'switched', backups: result.backups,
        message: '已改用当前账号，原来的配置已备份。Claude Desktop 现在开着的话，要完全退出再打开才会换过来。' }
    }
    return queueExternalConfigWork(work)
  }
  /**
   * 第四十三批 A：用户换了线路、重启以后，星芒替当前账号写进 Claude Desktop、WorkBuddy、
   * OpenCode 的那一份跟着换到当前线路，只换地址，Key、型号和别的设置都不动。四个命令行工具
   * #872 起已经这么换，规矩照那边：用户明确选过线路、地址是这个站登记过的另一条、归属对得上、
   * 客户端没开着，四条都满足才写；开着就先不写，那一行带 routePending。和保存配置排同一个队。
   * 检测时顺带做：开机那一次、「重新检测」、检查页「测试连接」之前那次都会走到。换过以后归属
   * 记在新地址上：客户端要是又把旧的那份写了回来，那份不再算星芒的，不会来回改。
   *
   * 选过线路的人连读配置也排进队：同时有两次检测时，后一次要读到前一次换完的那份，不然
   * 首页会被它旧的结论盖回去。
   */
  // C11：外部客户端开着、换线路要等它退出的，每 5 分钟只看一眼它的进程（runtime.stillRunning，不做整轮盘点），
  // 星芒窗口回到前台时也看一眼（同一个客户端两次至少隔 2 分钟）；退了就整轮检测一次，换线路在那一轮里做，
  // 写之前照旧再盘点一次（followExternalClientRoute 的 recheck）。一直看到换成、线路又变、换账号或星芒退出，
  // 不设次数上限：Claude Desktop 往往整天开着。看不出开没开的（检测失败）退成每 15 分钟整轮检测一次。
  // 跟着工具换 Key 开着等的（#1113）也记在这里，两个站都等，那一行带 keyPending。
  const externalRoutePending = new Map<ExternalToolId, { path: string; checkedAt: number; scannedAt: number }>()
  let cancelExternalRouteRecheck: (() => void) | null = null
  const externalRouteRecheckMs = 5 * 60 * 1000
  const externalRouteFocusGapMs = 2 * 60 * 1000
  const externalRouteFullScanMs = 15 * 60 * 1000

  function noteExternalRoutePending(
    statuses: readonly ExternalClientRuntimeStatus[],
    clients: readonly ExternalClientStatus[],
    keyPending: ReadonlySet<ExternalToolId> = new Set(),
  ): void {
    const now = toolRouteNow()
    for (const client of clients) {
      const clientPath = statuses.find((status) => status.tool === client.tool)?.path ?? null
      if (((client.routePending && client.routeRecheck) || keyPending.has(client.tool)) && clientPath) {
        const known = externalRoutePending.get(client.tool)
        externalRoutePending.set(client.tool, known?.path === clientPath ? known : { path: clientPath, checkedAt: now, scannedAt: now })
      } else {
        externalRoutePending.delete(client.tool)
      }
    }
    if (!externalRoutePending.size) {
      cancelExternalRouteRecheck?.()
      cancelExternalRouteRecheck = null
    } else if (!cancelExternalRouteRecheck) {
      cancelExternalRouteRecheck = scheduleToolRouteTimer(() => {
        cancelExternalRouteRecheck = null
        void recheckExternalRoutes('timer')
      }, externalRouteRecheckMs)
    }
  }

  async function recheckExternalRoutes(trigger: 'timer' | 'focus'): Promise<void> {
    const now = toolRouteNow()
    let rescan = false
    for (const [tool, entry] of [...externalRoutePending]) {
      if (trigger === 'focus' && now - entry.checkedAt < externalRouteFocusGapMs) continue
      entry.checkedAt = now
      const running = await externalClientRuntime.stillRunning?.(tool, entry.path) ?? null
      if (running === false || (running === null && now - entry.scannedAt >= externalRouteFullScanMs)) {
        entry.scannedAt = now
        rescan = true
      }
    }
    if (rescan) {
      const waiting = new Set(externalRoutePending.keys())
      try {
        await scanExternalClients(true)
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'external-client.route.recheck-failed', '外部客户端这次没检测成，稍后再看', { reason: credentialFailureReason(error) })
      }
      // 换成了的那几个界面要重读；没换成的照旧等。
      if ([...waiting].some((tool) => !externalRoutePending.has(tool))) serviceOptions.onToolRouteFollowed?.()
    }
    if (externalRoutePending.size && !cancelExternalRouteRecheck) {
      cancelExternalRouteRecheck = scheduleToolRouteTimer(() => {
        cancelExternalRouteRecheck = null
        void recheckExternalRoutes('timer')
      }, externalRouteRecheckMs)
    }
  }

  function recheckPendingExternalRoutes(): void {
    if (externalRoutePending.size) void recheckExternalRoutes('focus')
  }

  // 星芒退出时停掉还在等客户端退出的那次回头看（createSystemService 的 disposeToolRoutes 调）。
  function cancelPendingExternalRouteRecheck(): void {
    cancelExternalRouteRecheck?.()
    cancelExternalRouteRecheck = null
  }

  async function followExternalClientRoutes(statuses: readonly ExternalClientRuntimeStatus[]): Promise<ExternalClientStatus[]> {
    const describe = () => Promise.all(statuses.map(describeExternalClient))
    const to = relayRouting.selection(activeRelaySite().id)
    if (to === undefined && !await externalKeyTarget(statuses)) {
      const clients = await describe()
      // 之前开着等换 Key 的，现在不用换了（客户自己重配过、Claude Code 又换了别的）：别再隔 5 分钟看一眼。
      if (externalRoutePending.size) noteExternalRoutePending(statuses, clients)
      return clients
    }
    const work = async () => {
      const clients = await describe()
      const updated = new Map<ExternalToolId, ExternalClientStatus>()
      // 已经在当前线路上的不用再读一遍（Windows 商店版读 Claude Desktop 配置要起一次 PowerShell）；
      // 没装上的看不出开没开，不碰。
      const candidates = to === undefined ? [] : statuses.flatMap((status) => {
        const client = clients.find((entry) => entry.tool === status.tool)
        return client && status.installed && !status.detectionError && client.configurationSource === 'other' ? [{ status, client, to }] : []
      })
      for (const { status, client, to } of candidates) {
        try {
          const next = await followExternalClientRoute(status, client, to)
          if (next) updated.set(status.tool, next)
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'external-client.route.failed', `${externalClientNames[status.tool]} 的连接线路这次没换成，下次检测再试`, {
            tool: status.tool, to, reason: credentialFailureReason(error),
          })
        }
      }
      // 换 Key 放在换线路之后：两样都要换时，这一轮先换地址；旧 Key 在新线路上不认、地址没换成的，Key 照样换，
      // 地址下一轮再换。排队这会儿工具的 Key 可能又换过，所以进了队再看一次。
      const keyPending = new Set<ExternalToolId>()
      const keyTarget = await externalKeyTarget(statuses)
      if (keyTarget) {
        for (const status of statuses) {
          const client = updated.get(status.tool) ?? clients.find((entry) => entry.tool === status.tool)
          if (!client || !status.installed || status.detectionError) continue
          const followed = await followExternalClientKey(status, client, keyTarget)
          if (followed.client) updated.set(status.tool, followed.client)
          if (followed.pending) keyPending.add(status.tool)
        }
      }
      const result = clients.map((client) => updated.get(client.tool) ?? client)
      noteExternalRoutePending(statuses, result, keyPending)
      return result
    }
    return queueExternalConfigWork(work)
  }
  /** 这一轮要不要看外部客户端跟没跟上工具的 Key：一个都没装上、看不出装没装的不看（#1113）。 */
  async function externalKeyTarget(statuses: readonly ExternalClientRuntimeStatus[]): Promise<ManagedKeyFollowTarget | null> {
    return statuses.some((status) => status.installed && !status.detectionError) ? managedKeyFollowTarget() : null
  }
  /**
   * #1113：Claude Desktop 默认借 Claude Code 那把星芒密钥，WorkBuddy、OpenCode 也能选「使用某工具当前的密钥」。
   * 星芒替那个工具换了 Key（撤销后换新、失效重签、换组）以后，客户端要跟上的就是它现在用的那把，连同缓存一起交出。
   * 只交这台电脑上托管 Key 换过、自己也已经换上缓存里那把的工具。已知37：换了账号、工具同步成新账号那把的，客户端
   * 手上要是上一个账号给这个工具的那把也跟上，所以同一个站别的账号缓存过 Key 时也交出。两样都没有回 null：没登录、
   * 从没换过，或者工具自己还没换上（写配置没成、客户换成了别的 Key、换账号时没勾这个工具），这时不替客户端做主。
   * 主进程内部专用，密钥永不跨 IPC（I3）。
   */
  async function managedKeyFollowTarget(): Promise<ManagedKeyFollowTarget | null> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (owner === null || !serviceOptions.readCurrentManagedCliKeys) return null
    const cachedKeys = await serviceOptions.readCurrentManagedCliKeys().catch(() => [])
    const otherAccounts = cachedKeys.length && serviceOptions.readOtherManagedCliKeyAccounts
      ? (await serviceOptions.readOtherManagedCliKeyAccounts().catch(() => [])).filter((account) => account.owner !== owner) : []
    // 别的账号给同一个工具缓存过另一把：换账号以后客户端手上可能还是那一把。
    const otherAccountKey = (entry: StoredManagedCliKey) => otherAccounts.some((account) => account.keys.some((key) => key.provider === entry.provider && key.key !== entry.key))
    // 先只看缓存：这台电脑上的托管 Key 从没被星芒换过、也没有别的账号时，一个工具的配置都不读。
    const inUse = cachedKeys.flatMap((entry) => {
      if (isRetiredProviderId(entry.provider) || (!entry.replacedKeyDigests?.length && !otherAccountKey(entry))) return []
      const tool = inspectNativeProviderConfig(entry.provider)
      return tool.hasApiKey && tool.matchesRelay && tool.apiKey === entry.key ? [{ provider: entry.provider, apiKey: entry.key }] : []
    })
    const keys = inUse.filter((key) => cachedKeys.some((entry) => entry.provider === key.provider && entry.replacedKeyDigests?.length))
    const previousAccounts = otherAccounts.filter((account) => account.keys.some((entry) => inUse.some((key) => key.provider === entry.provider && key.apiKey !== entry.key)))
    if ((!keys.length && !previousAccounts.length) || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) return null
    return { owner, keys, cachedKeys, inUse, previousAccounts }
  }
  /**
   * 星芒刚替某个工具换了 Key（保存配置那一下）：马上看一眼外部客户端要不要跟上，不等下次检测。先只看缓存和工具配置，
   * 没有要跟的不为它盘点一遍本机客户端。这一轮是后台做的，界面手上还是换之前那份（换账号时首页在同步工具之前就读过
   * 客户端），换成了叫一声让它重读。
   *
   * 换账号时同步到 Claude Code、Codex 是连着保存两家，各叫一次这里。以前两轮各跑各的：后一轮在前一轮换完之前就记下
   * 了计数，两轮都看到「变了」，界面重读两次（#1413 的用例在 Mac CI 上偶发红）。现在一轮跑着时再叫，只记一笔「跑完
   * 再看一遍」，后一家刚写的 Key 照样跟上，从头到尾只叫一次。
   */
  async function followManagedKeysNow(): Promise<void> {
    if (followingManagedKeys) {
      followManagedKeysAgain = true
      return followingManagedKeys
    }
    followingManagedKeys = followManagedKeyRounds()
    return followingManagedKeys
  }
  async function followManagedKeyRounds(): Promise<void> {
    const before = externalKeysFollowed
    try {
      do {
        followManagedKeysAgain = false
        if (await managedKeyFollowTarget()) await scanExternalClients()
      } while (followManagedKeysAgain)
    } finally {
      // 最后一次看完和这里之间没有 await：之后再叫的另起一轮，不会挂在一个已经不再回头看的轮次上。
      followingManagedKeys = null
      if (externalKeysFollowed !== before) serviceOptions.onToolRouteFollowed?.()
    }
  }
  /**
   * 把客户端那份换成借的那个工具现在的 Key（#1113），只换 Key，地址、型号和别的设置都不动。全都对上才换：
   * 正在用的是星芒替当前账号写的那份、地址是这个站的线路；它那把是缓存记着「被换掉」的某个工具的旧 Key；
   * 不是客户自己填的（保存时记下的来源，0.2.20 以前保存的没记，凭「就是工具换下来的那把」认）；新 Key 认它
   * 用着的型号。换了账号的（已知37）认的是上一个账号：见 externalClientKeyChange。客户端开着就先不写，等它退出
   * 再换（同换线路 C11），那一行带 keyPending、pending 交回去记着。
   */
  async function followExternalClientKey(
    status: ExternalClientRuntimeStatus,
    client: ExternalClientStatus,
    target: ManagedKeyFollowTarget,
  ): Promise<{ client: ExternalClientStatus | null; pending: boolean }> {
    const { tool } = status
    const name = externalClientNames[tool]
    const activeSite = activeRelaySite()
    const { owner } = target
    const assertContext = () => {
      if (activeRelaySite().id !== activeSite.id || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) {
        throw new Error('账号已变化，这次不换密钥')
      }
    }
    const change = await externalClientKeyChange(status, client, activeSite, target)
    if (!change) return { client: null, pending: false }
    const { found, next } = change
    const switched = change.from !== owner
    const detail = { tool, route: found.route.endpointId, ...(switched ? { accountSwitch: true } : {}) }
    if (status.running) {
      runtimeLog?.log('info', 'config', 'external-client.key.deferred', `${name} 还开着，先不换密钥，退出后再换`, detail)
      return { client: { ...client, keyPending: true }, pending: true }
    }
    const latest = { status }
    try {
      // 新 Key 认它用着的型号才换，不替客户换型号；Claude Desktop 没写型号（由它自动获取）的，新 Key 能用就够了。
      const models = await fetchAvailableModels(next.apiKey, { bypassCache: true, site: activeSite })
      assertContext()
      if (found.model !== null && !models.includes(found.model)) throw new Error(`新密钥不支持 ${name} 现在用的型号`)
      // 同换线路：动文件之前再盘点一次开没开，要的是拉清单之后才开始的那一轮。
      const recheck = async () => {
        latest.status = (await externalClientRuntime.scan({ fresh: true })).find((entry) => entry.tool === tool) ?? { ...status, installed: false }
        if (latest.status.running) throw new Error(`${name} 还开着，已保留原配置`)
        if (!latest.status.installed || latest.status.detectionError) throw new Error(`${name} 这次没认出来开没开，已保留原配置`)
        assertContext()
      }
      const keyChange = { baseUrl: found.baseUrl, from: found.apiKey, to: next.apiKey }
      if (switched) {
        // 换了账号：归属先记到当前账号名下（来源照上一个账号那份记），再改客户端。中途断了，客户端手上还是上一个
        // 账号那把，上一个账号的归属也还在，下次检测照样认出来再换。
        await externalOwnership.write(tool, owner, found.route.baseUrl, next.apiKey, change.source)
        await moveExternalClientKey(status, keyChange, assertContext, recheck)
      } else {
        await externalOwnership.stageKey(tool, owner, found.route.baseUrl, found.apiKey, next.apiKey)
        await moveExternalClientKey(status, keyChange, assertContext, recheck)
        await externalOwnership.rewrite(tool, owner, found.route.baseUrl, next.apiKey)
      }
      externalKeysFollowed += 1
      runtimeLog?.log('info', 'config', 'external-client.key.followed', `已把 ${name} 换成 ${cliCatalog[next.provider].name} 现在用的密钥`, detail)
      return { client: await describeExternalClient(latest.status), pending: false }
    } catch (error) {
      if (latest.status.running) {
        runtimeLog?.log('info', 'config', 'external-client.key.deferred', `${name} 还开着，先不换密钥，退出后再换`, detail)
        return { client: { ...client, ...latest.status, keyPending: true }, pending: true }
      }
      // 拉不到模型清单、型号不在了、写之前客户刚改过配置都走这里：这次不动，下次检测再看。
      runtimeLog?.log('warn', 'config', 'external-client.key.failed', `${name} 的密钥这次没换成，下次检测再试`, {
        ...detail, reason: credentialFailureReason(error),
      })
      return { client: { ...client, ...latest.status }, pending: false }
    }
  }
  /**
   * 这个客户端要换成哪把，换不了回 null。from 是归属记在哪个账号名下：
   * - 当前账号（#1113）：它那把是哪个工具换下来的，就跟那个工具现在那把。
   * - 上一个账号（已知37）：首页认它不是当前账号那份（configurationSource 为 other）；归属记在这个站别的账号名下，
   *   它那把是那个账号缓存里给某个工具的托管 Key；那个工具现在用的是当前账号缓存里那把（换账号时勾了它同步）。
   *   换账号时没同步这个工具的，客户端也不动，跟着客户在「同步到工具」里的选择走。
   * 两种都不动客户自己填的（manual）。只读一遍客户端配置：Windows 上读 Claude Desktop 每次都要起 PowerShell。
   */
  async function externalClientKeyChange(
    status: ExternalClientRuntimeStatus,
    client: ExternalClientStatus,
    activeSite: RelaySite,
    target: ManagedKeyFollowTarget,
  ): Promise<{ found: ExternalClientKeyCredential; next: { provider: ProviderId; apiKey: string }; from: string; source?: ExternalClientKeySource } | null> {
    const { tool } = status
    const { owner } = target
    const unchanged = () => (serviceOptions.getExternalClientAccountId?.() ?? null) === owner
    const sameAccount = (baseUrl: string, apiKey: string) => target.keys.length > 0 && unchanged()
      && externalOwnership.matches(tool, owner, baseUrl, apiKey)
    const switchable = client.configurationSource === 'other' && target.previousAccounts.length > 0
    const previous = (baseUrl: string, apiKey: string) => switchable && unchanged() ? previousAccountKey(tool, target, baseUrl, apiKey) : null
    if (!target.keys.length && !switchable) return null
    const found = await externalClientKeyCredential(status, activeSite, (baseUrl, apiKey) => sameAccount(baseUrl, apiKey) || previous(baseUrl, apiKey) !== null)
    if (!found) return null
    if (sameAccount(found.route.baseUrl, found.apiKey)) {
      const next = target.keys.find((key) => key.apiKey !== found.apiKey && isReplacedManagedKey(key.provider, found.apiKey, target.cachedKeys))
      const recorded = next && unchanged() ? externalOwnership.inspect(tool, owner, found.route.baseUrl, found.apiKey) : null
      // 客户自己在客户端里填的那把，哪怕就是工具的旧 Key 也不动。
      return next && recorded && recorded.source !== 'manual' ? { found, next, from: owner, ...(recorded.source ? { source: recorded.source } : {}) } : null
    }
    const match = previous(found.route.baseUrl, found.apiKey)
    return match ? { found, ...match } : null
  }
  /** 已知37：这把是不是这个站别的账号缓存里给某个工具的托管 Key、归属记在那个账号名下、不是客户自己填的。 */
  function previousAccountKey(
    tool: ExternalToolId,
    target: ManagedKeyFollowTarget,
    baseUrl: string,
    apiKey: string,
  ): { next: { provider: ProviderId; apiKey: string }; from: string; source?: ExternalClientKeySource } | null {
    for (const account of target.previousAccounts) {
      const next = target.inUse.find((key) => key.apiKey !== apiKey && isAccountManagedKey(key.provider, apiKey, account.keys))
      if (!next) continue
      const recorded = externalOwnership.inspect(tool, account.owner, baseUrl, apiKey)
      if (!recorded || recorded.source === 'manual') continue
      return { next, from: account.owner, ...(recorded.source ? { source: recorded.source } : {}) }
    }
    return null
  }
  /**
   * 星芒写进这个客户端、现在正用着的那一份（#1113）：route 是它在这个站登记的哪条线路，baseUrl 是配置里原样写着的
   * 地址（Claude Desktop 设置窗口存的可能带斜杠），Key 和型号原样交出（Claude Desktop 没写型号时 model 为 null）。
   * 归属认不认由 owned 说（当前账号的，或者换账号以前那个账号的）；对不上、不在这个站的线路上回 null。主进程内部
   * 专用，密钥永不跨 IPC（I3）。
   */
  async function externalClientKeyCredential(
    status: ExternalClientRuntimeStatus,
    activeSite: RelaySite,
    owned: (baseUrl: string, apiKey: string) => boolean,
  ): Promise<ExternalClientKeyCredential | null> {
    if (status.tool === 'claudeDesktop') {
      // 一次读出地址再比：Windows 上每读一次都要起 PowerShell 查管理策略。
      const gateway = await claudeDesktopConfig(status).then((service) => service.inspectOwnedRoute()).catch(() => null)
      const route = gateway ? relaySiteProviderBaseUrlVariants(activeSite.id, 'claude').find((variant) => sameRouteUrl(gateway.baseUrl, variant.baseUrl)) : undefined
      return gateway && route && owned(route.baseUrl, gateway.apiKey) ? { route, ...gateway } : null
    }
    for (const route of relaySiteProviderBaseUrlVariants(activeSite.id, 'codex')) {
      const credential = await externalClientProbeCredential(status, route.baseUrl, (apiKey) => owned(route.baseUrl, apiKey))
      if (credential) return { route, baseUrl: route.baseUrl, ...credential }
    }
    return null
  }
  /** 只改 Key 的那一笔写，recheck 的位置同 moveExternalClientRoute。 */
  async function moveExternalClientKey(
    status: ExternalClientRuntimeStatus,
    change: { baseUrl: string; from: string; to: string },
    assertContext: () => void,
    recheck: () => Promise<void>,
  ): Promise<void> {
    if (status.tool === 'claudeDesktop') {
      await (await claudeDesktopConfig(status, assertContext)).followKey(change.baseUrl, change.from, change.to, recheck)
      return
    }
    const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
    if (xdgConfig && !path.isAbsolute(xdgConfig)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径')
    await recheck()
    await followExternalToolKey(status.tool, platform === 'win32' || platform === 'darwin' ? platform : 'linux', {
      userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
    }, change, { beforeReplace: assertContext })
  }
  /** followExternalClientRoutes 里的一个客户端：那一行要换成什么就回什么，不用动时回 null。 */
  async function followExternalClientRoute(
    status: ExternalClientRuntimeStatus,
    client: ExternalClientStatus,
    to: RelayEndpointId,
  ): Promise<ExternalClientStatus | null> {
    const { tool } = status
    const name = externalClientNames[tool]
    const activeSite = activeRelaySite()
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (owner === null) return null
    const followedKey = JSON.stringify([tool, owner])
    const baseUrl = tool === 'claudeDesktop' ? activeSite.providerBaseUrls.claude : activeSite.providerBaseUrls.codex
    const assertContext = () => {
      if (activeRelaySite().id !== activeSite.id || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) {
        throw new Error('账号已变化，这次不换线路')
      }
    }
    const found = await externalClientRouteCredential(status, activeSite, owner)
    if (!found) {
      // 换过的又回到原来那份：归属已经记在新地址上，不会再换，只在日志里说一次。
      const followed = externalRoutesFollowed.get(followedKey)
      if (!followed) return null
      externalRoutesFollowed.delete(followedKey)
      if (await externalClientProbeCredential(status, followed.baseUrl, (apiKey) => apiKey === followed.apiKey)) {
        runtimeLog?.log('warn', 'config', 'external-client.route.reverted', `${name} 换过连接线路后又回到了原来那条，不再替它换`, { tool, from: followed.from, to })
      }
      return null
    }
    const detail = { tool, from: found.from, to }
    if (found.baseUrl === baseUrl) {
      // 地址已经在当前线路上，归属还记在原来那条：上回换完没记上（记归属那一步失败，或者星芒
      // 正好在两步之间退出）。客户端那份不用再动，补记归属就行。
      assertContext()
      await externalOwnership.rewrite(tool, owner, baseUrl, found.apiKey)
      runtimeLog?.log('info', 'config', 'external-client.route.recorded', `${name} 已在当前连接线路上，补记归属`, detail)
      return await describeExternalClient(status)
    }
    if (status.running) {
      runtimeLog?.log('info', 'config', 'external-client.route.deferred', `${name} 还开着，连接线路暂未改动`, detail)
      return { ...client, routePending: true, ...(activeSite.id === 'solov' ? { routeRecheck: true } : {}) }
    }
    const latest = { status, moved: false }
    try {
      // 新线路上认这把 Key、型号也还在才换，不替客户换型号（同 #872）；Claude Desktop 没写型号
      // （由它自动获取）的那份，新线路认这把 Key 就够了。
      const models = await fetchAvailableModels(found.apiKey, { bypassCache: true, site: activeSite })
      assertContext()
      if (found.model !== null && !models.includes(found.model)) throw new Error('当前密钥不支持所选模型，请重新检测')
      // 动文件之前再盘点一次客户端开没开，放在写之前最后一步异步里（同 #872）。要的是这之后才
      // 开始的那一轮：客户端可能是在拉清单那几秒里打开的，而那时正在跑的盘点可能比它早。
      const recheck = async () => {
        latest.status = (await externalClientRuntime.scan({ fresh: true })).find((entry) => entry.tool === tool) ?? { ...status, installed: false }
        if (latest.status.running) throw new Error(`${name} 还开着，已保留原配置`)
        if (!latest.status.installed || latest.status.detectionError) throw new Error(`${name} 这次没认出来开没开，已保留原配置`)
        assertContext()
      }
      await moveExternalClientRoute(status, { from: found.baseUrl, to: baseUrl, apiKey: found.apiKey }, assertContext, recheck)
      latest.moved = true
      externalRoutesFollowed.set(followedKey, { from: found.from, baseUrl: found.baseUrl, apiKey: found.apiKey })
      await externalOwnership.rewrite(tool, owner, baseUrl, found.apiKey)
      runtimeLog?.log('info', 'config', 'external-client.route.followed', `已把 ${name} 换到当前连接线路`, detail)
      return await describeExternalClient(latest.status)
    } catch (error) {
      if (latest.status.running) {
        runtimeLog?.log('info', 'config', 'external-client.route.deferred', `${name} 还开着，连接线路暂未改动`, detail)
        return { ...client, ...latest.status, routePending: true }
      }
      // 拉不到模型清单、型号不在了、写之前客户刚改过配置也走这里：这次不动，下次检测再试。
      // 地址已经换好、只是归属没记上的，下次检测补记（上面 recorded 那一支）。
      runtimeLog?.log('warn', 'config', 'external-client.route.failed', latest.moved
        ? `${name} 已换到当前连接线路，归属没记上，下次检测补记` : `${name} 的连接线路这次没换成，下次检测再试`,
      { ...detail, reason: credentialFailureReason(error) })
      return { ...client, ...latest.status }
    }
  }
  /**
   * 星芒替当前账号写的那一份在这个站的哪条线路上：from 是归属记在哪条线路，baseUrl 是那份配置
   * 现在指着的地址，Key 和型号原样交出（Claude Desktop 没写型号时 model 为 null）。baseUrl 是另一条
   * 线路的，跟着换；已经是当前线路的（上回地址换好了、归属没记上），补记归属。归属对不上、不是
   * 这个站登记过的线路，回 null。别名也认：直连原来的地址是 IP 测试入口，那时存的那份归属记在
   * IP 上，现在 IP 退成别名、要关掉，得跟着换到域名。主进程内部专用，密钥永不跨 IPC（I3）。
   */
  async function externalClientRouteCredential(
    status: ExternalClientRuntimeStatus,
    activeSite: RelaySite,
    owner: string,
  ): Promise<{ from: RelayEndpointId; baseUrl: string; apiKey: string; model: string | null } | null> {
    const provider = status.tool === 'claudeDesktop' ? 'claude' : 'codex'
    const current = activeSite.providerBaseUrls[provider]
    const routes = relaySiteProviderBaseUrlVariants(activeSite.id, provider)
      .map((variant) => ({ from: variant.endpointId, baseUrl: variant.baseUrl }))
      .filter((route) => route.baseUrl !== current)
    const unchanged = () => serviceOptions.getExternalClientAccountId?.() === owner && activeRelaySite().id === activeSite.id
    const ownedRoute = (apiKey: string) => unchanged() ? routes.find((route) => externalOwnership.matches(status.tool, owner, route.baseUrl, apiKey)) : undefined
    if (status.tool === 'claudeDesktop') {
      // 一次读出地址再比：Windows 上每读一次都要起 PowerShell 查管理策略。
      const gateway = await claudeDesktopConfig(status).then((service) => service.inspectOwnedRoute()).catch(() => null)
      const route = gateway ? ownedRoute(gateway.apiKey) : undefined
      if (!gateway || !route) return null
      const at = sameRouteUrl(gateway.baseUrl, current) ? current : sameRouteUrl(gateway.baseUrl, route.baseUrl) ? route.baseUrl : null
      return at ? { ...gateway, from: route.from, baseUrl: at } : null
    }
    for (const route of routes) {
      const credential = await externalClientProbeCredential(status, route.baseUrl, (apiKey) => ownedRoute(apiKey) === route)
      if (credential) return { ...credential, from: route.from, baseUrl: route.baseUrl }
    }
    const credential = await externalClientProbeCredential(status, current, (apiKey) => ownedRoute(apiKey) !== undefined)
    const route = credential ? ownedRoute(credential.apiKey) : undefined
    return credential && route ? { ...credential, from: route.from, baseUrl: current } : null
  }
  /**
   * 只改地址的那一笔写：Claude Desktop 改网关地址，WorkBuddy、OpenCode 改星芒那几条的地址。
   * recheck 是写之前最后看一眼客户端开没开，放在最后一步异步之后：Claude Desktop 那边商店版目录、
   * 管理策略都要起 PowerShell，所以交给 followRoute 在那之后调。
   */
  async function moveExternalClientRoute(
    status: ExternalClientRuntimeStatus,
    route: { from: string; to: string; apiKey: string },
    assertContext: () => void,
    recheck: () => Promise<void>,
  ): Promise<void> {
    if (status.tool === 'claudeDesktop') {
      await (await claudeDesktopConfig(status, assertContext)).followRoute(route.from, route.to, route.apiKey, recheck)
      return
    }
    const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
    if (xdgConfig && !path.isAbsolute(xdgConfig)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径')
    await recheck()
    await followExternalToolRoute(status.tool, platform === 'win32' || platform === 'darwin' ? platform : 'linux', {
      userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
    }, route, { beforeReplace: assertContext })
  }

  return {
    scanExternalClients,
    cachedExternalClients,
    getLastExternalClients,
    installExternalClient,
    cancelExternalClientInstall,
    launchExternalClient,
    checkExternalClientConnection,
    configureExternalTool,
    switchExternalClientSource,
    recheckPendingExternalRoutes,
    followManagedKeysNow,
    cancelPendingExternalRouteRecheck,
  }
}
