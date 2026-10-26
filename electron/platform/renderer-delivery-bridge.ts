// 主窗口缩在托盘里久了，界面进程会被关掉省内存（renderer-release.ts）；点系统通知叫回窗口时
// 界面正在重新加载，这时发过去的跳页没人接。点通知跳页在 install-system-api.ts 里发，那边和
// main.ts 互不 import，按 host-notification-bridge.ts 的做法留一个转接口：main.ts 接上以后，
// 界面没准备好的那一会儿先存着，准备好了再发。没接上（测试、旧调用方）就照旧马上发。
export type RendererDelivery = (key: string, send: () => void) => void

let sink: RendererDelivery | null = null

export function deliverToMainRenderer(key: string, send: () => void): void {
  if (sink) sink(key, send)
  else send()
}

export function attachRendererDelivery(next: RendererDelivery): void {
  sink = next
}

export function detachRendererDelivery(previous: RendererDelivery): void {
  // 只有当前这一个才能摘掉自己，同 host-notification-bridge.ts。
  if (sink === previous) sink = null
}
