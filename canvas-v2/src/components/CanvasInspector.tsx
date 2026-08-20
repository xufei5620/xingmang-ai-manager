import type { ReactNode } from 'react'
import { Ban, Box, CirclePlay, Crosshair, Film, Image as ImageIcon, Lock, LockOpen, Maximize2, Music2, SlidersHorizontal, X } from 'lucide-react'
import { middleTruncate } from '../identifier-display'
import { SafeImage, isLocalCanvasAssetUrl } from './MediaPreview'
import { canvasInspectorParameterRows } from './canvas-inspector-model'
import type { CanvasInspectorNode } from './canvas-inspector-model'

export type { CanvasInspectorNode } from './canvas-inspector-model'
export type CanvasInspectorTab = 'node' | 'assets' | 'runs'

interface CanvasInspectorProps {
  tab: CanvasInspectorTab
  nodes: readonly CanvasInspectorNode[]
  imageModels: readonly string[]
  videoModels: readonly string[]
  onTabChange(tab: CanvasInspectorTab): void
  onClose(): void
  onLocate(nodeId: string): void
  onRun(nodeId: string): void
  onToggleLocked(nodeId: string, locked: boolean): void
  onToggleDisabled(nodeId: string, disabled: boolean): void
  onPreview(node: CanvasInspectorNode): void
  children?: ReactNode
}

const statusLabel: Record<string, string> = {
  idle: '待运行', running: '运行中', queued: '排队中', succeeded: '已完成', failed: '失败',
  cached: '缓存命中', cancelled: '已取消', skipped: '已跳过', interrupted: '已中断',
}

/**
 * Read-only. The node body owns parameter editing; mirroring the controls here
 * gave every value two independent editors and consumed the space that run
 * history, cost and error detail actually need.
 */
function NodeParameterSummary({ node, onLocate }: {
  node: CanvasInspectorNode
  onLocate(nodeId: string): void
}) {
  const rows = canvasInspectorParameterRows(node)
  return (
    <section className="canvas-inspector-section" aria-label="节点参数">
      <h3>参数<button type="button" className="canvas-inspector-section-action" onClick={() => onLocate(node.id)}>在节点上编辑</button></h3>
      {rows.length === 0
        ? <p className="canvas-inspector-muted">该节点没有可编辑参数。</p>
        : <dl className="canvas-inspector-parameters">
            {rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd title={row.value}>{row.value}</dd>
              </div>
            ))}
          </dl>}
    </section>
  )
}

function NodePreview({ node, onPreview }: { node: CanvasInspectorNode; onPreview(node: CanvasInspectorNode): void }) {
  const asset = node.previewAsset
  if (!asset) return <p className="canvas-inspector-muted">尚无结果</p>
  return (
    <button type="button" className={`canvas-inspector-preview is-${asset.kind}`} onClick={() => onPreview(node)} title="放大预览">
      {asset.kind === 'image' && isLocalCanvasAssetUrl(asset.localUrl, 'image')
        ? <SafeImage src={asset.localUrl} alt="节点结果缩略图" fallbackLabel="结果不可用" />
        : asset.kind === 'video' ? <Film size={24} aria-hidden="true" /> : <Music2 size={24} aria-hidden="true" />}
      <span>{asset.kind === 'image' ? '图像结果' : asset.kind === 'video' ? '视频结果' : '音频结果'}<Maximize2 size={12} /></span>
    </button>
  )
}

type SingleNodeInspectorProps = Pick<CanvasInspectorProps,
  'imageModels' | 'videoModels' | 'onLocate' | 'onRun'
  | 'onToggleLocked' | 'onToggleDisabled' | 'onPreview'> & { node: CanvasInspectorNode }

