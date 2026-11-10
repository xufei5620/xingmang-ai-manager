import { useEffect, useState } from 'react'
import type { RendererRestartWork } from '../../electron/ipc-contract'

/**
 * 手上正在做、界面一关就会断的事：聊天在回复、视频剪辑在出片拼片、工具在装、密钥在同步。
 *
 * 窗口缩到托盘久了，主进程会关掉界面进程省内存（electron/renderer-release.ts），关之前先看界面有没有
 * 这些事。各处用 useBackgroundWork 登记，App 汇总以后报给主进程（features/app/useRendererRelease.ts）。
 *
 * 其中聊天在回复或出图、视频剪辑在拼接这两样，重启装更新前主进程还要点名问一句（D10）：登记时带上
 * restartWork，主进程只列真在跑的那几样。
 */
const active = new Map<symbol, RendererRestartWork | undefined>()
const listeners = new Set<() => void>()

export function markBackgroundWork(token: symbol, busy: boolean, restartWork?: RendererRestartWork): void {
  if (busy === active.has(token)) return
  if (busy) active.set(token, restartWork)
  else active.delete(token)
  for (const listener of [...listeners]) listener()
}

export function backgroundWorkActive(): boolean {
  return active.size > 0
}

/** 正在做的事里，重启装更新前要点名的那几样；排好序，前后两次一比就知道变没变。 */
export function activeRestartWork(): RendererRestartWork[] {
  const kinds = new Set<RendererRestartWork>()
  for (const kind of active.values()) {
    if (kind) kinds.add(kind)
  }
  return [...kinds].sort()
}

export function subscribeBackgroundWork(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** busy 为真时登记上，做完或组件卸载时撤掉。label 只给调试看。 */
export function useBackgroundWork(label: string, busy: boolean, restartWork?: RendererRestartWork): void {
  const [token] = useState(() => Symbol(label))
  useEffect(() => {
    markBackgroundWork(token, busy, restartWork)
    return () => { markBackgroundWork(token, false) }
  }, [token, busy, restartWork])
}
