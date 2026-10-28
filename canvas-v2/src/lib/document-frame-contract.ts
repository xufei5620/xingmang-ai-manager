/** Detect new document replay coordinates before an older page can erase them.
 * This is a capability guard, not validation or an ownership grant. Explicit
 * malformed frames still require the new page; recipe parsing remains strict. */
function recipeHasDocumentFrame(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const recipe = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(recipe, 'documentFrame')) return true
  if (!Array.isArray(recipe.layers)) return false
  return recipe.layers.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const layer = value as Record<string, unknown>
    return (['x', 'y'] as const).some((key) => typeof layer[key] === 'number' && (layer[key] < -2 || layer[key] > 2))
      || (['width', 'height'] as const).some((key) => typeof layer[key] === 'number' && (layer[key] < .001 || layer[key] > 4))
  })
}

export function graphHasDocumentFrame(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const graph = value as Record<string, unknown>
  if (!Array.isArray(graph.nodes)) return false
  return graph.nodes.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const node = value as Record<string, unknown>
    const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data as Record<string, unknown> : undefined
    const settings = data?.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings as Record<string, unknown> : undefined
    return recipeHasDocumentFrame(data?.imageTransform) || recipeHasDocumentFrame(settings?.imageTransform)
  })
}

export function projectHasDocumentFrame(content: string): boolean {
  return graphHasDocumentFrame(JSON.parse(content))
}

export function assertDocumentFrameClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的图层画布裁剪与扩展坐标，请刷新页面后重试；未提交生成或覆盖工程')
}
