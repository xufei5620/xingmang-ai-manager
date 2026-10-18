import { useEffect, useState } from 'react'

/**
 * 防「慢响应盖掉新数据」（AGENTS.md T6）：每发一次请求先 begin()，响应回来先问拿到的那个函数
 * 这次还算不算数。后来又 begin() 一次、invalidate()、组件卸载，都会让之前拿到的全部作废。
 * 以前每处手抄一个 useRef(0) 计数器（#1073 第 10 条），新代码用这一份；旧的等 #1070 拆分时一并换。
 */
export interface LatestRequest {
  /** 开始一次新请求。返回的函数只在这次仍是最后一次时为真。 */
  begin(): () => boolean
  /** 不发新请求，只把手上的全部作废：换了账号或参数、关掉弹窗时用。 */
  invalidate(): void
}

export function createLatestRequest(): LatestRequest {
  let sequence = 0
  return {
    begin() {
      const id = ++sequence
      return () => id === sequence
    },
    invalidate() {
      sequence++
    },
  }
}

/**
 * 组件或 hook 里用：同一个组件实例拿到的始终是同一份，可以放进依赖数组。卸载时自己作废，
 * 不用再写 `return () => { request.current++ }`。开发版 StrictMode 会假卸载一次，effect 里发的
 * 请求随 effect 重跑再发一次就行（同 useResource）。
 */
export function useLatestRequest(): LatestRequest {
  const [latest] = useState(createLatestRequest)
  useEffect(() => latest.invalidate, [latest])
  return latest
}
