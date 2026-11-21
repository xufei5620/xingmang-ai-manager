// Codex 有个对话大到线路 1 发不出去（413）时帮客户换到线路 2（codex-payload-limit.ts）：盯着 Codex 的会话记录，
// 认出来以后星芒账号换工具线路、历史账号换应用线路，Codex 的配置跟过去、提示重开；换不成的提示新开对话。系统服务
// 和两套线路都建好以后才开始盯；那条「新开对话」的提示板先建，系统服务把它放进设置快照。
import path from 'node:path'
import {
  type CodexPayloadLimitDependencies,
  type CodexPayloadNoticeBoard,
  createCodexPayloadLimitService,
  createCodexPayloadStateStore,
  createCodexRolloutWatcher,
} from '../codex-payload-limit'
import type { CodexPayloadNoticeKind } from '../running-tools'
import type { RuntimeLogStore } from '../runtime-log'
import type { SystemService } from '../system-service'
import type { NetworkRoutes } from './network-routes'

export interface CodexPayloadWatchOptions {
  managerDataDirectory: string
  codexHome: string
  runtimeLog: RuntimeLogStore
  readAccountSiteId: () => string
  /** 当前登录的是谁（站点加用户编号），没登录给 null：认出处理到一半换了人（R29-03）。 */
  readAccountOwner?: () => string | null
  routes: Pick<NetworkRoutes, 'relayRouteController' | 'toolRouteController' | 'toolRouting' | 'notifyRelayRouteChanged'>
  systemService: Pick<SystemService, 'followToolRoutes' | 'noteCodexPayloadRestart' | 'readStoredConfig'>
  notices: CodexPayloadNoticeBoard
  /** 发系统通知（客户这会儿多半在 Codex 里，看不见星芒角落那张卡）。 */
  notifyHost: (kind: CodexPayloadNoticeKind, eventKey: string) => void
}

type CodexPayloadRouting = Pick<CodexPayloadLimitDependencies,
  'activeSiteId' | 'accountOwner' | 'preference' | 'toolLine' | 'codexOnRelay' | 'holdDirect' | 'followCodex' | 'notify'>

/** 不碰文件的那一半：哪个站换哪套线路、Codex 的配置怎么跟过去、提示往哪发。 */
export function codexPayloadRouting(options: Omit<CodexPayloadWatchOptions, 'managerDataDirectory' | 'codexHome' | 'runtimeLog'>): CodexPayloadRouting {
  const { routes, systemService } = options
  return {
    activeSiteId: () => options.readAccountSiteId(),
    accountOwner: () => options.readAccountOwner?.() ?? null,
    preference: (siteId) => routes.toolRouting.preferences[siteId],
    toolLine: (siteId) => routes.toolRouting.lines()[siteId].line,
    codexOnRelay: () => !systemService.readStoredConfig().officialProviders?.includes('codex'),
    holdDirect: (siteId, trigger) => siteId === 'solov'
      ? routes.toolRouteController.holdDirect(trigger)
      : routes.relayRouteController.holdDirect(siteId, trigger),
    async followCodex(siteId, result, stillCurrent) {
      if (siteId === 'solov') {
        // 星芒账号的工具配置由主进程定点改（tool-route-follow-service.ts）：换线那一声已经在改了，这里再叫一次 Codex，
        // 等它改完再看配置在不在线路 2 上。等的时候换了账号、Codex 换成了官方账号，就别再提示重开（R29-03）。
        await systemService.followToolRoutes?.({ reason: 'payload', providers: ['codex'] })
        if (!stillCurrent()) return false
        return await systemService.noteCodexPayloadRestart?.() ?? false
      }
      // 历史账号的工具配置由界面整份写入跟过去（useRelayRouteSync），写完那一步（noteRouteFollowRestart）再提示重开。
      if (result === 'switched') return true
      return await systemService.noteCodexPayloadRestart?.() ?? false
    },
    notify(kind) {
      const notice = options.notices.show(kind)
      routes.notifyRelayRouteChanged()
      options.notifyHost(kind, String(notice.id))
    },
  }
}

export function startCodexPayloadWatch(options: CodexPayloadWatchOptions) {
  const { runtimeLog } = options
  const service = createCodexPayloadLimitService({
    ...codexPayloadRouting(options),
    ...createCodexPayloadStateStore(path.join(options.managerDataDirectory, 'codex-payload-sessions.json')),
    log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
  })
  const watcher = createCodexRolloutWatcher({
    sessionsDirectory: path.join(options.codexHome, 'sessions'),
    onPayloadTooLarge: (event) => { void service.payloadTooLarge(event) },
    onLargeSession: (event) => service.largeSession(event),
    log: (level, event, message, detail) => runtimeLog.log(level, 'config', event, message, detail),
  })
  watcher.start()
  return { dispose: () => watcher.dispose() }
}
