import type { CanvasShortcut, CanvasShortcutEvent } from './shortcuts'

interface ShortcutHelpItem {
  command: CanvasShortcut
  label: string
  event: CanvasShortcutEvent
}

export interface ShortcutHelpGroup {
  title: string
  hint: string
  items: readonly ShortcutHelpItem[]
}

export const canvasShortcutHelp: readonly ShortcutHelpGroup[] = [
  {
    title: '创作与查看',
    hint: '快速找到节点、素材和画布视图',
    items: [
      { command: 'quick-insert', label: '快速添加节点', event: { key: 'k', ctrlKey: true } },
      { command: 'find-node', label: '查找画布中的节点', event: { key: 'f', ctrlKey: true } },
      { command: 'toggle-assets', label: '打开 / 收起素材面板', event: { key: 'a' } },
      { command: 'toggle-overview', label: '适应整图 / 返回原视图', event: { key: 'z' } },
      { command: 'paste', label: '粘贴已复制的节点', event: { key: 'v', ctrlKey: true } },
    ],
  },
  {
    title: '选中内容',
    hint: '先选中节点，再执行这些操作',
    items: [
      { command: 'copy', label: '复制选中节点', event: { key: 'c', ctrlKey: true } },
      { command: 'duplicate', label: '创建选中节点的副本', event: { key: 'd', ctrlKey: true } },
      { command: 'delete', label: '删除选中节点 / 连线', event: { key: 'Delete' } },
      { command: 'group', label: '将选中节点编组', event: { key: 'g', ctrlKey: true } },
      { command: 'ungroup', label: '解除选中分组', event: { key: 'g', ctrlKey: true, shiftKey: true } },
    ],
  },
  {
    title: '整张画布与历史',
    hint: '排列作用于整图；运行沿用顶部所选范围',
    items: [
      { command: 'undo', label: '撤销上一步', event: { key: 'z', ctrlKey: true } },
      { command: 'redo', label: '重做上一步', event: { key: 'z', ctrlKey: true, shiftKey: true } },
      { command: 'select-all', label: '选中全部节点', event: { key: 'a', ctrlKey: true } },
      { command: 'layout', label: '自动排列整图', event: { key: 'l', ctrlKey: true } },
      { command: 'save', label: '下载工作流文件', event: { key: 's', ctrlKey: true } },
      { command: 'open', label: '打开工作流文件', event: { key: 'o', ctrlKey: true } },
      { command: 'run', label: '运行当前范围', event: { key: 'Enter', ctrlKey: true } },
    ],
  },
]

export function canvasShortcutKeyLabels(event: CanvasShortcutEvent): string[] {
  return [
    ...(event.ctrlKey || event.metaKey ? ['⌘ / Ctrl'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
    event.key.length === 1 ? event.key.toUpperCase() : event.key,
  ]
}
