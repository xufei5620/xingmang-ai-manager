import type { PlatformPrivacyPreference } from './contract'

// 设置「隐私数据」里的开关由这里的平台服务保存（system-service.ts），匿名使用统计却建在
// main.ts 里（usage-stats-reporter.ts）。两边同进程、互不 import，照 tray-availability-bridge.ts
// 的做法留一个转接口，方向反过来：这边存好开关后告诉那边。没接上就什么都不做：那边接上以后
// 每次记和发之前都重读开关，关着时第一次定时检查也会删掉本机那份。
type PrivacyChangeListener = (kind: PlatformPrivacyPreference, enabled: boolean) => void

let listener: PrivacyChangeListener | null = null

/** 返回摘掉自己的函数；只摘得掉自己，后接上的那个不受影响。 */
export function attachPrivacyChangeListener(next: PrivacyChangeListener): () => void {
  listener = next
  return () => {
    if (listener === next) listener = null
  }
}

export function notifyPrivacyChanged(kind: PlatformPrivacyPreference, enabled: boolean): void {
  listener?.(kind, enabled)
}
