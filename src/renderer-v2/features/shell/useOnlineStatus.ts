import { createContext, useContext, useSyncExternalStore } from 'react'

export interface OnlineStatus {
  offline: boolean
  /** 「重新检测」正在跑。 */
  checking: boolean
  recheck(): void
}

function noRecheck() {}

// 缺省按有网算：组件测试走 react-dom/server、没有 Provider，页面就按有网时的样子渲染。
export const OnlineStatusContext = createContext<OnlineStatus>({ offline: false, checking: false, recheck: noRecheck })

/** 要联网的按钮点下去之前读这个；true 就直接说没网，不等请求超时。 */
export function useOnlineStatus(): OnlineStatus {
  return useContext(OnlineStatusContext)
}

function subscribeBrowserOnline(listener: () => void) {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

function readBrowserOnline() {
  return navigator.onLine !== false
}

function serverBrowserOnline() {
  return true
}

/** navigator.onLine 只当触发信号，最终判断见 online-status.ts 的 isOffline。 */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(subscribeBrowserOnline, readBrowserOnline, serverBrowserOnline)
}
