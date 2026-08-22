// 领域模型 —— 刻意零依赖(不 import React/@xyflow):引擎与持久化只认这里
// 的类型,画布层(App.tsx)负责与 @xyflow/react 的 Node/Edge 互相映射。
// MVP 数据模型最薄化,见 docs/CANVAS-V2-PLAN.md 第 4 节。

export type PortKind = 'text' | 'image' | 'video' | 'audio'

export type NodeKind =
  | 'text' | 'image' | 'video'
  | 'prompt' | 'image-input' | 'video-input' | 'audio-input'
  | 'image-generate' | 'image-edit' | 'video-generate'
  | 'frame-extract' | 'router' | 'gallery' | 'output'
  | 'group' | 'note' | 'unknown'
  | 'drama-bible' | 'drama-script' | 'drama-parse'
  | 'drama-character' | 'drama-scene' | 'drama-prop' | 'drama-shot'

export type NodeStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'
export type NodeRunStage =
  | 'validating' | 'resolving-cache' | 'waiting-slot' | 'submitting'
  | 'processing' | 'downloading' | 'saving'

export interface AssetRef {
  kind: 'image' | 'video' | 'audio'
  /** Stable identifier owned by the desktop asset store. */
  assetId?: string
  /** App-local URL derived from assetId; never an absolute filesystem path. */
  localUrl?: string
  mimeType?: string
  width?: number
  height?: number
  /** 视频/音频自身的播放时长，不是生成耗时。 */
  durationSeconds?: number
  /** relay 返回的产物 URL(生成在服务端,主通路是网络拉取,不走本地桥)。 */
  remoteUrl?: string
  /** 视频异步任务 id,应用重启后凭它恢复轮询(断线恢复)。 */
  taskId?: string
}

/** 运行记录投影到节点上的候选视图；仅包含宿主签发的本地资产引用。 */
export interface WorkflowCandidateRef {
  candidateId: string
  attemptId: string
  createdAt: string
  asset: AssetRef
  group?: string
  model?: string
  costQuota?: number
}

export interface WorkflowNodeData {
  prompt: string
  /** relay 侧模型名。渠道配置好之前允许为空,mock 执行器不校验。 */
  model: string
  /** 可选的节点级 relay 分组覆盖；为空时继承项目级生成配置。 */
  group?: string
  /** 图像画质档(gpt-image 系必须显式传,默认 low——auto 有 35 倍费用陷阱,见 RECON-image-generation)。 */
  quality?: string
  /** 图像尺寸(按模型区分合法值,见 models.ts 预设)。 */
  size?: string
  /** 图像输出清晰度档位；与视频 resolution 分离。 */
  imageResolution?: '1K' | '2K' | '4K'
  /** 视频生成时长，协议要求为 1-15 的整数字符串。 */
  seconds?: string
  status: NodeStatus
  /** 已由用户采纳、允许持久化并作为下游输入的结果。暂存候选不得覆盖它。 */
  result?: AssetRef
  /** 面向用户的失败原因(中文),仅 status === 'failed' 时有意义。 */
  errorMessage?: string
  /** 本次执行消耗的 quota(new-api 记账单位),费用透明是留存前提。 */
  costQuota?: number
  /** 节点定义自己的可持久配置。凭据、绝对路径和远程地址会在 schema 边界剥离。 */
  settings?: Record<string, unknown>
  /** 多候选节点当前展示的候选资产标识。 */
  candidateAssetIds?: string[]
  /** 当前运行返回、等待用户采纳或丢弃的候选；运行态数据，不进入工作流文件。 */
  candidates?: WorkflowCandidateRef[]
  /** 预览候选与已采纳候选分离，选择预览不会影响下游。 */
  selectedCandidateId?: string
  adoptedCandidateId?: string
  /** 输入或采纳结果变化后，等待用户显式运行的标记。 */
  dirty?: boolean
  attemptCount?: number
  /** 本次打开画布期间的生成耗时。只活在内存里，不进工作流文件，重开后不恢复。 */
  latestAttemptDurationMs?: number
  /** 主进程运行开始时间；仅用于节点实时计时，不进入工作流文件。 */
  runStartedAt?: string
  /** 主进程签发的当前运行阶段；仅用于实时展示，不进入工作流文件。 */
  runStage?: NodeRunStage
  runProgress?: number
  runProgressMode?: 'determinate' | 'indeterminate'
  runHealth?: 'normal' | 'delayed'
  /**
   * The last terminal state was a fingerprint cache hit rather than a fresh
   * paid run. Runtime only: it describes how the current result was obtained,
   * not what the workflow is, so it never reaches persistence.
   */
  fromCache?: boolean
}

