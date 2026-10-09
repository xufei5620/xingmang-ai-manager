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
import type { ToolRouteNotice, ToolRouteSnapshot } from './tool-route-controller'

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
