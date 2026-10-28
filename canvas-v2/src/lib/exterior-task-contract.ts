/** Presence must be tested before a sanitizer can discard future task metadata. */
export function graphHasExteriorTask(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const nodes = (value as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return false
  return nodes.some((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const data = (node as Record<string, unknown>).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    const raw = data as Record<string, unknown>
    return Object.hasOwn(raw, 'exteriorTask') || !!raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) && Object.hasOwn(raw.settings, 'exteriorTask')
  })
}
export function projectHasExteriorTask(content: string): boolean { return graphHasExteriorTask(JSON.parse(content)) }
export function assertExteriorTaskClientVersion(version: unknown, required: boolean): void { if (required && version !== 1) throw new Error('当前页面版本不支持此工程的室外创作配置，请刷新后重试；未提交模型或覆盖工程') }
