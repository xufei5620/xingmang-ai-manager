'use client'

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowRight, CircleHelp, LoaderCircle, ShieldCheck, Upload, Workflow, X } from 'lucide-react'
import { buildProjectImportPresentation, projectImportProgressLabel, projectAssetNodeLabel, projectImportBytes, type ProjectImportPreview, type ProjectImportProgress } from '../lib/project-import-model'
import './project-import-dialog.css'

export interface ProjectImportDialogProps {
  preview: ProjectImportPreview
  busy: boolean
  error?: string | null
  blocked?: boolean
  progress?: ProjectImportProgress
  appearance?: 'workspace' | 'canvas'
  purpose?: 'file' | 'assets'
  onCancel(): void
  onConfirm(): void
}

export function projectImportVisibleControls<T extends { getClientRects(): { length: number } }>(controls: Iterable<T>): T[] {
  // Closed details retain their descendants in DOM queries but cannot receive focus.
  return [...controls].filter((control) => control.getClientRects().length > 0)
}

export function ProjectImportDetails({ preview }: { preview: ProjectImportPreview }) {
  const summary = buildProjectImportPresentation(preview)
  const requiresOriginalAssets = preview.originalImportPolicy === 'reject' && summary.missingCount > 0
  return <div className="project-import-details">
    <div className="project-import-file"><strong>{preview.workflowName}</strong><span title={preview.name}>{preview.name} · {summary.fileSize}</span></div>
    <dl className="project-import-stats">
      <div><dt>节点</dt><dd>{summary.nodeCount}</dd></div><div><dt>连线</dt><dd>{summary.edgeCount}</dd></div>
      <div><dt>{preview.createsProject ? '账户可用引用' : '本地可用素材'}</dt><dd>{summary.availableCount}</dd></div>
      <div className={summary.missingCount ? 'has-missing' : ''}><dt>缺失外部引用</dt><dd>{summary.missingCount}</dd></div>
    </dl>
    <div className="project-import-embedded"><strong>包内可迁入素材：{summary.embeddedCount} 项 · {summary.embeddedSize}</strong>
      {summary.mediaCounts ? <dl className="project-import-media" aria-label="包内素材类型"><div><dt>图片</dt><dd>{summary.mediaCounts.image}</dd></div><div><dt>视频</dt><dd>{summary.mediaCounts.video}</dd></div><div><dt>音频</dt><dd>{summary.mediaCounts.audio}</dd></div></dl> : summary.embeddedCount > 0 && <p>此预览未提供类型统计，文件总数已核对。</p>}
      {summary.embeddedAssets.length > 0 && <details><summary>查看包内文件（{summary.embeddedAssets.length} 项）</summary><ul className="project-import-missing-list" tabIndex={0} aria-label="包内文件清单">{summary.embeddedAssets.map((asset) => <li key={asset.assetId}><strong>{asset.fileName || '原文件未提供名称'}</strong><span>{asset.mediaType === 'image' ? '图片' : asset.mediaType === 'video' ? '视频' : '音频'} · {projectImportBytes(asset.byteSize)} · 可迁入</span><span>{projectAssetNodeLabel(asset)}</span><code>{asset.assetId}</code></li>)}</ul></details>}
      <p>{summary.embeddedCount ? '这些素材已经过本机预检。确认后才会上传并重映射到当前账户，不能把它们当作缺失素材移除。' : '此文件不含可迁入素材；可用素材引用会保留。'}</p></div>
    {summary.provenance.length ? <details className="project-import-provenance"><summary>原文件来源声明（{summary.provenance.length} 项）</summary><p>来源声明由原文件提供；保留声明不等于授予额外使用许可。请按原许可及素材权利决定使用范围。</p><ol tabIndex={0} aria-label="原文件来源声明列表">{summary.provenance.map((source, index) => <li key={index}><strong>{source.name}</strong><div><span>许可声明</span><p>{source.license}</p></div>{source.notice !== undefined && source.notice.length > 0 && <div><span>原文件附注</span><p>{source.notice}</p></div>}</li>)}</ol></details>
      : <p className="project-import-source-unknown">原文件未提供来源声明，来源未知；请自行核对使用许可。此处不会补填或推断许可证。</p>}
    {summary.warnings.length > 0 && <div className="project-import-note"><strong>导入前请留意</strong><ul>{summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>{summary.additionalWarnings > 0 && <small>另有 {summary.additionalWarnings} 条预检提示；导入后可在工程中继续核对。</small>}</div>}
    {summary.missingCount ? <div className="project-import-note is-warning"><strong><CircleHelp size={15} />外部素材未在当前账户找到，或已不可读取</strong><p>{requiresOriginalAssets ? '原导入要求保留全部素材。请先在素材库恢复这些文件，再重新核对原导入；当前不会移除引用或继续创建。' : <>继续会移除这 {summary.missingCount} 个引用，保留节点与连线。包内可迁入素材会按计划迁入；取消会保留当前画布。</>}</p>{summary.missingAssets.length > 0 && <details><summary>查看缺失引用{summary.missingCount > 100 ? '（前 100 项）' : ''}</summary><ul className="project-import-missing-list" tabIndex={0} aria-label="缺失素材清单">{summary.missingAssets.map((asset) => <li key={asset.assetId}><span>{projectAssetNodeLabel(asset)}</span><code>{asset.assetId}</code></li>)}</ul></details>}</div>
      : <p className="project-import-ready"><ShieldCheck size={16} />引用预检通过。确认后会保留可用引用并迁入包内素材。</p>}
  </div>
}

export default function ProjectImportDialog({ preview, busy, error, blocked, progress, appearance = 'workspace', purpose = 'file', onCancel, onConfirm }: ProjectImportDialogProps) {
  const dialog = useRef<HTMLElement>(null)
  const progressLabel = projectImportProgressLabel(progress)
  const missing = (preview.missingAssetCount ?? 0) > 0
  const assetCreation = purpose === 'assets'
  const resuming = preview.resumingImport === true
  const requiresOriginalAssets = preview.originalImportPolicy === 'reject' && missing
  const assetSummary = assetCreation ? buildProjectImportPresentation(preview) : null
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement) || !dialog.current?.contains(focused) || focused.matches(':disabled')) dialog.current?.focus()
  }, [busy, blocked])
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel() }
    if (event.key !== 'Tab') return
    const controls = projectImportVisibleControls(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], [tabindex="0"]') ?? [])
    const first = controls[0]
    const last = controls.at(-1)
    if (!first) { event.preventDefault(); dialog.current?.focus() }
    else if (!controls.some((control) => control === document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return <div className={`project-import-backdrop is-${appearance}`} onClick={() => { if (!busy) onCancel() }}>
    <section ref={dialog} className="project-import-dialog" role="dialog" aria-modal="true" aria-labelledby="project-import-title" aria-describedby="project-import-description" aria-busy={busy} tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={keyboard}>
      <header><span><Workflow size={20} /><h2 id="project-import-title">{assetCreation ? '用所选素材创建画布' : resuming ? '继续原导入' : '确认导入项目'}</h2></span><button type="button" aria-label={assetCreation ? '取消素材创作' : '取消项目导入'} disabled={busy} onClick={onCancel}><X size={18} /></button></header>
      <div className="project-import-body" role="region" aria-label="导入预检详情" tabIndex={0}>
        <p id="project-import-description">{assetCreation ? '所选素材将按当前排列顺序放入独立画布。确认后即可继续连线、处理和创作。' : resuming ? '已找回原导入编号。确认后会核对已有素材，只迁入尚未完成的文件，并继续原工程创建。' : preview.createsProject ? '预检没有上传素材或创建工程。确认后迁入素材，再建立独立画布并打开编辑。' : '确认后迁入包内素材并替换当前工作流；取消保留当前画布。'}</p>
        {resuming && preview.originalImportPolicy && <p className="project-import-retention">{preview.originalImportPolicy === 'drop' ? '沿用原导入规则：保留当前可用素材，只移除仍然缺失的外部引用。' : '沿用原导入规则：保留全部素材；有缺失时先恢复原素材。'}</p>}
        {!assetCreation && <p className="project-import-retention">支持普通工作流及第 1–7 版项目包（含网页便携包与完整图像调整）。普通工作流限 2 MiB；项目包限 96 MiB，最多 64 项文件，单项限 32 MiB。未内嵌文件会单独核对，不会自动下载外部地址。</p>}
        {assetCreation && assetSummary ? <div className="project-import-details"><div className="project-import-file"><strong>{preview.workflowName}</strong></div><dl className="project-import-stats"><div><dt>素材节点</dt><dd>{assetSummary.nodeCount}</dd></div><div><dt>可用素材</dt><dd>{assetSummary.availableCount}</dd></div><div><dt>不可用素材</dt><dd>{assetSummary.missingCount}</dd></div></dl><p className={missing ? 'project-import-note is-warning' : 'project-import-ready'}>{missing ? '部分素材已不可用，请取消并在素材库中核对后重新选择。' : '素材已核对。创建会复用当前账号中的原文件，不会生成新内容或消耗模型额度。'}</p></div> : <ProjectImportDetails preview={preview} />}
        {busy && <div className="project-import-progress" role="status"><LoaderCircle size={16} className="project-import-spin" /><span>{assetCreation ? '正在核对素材并创建画布，请稍候…' : progressLabel || '正在核对、迁入素材并确认工程，请稍候…'}</span></div>}
        {error && <div className="project-import-note is-error" role="alert"><strong>{assetCreation ? '画布创建尚未完成' : '导入尚未完成'}</strong><p>{error}</p>{!blocked && <small>{assetCreation ? '当前创建记录已保留。继续会核对并沿用同一次创建操作。' : '预览与原导入编号已保留。“继续导入”会核对已有素材，并沿用同一次工程创建操作。'}</small>}</div>}
        <p className="project-import-retention">{assetCreation ? '原素材会保留在素材库。取消准备不会创建画布；提交后关闭页面不会撤销已经完成的创建。' : '确认后已上传的素材会保留在素材库；取消或关闭页面不会删除它们，也不会撤销服务器已经完成的操作。'}</p>
      </div>
      <footer><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className="is-primary" onClick={onConfirm} disabled={busy || blocked || requiresOriginalAssets || assetCreation && missing}>{busy ? <LoaderCircle size={15} className="project-import-spin" /> : <Upload size={15} />}{assetCreation ? busy ? '正在创建…' : error ? '继续创建' : '确认创建画布' : busy ? '正在导入…' : requiresOriginalAssets ? '请先恢复原素材' : error || resuming ? missing ? '继续导入并移除缺失引用' : '继续导入' : missing ? '移除缺失外部引用并导入' : '确认导入'}{!busy && <ArrowRight size={15} />}</button></footer>
    </section>
  </div>
}
