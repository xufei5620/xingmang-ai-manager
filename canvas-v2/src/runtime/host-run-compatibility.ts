// 运行请求按宿主能力收口（#4）：运行前先找出宿主做不了的节点和参数，在预检里挡下，一个付费请求都不发；
// 交给宿主的运行图只带宿主认的键。桌面在付费前也会再拒一次（#1425），这里是让用户在点运行时就看到原因，
// 而不是等主进程整单拒绝。
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { CanvasHostBridge, CanvasRunGraph } from '../host'
import { canvasNodeKindAvailable, type CanvasCapabilityProfile } from '../host-capabilities'
import type { WorkflowNodeData } from '../model'

type RunNode = CanvasRunGraph['nodes'][number]
type RunNodeData = RunNode['data']
type StartRunInput = Parameters<CanvasHostBridge['startRun']>[0]

// Labels name what the user switched on, never a field. They follow the
// desktop's own refusal wording (#1425) so both sides say the same thing.
const structuredFields: ReadonlyArray<[keyof RunNodeData, keyof CanvasCapabilityProfile['features'], string]> = [
  ['imageEditMask', 'imageEditMask', '蒙版局部修改'],
  ['commerceTask', 'scenarioTemplates', '电商创作'],
  ['interiorTask', 'scenarioTemplates', '室内创作'],
  ['exteriorTask', 'scenarioTemplates', '室外创作'],
  ['storyboardTask', 'scenarioTemplates', '故事板'],
  ['imageTransform', 'imageTools', '图片处理'],
  ['imageCollageInputOrder', 'imageTools', '图片处理'],
  ['tileInput', 'imageTools', '图片处理'],
  ['imageOutputIndex', 'imageTools', '图片处理'],
  ['frameTimestampSeconds', 'frameExtract', '视频抽帧'],
]

// The kernel's videoResolution and videoAspectRatio are MiniMax settings
// whatever the node or protocol. A host parses these three keys on every node
// in the graph and refuses the whole run on a value it does not know, so they
// are checked on any node, not only on video nodes.
function unparseableValueLabels(data: RunNodeData, profile: CanvasCapabilityProfile): string[] {
  const { video } = profile
  const labels: string[] = []
  if (data.videoResolution !== undefined && !video.miniMaxResolutions.has(data.videoResolution)) labels.push('视频分辨率')
  if (data.videoAspectRatio !== undefined && !video.miniMaxAspectRatios.has(data.videoAspectRatio)) labels.push('视频比例')
  if (!hostAcceptsSeconds(data.seconds, profile)) labels.push('视频时长')
  return labels
}

// Hosts read seconds as a plain decimal integer string ("6", never "06" or "6.0").
function hostAcceptsSeconds(value: string | undefined, profile: CanvasCapabilityProfile): boolean {
  if (value === undefined || value === '') return true
  const seconds = Number(value)
  return /^[1-9]\d*$/.test(value) && seconds >= profile.video.seconds.minimum && seconds <= profile.video.seconds.maximum
}

function nodeTitle(kind: string): string {
  return builtinNodeRegistry.resolve(kind)?.title ?? kind
}

/** Why the host cannot run any node of this kind, or undefined. */
export function canvasNodeKindUnsupportedReason(kind: string, profile: CanvasCapabilityProfile): string | undefined {
  return canvasNodeKindAvailable(kind, profile) ? undefined : `「${nodeTitle(kind)}」节点当前客户端暂不支持`
}

/**
 * Why the host cannot run this node as configured, or undefined. Values that
 * leave the request as the host already sends it (a missing key, one
 * candidate, empty reference slots) are not reasons.
 */
export function canvasRunNodeUnsupportedReason(node: RunNode, profile: CanvasCapabilityProfile): string | undefined {
  const kindReason = canvasNodeKindUnsupportedReason(node.kind, profile)
  if (kindReason) return kindReason
  const { data } = node
  const { features, video } = profile
  const reasons: string[] = []
  if ((data.imageCandidateCount ?? 1) > profile.imageCandidates.maximum) reasons.push('一次出多张图')
  if ((data.videoCandidateCount ?? 1) > profile.videoCandidates.maximum) reasons.push('一次出多个视频')
  if (data.textWebSearch === true && !features.textWebSearch) reasons.push('联网搜索')
  if (data.generateAudio !== undefined && !features.generateAudio) reasons.push('生成音频设置')
  if (data.routerStrategy !== undefined && !features.routerStrategy) reasons.push('路由策略')
  if (data.videoProtocol !== undefined && !video.protocols.has(data.videoProtocol)) reasons.push('这个视频接口')
  if ((data.videoReferenceOrder?.slots.length ?? 0) > 0 && !features.referenceOrder) reasons.push('视频参考顺序')
  if (data.imageReferenceOrder !== undefined && !features.referenceOrder) reasons.push('参考图角色')
  for (const [field, feature, label] of structuredFields) if (data[field] !== undefined && !features[feature]) reasons.push(label)
  reasons.push(...unparseableValueLabels(data, profile))
  return reasons.length ? `「${[...new Set(reasons)].join('、')}」当前客户端暂不支持` : undefined
}

