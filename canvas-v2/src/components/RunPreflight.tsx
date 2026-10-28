import { useEffect, useRef } from 'react'
import type { CanvasRunPreflight, CanvasRunPreflightItem } from '../runtime/run-preflight'
import type { CanvasGroupSummary } from '../host'
import { canvasGroupDisplayName } from '../library/group-catalog'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { AlertTriangle, CheckCircle2, CircleDollarSign, X } from 'lucide-react'

interface RunPreflightProps {
  preflight: CanvasRunPreflight
  groups?: readonly CanvasGroupSummary[]
  agentRequestLabel?: string
  originalRunId?: string
  onCancel(): void
  onConfigure(): void
  onLocateNode(nodeId: string): void
  onConfirm(): void
}

function needsGenerationConfiguration(item: CanvasRunPreflightItem): boolean {
  return item.action === 'blocked' && (item.reasonCode === 'missing-group' || item.reasonCode === 'unavailable-model')
}

export function RunPreflight({ preflight, groups = [], agentRequestLabel, originalRunId, onCancel, onConfigure, onLocateNode, onConfirm }: RunPreflightProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const hasGenerationConfigurationBlocker = preflight.items.some(needsGenerationConfiguration)
  useEffect(() => {
    const dialog = dialogRef.current
    const first = dialog?.querySelector<HTMLElement>('button:not([disabled])')
    first?.focus()
  }, [])

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
    if (focusable.length === 0) return
    const current = document.activeElement
    const index = focusable.indexOf(current as HTMLElement)
    const next = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length]
    event.preventDefault()
    next.focus()
  }

  return (
    <div className="run-preflight-backdrop" role="presentation">
      <section ref={dialogRef} className="run-preflight" role="dialog" aria-modal="true" aria-label="运行前检查" onKeyDown={trapFocus}>
        <header>
          <span><CircleDollarSign size={17} aria-hidden="true" /><strong>运行前检查</strong></span>
          <button type="button" title="关闭" aria-label="关闭运行前检查" onClick={onCancel}><X size={16} /></button>
        </header>
        {agentRequestLabel && <p className="run-preflight-scope" aria-label="本次运行关联的 Agent 需求">Agent 原需求：{agentRequestLabel}。使用当前画布参数，结果保存在这条原消息下。</p>}
        {originalRunId && <p className="run-preflight-scope" aria-label="继续原运行的已保存参数">继续原运行 {originalRunId}。使用已保存的原图参数；当前画布后来的修改不会用于这次继续。请求数量为尚未结束节点的上限。</p>}
        <div className="run-preflight-summary">
          <div><strong>{preflight.selectedNodeIds.length}</strong><span>个节点</span></div>
          <div><strong>{preflight.requestCount}</strong><span>个执行项</span></div>
          <div><strong>{preflight.cacheHitCount}</strong><span>个缓存</span></div>
          <div className={preflight.imageRequestCount > 0 ? 'is-warning' : ''}><strong>{preflight.imageRequestCount}</strong><span>图片请求</span></div>
          <div className={preflight.videoRequestCount > 0 ? 'is-warning' : ''}><strong>{preflight.videoRequestCount}</strong><span>视频请求</span></div>
          <div className={preflight.textRequestCount > 0 ? 'is-warning' : ''}><strong>{preflight.textRequestCount}</strong><span>文字请求</span></div>
        </div>
        <p className="run-preflight-scope">{preflight.warnings[0] ?? '当前运行范围'}</p>
        {preflight.blockedCount > 0 && (
          <div className="run-preflight-blocking" role="alert"><AlertTriangle size={15} /><span>{preflight.blockedCount} 个节点阻塞，请根据下列原因处理后重新运行。</span></div>
        )}
        <div className="run-preflight-details">
          <div><span>来源</span><strong>{preflight.groups.map((group) => canvasGroupDisplayName(group, groups)).join('、') || '无'}</strong></div>
          <div><span>模型</span><strong>{preflight.models.join('、') || '无'}</strong></div>
        </div>
        <ul className="run-preflight-items">
          {preflight.items.map((item) => (
            <li key={item.nodeId} className={`is-${item.action}`}>
              {item.action === 'blocked' ? <AlertTriangle size={13} /> : item.action === 'cached' ? <CheckCircle2 size={13} /> : <span className="run-preflight-dot" />}
              <span>
                <strong title={item.nodeId}>{builtinNodeRegistry.resolve(item.kind)?.title ?? '未识别节点'}</strong>
                <small>{item.reason ?? (item.action === 'cached' ? '复用已有结果' : item.action === 'skip' ? '已跳过' : item.paid ? '将提交付费生成请求' : '本地处理')}</small>
                {item.paid && item.requestCount > 1 && <small>最多 {item.requestCount} 次独立生成，按次计费，具体金额以来源为准</small>}
                {item.webSearch && item.action === 'cached' && <small>复用已有联网搜索结果；需要最新信息请重新运行该节点</small>}
                {item.action === 'blocked' && !needsGenerationConfiguration(item) && <button type="button" className="run-preflight-locate" data-node-id={item.nodeId} onClick={() => onLocateNode(item.nodeId)}>{item.reasonCode === 'missing-asset' ? '定位并补充素材' : item.reasonCode === 'invalid-parameters' ? '定位并检查参数与输入' : '定位并检查节点'}</button>}
              </span>
            </li>
          ))}
        </ul>
        {preflight.paidRequestCount > 0 && <p className="run-preflight-warning">本次最多提交 {preflight.paidRequestCount} 个付费请求；{preflight.scope.kind === 'to-node' ? '目标节点将重新执行，其余节点先核对缓存。' : '先核对服务端缓存，仅未命中时才提交。'}停止等待不代表上游已取消，请勿因不确定结果立即重复提交。</p>}
        {preflight.webSearchRequestCount > 0 && <p className="run-preflight-warning" role="note">其中 {preflight.webSearchRequestCount} 个文字请求开启联网搜索，每个请求最多调用一次搜索工具，具体费用以来源为准。{preflight.scope.kind === 'to-node' ? '运行到此会重新搜索目标节点；上游缓存仍可复用。' : '命中缓存会复用之前的搜索结果；需要更新信息时，请在该节点选择运行此节点。'}</p>}
        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          {hasGenerationConfigurationBlocker && <button type="button" onClick={onConfigure}>打开生成配置</button>}
          <button type="button" className="is-primary" disabled={!preflight.canStart} onClick={onConfirm}>{originalRunId ? '确认继续原运行' : '确认运行'}</button>
        </footer>
      </section>
    </div>
  )
}
