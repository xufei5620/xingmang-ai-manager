// 检查页和反馈报告（#1070 第 5 步从 main.ts 的启动回调原样搬出）：健康诊断、一键处理、连接自检、Codex 实测，
// 以及反馈报告里「工具环境」「运行环境」「自检结果」三段。反馈报告只读诊断和扫描上一次留下的结果，
// 生成报告不重跑探测，所以这两样放在一起。
import path from 'node:path'
import { app, session } from 'electron'
import type { AiAssetStore } from '../ai-asset-store'
import { providerIds, type ProviderId } from '../catalog'
import type { CodexHomeContext } from '../codex-home'
import { createCodexResponsesProbeService } from '../codex-responses-probe'
import { inspectProviderConfig } from '../config-files'
import { buildConnectionProbe, runConnectionCheck } from '../connection-check'
import { clearUserProviderOverrides, setAsideCodexDotenv, setAsideHomeProjectInstructions, type DiagnosticFixKind } from '../diagnostic-fixes'
import { clearableEnvironmentOverrides, createDiagnosticsExport, diagnosticsScanReuseMs, environmentAccountBaseUrls, redactDiagnosticText, runDiagnostics, type DiagnosticsDependencies, type DiagnosticsRelayRoute, type DiagnosticsReport, type DiagnosticsRunOptions } from '../diagnostics'
import type { ExternalToolId } from '../external-tool-config'
import { buildFeedbackEnvironmentLines, buildFeedbackRuntimeLines, pickFeedbackRuntimeSnapshot, resolveFeedbackRelayRoute, resolveFeedbackToolRoute } from '../feedback-environment'
import { buildFeedbackSelfCheckLines, hasFeedbackSelfCheck, type FeedbackConnectionRecord } from '../feedback-self-check'
import type { RootedMainServiceOptions } from '../main-service-options'
import { managedCliRoot } from '../managed-cli-paths'
import { relayAutoBackupLine, relayAutoPreferredLines, requireRelaySite, type RelayRouteSiteId } from '../relay-sites'
import type { RuntimeLogStore } from '../runtime-log'
import type { SystemService, SystemSnapshot } from '../system-service'
import { buildToolRouteReport } from '../tool-route-status'
import type { WindowsCliExecutionModeResolution } from '../windows-elevation'
import type { createRealmBusinesses } from './ai-services'
import type { NetworkRoutes } from './network-routes'

type RealmBusiness = ReturnType<ReturnType<typeof createRealmBusinesses>['ensureBusiness']>

export interface DiagnosticsWiringOptions {
  routes: Pick<NetworkRoutes, 'relayRouting' | 'relayRouteController' | 'toolRouting' | 'toolRouteController' | 'latestRouteStatus' | 'latestToolProbes' | 'observedRelayFetch' | 'proxyBypass'>
  systemService: SystemService
  rootedOptions: RootedMainServiceOptions
  codexContext: CodexHomeContext
  managerDataDirectory: string
  windowsCliExecution: WindowsCliExecutionModeResolution
  accelerationBundleStatus: Promise<'intact' | 'damaged' | null>
  accelerationRunning: () => Promise<boolean>
  readDocumentsDirectory: () => string | null
  runtimeLog: RuntimeLogStore
  /** 账号服务建得比这里晚，用到时再取。 */
  readBillingAccountScope: () => string
  /** AI 工作区建得比这里晚，用到时再取当前站点那份。 */
  currentBusiness: () => Pick<RealmBusiness, 'aiOutputPlacement'>
  assetStore: () => Pick<AiAssetStore, 'assertWritable'>
}

export interface FeedbackDescriberOptions {
  /** 最近一次扫描留下的快照（主窗口每次扫描完交回来），还没扫描过是 null。 */
  latestTraySystem: () => SystemSnapshot | null
}

