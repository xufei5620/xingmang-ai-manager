import { useCallback, useState } from 'react'

function windowSession(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

export function readWindowSession(key: string): string | null {
  try { return windowSession()?.getItem(key) ?? null } catch { return null }
}

export function writeWindowSession(key: string, value: string | null): void {
  try {
    const storage = windowSession()
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, value)
  } catch { /* 记不下就只在这次加载里管用，同原来的 useState。 */ }
}

/**
 * 同 useState，值还记在 sessionStorage 里。窗口缩到托盘久了界面会被关掉、叫出来时重新加载
 * （electron/renderer-release.ts），同一个窗口的 sessionStorage 还在：客户点掉的提示不会又冒出来。
 */
export function useWindowSessionString(key: string): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState(() => readWindowSession(key))
  const update = useCallback((next: string | null) => {
    writeWindowSession(key, next)
    setValue(next)
  }, [key])
  return [value, update]
}
