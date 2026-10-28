import type { CanvasGroupSummary } from '../host'
import { canvasNodeMediaKind } from '../library/node-model-availability'

export function NodeModelSourceSelect({ kind, group, sources, disabled, onChange }: { kind: string; group?: string; sources: readonly CanvasGroupSummary[]; disabled?: boolean; onChange(group: string | undefined): void }) {
  const purpose = canvasNodeMediaKind(kind)
  if (!purpose) return null
  const choices = sources.filter((source) => source.purposes === undefined || source.purposes.includes(purpose))
  const known = choices.some((source) => source.name === group)
  return <label className="wf-source-selection nodrag nowheel"><span>生成来源</span><select className="wf-model" aria-label="节点生成来源" value={group === undefined ? '' : group || '__invalid_source__'} disabled={disabled} onChange={(event) => {
    const value = event.target.value
    if (value === '') onChange(undefined)
    else if (choices.some((source) => source.name === value && (!source.connectionStatus || source.connectionStatus === 'ready'))) onChange(value)
  }}>
    <option value="">使用画布默认来源</option>
    {group !== undefined && !known && <option value={group || '__invalid_source__'} disabled>{group || '空值'}（固定来源已失效）</option>}
    {choices.map((source) => <option key={source.name} value={source.name} disabled={!!source.connectionStatus && source.connectionStatus !== 'ready'}>{source.description || source.name}{source.connectionStatus === 'untested' ? '（尚未检测）' : source.connectionStatus === 'failed' ? '（检测失败）' : ''}</option>)}
  </select></label>
}
