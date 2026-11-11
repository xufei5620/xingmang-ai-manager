export const canvasRunContractVersion = 1 as const
export const canvasRunTimelineLimit = 4_096

export type CanvasRunNodeKind =
  | 'text' | 'image' | 'video' | 'prompt'
  | 'image-input' | 'video-input' | 'audio-input' | 'image-generate' | 'image-edit' | 'video-generate'
  | 'frame-extract' | 'router' | 'gallery' | 'output' | 'group' | 'note'
  | 'drama-bible' | 'drama-script' | 'drama-parse'
  | 'drama-character' | 'drama-scene' | 'drama-prop' | 'drama-shot'
  | 'text-generate'
  | CanvasRunImageToolNodeKind
  | CanvasRunKernelOnlyNodeKind

/**
 * The kernel's image tools the desktop runs once imageTools is switched on
 * (画布完善第 7 条第三步): the page makes the pixels, the main process checks
 * and stores them; compare and panorama only pass their images on. With the
 * switch off they are refused like a kernel-only kind. Each label is the
 * kernel's own node title.
 */
export const canvasRunImageToolNodeLabels = {
  'image-crop': '裁剪图片',
  'image-collage': '拼图',
  'image-grid-split': '宫格裁剪',
  'image-tile': '平铺图片',
  'image-layer': '图层合成',
  'image-compare': '图片对比',
  'image-panorama': '全景预览',
} as const

export type CanvasRunImageToolNodeKind = keyof typeof canvasRunImageToolNodeLabels

/**
 * Node kinds the xingmang-canvas kernel can put in a run graph but the desktop
 * has no executor for yet. They parse so a graph that merely contains one is
 * not refused as a whole; a run whose scope reaches one is refused before any
 * paid request (#1392). Each label is the kernel's own node title. Empty since
 * the grid split joined the image tools; the next kernel kind goes here.
 */
export const canvasRunKernelOnlyNodeLabels = {} as const

export type CanvasRunKernelOnlyNodeKind = keyof typeof canvasRunKernelOnlyNodeLabels
export type CanvasRunScope =
  | { kind: 'all' }
  | { kind: 'to-node'; nodeId: string }
  | { kind: 'from-node'; nodeId: string }
  | { kind: 'selection'; nodeIds: string[] }
  | { kind: 'dirty'; nodeIds: string[] }

export interface CanvasRunAsset {
  kind: 'image' | 'video' | 'audio'
  assetId: string
  localUrl: string
  mimeType?: string
  width?: number
  height?: number
  taskId?: string
}

export interface CanvasRunGraphNode {
  id: string
  kind: CanvasRunNodeKind
  definitionVersion: number
  disabled?: boolean
  /**
   * Set by the request parser when the node is a kernel-only kind or carries a
   * parameter the desktop cannot honour. The parameter itself is never passed
   * on, so running the node would silently drop what the user paid for; a run
   * that reaches it is refused instead. It is not part of the fingerprint or
   * the graph revision.
   */
  desktopUnsupported?: string
  data: {
    prompt: string
    model: string
    group?: string
    quality?: string
    size?: string
    imageResolution?: '1K' | '2K' | '4K'
    seconds?: string
    adoptedAssetId?: string
    videoMode?: 'auto' | 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va'
    videoResolution?: '480p' | '720p'
    videoAspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4'
    promptOptimization?: boolean
    /**
     * Image kinds only, 2-4. The desktop sends this many independent requests
     * that each ask for one image (upstream n stays 1); absent means one.
     */
    imageCandidateCount?: CanvasRunImageCandidateCount
    /**
     * image-edit only: repaint just the painted part of the one source image
     * (画布完善第 5 条). Parsed with the kernel's limits; absent means a plain
     * edit, exactly as before.
     */
    imageEditMask?: CanvasImageEditMask
    /**
     * frame-extract only, seconds into the source video (画布完善第 7 条第二步).
     * Kept only while the desktop runs frame-extract nodes; absent on every
     * other node, so their fingerprints stay as they were.
     */
    frameTimestampSeconds?: number
    /**
     * Crop, collage, tile and layer nodes only (画布完善第 7 条第三步): the
     * kernel's recipe exactly as it came, bounded but never interpreted; the
     * page that wrote it gets it back to make the pixels. Kept only while the
     * desktop runs image tools.
     */
    imageTransform?: CanvasImageTransformRecipe
    /** Collage nodes only: the order the user arranged the pictures in. */
    imageCollageInputOrder?: CanvasImageCollageInputOrder
    /** Tile nodes only: which connected picture is the tile. */
    tileInput?: CanvasTileInputSelection
    /**
     * Grid-split nodes only: which slice the canvas shows and a single-picture
     * connection hands on, below rows x columns. Choosing another slice is not
     * a new picture, so it stays out of the fingerprint, as on the web host.
     */
    imageOutputIndex?: number
    /**
     * Image, image-generate, image-edit and text-generate nodes (画布完善第 8
     * 条): which connected picture is the source and which are references, in
     * the order the request sends them. Absent means connection order.
     */
    imageReferenceOrder?: CanvasImageReferenceOrder
    /**
     * Video nodes only: the order the user arranged the references in (which
     * picture is the first frame). Absent means connection order, as before;
     * an empty order is dropped by the parser for the same reason.
     */
    videoReferenceOrder?: CanvasVideoReferenceOrder
  }
}

