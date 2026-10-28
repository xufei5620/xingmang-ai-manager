import { knownNonImageModel, knownNonTextModel, knownVideoModel, imageModelPresets } from '../models'
import { CanvasAgentError, canvasAgentId, canvasAgentKeys, canvasAgentRecord, canvasAgentText, type CanvasAgentProposal } from './canvas-agent-contract'
import type { WorkflowFile } from '../model'
import { isProviderVideoProtocol, type ProviderVideoProtocol } from './provider-video-protocol'

export type CanvasAgentMediaPurpose = 'text' | 'image' | 'video'
export interface CanvasAgentMediaModel { providerId: string; model: string }
export interface CanvasAgentMediaModelsV1 { version: 1; image?: CanvasAgentMediaModel; video?: CanvasAgentMediaModel }
export interface CanvasAgentMediaModelsV2 { version: 2; image?: CanvasAgentMediaModel[]; video?: CanvasAgentMediaModel[] }
export interface CanvasAgentMediaModelsV3 { version: 3; mode: 'fixed' | 'auto'; text?: CanvasAgentMediaModel[]; image?: CanvasAgentMediaModel[]; video?: CanvasAgentMediaModel[] }
export type CanvasAgentMediaModels = CanvasAgentMediaModelsV1 | CanvasAgentMediaModelsV2 | CanvasAgentMediaModelsV3
export type CanvasAgentMediaChoiceRef = `t${number}` | `i${number}` | `v${number}`
export interface CanvasAgentMediaModelChoice extends CanvasAgentMediaModel { ref: CanvasAgentMediaChoiceRef; purpose: CanvasAgentMediaPurpose }
export interface CanvasAgentMediaModelSource { purpose: CanvasAgentMediaPurpose; providerId: string; providerName: string; models: readonly string[] }
export interface CanvasAgentRouteDecision extends CanvasAgentMediaModel {
  version: 1; nodeId: string; purpose: CanvasAgentMediaPurpose; ref: CanvasAgentMediaChoiceRef
  mode: 'fixed' | 'auto'; reasonSource: 'agent' | 'user-fixed'; routeReason?: string
  compatibility: 'compatible' | 'unconfirmed'; checks: string[]
}
export interface CanvasAgentRoutingSource { providerId: string; version: number; keyVersion: number; videoProtocol?: ProviderVideoProtocol }
export function parseCanvasAgentRoutingSources(value: unknown): CanvasAgentRoutingSource[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 24) throw new CanvasAgentError('内容模型来源快照无效', 502)
  const sources = value.map((item) => {
    const raw = canvasAgentRecord(item, '内容模型来源快照'); canvasAgentKeys(raw, ['providerId', 'version', 'keyVersion', 'videoProtocol'])
    if (![raw.version, raw.keyVersion].every((number) => Number.isSafeInteger(number) && Number(number) > 0) || raw.videoProtocol !== undefined && !isProviderVideoProtocol(raw.videoProtocol)) throw new CanvasAgentError('内容模型来源版本或协议快照无效', 502)
    return { providerId: canvasAgentId(raw.providerId), version: Number(raw.version), keyVersion: Number(raw.keyVersion), ...(raw.videoProtocol !== undefined ? { videoProtocol: raw.videoProtocol as ProviderVideoProtocol } : {}) }
  })
  if (new Set(sources.map((source) => source.providerId)).size !== sources.length) throw new CanvasAgentError('内容模型来源快照重复', 502)
  return sources
}
export function parseCanvasAgentRouteDecisions(value: unknown): CanvasAgentRouteDecision[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 40) throw new CanvasAgentError('内容模型路由回执数量无效', 502)
  const decisions = value.map((item): CanvasAgentRouteDecision => {
    const raw = canvasAgentRecord(item, '内容模型路由回执'); canvasAgentKeys(raw, ['version', 'nodeId', 'purpose', 'ref', 'providerId', 'model', 'mode', 'reasonSource', 'routeReason', 'compatibility', 'checks'])
    if (raw.version !== 1 || !['text', 'image', 'video'].includes(String(raw.purpose)) || typeof raw.ref !== 'string' || !/^[tiv][0-7]$/.test(raw.ref) || raw.ref[0] !== (raw.purpose === 'text' ? 't' : raw.purpose === 'image' ? 'i' : 'v') || !['fixed', 'auto'].includes(String(raw.mode)) || raw.reasonSource !== (raw.mode === 'fixed' ? 'user-fixed' : 'agent') || !['compatible', 'unconfirmed'].includes(String(raw.compatibility))) throw new CanvasAgentError('内容模型路由回执身份或版本无效', 502)
    if (raw.mode === 'fixed' && Object.hasOwn(raw, 'routeReason') || raw.mode === 'auto' && !Object.hasOwn(raw, 'routeReason') || !Array.isArray(raw.checks) || !raw.checks.length || raw.checks.length > 16) throw new CanvasAgentError('内容模型路由解释或核对回执不完整', 502)
    const checks = raw.checks.map((check) => canvasAgentText(check, '服务端路由核对', 200))
    if (new Set(checks).size !== checks.length) throw new CanvasAgentError('内容模型路由核对项目重复', 502)
    return { version: 1, nodeId: canvasAgentId(raw.nodeId), purpose: raw.purpose as CanvasAgentMediaPurpose, ref: raw.ref as CanvasAgentMediaChoiceRef, providerId: canvasAgentId(raw.providerId), model: canvasAgentText(raw.model, '内容模型', 200), mode: raw.mode as 'fixed' | 'auto', reasonSource: raw.reasonSource as 'agent' | 'user-fixed', ...(raw.mode === 'auto' ? { routeReason: canvasAgentText(raw.routeReason, 'Agent 路由解释', 400) } : {}), compatibility: raw.compatibility as 'compatible' | 'unconfirmed', checks }
  })
  if (new Set(decisions.map((decision) => decision.nodeId)).size !== decisions.length) throw new CanvasAgentError('内容模型路由回执节点重复', 502)
  return decisions
}

