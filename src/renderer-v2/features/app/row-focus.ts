import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * 从别处跳过来要落到页面里的某一行：顶部搜索搜到设置里的「自动更新」，设置页要翻到那一行；
 * 设置里「企业证书」的「去检查页」，检查页要翻到「安全证书」那一项。页面切换只传页面名，
 * 要翻到的那一行先放在这里，页面把那一行画出来以后取走（同 settings-group-intent）。
 */
export type RowFocusPage = 'settings' | 'health'

/** 检查页上「第一项问题」：开机提示的「去看看」不知道是哪一项，由检查页自己换成那一项的 code。 */
export const firstProblemAnchor = 'first-problem'

let pending: { page: RowFocusPage; anchor: string } | null = null
const listeners = new Set<() => void>()

export function requestRowFocus(page: RowFocusPage, anchor: string): void {
  pending = { page, anchor }
  for (const listener of listeners) listener()
}

/** 取走这一页待翻到的那一行；别的页的不动，取走即清空。 */
export function takeRowFocus(page: RowFocusPage): string | null {
  if (pending?.page !== page) return null
  const anchor = pending.anchor
  pending = null
  return anchor
}

export function hasRowFocus(page: RowFocusPage): boolean {
  return pending?.page === page
}

/**
 * 翻到那一行之前在那一行上发的事件（冒泡）。外壳换页时会等新页面长高、再把正文滚回这一页上次的位置，
 * 设置页从别处打开时先只有一行「正在读取设置…」，长高那一下正好落在翻到那一行之后，会把它又拽走；
 * 外壳收到这个事件就不再滚回去。
 */
export const rowFocusEvent = 'xingmang-row-focus'

// 那一行亮一下的时长；开了「减少动画」时不闪，同样时长里只围一圈边框（样式在 components.css）。
const highlightMs = 2000
// 有的行要等别的读取回来才画得出（Mac 才有的「卸载星芒」要等平台能力），先等一会儿再放弃。
const lookupAttempts = 20
const lookupIntervalMs = 100

function rowFor(root: HTMLElement, anchor: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>('[data-anchor]'))
    if (element.dataset.anchor === anchor) return element
  return null
}

function highlight(row: HTMLElement) {
  row.dispatchEvent(new Event(rowFocusEvent, { bubbles: true }))
  row.scrollIntoView?.({ block: 'center' })
  // 键盘用户回车打开的，焦点直接给那一行能操作的第一个控件，不用再从页头一路 Tab 过来。
  row.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus({ preventScroll: true })
  row.dataset.anchorFocus = 'true'
  window.setTimeout(() => { delete row.dataset.anchorFocus }, highlightMs)
}

/**
 * 页面画好了（ready）就看有没有要翻到的那一行：有就滚到正中、亮一下。那一行等了一会儿还是
 * 没画出来（比如检查结果里这台电脑没有「安全证书」），就只停在这一页，不留着下次再跳。
 * resolve：把要翻到的那一行换成页面上真有的那一行（检查页的「第一项问题」），顺便让页面把收起的那一行
 * 摆出来；返回 null 就不翻。缺省 = 原样找。
 */
export function useRowFocus(page: RowFocusPage, root: RefObject<HTMLElement | null>, ready: boolean, resolve?: (anchor: string) => string | null) {
  const [request, setRequest] = useState(0)
  const resolver = useRef(resolve)
  useEffect(() => { resolver.current = resolve })
  useEffect(() => {
    const listener = () => setRequest((value) => value + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  useEffect(() => {
    if (!ready || !hasRowFocus(page)) return
    let attempts = 0
    let timer = 0
    let anchor: string | null = null
    const frame = requestAnimationFrame(function look() {
      anchor ??= takeRowFocus(page)
      const element = root.current
      const target = anchor && resolver.current ? resolver.current(anchor) : anchor
      if (!target || !element) return
      const row = rowFor(element, target)
      if (row) highlight(row)
      else if (++attempts < lookupAttempts) timer = window.setTimeout(look, lookupIntervalMs)
    })
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [page, root, ready, request])
}
