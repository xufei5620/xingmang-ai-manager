import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Building2, FileStack, Focus, House, Image, LayoutGrid } from 'lucide-react'
import { builtinNodeRegistry, hiddenLibraryNodeTypes } from '../domain/builtin-node-definitions'
import { builtinCanvasTemplates } from '../templates/builtin-templates'
import { canvasNodeKindAvailable, type CanvasCapabilityProfile } from '../host-capabilities'
import { searchExistingCanvasNodes } from '../editor/command-palette'
import { canvasPaletteWindow, clampCanvasPaletteIndex, moveCanvasPaletteIndex, resolveCanvasPaletteKey } from '../editor/palette-keyboard'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { NodeTypeIcon } from './NodeTypeIcon'

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
  onBatchImages?(): void
  onInteriorTask?(): void
  onExteriorTask?(): void
  onStoryboardTask?(): void
  batchImagesDisabledReason?: string
  /** Nodes and templates the host cannot run are not offered. Omitted, nothing is hidden for the host's sake. */
  capabilities?: CanvasCapabilityProfile
}

type QuickInsertEntry = {
  id: string
  group: '现有节点' | '节点' | '模板' | '画布命令'
  title: string
  description: string
  search: string
  icon: ReactNode
  disabledReason?: string
  run(): void
}

const hiddenNodeTypes = hiddenLibraryNodeTypes

