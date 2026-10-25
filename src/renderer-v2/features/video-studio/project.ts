import type { AiChatGroupSummary, AiVideoClip, AiVideoGenerateInput, AiVideoProgressEvent, VideoStudioPlan } from '../../../../electron/ipc-contract'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { buildChatCatalog, pickChatGroup, resolveDefaultChatModel, type ChatCatalogEntry, type ChatGroupPreparation, type ChatSite } from '../chat/state'
import { inspectModel } from '../chat/api'
import { isVideoStudioAspect, isVideoStudioFit, isVideoStudioResolution, normalizeVideoStudioCaption, type VideoStudioAspect, type VideoStudioFit, type VideoStudioResolution } from './timeline'

// 视频剪辑页的一份工程：想法、分镜、每个镜头生成好的片段，以及上一次拼好的成片。这里全是纯计算，
// 页面和测试都直接调；请求在 useVideoStudio 里发。

export type VideoStudioShotStatus = 'idle' | 'queued' | 'generating' | 'done' | 'failed'

export interface VideoStudioShot {
  id: string
  prompt: string
  caption: string
  /** 生成好的片段；重新生成成功前一直留着上一段。 */
  clip?: AiVideoClip
  // 下面几项只在这一次打开页面时有，不存。
  status: VideoStudioShotStatus
  requestId?: string
  stage?: AiVideoProgressEvent['stage']
  progress?: number
  delayed?: boolean
  error?: string
}

export interface VideoStudioSettings {
  idea: string
  shotCount: number
  secondsPerShot: number
  aspect: VideoStudioAspect
  captions: boolean
  textModel: string
  textGroup: string
  videoModel: string
  videoGroup: string
  resolution: VideoStudioResolution
  fit: VideoStudioFit
}

export interface VideoStudioProject {
  version: 1
  settings: VideoStudioSettings
  title: string
  shots: VideoStudioShot[]
  /** 上一次拼好、存进作品库的成片。 */
  exported?: AiVideoClip
}

export const videoStudioShotCounts = [1, 2, 3, 4, 5, 6, 8, 10, 12] as const
const secondsChoices = [3, 4, 5, 6, 8, 10, 12, 15] as const
// 优先 Grok：1 到 15 秒都能出、只要一句描述；MiniMax 最短 5 秒。账号里都没有就取模型表里第一个。
const preferredVideoModels = ['grok-imagine-video-1.5', 'grok-imagine-video', 'minimax-h3-base', 'minimax-h3-fast', 'minimax-h3-mini'] as const
// Grok 视频只认这几种宽高（ai-chat-protocol.ts 的 allowedVideoDimensions）。
const grokDimensions: Readonly<Record<VideoStudioAspect, { width: number, height: number }>> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1024, height: 1024 },
}

export const videoStudioAspectNames: Readonly<Record<VideoStudioAspect, string>> = { '16:9': '横屏 16:9', '9:16': '竖屏 9:16', '1:1': '方形 1:1' }
export const videoStudioFitNames: Readonly<Record<VideoStudioFit, string>> = { cover: '裁边铺满', contain: '补黑边' }

export function createVideoStudioId(): string {
  return crypto.randomUUID()
}

export function defaultVideoStudioSettings(): VideoStudioSettings {
  return { idea: '', shotCount: 4, secondsPerShot: 6, aspect: '9:16', captions: true, textModel: '', textGroup: '', videoModel: '', videoGroup: '', resolution: 720, fit: 'cover' }
}

export function createVideoStudioProject(settings: VideoStudioSettings = defaultVideoStudioSettings()): VideoStudioProject {
  return { version: 1, settings: { ...settings }, title: '', shots: [] }
}

/** 这个视频模型一段能出几秒；认不出时按 1 到 15 秒算，交给主进程再核。 */
export function videoModelSeconds(model: string): { minimum: number, maximum: number } {
  try {
    const capability = inspectModel(model)
    if (capability.kind === 'video') return { minimum: capability.minimumSeconds, maximum: capability.maximumSeconds }
  } catch {
    // 落到下面的缺省。
  }
  return { minimum: 1, maximum: 15 }
}

