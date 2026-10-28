import { graphHasColorGradeProperty } from './color-grade-contract'

/** Explicit neutral, disabled, invalid and future values are still editable
 * data. Check presence before any older projection can discard that data. */
export function graphHasColorGradePresence(value: unknown): boolean {
  return graphHasColorGradeProperty(value, 'presence')
}

export function projectHasColorGradePresence(content: string): boolean {
  return graphHasColorGradePresence(JSON.parse(content))
}

export function assertColorGradePresenceClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的纹理、清晰度与去雾设置，请刷新页面后重试；未提交生成或覆盖工程')
}

/** Persisted workflows use settings; immutable run graphs use the flat field.
 * Reject every misplaced occurrence before the respective whitelist runs. */
export function assertColorGradePresencePlacement(kind: unknown, data: unknown, container: 'workflow' | 'run'): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const raw = data as Record<string, unknown>
  const flat = graphHasColorGradePresence({ nodes: [{ data: { imageTransform: raw.imageTransform } }] })
  const nested = graphHasColorGradePresence({ nodes: [{ data: { settings: raw.settings } }] })
  if (container === 'workflow' ? flat || kind !== 'image-layer' && nested : nested || kind !== 'image-layer' && flat) throw new Error('纹理、清晰度与去雾必须完整保存在图层合成节点的正确配置位置；不会丢弃字段后保存或运行')
}
