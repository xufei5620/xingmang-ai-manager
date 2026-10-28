import { useId, useState } from 'react'
import { CanvasWorkshopDialogFrame as DialogFrame } from './CanvasWorkshopDialogFrame'

export function CanvasNodeRenameDialog({ name, onConfirm, onClose }: { name: string; onConfirm(name: string): void; onClose(): void }) {
  const inputId = useId()
  const [value, setValue] = useState(name)
  return <DialogFrame title="重命名节点" label="节点设置" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (value.trim()) onConfirm(value.trim()) }}><label htmlFor={inputId}>节点名称<input id={inputId} autoFocus maxLength={160} value={value} onChange={(event) => setValue(event.target.value)} required /></label><footer><button type="button" onClick={onClose}>取消</button><button type="submit" className="is-primary" disabled={!value.trim()}>保存名称</button></footer></form></DialogFrame>
}