export function videoStudioSecondsChoices(model: string): number[] {
  const { minimum, maximum } = videoModelSeconds(model)
  return secondsChoices.filter((seconds) => seconds >= minimum && seconds <= maximum)
}

/** 换了视频模型以后，每段时长挪到这个模型能出的、离原来最近的那一档。 */
export function clampVideoStudioSeconds(seconds: number, model: string): number {
  const choices = videoStudioSecondsChoices(model)
  if (!choices.length) return seconds
  return choices.reduce((best, choice) => Math.abs(choice - seconds) < Math.abs(best - seconds) ? choice : best)
}

export interface VideoStudioCatalogs { text: ChatCatalogEntry[]; video: ChatCatalogEntry[] }

/** 各分组读到的模型并成两张表：写分镜用的文字模型、出片段用的视频模型。 */
export function buildVideoStudioCatalogs(groups: readonly Pick<AiChatGroupSummary, 'name'>[], preparations: Readonly<Record<string, ChatGroupPreparation | undefined>>): VideoStudioCatalogs {
  const video = new Map<string, ChatCatalogEntry>()
  for (const group of groups) {
    const prepared = preparations[group.name]
    if (!prepared || prepared.phase === 'error') continue
    for (const model of prepared.models) {
      let capability
      try { capability = inspectModel(model) } catch { continue }
      if (capability.kind !== 'video' || !capability.available || capability.hidden) continue
      const entry = video.get(model)
      if (entry) { if (!entry.groups.includes(group.name)) entry.groups.push(group.name) } else video.set(model, { model, groups: [group.name] })
    }
  }
  // 准备分组时已经滤过藏起来的模型（useVideoStudio）；这里再滤一遍，表永远不列用不了的。
  const text = buildChatCatalog(groups, preparations, 'text').filter((entry) => {
    try { const capability = inspectModel(entry.model); return capability.available && !capability.hidden } catch { return false }
  })
  return { text, video: [...video.values()] }
}

export interface VideoStudioModelContext { groups: readonly (Pick<AiChatGroupSummary, 'name' | 'recommended'> & Partial<Pick<AiChatGroupSummary, 'ratio'>>)[]; site: ChatSite; settled: boolean }

/**
 * 记着的两个模型按这两张表落定，同聊天页 settleChatModel 的规矩：模型还在就挑一个有它的分组；不在了，
 * 等各分组都读完再换成默认的。视频模型按出图的规矩挑分组（先挑图片分组，视频模型都在那里）。
 */
export function settleVideoStudioModels(settings: VideoStudioSettings, catalogs: VideoStudioCatalogs, context: VideoStudioModelContext): Pick<VideoStudioSettings, 'textModel' | 'textGroup' | 'videoModel' | 'videoGroup' | 'secondsPerShot'> {
  const text = settleOne(settings.textModel, settings.textGroup, catalogs.text, context, 'text', (models) => resolveDefaultChatModel('text', models))
  const video = settleOne(settings.videoModel, settings.videoGroup, catalogs.video, context, 'image', (models) => preferredVideoModels.find((model) => models.includes(model)) ?? models[0] ?? '')
  return {
    textModel: text.model, textGroup: text.group, videoModel: video.model, videoGroup: video.group,
    secondsPerShot: video.model ? clampVideoStudioSeconds(settings.secondsPerShot, video.model) : settings.secondsPerShot,
  }
}

function settleOne(model: string, group: string, catalog: readonly ChatCatalogEntry[], context: VideoStudioModelContext, mode: 'text' | 'image', fallback: (models: string[]) => string): { model: string, group: string } {
  const pick = (entry: ChatCatalogEntry) => ({ model: entry.model, group: pickChatGroup(entry.groups, { groups: context.groups, site: context.site, current: group, mode }) })
  const remembered = model ? catalog.find((entry) => entry.model === model) : undefined
  if (remembered) return pick(remembered)
  if (!context.settled || !catalog.length) return { model, group }
  const chosen = catalog.find((entry) => entry.model === fallback(catalog.map((item) => item.model)))
  return chosen ? pick(chosen) : { model, group }
}

