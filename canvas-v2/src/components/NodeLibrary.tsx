import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Box, Check, ChevronLeft, ChevronRight, Clapperboard, FileStack, GitBranch, Image, Layers3, Library, MessageSquareText, MoreHorizontal, Music2, Pencil, Plus, Search, X } from 'lucide-react'
import { builtinNodeRegistry, hiddenLibraryNodeTypes } from '../domain/builtin-node-definitions'
import type { NodeCategory } from '../domain/node-definition'
import type { CanvasAssetPage, CanvasPromptPreset } from '../host'
import { canvasNodeKindAvailable, type CanvasCapabilityProfile } from '../host-capabilities'
import { promptPresetMime, searchPromptPresets } from '../library/prompt-presets'
import { maximumPromptPresetLength, promptPresetGroups, type PromptPresetUpdateInput } from '../library/prompt-preset-contract'
import { builtinCanvasTemplates } from '../templates/builtin-templates'
import { SafeImage, VideoCoverImage, canvasAssetIsPreviewable } from './MediaPreview'
import { savePromptPresetDraft, type PromptPresetDraft } from './prompt-preset-edit'
import { PromptPresetMetadataFields } from './PromptPresetMetadataFields'
import { NodeTypeIcon } from './NodeTypeIcon'
import '../theme/editor-library.css'

interface NodeLibraryProps {
  readOnly?: boolean
  resources?: ReactNode
  resourceCount?: number
  onAdd(type: string): void
  onAddPrompt(prompt: string): void
  onAddAsset(assetId: string): void
  onDeletePromptPreset(id: string, expectedVersion?: number): void | Promise<void>
  onUpdatePromptPreset?(id: string, patch: Omit<PromptPresetUpdateInput, 'id'>): void | Promise<void>
  onRefreshPromptPresets?(): Promise<void>
  onLoadTemplate(templateId: string): void
  onOpenAssets(): void
  onAssetMenu(assetId: string): void
  assets: CanvasAssetPage
  userPromptPresets: readonly CanvasPromptPreset[]
  collapsed?: boolean
  onCollapsedChange?(collapsed: boolean): void
  /** Nodes and templates the host cannot run are not offered. Omitted, nothing is hidden for the host's sake. */
  capabilities?: CanvasCapabilityProfile
}

type LibraryView = 'resources' | 'nodes' | 'prompts' | 'templates' | 'assets'

const libraryViews: ReadonlyArray<{ id: LibraryView; label: string; icon: typeof Box }> = [
  { id: 'resources', label: '资源', icon: Layers3 },
  { id: 'nodes', label: '节点', icon: Box },
  { id: 'prompts', label: '提示词', icon: MessageSquareText },
  { id: 'templates', label: '模板', icon: FileStack },
  { id: 'assets', label: '素材', icon: Image },
]

const categoryOrder: readonly NodeCategory[] = ['input', 'generation', 'transform', 'flow', 'output', 'structural', 'drama']
const categoryLabel: Record<NodeCategory, string> = {
  drama: '漫剧',
  input: '输入与素材',
  generation: 'AI 生成',
  transform: '媒体处理',
  flow: '工作流',
  output: '交付输出',
  structural: '画布组织',
}