export type CanvasImageTransformKind = 'crop' | 'collage' | 'grid-split' | 'tile' | 'layer'

/** The kernel's ImageTransformRecipe (xingmang-canvas image-tools/recipe.ts); only `kind` is typed here. */
export interface CanvasImageTransformRecipe {
  kind: CanvasImageTransformKind
  [field: string]: unknown
}

export interface CanvasImageCollageInputSlot { edgeId: string; outputIndex: number }
export interface CanvasImageCollageInputOrder { version: 1; slots: CanvasImageCollageInputSlot[] }
export type CanvasTileInputSelection = { edgeId: string; outputIndex: number } | { missing: true }

/** One picture reaching a node, named by its connection and its place in that connection's batch. */
export interface CanvasReferenceIdentity { edgeId: string; outputIndex: number }
/** The kernel's ImageReferenceSlot (commerce/image-reference-order.ts): slot 1 is the source, the rest references. */
export type CanvasImageReferenceSlot = { role: 'source' | 'reference' } & (CanvasReferenceIdentity | { missing: true })
export interface CanvasImageReferenceOrder { version: 1; slots: CanvasImageReferenceSlot[] }
/** The kernel's VideoReferenceOrder (video-tools/video-reference-order.ts), at most 12 slots. */
export interface CanvasVideoReferenceOrder { version: 1; slots: CanvasReferenceIdentity[] }

export type CanvasRunImageCandidateCount = 1 | 2 | 3 | 4

export interface CanvasImageEditMaskPoint { x: number; y: number }
export interface CanvasImageEditMaskStroke { tool: 'brush' | 'erase'; size: number; points: CanvasImageEditMaskPoint[] }
/** Strokes in 0-1 coordinates over a width x height image (xingmang-canvas image-tools/image-edit-mask.ts). */
export interface CanvasImageEditMask {
  version: 1
  /** The image the mask was drawn on; a run refuses any other source. */
  sourceAssetId?: string
  width: number
  height: number
  strokes: CanvasImageEditMaskStroke[]
}

/**
 * One request of a multi-image node. Every request of the same run shares the
 * batchId and the node's fingerprint; index counts from 1. The kernel shows the
 * candidates of the latest batch together (xingmang-canvas
 * runtime/image-candidate-batch.ts).
 */
export interface CanvasRunImageBatch {
  batchId: string
  index: CanvasRunImageCandidateCount
  count: CanvasRunImageCandidateCount
}

export interface CanvasRunGraphEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface CanvasRunGraph {
  nodes: CanvasRunGraphNode[]
  edges: CanvasRunGraphEdge[]
}

export type CanvasRunNodeState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'cached'
  | 'interrupted'

export type CanvasRunNodeStage =
  | 'validating'
  | 'resolving-cache'
  | 'waiting-slot'
  | 'submitting'
  | 'processing'
  | 'downloading'
  | 'saving'