function mediaRoute(value: unknown): CanvasAgentMediaModel {
  const route = canvasAgentRecord(value, '媒体模型')
  canvasAgentKeys(route, ['providerId', 'model'])
  return { providerId: canvasAgentId(route.providerId, '媒体模型来源'), model: canvasAgentText(route.model, '媒体模型', 200) }
}
export function parseCanvasAgentMediaModels(value: unknown): CanvasAgentMediaModels | undefined {
  if (value === undefined) return undefined
  const raw = canvasAgentRecord(value, '媒体模型选择')
  canvasAgentKeys(raw, raw.version === 3 ? ['version', 'mode', 'text', 'image', 'video'] : ['version', 'image', 'video'])
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3 || !Object.hasOwn(raw, 'image') && !Object.hasOwn(raw, 'video') && !(raw.version === 3 && Object.hasOwn(raw, 'text'))) throw new CanvasAgentError('媒体模型选择版本或内容无效，请重新选择', 409)
  if (raw.version === 1) {
    const result: CanvasAgentMediaModelsV1 = { version: 1 }
    for (const purpose of ['image', 'video'] as const) if (Object.hasOwn(raw, purpose)) result[purpose] = mediaRoute(raw[purpose])
    return result
  }
  if (raw.version === 3 && raw.mode !== 'fixed' && raw.mode !== 'auto') throw new CanvasAgentError('内容模型选择模式无效，请明确固定或自动选择', 409)
  const result: CanvasAgentMediaModelsV2 | CanvasAgentMediaModelsV3 = raw.version === 3 ? { version: 3, mode: raw.mode as 'fixed' | 'auto' } : { version: 2 }
  for (const purpose of ['text', 'image', 'video'] as const) if (Object.hasOwn(raw, purpose)) {
    const candidates = raw[purpose]
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 8) throw new CanvasAgentError('每类媒体候选池需要 1–8 个模型，请明确保留候选或关闭候选池', 409)
    const parsed = candidates.map(mediaRoute), identities = parsed.map((route) => JSON.stringify([route.providerId, route.model]))
    if (new Set(identities).size !== identities.length) throw new CanvasAgentError('同一媒体候选池不能重复选择相同来源和模型', 409)
    if (result.version === 3) { if (result.mode === 'fixed' && parsed.length !== 1) throw new CanvasAgentError('固定模式每种用途必须明确选择一个内容模型', 409); result[purpose] = parsed }
    else if (purpose !== 'text') result[purpose] = parsed
  }
  return result
}
export function canvasAgentMediaModelCandidates(value: CanvasAgentMediaModels | undefined, purpose: CanvasAgentMediaPurpose): CanvasAgentMediaModel[] {
  const models = parseCanvasAgentMediaModels(value)
  if (!models || purpose === 'text' && models.version !== 3) return []
  if (models.version === 3) return (models[purpose] ?? []).map((route) => ({ ...route }))
  if (purpose === 'text') return []
  return !models[purpose] ? [] : models.version === 1 ? [{ ...models[purpose]! }] : models[purpose]!.map((route) => ({ ...route }))
}
export function canvasAgentMediaModelChoices(value: CanvasAgentMediaModels | undefined): CanvasAgentMediaModelChoice[] {
  return (['text', 'image', 'video'] as const).flatMap((purpose) => canvasAgentMediaModelCandidates(value, purpose).map((route, index) => ({ ref: `${purpose === 'text' ? 't' : purpose === 'image' ? 'i' : 'v'}${index}` as CanvasAgentMediaChoiceRef, purpose, ...route })))
}
/** Only an opaque frozen alias may arrive from the language model. */
export function resolveCanvasAgentMediaModel(kind: string, value: CanvasAgentMediaModels | undefined, reference: unknown, requiresReference: boolean): CanvasAgentMediaModel | undefined {
  const purpose = canvasAgentMediaPurpose(kind), models = parseCanvasAgentMediaModels(value)
  const candidates = purpose ? canvasAgentMediaModelCandidates(models, purpose) : []
  if (models?.version === 3) {
    if (!requiresReference || !purpose) { if (reference !== undefined) throw new CanvasAgentError('此节点或更新不允许内容模型引用', 422); return undefined }
    if (!candidates.length) throw new CanvasAgentError(`本轮未明确选择${purpose === 'text' ? '文字' : purpose === 'image' ? '图片' : '视频'}内容模型，请补齐候选池；不会改用画布默认来源`, 422)
    if (models.mode === 'fixed') { if (reference !== undefined) throw new CanvasAgentError('固定内容模型由服务端映射，规划不能指定 mediaRef', 422); return candidates[0] }
    const choice = canvasAgentMediaModelChoices(models).find((item) => item.ref === reference && item.purpose === purpose)
    if (!choice) throw new CanvasAgentError('内容生成节点必须明确选择本轮同用途 mediaRef；不会改用默认模型', 422)
    return { providerId: choice.providerId, model: choice.model }
  }
  if (models?.version !== 2) {
    if (reference !== undefined) throw new CanvasAgentError('当前规划未启用媒体候选池，不能指定 mediaRef', 422)
    return requiresReference ? candidates[0] : undefined
  }
  if (!requiresReference || !purpose || !candidates.length) {
    if (reference !== undefined) throw new CanvasAgentError('此节点或更新未配置对应媒体候选池，不能指定 mediaRef', 422)
    return undefined
  }
  const choice = canvasAgentMediaModelChoices(models).find((item) => item.ref === reference && item.purpose === purpose)
  if (!choice) throw new CanvasAgentError('媒体节点必须明确选择本轮对应用途的 mediaRef；不会改用默认模型', 422)
  return { providerId: choice.providerId, model: choice.model }
}
export function buildCanvasAgentMediaModelPrompt(value: CanvasAgentMediaModels | undefined): string {
  const models = parseCanvasAgentMediaModels(value)
  if (models?.version === 3) return `\n本轮内容模型协议v3，规划文字模型仍固定且不在内容候选池。候选：${JSON.stringify(canvasAgentMediaModelChoices(models).map(({ ref, purpose, model }) => ({ ref, purpose, model })))}。只有text-generate使用t序号，图片生成/编辑使用i序号，视频生成使用v序号；prompt、text、router等本地节点不允许模型引用。没有配置对应池时不能创建该用途的生成节点，请说明需补选并返回proposal:null。${models.mode === 'fixed' ? '本轮为固定模式，每种已配置用途唯一模型由服务端映射。禁止输出mediaRef或routeReason，不能替换为其他来源。' : '本轮为自动选择模式：每个新增生成节点、修改生成节点data的更新，顶层必须给同用途mediaRef及routeReason（1–400字符，简述为何适合此节点）。routeReason仅是Agent解释，不能假造价格、速度、质量测评或已验证能力。仅改名不能给这两个字段。'}mediaRef和routeReason不在data内，不能提供model/group/providerId、网址或密钥。具体能力仍由服务器与原执行协议检查，未知能力不代表已确认，禁止静默丢弃参数、改比例、降分辨率、替换来源或自动重试。`
  if (models?.version !== 2) return ''
  return `\n本轮启用逐节点媒体候选选择。候选池：${JSON.stringify(canvasAgentMediaModelChoices(models).map(({ ref, purpose, model }) => ({ ref, purpose, model })))}。对有候选池用途的新增媒体节点，以及修改已有媒体节点data的更新，必须在节点或更新顶层明确给mediaRef（例如i0或v0）；每个节点可以选择不同候选。mediaRef不在data内。图片仅用i序号，视频仅用v序号；未配置用途、非媒体节点和仅改名更新不能给mediaRef。不能提供model、group、providerId或来源编号。服务端仅按冻结候选映射，不自动执行、补选或重试。`
}
export function canvasAgentMediaPurpose(kind: string): CanvasAgentMediaPurpose | undefined {
  return kind === 'text-generate' ? 'text' : ['image-generate', 'image-edit', 'image'].includes(kind) ? 'image' : ['video-generate', 'video'].includes(kind) ? 'video' : undefined
}
export function assertCanvasAgentMediaModelClient(version: unknown, required: boolean, models?: CanvasAgentMediaModels): void {
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3 || required && version !== 1 && version !== 2 && version !== 3 || models?.version === 2 && version !== 2 && version !== 3 || models?.version === 3 && version !== 3) throw new CanvasAgentError(models?.version === 3 ? '此消息已固定内容模型，请刷新页面后核对原消息' : '此消息已固定图片或视频模型，请刷新页面后核对原消息', 409)
}
export function isCanvasAgentMediaModelForPurpose(purpose: CanvasAgentMediaPurpose, model: string): boolean {
  if (purpose === 'text') return !knownNonTextModel(model)
  const name = model.split('/').at(-1)!.toLowerCase()
  const video = knownVideoModel(model)
  const image = imageModelPresets.some((preset) => preset.id.toLowerCase() === name) || /^(gpt-image(?:-|$)|grok-imagine-image(?:-|$))/.test(name)
  return !(purpose === 'image' ? knownNonImageModel(model) : image || knownNonImageModel(model) && !video)
}
export function assertCanvasAgentMediaModelPurpose(purpose: CanvasAgentMediaPurpose, model: string): void {
  if (!isCanvasAgentMediaModelForPurpose(purpose, model)) throw new CanvasAgentError(`所选模型已知不属于${purpose === 'text' ? '文字' : purpose === 'image' ? '图片' : '视频'}用途，请明确选择合适模型；不会自动替换`, 409)
}
export function canvasAgentMediaModelIssue(value: CanvasAgentMediaModels | undefined, catalog: readonly CanvasAgentMediaModelSource[]): string | undefined {
  for (const { purpose, providerId, model } of canvasAgentMediaModelChoices(value)) {
    try { assertCanvasAgentMediaModelPurpose(purpose, model) } catch (error) { return error instanceof Error ? error.message : '媒体模型用途不匹配' }
    if (!catalog.some((source) => source.purpose === purpose && source.providerId === providerId && source.models.includes(model))) return `已选择的${purpose === 'text' ? '文字' : purpose === 'image' ? '图片' : '视频'}来源或模型已失效，${value?.version === 3 ? '请重新选择；未配置用途不会改用默认来源。' : '请重新选择或明确改回画布默认来源；不会自动替换。'}`
  }
  return undefined
}
/** Persisted proposals carry mapped routes, never model-supplied identities. */
export function assertCanvasAgentProposalMediaModels(proposal: CanvasAgentProposal, value: CanvasAgentMediaModels | undefined, base?: WorkflowFile): void {
  const models = parseCanvasAgentMediaModels(value)
  function matches(kind: string, data: { model?: string; group?: string }, requiresRoute: boolean): boolean {
    const purpose = canvasAgentMediaPurpose(kind), candidates = purpose ? canvasAgentMediaModelCandidates(models, purpose) : []
    return candidates.length && requiresRoute ? candidates.some((route) => route.model === data.model && route.providerId === data.group) : data.model === undefined && data.group === undefined
  }
  for (const node of proposal.nodes) {
    const purpose = canvasAgentMediaPurpose(node.kind), candidates = purpose ? canvasAgentMediaModelCandidates(models, purpose) : []
    if (models?.version === 3 && purpose && !candidates.length) throw new CanvasAgentError('提案生成节点缺少原消息对应的内容候选池', 409)
    if (candidates.length ? !matches(node.kind, node.data, true) : node.data.model !== '' || node.data.group !== undefined) throw new CanvasAgentError('提案媒体模型与原消息固定选择不一致，不能应用', 409)
  }
  for (const update of proposal.updates) {
    const data = update.data
    if (!data) continue
    const routePresent = Object.hasOwn(data, 'model') || Object.hasOwn(data, 'group')
    const node = base?.nodes.find((item) => item.id === update.nodeId)
    if (node) {
      const purpose = canvasAgentMediaPurpose(node.kind), candidates = purpose ? canvasAgentMediaModelCandidates(models, purpose) : []
      if (models?.version === 3 && purpose && !candidates.length) throw new CanvasAgentError('提案更新缺少原消息对应的内容候选池', 409)
      if (candidates.length ? !matches(node.kind, data, true) : routePresent) throw new CanvasAgentError('节点更新的媒体模型与原选择不一致，不能应用', 409)
    } else if (routePresent && !canvasAgentMediaModelChoices(models).some((route) => route.model === data.model && route.providerId === data.group)) throw new CanvasAgentError('节点更新的媒体模型与原选择不一致，不能应用', 409)
  }
  if (models?.version !== 3) { if (proposal.routeDecisions !== undefined) throw new CanvasAgentError('旧版媒体提案不能携带新版内容路由回执', 409); return }
  const decisions = parseCanvasAgentRouteDecisions(proposal.routeDecisions)
  if (!decisions) throw new CanvasAgentError('新版内容模型提案缺少服务端路由回执', 409)
  const expected = [
    ...proposal.nodes.filter((node) => canvasAgentMediaPurpose(node.kind)).map((node) => ({ nodeId: node.id, purpose: canvasAgentMediaPurpose(node.kind), data: node.data })),
    ...proposal.updates.filter((update) => update.data && (base ? canvasAgentMediaPurpose(base.nodes.find((node) => node.id === update.nodeId)?.kind ?? '') : Object.hasOwn(update.data, 'group') || Object.hasOwn(update.data, 'model'))).map((update) => ({ nodeId: update.nodeId, purpose: base ? canvasAgentMediaPurpose(base.nodes.find((node) => node.id === update.nodeId)?.kind ?? '') : undefined, data: update.data! })),
  ]
  if (decisions.length !== expected.length || expected.some((target) => !decisions.some((decision) => decision.nodeId === target.nodeId && (!target.purpose || decision.purpose === target.purpose) && decision.providerId === target.data.group && decision.model === target.data.model && decision.mode === models.mode && canvasAgentMediaModelChoices(models).some((choice) => choice.ref === decision.ref && choice.purpose === decision.purpose && choice.providerId === decision.providerId && choice.model === decision.model)))) throw new CanvasAgentError('内容路由回执与原候选、节点或提案不一致', 409)
}
