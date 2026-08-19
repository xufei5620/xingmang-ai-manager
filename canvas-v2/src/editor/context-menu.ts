export type CanvasContextTarget = 'node' | 'selection'

export type CanvasContextAction =
  | 'run'
  | 'locate'
  | 'copy'
  | 'duplicate'
  | 'group'
  | 'ungroup'
  | 'lock'
  | 'unlock'
  | 'disable'
  | 'enable'
  | 'delete'

export interface CanvasContextMenuItem {
  action: CanvasContextAction
  label: string
  danger?: boolean
  separatorBefore?: boolean
}

export interface CanvasContextMenuInput {
  target: CanvasContextTarget
  selectionCount: number
  executable: boolean
  running: boolean
  hasGroup: boolean
  allLocked: boolean
  allDisabled: boolean
  canDisable: boolean
}

/**
 * Items for the node and selection context menus. Kept as data so the set can
 * be asserted directly, rather than only through a rendered DOM the repo has
 * no environment to render (T7).
 */
export function canvasContextMenuItems(input: CanvasContextMenuInput): CanvasContextMenuItem[] {
  const items: CanvasContextMenuItem[] = []
  const single = input.target === 'node' && input.selectionCount <= 1

  if (single && input.executable) {
    items.push({ action: 'run', label: input.running ? '运行中' : '运行此节点' })
  }
  if (single) items.push({ action: 'locate', label: '定位到此节点' })

  items.push({ action: 'copy', label: '复制', separatorBefore: items.length > 0 })
  items.push({ action: 'duplicate', label: '创建副本' })

  if (input.selectionCount > 1) items.push({ action: 'group', label: '编组', separatorBefore: true })
  if (input.hasGroup) {
    items.push({ action: 'ungroup', label: '解散分组', separatorBefore: input.selectionCount <= 1 })
  }

  items.push({
    action: input.allLocked ? 'unlock' : 'lock',
    label: input.allLocked ? '解锁位置' : '锁定位置',
    separatorBefore: true,
  })
  if (input.canDisable) {
    items.push({
      action: input.allDisabled ? 'enable' : 'disable',
      label: input.allDisabled ? '启用' : '跳过运行',
    })
  }

  items.push({ action: 'delete', label: '删除', danger: true, separatorBefore: true })
  return items
}
