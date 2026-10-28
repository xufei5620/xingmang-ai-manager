'use client'

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { FolderOpen, History, LoaderCircle, Upload, X } from 'lucide-react'
import type { ProjectImportRecoveryInspection, ProjectImportRecoveryPort, ProjectImportRecoveryRecord } from '../lib/project-import-recovery'
import type { CanvasProjectPreview } from '../host'
import { projectImportBytes, projectImportFailureMessage } from '../lib/project-import-model'
import { projectImportVisibleControls } from './project-import-dialog'
import './project-import-dialog.css'

interface Props {
  port: ProjectImportRecoveryPort
  appearance?: 'workspace' | 'canvas'
  onClose(): void
  onPreview(preview: CanvasProjectPreview): void
  onOpen(projectId: string): Promise<void>
}

export function projectImportRecoveryStatus(inspection?: ProjectImportRecoveryInspection): string {
  if (!inspection) return '等待核对原操作'
  if (inspection.state === 'deleted') return '原工程已删除，不会重新创建'
  if (inspection.state === 'confirmed') return inspection.project.archivedAt ? '原工程已创建，当前位于归档' : '原工程已经创建'
  return inspection.state === 'verification-required' ? '需要原文件核对工程内容' : '尚未确认工程，需要原文件继续'
}

