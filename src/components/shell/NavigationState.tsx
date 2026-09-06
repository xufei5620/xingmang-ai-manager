import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

const NavigationStateContext = createContext<Map<string, unknown> | null>(null)

export function NavigationStateProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const values = useMemo(() => new Map<string, unknown>(), [scope])
  return <NavigationStateContext.Provider key={scope} value={values}>{children}</NavigationStateContext.Provider>
}

/** In-memory view preferences only; credentials and request results stay in their owning services. */
export function useNavigationState<Value>(key: string, initial: Value | (() => Value)): [Value, Dispatch<SetStateAction<Value>>] {
  const values = useContext(NavigationStateContext)
  const [value, setValue] = useState<Value>(() => values?.has(key)
    ? values.get(key) as Value
    : typeof initial === 'function' ? (initial as () => Value)() : initial)
  useLayoutEffect(() => { values?.set(key, value) }, [key, value, values])
  return [value, setValue]
}

/** Restore only the viewport position; list data and credentials never enter this store. */
export function PageViewport({ viewKey, children }: { viewKey: string; children: ReactNode }) {
  const values = useContext(NavigationStateContext)
  const fallback = useRef(new Map<string, unknown>())
  const viewportRef = useRef<HTMLElement>(null)
  const store = values ?? fallback.current

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const viewport: HTMLElement = element
    const key = `viewport.scroll:${viewKey}`
    const previous = store.get(key)
    const target = typeof previous === 'number' && Number.isFinite(previous) ? Math.max(0, previous) : 0
    let restoring = target > 0
    let frame = 0
    let disposed = false
    let expectedScrollTop = 0
    let latestScrollTop = target
    const resize = new ResizeObserver(() => scheduleRestore())
    const mutation = new MutationObserver(() => {
      if (!restoring) return
      observeChildren()
      scheduleRestore()
    })

    const stopRestoration = () => {
      restoring = false
      resize.disconnect()
      mutation.disconnect()
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }
    const remember = () => {
      latestScrollTop = viewport.scrollTop
      store.set(key, latestScrollTop)
    }
    const restore = () => {
      frame = 0
      if (disposed || !restoring) return
      expectedScrollTop = Math.min(target, Math.max(0, viewport.scrollHeight - viewport.clientHeight))
      viewport.scrollTop = expectedScrollTop
      if (Math.abs(viewport.scrollTop - target) <= 1) {
        stopRestoration()
        remember()
      }
    }
    function scheduleRestore() {
      if (!disposed && restoring && !frame) frame = requestAnimationFrame(restore)
    }
    function observeChildren() {
      resize.disconnect()
      resize.observe(viewport)
      for (const child of viewport.children) resize.observe(child)
    }
    const onScroll = () => {
      if (restoring) {
        if (Math.abs(viewport.scrollTop - expectedScrollTop) <= 1) return
        stopRestoration()
      }
      remember()
    }
    const onUserIntent = () => {
      if (!restoring) return
      stopRestoration()
      remember()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isComposing && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) onUserIntent()
    }

    viewport.scrollTop = 0
    viewport.addEventListener('scroll', onScroll, { passive: true })
    viewport.addEventListener('wheel', onUserIntent, { passive: true, capture: true })
    viewport.addEventListener('touchstart', onUserIntent, { passive: true, capture: true })
    viewport.addEventListener('pointerdown', onUserIntent, true)
    viewport.addEventListener('keydown', onKeyDown, true)
    viewport.addEventListener('load', scheduleRestore, true)
    if (restoring) {
      observeChildren()
      mutation.observe(viewport, { childList: true, subtree: true, characterData: true, attributes: true })
      restore()
    }

    return () => {
      disposed = true
      store.set(key, latestScrollTop)
      stopRestoration()
      viewport.removeEventListener('scroll', onScroll)
      viewport.removeEventListener('wheel', onUserIntent, true)
      viewport.removeEventListener('touchstart', onUserIntent, true)
      viewport.removeEventListener('pointerdown', onUserIntent, true)
      viewport.removeEventListener('keydown', onKeyDown, true)
      viewport.removeEventListener('load', scheduleRestore, true)
    }
  }, [store, viewKey])

  return <main ref={viewportRef} className="main-content" data-view-key={viewKey}>{children}</main>
}