export interface WorkflowNode {
  id: string
  kind: NodeKind
  /** Version of the node definition that produced the persisted data. */
  definitionVersion?: number
  /** Unsupported node definitions are retained as disconnected placeholders. */
  disabled?: boolean
  /** Original definition type for a disabled placeholder. */
  unknownKind?: string
  parentId?: string
  width?: number
  height?: number
  locked?: boolean
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
  /** v1 remains accepted in memory until all legacy construction sites migrate. */
  schemaVersion: 1 | 2
  name: string
  viewport?: { x: number; y: number; zoom: number }
  mediaGroups?: {
    image?: string
    video?: string
    text?: string
    imageModel?: string
    videoModel?: string
    textModel?: string
  }
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** 每种节点的输出端口类型(输入端口见 nodeInputKinds)。 */
export const nodeOutputKind: Record<NodeKind, PortKind> = {
  text: 'text',
  image: 'image',
  video: 'video',
  prompt: 'text',
  'image-input': 'image',
  'video-input': 'video',
  'audio-input': 'audio',
  'image-generate': 'image',
  'image-edit': 'image',
  'video-generate': 'video',
  'frame-extract': 'image',
  router: 'text',
  gallery: 'image',
  output: 'image',
  group: 'text',
  note: 'text',
  unknown: 'text',
  'drama-bible': 'text',
  'drama-script': 'text',
  'drama-parse': 'text',
  'drama-character': 'image',
  'drama-scene': 'image',
  'drama-prop': 'image',
  'drama-shot': 'text',
}

/**
 * 每种节点接受的输入端口类型。text 是源节点无输入;image 吃 text 与 image
 * ——只接 text 走文生图 /v1/images/generations,接上 image 就自动转成图生图
 * /v1/images/edits(同一个节点两种形态,不另开第四种节点类型:引擎与持久化
 * 不必改,image→image→video 这种链路也就天然可组);video 吃 text 与 image
 * (图生视频的提示词 + 参考图,对应 relay 视频任务的 prompt + image 入参)。
 */
export const nodeInputKinds: Record<NodeKind, readonly PortKind[]> = {
  text: [],
  image: ['text', 'image'],
  video: ['text', 'image', 'video', 'audio'],
  prompt: [],
  'image-input': [],
  'video-input': [],
  'audio-input': [],
  'image-generate': ['text', 'image'],
  'image-edit': ['text', 'image'],
  'video-generate': ['text', 'image', 'video', 'audio'],
  'frame-extract': ['video'],
  router: ['text', 'image', 'video', 'audio'],
  gallery: ['image', 'video', 'audio'],
  output: ['text', 'image', 'video', 'audio'],
  group: [],
  note: [],
  unknown: [],
  'drama-bible': [],
  'drama-script': [],
  'drama-parse': ['text'],
  'drama-character': ['text', 'image'],
  'drama-scene': ['text', 'image'],
  'drama-prop': ['text', 'image'],
  'drama-shot': ['text', 'image'],
}

export function createEmptyWorkflow(name = '未命名工作流'): WorkflowFile {
  return { schemaVersion: 2, name, nodes: [], edges: [] }
}

// Compatibility exports keep App stable while persistence evolves.
export {
  parseWorkflowFile,
  parseWorkflowFileDetailed,
  serializeWorkflow,
} from './persistence/workflow-serializer'
