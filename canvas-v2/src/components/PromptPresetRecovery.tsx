import type { CanvasPromptPreset } from '../library/prompt-preset-contract'
import type { RefObject } from 'react'

export interface PromptPresetRecoveryProps {
  conflict: boolean
  editing: boolean
  latest: CanvasPromptPreset | null
  matched: boolean
  readComplete: boolean
  loading: boolean
  readButtonRef?: RefObject<HTMLButtonElement | null>
  onRead(): void
  onKeep(): void
  onReload(): void
}

export function PromptPresetRecovery(props: PromptPresetRecoveryProps) {
  return <div className="xm-workshop-recovery wf-shortcut-recovery" role="group" aria-label="提示词保存恢复">
    <p role="status">{props.conflict ? '版本冲突：其他页面已修改此模板，本次修改未保存。' : props.readComplete && props.matched ? '已读取到内容一致的已保存条目。' : '保存结果待核对，输入继续保留。'}{!props.readComplete && '请先读取最新版本。'}</p>
    <button ref={props.readButtonRef} type="button" className="xm-button xm-button-secondary" disabled={props.loading} onClick={props.onRead}>{props.loading ? '正在读取…' : '读取最新版本'}</button>
    {props.readComplete && props.latest && <>
      <details><summary>查看服务器最新版本 · v{props.latest.version ?? 1}</summary><dl><dt>名称</dt><dd>{props.latest.name}</dd><dt>分组</dt><dd>{props.latest.group || '未分组'}</dd><dt>简介</dt><dd>{props.latest.description || '无'}</dd></dl><pre style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{props.latest.prompt}</pre></details>
      {props.editing && !props.matched && <button type="button" className="xm-button xm-button-secondary" disabled={props.loading} onClick={props.onKeep}>保留我的输入，基于最新版本继续编辑</button>}
      <button type="button" className="xm-button xm-button-secondary" disabled={props.loading} onClick={props.onReload}>{props.matched ? '已核对，编辑已保存条目' : '放弃我的输入，加载服务器版本'}</button>
    </>}
    {props.readComplete && !props.latest && <p role="status">{props.editing ? '未找到此模板，可能已被删除。输入仍保留，可复制后取消编辑。' : '未找到完全相同的已保存条目。请保留输入并稍后再次核对，避免重复新建。'}</p>}
  </div>
}