function SingleNodeInspector(props: SingleNodeInspectorProps) {
  const { node } = props
  const inputs = node.ports.filter((port) => port.direction === 'input')
  const outputs = node.ports.filter((port) => port.direction === 'output')
  const running = node.status === 'running' || node.status === 'queued'
  return (
    <div className="canvas-inspector-node-panel">
      <section className="canvas-inspector-node-head">
        <span><strong>{node.title}</strong><small>{node.description}</small></span>
        <em className={`is-${node.status}`}>{statusLabel[node.status] ?? node.status}</em>
      </section>
      <div className="canvas-inspector-actions" role="toolbar" aria-label="当前节点操作">
        <button type="button" title="定位节点" aria-label="定位节点" onClick={() => props.onLocate(node.id)}><Crosshair size={14} /></button>
        {node.executable && <button type="button" title="运行此节点" aria-label="运行此节点" disabled={node.disabled || running} onClick={() => props.onRun(node.id)}><CirclePlay size={14} /></button>}
        <button type="button" title={node.locked ? '解锁位置' : '锁定位置'} aria-label={node.locked ? '解锁节点位置' : '锁定节点位置'} onClick={() => props.onToggleLocked(node.id, !node.locked)}>{node.locked ? <LockOpen size={14} /> : <Lock size={14} />}</button>
        {node.executable && node.kind !== 'unknown' && <button type="button" className={node.disabled ? 'is-active' : ''} title={node.disabled ? '启用节点' : '禁用节点'} aria-label={node.disabled ? '启用节点' : '禁用节点'} onClick={() => props.onToggleDisabled(node.id, !node.disabled)}><Ban size={14} /></button>}
        {node.previewAsset && <button type="button" title="预览结果" aria-label="预览结果" onClick={() => props.onPreview(node)}><Maximize2 size={14} /></button>}
      </div>
      <NodeParameterSummary node={node} onLocate={props.onLocate} />
      <section className="canvas-inspector-section" aria-label="节点端口">
        <h3>连接</h3>
        <div className="canvas-inspector-ports">
          {[...inputs, ...outputs].map((port) => <span key={port.id} className={`is-${port.kind}`}><strong>{port.direction === 'input' ? '输入' : '输出'}·{port.label}</strong><small>{port.connectionCount} 条{port.cardinality === 'many' ? ' · 可多连' : ''}</small></span>)}
          {node.ports.length === 0 && <p className="canvas-inspector-muted">该节点没有连接端口。</p>}
        </div>
      </section>
      <section className="canvas-inspector-section" aria-label="节点结果">
        <h3>结果</h3>
        <NodePreview node={node} onPreview={props.onPreview} />
        <dl className="canvas-inspector-runtime">
          <div><dt>候选</dt><dd>{node.candidateCount}</dd></div>
          <div><dt>尝试</dt><dd>{node.attemptCount}</dd></div>
          <div><dt>耗时</dt><dd>{node.latestAttemptDurationMs === undefined ? '—' : `${(node.latestAttemptDurationMs / 1000).toFixed(1)} 秒`}</dd></div>
          <div><dt>消耗</dt><dd>{node.costQuota === undefined ? '—' : `${node.costQuota} quota`}</dd></div>
        </dl>
        {node.dirty && <p className="canvas-inspector-warning">输入已变化，当前结果待更新。</p>}
        {node.errorMessage && <p className="canvas-inspector-error" role="alert">{node.errorMessage}</p>}
      </section>
    </div>
  )
}

export function CanvasInspector(props: CanvasInspectorProps) {
  const closeLabel = props.tab === 'runs' ? '关闭运行面板' : props.tab === 'assets' ? '关闭素材面板' : '关闭节点检查器'
  const single = props.nodes.length === 1 ? props.nodes[0] : null
  return (
    <aside className="canvas-inspector" aria-label="统一检查器">
      <header className="canvas-inspector-header">
        <span className="canvas-inspector-title"><SlidersHorizontal size={15} aria-hidden="true" /><strong>检查器</strong></span>
        <button type="button" title={closeLabel} aria-label={closeLabel} onClick={props.onClose}><X size={15} /></button>
      </header>
      <nav className="canvas-inspector-tabs" aria-label="检查器页签">
        <button type="button" className={props.tab === 'node' ? 'is-active' : ''} aria-selected={props.tab === 'node'} onClick={() => props.onTabChange('node')}><Box size={13} />节点</button>
        <button type="button" className={props.tab === 'assets' ? 'is-active' : ''} aria-selected={props.tab === 'assets'} onClick={() => props.onTabChange('assets')}><ImageIcon size={13} />素材</button>
        <button type="button" className={props.tab === 'runs' ? 'is-active' : ''} aria-selected={props.tab === 'runs'} onClick={() => props.onTabChange('runs')}><SlidersHorizontal size={13} />运行</button>
      </nav>
      {props.tab === 'node' ? (
        single
          ? <SingleNodeInspector {...props} node={single} />
          : <div className="canvas-inspector-node-panel">
              {props.nodes.length === 0 && <p className="canvas-inspector-empty">选择一个节点查看参数、输入和运行结果。</p>}
              {props.nodes.length > 1 && <><div className="canvas-inspector-selection-summary"><strong>已选 {props.nodes.length} 个节点</strong><span>逐个定位后可编辑完整参数</span></div><div className="canvas-inspector-node-list">{props.nodes.map((node) => <button type="button" key={node.id} onClick={() => props.onLocate(node.id)}><span><strong>{node.title}</strong><small title={node.model || node.id}>{middleTruncate(node.model || node.id, 22)}</small></span><em className={`is-${node.status}`}>{statusLabel[node.status] ?? node.status}</em><Crosshair size={13} /></button>)}</div></>}
            </div>
      ) : <div className="canvas-inspector-content">{props.children}</div>}
    </aside>
  )
}