export default function ProjectImportRecoveryDialog({ port, appearance = 'workspace', onClose, onPreview, onOpen }: Props) {
  const [records, setRecords] = useState<ProjectImportRecoveryRecord[]>([])
  const [inspections, setInspections] = useState<Record<string, ProjectImportRecoveryInspection>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const active = useRef(true)
  const revision = useRef(0)
  const running = useRef(false)
  const dialog = useRef<HTMLElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const selectedOperation = useRef<string | null>(null)

  useEffect(() => {
    active.current = true
    revision.current += 1
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    try { setRecords(port.list()) } catch (reason) { setError(projectImportFailureMessage(reason)) }
    dialog.current?.focus()
    return () => { active.current = false; revision.current += 1; if (previous?.isConnected) previous.focus() }
  }, [port])

  async function action(operationId: string, work: (current: () => boolean) => Promise<void>) {
    if (running.current || !active.current) return
    running.current = true
    const token = revision.current
    function current() { return active.current && token === revision.current }
    setBusy(operationId); setError(null)
    try { await work(current) } catch (reason) { if (current()) setError(projectImportFailureMessage(reason)) }
    finally { running.current = false; if (current()) setBusy(null) }
  }

  async function inspect(operationId: string) {
    await action(operationId, async (current) => {
      const inspection = await port.inspect(operationId)
      if (current()) setInspections((previous) => ({ ...previous, [operationId]: inspection }))
    })
  }

  async function reselect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0], operationId = selectedOperation.current
    event.target.value = ''; selectedOperation.current = null
    if (!file || !operationId) return
    await action(operationId, async (current) => {
      try {
        const preview = await port.reselectFile(operationId, file)
        if (current()) onPreview(preview)
      } catch (reason) {
        if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'PROJECT_IMPORT_RECOVERY_REQUIRED') {
          const inspection = await port.inspect(operationId)
          if (current()) setInspections((previous) => ({ ...previous, [operationId]: inspection }))
          return
        }
        throw reason
      }
    })
  }

  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!running.current) onClose() }
    if (event.key !== 'Tab') return
    const controls = projectImportVisibleControls(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); dialog.current?.focus() }
    else if (!controls.some((control) => control === document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return <div className={`project-import-backdrop is-${appearance}`} onClick={() => { if (!running.current) onClose() }}>
    <section ref={dialog} className="project-import-dialog project-import-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="project-import-recovery-title" tabIndex={-1} aria-busy={Boolean(busy)} onKeyDown={keyboard} onClick={(event) => event.stopPropagation()}>
      <header><span><History size={20} /><h2 id="project-import-recovery-title">恢复未完成导入</h2></span><button type="button" aria-label="关闭导入恢复" disabled={Boolean(busy)} onClick={onClose}><X size={18} /></button></header>
      <input ref={fileInput} type="file" hidden accept=".json,.xingcanvas,application/json" onChange={(event) => void reselect(event)} />
      <div className="project-import-body" role="region" aria-label="原导入记录" tabIndex={0}>
        <p>这里保留当前账号在本浏览器发起的导入。先核对原结果；需要继续时，重新选择当时的同一个文件。</p>
        {!records.length && !error && <div className="project-import-note"><strong>没有待恢复的导入</strong><p>确认导入后，操作记录会保留到结果核对完成。关闭窗口或刷新不会删除已上传素材。</p></div>}
        {records.map((record) => {
          const inspection = inspections[record.operationId]
          const confirmed = inspection?.state === 'confirmed'
          const deleted = inspection?.state === 'deleted'
          const canReselect = inspection?.state === 'missing' || inspection?.state === 'verification-required'
          return <article key={record.operationId} className="project-import-recovery-record">
            <strong>{record.fileName}</strong><small>{projectImportBytes(record.fileBytes)} · {new Date(record.createdAt).toLocaleString('zh-CN')}</small>
            <p role="status">{projectImportRecoveryStatus(inspection)}</p>
            {canReselect && record.assets.length > 0 && <p>包内素材：{inspection.assets.filter((asset) => asset.state === 'ready').length} 项已确认 · {inspection.assets.filter((asset) => asset.state === 'pending').length} 项待核对 · {inspection.assets.filter((asset) => asset.state === 'missing').length} 项待上传</p>}
            <small className="project-import-recovery-id">原操作：{record.operationId}</small>
            {canReselect && <p>继续沿用原文件、素材回执和导入编号；重新选择文件只做预检，确认后才继续上传。</p>}
            {confirmed && inspection.project.archivedAt && <p>请到“我的画布”的归档列表恢复原工程后再打开。</p>}
            <div className="project-import-recovery-actions">
              <button type="button" disabled={Boolean(busy)} onClick={() => void inspect(record.operationId)}>{busy === record.operationId ? <LoaderCircle size={14} className="project-import-spin" /> : <History size={14} />}核对原结果</button>
              {canReselect && <button type="button" disabled={Boolean(busy)} onClick={() => { selectedOperation.current = record.operationId; fileInput.current?.click() }}><Upload size={14} />重选原文件继续</button>}
              {confirmed && !inspection.project.archivedAt && <button type="button" disabled={Boolean(busy)} onClick={() => void action(record.operationId, async (current) => { const fresh = await port.inspect(record.operationId); if (!current()) return; setInspections((previous) => ({ ...previous, [record.operationId]: fresh })); if (fresh.state === 'confirmed' && !fresh.project.archivedAt) await onOpen(fresh.project.id) })}><FolderOpen size={14} />打开原工程</button>}
              {(confirmed || deleted) && <button type="button" disabled={Boolean(busy)} onClick={() => void action(record.operationId, async (current) => { await port.finish(record.operationId); if (current()) setRecords(port.list()) })}>确认结果并移出恢复列表</button>}
            </div>
          </article>
        })}
        {error && <div className="project-import-note is-error" role="alert"><strong>恢复尚未完成</strong><p>{error}</p></div>}
        <p className="project-import-retention">浏览器仅保存文件摘要与操作编号，不保存文件内容或密钥。清理站点数据会丢失本地恢复记录，服务器上已完成的工程和素材仍保留。</p>
      </div>
      <footer><button type="button" disabled={Boolean(busy)} onClick={() => { try { setRecords(port.list()); setInspections({}); setError(null) } catch (reason) { setError(projectImportFailureMessage(reason)) } }}>重新读取本地记录</button><button type="button" disabled={Boolean(busy)} onClick={onClose}>关闭</button></footer>
    </section>
  </div>
}
