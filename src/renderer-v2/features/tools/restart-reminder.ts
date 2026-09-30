import { useSyncExternalStore } from 'react'

/**
 * 「运行环境装好了、还差重启一次电脑」这件事记在渲染进程里，软件开着就一直在。
 * 以前只弹一次重启框，关掉之后页面上什么都不留，用户接着点「安装」就会失败
 * （新手引导梳理 9-25 第 4 条）。
 *
 * 故意不落盘：重启电脑时软件也跟着关了，下次打开这里自然是空的；写进本机存储
 * 反而分不清「重启过了」和「只是把软件关了又开」，会一直错报。
 */
let pending = false
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function markRestartPending() {
  if (pending) return
  pending = true
  notify()
}

/** 只给测试用：把记下的状态清掉。 */
export function resetRestartPending() {
  pending = false
  notify()
}

export function readRestartPending() {
  return pending
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useRestartPending() {
  return useSyncExternalStore(subscribe, readRestartPending, readRestartPending)
}
