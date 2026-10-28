import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { searchCanvasNodes, type SearchableNode } from '../editor/node-search'
import { canvasPaletteWindow, clampCanvasPaletteIndex, moveCanvasPaletteIndex, resolveCanvasPaletteKey } from '../editor/palette-keyboard'

export function NodeSearchPalette({ nodes, onJump, onClose }: {
  nodes: readonly SearchableNode[]
  onJump(nodeId: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const composingRef = useRef(false)
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const resultsId = `canvas-node-search-results-${useId()}`
  const hits = useMemo(() => searchCanvasNodes(nodes, query), [nodes, query])
  const activeIndex = clampCanvasPaletteIndex(active, hits.length)
  const page = canvasPaletteWindow(activeIndex, hits.length)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => {
    previousActiveElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // StrictMode replays this effect before the next frame. Focusing inline
    // would make the second setup remember this input as the return target.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-node-search-trigger="true"]')) return
      onCloseRef.current()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [])
  useEffect(() => { setActive((current) => clampCanvasPaletteIndex(current, hits.length)) }, [hits.length])
  useEffect(() => {
    const hit = hits[activeIndex]
    if (hit) optionRefs.current[hit.id]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, hits])

  const close = () => {
    previousActiveElementRef.current?.focus()
    onClose()
  }
  const jump = (nodeId: string) => {
    onJump(nodeId)
    close()
  }

  return (
    <div
      ref={rootRef}
      className="canvas-node-search"
      role="dialog"
      aria-label="查找节点"
      onKeyDown={(event) => {
        // The palette owns keys even when native editing or a button handles
        // them. Never let an unhandled Delete reach the document behind it.
        event.stopPropagation()
        const key = resolveCanvasPaletteKey({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, composingRef.current)
        if (!key) return
        if (key === 'activate' && event.target !== inputRef.current) return
        event.preventDefault()
        if (key === 'close') close()
        else if (key === 'activate') {
          const hit = hits[activeIndex]
          if (hit) jump(hit.id)
        } else {
          setActive((current) => moveCanvasPaletteIndex(current, hits.length, key))
          inputRef.current?.focus()
        }
      }}
    >
      <label>
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={query.trim().length > 0 && hits.length > 0}
          aria-controls={hits.length > 0 ? resultsId : undefined}
          aria-activedescendant={hits[activeIndex] ? `${resultsId}-${activeIndex}` : undefined}
          autoComplete="off"
          value={query}
          maxLength={120}
          placeholder="按名称、编号、提示词或模型查找"
          aria-label="查找节点"
          onChange={(event) => { setQuery(event.target.value); setActive(0) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
        />
        <button type="button" onClick={close} aria-label="关闭查找">Esc</button>
      </label>
      {query.trim().length > 0 && (
        hits.length === 0
          ? <p className="canvas-node-search-empty" role="status">没有匹配的节点</p>
          : <ul id={resultsId} role="listbox" aria-label="查找结果">
              {hits.slice(page.start, page.end).map((hit, offset) => {
                const index = page.start + offset
                return (
                <li key={hit.id}>
                  <button
                    id={`${resultsId}-${index}`}
                    ref={(element) => { optionRefs.current[hit.id] = element }}
                    type="button"
                    tabIndex={-1}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-posinset={index + 1}
                    aria-setsize={hits.length}
                    className={index === activeIndex ? 'is-active' : ''}
                    onFocus={() => setActive(index)}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => jump(hit.id)}
                  >
                    <strong>{hit.title}</strong>
                    <small title={hit.detail}>{hit.detail}</small>
                  </button>
                </li>
              )})}
            </ul>
      )}
      {query.trim().length === 0 && <p className="canvas-node-search-empty">输入关键词查找当前画布，↑↓ 选择，Enter 定位</p>}
      {hits.length > 0 && <div className="canvas-palette-pagination">
        <span role="status" aria-live="polite">{page.start + 1}–{page.end} / 共 {hits.length} 个节点</span>
        <button type="button" aria-label="上一页查找结果" disabled={page.start === 0} onClick={() => setActive(moveCanvasPaletteIndex(activeIndex, hits.length, 'previous-page'))}>上一页</button>
        <button type="button" aria-label="下一页查找结果" disabled={page.end === hits.length} onClick={() => setActive(moveCanvasPaletteIndex(activeIndex, hits.length, 'next-page'))}>下一页</button>
      </div>}
    </div>
  )
}
