// 托盘建在 main.ts 里（Linux 上要先问任务栏有没有地方放，linux-tray-host.ts），设置页
// 「开机自动启动」那句说明却由这里的平台服务给出：有托盘时开机在托盘里待命，没有就
// 直接弹窗口。两边同进程、互不 import，照 proxy-bypass-bridge.ts 的做法留一个转接口；
// 没接上返回 null，由调用方按旧说法处理。
let reader: (() => boolean) | null = null

export function attachTrayAvailability(read: () => boolean): void {
  reader = read
}

export function trayAvailability(): boolean | null {
  return reader ? reader() : null
}
