/** Presence is guarded before sanitization, including null and future versions. */
export function graphHasInteriorTask(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const nodes = (value as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return false
  return nodes.some((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const data = (node as Record<string, unknown>).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    const raw = data as Record<string, unknown>
    return Object.hasOwn(raw, 'interiorTask') || !!raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) && Object.hasOwn(raw.settings, 'interiorTask')
  })
}
export function projectHasInteriorTask(content: string): boolean { return graphHasInteriorTask(JSON.parse(content)) }
export function assertInteriorTaskClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的室内创作配置，请刷新后重试；未提交模型或覆盖工程')
}
