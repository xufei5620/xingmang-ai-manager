import type { CanvasAssetReferenceReport } from '../host'
import { middleTruncate } from '../identifier-display'

export function assetReferenceScanIncomplete(report: CanvasAssetReferenceReport): boolean {
  return report.projectScanStatus === 'partial' || report.runScanStatus === 'partial'
    || report.runScanStatus === 'unavailable' || (report.invalidVersionCount ?? 0) > 0
}

export function AssetReferenceDetails({ report, loading, onCheckRunInputs }: {
  report: CanvasAssetReferenceReport
  loading: boolean
  onCheckRunInputs?(retryUnavailable?: boolean): void
}) {
  const incomplete = assetReferenceScanIncomplete(report)
  const historyAvailable = report.versions !== undefined || report.versionReferenceCount !== undefined || report.invalidVersionCount !== undefined
  const versions = report.versions ?? []
  return <>
    <p className={report.inUse || incomplete ? 'is-referenced' : 'is-clear'}>
      <strong>{incomplete ? '素材仍需保留，引用核查尚未完成' : report.inUse ? '素材仍被画布或历史记录引用' : '未发现工作流引用'}</strong>
      <span>{incomplete ? '部分记录尚未核对，请保留素材；本次不会删除文件。' : report.inUse ? '本次只读取引用；素材不会被永久删除。' : '引用检查已完成；本次只生成报告，没有删除文件。'}</span>
    </p>
    <dl className="asset-reference-summary">
      <div><dt>当前画布</dt><dd>{report.currentProject.nodeIds.length} 个节点</dd></div>
      <div><dt>已保存项目</dt><dd>{report.projectReferenceCount ?? report.projects.length} 个项目</dd></div>
      <div><dt>运行与候选</dt><dd>{report.runScanStatus === 'unavailable' ? '待核查' : `${report.runReferenceCount ?? report.runs.length} 条运行${report.runScanStatus === 'partial' ? ' · 未完整核查' : ''}`}</dd></div>
      {historyAvailable && <div><dt>历史版本与恢复点</dt><dd>{report.versionReferenceCount ?? versions.length} 条记录{(report.invalidVersionCount ?? 0) > 0 ? ' · 未完整核查' : ''}</dd></div>}
    </dl>
    {report.sharedProjectUse && <p role="status">素材仍被共享项目或其历史记录使用，暂时不能移入回收站。此处仅展示您自己项目的引用详情。</p>}
    {report.projectScanStatus === 'partial' && <p role="status">{report.invalidProjectCount ?? '部分'} 个工程内容无法读取，引用情况待核查。</p>}
    {report.runScanStatus === 'unavailable' && <p role="status">运行输入与候选记录尚未接入引用扫描。</p>}
    {(report.pendingRunInputCount ?? 0) > 0 && <p role="status">还有 {report.pendingRunInputCount} 条旧运行输入尚未核对，每次读取最多 5 条已保存输入。</p>}
    {(report.unreadableRunInputCount ?? 0) > 0 && <p role="status">{report.unreadableRunInputCount} 条运行输入无法读取，仍需保留素材；可稍后重试。</p>}
    {(report.invalidRunRecordCount ?? 0) > 0 && <p role="status">{report.invalidRunRecordCount} 条运行或恢复记录无法完整读取，引用情况待核查。</p>}
    {(report.invalidVersionCount ?? 0) > 0 && <p role="status">{report.invalidVersionCount} 条历史版本内容或素材引用索引无法完整读取，引用情况待核查；请保留素材。</p>}
    {onCheckRunInputs && ((report.pendingRunInputCount ?? 0) > 0 || (report.unreadableRunInputCount ?? 0) > 0) && <div className="asset-reference-actions">
      {(report.pendingRunInputCount ?? 0) > 0 && <button type="button" disabled={loading} onClick={() => onCheckRunInputs()}>继续核对旧运行输入</button>}
      {(report.unreadableRunInputCount ?? 0) > 0 && <button type="button" disabled={loading} onClick={() => onCheckRunInputs(true)}>重试不可读取的输入</button>}
      <small>只读取现有记录，不提交模型请求。</small>
    </div>}
    {report.projectDetailsTruncated && <p>已统计可读取工程，当前展示前 {Math.min(report.projects.length, 50)} 个引用工程的详情，其余详情暂未载入。</p>}
    {report.runDetailsTruncated && <p>已统计可读取运行，当前展示前 {Math.min(report.runs.length, 50)} 条引用运行的详情，其余详情暂未载入。</p>}
    {report.versionDetailsTruncated && <p>已统计可读取的历史引用，当前展示前 {Math.min(versions.length, 50)} 条历史版本或恢复点，其余详情暂未载入。</p>}
    {(report.projects.length > 0 || report.runs.length > 0 || versions.length > 0) && <div className="asset-reference-list">
      {report.projects.slice(0, 50).map((project) => <div key={`project:${project.projectId}`}><span><strong>{project.projectName}</strong><small>{project.archived ? '已归档项目' : '已保存项目'}</small></span><em>{project.nodeReferenceCount === null ? '—' : project.nodeReferenceCount ?? project.nodeIds.length} 个节点</em></div>)}
      {report.runs.slice(0, 50).map((run) => <div key={`run:${run.runId}`}><span><strong title={run.runId}>{middleTruncate(run.runId, 24)}</strong><small>{run.graphReferenceCount ?? '—'} 个输入快照引用 · {run.inputReferenceCount} 次实际输入 · {run.candidateReferenceCount} 个候选</small></span><em>{run.nodeReferenceCount ?? run.nodeIds.length} 个节点</em></div>)}
      {versions.slice(0, 50).map((version) => <div key={`version:${version.projectId}:${version.revisionId}`}><span><strong title={version.revisionId}>{version.projectName}</strong><small>{version.kind === 'restore-point' ? '恢复前版本（恢复点）' : '已保存历史版本'} · <time dateTime={version.savedAt}>{version.savedAt}</time></small></span><em>版本 {version.projectVersion}</em></div>)}
    </div>}
  </>
}
