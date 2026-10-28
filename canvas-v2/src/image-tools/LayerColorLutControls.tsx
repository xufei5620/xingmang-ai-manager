import { useEffect, useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { maximumColorLutCubeBytes } from './layer-color-lut'
import { layerColorLutPresets } from './layer-color-lut-presets'
import { buildColorLutSelection, parseColorLutSelection, type AssetColorLutSource, type ColorLutSelection } from './layer-color-lut-selection'
import './layer-color-lut-controls.css'

export interface LayerColorLutControlsProps {
  value?: ColorLutSelection
  disabled?: boolean
  revision: number
  scope: object
  onChange(value: ColorLutSelection | undefined): void
  onImport(file: File, signal: AbortSignal): Promise<AssetColorLutSource>
  onReadingChange?(reading: boolean): void
}

interface ImportTicket { controller: AbortController; scope: object; revision: number; signature: string; previous?: ColorLutSelection }

function signature(value: ColorLutSelection | undefined): string { return value === undefined ? '' : JSON.stringify(parseColorLutSelection(value)) }

export function LayerColorLutControls(props: LayerColorLutControlsProps) {
  const { value, disabled = false, revision, scope } = props
  const valueSignature = signature(value)
  const [reading, setReading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const fileInput = useRef<HTMLInputElement>(null), alive = useRef(true), active = useRef<ImportTicket | null>(null), reportedReading = useRef(false)
  const latest = useRef({ ...props, signature: valueSignature })
  latest.current = { ...props, signature: valueSignature }

  function reportReading(next: boolean) {
    if (alive.current) setReading(next)
    if (reportedReading.current !== next) { reportedReading.current = next; latest.current.onReadingChange?.(next) }
  }
  function abortImport() {
    const previous = active.current
    active.current = null
    previous?.controller.abort()
    reportReading(false)
  }
  function isScopeCurrent() { const current = latest.current; return alive.current && !current.disabled && current.scope === scope && current.revision === revision && current.signature === valueSignature }
  function canEdit() { return isScopeCurrent() && active.current === null }
  function isTicketCurrent(ticket: ImportTicket) {
    const current = latest.current
    return alive.current && active.current === ticket && !ticket.controller.signal.aborted && !current.disabled && current.scope === ticket.scope && current.revision === ticket.revision && current.signature === ticket.signature
  }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; abortImport() }
  }, [])
  useEffect(() => {
    const ticket = active.current
    if (ticket && !isTicketCurrent(ticket)) { abortImport(); setNotice('读取已取消，当前调整保留'); setError('') }
  }, [scope, revision, valueSignature, disabled])

  function change(next: ColorLutSelection | undefined, message = '') {
    if (!canEdit()) return
    try { latest.current.onChange(next === undefined ? undefined : parseColorLutSelection(next)); setError(''); setNotice(message) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'LUT 设置未能应用，原配置保留') }
  }
  function choosePreset(id: string) {
    if (!canEdit()) return
    try { change(buildColorLutSelection({ kind: 'builtin', presetId: id }, latest.current.value), '原创预设已载入草稿，完成调整后应用到图层') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法选择 LUT 预设，原配置保留') }
  }
  function strength(next: number) {
    if (!canEdit() || !latest.current.value || !Number.isFinite(next)) return
    change({ ...latest.current.value, strength: Math.max(0, Math.min(100, Math.round(next))) })
  }
  function cancelImport(ticket: ImportTicket | null) { if (!ticket || active.current !== ticket) return; abortImport(); if (alive.current) { setError(''); setNotice('已取消读取，原 LUT 配置保留') } }
  async function importFile(file: File) {
    if (!isScopeCurrent()) return
    abortImport()
    const current = latest.current
    const ticket: ImportTicket = { controller: new AbortController(), scope: current.scope, revision: current.revision, signature: current.signature, previous: current.value === undefined ? undefined : parseColorLutSelection(current.value) }
    active.current = ticket
    setError(''); setNotice('正在读取调色表，原配置保留'); reportReading(true)
    try {
      if (!/\.cube$/i.test(file.name)) throw new Error('请选择 .cube 格式的 LUT 调色表')
      if (!Number.isFinite(file.size) || file.size < 0 || file.size > maximumColorLutCubeBytes) throw new Error('LUT 文件不能超过 24 MiB')
      if (!isTicketCurrent(ticket)) return
      const source = await current.onImport(file, ticket.controller.signal)
      if (!isTicketCurrent(ticket)) return
      if (!source || typeof source !== 'object' || source.kind !== 'asset') throw new Error('自定义 LUT 未返回有效的账户素材，原配置保留')
      const selection = buildColorLutSelection(source, ticket.previous)
      // Parent callbacks can synchronously change scope or revoke editing. Recheck
      // after reporting idle as well as after the asynchronous resource read.
      active.current = null; reportReading(false)
      const now = latest.current
      if (!alive.current || ticket.controller.signal.aborted || now.disabled || now.scope !== ticket.scope || now.revision !== ticket.revision || now.signature !== ticket.signature) return
      try { now.onChange(selection); setNotice(`已载入「${source.name}」，完成调整后应用到图层`) }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'LUT 设置未能应用，原配置保留') }
    } catch (cause) {
      if (isTicketCurrent(ticket)) setError(cause instanceof Error ? cause.message : 'LUT 导入失败，原配置保留')
    } finally {
      if (active.current === ticket) { active.current = null; ticket.controller.abort(); reportReading(false) }
    }
  }

  const blocked = disabled || reading, source = value?.source, selectedPreset = source?.kind === 'builtin' ? layerColorLutPresets.find((entry) => entry.id === source.presetId) : undefined
  const sourceName = value?.source.kind === 'asset' ? value.source.name : selectedPreset?.name, displayedTicket = active.current
  return <section className="layer-color-lut-controls" aria-label="LUT 调色" aria-busy={reading}>
    <header><strong>LUT 调色</strong><label><input type="checkbox" aria-label="启用 LUT" disabled={blocked || !value} checked={value?.enabled ?? false} onChange={(event) => { if (canEdit() && latest.current.value) change({ ...latest.current.value, enabled: event.currentTarget.checked }) }} />启用</label></header>
    <label className="layer-color-lut-preset">原创预设<select aria-label="LUT 原创预设" disabled={blocked} value={selectedPreset?.id ?? ''} onChange={(event) => choosePreset(event.currentTarget.value)}><option value="" disabled>{value?.source.kind === 'asset' ? '当前使用自定义调色表' : '选择原创预设'}</option>{layerColorLutPresets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
    <p className="layer-color-lut-description">{selectedPreset?.description ?? '选择原创预设，或从本机导入 .cube 调色表。'}</p>
    <small>18 款星芒原创调色预设，可继续调整强度。</small>
    <div className="layer-color-lut-source" aria-label="当前 LUT 调色表"><strong>{sourceName ?? '尚未选择调色表'}</strong>{value && <span>33³ · {value.source.kind === 'asset' ? '自定义调色表' : '原创内置预设'}{!value.enabled ? ' · 已停用' : value.strength === 0 ? ' · 强度为 0，当前无效果' : ''}</span>}</div>
    <label className="layer-color-lut-strength"><span>LUT 强度</span><div><input type="range" aria-label="LUT 强度滑杆" min={0} max={100} step={1} disabled={blocked || !value} value={value?.strength ?? 100} onChange={(event) => strength(event.currentTarget.valueAsNumber)} /><input type="number" aria-label="LUT 强度" min={0} max={100} step={1} disabled={blocked || !value} value={value?.strength ?? 100} onChange={(event) => strength(event.currentTarget.valueAsNumber)} /><span>%</span></div></label>
    <div className="layer-color-lut-actions"><button type="button" disabled={blocked} onClick={() => { if (canEdit()) fileInput.current?.click() }}><Upload size={14} />{value?.source.kind === 'asset' ? '替换 .cube' : '导入 .cube'}</button><button type="button" disabled={blocked || !value} onClick={() => change(undefined, '已清除 LUT，其他调整保留')}><X size={14} />清除 LUT</button></div>
    <input ref={fileInput} type="file" accept=".cube" hidden disabled={blocked} aria-label="选择自定义 LUT 文件" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file) }} />
    {reading && <div className="layer-color-lut-reading"><span role="status">正在读取 LUT… 原配置保留</span><button type="button" onClick={() => cancelImport(displayedTicket)}>取消读取 LUT</button></div>}
    {error ? <p role="alert">{error}</p> : !reading && notice ? <p role="status">{notice}</p> : null}
    <small>支持 .cube · 上限 24 MiB · 统一为 33³ 调色表。导入不会触发 AI 生成。</small>
  </section>
}
