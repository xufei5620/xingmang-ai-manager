import type { WorkflowFile } from '../model'
import type { CanvasAssetSummary } from '../host'
import { parseXingCanvasProject } from '../persistence/project-package'
import { parseWorkflowFileDetailed, serializeWorkflow } from '../persistence/workflow-serializer'
import { maximumProjectContentBytes, maximumProjectEdges, maximumProjectFileBytes, maximumProjectNodes, utf8ByteLength } from './canvas-limits'
import { parseColorLutResourceDescriptor, type ColorLutResourceDescriptor } from './color-lut-resource-contract'
import { remapWorkflowColorLutSources } from './workflow-color-lut-resources'
import { collectNodeAssetReferences } from './asset-reference-values'

export interface WorkflowColorLutAsset {
  assetId: string
  mediaType: 'lut'
  mimeType: ColorLutResourceDescriptor['mimeType']
  fileName: string
  createdAt: string
  colorLut: ColorLutResourceDescriptor
}
export type WorkflowReferencedAsset = CanvasAssetSummary | WorkflowColorLutAsset

export interface MissingWorkflowAsset {
  assetId: string
  nodeIds: string[]
}

export function parseProjectImport(content: unknown): { workflow: WorkflowFile; content: string; warnings: string[] } {
  if (typeof content !== 'string' || !content || utf8ByteLength(content) > maximumProjectFileBytes) throw new Error('工作流文件不能超过 2 MB')
  const parsed = parseXingCanvasProject(content) ?? parseWorkflowFileDetailed(content)
  if (!parsed) throw new Error('无法识别工作流，请选择星芒画布导出的 JSON 或 .xingcanvas 文件')
  const { workflow } = parsed
  if (workflow.nodes.length > maximumProjectNodes || workflow.edges.length > maximumProjectEdges) throw new Error('单个工程最多 2000 个节点和 4000 条连线，请拆分工作流后再导入')
  const normalized = serializeWorkflow(workflow)
  if (utf8ByteLength(normalized) > maximumProjectContentBytes) throw new Error('规范化后的工作流超过云端容量，请减少提示词或拆分工程')
  return { workflow, content: normalized, warnings: [...parsed.warnings] }
}

export function workflowAssetReferences(workflow: WorkflowFile): Map<string, Set<string>> { return collectNodeAssetReferences(workflow.nodes) }

/** Only the caller's verified owner assets can supply a rewritten media URL. */
export function remapWorkflowAssets(workflow: WorkflowFile, mappings: ReadonlyMap<string, WorkflowReferencedAsset>): WorkflowFile {
  const owned = new Map<string, CanvasAssetSummary>()
  const lutMappings = new Map<string, ColorLutResourceDescriptor>()
  for (const [sourceId, asset] of mappings) {
    if (asset.mediaType === 'lut') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(sourceId)) throw new Error('项目调色资源映射不正确')
      const descriptor = parseColorLutResourceDescriptor(asset.colorLut)
      if (descriptor.assetId !== asset.assetId || descriptor.mimeType !== asset.mimeType) throw new Error('项目调色资源映射与已核验回执不一致')
      lutMappings.set(sourceId, descriptor)
      continue
    }
    if (sourceId.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(sourceId) || asset.assetId.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || !['image', 'video', 'audio'].includes(asset.mediaType)) throw new Error('项目素材映射不正确，请重新核对当前账户素材')
    owned.set(sourceId, asset)
  }
  function mediaForUrl(raw: Record<string, unknown>, url: unknown): CanvasAssetSummary | undefined {
    if (typeof raw.assetId === 'string' && owned.has(raw.assetId)) return owned.get(raw.assetId)
    if (typeof url === 'string') {
      const match = /^xingmang-asset:\/\/(?:image|video|audio)\/([A-Za-z0-9_-]{43})$/.exec(url)
      if (match && owned.has(match[1])) return owned.get(match[1])
    }
    const candidates = Object.entries(raw).filter(([key, value]) => /assetId$/i.test(key) && typeof value === 'string' && owned.has(value)).map(([, value]) => owned.get(value as string)!)
    return new Set(candidates.map((asset) => asset.assetId)).size === 1 ? candidates[0] : undefined
  }
  function remap(value: unknown, depth = 0): unknown {
    if (depth > 32) throw new Error('项目素材引用层级超过安全上限，请拆分工作流后导入')
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((entry) => remap(entry, depth + 1))
    const raw = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(raw)) {
      // Foreign provider jobs cannot become resumable Site attempts on import.
      if (/taskIds?$/i.test(key) || /^remoteUrl$/i.test(key)) continue
      if (/assetId$/i.test(key) && typeof entry === 'string') result[key] = owned.get(entry)?.assetId ?? entry
      else if (/assetIds$/i.test(key) && Array.isArray(entry)) result[key] = entry.map((id) => typeof id === 'string' ? owned.get(id)?.assetId ?? id : remap(id, depth + 1))
      else if (/^(?:localUrl|thumbnailUrl)$/i.test(key)) {
        const asset = mediaForUrl(raw, entry)
        if (asset) result[key] = `xingmang-asset://${asset.mediaType}/${asset.assetId}`
      } else result[key] = remap(entry, depth + 1)
    }
    return result
  }
  // Node IDs, kinds, parameters and edges keep their original identity.
  const source = lutMappings.size ? remapWorkflowColorLutSources(workflow, lutMappings) : workflow
  return { ...source, nodes: source.nodes.map((node) => ({ ...node, data: remap(node.data) as WorkflowFile['nodes'][number]['data'] })) }
}

/** Preserve the graph and parameters while removing explicitly unresolvable media. */
export function removeMissingWorkflowAssets(workflow: WorkflowFile, missing: Set<string>): WorkflowFile {
  function clean(value: unknown, depth = 0): unknown {
    if (depth > 32) return undefined
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1)).filter((item) => item !== undefined)
    const raw = value as Record<string, unknown>
    if (typeof raw.assetId === 'string' && missing.has(raw.assetId)) return undefined
    // A partial source would be invalid and could falsely look like an editable
    // selection. Explicit drop removes the whole selection, never other grades.
    if (raw.version === 1 && raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source)) {
      const source = raw.source as Record<string, unknown>
      if (source.kind === 'asset' && typeof source.lutAssetId === 'string' && missing.has(source.lutAssetId)) return undefined
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(raw)) {
      if (/assetId$/i.test(key) && typeof item === 'string' && missing.has(item)) continue
      const cleaned = /assetIds$/i.test(key) && Array.isArray(item) ? item.filter((id) => typeof id === 'string' && !missing.has(id)) : clean(item, depth + 1)
      if (cleaned !== undefined) result[key] = cleaned
    }
    return result
  }
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const data = clean(node.data) as WorkflowFile['nodes'][number]['data']
      // A task without owned output belongs to the exporting service, not this Site.
      if (data.result && !data.result.assetId) delete data.result
      if (data.result) delete data.result.taskId
      data.status = data.result?.assetId ? 'succeeded' : 'idle'
      return { ...node, data }
    }),
  }
}