export function createDiagnostics(options: DiagnosticsWiringOptions) {
  const {
    routes: { relayRouting, relayRouteController, toolRouting, toolRouteController, latestRouteStatus, latestToolProbes, observedRelayFetch, proxyBypass },
    systemService, rootedOptions, codexContext, managerDataDirectory, windowsCliExecution, accelerationBundleStatus, accelerationRunning,
    readDocumentsDirectory, runtimeLog, readBillingAccountScope, currentBusiness, assetStore,
  } = options
  const windowsCliExecutionMode = windowsCliExecution.mode
  let latestDiagnostics: DiagnosticsReport | null = null
  // 「星芒 AI 网络」一项要说清用的是哪条线路；「自动」走先走的那条没查通时它改查备用那条，并把失败报过来。
  // 各工具「连接设置」、电脑里另外设过的工具地址比的是工具线路（xm 三线路）；历史账号两套是同一套，不另给。
  function diagnosticsToolRoute(siteId: string | undefined): DiagnosticsDependencies['toolRoute'] {
    const site = toolRouting.resolve(siteId)
    if (site.id !== 'solov') return undefined
    return {
      site,
      route: { line: toolRouting.lines().solov.line, settled: true, automatic: toolRouting.preferences.solov === 'auto', primarySite: requireRelaySite('solov') },
      report: () => buildToolRouteReport({ snapshot: toolRouteController.snapshot(), lastStatus: latestRouteStatus(), probes: latestToolProbes }),
    }
  }
  function diagnosticsRelayRoute(siteId: string | undefined): DiagnosticsRelayRoute | undefined {
    const site = relayRouting.resolve(siteId)
    if (site.id !== 'solov' && site.id !== 'solov-api') return undefined
    const routeSiteId: RelayRouteSiteId = site.id
    const { line, settled } = relayRouting.lines()[routeSiteId]
    return {
      line,
      settled,
      automatic: relayRouting.preferences[routeSiteId] === 'auto',
      primarySite: requireRelaySite(routeSiteId),
      preferredLine: relayAutoPreferredLines[routeSiteId],
      backupSite: requireRelaySite(routeSiteId, relayAutoBackupLine(routeSiteId)),
      reportLineFailure: (reason) => relayRouteController.reportFailure(routeSiteId, line, reason),
      lastChange: relayRouteController.lastChange(routeSiteId),
    }
  }
  // 最近一次连接自检的结论，只留进报告的那几项（没有 Key、没有地址、没有站
  // 点名）。键是四个工具，所以天然有界。
  const latestConnectionChecks = new Map<ProviderId, FeedbackConnectionRecord>()
  function codexProbeContext() {
    const site = toolRouting.resolve(systemService.readStoredConfig().relaySiteId)
    const inspection = inspectProviderConfig(
      'codex', rootedOptions.system.providerRoots, site.providerBaseUrls,
    )
    return { site, inspection }
  }
  const codexResponsesProbe = createCodexResponsesProbeService(
    () => {
      const { site, inspection } = codexProbeContext()
      return buildConnectionProbe('codex', site, inspection)
    },
    {
      // 查的是 Codex 自己那份配置里的地址：工具会走哪条就查哪条（observed，不换不重发）。
      fetch: observedRelayFetch,
      // The Key stays in main-process memory. Re-reading it after the first
      // response prevents a second paid request after account/source changes.
      currentScope: () => {
        const { site, inspection } = codexProbeContext()
        return JSON.stringify([
          readBillingAccountScope(), site.id, inspection.actualBaseUrl,
          inspection.apiKey, inspection.model, inspection.matchesRelay,
        ])
      },
    },
  )
  // 诊断导出与反馈报告都要把本机真正写着的那几把 Key 当敏感值剔掉。
  const sensitiveKeyValues = () => providerIds
    .map((provider) => inspectProviderConfig(provider, rootedOptions.system.providerRoots).apiKey)
    .filter(Boolean)
  const diagnosticsService = {
    run: async (options: DiagnosticsRunOptions = {}) => {
      // 开机自动检查紧跟着首页扫描：扫描正在跑就等它，一分钟内刚跑完就直接用，
      // 不再把各工具的版本探测、PowerShell、Codex 桌面端检测重跑一遍。没有现成的
      // 就照旧自己探，不为此专门起一轮扫描。
      const recent = options.reuseRecentScan ? systemService.recentScan(diagnosticsScanReuseMs) : null
      const recentScan = recent ? await recent.catch(() => null) : null
      latestDiagnostics = await runDiagnostics({
        recentScan,
        ...rootedOptions.diagnostics,
        app: {
          name: '星芒AI管理工具',
          version: app.getVersion(),
          packaged: app.isPackaged,
        },
        inspectCodexDesktop: async () => systemService.inspectCodexDesktop(),
        // 「磁盘空间」那一项要看软件数据目录所在的盘，而 userData 在哪只有宿主
        // 知道；CLI 落点由诊断自己算。
        userDataDirectory: app.getPath('userData'),
        // 跟着当前账号所在的那一套 output 走（历史账号多一层 realms/api-account）。
        probeAiOutput: () => assetStore().assertWritable(),
        aiOutputPlacement: () => currentBusiness().aiOutputPlacement,
        // 「文档文件夹能不能写」一项（Windows）：新项目与 AI 作品默认都放在它下面。
        documentsDirectory: readDocumentsDirectory(),
        ...await accelerationBundleStatus.then((status) => status ? { accelerationBundle: status } : {}),
        windowsExecution: windowsCliExecution,
        windowsProcessor: await systemService.inspectWindowsProcessor(),
        macRosetta: process.platform === 'darwin' && app.runningUnderARM64Translation,
        // 报告只装中文结论（它会被导出发给客服），认出失败靠的那段上游原文
        // 留在 runtime.jsonl 里。
        log: (level, event, message, detail) => runtimeLog.log(level, 'diagnostics', event, message, detail),
        // Read the account's site on every run; endpoint preferences take
        // effect only after restart, matching the live account clients.
        relaySite: relayRouting.resolve(systemService.readStoredConfig().relaySiteId),
        relayRoute: diagnosticsRelayRoute(systemService.readStoredConfig().relaySiteId),
        toolRoute: diagnosticsToolRoute(systemService.readStoredConfig().relaySiteId),
        inspectAccelerationActive: accelerationRunning,
        // 「电脑里的代理设置」顺带看账号请求走不走系统代理：账号请求用的就是
        // defaultSession 的 net.fetch，问它本身最准，也不用另起命令读系统设置。
        resolveAppProxy: (url) => session.defaultSession.resolveProxy(url),
        // 代理不转发星芒、账号和 AI 对话已经自己改了直连时，这一项照实说，不叫人去退代理软件。
        siteDirectActive: () => proxyBypass.siteDirect(),
        // 「Claude 命令确认方式」要分清 bypassPermissions 是我们写的还是别人写的。
        // 来源的判定要比对当前登录账号，只有 system-service 那边算得出来。
        readClaudeConfigOwnership: () => systemService.getConfig(false).providers.claude.configurationOwnership ?? null,
        // 「项目文件夹里的设置」看的是用户最近一次选的项目文件夹，每次检查现读。
        workspace: systemService.readStoredConfig().workspace,
      })
      return latestDiagnostics
    },
    // 检查页的一键处理。要删哪几项、挪哪个文件在点的那一刻按当前环境和当前站点重算，
    // 不信渲染层给的任何名字或路径（I5）。
    fix: async (kind: DiagnosticFixKind) => {
      if (kind === 'set-aside-codex-dotenv') return setAsideCodexDotenv(codexContext.codexHome)
      if (kind === 'set-aside-home-agents-md') return setAsideHomeProjectInstructions(codexContext.userHome)
      const siteId = systemService.readStoredConfig().relaySiteId
      // 和检查页那一项同一套「指向当前账号」：「自动」走直连时指着默认线路的不删。星芒账号按工具线路认。
      const toolRoute = diagnosticsToolRoute(siteId)
      const accountBaseUrls = toolRoute
        ? environmentAccountBaseUrls(toolRoute.site, toolRoute.route)
        : environmentAccountBaseUrls(relayRouting.resolve(siteId), diagnosticsRelayRoute(siteId))
      return clearUserProviderOverrides({
        names: clearableEnvironmentOverrides(process.env, accountBaseUrls, codexContext.userHome),
      })
    },
    // 自检跟着用户当前所在的站点走，探测和对账读同一个 RelaySite ——
    // 与 system-service.ts 的 inspectNativeProviderConfig 同参，否则换过
    // 站点的用户会被告知一份好配置「指错了地方」。站点名只进日志不上屏。
    checkConnection: async (provider: ProviderId) => {
      const site = toolRouting.resolve(systemService.readStoredConfig().relaySiteId)
      const result = await runConnectionCheck({
        provider,
        site,
        inspection: inspectProviderConfig(provider, rootedOptions.system.providerRoots, site.providerBaseUrls),
        // 测的是工具配置里写的那个地址，工具走哪条就测哪条（observed，不换不重发）。
        fetch: observedRelayFetch,
      })
      latestConnectionChecks.set(provider, {
        ok: result.ok,
        layer: result.layer,
        summary: result.summary,
        checkedAt: result.checkedAt,
      })
      return result
    },
    probeCodexResponses: (expectedAccountScope: string) => {
      if (expectedAccountScope !== readBillingAccountScope()) {
        throw new Error('当前账号变了，请重新勾选确认后再检查')
      }
      return codexResponsesProbe.run()
    },
    // 外部客户端的自检由 system-service 出面：Key、地址与归属都只有它算得出
    // 来，主进程这一层只负责把它接到通道上。
    checkExternalConnection: (tool: ExternalToolId) => systemService.checkExternalClientConnection(tool),
    // 预览反馈报告时据此提醒先去检查：与报告里写不写「还没做过自检」读的是同一份结果。
    hasSelfCheckResult: () => hasFeedbackSelfCheck({
      report: latestDiagnostics,
      readConnection: (provider) => latestConnectionChecks.get(provider) ?? null,
    }),
    exportLatest: () => {
      if (!latestDiagnostics) throw new Error('请先运行一次健康诊断')
      return createDiagnosticsExport(latestDiagnostics, {
        ...rootedOptions.diagnosticExport,
        sensitiveValues: sensitiveKeyValues(),
      })
    },
  }
  // 原来在启动回调后段才挂上（要读的扫描快照在那里才声明），由 main.ts 照旧在那个位置调用。
  function attachFeedbackDescribers({ latestTraySystem }: FeedbackDescriberOptions): void {
    // 客服收到反馈报告的第一句总是「你的工具是什么版本、怎么装的、配置指向哪」。
    // 这几行就答这三件事：只读上一次扫描留下的快照（latestTraySystem），不为了
    // 生成一份报告再发一轮探测；配置按用户当前所在的站点对账（同上面的
    // checkConnection），否则换过站的用户会被告知一份好配置「没指向当前账号」。
    runtimeLog.attachEnvironmentDescriber(async () => {
      // 「配置指向哪」对的是写进工具配置的那条（工具线路）。
      const site = toolRouting.resolve(systemService.readStoredConfig().relaySiteId)
      return buildFeedbackEnvironmentLines({
        clis: latestTraySystem()?.clis ?? null,
        readConfig: (provider) => inspectProviderConfig(
          provider,
          rootedOptions.system.providerRoots,
          site.providerBaseUrls,
        ),
        // 三个外部客户端同样只读上一次检测留下的快照：生成一份报告不该再去跑
        // 一轮 PowerShell 盘点。没检测过时那三行写「未能读取」。
        externalClients: systemService.getLastExternalClients(),
      })
    })
    // 「运行环境」段：系统里的 Node / npm / Python / Git、Codex 桌面端、网络位置
    // 同样只读上一次扫描的快照；其余几行是进程本来就知道的路径与区域设置，
    // 不起任何探测。
    runtimeLog.attachHostDescriber(async () => {
      let managedDirectory: string | null = null
      try {
        managedDirectory = managedCliRoot(process.env, process.platform)
      } catch {
        // ProgramData 解析不出来时这一行不出，报告照常生成。
      }
      return buildFeedbackRuntimeLines({
        snapshot: pickFeedbackRuntimeSnapshot(latestTraySystem()),
        platform: process.platform,
        mac: process.platform === 'darwin'
          ? { systemVersion: process.getSystemVersion(), appArch: process.arch, translated: app.runningUnderARM64Translation }
          : null,
        executionMode: process.platform === 'win32' ? windowsCliExecutionMode : null,
        executionProbeFailure: windowsCliExecution.probeFailure?.reason ?? null,
        certificateTrust: latestDiagnostics?.items.find((item) => item.code === 'CERTIFICATE_TRUST')?.summary ?? null,
        relayRoute: resolveFeedbackRelayRoute(relayRouting, systemService.readStoredConfig().relaySiteId),
        toolRoute: resolveFeedbackToolRoute(toolRouting, systemService.readStoredConfig().relaySiteId),
        toolRouteCertificate: toolRouting.resolve(systemService.readStoredConfig().relaySiteId).id === 'solov' ? toolRouteController.certificateFailure() : null,
        appDirectory: path.dirname(app.getPath('exe')),
        dataDirectory: managerDataDirectory,
        managedDirectory,
        locale: app.getLocale(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    })
    // 客服的第二个问题是「到底能不能用」——这答案用户在「检查」页点过一次就有
    // 了，没必要再让他截图发过来。只读上一次的结果，生成报告不重跑自检、不发
    // 网络请求。
    runtimeLog.attachSelfCheckDescriber(async () => buildFeedbackSelfCheckLines({
      report: latestDiagnostics,
      readConnection: (provider) => latestConnectionChecks.get(provider) ?? null,
      now: new Date(),
      // 诊断结论本身不该带 Key，但这份报告是要发到客服群里的，所以跟诊断导出
      // 过同一遍脱敏（I13）。
      redact: (value) => redactDiagnosticText(value, {
        ...rootedOptions.diagnosticExport,
        sensitiveValues: sensitiveKeyValues(),
      }),
    }))
  }
  return { diagnosticsService, attachFeedbackDescribers }
}
