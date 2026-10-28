import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AssetCategoryInput, AssetCategoryOperationInspection, AssetCategoryResult } from '../lib/asset-category-contract'
import { confirmAssetCategoryResult } from '../lib/asset-category-contract'
import { isAssetCategoryClientRejected } from '../lib/asset-category-client-error'
import { isAssetCategoryRecoveryNotSubmitted } from '../lib/asset-category-recovery'

export interface AssetCategoryOperationProps {
  scopeKey: string
  disabled?: boolean
  recovery?: AssetCategoryInput
  /** A loaded durable journal is authoritative even when it is empty. */
  durableRecoveryReady?: boolean
  recoveryNotice?: ReactNode
  onRecoveryChange?(input: AssetCategoryInput | undefined): void
  onSubmit(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryResult>
  onRetry?(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryResult>
  onInspect(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryOperationInspection>
  onChanged(result: AssetCategoryResult): void
}

export function useAssetCategoryOperation(props: AssetCategoryOperationProps) {
  const context = useRef({ scope: props.scopeKey, generation: 0, mounted: true, disabled: !!props.disabled, busy: false })
  const controller = useRef<AbortController | null>(null)
  if (context.current.scope !== props.scopeKey) { context.current.scope = props.scopeKey; context.current.generation++; context.current.busy = false; controller.current?.abort() }
  context.current.disabled = !!props.disabled
  const [pendingState, setPendingState] = useState({ scope: props.scopeKey, input: props.recovery })
  const pending = pendingState.scope === props.scopeKey ? pendingState.input : props.recovery
  function setPending(input: AssetCategoryInput | undefined) { setPendingState({ scope: props.scopeKey, input }) }
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState(false)
  const [rejected, setRejected] = useState(false)
  useEffect(() => { setPending(props.recovery); setBusy(false); setMissing(false); setRejected(false); setError('') }, [props.scopeKey])
  useEffect(() => {
    if (context.current.busy) return
    if (props.recovery && props.recovery.operationId !== pendingRef.current?.operationId) { pendingRef.current = props.recovery; setPending(props.recovery); setMissing(false); setRejected(false); setError('') }
    else if (props.durableRecoveryReady && !props.recovery && pendingRef.current) { pendingRef.current = undefined; setPending(undefined); setMissing(false); setRejected(false); setError('') }
  }, [props.recovery, props.durableRecoveryReady, busy])
  useEffect(() => {
    context.current.mounted = true
    return () => { context.current.mounted = false; context.current.generation++; controller.current?.abort() }
  }, [])
  useEffect(() => { if (props.disabled) { context.current.generation++; context.current.busy = false; controller.current?.abort(); setBusy(false) } }, [props.disabled])
  function remember(input: AssetCategoryInput | undefined) { pendingRef.current = input; setPending(input); props.onRecoveryChange?.(input) }
  function begin() {
    if (!context.current.mounted || context.current.disabled || context.current.busy) return null
    const generation = context.current.generation, active = new AbortController()
    controller.current?.abort(); controller.current = active; context.current.busy = true; setBusy(true); setError('')
    return { signal: active.signal, current: () => context.current.mounted && !context.current.disabled && generation === context.current.generation && !active.signal.aborted && controller.current === active }
  }
  function accept(input: AssetCategoryInput, result: AssetCategoryResult) {
    confirmAssetCategoryResult(input, result)
    remember(undefined); setMissing(false); setRejected(false)
    try { props.onChanged(result) } catch { setError('分类操作已确认，列表更新未完成，请刷新核对。') }
  }
  async function submit(input: AssetCategoryInput, retry = false) {
    if (pendingRef.current && (!retry || !missing || input !== pendingRef.current)) return
    const ticket = begin()
    if (!ticket) return
    remember(input); setMissing(false); setRejected(false)
    try { const result = await (retry && props.onRetry ? props.onRetry : props.onSubmit)(input, ticket.signal); if (ticket.current()) accept(input, result) }
    catch (cause) {
      if (!ticket.current()) return
      if (isAssetCategoryClientRejected(cause)) { remember(undefined); setRejected(true) }
      else if (isAssetCategoryRecoveryNotSubmitted(cause)) {
        if (retry) setMissing(false)
        else { remember(undefined); setRejected(true) }
      }
      setError(cause instanceof Error ? cause.message : '分类操作未确认，请核对原操作。')
    } finally { if (ticket.current()) { context.current.busy = false; setBusy(false) } }
  }
  async function inspect() {
    const input = pendingRef.current
    if (!input) return
    const ticket = begin()
    if (!ticket) return
    try {
      const result = await props.onInspect(input, ticket.signal)
      if (!ticket.current()) return
      if (result.operationId !== input.operationId) throw new Error('原分类操作核对回执不一致')
      if (result.status === 'applied') accept(input, result.result)
      else { setMissing(true); setError('尚未找到已提交回执。可明确重试原操作；将沿用相同内容和操作编号。') }
    } catch (cause) { if (ticket.current()) setError(cause instanceof Error ? cause.message : '原分类操作尚未核对完成') }
    finally { if (ticket.current()) { context.current.busy = false; setBusy(false) } }
  }
  return { pending, busy, error, missing, rejected, locked: !!props.disabled || busy || !!pending, canClose: !busy && (!pending || !!props.onRecoveryChange), submit, inspect, retry: () => pendingRef.current && submit(pendingRef.current, true), clearError: () => { setError(''); setRejected(false) } }
}
