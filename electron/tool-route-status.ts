/**
 * 工具线路要给客户看的那几样（xm 三线路 5.1.5、C20），从 tool-route-controller.ts 的快照和提示里整理出来，
 * 放进设置快照的 relayToolRouteStatus（不加 IPC 通道，界面收到 network:relay-route-changed 重读设置）。
 *
 * - 服务端正在切换：快照里有就给，首页安静显示一行。
 * - 三条线都连不上：控制器按原因 24 小时限过频才叫 notify，这里从那一刻起给到恢复为止；顺带查一下
 *   管理工具自己能不能连上，能就在提示前面多说一句。
 * - 劫持：控制器每台电脑 7 天最多叫一次，这里出来以后半小时内给界面（窗口晚开、重载还能看到）。
 */
import type { RelayToolRouteStatus } from './app-settings'
import type { RelayEndpointId } from './relay-sites'
import type { RouteStatus } from './route-status-file'
import type { ToolRouteChange, ToolRouteChangeReason, ToolRouteNotice, ToolRouteSnapshot } from './tool-route-controller'

export const toolRouteHijackNoticeTtlMs = 30 * 60_000

export interface ToolRouteStatusBoardOptions {
  /** 管理工具自己这会儿能不能连上星芒（应用线路的健康检查）；查不出来按不能。 */
  appReachable(): Promise<boolean>
  /** 要给界面的东西变了：叫界面重读设置。 */
  changed(): void
  now?(): number
}

export interface ToolRouteStatusBoard {
  notice(notice: ToolRouteNotice): void
  /** 控制器的快照变了：恢复了就把三线全挂那条收起。 */
  update(snapshot: ToolRouteSnapshot): void
  status(snapshot: ToolRouteSnapshot): RelayToolRouteStatus | undefined
}

export function createToolRouteStatusBoard(options: ToolRouteStatusBoardOptions): ToolRouteStatusBoard {
  const now = options.now ?? Date.now
  let outage: NonNullable<RelayToolRouteStatus['outage']> | null = null
  let hijack: { id: number } | null = null
  // 每次三线全挂提示 +1：查管理工具能不能连上的那一下回来晚了、这期间已经恢复或者又提示了一次，就作废。
  let generation = 0

  return {
    notice(notice) {
      if (notice.kind === 'hijack') {
        hijack = { id: now() }
        options.changed()
        return
      }
      const token = ++generation
      const id = now()
      void options.appReachable().catch(() => false).then((appReachable) => {
        if (token !== generation) return
        outage = { id, reason: notice.reason, appReachable }
        options.changed()
      })
    },
    update(snapshot) {
      if (snapshot.outage) return
      // 恢复了：还没回来的那一下也作废。
      generation++
      if (!outage) return
      outage = null
      options.changed()
    },
    status(snapshot) {
      const age = hijack ? now() - hijack.id : -1
      const hijackShown = hijack && age >= 0 && age < toolRouteHijackNoticeTtlMs ? hijack : null
      const outageShown = snapshot.outage ? outage : null
      if (!snapshot.serverSwitching && !hijackShown && !outageShown) return undefined
      return {
        ...(snapshot.serverSwitching ? { serverSwitching: true as const } : {}),
        ...(outageShown ? { outage: outageShown } : {}),
        ...(hijackShown ? { hijack: hijackShown } : {}),
      }
    },
  }
}

export interface ToolRouteProbeRecord {
  ok: boolean
  kind?: string
  at: number
}

export interface ToolRouteReportInput {
  snapshot: ToolRouteSnapshot
  /** 最近一次读线路状态文件；还没读过给 null。 */
  lastStatus: { at: number; status: RouteStatus | null } | null
  /** 两条线路最近一次照工具的连法探测（tool-route-probe.ts）的结果。 */
  probes: Partial<Record<RelayEndpointId, ToolRouteProbeRecord>>
}

const reportLineNames: Readonly<Record<RelayEndpointId, string>> = { direct: '洛杉矶', primary: 'CF' }
// 拉丁字母前后空一格，和附录 A 的「改走 CF 线路」一个写法。
const reportLineTitles: Readonly<Record<RelayEndpointId, string>> = { direct: '洛杉矶线路', primary: ' CF 线路' }
const reportChangeReasons: Readonly<Record<Exclude<ToolRouteChangeReason, 'recovered'>, string>> = {
  failed: '没连上',
  hijack: '的地址被指到了别处',
  incident: '服务端在处理故障',
}

// 按这台电脑的时区说，和「星芒 AI 网络」那一项的应用线路换线时间同一个写法。
function reportTime(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function describeToolRouteChange(change: ToolRouteChange): string {
  const from = reportLineTitles[change.from].trimStart()
  const to = reportLineTitles[change.to]
  if (change.reason === 'recovered') return `${reportTime(change.at)}，${to.trimStart()}恢复稳定，换回${to}`
  return `${reportTime(change.at)}，${from}${reportChangeReasons[change.reason]}，改走${to}`
}

function describeProbe(record: ToolRouteProbeRecord): string {
  return `${reportTime(record.at)} ${record.ok ? '通' : `没通（${record.kind ?? 'unknown'}）`}`
}

/**
 * 「星芒 AI 网络」那一项导出报告里工具线路的几行（xm 三线路 C16）。只进导出的报告（检查页详情不列这些键），
 * 不带地址：状态文件里只取 incident 状态和洛杉矶那个域名指向哪台入口（lax / hkg 这类代号）。
 */
export function buildToolRouteReport(input: ToolRouteReportInput): Record<string, string> {
  const { snapshot, lastStatus, probes } = input
  const report: Record<string, string> = {
    toolLine: reportLineNames[snapshot.line],
    toolLineMode: snapshot.automatic ? '自动' : '固定',
  }
  if (snapshot.lastChange) {
    report.toolLastChange = describeToolRouteChange(snapshot.lastChange)
    if (snapshot.lastChange.trigger) report.toolLastChangeTrigger = snapshot.lastChange.trigger
  }
  if (snapshot.serverSwitching) report.toolServerSwitching = '是'
  if (snapshot.outage) report.toolOutage = snapshot.outage.reason
  if (!lastStatus) report.routeStatusFile = '还没读过'
  else if (!lastStatus.status) report.routeStatusFile = `${reportTime(lastStatus.at)} 读不到`
  else {
    report.routeStatusFile = `${reportTime(lastStatus.at)} 读得到`
    report.routeStatusIncident = lastStatus.status.incident.state
    const target = lastStatus.status.lines.direct?.target
    if (target) report.routeStatusDirectTarget = target
  }
  for (const line of ['direct', 'primary'] as const) {
    const record = probes[line]
    if (record) report[line === 'direct' ? 'toolProbeLosAngeles' : 'toolProbeCf'] = describeProbe(record)
  }
  return report
}
