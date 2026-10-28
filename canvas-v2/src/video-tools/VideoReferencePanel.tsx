import { useState, type KeyboardEvent } from 'react'
import { AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, Film, Image as ImageIcon, Music2, X } from 'lucide-react'
import { SafeImage } from '../components/MediaPreview'
import { upstreamReferenceRemovalLabel, type UpstreamMediaReference } from '../components/upstream-references'
import type { VideoReferenceOrder } from './video-reference-order'
import { arkSeedanceVideoReferenceLimits, type VideoProtocol } from '../lib/video-request-protocol'
import { inspectVideoReferences, moveVideoReference, removeMissingVideoReference, swapVideoReferenceFrames } from './video-reference-model'
import './video-reference-panel.css'

export interface VideoReferencePanelProps {
  model: string
  videoProtocol?: VideoProtocol
  videoMode?: string
  references: readonly UpstreamMediaReference[]
  order?: VideoReferenceOrder
  disabled?: boolean
  disabledReason?: string
  /** Why the host takes no explicit order; removing a reference stays available. */
  reorderUnavailableReason?: string
  onOrderChange(order: VideoReferenceOrder): void
  onPreview?(reference: UpstreamMediaReference): void
  onRemove?(edgeId: string): void
}

export function VideoReferencePanel(props: VideoReferencePanelProps) {
  const presentation = inspectVideoReferences(props)
  const [announcement, setAnnouncement] = useState('')
  const disabledReason = props.disabled ? props.disabledReason ?? '当前暂不能修改素材顺序' : props.reorderUnavailableReason ?? presentation.reorderDisabledReason
  function apply(order: VideoReferenceOrder | undefined, message: string) {
    if (props.disabled || props.reorderUnavailableReason || !order) return
    props.onOrderChange(order)
    setAnnouncement(message)
  }
  function move(key: string, delta: -1 | 1) {
    const item = presentation.items.find((entry) => entry.key === key)
    apply(moveVideoReference(presentation, key, delta), `${item?.label ?? '素材'}已${delta < 0 ? '前移' : '后移'}`)
  }
  function keyDown(event: KeyboardEvent<HTMLElement>, key: string) {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey) return
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : undefined
    if (delta === undefined) return
    event.preventDefault()
    move(key, delta)
  }
  return <section className="video-reference-panel nodrag nowheel" aria-label="视频参考素材" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <header className="video-reference-header"><strong>素材顺序</strong><span>{presentation.modeLabel}</span>{presentation.firstLast && <button type="button" className="video-reference-swap" disabled={Boolean(disabledReason) || !presentation.canSwap} title={disabledReason ?? (presentation.canSwap ? '调换首尾帧' : '需要两个明确的图片输入位置')} onClick={() => apply(swapVideoReferenceFrames(presentation), '首帧与尾帧已调换')}><ArrowLeftRight size={14} aria-hidden="true" />调换首尾帧</button>}</header>
    <div className={`video-reference-items${presentation.firstLast ? ' is-first-last' : ''}`}>
      {presentation.items.map((item, index) => <article key={presentation.items.filter((entry) => entry.key === item.key).length > 1 ? `${item.key}:${index}` : item.key} className={`video-reference-item${item.missing ? ' is-missing' : ''}`} tabIndex={0} aria-label={`${item.role}：${item.label}`} onKeyDown={(event) => keyDown(event, item.key)}>
        <button type="button" className="video-reference-preview" disabled={!props.onPreview || !item.reference?.asset || item.pending} title={item.pending ? '素材尚未就绪' : `预览${item.label}`} aria-label={`预览${item.role}：${item.label}`} onClick={() => { if (item.reference && !item.pending) props.onPreview?.(item.reference) }}>
          {item.reference?.asset?.kind === 'image' && item.reference.asset.localUrl && !item.missing ? <SafeImage src={item.reference.asset.localUrl} alt="" draggable={false} /> : item.kind === 'audio' ? <Music2 size={22} aria-hidden="true" /> : item.kind === 'video' ? <Film size={22} aria-hidden="true" /> : <ImageIcon size={22} aria-hidden="true" />}
        </button>
        <div className="video-reference-copy"><strong>{item.role}</strong><span title={item.label}>{item.label}</span><small>{item.missing ? '原位置待恢复' : item.dynamic ? '整组数量待确定' : item.pending ? '等待素材' : item.reference?.batch ? `整组第 ${item.outputIndex + 1} 项` : '已就绪'}</small></div>
        <div className="video-reference-actions">
          {!presentation.firstLast && <><button type="button" aria-label={`前移${item.role}：${item.label}`} title={disabledReason ?? '前移（Alt + ↑ / ←）'} disabled={Boolean(disabledReason) || index === 0} onClick={() => move(item.key, -1)}><ArrowUp size={14} aria-hidden="true" /></button><button type="button" aria-label={`后移${item.role}：${item.label}`} title={disabledReason ?? '后移（Alt + ↓ / →）'} disabled={Boolean(disabledReason) || index === presentation.items.length - 1} onClick={() => move(item.key, 1)}><ArrowDown size={14} aria-hidden="true" /></button></>}
          {item.missing ? <button type="button" aria-label={`移除失效位置：${item.role}`} title="明确移除此失效位置，其余位置将重新排列" disabled={props.disabled || !removeMissingVideoReference(presentation, item.key)} onClick={() => apply(removeMissingVideoReference(presentation, item.key), '失效位置已移除，请重新核对首尾帧')}><X size={14} aria-hidden="true" /></button> : props.onRemove && item.reference ? <button type="button" aria-label={upstreamReferenceRemovalLabel(item.reference)} title={props.disabled ? props.disabledReason : upstreamReferenceRemovalLabel(item.reference)} disabled={props.disabled} onClick={() => { if (!props.disabled) props.onRemove?.(item.edgeId) }}><X size={14} aria-hidden="true" /></button> : null}
        </div>
      </article>)}
      {presentation.emptyRoles.map((role) => <div key={role} className="video-reference-empty"><ImageIcon size={23} aria-hidden="true" /><strong>{role}</strong><span>连接一张图片</span></div>)}
    </div>
    {!presentation.items.length && !presentation.emptyRoles.length && <p className="video-reference-hint">{presentation.mode === 't2va' ? '当前使用文字生成视频，无需参考素材' : props.videoProtocol === 'ark-seedance' ? '连接图片、视频或音频后，在这里核对输入角色与顺序' : '连接图片或音频后，在这里核对输入角色与顺序'}</p>}
    {props.videoProtocol === 'ark-seedance' && <p className="video-reference-hint">最多 {arkSeedanceVideoReferenceLimits.images} 张图片、{arkSeedanceVideoReferenceLimits.videos} 个视频、{arkSeedanceVideoReferenceLimits.audios} 个音频；本站总数上限 {arkSeedanceVideoReferenceLimits.total} 项。多模态参考至少包含一张图片或一个视频。</p>}
    {presentation.firstLast && <p className="video-reference-hint">左侧为开始画面，右侧为结束画面；同一图片可分别连接到两个位置</p>}
    {presentation.items.length > 1 && !presentation.firstLast && <p className="video-reference-hint">按显示顺序使用素材 · 可用按钮或 Alt + 方向键排序</p>}
    {presentation.issues.map((issue) => <p className="video-reference-warning" key={issue} role="status"><AlertTriangle size={13} aria-hidden="true" /><span>{issue}</span></p>)}
    {props.disabled && props.disabledReason && <p className="video-reference-hint">{props.disabledReason}</p>}
    <span className="video-reference-live" role="status" aria-live="polite">{announcement}</span>
  </section>
}
