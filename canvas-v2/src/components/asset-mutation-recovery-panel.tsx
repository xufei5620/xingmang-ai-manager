'use client'

import { useEffect, useRef, useState } from 'react'
import type { AssetMutationAction, AssetMutationInput } from '../lib/asset-mutation-contract'
import type { AssetMutationRecoveryHook } from '../lib/asset-mutation-recovery-hook'
import './asset-mutation-recovery.css'

export const assetMutationActionLabels: Record<AssetMutationAction, string> = { favorite: '收藏', unfavorite: '取消收藏', delete: '移入回收站', restore: '恢复素材', tags: '修改标签', rename: '重命名', undo: '撤销原改动' }
function summary(input: AssetMutationInput): string {
  if (input.action === 'rename') return '新名称：' + input.displayName
  if (input.action === 'tags') return '共 ' + input.assetIds.length + ' 项 · 标签：' + (input.tags.join('、') || '清空标签')
  return '共 ' + input.assetIds.length + ' 项素材'
}

export function AssetMutationRecoveryPanel({ journal, onChanged }: { journal: AssetMutationRecoveryHook; onChanged?(): void }) {
  const latest = useRef({ journal, onChanged }), mounted = useRef(true)
  latest.current = { journal, onChanged }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [localError, setLocalError] = useState('')
  // The hook changes this callback before effects on every owner/access
  // revision, including A -> B -> A. A mounted panel is not a scope guard.
  const scope = journal.submit, errorScope = useRef(scope)
  const [expanded, setExpanded] = useState(() => ({ scope, open: false }))
  const visibleError = errorScope.current === scope ? localError : ''
  const entry = journal.entries.find((item) => item.input.operationId === journal.selectedOperationId)
  const result = entry && journal.result?.operationId === entry.input.operationId ? journal.result : null
  const undoable = result?.action !== 'undo' ? result?.outcomes.filter((item) => item.state === 'succeeded' && item.changed && item.undoable).map((item) => item.assetId) ?? [] : []
  const writable = journal.ready && journal.writeAvailable && !journal.loading && !journal.busy && !journal.pending
  function current() { return mounted.current && latest.current.journal.submit === scope }
  function currentEntry() { return current() && !!entry && latest.current.journal.selectedOperationId === entry.input.operationId && latest.current.journal.entries.some((item) => item.input.operationId === entry.input.operationId && item.requestDigest === entry.requestDigest) }
  function error(message: string) { if (current()) { errorScope.current = scope; setLocalError(message) } }
  async function inspect() {
    if (!entry || !currentEntry() || latest.current.journal.busy || latest.current.journal.loading || !latest.current.journal.ready) return
    error('')
    try {
      const checked = await latest.current.journal.inspect(entry.input)
      if (currentEntry() && checked.status === 'applied') latest.current.onChanged?.()
    } catch (reason) { if (currentEntry()) error(reason instanceof Error ? reason.message : '原素材操作尚未确认，请重新核对。') }
  }
  async function retry() {
    if (!entry || !currentEntry() || !latest.current.journal.retryAvailable || latest.current.journal.busy || latest.current.journal.loading || !latest.current.journal.writeAvailable) return
    error('')
    try { await latest.current.journal.retry(entry.input); if (currentEntry()) latest.current.onChanged?.() }
    catch (reason) { if (currentEntry()) error(reason instanceof Error ? reason.message : '原素材操作尚未确认，请重新核对。') }
  }
  async function undo() {
    const active = latest.current.journal
    if (!currentEntry() || !result || !writable || active.busy || active.loading || active.pending || !active.ready || !active.writeAvailable || active.result?.operationId !== result.operationId || active.result?.requestDigest !== result.requestDigest || active.selectedOperationId !== result.operationId || !undoable.length) return
    error('')
    try {
      await active.submit({ operationId: crypto.randomUUID(), action: 'undo', assetIds: undoable, originalOperationId: result.operationId, originalRequestDigest: result.requestDigest })
      if (current()) latest.current.onChanged?.()
    } catch (reason) { error(reason instanceof Error ? reason.message : '撤销结果尚未确认，请核对原操作。') }
  }
  async function reload() {
    if (!current() || latest.current.journal.busy || latest.current.journal.loading) return
    error('')
    try { await latest.current.journal.reload() } catch { /* The journal publishes its scoped read error. */ }
  }
  function select(operationId: string) {
    if (!current() || latest.current.journal.busy || latest.current.journal.loading) return
    error('')
    try { latest.current.journal.select(operationId) } catch (reason) { error(reason instanceof Error ? reason.message : '原素材记录尚未读取，请重试。') }
  }
  function stopWaiting() {
    if (!current()) return
    try { latest.current.journal.stopWaiting() } catch (reason) { error(reason instanceof Error ? reason.message : '当前素材操作所属账号已变化。') }
  }
  if (!journal.entries.length && journal.ready && !journal.error && !journal.writeError) return null
  return <section className="xm-asset-recovery" aria-label="素材操作记录">
    <details className="xm-asset-recovery-disclosure" open={expanded.scope === scope && expanded.open || journal.busy || !!journal.pending || !!journal.error || !!visibleError || !!journal.writeError}>
    <summary className="xm-asset-recovery-heading" onClick={(event) => { event.preventDefault(); if (current()) setExpanded((value) => ({ scope, open: value.scope !== scope || !value.open })) }}><strong>素材操作记录</strong><span>{journal.busy ? '正在核对原操作…' : journal.pending ? '有一项操作待核对' : '保留最近20项，可跨页面核对'}</span><span className="xm-asset-recovery-toggle">查看记录与撤销</span></summary>
    <div className="xm-asset-recovery-tools">
      <button type="button" disabled={journal.busy || journal.loading} onClick={() => void reload()}>重读本机记录</button>
      {journal.busy && <button type="button" onClick={stopWaiting}>停止等待</button>}
    </div>
    {journal.entries.length > 0 && <label className="xm-asset-recovery-select">原操作<select aria-label="选择素材操作记录" value={journal.selectedOperationId ?? ''} disabled={journal.busy || journal.loading} onChange={(event) => select(event.target.value)}>
      {[...journal.entries].reverse().map((item) => <option key={item.input.operationId} value={item.input.operationId}>{assetMutationActionLabels[item.input.action]} · {new Date(item.createdAt).toLocaleString('zh-CN')} · {item.phase === 'pending' ? '待核对' : '已确认'}</option>)}
    </select></label>}
    {entry && <div className="xm-asset-recovery-original"><span>{assetMutationActionLabels[entry.input.action]} · {summary(entry.input)}</span><small>原操作 {entry.input.operationId.slice(0, 8)} · 第 {entry.attempt} 次提交</small></div>}
    {result ? <div className="xm-asset-recovery-result" role="status">
      <p>成功 {result.outcomes.filter((item) => item.state === 'succeeded').length} 项，拒绝 {result.outcomes.filter((item) => item.state === 'rejected').length} 项；其中 {result.outcomes.filter((item) => item.state === 'succeeded' && !item.changed).length} 项无需改动。</p>
      <details><summary>查看逐项结果</summary><ul>{result.outcomes.map((item) => <li key={item.assetId}><strong>{item.displayName}</strong><span>{item.message}</span></li>)}</ul></details>
      {undoable.length > 0 && <div className="xm-asset-recovery-undo"><span>仅尝试撤销原来成功且有改动的 {undoable.length} 项；后续改动、共享保护或已删除素材会保留并提示冲突。</span><button type="button" disabled={!writable} onClick={() => void undo()}>撤销本次成功改动</button></div>}
    </div> : entry && <p className="xm-asset-recovery-explanation">只核对这份原操作，不根据当前素材状态猜测成功，也不会自动重新提交。</p>}
    {entry && <div className="xm-asset-recovery-actions"><button type="button" disabled={journal.busy || journal.loading || !journal.ready} onClick={() => void inspect()}>核对原操作结果</button>{journal.retryAvailable && <button type="button" disabled={journal.busy || journal.loading || !journal.writeAvailable} onClick={() => void retry()}>按原内容重新提交同一操作</button>}</div>}
    {journal.retryAvailable && <p className="xm-asset-recovery-explanation">服务器暂未找到原回执；再次确认只重发同一编号和内容。它仍可能与先前请求重叠，由服务器去重。</p>}
    {(journal.error || visibleError || journal.writeError) && <p role="alert" className="xm-asset-recovery-error">{journal.error || visibleError || journal.writeError}</p>}
    {journal.pending && <p className="xm-asset-recovery-explanation">原记录确认前暂停新的素材改动。关闭页面只停止等待，已经提交的批次不会因此撤销。</p>}
    </details>
  </section>
}
