/** Inspect presence before an older client can remove a layer's adjustments.
 * Invalid explicit values still require the current client. Recipe parsers
 * validate their shape; this capability never grants project or asset access. */
function layerHasLiquify(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const layer = value as Record<string, unknown>
  if (!layer.edits || typeof layer.edits !== 'object' || Array.isArray(layer.edits)) return false
  const edits = layer.edits as Record<string, unknown>
  return Array.isArray(edits.operations) && edits.operations.some((operation) => operation && typeof operation === 'object' && operation.mode === 'liquify')
}

export function graphHasLiquify(value: unknown): boolean {
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
      const recipe = candidate as Record<string, unknown>
      if (Array.isArray(recipe.layers) && recipe.layers.some(layerHasLiquify)) return true
    }
  }
  return false
}

export function projectHasLiquify(content: string): boolean {
  return graphHasLiquify(JSON.parse(content))
}

export function assertLiquifyClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的液化参数，请刷新页面后重试；未提交生成或覆盖工程')
}