/**
 * Why a node cannot run because a node feeding it is one the host cannot run.
 * A v2-era host never receives such a node, so the node it feeds would run
 * without that input and pay for a different result.
 */
export function canvasRunUpstreamUnsupportedReason(upstream: readonly RunNode[], profile: CanvasCapabilityProfile): string | undefined {
  const unavailable = upstream.find((node) => !canvasNodeKindAvailable(node.kind, profile))
  return unavailable ? `上游的「${nodeTitle(unavailable.kind)}」节点当前客户端暂不支持` : undefined
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

// Only nodes the run does not execute can still carry these values: the
// preflight blocks every one it would execute. The host never reads them on a
// node it does not run, but it parses them and would refuse the whole run.
function withoutUnparseableValues(data: RunNodeData, profile: CanvasCapabilityProfile): RunNodeData {
  const { video } = profile
  const { videoResolution, videoAspectRatio, seconds, ...rest } = data
  return {
    ...rest,
    ...(videoResolution !== undefined && video.miniMaxResolutions.has(videoResolution) ? { videoResolution } : {}),
    ...(videoAspectRatio !== undefined && video.miniMaxAspectRatios.has(videoAspectRatio) ? { videoAspectRatio } : {}),
    ...(seconds !== undefined && hostAcceptsSeconds(seconds, profile) ? { seconds } : {}),
  }
}

// The twelve keys the desktop's v2-era run parser (000f913) accepts; any other key fails the whole run.
function v2RunNodeData(data: RunNodeData): RunNodeData {
  const { prompt, model, group, quality, size, imageResolution, seconds, adoptedAssetId, videoMode, videoResolution, videoAspectRatio, promptOptimization } = data
  return withoutUndefined({ prompt, model, group, quality, size, imageResolution, seconds, adoptedAssetId, videoMode, videoResolution, videoAspectRatio, promptOptimization })
}

/**
 * The start-run request exactly as this host accepts it. A v2-era host fails
 * the whole run on a node kind or a node data key it does not know, even on a
 * node outside the run scope, so it gets neither: nodes it cannot run are left
 * out with their edges, and the rest keep only the twelve keys it parses. The
 * preflight has already blocked every enabled node in scope that this would
 * change, and every node in scope fed by a node left out, so what changes here
 * is either outside the scope, disabled or skipped, or a key still at the
 * value the host would use anyway.
 */
export function canvasRunInputForHost(input: StartRunInput, profile: CanvasCapabilityProfile): StartRunInput {
  if (input.agentExecution && !profile.features.agentExecution) throw new Error('当前客户端不支持由 Agent 发起运行')
  const v2 = profile.runNodeDataFields === 'v2'
  const kept = v2 ? input.graph.nodes.filter((node) => canvasNodeKindAvailable(node.kind, profile)) : input.graph.nodes
  const keptIds = new Set(kept.map((node) => node.id))
  const nodes = kept.map((node) => {
    const data = withoutUnparseableValues(withoutUndefined(node.data), profile)
    return { ...node, data: v2 ? v2RunNodeData(data) : data }
  })
  const edges = v2 ? input.graph.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target)) : input.graph.edges
  return { graph: { nodes, edges }, scope: input.scope, ...(input.agentExecution ? { agentExecution: input.agentExecution } : {}) }
}

/**
 * A new node's data without the defaults of switches the host has off. A
 * fresh router otherwise starts with a routing strategy, which a host without
 * routerStrategy would refuse on every run.
 */
export function withoutHostDisabledDefaults(data: WorkflowNodeData, profile: CanvasCapabilityProfile): WorkflowNodeData {
  if (profile.features.routerStrategy || !data.settings || !Object.hasOwn(data.settings, 'routerStrategy')) return data
  const { routerStrategy: _routerStrategy, ...settings } = data.settings
  const { settings: _settings, ...rest } = data
  return Object.keys(settings).length ? { ...rest, settings } : rest
}
