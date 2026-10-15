import type { TutorialTopic } from '../../registry/tutorials'

/**
 * 教程卡片上的「已完成 k / n 步」（v4 问8）。只是这台电脑上的阅读进度，丢了重新读一遍就行，
 * 不值得为它新开主进程通道；写法照 first-run-dismissal.ts：storage 由调用方传入，纯函数部分
 * 不需要 DOM 就能测；读回来的内容一律当坏数据校验，别人改过 localStorage 不该让教程页白掉。
 */
export interface TutorialProgressStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
export type TutorialProgress = Readonly<Record<string, number>>

export const tutorialProgressKey = 'xingmang-ui-v2:tutorial-progress'

export function getTutorialProgressStorage(): TutorialProgressStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

/** 只留认识的篇目、0 到这篇步数之间的整数；教程改短了，记下的步数跟着收到新的总数。 */
export function readTutorialProgress(storage: TutorialProgressStorage | null, topics: readonly Pick<TutorialTopic, 'id' | 'steps'>[]): TutorialProgress {
  if (!storage) return {}
  try {
    const raw = storage.getItem(tutorialProgressKey)
    if (!raw || raw.length > 4_000) return {}
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const progress: Record<string, number> = {}
    for (const topic of topics) {
      const done = (value as Record<string, unknown>)[topic.id]
      if (typeof done === 'number' && Number.isInteger(done) && done > 0) progress[topic.id] = Math.min(done, topic.steps.length)
    }
    return progress
  } catch { return {} }
}

/**
 * 记下读完了几步，只往前走：回头看前面的步骤不会把进度退回去。没变化时原样返回同一个对象，
 * 滚动时每一帧都会调到这里，React 看到同一个对象就不重新渲染，也不重复写 localStorage。
 */
export function recordTutorialProgress(storage: TutorialProgressStorage | null, progress: TutorialProgress, topic: Pick<TutorialTopic, 'id' | 'steps'>, done: number): TutorialProgress {
  const next = Math.min(Math.max(0, Math.floor(done)), topic.steps.length)
  if (next <= (progress[topic.id] ?? 0)) return progress
  const updated = { ...progress, [topic.id]: next }
  if (storage) {
    try { storage.setItem(tutorialProgressKey, JSON.stringify(updated)) } catch { /* 进度只在这次打开里有效，不打断阅读。 */ }
  }
  return updated
}

export interface TutorialCardState {
  text: string
  action: '开始' | '继续' | '再看一遍'
  /** 点按钮后翻到第几步（从 0 数）；「继续」落在第一个还没读完的那一步。 */
  resumeAt: number
}

export function buildTutorialCardState(done: number, total: number, minutes: number): TutorialCardState {
  if (done >= total) return { text: '已全部完成', action: '再看一遍', resumeAt: 0 }
  if (done > 0) return { text: `已完成 ${done} / ${total} 步`, action: '继续', resumeAt: done }
  return { text: `${total} 步，约 ${minutes} 分钟`, action: '开始', resumeAt: 0 }
}
