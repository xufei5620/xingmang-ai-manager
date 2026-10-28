/** Inspect presence before an older client can remove a layer's adjustments.
 * Invalid explicit values still require the current client. Recipe parsers
 * validate their shape; this capability never grants project or asset access. */
export function graphHasColorGrade(value: unknown): boolean {
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
      if (Array.isArray(recipe.layers) && recipe.layers.some((layer) => layer && typeof layer === 'object' && Object.hasOwn(layer, 'colorGrade'))) return true
    }
  }
  return false
}

export function projectHasColorGrade(content: string): boolean {
  return graphHasColorGrade(JSON.parse(content))
}

/** Share presence traversal across independently versioned grade features. */
export function graphHasColorGradeProperty(value: unknown, property: 'lut' | 'detail' | 'presence' | 'calibration'): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const nodes = (value as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return false
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue
    const data = (node as Record<string, unknown>).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const raw = data as Record<string, unknown>, settings = raw.settings
    for (const candidate of [raw.imageTransform, settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>).imageTransform : undefined]) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const layers = (candidate as Record<string, unknown>).layers
      if (!Array.isArray(layers)) continue
      for (const layer of layers) {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue
        const grade = (layer as Record<string, unknown>).colorGrade
        if (grade && typeof grade === 'object' && !Array.isArray(grade) && Object.hasOwn(grade, property)) return true
      }
    }
  }
  return false
}

export function assertColorGradeClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的图像调整参数，请刷新页面后重试；未提交生成或覆盖工程')
}
