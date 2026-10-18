import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { NetworkSettingsKind, XingmangApi } from '../../../../electron/ipc-contract'
import { isOffline, offlineCause, stillOfflineText } from '../shell/online-status'
import { useBrowserOnline, type OnlineStatus } from '../shell/useOnlineStatus'
import type { AccountBalanceSnapshot, AccountBalanceStore } from './balance-store'
import type { AppToast } from './runtime-context'

interface AppOnlineStatusOptions {
  native: XingmangApi
  toast: AppToast
  authenticated: boolean
  balanceStore: AccountBalanceStore
  balanceState: AccountBalanceSnapshot
  mounted: RefObject<boolean>
}

/**
 * 顶上那条「网断了」横幅背后的判断：系统说断了，或者登录后读余额连着失败。代理连不上时先替用户
 * 试一次直连；「重新检测」再读一次余额，真通了横幅才收起。
 */
export function useAppOnlineStatus({ native, toast, authenticated, balanceStore, balanceState, mounted }: AppOnlineStatusOptions) {
  const browserOnline = useBrowserOnline()
  const offline = isOffline({ browserOnline, networkFailures: authenticated ? balanceState.networkFailures : 0 })
  // 安装任务跑到一半要看的是「现在」断没断网（换成星芒装的，动手卸之前），闭包里的 offline 停在点按钮那一刻。
  const offlineNow = useRef(offline)
  offlineNow.current = offline
  const [onlineChecking, setOnlineChecking] = useState(false)
  // 系统说网回来了，不等下一次定时刷新：马上读一次余额，确认真的通了横幅才收起。
  useEffect(() => {
    if (browserOnline && authenticated && balanceStore.getSnapshot().networkFailures > 0) void balanceStore.refresh('manual')
  }, [browserOnline, balanceStore, authenticated])
  const onlineCause = offline ? offlineCause({ browserOnline, networkFailureReason: balanceState.networkFailureReason }) : undefined
  // 代理连不上时，星芒先替用户试一次直连（只改自己的连接，下次打开软件照旧跟随系统）。
  // 自动只试一次；之后点「重新检测」再试。
  const proxyBypassTried = useRef(false)
  const [proxyBypassNotice, setProxyBypassNotice] = useState(false)
  const tryProxyBypass = useCallback(async () => {
    proxyBypassTried.current = true
    const outcome = await Promise.resolve().then(() => native.bypassBrokenProxy()).catch(() => 'unavailable' as const)
    if (outcome === 'direct' && mounted.current) setProxyBypassNotice(true)
    return outcome === 'direct'
  }, [native, mounted])
  useEffect(() => {
    if (onlineCause !== 'proxy' || proxyBypassTried.current) return
    void tryProxyBypass().then((direct) => { if (direct) void balanceStore.refresh('manual') })
  }, [onlineCause, tryProxyBypass, balanceStore])
  const recheckOnline = useCallback(() => {
    if (!navigator.onLine || !authenticated) { toast.show(stillOfflineText, 'warn'); return }
    setOnlineChecking(true)
    const bypass = onlineCause === 'proxy' ? tryProxyBypass() : Promise.resolve(false)
    void bypass.then(() => balanceStore.refresh('manual')).finally(() => {
      if (!mounted.current) return
      setOnlineChecking(false)
      if (isOffline({ browserOnline: navigator.onLine, networkFailures: balanceStore.getSnapshot().networkFailures })) toast.show(stillOfflineText, 'warn')
    })
  }, [balanceStore, authenticated, onlineCause, tryProxyBypass, toast, mounted])
  const openNetworkSettings = useCallback((kind: NetworkSettingsKind) => {
    void Promise.resolve().then(() => native.openNetworkSettings(kind)).then((opened) => {
      if (!opened) throw new Error('not-opened')
    }).catch(() => {
      toast.show(kind === 'proxy' ? '没能打开系统代理设置，请在系统设置里找「代理」。' : '没能打开认证页，请打开浏览器随便访问一个网页。', 'warn')
    })
  }, [native, toast])
  const dismissProxyBypassNotice = useCallback(() => setProxyBypassNotice(false), [])
  // 代理软件好了以后主进程会改回跟随系统代理（electron/proxy-bypass.ts），这条提示说的就不对了：自己收起，不用等用户点「知道了」。
  useEffect(() => native.onProxyBypassEnded?.(() => setProxyBypassNotice(false)), [native])
  const onlineStatus = useMemo<OnlineStatus>(() => ({
    offline,
    cause: onlineCause,
    proxyBypassNotice: !offline && proxyBypassNotice,
    checking: onlineChecking,
    recheck: recheckOnline,
    openNetworkSettings,
    dismissProxyBypassNotice,
  }), [offline, onlineCause, proxyBypassNotice, onlineChecking, recheckOnline, openNetworkSettings, dismissProxyBypassNotice])
  return { offline, offlineNow, onlineStatus }
}