export function NodeLibrary({ readOnly, resources, resourceCount = 0, onAdd, onAddPrompt, onAddAsset, onDeletePromptPreset, onUpdatePromptPreset, onRefreshPromptPresets, onLoadTemplate, onOpenAssets, onAssetMenu, assets, userPromptPresets, collapsed, onCollapsedChange, capabilities }: NodeLibraryProps) {
  const [view, setView] = useState<LibraryView>(resources ? 'resources' : 'nodes')
  const [query, setQuery] = useState('')
  const [localExpanded, setLocalExpanded] = useState(true)
  const [editingPreset, setEditingPreset] = useState<PromptPresetDraft | null>(null)
  const [presetSaving, setPresetSaving] = useState(false)
  const [presetError, setPresetError] = useState<string | null>(null)
  const [presetRefreshed, setPresetRefreshed] = useState(false)
  const presetSavingRef = useRef(false)
  const [addNotice, setAddNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!addNotice) return
    const timer = window.setTimeout(() => setAddNotice(null), 2400)
    return () => window.clearTimeout(timer)
  }, [addNotice])
  const submitPreset = async (event: FormEvent) => {
    event.preventDefault()
    if (!editingPreset || !onUpdatePromptPreset || presetSavingRef.current) return
    const draft = editingPreset
    presetSavingRef.current = true
    setPresetSaving(true)
    setPresetError(null); setPresetRefreshed(false)
    const result = await savePromptPresetDraft(draft, onUpdatePromptPreset)
    presetSavingRef.current = false
    setPresetSaving(false)
    if (!result.ok) { setPresetError(result.message); return }
    setEditingPreset((current) => current?.id === draft.id ? null : current); setQuery('')
  }
  const expanded = collapsed === undefined ? localExpanded : !collapsed
  const setExpanded = (next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(expanded) : next
    if (onCollapsedChange) onCollapsedChange(!resolved)
    else setLocalExpanded(resolved)
  }
  const normalized = query.trim().toLowerCase()
  const definitions = useMemo(() => builtinNodeRegistry.list().filter((definition) => (
    !hiddenLibraryNodeTypes.has(definition.type)
    && (!capabilities || canvasNodeKindAvailable(definition.type, capabilities))
    && (!normalized || `${definition.title} ${definition.description} ${definition.type}`.toLowerCase().includes(normalized))
  )), [capabilities, normalized])
  const promptPresets = useMemo(() => searchPromptPresets(query), [query])
  const userPresets = useMemo(() => userPromptPresets.filter((preset) => (
    !normalized || `${preset.name} ${preset.group ?? ''} ${preset.description ?? ''} ${preset.tags.join(' ')}`.toLowerCase().includes(normalized)
  )), [normalized, userPromptPresets])
  const templates = useMemo(() => builtinCanvasTemplates.filter((template) => (
    (!capabilities || template.requiredNodeTypes.every((type) => canvasNodeKindAvailable(type, capabilities)))
    && (!normalized || `${template.name} ${template.description} ${template.tags.join(' ')}`.toLowerCase().includes(normalized))
  )), [capabilities, normalized])
  const recentAssets = assets.items.slice(0, 8)

  const counts: Record<LibraryView, number> = {
    resources: resourceCount,
    nodes: definitions.length,
    prompts: promptPresets.length + userPresets.length,
    templates: templates.length,
    assets: assets.total,
  }

  if (readOnly) return <aside className="node-library is-expanded" aria-label="只读工程资源"><div className="library-panel"><h3>项目资源 · 只读</h3>{resources}</div></aside>

  return (
    <aside className={`node-library${expanded ? ' is-expanded' : ' is-collapsed'}`} aria-label="创作内容库">
      <nav className="library-rail" aria-label="创作库类型">
        {libraryViews.filter((entry) => entry.id !== 'resources' || resources).map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.id}
              type="button"
              className={view === entry.id && expanded ? 'is-active' : ''}
              aria-pressed={view === entry.id && expanded}
              aria-controls="node-library-drawer"
              aria-expanded={view === entry.id ? expanded : false}
              title={entry.label}
              onClick={() => {
                if (view === entry.id && expanded) setExpanded(false)
                else { setView(entry.id); setQuery(''); setExpanded(true) }
              }}
            >
              <Icon size={17} /><span>{entry.label}</span>
            </button>
          )
        })}
        <button type="button" className="library-rail-toggle" title={expanded ? '收起创作库' : '展开创作库'} aria-label={expanded ? '收起创作库' : '展开创作库'} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
        </button>
      </nav>
      {expanded && <div id="node-library-drawer" className="library-drawer">
        {view === 'resources' ? resources : <>
        <header>
          <span className="library-title"><Library size={15} /><strong>{libraryViews.find((entry) => entry.id === view)?.label ?? '创作库'}</strong></span>
          <span className="library-result-count">{counts[view]}</span>
        </header>
        {view !== 'assets' && (
          <div className="node-library-search">
            <Search size={15} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${libraryViews.find((entry) => entry.id === view)?.label ?? ''}`} aria-label={`搜索${libraryViews.find((entry) => entry.id === view)?.label ?? ''}`} />
            {query && <button type="button" aria-label="清空创作库搜索" onClick={() => setQuery('')}><X size={13} /></button>}
          </div>
        )}
        <p className="library-usage-hint">{view === 'templates' ? '选择模板，预览后添加到画布' : view === 'assets' ? '点击素材添加，也可以拖到画布' : '点击添加，或拖到画布任意位置'}</p>
        <div className="node-library-scroll">
        {view === 'templates' && <section className="template-section">
          <div className="node-library-section-title">工作流模板</div>
          {templates.map((template) => (
            <button key={template.id} type="button" className="template-row" onClick={() => onLoadTemplate(template.id)}>
              <span className="template-swatch" style={{ backgroundColor: template.thumbnail.value }}><GitBranch size={17} /></span>
              <span><strong>{template.name}</strong><small>{template.description}</small><em>{template.workflow.nodes.length} 个节点</em></span>
            </button>
          ))}
          {templates.length === 0 && <p className="library-empty">没有匹配的工作流模板</p>}
        </section>}
        {view === 'prompts' && <section className="prompt-preset-section">
          {presetError && !editingPreset && <p className="library-edit-error" role="alert">{presetError}</p>}
          {userPresets.length > 0 && <>
            <div className="node-library-section-title">我的预设{onRefreshPromptPresets && <button type="button" disabled={presetSaving} onClick={() => void onRefreshPromptPresets().catch((error: unknown) => setPresetError(error instanceof Error ? error.message : '刷新未完成'))}>刷新</button>}</div>
            {userPresets.map((preset) => (
              editingPreset?.id === preset.id
                ? <form key={preset.id} className="user-prompt-edit" onSubmit={(event) => void submitPreset(event)} aria-busy={presetSaving}>
                    <input value={editingPreset.name} disabled={presetSaving} maxLength={capabilities?.promptPresets.nameMaxLength ?? 160} aria-label="预设名称" onChange={(event) => setEditingPreset((current) => current ? { ...current, name: event.target.value } : current)} />
                    {(!capabilities || capabilities.features.promptPresetGroups) && <PromptPresetMetadataFields group={editingPreset.group ?? ''} description={editingPreset.description ?? ''} groups={promptPresetGroups(userPromptPresets)} disabled={presetSaving} onGroup={(group) => setEditingPreset((current) => current ? { ...current, group } : current)} onDescription={(description) => setEditingPreset((current) => current ? { ...current, description } : current)} />}
                    <textarea value={editingPreset.prompt} disabled={presetSaving} maxLength={maximumPromptPresetLength} aria-label="预设内容" onChange={(event) => setEditingPreset((current) => current ? { ...current, prompt: event.target.value } : current)} />
                    {presetError && <p className="library-edit-error" role="alert">{presetError}</p>}{presetError && onRefreshPromptPresets && <button type="button" disabled={presetSaving} onClick={() => void onRefreshPromptPresets().then(() => setPresetRefreshed(true)).catch((error: unknown) => setPresetError(error instanceof Error ? error.message : '刷新未完成'))}>读取最新版本</button>}{presetError && presetRefreshed && <button type="button" onClick={() => { setEditingPreset((current) => current ? { ...current, expectedVersion: preset.version ?? 1 } : current); setPresetError(null); setPresetRefreshed(false) }}>保留输入，按已读取版本继续修改</button>}
                    <span><button type="submit" disabled={presetSaving || !editingPreset.name.trim() || !editingPreset.prompt.trim()} title="保存预设" aria-label="保存预设"><Check size={13} />{presetSaving ? '保存中…' : '保存'}</button><button type="button" title="取消编辑" aria-label="取消编辑" disabled={presetSaving} onClick={() => setEditingPreset(null)}>取消</button></span>
                  </form>
                : <div
                    key={preset.id}
                    className="prompt-preset-row user-prompt-preset-row"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(promptPresetMime, preset.prompt)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <button type="button" onClick={() => { onAddPrompt(preset.prompt); setAddNotice('已添加提示词节点') }}><span><strong>{preset.name}</strong><small>{[preset.group || '未分组', preset.description || preset.tags.join(' · ') || preset.prompt].join(' · ')}</small></span></button>
                    {onUpdatePromptPreset && <button type="button" title="编辑预设" aria-label={`编辑预设 ${preset.name}`} disabled={presetSaving} onClick={() => { setPresetError(null); setPresetRefreshed(false); setEditingPreset({ id: preset.id, name: preset.name, prompt: preset.prompt, group: preset.group ?? '', description: preset.description ?? '', expectedVersion: preset.version ?? 1 }) }}><Pencil size={12} /></button>}
                    <button type="button" className="prompt-preset-delete" title="删除预设" aria-label={`删除预设 ${preset.name}`} onClick={() => { if (window.confirm(`删除“${preset.name}”？已插入的正文不会改变。`)) void Promise.resolve(onDeletePromptPreset(preset.id, preset.version ?? 1)).catch((error: unknown) => setPresetError(error instanceof Error ? error.message : '删除未确认，请刷新目录核对。')) }}>×</button>
                  </div>
            ))}
          </>}
          <div className="node-library-section-title">星芒提示词预设</div>
          {promptPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="prompt-preset-row"
              onClick={() => { onAddPrompt(preset.prompt); setAddNotice('已添加提示词节点') }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(promptPresetMime, preset.prompt)
                event.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <span><strong>{preset.title}</strong><small>{preset.description}</small></span>
              <Plus size={14} aria-hidden="true" />
            </button>
          ))}
          {promptPresets.length === 0 && userPresets.length === 0 && <p className="library-empty">没有匹配的提示词</p>}
        </section>}
        {view === 'assets' && <section className="library-assets-section">
          <div className="library-assets-heading"><span>素材速取 · {recentAssets.length} 项</span><button type="button" onClick={onOpenAssets}>查看全部</button></div>
          <div className="library-asset-grid">
            {recentAssets.map((asset) => {
              const name = asset.displayName || asset.fileName
              const available = !asset.deletedAt && canvasAssetIsPreviewable(asset)
              return (
                <article
                  key={asset.assetId}
                  className="library-asset-item"
                  title={`${name}\n${available ? '点击添加到画布，右键打开素材操作' : '此素材不可用，请在素材管理中检查'}`}
                  onContextMenu={(event) => { event.preventDefault(); onAssetMenu(asset.assetId) }}
                  draggable={available}
                  onDragStart={(event) => {
                    if (!available) { event.preventDefault(); return }
                    event.dataTransfer.setData('application/x-xingmang-asset-id', asset.assetId)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <button type="button" className="library-asset-preview" aria-label={`添加素材到画布：${name}`} disabled={!available} onClick={() => { onAddAsset(asset.assetId); setAddNotice(`已添加「${name}」`) }}>
                    {/* This strip never plays anything, so a derived still is all
                        it ever needed; it used to mount one video element per
                        tile purely to paint a frame. */}
                    {asset.mediaType === 'audio'
                      ? <span className="asset-video-placeholder"><Music2 size={22} /><small>音频</small></span>
                      : asset.mediaType === 'video'
                        ? <VideoCoverImage
                            thumbnailUrl={asset.thumbnailUrl}
                            videoUrl={asset.localUrl}
                            alt={name}
                            loading="lazy"
                            fallbackLabel="视频"
                          />
                        : <SafeImage
                            src={asset.thumbnailUrl}
                            fallbackSrc={asset.localUrl}
                            alt={name}
                            loading="lazy"
                          />}
                    <span className="library-asset-add" aria-hidden="true">{available ? <Plus size={15} /> : <X size={15} />}</span>
                    <span className="library-asset-kind">{asset.mediaType === 'video' ? '视频' : asset.mediaType === 'audio' ? '音频' : '图片'}</span>
                  </button>
                  <footer>
                    <span title={name}>{name}</span>
                    <button type="button" title="素材操作" aria-label={`打开素材操作：${name}`} onClick={() => onAssetMenu(asset.assetId)}><MoreHorizontal size={12} /></button>
                  </footer>
                </article>
              )
            })}
          </div>
          {recentAssets.length === 0 && <p className="library-empty">还没有本地素材</p>}
          <button type="button" className="library-assets-open" onClick={onOpenAssets}>打开素材管理</button>
        </section>}
        {view === 'nodes' && definitions.length === 0 && <p className="library-empty" role="status">没有匹配的节点，试试其他关键词</p>}
        {view === 'nodes' && categoryOrder.map((category) => {
          const entries = definitions.filter((definition) => definition.category === category)
          if (entries.length === 0) return null
          return (
            <section key={category}>
              <div className="node-library-section-title"><span>{categoryLabel[category]}</span><small>{entries.length}</small></div>
              {category === 'drama' && (
                <button type="button" className="template-row" onClick={() => onLoadTemplate('xingmang-drama-script-parse')}>
                  <span className="template-swatch" style={{ backgroundColor: '#8B5CF6' }}><Clapperboard size={17} /></span>
                  <span><strong>从剧本开始</strong><small>粘贴剧本 → 解析四表 → 确认后自动铺角色、场景、分镜</small></span>
                </button>
              )}
              <div className="node-library-grid">
                {entries.map((definition) => (
                  <button
                    key={definition.type}
                    type="button"
                    className={`node-library-item node-library-${definition.category}`}
                    title={definition.description}
                    onClick={() => { onAdd(definition.type); setAddNotice(`已添加「${definition.title}」`) }}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-xingmang-node', definition.type)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <span className="node-library-icon" aria-hidden="true"><NodeTypeIcon type={definition.type} category={definition.category} /></span>
                    <span><strong>{definition.title}</strong><small>{definition.description}</small></span>
                    <Plus className="library-node-add" size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>
          )
        })}
        </div>
        {addNotice && <p className="library-add-notice" role="status"><Check size={13} />{addNotice}</p>}
        </>}
      </div>}
    </aside>
  )
}
