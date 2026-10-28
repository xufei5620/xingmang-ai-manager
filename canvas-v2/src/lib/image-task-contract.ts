/** Detect presence, including malformed/future values, before old clients can strip semantics. */
export function graphHasImageTask(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const nodes = (value as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return false
  return nodes.some((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const data = (node as Record<string, unknown>).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    const record = data as Record<string, unknown>
    const settings = record.settings
    return [record, ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? [settings as Record<string, unknown>] : [])]
      .some((candidate) => Object.hasOwn(candidate, 'commerceTask') || Object.hasOwn(candidate, 'imageReferenceOrder'))
  })
}
export function projectHasImageTask(content: string): boolean { return graphHasImageTask(JSON.parse(content)) }
export function assertImageTaskClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的参考图创作配置，请刷新后重试；未提交模型或覆盖工程')
}
