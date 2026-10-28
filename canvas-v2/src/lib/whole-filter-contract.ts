/** Presence is checked before an older client can sanitize away ordered filters.
 * This does not validate parameters or grant access to a project or asset. */
export function graphHasWholeFilter(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const graph = value as Record<string, unknown>
  if (!Array.isArray(graph.nodes)) return false
  for (const raw of graph.nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const node = raw as Record<string, unknown>
    const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data as Record<string, unknown> : undefined
    const settings = data?.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings as Record<string, unknown> : undefined
    for (const candidate of [data?.imageTransform, settings?.imageTransform]) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const layers = (candidate as Record<string, unknown>).layers
      if (!Array.isArray(layers)) continue
      for (const layer of layers) {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue
        const edits = (layer as Record<string, unknown>).edits
        if (!edits || typeof edits !== 'object' || Array.isArray(edits)) continue
        const operations = (edits as Record<string, unknown>).operations
        if (Array.isArray(operations) && operations.some((operation) => operation && typeof operation === 'object' && !Array.isArray(operation) && operation.mode === 'whole-filter')) return true
      }
    }
  }
  return false
}

export function projectHasWholeFilter(content: string): boolean {
  return graphHasWholeFilter(JSON.parse(content))
}

export function assertWholeFilterClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的整层滤镜，请刷新后重试；未提交生成或覆盖工程')
}
