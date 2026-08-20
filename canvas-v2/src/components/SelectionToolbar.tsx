import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround,
  Copy, Focus, Group, Lock, LockOpen, Power, PowerOff, Trash2, Ungroup,
} from 'lucide-react'
import type { CanvasAlignMode, CanvasDistributeAxis } from '../editor/align'

const alignActions: readonly { mode: CanvasAlignMode; label: string; Icon: typeof AlignStartVertical }[] = [
  { mode: 'left', label: '左对齐', Icon: AlignStartVertical },
  { mode: 'horizontal-center', label: '水平居中', Icon: AlignCenterVertical },
  { mode: 'right', label: '右对齐', Icon: AlignEndVertical },
  { mode: 'top', label: '顶对齐', Icon: AlignStartHorizontal },
  { mode: 'vertical-center', label: '垂直居中', Icon: AlignCenterHorizontal },
  { mode: 'bottom', label: '底对齐', Icon: AlignEndHorizontal },
]

const distributeActions: readonly { axis: CanvasDistributeAxis; label: string; Icon: typeof AlignStartVertical }[] = [
  { axis: 'horizontal', label: '水平均分间距', Icon: AlignHorizontalSpaceAround },
  { axis: 'vertical', label: '垂直均分间距', Icon: AlignVerticalSpaceAround },
]

interface SelectionToolbarProps {
  count: number
  canGroup: boolean
  canUngroup: boolean
  allLocked: boolean
  canToggleDisabled: boolean
  allDisabled: boolean
  onAlign(mode: CanvasAlignMode): void
  onDistribute(axis: CanvasDistributeAxis): void
  onCopy(): void
  onDuplicate(): void
  onGroup(): void
  onUngroup(): void
  onToggleLocked(): void
  onToggleDisabled(): void
  onFocus(): void
  onDelete(): void
}

export function SelectionToolbar({ count, canGroup, canUngroup, allLocked, canToggleDisabled, allDisabled, onAlign, onDistribute, onCopy, onDuplicate, onGroup, onUngroup, onToggleLocked, onToggleDisabled, onFocus, onDelete }: SelectionToolbarProps) {
  if (count === 0) return null
  return (
    <div className="canvas-selection-toolbar" role="toolbar" aria-label="选中节点操作">
      <span>{count} 个节点</span>
      {count > 1 && <span className="canvas-selection-toolbar-group">
        {alignActions.map(({ mode, label, Icon }) => (
          <button key={mode} type="button" title={label} aria-label={label} onClick={() => onAlign(mode)}><Icon size={14} /></button>
        ))}
        {distributeActions.map(({ axis, label, Icon }) => (
          <button key={axis} type="button" title={label} aria-label={label} disabled={count < 3} onClick={() => onDistribute(axis)}><Icon size={14} /></button>
        ))}
      </span>}
      <button type="button" title="复制" aria-label="复制选中节点" onClick={onCopy}><Copy size={14} /></button>
      <button type="button" title="复制并粘贴" aria-label="复制并粘贴选中节点" onClick={onDuplicate}><Copy size={14} /><small>+</small></button>
      <button type="button" title="聚焦" aria-label="聚焦选中节点" onClick={onFocus}><Focus size={14} /></button>
      <button
        type="button"
        title={allLocked ? '解锁位置' : '锁定位置'}
        aria-label={allLocked ? '解锁选中节点位置' : '锁定选中节点位置'}
        aria-pressed={allLocked}
        onClick={onToggleLocked}
      >{allLocked ? <LockOpen size={14} /> : <Lock size={14} />}</button>
      <button
        type="button"
        title={allDisabled ? '启用节点' : '禁用节点'}
        aria-label={allDisabled ? '启用选中节点' : '禁用选中节点'}
        aria-pressed={allDisabled}
        disabled={!canToggleDisabled}
        onClick={onToggleDisabled}
      >{allDisabled ? <Power size={14} /> : <PowerOff size={14} />}</button>
      <button type="button" title="分组" aria-label="将选中节点分组" disabled={!canGroup} onClick={onGroup}><Group size={14} /></button>
      <button type="button" title="取消分组" aria-label="取消选中分组" disabled={!canUngroup} onClick={onUngroup}><Ungroup size={14} /></button>
      <button type="button" className="is-danger" title="删除" aria-label="删除选中节点" onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  )
}
