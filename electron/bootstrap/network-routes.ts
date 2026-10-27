// 星芒自己连站点的那几条路和两套线路（#1070 第 5 步从 main.ts 的启动回调原样搬出）：应用线路（管理工具自己的
// 请求）、工具线路（写进各 AI 工具配置的那条）、代理软件不转发时改走的直连会话。启动时先建这些、先开始查，
// 系统服务和账号、AI 工作区才拿得到线路；建好的东西都交回 main.ts，退出清理也照旧在 main.ts 里登记。
import path from 'node:path'
import { app, type BrowserWindow, net, powerMonitor, session } from 'electron'
import type { AppSettings, AppSettingsStore } from '../app-settings'
import { relaySiteStatusProbeUrls, relayStatusProbeUrl } from '../diagnostics'
import { parseChromiumProxyResult } from '../download-proxy'
import { ipcEventChannels } from '../ipc-contract'
import { createSiteRouting } from '../proxy-bypass'
import { createRelayLineFetch, createRelayObservedFetch } from '../relay-line-fetch'
import { createRelayRouteConclusionStore, createRelayRouteController, probeRelayLineHealth } from '../relay-route-controller'
import { createRelayEndpointRoutingSnapshot, createToolRouteRoutingSnapshot, requireRelaySite, resolveRelayRoutePreferences, type RelayEndpointId } from '../relay-sites'
import { createRouteStatusReader, type RouteStatus } from '../route-status-file'
import type { RuntimeLogStore } from '../runtime-log'
import { readWindowsProxyScopes } from '../stale-proxy-environment'
import type { SystemService } from '../system-service'
import { environmentProxyCandidates, probeToolPathDirect, probeToolPathThroughFetch } from '../tool-path-probe'
import { createToolRouteController, createToolRouteStateStore, type ToolRouteProbeResult } from '../tool-route-controller'
import { createToolRouteProbe } from '../tool-route-probe'
import { createToolRouteStatusBoard, type ToolRouteProbeRecord } from '../tool-route-status'

export interface NetworkRoutesOptions {
  managerDataDirectory: string
  settingsStore: Pick<AppSettingsStore, 'read'>
  runtimeLog: RuntimeLogStore
  chromiumSessionFetch: (target: Electron.Session) => typeof fetch
  /** 系统服务建得比这里晚；探测地址出了事才去读站点设置。 */
  readStoredConfig: () => Pick<AppSettings, 'relaySiteId'>
  accelerationRunning: () => Promise<boolean>
  /** 主窗口建得比这里晚，用到时再取。 */
  mainWindow: () => BrowserWindow | null
  readAccountSiteId: () => string
}

