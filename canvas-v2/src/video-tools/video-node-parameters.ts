import { inspectVideoModelParameters, type VideoRequestInput } from '../lib/video-request-protocol'
import type { WorkflowNodeData } from '../model'

export type VideoParameterPatch = Partial<Pick<VideoRequestInput, 'model' | 'seconds' | 'size' | 'videoMode' | 'videoResolution' | 'videoAspectRatio' | 'promptOptimization' | 'generateAudio'>>
interface VideoNode { id: string; type?: string | null; parentId?: string; draggable?: boolean; disabled?: boolean; data: WorkflowNodeData }

export function assertEditableVideoNode<T extends VideoNode>(nodes: readonly T[], nodeId: string): T {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const target = byId.get(nodeId)
  if (!target || !['video', 'video-generate'].includes(target.type ?? '')) throw new Error('请选择可编辑的视频生成节点')
  let ancestor: T | undefined = target
  const visited = new Set<string>()
  while (ancestor) {
    if (visited.has(ancestor.id)) throw new Error('视频节点的分组层级无效，请重新打开工程')
    visited.add(ancestor.id)
    if (ancestor.disabled || ancestor.draggable === false) throw new Error('视频节点或所在分组已锁定或禁用')
    if (ancestor.parentId && !byId.has(ancestor.parentId)) throw new Error('视频节点的分组已变化，请重新打开工程')
    ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
  }
  if (['queued', 'running'].includes(target.data.status)) throw new Error('视频正在生成，请完成或停止后再修改')
  return target
}

export function videoParametersForNode(data: WorkflowNodeData, model: string, videoProtocol?: VideoRequestInput['videoProtocol']): VideoParameterPatch & { model: string; videoProtocol?: VideoRequestInput['videoProtocol'] } {
  return { model, videoProtocol, seconds: data.seconds, size: data.size,
    videoMode: data.settings?.videoMode as VideoRequestInput['videoMode'],
    videoResolution: data.settings?.videoResolution as VideoRequestInput['videoResolution'],
    videoAspectRatio: data.settings?.videoAspectRatio as VideoRequestInput['videoAspectRatio'],
    promptOptimization: data.settings?.promptOptimization as VideoRequestInput['promptOptimization'],
    generateAudio: data.settings?.generateAudio as VideoRequestInput['generateAudio'],
  }
}

export function inspectVideoNodeParameters(data: WorkflowNodeData, model: string, videoProtocol?: VideoRequestInput['videoProtocol'], imageCount = 0) {
  return inspectVideoModelParameters({ ...videoParametersForNode(data, model, videoProtocol), imageCount })
}

/** Keep existing settings and results intact; callers commit this patch as one undo step. */
export function buildVideoParameterPatch(data: WorkflowNodeData, patch: VideoParameterPatch): Partial<WorkflowNodeData> {
  const result: Partial<WorkflowNodeData> = {}
  const settings = { ...data.settings }
  let changedSettings = false
  for (const [key, value] of Object.entries(patch)) {
    if (!['model', 'seconds', 'size', 'videoMode', 'videoResolution', 'videoAspectRatio', 'promptOptimization', 'generateAudio'].includes(key)) throw new Error('视频参数包含不支持的字段')
    if (key === 'model' || key === 'seconds' || key === 'size') {
      if (value !== undefined && (typeof value !== 'string' || value.length > 256)) throw new Error('视频参数格式不正确')
      if (key === 'model' && (!value || value !== value.trim())) throw new Error('视频模型编号不正确')
      result[key] = value as string | undefined
    } else {
      if (value !== undefined && (['promptOptimization', 'generateAudio'].includes(key) ? typeof value !== 'boolean' : typeof value !== 'string' || value.length > 32)) throw new Error('视频参数格式不正确')
      changedSettings = true
      if (value === undefined) delete settings[key]
      else settings[key] = value
    }
  }
  if (changedSettings) result.settings = settings
  return result
}
