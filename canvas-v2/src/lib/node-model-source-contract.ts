/** A fixed node source is editable owner configuration, never a credential or ACL. */
export interface NodeMediaSource { nodeId: string; group: string; model: string }
const mediaKinds = new Set(['image', 'image-generate', 'image-edit', 'video', 'video-generate'])
const contentTextKinds = new Set(['text-generate', 'drama-parse'])
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function nodes(value: unknown): Record<string, unknown>[] {
  if (!record(value) || !Array.isArray(value.nodes)) return []
  return value.nodes.filter((node): node is Record<string, unknown> => record(node) && (mediaKinds.has(String(node.kind ?? node.type)) || contentTextKinds.has(String(node.kind ?? node.type))) && record(node.data) && Object.hasOwn(node.data, 'group'))
}
export function assertNodeMediaSourceGroup(kind: unknown, data: unknown): void {
  if (!mediaKinds.has(String(kind)) && !contentTextKinds.has(String(kind)) || !record(data) || !Object.hasOwn(data, 'group')) return
  if (typeof data.group !== 'string' || !data.group.trim() || data.group !== data.group.trim() || data.group.length > 128 || /[\u0000-\u001f\u007f]/.test(data.group)) throw new Error('节点固定模型来源格式无效；不会丢弃配置后保存或运行')
}
export function graphHasNodeMediaSource(value: unknown): boolean { return nodes(value).length > 0 }
export function projectHasNodeMediaSource(content: string): boolean { return graphHasNodeMediaSource(JSON.parse(content)) }
export function graphNodeMediaSourceVersion(value: unknown): 1 | 2 | undefined {
  const fixed = nodes(value)
  return fixed.some((node) => contentTextKinds.has(String(node.kind ?? node.type))) ? 2 : fixed.length ? 1 : undefined
}
export function assertNodeMediaSourceClientVersion(version: unknown, required: boolean, minimumVersion: 1 | 2 = 1): void {
  if (version !== undefined && version !== 1 && version !== 2 || required && version !== 1 && version !== 2 || required && minimumVersion === 2 && version !== 2) throw new Error('当前页面版本不支持节点固定模型来源，请刷新页面后重试；未覆盖工程或提交生成')
}
export function collectNodeMediaSources(value: unknown): NodeMediaSource[] {
  return nodes(value).map((node) => {
    const data = node.data as Record<string, unknown>
    assertNodeMediaSourceGroup(node.kind ?? node.type, data)
    if (typeof node.id !== 'string' || !node.id || typeof data.group !== 'string' || !data.group.trim() || data.group !== data.group.trim() || data.group.length > 128 || /[\u0000-\u001f\u007f]/.test(data.group) || typeof data.model !== 'string' || data.model.length > 200) throw new Error('节点固定模型来源或模型格式无效；不会丢弃配置后保存或运行')
    return { nodeId: node.id, group: data.group, model: data.model }
  })
}
export function assertNodeMediaSourceWorkflow(content: string, version: unknown): void {
  const raw: unknown = JSON.parse(content)
  const required = graphNodeMediaSourceVersion(raw)
  assertNodeMediaSourceClientVersion(version, required !== undefined, required)
  collectNodeMediaSources(raw)
}
/** The browser cannot replace a persisted fixed route with its global defaults. */
export function assertNodeMediaSourceRun(content: string, graph: { nodes: readonly { id: string; data: { group?: string; model: string } }[] }, selectedNodeIds: readonly string[]): void {
  const selected = new Set(selectedNodeIds)
  for (const fixed of collectNodeMediaSources(JSON.parse(content))) {
    const node = graph.nodes.find((entry) => entry.id === fixed.nodeId)
    if (node && selected.has(node.id) && (node.data.group !== fixed.group || fixed.model && node.data.model !== fixed.model)) throw new Error('运行中的节点模型来源与已保存工程不一致，请保存并重新预检；不会改用全局默认来源')
  }
}

export function nodeMediaSourceSignature(content: string, selectedNodeIds: readonly string[]): string {
  const selected = new Set(selectedNodeIds)
  return JSON.stringify(collectNodeMediaSources(JSON.parse(content)).filter((entry) => selected.has(entry.nodeId)).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
}
