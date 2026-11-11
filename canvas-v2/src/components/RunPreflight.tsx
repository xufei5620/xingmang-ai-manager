import { useEffect, useRef } from 'react'
import type { CanvasRunPreflight, CanvasRunPreflightItem } from '../runtime/run-preflight'
import { canvasRunQuoteText, type CanvasRunQuoteView } from '../runtime/run-quote'
import type { CanvasGroupSummary } from '../host'
import { canvasGroupDisplayName } from '../library/group-catalog'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { AlertTriangle, CheckCircle2, CircleDollarSign, X } from 'lucide-react'

interface RunPreflightProps {
  preflight: CanvasRunPreflight
  groups?: readonly CanvasGroupSummary[]
  agentRequestLabel?: string
  originalRunId?: string
  /** 「预计约 $x」; left out where the host offers no price list. */
  quote?: CanvasRunQuoteView | null
  onCancel(): void
  onConfigure(): void
  onLocateNode(nodeId: string): void
  onConfirm(): void
}

function needsGenerationConfiguration(item: CanvasRunPreflightItem): boolean {
  return item.action === 'blocked' && (item.reasonCode === 'missing-group' || item.reasonCode === 'unavailable-model')
}

export function RunPreflight({ preflight, groups = [], agentRequestLabel, originalRunId, quote, onCancel, onConfigure, onLocateNode, onConfirm }: RunPreflightProps) {
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
          <div><strong>{preflight.requestCount}</strong><span>项要运行</span></div>
          <div><strong>{preflight.cacheHitCount}</strong><span>个用上次结果</span></div>
          <div className={preflight.imageRequestCount > 0 ? 'is-warning' : ''}><strong>{preflight.imageRequestCount}</strong><span>图片请求</span></div>
          <div className={preflight.videoRequestCount > 0 ? 'is-warning' : ''}><strong>{preflight.videoRequestCount}</strong><span>视频请求</span></div>
          <div className={preflight.textRequestCount > 0 ? 'is-warning' : ''}><strong>{preflight.textRequestCount}</strong><span>文字请求</span></div>
        </div>
        <p className="run-preflight-scope">{preflight.warnings[0] ?? '当前运行范围'}</p>
        {preflight.blockedCount > 0 && (
          <div className="run-preflight-blocking" role="alert"><AlertTriangle size={15} /><span>{preflight.blockedCount} 个节点还不能运行，照下面写的原因改好再运行。</span></div>
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
                <small>{item.reason ?? (item.action === 'cached' ? '用上次的结果' : item.action === 'skip' ? '已跳过' : item.paid ? '会扣费生成' : '本地处理')}</small>
                {item.paid && item.requestCount > 1 && <small>最多生成 {item.requestCount} 次，每次都扣费，价格以来源为准</small>}
                {item.webSearch && item.action === 'cached' && <small>用的是上次的搜索结果；要最新信息请重新运行这个节点</small>}
                {item.action === 'blocked' && !needsGenerationConfiguration(item) && <button type="button" className="run-preflight-locate" data-node-id={item.nodeId} onClick={() => onLocateNode(item.nodeId)}>{item.reasonCode === 'missing-asset' ? '定位并补充素材' : item.reasonCode === 'invalid-parameters' ? '定位并检查参数与输入' : '定位并检查节点'}</button>}
              </span>
            </li>
          ))}
        </ul>
        {preflight.paidRequestCount > 0 && <p className="run-preflight-warning">这次最多扣费生成 {preflight.paidRequestCount} 次{quote && <>，<span className="run-preflight-quote" title="按你账号的价目和分组倍率算的最多花费，实际扣多少以站点为准" aria-live="polite">{canvasRunQuoteText(quote)}</span></>}。{preflight.scope.kind === 'to-node' ? '选中的节点会重新生成，前面的节点输入没变就用上次的结果。' : '输入跟上次一样的直接用上次的结果，不扣费。'}中途点停止只是不再等，已经发出去的生成可能还在跑、照样扣费，结果没出来先别急着重新运行。</p>}
        {preflight.webSearchRequestCount > 0 && <p className="run-preflight-warning" role="note">其中 {preflight.webSearchRequestCount} 个文字节点要联网搜索，每个最多搜一次，费用以来源为准。{preflight.scope.kind === 'to-node' ? '选中的节点会重新搜索，前面的节点输入没变就用上次的搜索结果。' : '输入没变的会用上次的搜索结果；要最新信息，就在那个节点上选「运行此节点」。'}</p>}
        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          {hasGenerationConfigurationBlocker && <button type="button" onClick={onConfigure}>打开生成配置</button>}
          <button type="button" className="is-primary" disabled={!preflight.canStart} onClick={onConfirm}>{originalRunId ? '确认继续原运行' : '确认运行'}</button>
        </footer>
      </section>
    </div>
  )
}
