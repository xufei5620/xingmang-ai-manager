import { useMemo, useState } from 'react'
import { Box, Check, ChevronLeft, ChevronRight, FileStack, Film, Image, Library, MessageSquareText, MoreHorizontal, Music2, Pencil, Plus, X } from 'lucide-react'
import { builtinNodeRegistry, hiddenLibraryNodeTypes } from '../domain/builtin-node-definitions'
import type { NodeCategory } from '../domain/node-definition'
import type { CanvasAssetPage, CanvasPromptPreset } from '../host'
import { promptPresetMime, searchPromptPresets } from '../library/prompt-presets'
import { builtinCanvasTemplates } from '../templates/builtin-templates'
import { SafeImage, VideoCoverImage, ViewportVideo, isLocalCanvasAssetUrl } from './MediaPreview'
import { mediaAssetAspectRatio } from '../library/media-assets'

interface NodeLibraryProps {
  onAdd(type: string): void
  onAddPrompt(prompt: string): void
  onAddAsset(assetId: string): void
  onDeletePromptPreset(id: string): void
  onUpdatePromptPreset?(id: string, patch: { name: string; prompt: string }): void | Promise<void>
  onLoadTemplate(templateId: string): void
  onOpenAssets(): void
  onAssetMenu(assetId: string): void
  assets: CanvasAssetPage
  userPromptPresets: readonly CanvasPromptPreset[]
  collapsed?: boolean
  onCollapsedChange?(collapsed: boolean): void
}

type LibraryView = 'nodes' | 'prompts' | 'templates' | 'assets'

const libraryViews: ReadonlyArray<{ id: LibraryView; label: string; icon: typeof Box }> = [
  { id: 'nodes', label: '节点', icon: Box },
  { id: 'prompts', label: '提示词', icon: MessageSquareText },
  { id: 'templates', label: '模板', icon: FileStack },
  { id: 'assets', label: '素材', icon: Image },
]

const categoryOrder: readonly NodeCategory[] = ['drama', 'input', 'generation', 'transform', 'flow', 'output', 'structural']
const categoryLabel: Record<NodeCategory, string> = {
  drama: '漫剧',
  input: '输入',
  generation: '生成',
  transform: '处理',
  flow: '流程',
  output: '输出',
  structural: '组织',
}

