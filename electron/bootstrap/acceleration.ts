// 本机加速的接线（#1070 第 5 步从 main.ts 的启动回调原样搬出），按启动时建的先后：
// - createAccelerationRouting：下载线路和 Codex 桌面端要的加速，系统服务要用，所以最早建；
// - createAccelerationHost：加速文件一读完、能用就建宿主（辅助进程、内核、系统代理都归它管），并把上次崩溃
//   没改回的系统代理先改回去。建窗口不等它，用到宿主的地方等它给的 Promise；
// - createAccelerationServices：加速服务和挂在它上面的系统通知、加速页、托盘。
// 睡眠唤醒那一段（没有宿主时什么都不做）和退出清理留在 main.ts。
import { app, type BrowserWindow, net, session } from 'electron'
import { accelerationConflictDescriptions, accelerationFailureMessages, accelerationProxyFailureCause, type AccelerationBundleCheck, type AccelerationMode, type AccelerationState } from '../acceleration-contract'
import { accelerationStartFailureDescriptions, createAccelerationDevelopmentHost, type AccelerationDevelopmentConfig, type AccelerationDevelopmentHost } from '../acceleration-development-host'
import { createAccelerationExpiryNotice, type AccelerationExpiryNotice } from '../acceleration-expiry-notice'
import { createAccelerationInterruptionNotice, type AccelerationInterruptionNotice } from '../acceleration-interruption-notice'
import { accelerationStartRequest, defaultAccelerationPreference, type AccelerationPreferenceStore } from '../acceleration-preference-store'
import { createAccelerationService, createUserAccelerationApi, userAccelerationState, type AccelerationService } from '../acceleration-service'
import type { AppSettings } from '../app-settings'
import type { ApplicationTrayController } from '../application-tray'
import { createClaudeDesktopAccelerationCoordinator } from '../claude-desktop-acceleration'
import { createCodexDesktopAccelerationCoordinator, createCodexDesktopAccelerationNeedReader } from '../codex-desktop-acceleration'
import { probeCodexDesktopRunning } from '../codex-desktop-service'
import { buildCodexStartupTunnelUrl, createCodexDesktopStartupRouteCoordinator } from '../codex-desktop-startup-route'
import { inspectProviderConfig } from '../config-files'
import { createDownloadAccelerationCoordinator } from '../download-acceleration'
import type { DownloadProxyEndpoint } from '../download-proxy'
import { ipcEventChannels } from '../ipc-contract'
import type { RootedMainServiceOptions } from '../main-service-options'
import { createManualRedirectFetch } from '../manual-redirect-fetch'
import type { NewApiCodexStartupTicket } from '../new-api-client'
import { platformCapabilitiesFor } from '../platform-capabilities'
import { hostNotifier } from '../platform/host-notification-bridge'
import { relayEndpointOrigin, type RelayEndpointId } from '../relay-sites'
import type { RuntimeLogStore } from '../runtime-log'
import { createTrayAccelerationCoordinator, type TrayAccelerationCoordinator } from '../tray-acceleration'
import type { NetworkRoutes } from './network-routes'

export interface AccelerationRoutingOptions {
  routes: Pick<NetworkRoutes, 'relayRouting' | 'proxyBypass' | 'resolveSystemProxy'>
  rootedOptions: Pick<RootedMainServiceOptions, 'system'>
  accelerationPreferences: Pick<AccelerationPreferenceStore, 'getAccelerationPreference'>
  runtimeLog: RuntimeLogStore
  /** 下面这几样都建得比这里晚（账号服务、加速宿主、加速服务、系统服务），用到时再取。 */
  readAccelerationAccountScope: () => string | null
  downloadRoutes: () => Pick<AccelerationDevelopmentHost, 'startDownloadRoute' | 'stopDownloadRoute'> | null
  accelerationService: () => AccelerationService | undefined
  issueCodexStartupTicket: () => Promise<NewApiCodexStartupTicket>
  readStoredConfig: () => Pick<AppSettings, 'relaySiteId'>
}

