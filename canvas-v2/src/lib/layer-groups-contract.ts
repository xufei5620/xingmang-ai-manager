/** Presence is checked before any projection can discard unknown editable data.
 * Shape validation remains the strict recipe parser's responsibility. */
export interface LayerGroupsCapabilities { layerGroupsVersion?: unknown }

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function groupPaths(value: unknown): string[][] {
  const paths: string[][] = [], seen = new Set<object>()
  let visited = 0
  function visit(value: unknown, path: string[]): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    if (++visited > 20_000 || path.length > 40) { paths.push(['unsupported-depth']); return }
    seen.add(value)
    if (Array.isArray(value)) { for (const [index, child] of value.entries()) visit(child, [...path, String(index)]); return }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'layerGroups') paths.push([...path, key])
      visit(child, [...path, key])
    }
  }
  visit(value, [])
  return paths
}

export function graphHasLayerGroups(value: unknown): boolean {
  if (!record(value) || !Array.isArray(value.nodes)) return false
  return value.nodes.some((node) => record(node) && groupPaths(node.data).length > 0)
}

export function imageTransformHasLayerGroups(value: unknown): boolean { return groupPaths(value).length > 0 }

export function projectHasLayerGroups(content: string): boolean { return graphHasLayerGroups(JSON.parse(content)) }

export function assertLayerGroupsClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的持久图层编组，请刷新页面后重试；原图层与分组已保留，未保存或运行')
}

export function assertLayerGroupsPlacement(kind: unknown, data: unknown, container: 'workflow' | 'run'): void {
  const paths = groupPaths(data)
  if (!paths.length) return
  const allowed = container === 'workflow' ? ['settings', 'imageTransform', 'layerGroups'] : ['imageTransform', 'layerGroups']
  if (kind !== 'image-layer' || paths.some((path) => JSON.stringify(path) !== JSON.stringify(allowed))) throw new Error('持久图层编组必须完整保存在图层合成节点的正确配方位置；不会丢弃分组后保存或运行')
}
