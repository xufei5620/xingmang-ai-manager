import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, FileStack, Focus, Image, LayoutGrid } from 'lucide-react'
import { builtinNodeRegistry, hiddenLibraryNodeTypes } from '../domain/builtin-node-definitions'
import { builtinCanvasTemplates } from '../templates/builtin-templates'
import { searchExistingCanvasNodes } from '../editor/command-palette'
import type { CanvasNode } from '../nodes/WorkflowNodes'

export type QuickInsertCommand = 'fit-all' | 'fit-selection' | 'open-assets'

interface QuickInsertProps {
  open: boolean
  anchor: { x: number; y: number }
  hasNodes: boolean
  hasSelection: boolean
  canvasNodes: readonly CanvasNode[]
  allowedNodeTypes?: readonly string[]
  onAddNode(type: string): void
  onLoadTemplate(templateId: string): void
  onCommand(command: QuickInsertCommand): void
  onLocateNode(nodeId: string): void
  onClose(): void
}

type QuickInsertEntry = {
  id: string
  group: '现有节点' | '节点' | '模板' | '画布命令'
  title: string
  description: string
  search: string
  icon: typeof Box
  run(): void
}

const hiddenNodeTypes = hiddenLibraryNodeTypes

export function QuickInsert({ open, anchor, hasNodes, hasSelection, canvasNodes, allowedNodeTypes, onAddNode, onLoadTemplate, onCommand, onLocateNode, onClose }: QuickInsertProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const entries = useMemo<QuickInsertEntry[]>(() => {
    const allowed = allowedNodeTypes ? new Set(allowedNodeTypes) : null
    return [
    ...builtinNodeRegistry.list()
      .filter((definition) => !hiddenNodeTypes.has(definition.type) && (!allowed || allowed.has(definition.type)))
      .map((definition) => ({
        id: `node:${definition.type}`,
        group: '节点' as const,
        title: definition.title,
        description: definition.description,
        search: `${definition.title} ${definition.description} ${definition.type}`.toLowerCase(),
        icon: Box,
        run: () => onAddNode(definition.type),
      })),
    ...(!allowed ? builtinCanvasTemplates.map((template) => ({
      id: `template:${template.id}`,
      group: '模板' as const,
      title: template.name,
      description: template.description,
      search: `${template.name} ${template.description} ${template.tags.join(' ')}`.toLowerCase(),
      icon: FileStack,
      run: () => onLoadTemplate(template.id),
    })) : []),
    ...(!allowed && hasNodes ? [{
      id: 'command:fit-all', group: '画布命令' as const, title: '适配全部内容', description: '将工作流居中到可读视图',
      search: '适配全部内容 fit view zoom', icon: LayoutGrid, run: () => onCommand('fit-all'),
    }] : []),
    ...(!allowed && hasSelection ? [{
      id: 'command:fit-selection', group: '画布命令' as const, title: '聚焦选中节点', description: '只适配当前选中的内容',
      search: '聚焦选中节点 fit selection focus', icon: Focus, run: () => onCommand('fit-selection'),
    }] : []),
    ...(!allowed ? [{
      id: 'command:open-assets', group: '画布命令' as const, title: '打开素材库', description: '浏览和导入本地图片、视频',
      search: '打开素材库 assets image video', icon: Image, run: () => onCommand('open-assets'),
    }] : []),
  ]
  }, [allowedNodeTypes, hasNodes, hasSelection, onAddNode, onCommand, onLoadTemplate])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const base = normalized ? entries.filter((entry) => entry.search.includes(normalized)) : entries
    if (!normalized || allowedNodeTypes) return base
    const existing: QuickInsertEntry[] = searchExistingCanvasNodes(canvasNodes, normalized).map((node) => ({
      id: `existing:${node.id}`,
      group: '现有节点',
      title: node.title,
      description: node.description,
      search: node.search,
      icon: Focus,
      run: () => onLocateNode(node.id),
    }))
    return [...existing, ...base]
  }, [allowedNodeTypes, canvasNodes, entries, onLocateNode, query])

  useEffect(() => {
    if (!open) return
    previousActiveElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setActiveIndex(0)
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-quick-insert-trigger="true"]')) return
      onCloseRef.current()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open])

  useEffect(() => {
    if (activeIndex < filtered.length) return
    setActiveIndex(Math.max(0, filtered.length - 1))
  }, [activeIndex, filtered.length])

  useEffect(() => {
    const entry = filtered[activeIndex]
    if (!entry) return
    optionRefs.current[entry.id]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, filtered])

  if (!open) return null

  const activate = (entry: QuickInsertEntry | undefined) => {
    if (!entry) return
    entry.run()
    onClose()
  }

  return (
    <div
      ref={rootRef}
      className="quick-insert"
      style={{ left: anchor.x, top: anchor.y }}
      role="dialog"
      aria-label="快速创建"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          const previous = previousActiveElementRef.current
          previous?.focus()
          onClose()
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveIndex((index) => filtered.length ? (index + 1) % filtered.length : 0)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          activate(filtered[activeIndex])
        }
      }}
    >
      <label className="quick-insert-search">
        <span aria-hidden="true">+</span>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-insert-results"
          aria-activedescendant={filtered[activeIndex] ? `quick-insert-${filtered[activeIndex].id.replace(/[^a-z0-9-]/gi, '-')}` : undefined}
          autoComplete="off"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
          placeholder={allowedNodeTypes ? '搜索可连接节点' : '搜索现有节点、新节点或命令'}
          aria-label={allowedNodeTypes ? '搜索可连接节点' : '搜索现有节点、新节点或命令'}
        />
        <kbd>Esc</kbd>
      </label>
      <div id="quick-insert-results" className="quick-insert-results" role="listbox" aria-label="快速创建结果">
        {filtered.map((entry, index) => {
          const Icon = entry.icon
          const showGroup = index === 0 || filtered[index - 1]?.group !== entry.group
          return (
            <div key={entry.id} className="quick-insert-entry-wrap">
              {showGroup && <div className="quick-insert-group" role="presentation">{entry.group}</div>}
              <button
                id={`quick-insert-${entry.id.replace(/[^a-z0-9-]/gi, '-')}`}
                ref={(element) => { optionRefs.current[entry.id] = element }}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className="quick-insert-entry"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => activate(entry)}
              >
                <span className="quick-insert-icon"><Icon size={15} /></span>
                <span><strong>{entry.title}</strong><small>{entry.description}</small></span>
              </button>
            </div>
          )
        })}
        {filtered.length === 0 && <p className="quick-insert-empty">没有匹配的内容</p>}
      </div>
      <footer><span>↑↓ 选择</span><span>Enter 确认</span><span>节点会在当前位置创建</span></footer>
    </div>
  )
}
