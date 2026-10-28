import { graphHasColorGradeProperty } from './color-grade-contract'

/** Explicit neutral, disabled, invalid and future values are still editable
 * data. Check calibration before any older projection can discard that data. */
export function graphHasColorGradeCalibration(value: unknown): boolean {
  return graphHasColorGradeProperty(value, 'calibration')
}

export function projectHasColorGradeCalibration(content: string): boolean {
  return graphHasColorGradeCalibration(JSON.parse(content))
}

export function assertColorGradeCalibrationClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的阴影色调与 RGB 原色校准设置，请刷新页面后重试；未提交生成或覆盖工程')
}

/** Persisted workflows use settings; immutable run graphs use the flat field.
 * Reject every misplaced occurrence before the respective whitelist runs. */
export function assertColorGradeCalibrationPlacement(kind: unknown, data: unknown, container: 'workflow' | 'run'): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const raw = data as Record<string, unknown>
  const flat = graphHasColorGradeCalibration({ nodes: [{ data: { imageTransform: raw.imageTransform } }] })
  const nested = graphHasColorGradeCalibration({ nodes: [{ data: { settings: raw.settings } }] })
  if (container === 'workflow' ? flat || kind !== 'image-layer' && nested : nested || kind !== 'image-layer' && flat) throw new Error('阴影色调与 RGB 原色校准必须完整保存在图层合成节点的正确配置位置；不会丢弃字段后保存或运行')
}
