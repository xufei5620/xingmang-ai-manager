// React Flow ships English accessibility strings that reach screen readers and
// some focus states. Leaving them in place is a visible defect in a
// Chinese-language product, so the whole set is translated here rather than
// spot-patched at the call site.

export interface CanvasAriaLiveMove {
  direction: string
  x: number
  y: number
}

const directionLabels: Record<string, string> = {
  up: '上',
  down: '下',
  left: '左',
  right: '右',
}

export function canvasMoveDirectionLabel(direction: string): string {
  return directionLabels[direction] ?? direction
}

export const canvasAriaLabelConfig = {
  'node.a11yDescription.default': '按 Enter 或空格选中节点,按 Delete 删除,按 Esc 取消。',
  'node.a11yDescription.keyboardDisabled': '按 Enter 或空格选中节点,然后用方向键移动它,按 Delete 删除,按 Esc 取消。',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: CanvasAriaLiveMove) =>
    `已将选中节点向${canvasMoveDirectionLabel(direction)}移动。新位置 x:${x},y:${y}`,
  'edge.a11yDescription.default': '按 Enter 或空格选中连线,然后按 Delete 删除,按 Esc 取消。',
  'controls.ariaLabel': '画布控制',
  'controls.zoomIn.ariaLabel': '放大',
  'controls.zoomOut.ariaLabel': '缩小',
  'controls.fitView.ariaLabel': '适配全部内容',
  'controls.interactive.ariaLabel': '锁定或解锁画布交互',
  'minimap.ariaLabel': '缩略图',
  'handle.ariaLabel': '端口',
} as const
