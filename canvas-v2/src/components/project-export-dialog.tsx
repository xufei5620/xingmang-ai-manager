'use client'

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowDownToLine, CircleHelp, FileArchive, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { ProjectExportPreview, ProjectExportProgress } from '../lib/project-export-contract'
import { buildProjectExportPresentation, projectExportProgressLabel, projectExportReferenceLabel } from '../lib/project-export-model'
import { projectAssetNodeLabel, projectImportBytes } from '../lib/project-import-model'
import './project-export-dialog.css'

export interface ProjectExportDialogProps {
  preview: ProjectExportPreview | null
  preparing: boolean
  busy: boolean
  error?: string | null
  blocked?: boolean
  progress?: ProjectExportProgress
  allowExternalReferences: boolean
  onAllowExternalReferences(value: boolean): void
  onCancel(): void
  onConfirm(): void
}

export function projectExportVisibleControls<T extends { getClientRects(): { length: number } }>(controls: Iterable<T>): T[] {
  return [...controls].filter((control) => control.getClientRects().length > 0)
}

export default function ProjectExportDialog({ preview, preparing, busy, error, blocked, progress, allowExternalReferences, onAllowExternalReferences, onCancel, onConfirm }: ProjectExportDialogProps) {
  const dialog = useRef<HTMLElement>(null)
  const summary = preview ? buildProjectExportPresentation(preview) : null
  const progressLabel = projectExportProgressLabel(progress)
  const disabled = !summary || preparing || busy || blocked || !summary.canExport || summary.needsExternalConsent && !allowExternalReferences
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement) || !dialog.current?.contains(focused) || focused.matches(':disabled')) dialog.current?.focus()
  }, [busy, preparing, blocked])
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
    if (event.key !== 'Tab') return
    const controls = projectExportVisibleControls(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, a[href], [tabindex="0"]') ?? [])
    const first = controls[0]
    const last = controls.at(-1)
    if (!first) { event.preventDefault(); dialog.current?.focus() }
    else if (!controls.some((control) => control === document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return <div className="project-export-backdrop" onClick={onCancel}>
    <section ref={dialog} className="project-export-dialog" role="dialog" aria-modal="true" aria-labelledby="project-export-title" aria-describedby="project-export-description" aria-busy={preparing || busy} tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={keyboard}>
      <header><span><FileArchive size={21} /><h2 id="project-export-title">导出项目（含素材）</h2></span><button type="button" aria-label="取消项目导出" onClick={onCancel}><X size={18} /></button></header>
      <div className="project-export-body" role="region" aria-label="导出预检详情" tabIndex={0}>
        <p id="project-export-description">生成星芒画布网页便携包，携带工作流和已确认可读取的图片、视频与音频。此操作不保存新工程，也不调用生成模型。</p>
        <p className="project-export-footnote">网页便携包可在本站导入；旧桌面版本不支持此新版项目包。未携带的素材文件仍需另外保存。</p>
        {preparing && <div className="project-export-progress" role="status"><LoaderCircle size={17} className="project-export-spin" /><span>正在预检当前画布与素材清单，尚未读取素材文件或请求下载…</span></div>}
        {summary && preview && <>
          <div className="project-export-file"><strong>{preview.name}</strong><span>{preview.fileName}</span></div>
          <dl className="project-export-stats"><div><dt>节点</dt><dd>{summary.nodeCount}</dd></div><div><dt>连线</dt><dd>{summary.edgeCount}</dd></div><div><dt>携带文件</dt><dd>{summary.assetCount}</dd></div><div><dt>未携带文件引用</dt><dd>{summary.externalCount}</dd></div></dl>
          {summary.mediaCounts ? <dl className="project-export-media" aria-label="携带素材类型"><div><dt>图片</dt><dd>{summary.mediaCounts.image}</dd></div><div><dt>视频</dt><dd>{summary.mediaCounts.video}</dd></div><div><dt>音频</dt><dd>{summary.mediaCounts.audio}</dd></div></dl> : <p className="project-export-footnote">类型统计待核对；以下数量为已确认的文件总数。</p>}
          <div className="project-export-sizes"><span>素材文件总量<strong>{summary.assetSize}</strong></span><span>预计项目包大小<strong>{summary.estimatedSize}</strong></span></div>
          {summary.embeddedAssets.length > 0 && <details className="project-export-files"><summary>查看携带文件（{summary.embeddedAssets.length} 项）</summary><ul className="project-export-reference-list" tabIndex={0} aria-label="携带文件清单">{summary.embeddedAssets.map((asset) => <li key={asset.assetId}><strong>{asset.fileName || '原文件未提供名称'}</strong><span>{asset.mediaType === 'image' ? '图片' : asset.mediaType === 'video' ? '视频' : '音频'} · {projectImportBytes(asset.byteSize)} · 可携带</span><span>{projectAssetNodeLabel(asset)}</span><code>{asset.assetId}</code></li>)}</ul></details>}
          <p className="project-export-footnote">最多携带 64 项文件，单项不超过 32 MiB，项目包不超过 96 MiB。支持 PNG/JPEG/WebP 图片、MP4 视频与 MP3/WAV 音频；打包采用当前预览快照。</p>
          {summary.blockingReasons.length > 0 || !summary.canExport ? <div className="project-export-note is-error" role="alert"><strong>当前无法携素材导出</strong>{summary.blockingReasons.length > 0 ? <ul>{summary.blockingReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p>请关闭此窗口，核对素材和容量后重新预检。</p>}<small>超出容量的素材不会被自动忽略；同意保留外部引用也不能绕过这一限制。</small></div> : null}
          {summary.needsExternalConsent ? <div className="project-export-note is-warning"><strong><CircleHelp size={16} />有 {summary.externalCount} 个引用不携带文件</strong><p>回收站素材、不可读取或不支持的文件不会放入包中。保留这些引用不会携带文件，也不保证它们能在其他账户恢复。</p><details><summary>查看未携带文件的引用{summary.externalCount > 100 ? '（前 100 项）' : ''}</summary><ul className="project-export-reference-list" tabIndex={0} aria-label="未携带文件清单">{summary.externalReferences.map((asset) => <li key={asset.assetId}><strong>{asset.fileName || "文件名称不可用"}</strong><span>{projectExportReferenceLabel(asset.status, asset.mediaType)}</span><span>{projectAssetNodeLabel(asset)}</span><code>{asset.assetId}</code></li>)}</ul></details><label className="project-export-consent"><input type="checkbox" checked={allowExternalReferences} disabled={busy || blocked || !summary.canExport} onChange={(event) => onAllowExternalReferences(event.target.checked)} /><span>我同意保留未携带文件的引用，并继续导出。</span></label></div> : summary.canExport ? <p className="project-export-ready"><ShieldCheck size={16} />引用预检通过。确认后才读取素材并准备下载。</p> : null}
          {summary.warnings.length > 0 && <div className="project-export-note"><strong>导出前请留意</strong><ul>{summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>{summary.additionalWarnings > 0 && <small>另有 {summary.additionalWarnings} 条预检提示；请核对未携带文件的引用。</small>}</div>}
        </>}
        {busy && <div className="project-export-progress" role="status"><LoaderCircle size={17} className="project-export-spin" /><span>{progressLabel || '正在读取素材并打包，请稍候…'}</span></div>}
        {error && <div className="project-export-note is-error" role="alert"><strong>导出尚未确认</strong><p>{error}</p>{preview && !blocked && <small>可以取消，或保留本次预检后手动重试；不会自动重复下载。</small>}</div>}
        <p className="project-export-footnote">准备过程中可以随时取消。取消不会删除原素材或改变当前画布，也不能撤销已经交给浏览器的下载。</p>
      </div>
      <footer><button type="button" onClick={onCancel}>{preparing || busy ? '取消导出' : '取消'}</button><button type="button" className="is-primary" onClick={onConfirm} disabled={Boolean(disabled)}>{busy ? <LoaderCircle size={16} className="project-export-spin" /> : <ArrowDownToLine size={16} />}{busy ? '正在打包…' : error && preview ? '重试导出' : '确认并下载项目包'}</button></footer>
    </section>
  </div>
}