export type CanvasRunStatus =
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface CanvasRunCandidate {
  /**
   * Image tools only: the picture's place in what the node made (a grid
   * split's slice number), whichever candidate comes first. The kernel's
   * CanvasRunCandidate has the same field.
   */
  outputIndex?: number
  candidateId: string
  attemptId: string
  createdAt: string
  asset: CanvasRunAsset
  group?: string
  model?: string
  costQuota?: number
}

export interface CanvasRunAttempt {
  attemptId: string
  fingerprint: string
  state: CanvasRunNodeState
  startedAt: string
  completedAt: string
  durationMs: number
  cached: boolean
  inputAssetIds?: string[]
  candidates: CanvasRunCandidate[]
  outputText?: string
  errorMessage?: string
  costQuota?: number
  group?: string
  model?: string
  imageBatch?: CanvasRunImageBatch
  /** What the relay answered this attempt's paid requests with; absent when none left. */
  relayBilling?: CanvasRunRelayBilling
  /** Filled in a few seconds after the run, once the account's usage records are checked. */
  charge?: CanvasRunAttemptCharge
}

/**
 * 实扣的底账（画布完善第 2b 条第 3 步）：这次尝试发出去的付费请求，站点回了哪些请求号。
 * 用量记录按请求号记每一笔扣费，跑完拿它去对。请求号不敏感，客服对账就用它。
 */
export interface CanvasRunRelayBilling {
  /** The relay's request ids, in the order the answers came back. */
  requestIds: string[]
  /** A request left and no answer came back (stopped, timed out, connection lost): it may have been charged. */
  unanswered?: true
  /** An answer came back without a usable request id. */
  unidentified?: true
}

/** What one attempt actually cost, matched against the account's usage records. */
export interface CanvasRunAttemptCharge {
  /** settled: every request it sent is accounted for; unmatched: some could not be matched, shown as 待核对. */
  state: 'settled' | 'unmatched'
  /** Dollars of the requests that matched; 0 when nothing was charged. */
  usd: number
  /** The relay may still adjust it afterwards (video). */
  approximate?: true
}

/** The run's 实扣: the sum over its paid attempts. Never an estimate passed off as a charge. */
export interface CanvasRunCharge {
  state: 'settled' | 'unmatched'
  usd: number
  /** Paid attempts that could not be matched. */
  unmatchedAttempts: number
  approximate?: true
  checkedAt: string
}

export interface CanvasRunNodeRecord {
  nodeId: string
  kind: CanvasRunNodeKind
  state: CanvasRunNodeState
  latestStage?: CanvasRunNodeStage
  latestStageAt?: string
  latestStageSequence?: number
  latestProgress?: number
  latestProgressMode?: 'determinate' | 'indeterminate'
  latestHealth?: 'normal' | 'delayed'
  attempts: CanvasRunAttempt[]
  errorMessage?: string
}

interface CanvasRunEventBase {
  version: typeof canvasRunContractVersion
  runId: string
  graphRevision: string
  sequence: number
  at: string
}

export interface CanvasRunNodeEvent extends CanvasRunEventBase {
  type: 'node-state'
  nodeId: string
  state: CanvasRunNodeState
  attemptId?: string
  fingerprint?: string
  candidateIds?: string[]
  errorMessage?: string
  costQuota?: number
}

export interface CanvasRunNodeStageEvent extends CanvasRunEventBase {
  type: 'node-stage'
  nodeId: string
  stage: CanvasRunNodeStage
  attemptId?: string
  progress?: number
  progressMode?: 'determinate' | 'indeterminate'
  health?: 'normal' | 'delayed'
}

export interface CanvasRunTerminalEvent extends CanvasRunEventBase {
  type: 'run-terminal'
  status: Exclude<CanvasRunStatus, 'running'>
  outcome: CanvasRunOutcome
}

/**
 * A frame the page must decode for a frame-extract node (画布完善第 7 条第二步).
 * The kernel extracts it with its own browser decoder and hands the PNG back
 * through canvas-host:complete-run-preparation; only operations listed here
 * are accepted, once each. Same shape as the web host's run-waiting payload.
 */
