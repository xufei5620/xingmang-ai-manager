import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { searchCanvasNodes, type SearchableNode } from '../editor/node-search'

export function NodeSearchPalette({ nodes, onJump, onClose }: {
  nodes: readonly SearchableNode[]
  onJump(nodeId: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const hits = useMemo(() => searchCanvasNodes(nodes, query), [nodes, query])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setActive(0) }, [query])

  return (
    <div className="canvas-node-search" role="dialog" aria-label="查找节点">
      <label>
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          maxLength={120}
          placeholder="按名称、提示词或模型查找"
          aria-label="查找节点"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => Math.min(current + 1, hits.length - 1)); return }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => Math.max(current - 1, 0)); return }
            if (event.key === 'Enter' && hits[active]) { event.preventDefault(); onJump(hits[active].id); onClose() }
          }}
        />
        <button type="button" onClick={onClose} aria-label="关闭查找">Esc</button>
      </label>
      {query.trim().length > 0 && (
        hits.length === 0
          ? <p className="canvas-node-search-empty">没有匹配的节点</p>
          : <ul role="listbox" aria-label="查找结果">
              {hits.map((hit, index) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={index === active ? 'is-active' : ''}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => { onJump(hit.id); onClose() }}
                  >
                    <strong>{hit.title}</strong>
                    <small title={hit.detail}>{hit.detail}</small>
                  </button>
                </li>
              ))}
            </ul>
      )}
    </div>
  )
}
