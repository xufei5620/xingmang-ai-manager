import type { CanvasAlignMode, CanvasDistributeAxis } from '../editor/align'

export type SelectionToolbarMenuKind = 'layout' | 'more' | 'run'
export type SelectionToolbarActionId = `align:${CanvasAlignMode}` | `distribute:${CanvasDistributeAxis}` | 'inspect' | 'focus' | 'copy' | 'duplicate' | 'save' | 'agent' | 'lock' | 'disable' | 'group' | 'ungroup' | 'delete' | 'batch-images' | 'run-to' | 'run-from'
export interface SelectionToolbarAction {
  id: SelectionToolbarActionId
  label: string
  ariaLabel: string
  section: string
  disabledReason?: string
  shortcut?: string
  checked?: boolean
  danger?: boolean
}
export interface SelectionToolbarState {
  readOnly?: boolean
  count: number
  canGroup: boolean
  canUngroup: boolean
  allLocked: boolean
  canToggleDisabled: boolean
  allDisabled: boolean
  canSaveWorkshop: boolean
  canSendAgent?: boolean
  agentDisabledReason?: string
  hasBatchImages?: boolean
  batchImagesDisabledReason?: string
  hasRunActions?: boolean
  runDisabledReason?: string
}

export function selectionToolbarActions(state: SelectionToolbarState, menu: SelectionToolbarMenuKind): SelectionToolbarAction[] {
  if (state.readOnly) return menu === 'more' ? [
    { id: 'inspect', label: '查看详情', ariaLabel: '查看选中节点详情', section: '查看' },
    { id: 'focus', label: '聚焦选区', ariaLabel: '聚焦选中节点', section: '查看' },
    { id: 'copy', label: '复制', ariaLabel: '复制选中节点', section: '复用', shortcut: '⌘ / Ctrl C' },
  ] : []
  if (menu === 'run') return state.count === 1 && state.hasRunActions ? [
    { id: 'run-to', label: '运行到此', ariaLabel: '运行到此', section: '执行该节点及所需上游', disabledReason: state.runDisabledReason },
    { id: 'run-from', label: '从此向后', ariaLabel: '从此向后', section: '执行下游链路及必要依赖', disabledReason: state.runDisabledReason },
  ] : []
  if (menu === 'layout') {
    const align: readonly [CanvasAlignMode, string][] = [['left', '左对齐'], ['horizontal-center', '水平居中'], ['right', '右对齐'], ['top', '顶对齐'], ['vertical-center', '垂直居中'], ['bottom', '底对齐']]
    const distribute: readonly [CanvasDistributeAxis, string][] = [['horizontal', '水平均分间距'], ['vertical', '垂直均分间距']]
    return [
      ...align.map(([mode, label]): SelectionToolbarAction => ({ id: `align:${mode}`, label, ariaLabel: label, section: '对齐', ...(state.count < 2 ? { disabledReason: '至少选择 2 个独立节点才能对齐。' } : {}) })),
      ...distribute.map(([axis, label]): SelectionToolbarAction => ({ id: `distribute:${axis}`, label, ariaLabel: label, section: '分布', ...(state.count < 3 ? { disabledReason: '至少选择 3 个独立节点才能均分间距。' } : {}) })),
    ]
  }
  return [
    { id: 'inspect', label: '查看详情', ariaLabel: '查看选中节点详情', section: '查看' },
    { id: 'focus', label: '聚焦选区', ariaLabel: '聚焦选中节点', section: '查看' },
    ...(state.canSendAgent ? [{ id: 'agent' as const, label: '发送给 Agent', ariaLabel: '将选中节点和当前图片加入 Agent', section: '创作', disabledReason: state.agentDisabledReason }] : []),
    ...(state.hasBatchImages ? [{ id: 'batch-images' as const, label: '关联图片工具', ariaLabel: '关联选中图片到图像工具', section: '创作', disabledReason: state.batchImagesDisabledReason }] : []),
    { id: 'copy', label: '复制', ariaLabel: '复制选中节点', section: '复用', shortcut: '⌘ / Ctrl C' },
    { id: 'duplicate', label: '创建副本', ariaLabel: '复制并粘贴选中节点', section: '复用', shortcut: '⌘ / Ctrl D' },
    ...(state.canSaveWorkshop ? [{ id: 'save' as const, label: '保存到创意工坊', ariaLabel: '保存选区到创意工坊', section: '复用' }] : []),
    { id: 'lock', label: state.allLocked ? '解锁位置' : '锁定位置', ariaLabel: state.allLocked ? '解锁选中节点位置' : '锁定选中节点位置', section: '节点', checked: state.allLocked },
    { id: 'disable', label: state.allDisabled ? '启用节点运行' : '跳过节点运行', ariaLabel: state.allDisabled ? '启用选中节点' : '禁用选中节点', section: '节点', checked: state.allDisabled, ...(!state.canToggleDisabled ? { disabledReason: '选区中没有可切换运行状态的节点；分组和未知节点不参与运行。' } : {}) },
    { id: 'group', label: '编组', ariaLabel: '将选中节点分组', section: '节点', shortcut: '⌘ / Ctrl G', ...(!state.canGroup ? { disabledReason: '请选择至少 2 个同一父级的独立节点；分组与其子节点按一个整体计算。' } : {}) },
    { id: 'ungroup', label: '解散分组', ariaLabel: '取消选中分组', section: '节点', shortcut: '⌘ / Ctrl ⇧ G', ...(!state.canUngroup ? { disabledReason: '请先选中一个分组。' } : {}) },
    { id: 'delete', label: '删除', ariaLabel: '删除选中节点', section: '移除', shortcut: 'Delete', danger: true },
  ]
}