export interface CanvasFramePreparation {
  operationId: string
  nodeId: string
  attemptId: string
  sourceAssetId: string
  timestampSeconds: number
}

/**
 * Pictures the page must make for an image-tool node (画布完善第 7 条第三步).
 * The kernel processes them with its own browser code and hands the PNGs back
 * through canvas-host:complete-run-preparation; only operations listed here
 * are accepted, once each. Same shape as the web host's (xingmang-canvas
 * lib/image-transform-contract.ts CanvasImagePreparation).
 */
export interface CanvasImagePreparation {
  operationId: string
  attemptId: string
  runId: string
  projectId: string
  nodeId: string
  sourceAssetIds: string[]
  recipe: CanvasImageTransformRecipe
  /** Present when the recipe holds layer groups; the kernel refuses such a recipe without it. */
  layerGroupsVersion?: 1
  processorRevision: string
}

/**
 * Sent whenever the set of frames or pictures the run is waiting on changes;
 * an empty list means none. imagePreparations goes only to the page: recipes
 * can be large, so the run file keeps this event without them.
 */
export interface CanvasRunWaitingEvent extends CanvasRunEventBase {
  type: 'run-waiting'
  waitingForVideo: false
  framePreparations: CanvasFramePreparation[]
  imagePreparations?: CanvasImagePreparation[]
}

export type CanvasRunEvent = CanvasRunNodeEvent | CanvasRunNodeStageEvent | CanvasRunWaitingEvent | CanvasRunTerminalEvent

/**
 * Published (not kept in `events`) once a finished run's charges are checked.
 * The kernel drops events of runs it no longer tracks, so a kernel that does
 * not know this type ignores it; it reads `charge` from the record instead.
 */
export interface CanvasRunChargeEvent extends CanvasRunEventBase {
  type: 'run-charge'
  charge: CanvasRunCharge
  attempts: { nodeId: string; attemptId: string; charge: CanvasRunAttemptCharge }[]
}

export interface CanvasRunOutcome {
  succeeded: string[]
  failed: string[]
  skipped: string[]
  cancelled: string[]
  cached: string[]
}

export interface CanvasRunRecord {
  version: typeof canvasRunContractVersion
  userId: number
  ownerId: number
  projectId?: string
  runId: string
  graphRevision: string
  scope: CanvasRunScope
  status: CanvasRunStatus
  createdAt: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  outcome?: CanvasRunOutcome
  nodes: CanvasRunNodeRecord[]
  events: CanvasRunEvent[]
  /** Frames the page still has to hand back; left out when none. */
  framePreparations?: CanvasFramePreparation[]
  /**
   * Pictures the page still has to make. Added from memory while the run is
   * going (canvas-run-service.ts) and never written to the run file.
   */
  imagePreparations?: CanvasImagePreparation[]
  charge?: CanvasRunCharge
}

export interface CanvasRunCacheEntry {
  version: typeof canvasRunContractVersion
  fingerprint: string
  nodeKind: CanvasRunNodeKind
  candidate?: CanvasRunCandidate
  /**
   * Every candidate, when the node handed on more than one (a grid split's
   * slices, the pictures a compare node shows), starting with `candidate`.
   * A release that predates it reads only `candidate`.
   */
  candidates?: CanvasRunCandidate[]
  outputText?: string
  createdAt: string
  lastUsedAt: string
}

export interface CanvasRunAssetManifestEntry {
  version: typeof canvasRunContractVersion
  asset: CanvasRunAsset
  createdAt: string
  lastVerifiedAt: string
  lineage?: CanvasRunAssetLineage
}

export interface CanvasRunAssetLineage {
  origin: 'generated'
  runId: string
  graphRevision: string
  nodeId: string
  attemptId: string
  candidateId: string
  projectId?: string
  sourceAssetIds: string[]
}

export function isCanvasRunEventOwnedBy(
  event: CanvasRunEvent,
  ownership: { runId: string; graphRevision: string },
): boolean {
  return event.runId === ownership.runId && event.graphRevision === ownership.graphRevision
}