// 下载线路和 Codex 桌面端要的加速：打开 Codex 桌面端时替他连一次。装 CLI、下 Node 临时借线路那一路
// 2026-10-21 起没接（线路只通 ChatGPT / OpenAI，见 main.ts 建系统服务那里），下载协调者仍在，只剩 downloadFetch 用它。
// 系统服务要拿这里给的下载 fetch 和启动线路，所以建在系统服务之前。
export function createAccelerationRouting(options: AccelerationRoutingOptions) {
  const { routes: { relayRouting, proxyBypass, resolveSystemProxy }, rootedOptions, accelerationPreferences, runtimeLog } = options
  const { readAccelerationAccountScope, downloadRoutes, accelerationService, issueCodexStartupTicket, readStoredConfig } = options
  // 下载专用的网络分区：它的代理只在装 CLI / 下 Node 的那几分钟里被设成加速
  // 内核的回环端口，默认 session 一行不动，所以账号、中转与画布流量不受
  // 影响。非 persist: 前缀 = 内存分区，不落盘。
  const acceleratedDownloadSession = session.fromPartition('xingmang-download-acceleration')
  let acceleratedDownloadProxyRules: string | null = null
  async function applyAcceleratedDownloadProxy(endpoint: DownloadProxyEndpoint | null): Promise<void> {
    const rules = endpoint ? `http=${endpoint.host}:${endpoint.port};https=${endpoint.host}:${endpoint.port}` : null
    if (rules === acceleratedDownloadProxyRules) return
    await acceleratedDownloadSession.setProxy(rules
      ? { proxyRules: rules, proxyBypassRules: '<local>' }
      : { mode: 'direct' })
    acceleratedDownloadProxyRules = rules
  }
  const downloadAcceleration = createDownloadAccelerationCoordinator({
    getAccountScope: () => readAccelerationAccountScope(),
    startRoute: (scope) => {
      const accelerationDownloadRoutes = downloadRoutes()
      return accelerationDownloadRoutes
        ? accelerationDownloadRoutes.startDownloadRoute(scope)
        : Promise.resolve({ status: 'unavailable' as const })
    },
    stopRoute: async (scope) => { await downloadRoutes()?.stopDownloadRoute(scope) },
    onRouteChanged: applyAcceleratedDownloadProxy,
    // 没有临时线路时，下载和给 npm 的代理都按默认会话走（见下面的 downloadFetch 和
    // resolveSubprocessProxyEnvironment）：整个改了直连，它就不再跟着系统代理。
    downloadsFollowSystemProxy: () => !proxyBypass.active(),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  // 托盘与自动连接共用这一条：把用户在加速页上选过并落了盘的线路与模式，落到
  // 一次真正的连接上。没选过就是「智能分配 + 标准模式」，与落盘之前的行为一致；
  // 读不到偏好也按没选过继续，绝不因此连不上。
  async function accelerationStartArguments(scope: string, state: AccelerationState | null): Promise<[AccelerationMode, string?]> {
    let preference = defaultAccelerationPreference
    try { preference = await accelerationPreferences.getAccelerationPreference(scope) }
    catch (error) { runtimeLog.exception('network', 'acceleration.preference.read.failed', error) }
    const request = accelerationStartRequest(preference, state?.supportedModes)
    return request.lineId === undefined ? [request.mode] : [request.mode, request.lineId]
  }
  // Codex 桌面端是独立进程，只跟着系统代理走，所以这里要的是完整的「连接」
  // （和用户在加速页点的那一下同一条路），不是下载专用线路。加速服务同样
  // 建得比 systemService 晚，空着的时候一律按没加速打开。
  const codexDesktopAcceleration = createCodexDesktopAccelerationCoordinator({
    getAccountScope: () => readAccelerationAccountScope(),
    readState: (scope) => {
      const acceleration = accelerationService()
      return acceleration
        ? acceleration.getAccelerationState(scope)
        : Promise.reject(new Error('加速服务尚未就绪。'))
    },
    connect: async (scope, state) => {
      const acceleration = accelerationService()
      if (!acceleration) throw new Error('加速服务尚未就绪。')
      return acceleration.startAutomaticAcceleration(scope, 'codex-desktop', ...await accelerationStartArguments(scope, state))
    },
    // 自动连的不扣免费时长，所以用完就断开，否则就是一条白送的不限时线路。
    isDesktopRunning: () => probeCodexDesktopRunning(),
    disconnect: (scope, connectedAt) => {
      const acceleration = accelerationService()
      return acceleration
        ? acceleration.stopAutomaticAcceleration(scope, connectedAt)
        : Promise.reject(new Error('加速服务尚未就绪。'))
    },
    // 桌面端用的是星芒的 Key：它要加速只为启动时拉中文界面那份配置，之后连着只会
    // 让整台电脑白白绕道（yoyo 2026-10-02）。登 ChatGPT 账号的一直要连 chatgpt.com，
    // 认不准的也按这种算，等桌面端退出再断。读配置抛错由守护按「一直要」处理。
    onlyNeededAtStartup: () => codexDesktopUsesStarKeyOnly(),
    // Mac 上连一次、断一次各要一次电脑密码，系统只记 30 秒：用星芒密钥的 20 秒后看到桌面端在跑就断，
    // 断开不用再输一次（2026-10-18 客户 Mac 一直弹）。Windows 不要密码，照旧两分钟。
    ...(process.platform === 'darwin' ? { startupDisconnectMs: 20_000 } : {}),
    // 前后脚从星芒打开了 Claude Desktop、它还在下组件：Codex 这边用完也不断，交给它。
    heldElsewhere: (scope, connectedAt) => claudeDesktopAcceleration.holds(scope, connectedAt),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  // Claude Desktop 也是独立进程、只跟着系统代理走：第一次用、每次自己升级以后要从官网下 1GB 多的组件，
  // 国内直连下不动（#1373）。从星芒打开它时同样替他连一次，Claude 退出或连满一小时就断。
  const claudeDesktopAcceleration = createClaudeDesktopAccelerationCoordinator({
    getAccountScope: () => readAccelerationAccountScope(),
    readState: (scope) => {
      const acceleration = accelerationService()
      return acceleration
        ? acceleration.getAccelerationState(scope)
        : Promise.reject(new Error('加速服务尚未就绪。'))
    },
    connect: async (scope, state) => {
      const acceleration = accelerationService()
      if (!acceleration) throw new Error('加速服务尚未就绪。')
      return acceleration.startAutomaticAcceleration(scope, 'claude-desktop', ...await accelerationStartArguments(scope, state))
    },
    disconnect: (scope, connectedAt) => {
      const acceleration = accelerationService()
      return acceleration
        ? acceleration.stopAutomaticAcceleration(scope, connectedAt)
        : Promise.reject(new Error('加速服务尚未就绪。'))
    },
    heldElsewhere: (scope, connectedAt) => codexDesktopAcceleration.holds(scope, connectedAt),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  // 2026-10-25 客户 Mac 上自动连的加速一直没断，日志里看不出那一下为什么判成「要一直连着」：答案变了就记一笔。
  const codexDesktopUsesStarKeyOnly = createCodexDesktopAccelerationNeedReader({
    inspect: () => inspectProviderConfig('codex',
      rootedOptions.system.providerRoots, relayRouting.resolve(readStoredConfig().relaySiteId).providerBaseUrls),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  // 通道地址跟账号请求走同一个站、同一套线路：这会儿走的那条在前，另一条留作握不上手时再试。
  function codexStartupTunnelUrls(): string[] {
    const lines: RelayEndpointId[] = relayRouting.lines().solov.line === 'direct' ? ['direct', 'primary'] : ['primary', 'direct']
    return lines.flatMap((line) => {
      const origin = relayEndpointOrigin('solov', line)
      const url = origin ? buildCodexStartupTunnelUrl(origin) : null
      return url ? [url] : []
    })
  }
  const codexDesktopStartupRoute = createCodexDesktopStartupRouteCoordinator({
    launchArgumentsSupported: process.platform === 'win32' || process.platform === 'darwin',
    fastFailSupported: process.platform === 'win32',
    skipAccelerationWhenRunning: process.platform === 'darwin',
    onlyNeededAtStartup: () => codexDesktopUsesStarKeyOnly(),
    issueTicket: () => issueCodexStartupTicket(),
    tunnelUrls: () => codexStartupTunnelUrls(),
    ensureAccelerated: () => codexDesktopAcceleration.ensureConnected(),
    resolveSystemProxy: (url) => resolveSystemProxy(url),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  // CLI 产物下载以前走 Node 自带的网络栈，它不读系统代理，所以开着加速也
  // 一样直连。Chromium 的网络栈读，于是下载才真的走线路。
  // 临时线路生效时改走那条专用 session（它的代理只对下载有效，默认
  // session 一行未动，账号与中转流量不受影响）。
  // 各安装包下载自己一跳一跳地跟跳转（redirect: 'manual'，每一跳先核主机），net.fetch 却不把
  // 跳转交回来，直接报「Redirect was cancelled」，Git、Claude Desktop 因此一次都没下成。
  // createManualRedirectFetch 把这种请求改走 net.request，跳转照 Node 的 fetch 那样交回去。
  const downloadFetch: typeof fetch = createManualRedirectFetch((input, init) => {
    const url = input instanceof URL ? input.href : input
    // 专用 session 的 fetch 只收字符串或 Request；下载链路一律传 URL 字符串。
    if (downloadAcceleration.currentEndpoint() && typeof url === 'string') {
      return acceleratedDownloadSession.fetch(url, init)
    }
    return net.fetch(url, init)
  }, (options) => net.request({
    ...options,
    session: downloadAcceleration.currentEndpoint() ? acceleratedDownloadSession : session.defaultSession,
  }))
  return { downloadAcceleration, accelerationStartArguments, codexDesktopAcceleration, claudeDesktopAcceleration, codexDesktopStartupRoute, downloadFetch }
}

export type AccelerationRouting = ReturnType<typeof createAccelerationRouting>

export interface AccelerationHostOptions {
  /** 启动一开始就读的加速文件，读不通时 ok 是 false。不会失败（main.ts 先接住了）。 */
  read: Promise<{ ok: true, config: AccelerationDevelopmentConfig | null } | { ok: false, error: unknown }>
  managerDataDirectory: string
  runtimeLog: RuntimeLogStore
  /** 加速中断的提醒建得比这里晚，用到时再取。 */
  accelerationInterruption: () => AccelerationInterruptionNotice | null
}

export interface AccelerationHost {
  developmentAcceleration: AccelerationDevelopmentHost | undefined
  accelerationBundleDamaged: boolean
}

// 安装包里的加速内核三十多兆，校验要整读一遍，慢盘、杀毒软件逐字节扫的电脑上要一两秒；绝大多数客户又根本
// 不用加速。所以 main.ts 不等这里，读完的那一刻才建宿主、才去改回系统代理，跟有没有人用加速无关。
export async function createAccelerationHost(options: AccelerationHostOptions): Promise<AccelerationHost> {
  const { managerDataDirectory, runtimeLog, accelerationInterruption } = options
  const read = await options.read
  let developmentAcceleration: ReturnType<typeof createAccelerationDevelopmentHost> | undefined
  // 只看读文件这一步：后面建加速服务失败不是文件坏了，不能叫客户去翻杀毒软件。
  let accelerationBundleDamaged = false
  try {
    if (!read.ok) {
      accelerationBundleDamaged = app.isPackaged
      throw read.error
    }
    const accelerationConfig = read.config
    if (accelerationConfig) developmentAcceleration = createAccelerationDevelopmentHost({
      config: accelerationConfig, dataDirectory: managerDataDirectory, packaged: app.isPackaged,
      // cause 只有系统代理那一步才有：被拒、没去问、别的程序改过、没生效……2026-10-18 客户 Mac
      // 一直弹密码框时日志里只有 proxy-restore，第一次为什么没成一个字都查不到。
      onDiagnostic: (stage, cause) => runtimeLog.log('warn', 'network', 'acceleration.stop.failed',
        '加速停止尚未完成，将保留恢复记录并重试', { stage, ...(cause ? { cause } : {}) }),
      onRecoveryWithheld: (cause) => runtimeLog.log('warn', 'network', 'acceleration.recover.withheld',
        cause === 'declined' ? '上次加速的网络设置没改回：用户在密码框上点了取消，等他点开启或停止时再问'
          : '上次加速的网络设置没改回：这一次不弹密码框，等用户点开启或停止时再问', { cause }),
      // A failed connect resolves with an error-carrying state rather than
      // rejecting, so the IPC layer records it as a success. Without this the
      // only trace of a machine that can never connect is a sentence on
      // screen that means the same thing for every possible cause.
      onStartDiagnostic: (stage) => runtimeLog.log('error', 'network', 'acceleration.start.failed',
        `加速连接失败：${accelerationStartFailureDescriptions[stage]}`, { stage }),
      // yoyo 2026-09-20 真机反馈：本地 VPN 与加速互抢系统代理时，下载到底走了哪条线
      // 事后完全看不出来。记录检测到什么，以及用户是否选择了「仍然连接」。
      onConflictDiagnostic: (kind, ignored) => runtimeLog.log('warn', 'network',
        ignored ? 'acceleration.conflict.ignored' : 'acceleration.conflict.detected',
        `${ignored ? '用户选择忽略网络冲突继续连接' : '开始加速前检测到网络冲突'}：${accelerationConflictDescriptions[kind]}`,
        { kind, ignored }),
      // 启动辅助进程这一步以前把 errno 和原文一起吞掉，只留一句「本机加速进程
      // 启动失败。」。2026-09-22 客户机卡在临时目录上，就是因此只能靠反编译
      // 压缩产物才定位到。原因与底层错误都留在这里（日志会脱敏路径，I13）。
      onHelperFailure: (reason, error) => runtimeLog.exception('network', 'acceleration.helper.failed', error, {
        reason,
        ...(accelerationProxyFailureCause(error) === 'other' ? {} : { cause: accelerationProxyFailureCause(error) }),
        // errno 单列一格：光看 message 分不清「目录建不出来」报的是没空间、
        // 没权限还是路径不存在，而这恰恰是客服要问用户的下一句话。
        ...(typeof (error as NodeJS.ErrnoException | null)?.code === 'string' ? { code: (error as NodeJS.ErrnoException).code } : {}),
        detail: accelerationFailureMessages[reason],
      }),
      // 加速中内核或辅助进程自己没了：网络设置由辅助进程（或宿主重拉的那一个）
      // 先改回去，这里负责读一次状态让各处跟上，并告诉用户网络现在是什么样。
      onRuntimeExited: () => accelerationInterruption()?.runtimeExited(),
      onHelperExited: (recovered) => accelerationInterruption()?.helperExited(recovered),
      onProxyRecoveryRetry: (attempt, recovered) => runtimeLog.log(recovered ? 'info' : 'warn', 'network', 'acceleration.recover.retry',
        recovered ? '重试后已把网络设置改回去' : '重试仍未能把网络设置改回去', { attempt }),
      // 「现在重开」、退出后马上又打开：上一个星芒还在改回网络设置（Mac 上可能在等电脑密码），这边等它收完再接手。
      onPreviousOwnerWait: (recovered, waitedMs) => runtimeLog.log(recovered ? 'info' : 'warn', 'network', 'acceleration.previous-owner.wait',
        recovered ? '上一个星芒退出时还在改回网络设置，等它收完后已接手' : '等了半分钟，上一个星芒还占着网络设置', { waitedMs }),
      // 登录后读一次加速状态就会拉起整份 Electron 辅助进程；从不用加速的人
      // 不该一直背着它。两分钟没人用、又确认没在加速就退，下次用到再拉。
      idleExitMs: 120_000,
      ...(app.isPackaged ? { entitlementSource: 'local-device' as const } : {}),
    })
  } catch {
    runtimeLog.log('warn', 'network', 'acceleration.config.invalid', '本机加速资源校验未通过')
  }
  // The worker restores a proxy lease left by a crash as part of its own
  // initialization, and it only starts when a request reaches it. Every other
  // request carries an account scope, so a machine left pointing at a dead
  // acceleration port would never recover: the dead proxy blocks the sign-in
  // that would have produced the first scoped request.
  if (developmentAcceleration) void developmentAcceleration.recover().catch((error) => {
    const cause = accelerationProxyFailureCause(error)
    runtimeLog.exception('network', 'acceleration.recover.failed', error, cause === 'other' ? undefined : { cause })
  })
  return { developmentAcceleration, accelerationBundleDamaged }
}

export interface AccelerationServicesOptions {
  /** createAccelerationHost 给的那个：加速服务先建好，要用到宿主的操作等它。 */
  host: Promise<AccelerationHost>
  accelerationPreferences: AccelerationPreferenceStore
  recheckAccelerationBundle: () => Promise<AccelerationBundleCheck>
  routing: Pick<AccelerationRouting, 'codexDesktopAcceleration' | 'claudeDesktopAcceleration' | 'accelerationStartArguments'>
  readAccelerationAccountScope: () => string | null
  runtimeLog: RuntimeLogStore
  /** 主窗口和托盘都建得比这里晚，用到时再取。 */
  mainWindow: () => BrowserWindow | null
  applicationTray: () => ApplicationTrayController | null
  /** 状态文件关掉了网络加速（remote-features.ts）：加速页、托盘、替桌面端连的那次都不连新的。缺省 = 不关。 */
  accelerationSuspended?: () => boolean
}

// 加速服务和挂在它上面的几样：时长快用完、加速中断的系统通知，加速页和托盘看到的那一套。
// main.ts 照旧各有一份同名的变量，拿到这里的结果马上填上；睡眠唤醒那一段和退出清理留在 main.ts。
export function createAccelerationServices(options: AccelerationServicesOptions) {
  const { host, accelerationPreferences, recheckAccelerationBundle, runtimeLog } = options
  const { routing: { codexDesktopAcceleration, claudeDesktopAcceleration, accelerationStartArguments }, readAccelerationAccountScope, mainWindow, applicationTray } = options
  const { accelerationSuspended } = options
  // 建的过程中互相读得到：还没建好的那一样是空的，跟原来在 main.ts 里一样。
  let trayAcceleration: TrayAccelerationCoordinator | null = null
  let accelerationExpiry: AccelerationExpiryNotice | null = null
  let accelerationInterruption: AccelerationInterruptionNotice | null = null
  let acceleration: ReturnType<typeof createAccelerationService> | undefined
  function showAccelerationPage() {
    const managedMainWindow = mainWindow()
    if (managedMainWindow && !managedMainWindow.isDestroyed()) {
      managedMainWindow.webContents.send(ipcEventChannels.onNavigate, 'acceleration')
    }
  }
  // 时长快用完、以及用完自动断开的那一刻各发一条系统通知。放在主进程是因为
  // 窗口缩到托盘之后渲染层的计时与轮询都停着，而那正是用户在打游戏的时候。
  accelerationExpiry = createAccelerationExpiryNotice({
    notify: (stage, eventKey) => hostNotifier()({
      event: stage === 'expiring' ? 'accelerationExpiring' : 'accelerationExhausted',
      eventKey,
      onClick: showAccelerationPage,
    }),
    readState: (scope) => acceleration
      ? acceleration.getAccelerationState(scope)
      : Promise.reject(new Error('加速服务尚未就绪。')),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  accelerationInterruption = createAccelerationInterruptionNotice({
    notify: (outcome, eventKey) => hostNotifier()({
      event: outcome === 'restored' ? 'accelerationInterrupted' : 'accelerationInterruptedUnrestored',
      eventKey,
      onClick: showAccelerationPage,
    }),
    readState: (scope) => acceleration
      ? acceleration.getAccelerationState(scope)
      : Promise.reject(new Error('加速服务尚未就绪。')),
    getAccountScope: () => readAccelerationAccountScope(),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  acceleration = createAccelerationService({
    ready: host.then(({ developmentAcceleration, accelerationBundleDamaged }) => ({
      backend: developmentAcceleration,
      ...(accelerationBundleDamaged ? { bundleDamaged: { recheck: async () => {
        const result = await recheckAccelerationBundle()
        runtimeLog.log(result === 'repaired' ? 'info' : 'warn', 'network', 'acceleration.config.recheck',
          result === 'repaired' ? '本机加速资源已恢复，重新打开软件后生效' : '本机加速资源仍未通过校验', { result })
        return result
      } } } : {}),
    })),
    preferences: accelerationPreferences,
    getAccountScope: () => readAccelerationAccountScope(),
    ...(accelerationSuspended ? { suspended: accelerationSuspended } : {}),
    onState: (state) => {
      // 托盘与加速页同一口径：软件替他在后台连的那一次不显示（userAccelerationState）。
      trayAcceleration?.observe(userAccelerationState(state))
      accelerationExpiry?.observe(state)
      accelerationInterruption?.observe(state)
      codexDesktopAcceleration.observe(state)
      claudeDesktopAcceleration.observe(state)
    },
  })
  // 加速页（IPC）和托盘看到的那一套：软件替他在后台连的那一次（打开 Codex 桌面端
  // 时）在这里看不见，也停不掉（yoyo 2026-10-02）。主进程别的观察者读的仍是 acceleration。
  const userAcceleration = createUserAccelerationApi(acceleration)
  // 托盘上的连接与断开走的就是加速页那条路，线路与模式也用他在加速页上选过并
  // 落了盘的那一套，与打开 Codex 桌面端时自动连接同一口径。没有加速的平台（Linux
  // 第一版）托盘上就不放这一行，不然只会一直「正在读取状态」。
  trayAcceleration = platformCapabilitiesFor().acceleration === false ? null : createTrayAccelerationCoordinator({
    getAccountScope: () => readAccelerationAccountScope(),
    readState: (scope) => userAcceleration.getAccelerationState(scope),
    connect: async (scope, state) => userAcceleration.startAcceleration(scope, ...await accelerationStartArguments(scope, state)),
    disconnect: (scope) => userAcceleration.stopAcceleration(scope),
    onChanged: () => applicationTray()?.updateSnapshot(),
    ...(accelerationSuspended ? { suspended: accelerationSuspended } : {}),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  return { accelerationExpiry, accelerationInterruption, acceleration, userAcceleration, trayAcceleration }
}