export interface SelectionMenuRect { left: number; right: number; top: number; bottom: number }
export interface SelectionMenuViewport { left: number; top: number; width: number; height: number }
export interface SelectionMenuPosition { left: number; top: number; width: number; maxHeight: number }

/** Use viewport pixels: the portal must not inherit canvas zoom or sidebar clipping. */
export function positionSelectionMenu(anchor: SelectionMenuRect, viewport: SelectionMenuViewport, height: number): SelectionMenuPosition {
  const margin = Math.min(8, viewport.width / 4, viewport.height / 4), gap = 6
  const width = Math.max(1, Math.min(304, viewport.width - margin * 2))
  const available = Math.max(1, viewport.height - margin * 2)
  const below = Math.max(0, Math.min(available, viewport.top + viewport.height - margin - anchor.bottom - gap))
  const above = Math.max(0, Math.min(available, anchor.top - viewport.top - margin - gap))
  const overlay = Math.max(above, below) < Math.min(180, available)
  const useBelow = below >= Math.min(height, 360, available) || below >= above
  const maxHeight = Math.min(560, overlay ? available : useBelow ? below : above)
  const visibleHeight = Math.min(Math.max(1, height), maxHeight)
  const top = overlay ? viewport.top + margin : useBelow ? anchor.bottom + gap : anchor.top - gap - visibleHeight
  return {
    left: Math.max(viewport.left + margin, Math.min(anchor.right - width, viewport.left + viewport.width - margin - width)),
    top: Math.max(viewport.top + margin, Math.min(top, viewport.top + viewport.height - margin - visibleHeight)),
    width, maxHeight,
  }
}

export function selectionMenuKey(key: string, current: number, count: number): { kind: 'close' | 'tab' } | { kind: 'focus'; index: number } | null {
  if (key === 'Escape') return { kind: 'close' }
  if (key === 'Tab') return { kind: 'tab' }
  if (!count) return null
  if (key === 'Home') return { kind: 'focus', index: 0 }
  if (key === 'End') return { kind: 'focus', index: count - 1 }
  if (key === 'ArrowDown') return { kind: 'focus', index: current < 0 ? 0 : (current + 1) % count }
  if (key === 'ArrowUp') return { kind: 'focus', index: current < 0 ? count - 1 : (current + count - 1) % count }
  return null
}