export function NodeLibrary({ onAdd, onAddPrompt, onAddAsset, onDeletePromptPreset, onUpdatePromptPreset, onLoadTemplate, onOpenAssets, onAssetMenu, assets, userPromptPresets, collapsed, onCollapsedChange }: NodeLibraryProps) {
  const [view, setView] = useState<LibraryView>('nodes')
  const [query, setQuery] = useState('')
  const [localExpanded, setLocalExpanded] = useState(true)
  const [editingPreset, setEditingPreset] = useState<{ id: string; name: string; prompt: string } | null>(null)
  const expanded = collapsed === undefined ? localExpanded : !collapsed
  const setExpanded = (next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(expanded) : next
    if (onCollapsedChange) onCollapsedChange(!resolved)
    else setLocalExpanded(resolved)
  }
  const normalized = query.trim().toLowerCase()
  const definitions = useMemo(() => builtinNodeRegistry.list().filter((definition) => (
    !hiddenLibraryNodeTypes.has(definition.type)
    && (!normalized || `${definition.title} ${definition.description} ${definition.type}`.toLowerCase().includes(normalized))
  )), [normalized])
  const promptPresets = useMemo(() => searchPromptPresets(query), [query])
  const userPresets = useMemo(() => userPromptPresets.filter((preset) => (
    !normalized || `${preset.name} ${preset.prompt} ${preset.tags.join(' ')}`.toLowerCase().includes(normalized)
  )), [normalized, userPromptPresets])
  const templates = useMemo(() => builtinCanvasTemplates.filter((template) => (
    !normalized || `${template.name} ${template.description} ${template.tags.join(' ')}`.toLowerCase().includes(normalized)
  )), [normalized])
  const recentAssets = assets.items.slice(0, 8)

  const counts: Record<LibraryView, number> = {
    nodes: definitions.length,
    prompts: promptPresets.length + userPresets.length,
    templates: templates.length,
    assets: assets.total,
  }

  return (
    <aside className={`node-library${expanded ? ' is-expanded' : ' is-collapsed'}`} aria-label="创作内容库">
      <nav className="library-rail" aria-label="创作库类型">
        {libraryViews.map((entry) => {
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
        <header>
          <span className="library-title"><Library size={15} /><strong>{libraryViews.find((entry) => entry.id === view)?.label ?? '创作库'}</strong></span>
          <span>{counts[view]}</span>
        </header>
        {view !== 'assets' && (
          <div className="node-library-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${libraryViews.find((entry) => entry.id === view)?.label ?? ''}`} aria-label={`搜索${libraryViews.find((entry) => entry.id === view)?.label ?? ''}`} />
          </div>
        )}
        <div className="node-library-scroll">
        {view === 'templates' && <section className="template-section">
          <div className="node-library-section-title">工作流模板</div>
          {templates.map((template) => (
            <button key={template.id} type="button" className="template-row" onClick={() => onLoadTemplate(template.id)}>
              <span className="template-swatch" style={{ backgroundColor: template.thumbnail.value }} />
              <span><strong>{template.name}</strong><small>{template.description}</small></span>
            </button>
          ))}
          {templates.length === 0 && <p className="library-empty">没有匹配的工作流模板</p>}
        </section>}
        {view === 'prompts' && <section className="prompt-preset-section">
          {userPresets.length > 0 && <>
            <div className="node-library-section-title">我的预设</div>
            {userPresets.map((preset) => (
              editingPreset?.id === preset.id
                ? <form key={preset.id} className="user-prompt-edit" onSubmit={(event) => { event.preventDefault(); if (editingPreset.name.trim() && editingPreset.prompt.trim()) { void onUpdatePromptPreset?.(preset.id, { name: editingPreset.name.trim(), prompt: editingPreset.prompt.trim() }); setEditingPreset(null) } }}>
                    <input value={editingPreset.name} maxLength={80} aria-label="预设名称" onChange={(event) => setEditingPreset((current) => current ? { ...current, name: event.target.value } : current)} />
                    <textarea value={editingPreset.prompt} maxLength={8_000} aria-label="预设内容" onChange={(event) => setEditingPreset((current) => current ? { ...current, prompt: event.target.value } : current)} />
                    <span><button type="submit" title="保存预设" aria-label="保存预设"><Check size={13} /></button><button type="button" title="取消编辑" aria-label="取消编辑" onClick={() => setEditingPreset(null)}><X size={13} /></button></span>
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
                    <button type="button" onClick={() => onAddPrompt(preset.prompt)}><span><strong>{preset.name}</strong><small>{preset.tags.join(' · ') || preset.prompt}</small></span></button>
                    {onUpdatePromptPreset && <button type="button" title="编辑预设" aria-label={`编辑预设 ${preset.name}`} onClick={() => setEditingPreset({ id: preset.id, name: preset.name, prompt: preset.prompt })}><Pencil size={12} /></button>}
                    <button type="button" className="prompt-preset-delete" title="删除预设" aria-label={`删除预设 ${preset.name}`} onClick={() => onDeletePromptPreset(preset.id)}>×</button>
                  </div>
            ))}
          </>}
          <div className="node-library-section-title">星芒提示词预设</div>
          {promptPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="prompt-preset-row"
              onClick={() => onAddPrompt(preset.prompt)}
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
          <div className="library-assets-heading"><span>最近素材</span><button type="button" onClick={onOpenAssets}>查看全部</button></div>
          <div className="library-asset-grid">
            {recentAssets.map((asset) => (
              <article
                key={asset.assetId}
                className="library-asset-item"
                title={`${asset.fileName}\n点击添加到画布，右键打开素材操作`}
                onContextMenu={(event) => { event.preventDefault(); onAssetMenu(asset.assetId) }}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-xingmang-asset-id', asset.assetId)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <button type="button" className="library-asset-preview" aria-label={`添加素材到画布：${asset.fileName}`} onClick={() => onAddAsset(asset.assetId)}>
                  {/* This strip never plays anything, so a derived still is all
                      it ever needed; it used to mount one video element per
                      tile purely to paint a frame. */}
                  {asset.mediaType === 'audio'
                    ? <span className="asset-video-placeholder"><Music2 size={22} /><small>音频</small></span>
                    : asset.mediaType === 'video'
                      ? <VideoCoverImage
                          thumbnailUrl={asset.thumbnailUrl}
                          videoUrl={asset.localUrl}
                          alt={asset.fileName}
                          loading="lazy"
                          fallbackLabel="视频"
                          style={{ aspectRatio: mediaAssetAspectRatio(asset) }}
                        />
                      : <SafeImage
                          src={asset.thumbnailUrl}
                          fallbackSrc={asset.localUrl}
                          alt={asset.fileName}
                          loading="lazy"
                          style={{ aspectRatio: mediaAssetAspectRatio(asset) }}
                        />}
                </button>
                <footer>
                  <span>{asset.fileName}</span>
                  <button type="button" title="素材操作" aria-label={`打开素材操作：${asset.fileName}`} onClick={() => onAssetMenu(asset.assetId)}><MoreHorizontal size={12} /></button>
                </footer>
              </article>
            ))}
          </div>
          {recentAssets.length === 0 && <p className="library-empty">还没有本地素材</p>}
          <button type="button" className="library-assets-open" onClick={onOpenAssets}>打开素材管理</button>
        </section>}
        {view === 'nodes' && categoryOrder.map((category) => {
          const entries = definitions.filter((definition) => definition.category === category)
          if (entries.length === 0) return null
          return (
            <section key={category}>
              <div className="node-library-section-title">{categoryLabel[category]}</div>
              {category === 'drama' && (
                <button type="button" className="template-row" onClick={() => onLoadTemplate('xingmang-drama-script-parse')}>
                  <span className="template-swatch" style={{ backgroundColor: '#8B5CF6' }} />
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
                    onClick={() => onAdd(definition.type)}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-xingmang-node', definition.type)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <span className="node-library-icon" aria-hidden="true">{definition.title.slice(0, 1)}</span>
                    <span><strong>{definition.title}</strong><small>{definition.description}</small></span>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
        </div>
      </div>}
    </aside>
  )
}