export function QuickInsert({ open, anchor, hasNodes, hasSelection, canvasNodes, allowedNodeTypes, onAddNode, onLoadTemplate, onCommand, onLocateNode, onClose, onBatchImages, onInteriorTask, onExteriorTask, onStoryboardTask, batchImagesDisabledReason, capabilities }: QuickInsertProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const composingRef = useRef(false)
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const entries = useMemo<QuickInsertEntry[]>(() => {
    const allowed = allowedNodeTypes ? new Set(allowedNodeTypes) : null
    return [
    ...(!allowed && onStoryboardTask ? [{ id: 'command:storyboard-task', group: '画布命令' as const, title: '故事板', description: '按输入图片、剧情、四种画风与宫格配置创建故事板；核对后再运行', search: '故事板 叙事 剧情 分镜 白膜 手绘 火柴人 storyboard panels', icon: <LayoutGrid size={17} />, run: onStoryboardTask }] : []),
    ...(!allowed && onExteriorTask ? [{ id: 'command:exterior-task', group: '画布命令' as const, title: '室外创作', description: '建筑渲染、重绘、景观、立面、风格与店面任务；配置后再运行', search: '室外创作 建筑 渲染 重绘 景观 立面 风格 店面 exterior render landscape facade storefront', icon: <Building2 size={17} />, run: onExteriorTask }] : []),
    ...(!allowed && onInteriorTask ? [{ id: 'command:interior-task', group: '画布命令' as const, title: '室内一键渲染', description: '配置原图、空间与光线，再创建到画布；不会自动运行', search: '室内一键渲染 空间 灯光 天气 interior render', icon: <House size={17} />, run: onInteriorTask }] : []),
    ...(!allowed && onBatchImages ? [{ id: 'command:batch-images', group: '画布命令' as const, title: '关联图片工具', description: batchImagesDisabledReason ?? '按明确顺序将选中图片连接到拼图、对比或图层', disabledReason: batchImagesDisabledReason, search: '关联图片工具 拼图 对比 图层 多选 图片', icon: <LayoutGrid size={17} />, run: onBatchImages }] : []),
    ...builtinNodeRegistry.list()
      .filter((definition) => !hiddenNodeTypes.has(definition.type) && (!allowed || allowed.has(definition.type)) && (!capabilities || canvasNodeKindAvailable(definition.type, capabilities)))
      .map((definition) => ({
        id: `node:${definition.type}`,
        group: '节点' as const,
        title: definition.title,
        description: definition.description,
        search: `${definition.title} ${definition.description} ${definition.type}`.toLowerCase(),
        icon: <NodeTypeIcon type={definition.type} category={definition.category} />,
        run: () => onAddNode(definition.type),
      })),
    ...(!allowed ? builtinCanvasTemplates.filter((template) => !capabilities || template.requiredNodeTypes.every((type) => canvasNodeKindAvailable(type, capabilities))).map((template) => ({
      id: `template:${template.id}`,
      group: '模板' as const,
      title: template.name,
      description: template.description,
      search: `${template.name} ${template.description} ${template.tags.join(' ')}`.toLowerCase(),
      icon: <FileStack size={17} />,
      run: () => onLoadTemplate(template.id),
    })) : []),
    ...(!allowed && hasNodes ? [{
      id: 'command:fit-all', group: '画布命令' as const, title: '适配全部内容', description: '将工作流居中到可读视图',
      search: '适配全部内容 fit view zoom', icon: <LayoutGrid size={17} />, run: () => onCommand('fit-all'),
    }] : []),
    ...(!allowed && hasSelection ? [{
      id: 'command:fit-selection', group: '画布命令' as const, title: '聚焦选中节点', description: '只适配当前选中的内容',
      search: '聚焦选中节点 fit selection focus', icon: <Focus size={17} />, run: () => onCommand('fit-selection'),
    }] : []),
    ...(!allowed ? [{
      id: 'command:open-assets', group: '画布命令' as const, title: '打开素材库', description: '浏览和导入本地图片、视频',
      search: '打开素材库 assets image video', icon: <Image size={17} />, run: () => onCommand('open-assets'),
    }] : []),
  ]
  }, [allowedNodeTypes, capabilities, hasNodes, hasSelection, onAddNode, onCommand, onLoadTemplate, onBatchImages, onInteriorTask, onExteriorTask, onStoryboardTask, batchImagesDisabledReason])

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
      icon: <Focus size={17} />,
      run: () => onLocateNode(node.id),
    }))
    return [...existing, ...base]
  }, [allowedNodeTypes, canvasNodes, entries, onLocateNode, query])
  const active = clampCanvasPaletteIndex(activeIndex, filtered.length)
  const page = canvasPaletteWindow(active, filtered.length)
  const existingCount = filtered.filter((entry) => entry.group === '现有节点').length

  useEffect(() => {
    if (!open) return
    previousActiveElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setActiveIndex(0)
    composingRef.current = false
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
    setActiveIndex((current) => clampCanvasPaletteIndex(current, filtered.length))
  }, [filtered.length])

  useEffect(() => {
    const entry = filtered[active]
    if (!entry) return
    optionRefs.current[entry.id]?.scrollIntoView({ block: 'nearest' })
  }, [active, filtered])

  if (!open) return null

  const close = () => {
    previousActiveElementRef.current?.focus()
    onClose()
  }

  const activate = (entry: QuickInsertEntry | undefined) => {
    if (!entry || entry.disabledReason) return
    entry.run()
    close()
  }

  return (
    <div
      ref={rootRef}
      className="quick-insert"
      style={{ left: anchor.x, top: anchor.y, maxHeight: `min(460px, calc(100% - ${Math.max(0, anchor.y) + 12}px))` }}
      role="dialog"
      aria-label="快速创建"
      onKeyDown={(event) => {
        event.stopPropagation()
        const key = resolveCanvasPaletteKey({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, composingRef.current)
        if (!key) return
        if (key === 'activate' && event.target !== inputRef.current) return
        event.preventDefault()
        if (key === 'close') close()
        else if (key === 'activate') activate(filtered[active])
        else {
          setActiveIndex((index) => moveCanvasPaletteIndex(index, filtered.length, key))
          inputRef.current?.focus()
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
          aria-activedescendant={filtered[active] ? `quick-insert-${filtered[active].id.replace(/[^a-z0-9-]/gi, '-')}` : undefined}
          autoComplete="off"
          maxLength={120}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          placeholder={allowedNodeTypes ? '搜索可连接节点' : '搜索现有节点、新节点或命令'}
          aria-label={allowedNodeTypes ? '搜索可连接节点' : '搜索现有节点、新节点或命令'}
        />
        <button type="button" aria-label="关闭快速创建" onClick={close}>Esc</button>
      </label>
      <div id="quick-insert-results" className="quick-insert-results" role="listbox" aria-label="快速创建结果">
        {filtered.slice(page.start, page.end).map((entry, offset) => {
          const index = page.start + offset
          const showGroup = offset === 0 || filtered[index - 1]?.group !== entry.group
          return (
            <div key={entry.id} className="quick-insert-entry-wrap">
              {showGroup && <div className="quick-insert-group" role="presentation">{entry.group}</div>}
              <button
                id={`quick-insert-${entry.id.replace(/[^a-z0-9-]/gi, '-')}`}
                ref={(element) => { optionRefs.current[entry.id] = element }}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={index === active}
                aria-posinset={index + 1}
                aria-setsize={filtered.length}
                aria-disabled={Boolean(entry.disabledReason)}
                className="quick-insert-entry"
                title={entry.description}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => activate(entry)}
              >
                <span className="quick-insert-icon" aria-hidden="true">{entry.icon}</span>
                <span><strong>{entry.title}</strong><small>{entry.description}</small></span>
              </button>
            </div>
          )
        })}
        {filtered.length === 0 && <p className="quick-insert-empty" role="status">没有匹配的内容</p>}
      </div>
      {filtered.length > 0 && <div className="canvas-palette-pagination">
        <span role="status" aria-live="polite">{page.start + 1}–{page.end} / 共 {filtered.length} 项{existingCount > 0 ? ` · 现有节点 ${existingCount}` : ''}</span>
        <button type="button" aria-label="上一页快速创建结果" disabled={page.start === 0} onClick={() => setActiveIndex(moveCanvasPaletteIndex(active, filtered.length, 'previous-page'))}>上一页</button>
        <button type="button" aria-label="下一页快速创建结果" disabled={page.end === filtered.length} onClick={() => setActiveIndex(moveCanvasPaletteIndex(active, filtered.length, 'next-page'))}>下一页</button>
      </div>}
      <footer><span>↑↓ / PgUp PgDn 选择</span><span>Enter 确认</span></footer>
    </div>
  )
}
