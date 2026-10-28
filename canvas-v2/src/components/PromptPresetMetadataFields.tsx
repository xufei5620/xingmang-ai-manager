import { useId } from 'react'

export function PromptPresetMetadataFields({ group, description, groups, disabled, onGroup, onDescription }: { group: string; description: string; groups: readonly string[]; disabled?: boolean; onGroup(value: string): void; onDescription(value: string): void }) {
  const id = useId()
  return <>
    <label>分组<input value={group} list={id} maxLength={64} disabled={disabled} placeholder="留空为未分组，也可以输入新分组" onChange={(event) => onGroup(event.target.value)} /><datalist id={id}>{groups.map((item) => <option key={item} value={item} />)}</datalist></label>
    <label>简介<textarea value={description} maxLength={1000} rows={2} disabled={disabled} placeholder="适用场景、使用方法（可选）" onChange={(event) => onDescription(event.target.value)} /></label>
  </>
}