/** 分镜写好了：换上新的镜头。原来的镜头和片段都不要了（片段还在作品库里）。 */
export function applyVideoStudioPlan(project: VideoStudioProject, plan: VideoStudioPlan, createId: () => string = createVideoStudioId): VideoStudioProject {
  const { exported: _previous, ...rest } = project
  return {
    ...rest,
    title: plan.title,
    shots: plan.shots.map((shot) => ({ id: createId(), prompt: shot.prompt, caption: shot.caption ?? '', status: 'idle' })),
  }
}

export function updateVideoStudioShot(project: VideoStudioProject, id: string, change: (shot: VideoStudioShot) => VideoStudioShot): VideoStudioProject {
  return { ...project, shots: project.shots.map((shot) => shot.id === id ? change(shot) : shot) }
}

export function moveVideoStudioShot(project: VideoStudioProject, id: string, offset: -1 | 1): VideoStudioProject {
  const from = project.shots.findIndex((shot) => shot.id === id)
  const to = from + offset
  if (from < 0 || to < 0 || to >= project.shots.length) return project
  const shots = [...project.shots]
  const [moved] = shots.splice(from, 1)
  shots.splice(to, 0, moved)
  return { ...project, shots }
}

export function removeVideoStudioShot(project: VideoStudioProject, id: string): VideoStudioProject {
  return { ...project, shots: project.shots.filter((shot) => shot.id !== id) }
}

export function canAddVideoStudioShot(project: VideoStudioProject): boolean {
  return project.shots.length < videoStudioPlanLimits.maximumShots
}

export function addVideoStudioShot(project: VideoStudioProject, createId: () => string = createVideoStudioId): VideoStudioProject {
  if (!canAddVideoStudioShot(project)) return project
  return { ...project, shots: [...project.shots, { id: createId(), prompt: '', caption: '', status: 'idle' }] }
}

export function isVideoStudioShotBusy(shot: VideoStudioShot): boolean {
  return shot.status === 'queued' || shot.status === 'generating'
}

/** 这一镜交给视频模型之前要先改好的地方；没问题是 null。 */
export function videoStudioShotProblem(shot: VideoStudioShot, index: number): string | null {
  if (!shot.prompt.trim()) return `第 ${index + 1} 个镜头还没写画面描述`
  if (shot.prompt.length > videoStudioPlanLimits.maximumPromptLength) return `第 ${index + 1} 个镜头的画面描述太长了，删到 ${videoStudioPlanLimits.maximumPromptLength} 个字以内`
  return null
}

/** 出一段片段的请求。视频模型按它自己那家的写法给画面比例。 */
export function buildVideoStudioClipRequest(settings: VideoStudioSettings, shot: VideoStudioShot, requestId: string): AiVideoGenerateInput {
  const base = { requestId, group: settings.videoGroup, model: settings.videoModel, prompt: shot.prompt.trim(), seconds: String(settings.secondsPerShot) }
  let provider = ''
  try {
    const capability = inspectModel(settings.videoModel)
    if (capability.kind === 'video') provider = capability.provider
  } catch {
    // 认不出的模型交给主进程报错。
  }
  if (provider === 'minimax-h3') return { ...base, mode: 't2va', resolution: '720p', aspectRatio: settings.aspect, promptOptimization: false }
  return { ...base, ...grokDimensions[settings.aspect] }
}

/** 能拼了：至少一个镜头，每个镜头都有片段、没有正在生成的。 */
export function videoStudioReadyToCompose(project: VideoStudioProject): boolean {
  return project.shots.length > 0 && project.shots.every((shot) => shot.clip && !isVideoStudioShotBusy(shot))
}

/** 拼片时每一段烧上的字幕；关了字幕就都不烧。 */
export function videoStudioComposeCaptions(project: VideoStudioProject): string[] {
  return project.shots.map((shot) => project.settings.captions ? normalizeVideoStudioCaption(shot.caption) : '')
}

// —— 存到这台电脑上 ——
// 存的是想法、设置、分镜和片段编号，片段本身在作品库里。生成中、排队这类只在这次打开时有的
// 状态不存：重开以后没有片段的镜头一律当还没生成。

const maxStoredIdeaLength = videoStudioPlanLimits.maximumIdeaLength
const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

