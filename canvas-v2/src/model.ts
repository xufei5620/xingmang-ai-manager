// 领域模型 —— 刻意零依赖(不 import React/@xyflow):引擎与持久化只认这里
// 的类型,画布层(App.tsx)负责与 @xyflow/react 的 Node/Edge 互相映射。
// MVP 数据模型最薄化,见 docs/CANVAS-V2-PLAN.md 第 4 节。

export type PortKind = 'text' | 'image' | 'video'

export type NodeKind = 'text' | 'image' | 'video'

export type NodeStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'

export interface AssetRef {
  kind: 'image' | 'video'
  /** relay 返回的产物 URL(生成在服务端,主通路是网络拉取,不走本地桥)。 */
  remoteUrl?: string
  /** 视频异步任务 id,应用重启后凭它恢复轮询(断线恢复)。 */
  taskId?: string
}

export interface WorkflowNodeData {
  prompt: string
  /** relay 侧模型名。渠道配置好之前允许为空,mock 执行器不校验。 */
  model: string
  /** 图像画质档(gpt-image 系必须显式传,默认 low——auto 有 35 倍费用陷阱,见 RECON-image-generation)。 */
  quality?: string
  /** 图像尺寸(按模型区分合法值,见 models.ts 预设)。 */
  size?: string
  status: NodeStatus
  result?: AssetRef
  /** 面向用户的失败原因(中文),仅 status === 'failed' 时有意义。 */
  errorMessage?: string
  /** 本次执行消耗的 quota(new-api 记账单位),费用透明是留存前提。 */
  costQuota?: number
}

export interface WorkflowNode {
  id: string
  kind: NodeKind
  position: { x: number; y: number }
  data: WorkflowNodeData
}

export interface WorkflowEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface WorkflowFile {
  schemaVersion: 1
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** 每种节点的输出端口类型(输入端口见 nodeInputKinds)。 */
export const nodeOutputKind: Record<NodeKind, PortKind> = {
  text: 'text',
  image: 'image',
  video: 'video',
}

/**
 * 每种节点接受的输入端口类型。text 是源节点无输入;image 吃 text(文生图,
 * 后续可扩展 image 输入做图生图);video 吃 text 与 image(图生视频的提示
 * 词 + 参考图,对应 relay 视频任务的 prompt + image 入参)。
 */
export const nodeInputKinds: Record<NodeKind, readonly PortKind[]> = {
  text: [],
  image: ['text'],
  video: ['text', 'image'],
}

export function createEmptyWorkflow(name = '未命名工作流'): WorkflowFile {
  return { schemaVersion: 1, name, nodes: [], edges: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 工作流文件解析。宿主桥读进来的内容按敌意输入对待(与主仓 I5 同一姿态):
 * 结构不对返回 null 而不是抛错,让调用方给出可上屏的中文提示。
 */
export function parseWorkflowFile(content: string): WorkflowFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null
  if (typeof raw.name !== 'string' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  const nodes: WorkflowNode[] = []
  for (const entry of raw.nodes) {
    if (!isRecord(entry)) return null
    const { id, kind, position, data } = entry
    if (typeof id !== 'string' || id.length === 0) return null
    if (kind !== 'text' && kind !== 'image' && kind !== 'video') return null
    if (!isRecord(position) || typeof position.x !== 'number' || typeof position.y !== 'number') return null
    if (!isRecord(data) || typeof data.prompt !== 'string' || typeof data.model !== 'string') return null
    nodes.push({
      id,
      kind,
      position: { x: position.x, y: position.y },
      // status/result 不从文件恢复执行中间态:重开文件一律回到 idle,
      // 已完成的产物引用保留(remoteUrl/taskId)以便续跑或预览。
      data: {
        prompt: data.prompt,
        model: data.model,
        quality: typeof data.quality === 'string' ? data.quality : undefined,
        size: typeof data.size === 'string' ? data.size : undefined,
        status: data.status === 'succeeded' ? 'succeeded' : 'idle',
        result: isRecord(data.result) && (data.result.kind === 'image' || data.result.kind === 'video')
          ? {
              kind: data.result.kind,
              remoteUrl: typeof data.result.remoteUrl === 'string' ? data.result.remoteUrl : undefined,
              taskId: typeof data.result.taskId === 'string' ? data.result.taskId : undefined,
            }
          : undefined,
      },
    })
  }
  const edges: WorkflowEdge[] = []
  for (const entry of raw.edges) {
    if (!isRecord(entry)) return null
    const { id, source, sourceHandle, target, targetHandle } = entry
    if ([id, source, sourceHandle, target, targetHandle].some((v) => typeof v !== 'string' || v.length === 0)) {
      return null
    }
    edges.push({
      id: id as string,
      source: source as string,
      sourceHandle: sourceHandle as string,
      target: target as string,
      targetHandle: targetHandle as string,
    })
  }
  return { schemaVersion: 1, name: raw.name, nodes, edges }
}

export function serializeWorkflow(workflow: WorkflowFile): string {
  return JSON.stringify(workflow, null, 2)
}
