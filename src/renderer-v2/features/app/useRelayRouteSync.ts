import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AccountSessionState, AppSettingsV2, XingmangApi } from '../../../../electron/ipc-contract'
import type { AccountSiteId } from '../../account-context'
import { accountRoutesPending } from '../tools/account-bootstrap'
import type { AccountBootstrap } from './useAccountBootstrap'
import type { AppApi, Toolbox } from './runtime-context'

interface RelayRouteSyncOptions {
  native: XingmangApi
  app: AppApi
  boot: 'loading' | 'ready' | 'failed'
  session: AccountSessionState
  siteId: AccountSiteId
  toolbox: Toolbox
  setSettings: Dispatch<SetStateAction<AppSettingsV2 | null>>
  showRouteRestartHint(settings: AppSettingsV2): void
  runAccountBootstrap: AccountBootstrap['runAccountBootstrap']
  mounted: RefObject<boolean>
}

/**
 * 「自动」那条线路查出了结论、退回默认线路或切回直连（直连适配第二步）：设置里的线路跟着
 * 重读，另外三个客户端重新检测一遍（检测时跟着换，第四十三批 A）。工具配置还停在另一条线路
 * 上的，照开机那一档迁过去，开着的也改（#941）；没有要迁的就不去同步 Key。这一轮首页不摆进度、
 * 只换了线路也不说「已完成…」，出了错照常说（yoyo 10-8：线路的事不要太多提示）。
 */
export function useRelayRouteSync({ native, app, boot, session, siteId, toolbox, setSettings, showRouteRestartHint, runAccountBootstrap, mounted }: RelayRouteSyncOptions) {
  const followRelayRoute = useCallback(async () => {
    const [next, config] = await Promise.all([app.readSettings(), native.getConfig()]).catch(() => [null, null] as const)
    if (!mounted.current || !next || !config) return
    setSettings(next)
    showRouteRestartHint(next)
    void toolbox.refreshExternal(true).catch(() => undefined)
    // 星芒账号的工具配置由主进程定点改到新线路（xm 三线路 C9），改完也是叫这一声：首页的线路标签跟着重读。
    void toolbox.refreshConfig().catch(() => undefined)
    if (session.authenticated && session.account && accountRoutesPending(config, next)) {
      await runAccountBootstrap(session.account.userId, 'restore', true, undefined, siteId, true)
    }
  }, [app, native, runAccountBootstrap, session.account, session.authenticated, showRouteRestartHint, siteId, toolbox.refreshConfig, toolbox.refreshExternal, setSettings, mounted])
  useEffect(() => {
    if (boot !== 'ready') return
    return native.onRelayRouteChanged?.(() => { void followRelayRoute() })
  }, [boot, native, followRelayRoute])
}