function readModelName(value: unknown): string {
  return typeof value === 'string' && value.length <= 200 && !/[\x00-\x1F\x7F]/.test(value) ? value : ''
}

function readPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readClip(value: unknown): AiVideoClip | undefined {
  if (!isRecord(value) || typeof value.assetId !== 'string' || !assetIdPattern.test(value.assetId)) return undefined
  // 缩略图地址只收主进程给的那种（electron/asset-thumbnail.ts），而且要是同一段视频的。
  if (typeof value.thumbnailUrl !== 'string' || !/^xingmang-asset:\/\/thumb\/v[0-9]{1,4}\/video\/[A-Za-z0-9_-]{43}$/.test(value.thumbnailUrl) || !value.thumbnailUrl.endsWith(`/${value.assetId}`)) return undefined
  const width = readPositive(value.width), height = readPositive(value.height), durationSeconds = readPositive(value.durationSeconds)
  return {
    assetId: value.assetId, thumbnailUrl: value.thumbnailUrl,
    ...(width ? { width } : {}), ...(height ? { height } : {}), ...(durationSeconds ? { durationSeconds } : {}),
  }
}

export function serializeVideoStudioProject(project: VideoStudioProject): unknown {
  return {
    version: 1,
    settings: project.settings,
    title: project.title,
    shots: project.shots.map((shot) => ({ id: shot.id, prompt: shot.prompt, caption: shot.caption, ...(shot.clip ? { clip: shot.clip } : {}) })),
    ...(project.exported ? { exported: project.exported } : {}),
  }
}

/** 读回存着的工程。认不出的项换成缺省，整份认不出就是 null。 */
export function restoreVideoStudioProject(value: unknown, createId: () => string = createVideoStudioId): VideoStudioProject | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.settings)) return null
  const stored = value.settings
  const defaults = defaultVideoStudioSettings()
  const shotCount = typeof stored.shotCount === 'number' && (videoStudioShotCounts as readonly number[]).includes(stored.shotCount) ? stored.shotCount : defaults.shotCount
  const seconds = typeof stored.secondsPerShot === 'number' && Number.isInteger(stored.secondsPerShot)
    && stored.secondsPerShot >= videoStudioPlanLimits.minimumSecondsPerShot && stored.secondsPerShot <= videoStudioPlanLimits.maximumSecondsPerShot
    ? stored.secondsPerShot : defaults.secondsPerShot
  const settings: VideoStudioSettings = {
    idea: readText(stored.idea, maxStoredIdeaLength),
    shotCount,
    secondsPerShot: seconds,
    aspect: isVideoStudioAspect(stored.aspect) ? stored.aspect : defaults.aspect,
    captions: typeof stored.captions === 'boolean' ? stored.captions : defaults.captions,
    textModel: readModelName(stored.textModel),
    textGroup: readModelName(stored.textGroup),
    videoModel: readModelName(stored.videoModel),
    videoGroup: readModelName(stored.videoGroup),
    resolution: isVideoStudioResolution(stored.resolution) ? stored.resolution : defaults.resolution,
    fit: isVideoStudioFit(stored.fit) ? stored.fit : defaults.fit,
  }
  const ids = new Set<string>()
  const shots: VideoStudioShot[] = []
  for (const entry of Array.isArray(value.shots) ? value.shots.slice(0, videoStudioPlanLimits.maximumShots) : []) {
    if (!isRecord(entry)) continue
    let id = typeof entry.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(entry.id) ? entry.id : createId()
    if (ids.has(id)) id = createId()
    ids.add(id)
    const clip = readClip(entry.clip)
    shots.push({
      id,
      prompt: readText(entry.prompt, videoStudioPlanLimits.maximumPromptLength),
      caption: readText(entry.caption, videoStudioPlanLimits.maximumCaptionLength),
      ...(clip ? { clip } : {}),
      status: clip ? 'done' : 'idle',
    })
  }
  const exported = readClip(value.exported)
  return { version: 1, settings, title: readText(value.title, videoStudioPlanLimits.maximumTitleLength), shots, ...(exported ? { exported } : {}) }
}

export function videoStudioStorageKey(scope: string): string {
  return `xingmang-ui-v2:video-studio:${scope}`
}
