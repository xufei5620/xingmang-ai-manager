import { useEffect, useState } from 'react'

/**
 * 手上正在做、界面一关就会断的事：聊天在回复、视频剪辑在出片拼片、工具在装、密钥在同步。
 *
 * 窗口缩到托盘久了，主进程会关掉界面进程省内存（electron/renderer-release.ts），关之前先看界面有没有
 * 这些事。各处用 useBackgroundWork 登记，App 汇总以后报给主进程（features/app/useRendererRelease.ts）。
 */
const active = new Set<symbol>()
const listeners = new Set<() => void>()

export function markBackgroundWork(token: symbol, busy: boolean): void {
  if (busy === active.has(token)) return
  if (busy) active.add(token)
  else active.delete(token)
  for (const listener of [...listeners]) listener()
}

export function backgroundWorkActive(): boolean {
  return active.size > 0
}

export function subscribeBackgroundWork(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** busy 为真时登记上，做完或组件卸载时撤掉。label 只给调试看。 */
export function useBackgroundWork(label: string, busy: boolean): void {
  const [token] = useState(() => Symbol(label))
  useEffect(() => {
    markBackgroundWork(token, busy)
    return () => { markBackgroundWork(token, false) }
  }, [token, busy])
}
