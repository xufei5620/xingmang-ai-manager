import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AccountSessionState, XingmangApi } from '../../../../electron/ipc-contract'
import type { LatestRequest } from '../../latest-request'
import { accountScope } from '../../account-context'
import { formatAccountReadError } from './account-read-error'
import type { AccountBalanceStore } from './balance-store'
import { vaultRecoveredNotice, type StartupNotice } from './startup-notice'
import type { AppApi, AppToast, Toolbox, ToolsApi } from './runtime-context'

interface AccountSessionSyncOptions {
  native: XingmangApi
  app: AppApi
  toolsApi: ToolsApi
  toolbox: Toolbox
  toast: AppToast
  balanceStore: AccountBalanceStore
  session: AccountSessionState
  setSession: Dispatch<SetStateAction<AccountSessionState>>
  scope: string
  restoring: boolean
  sessionEvents: LatestRequest
  accountEpoch: LatestRequest
  mounted: RefObject<boolean>
  /** 上一个账号点的「打开」和它弹的问话框，换账号时一并放掉（useToolLaunch）。 */
  cancelPendingLaunchDialogs(): void
  /** 在跑的那一轮密钥同步要不要停下，由它按换到的账号判断（useAccountBootstrap）。 */
  followSessionChange(next: AccountSessionState): void
  refreshRecent(): void
  noteStartupCheck(notice: StartupNotice): void
  /** 收起工具配置、客户端连接这两个跟账号走的弹窗。 */
  closeAccountDialogs(): void
  /** 退到未登录：收起引导，回首页，欢迎页重新出来。 */
  leaveWorkspace(): void
  setUnread: Dispatch<SetStateAction<boolean>>
  setPaymentReturn: Dispatch<SetStateAction<{ sequence: number; order: string | null } | undefined>>
}

/**
 * 换账号、退出登录、登录被结束、开机恢复落定：主进程广播会话变化，这里把整套界面跟过去，
 * 上一个账号还没做完的事一律作废（accountEpoch）。
 */
export function useAccountSessionSync(options: AccountSessionSyncOptions) {
  const { native, app, toolsApi, toolbox, toast, balanceStore, session, setSession, scope, restoring, sessionEvents, accountEpoch, mounted, cancelPendingLaunchDialogs, followSessionChange, refreshRecent, noteStartupCheck, closeAccountDialogs, leaveWorkspace, setUnread, setPaymentReturn } = options
  const [accountReadError, setAccountReadError] = useState<{ scope: string; message: string } | null>(null)
  // 自己点的「退出登录」正在进行。主进程退完就广播会话变化，还要清完星芒AI Skill 的密钥
  // 才回话，所以事件总比退出这次调用的返回先到，光看事件分不出是自己退的还是登录被
  // 结束了（#1098）。退出期间记一笔，事件看到它就不说「当前登录已结束」。
  const voluntaryLogout = useRef(false)
  // 换账号等于换了一整套上下文：首页那份「最近」和余额卡用量两份缓存（各 60 秒）
  // 必须当场作废，否则切过去的头一眼看到的还是上一个账号在的时候读到的东西。
  useLayoutEffect(() => { accountEpoch.invalidate(); cancelPendingLaunchDialogs(); setAccountReadError(null); refreshRecent(); toolsApi.invalidateBalanceUsage() }, [scope, session.authenticated, refreshRecent, toolsApi, accountEpoch, cancelPendingLaunchDialogs])
  const reloadAccount = useCallback(async () => {
    const thisReload = accountEpoch.begin()
    cancelPendingLaunchDialogs()
    let next: AccountSessionState
    try { next = await app.session() }
    catch (cause) {
      if (!mounted.current || !thisReload()) return
      const message = formatAccountReadError(cause, 'session')
      if (message) setAccountReadError({ scope, message })
      return
    }
    if (!mounted.current || !thisReload()) return
    setSession(next); closeAccountDialogs(); setAccountReadError(null)
    balanceStore.setScope(next.authenticated ? accountScope(next) : null)
    if (next.authenticated) await balanceStore.refresh('foreground')
    else leaveWorkspace()
  }, [app, balanceStore, scope, accountEpoch, cancelPendingLaunchDialogs, closeAccountDialogs, leaveWorkspace, mounted, setSession])
  const logoutVoluntarily = useCallback(async function logout(): Promise<void> {
    voluntaryLogout.current = true
    try { await app.logout() }
    finally { voluntaryLogout.current = false }
  }, [app])
  useEffect(() => native.onAccountSessionChanged?.((next) => {
    sessionEvents.invalidate()
    accountEpoch.invalidate()
    cancelPendingLaunchDialogs()
    followSessionChange(next)
    setSession(next); setAccountReadError(null); setUnread(false); closeAccountDialogs(); setPaymentReturn(undefined)
    balanceStore.setScope(next.authenticated ? accountScope(next) : null)
    if (restoring) {
      // 开机恢复结束。先进首页时读到的配置没有账号可比，来源是「待定」：恢复成功
      // 就当场补读一次（作用域没变，首页不重来）；没恢复成就只是落回未登录，
      // 回到欢迎页，不按「登录被结束」处理。
      if (next.authenticated) { void toolbox.refreshConfig().catch(() => undefined); void balanceStore.refresh('foreground') }
      return
    }
    if (!next.authenticated) {
      leaveWorkspace()
      if (session.authenticated && !voluntaryLogout.current) toast.show('当前登录已结束，请重新登录。', 'warn')
    }
    else void balanceStore.refresh('foreground')
  }), [native, balanceStore, restoring, session.authenticated, toast, toolbox.refreshConfig, sessionEvents, accountEpoch, cancelPendingLaunchDialogs, followSessionChange, closeAccountDialogs, leaveWorkspace, setSession, setUnread, setPaymentReturn])
  // 本机账号存储被重建：主进程一次启动只发一条，界面照后台检查那套挂在角落，
  // 用户关掉就不再出现。事件不带任何账号内容，这里也不去读它。
  useEffect(() => native.onAccountVaultRecovered?.(() => noteStartupCheck(vaultRecoveredNotice())), [native, noteStartupCheck])
  return { accountReadError, setAccountReadError, reloadAccount, logoutVoluntarily }
}