export function createNetworkRoutes(options: NetworkRoutesOptions) {
  const {
    managerDataDirectory, settingsStore, runtimeLog, chromiumSessionFetch, readStoredConfig, accelerationRunning,
    mainWindow, readAccountSiteId,
  } = options
  // 线路选项开机时定下，这次运行里不再变（设置里改了要重启才生效）。选「自动」的站这次运行里会
  // 换线路：先用上次存下的结论，开机后在后台查一次，先走的那条连不上改走备用那条，好了再切回来
  // （星芒账号先走直连，历史账号先走默认线路，relay-route-controller.ts）。查线路走的是星芒自己连站点
  // 那条路（relayFetch，下面才建）。
  const relayPreferences = resolveRelayRoutePreferences(settingsStore.read().relayEndpointIds)
  const relayRouteConclusions = createRelayRouteConclusionStore(path.join(managerDataDirectory, 'relay-route-lines.json'))
  const relayRouteController = createRelayRouteController({
    preferences: relayPreferences,
    ...relayRouteConclusions,
    probe: (siteId, line) => probeRelayLineHealth(relayFetch, relayStatusProbeUrl(requireRelaySite(siteId, line))),
    // xm 三线路：日志里分得出是管理工具自己这套（应用线路）还是写进工具配置那套（工具线路）。
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, { kind: 'app', ...detail }),
  })
  const relayRouting = createRelayEndpointRoutingSnapshot(relayPreferences, () => relayRouteController.lines())
  // 客服要从日志看出这次走的是哪条：只记线路 id，不记地址。
  runtimeLog.log('info', 'config', 'relay.route.active', '本次运行用的连接线路', {
    preferences: relayRouting.preferences,
    lines: relayRouting.lines(),
  })
  const sessionFetch = chromiumSessionFetch(session.defaultSession)
  // 代理软件活着、只是不转发星芒站点时，连星芒站点的请求（账号、余额、AI 聊天画图、连通
  // 检查）改走的直连会话；默认会话照旧跟随系统代理，装工具、拉插件、检查页都不受影响。
  // 非 persist: 前缀 = 内存分区，不落盘；这些请求自己带凭据（Key，或者账号那边
  // credentials: 'omit' 的 cookie），换会话不影响登录。
  const siteDirectSession = session.fromPartition('xingmang-site-direct')
  const siteDirectSessionFetch = chromiumSessionFetch(siteDirectSession)
  let siteDirectProxy: Promise<void> | null = null
  const siteDirectFetch: typeof fetch = (input, init) => {
    // 设不上就下次再设，别把一次失败记一整个运行。
    siteDirectProxy ??= siteDirectSession.setProxy({ mode: 'direct' }).catch((error: unknown) => {
      siteDirectProxy = null
      throw error
    })
    return siteDirectProxy.then(() => siteDirectSessionFetch(input, init))
  }
  // 整个改了直连以后默认会话不再经过系统代理，看代理软件是不是又好了，得另走一个只跟随
  // 系统代理的会话。同样是内存分区，只用来探那一下。
  const systemProxySession = session.fromPartition('xingmang-system-proxy')
  const systemProxySessionFetch = chromiumSessionFetch(systemProxySession)
  let systemProxyMode: Promise<void> | null = null
  function ensureSystemProxyMode(): Promise<void> {
    systemProxyMode ??= systemProxySession.setProxy({ mode: 'system' }).catch((error: unknown) => {
      systemProxyMode = null
      throw error
    })
    return systemProxyMode
  }
  const systemProxyFetch: typeof fetch = (input, init) => (
    ensureSystemProxyMode().then(() => systemProxySessionFetch(input, init))
  )
  // 工具线路探测问「系统代理对星芒这个地址生不生效」（PAC、绕过列表都算在内），问的是同一个会话。
  function resolveSystemProxy(url: string): Promise<string> {
    return ensureSystemProxyMode().then(() => systemProxySession.resolveProxy(url))
  }
  // 系统代理指着一个已经关掉的代理软件时，星芒自己改走直连（更新那条路早就这么做）。
  // 只动 defaultSession，不落盘；装工具时给子进程的代理也按它 resolveProxy，一起跟着直连，
  // 代理软件好了以后再一起改回来。
  // AI 聊天画图、连通检查、查模型（relayFetch）都连星芒站点，账号请求（accountFetch）
  // 改直连时跟着一起改，它们自己不触发改直连；别的地址照旧走默认会话。建在这里是因为
  // relayFetch 马上就要用；站点设置、加速状态都是出了事才去读。
  const { bypass: proxyBypass, relayFetch, accountFetch } = createSiteRouting({
    probeUrl: () => {
      try { return relayStatusProbeUrl(relayRouting.resolve(readStoredConfig().relaySiteId)) }
      catch { return null }
    },
    // 同一个站的默认线路和直连算一个站点：「自动」中途换了线路，分去直连会话的请求照样分过去。
    siteProbeUrls: (url) => relaySiteStatusProbeUrls(url, relayRouting.lines()),
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    setProxy: (mode) => session.defaultSession.setProxy({ mode }),
    accelerationActive: accelerationRunning,
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
    sessionFetch,
    siteDirectFetch,
    systemProxyFetch,
    // 代理软件好了、改回跟随系统代理：界面上「已经改为直接联网」那条提示跟着收起。
    // 窗口是后面才建的，改回最早也在改直连 5 分钟以后，那时早就建好了。
    directEnded: () => {
      const managedMainWindow = mainWindow()
      if (!managedMainWindow || managedMainWindow.isDestroyed()) return
      if (managedMainWindow.webContents.isDestroyed()) return
      managedMainWindow.webContents.send(ipcEventChannels.onProxyBypassEnded, undefined)
    },
  })
  // 星芒自己的请求（账号、AI 工作区、AI 工作区查模型）按线路走：认得出的星芒地址换到这个站这会儿
  // 的线路，「自动」时先走的那条没走通当场改走备用那条（relay-line-fetch.ts）。报给线路那边的只是叫它查一轮
  // 健康检查，换不换由它定（#941 第 3 节）：正文读得慢、客户点了「停止」不报；账号请求只会因为等到时限
  // 才中止，连回应头都没等来就报（abortMeansNoAnswer）。工具相关的检查（写配置前查模型、工具自检）查的
  // 正是工具会用的那条线路，不换不重发，先走的那条上连不上只报给线路那边。
  function logRelayLine(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void {
    runtimeLog.log(level, 'network', event, message, detail)
  }
  const routedRelayFetch = createRelayLineFetch(relayRouteController, relayFetch, { log: logRelayLine })
  const routedAccountRelayFetch = createRelayLineFetch(relayRouteController, relayFetch, { abortMeansNoAnswer: true, log: logRelayLine })
  const routedAccountFetch = createRelayLineFetch(relayRouteController, accountFetch, { abortMeansNoAnswer: true, log: logRelayLine })

  // ---- xm 三线路：星芒账号的工具线路（写进各 AI 工具配置的那条，tool-route-controller.ts） ----
  // 管理工具自己的请求照旧走上面的应用线路；工具线路照 AI 工具自己的网络路径探（Node 的 TLS、系统代理、
  // HTTPS_PROXY），两套可以不一样。历史账号没有工具线路，照旧跟应用线路（createToolRouteRoutingSnapshot）。
  // 线路状态文件只经应用线路、按 origin 显式去读，读不到不算线路失败（需求 7.3）。
  const routeStatusReader = createRouteStatusReader({
    fetch: relayFetch,
    lines: () => relayRouting.lines().solov.line === 'direct' ? ['direct', 'primary'] : ['primary', 'direct'],
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  // 最近一次读到的状态文件和两条线路最近一次的探测结果：只给检查报告（C16）和更新源（C15）看。
  let latestRouteStatus: { at: number; status: RouteStatus | null } | null = null
  function readRouteStatus(options: { fresh: boolean }): Promise<RouteStatus | null> {
    return routeStatusReader.read(options).then((status) => {
      latestRouteStatus = { at: Date.now(), status }
      return status
    })
  }
  const latestToolProbes: Partial<Record<RelayEndpointId, ToolRouteProbeRecord>> = {}
  function recordToolProbe(probe: (line: RelayEndpointId) => Promise<ToolRouteProbeResult>): (line: RelayEndpointId) => Promise<ToolRouteProbeResult> {
    return async (line) => {
      const result = await probe(line)
      latestToolProbes[line] = { ok: result.ok, ...(result.kind ? { kind: result.kind } : {}), at: Date.now() }
      return result
    }
  }
  // 环境变量里的代理：Windows 上读当前账号、整台电脑那两份要起一次 PowerShell，所以不跟定时探测一起读，
  // 只在开机、唤醒、网络恢复、点「重新检测」、准备降级时重读，平时用上次的结果（计划第 5 节第 7 条）。
  let toolEnvironmentProxies: Promise<readonly string[]> | null = null
  function readToolEnvironmentProxies(): Promise<readonly string[]> {
    toolEnvironmentProxies ??= (process.platform === 'win32'
      ? readWindowsProxyScopes().catch(() => ({ user: {}, machine: {} }))
      : Promise.resolve({ user: {}, machine: {} })
    ).then((scopes) => environmentProxyCandidates({ process: process.env, ...scopes }))
    return toolEnvironmentProxies
  }
  // 每个环境变量代理一个内存分区（不落盘）；候选最多六个（三份环境 × 两个变量），超了清掉重记。
  // 分区名只增不复用：拿 size 起名的话，删掉一个以后新代理会落到别的代理正在用的分区上，把它的规则改掉。
  const toolProxySessions = new Map<string, { fetch: typeof fetch; ready: Promise<void> }>()
  let toolProxyPartitions = 0
  function toolProxyFetch(proxy: string): typeof fetch {
    let entry = toolProxySessions.get(proxy)
    if (!entry) {
      if (toolProxySessions.size >= 6) toolProxySessions.clear()
      const target = session.fromPartition(`xingmang-tool-proxy-${toolProxyPartitions++}`)
      const created = { fetch: chromiumSessionFetch(target), ready: target.setProxy({ proxyRules: proxy }) }
      created.ready.catch(() => { if (toolProxySessions.get(proxy) === created) toolProxySessions.delete(proxy) })
      toolProxySessions.set(proxy, created)
      entry = created
    }
    const { fetch: proxied, ready } = entry
    return (input, init) => ready.then(() => proxied(input, init))
  }
  // 开发构建可以把工具线路的各个计时缩短 60 倍（需求 5.8，给 V14 这种 24 小时的测试用），打包版不认。
  const toolRouteTimeScale = !app.isPackaged && process.env.XINGMANG_TOOL_ROUTE_FAST === '1' ? 60 : 1
  const toolRouteClockStart = Date.now()
  const toolRouteController = createToolRouteController({
    preference: relayPreferences.solov,
    ...createToolRouteStateStore(path.join(managerDataDirectory, 'tool-route-state.json')),
    readLegacyConclusions: () => relayRouteConclusions.readConclusions(),
    // Linux 本期只测无代理路径（需求 5.1.1）。
    probe: recordToolProbe(createToolRouteProbe({
      direct: (origin) => probeToolPathDirect(origin),
      ...(process.platform === 'linux' ? {} : {
        systemProxyActive: async (origin: string) => parseChromiumProxyResult(await resolveSystemProxy(origin)) !== null,
        throughSystemProxy: (origin: string) => probeToolPathThroughFetch(systemProxyFetch, origin),
        environmentProxies: readToolEnvironmentProxies,
        throughProxy: (proxy: string, origin: string) => probeToolPathThroughFetch(toolProxyFetch(proxy), origin),
      }),
    })),
    readStatus: ({ fresh }) => {
      // 不走缓存读状态文件 = 准备降级或者碰上认不出的地址：环境变量代理也一起重读。
      if (fresh) toolEnvironmentProxies = null
      return readRouteStatus({ fresh })
    },
    notify: (notice) => toolRouteStatusBoard.notice(notice),
    ...(toolRouteTimeScale === 1 ? {} : {
      now: () => toolRouteClockStart + (Date.now() - toolRouteClockStart) * toolRouteTimeScale,
      schedule: (callback: () => void, delayMs: number) => {
        const timer = setTimeout(callback, delayMs / toolRouteTimeScale)
        timer.unref?.()
        return () => clearTimeout(timer)
      },
    }),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  const toolRouteStatusBoard = createToolRouteStatusBoard({
    appReachable: () => probeRelayLineHealth(relayFetch, relayStatusProbeUrl(relayRouting.resolve('solov'))),
    // 只有星芒账号看得到这几样；历史账号、没登录时叫界面重读会白白多一轮外部客户端检测。
    changed: () => { if (readAccountSiteId() === 'solov') notifyRelayRouteChanged() },
  })
  // 写进工具配置、给工具自检对账用的线路：星芒账号读工具线路，历史账号照旧读应用线路。
  const toolRouting = createToolRouteRoutingSnapshot(relayPreferences, () => relayRouteController.lines(), () => toolRouteController.line())
  runtimeLog.log('info', 'config', 'relay.route.active', '本次运行写进工具配置的线路', { kind: 'tool', lines: { solov: toolRouteController.line() } })
  // 写配置前查模型、工具自检：星芒账号在工具线路上没走通报给工具线路，历史账号报先走的那条（默认线路）给应用线路。
  const observedRelayFetch = createRelayObservedFetch(relayRouteController, relayFetch, {
    log: logRelayLine,
    toolLine: {
      route: () => ({ line: toolRouteController.line(), automatic: relayPreferences.solov === 'auto' }),
      reportFailure: (trigger) => toolRouteController.reportFailure(trigger),
    },
  })
  // 「自动」换了线路：界面重读设置、把工具迁过去（App.tsx，开着的也迁）。窗口还没建好时不用叫，
  // 首屏读设置时读到的就是新线路。
  function notifyRelayRouteChanged(): void {
    const managedMainWindow = mainWindow()
    if (!managedMainWindow || managedMainWindow.isDestroyed()) return
    if (managedMainWindow.webContents.isDestroyed()) return
    managedMainWindow.webContents.send(ipcEventChannels.onRelayRouteChanged, undefined)
  }
  const unsubscribeRelayRoute = relayRouteController.subscribe(() => notifyRelayRouteChanged())
  // 什么时候重查见下面 startToolRouteFollowing。
  function recheckRoutes(trigger: 'resume' | 'network' | 'manual'): void {
    toolEnvironmentProxies = null
    toolRouteController.recheck(trigger)
    relayRouteController.recheck(trigger)
  }
  relayRouteController.start()
  return {
    relayRouteController,
    relayRouting,
    sessionFetch,
    resolveSystemProxy,
    // 检查页「别的代理软件」经系统代理、直接连各连一次星芒，比出是不是代理软件挡的路。
    systemProxyFetch,
    siteDirectFetch,
    proxyBypass,
    routedRelayFetch,
    routedAccountRelayFetch,
    routedAccountFetch,
    observedRelayFetch,
    latestRouteStatus: () => latestRouteStatus,
    readRouteStatus,
    latestToolProbes,
    toolRouteController,
    toolRouteStatusBoard,
    toolRouting,
    notifyRelayRouteChanged,
    unsubscribeRelayRoute,
    recheckRoutes,
  }
}

export type NetworkRoutes = ReturnType<typeof createNetworkRoutes>

export interface ToolRouteFollowingOptions {
  systemService: Pick<SystemService, 'followToolRoutes'>
  readAccountSiteId: () => string
}

/** 系统服务建好以后才开始跟工具线路：换了线路要它把工具配置里的地址改过去。 */
export function startToolRouteFollowing(
  routes: Pick<NetworkRoutes, 'toolRouteController' | 'toolRouteStatusBoard' | 'notifyRelayRouteChanged' | 'recheckRoutes'>,
  options: ToolRouteFollowingOptions,
) {
  const { toolRouteController, toolRouteStatusBoard, notifyRelayRouteChanged, recheckRoutes } = routes
  const { systemService, readAccountSiteId } = options
  // 星芒账号的工具线路换了：主进程把四个工具配置里的地址定点改过去（xm 三线路 C9）。历史账号照旧
  // 由界面收到应用线路那声以后走同步 Key。只有因为连不上换的（没通、劫持、服务端整体故障）才可能提示
  // 重开（C10）。服务端切换、三线全挂这些状态变了也叫界面重读设置。
  let toolRouteLine = toolRouteController.line()
  const unsubscribeToolRoutes = toolRouteController.subscribe((snapshot) => {
    toolRouteStatusBoard.update(snapshot)
    const lineChanged = snapshot.line !== toolRouteLine
    if (lineChanged) {
      toolRouteLine = snapshot.line
      // Codex 对话太大换的线路由 codex-payload-limit.ts 那边自己提示重开，只说 Codex，这里不说「连不上换了」。
      const reason = snapshot.lastChange?.reason
      void systemService.followToolRoutes?.({ reason: 'route-changed', fault: reason !== 'recovered' && reason !== 'payload-too-large' })
    }
    if (lineChanged || readAccountSiteId() === 'solov') notifyRelayRouteChanged()
  })
  toolRouteController.start()
  // 唤醒、网络恢复、点「重新检测」都马上查一轮工具线路（需求 5.1.4）和管理工具自己的应用线路（#1053：
  // 以前只查工具线路，换了网络以后账号、余额要等定时检查或者某次请求失败才开始换）。加速那边的 resume
  // 监听只在有加速时注册，不能挂在它上面。网络恢复没有现成的事件，隔 15 秒看一眼 net.isOnline()（只读
  // 本机状态，不出网）。
  const onRouteResume = () => recheckRoutes('resume')
  powerMonitor.on('resume', onRouteResume)
  let routeOnline = net.isOnline()
  const routeOnlineTimer = setInterval(() => {
    const online = net.isOnline()
    if (online && !routeOnline) recheckRoutes('network')
    routeOnline = online
  }, 15_000)
  routeOnlineTimer.unref?.()
  return { unsubscribeToolRoutes, onRouteResume, routeOnlineTimer }
}
