import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import { aiVideoUnconfirmedSubmissionMessage } from '../../../../electron/ai-video-submission'
import type { ImageSizePolicy } from '../../../../electron/ai-chat-protocol'
import type { AiChatGroupSummary, AiChatImageInput, AiVideoClip, AiVideoGenerateInput, AiVideoProgressEvent, VideoStudioMusic, VideoStudioPlan } from '../../../../electron/ipc-contract'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { buildChatCatalog, pickChatGroup, resolveDefaultChatModel, type ChatCatalogEntry, type ChatGroupPreparation, type ChatSite } from '../chat/state'
import { inspectModel } from '../chat/api'
import { isVideoStudioAspect, isVideoStudioFit, isVideoStudioResolution, normalizeVideoStudioCaption, type VideoStudioAspect, type VideoStudioFit, type VideoStudioResolution } from './timeline'

// 视频剪辑页的一份工程：想法、分镜、每个镜头生成好的片段，以及上一次拼好的成片。这里全是纯计算，
// 页面和测试都直接调；请求在 useVideoStudio 里发。

export type VideoStudioShotStatus = 'idle' | 'queued' | 'generating' | 'done' | 'failed'

/**
 * 这一镜开头用的那张图：客户从电脑里选的（chat:pick-images，和对话里附的图片同一个作品库）。只存编号，
 * 地址按编号现拼（作品库的图片地址只有这一种写法），存着的地址不信。
 */
export interface VideoStudioShotImage {
  assetId: string
  url: string
}

/** 有配乐时片段原声怎么放：照常、调小、关掉。 */
export type VideoStudioClipSound = 'normal' | 'quiet' | 'off'

/**
 * 背景音乐：客户从电脑里选的一首歌（video-studio:pick-music，存进作品库的音频那一格）。只存编号、
 * 文件名和时长，歌本身在作品库里，拼片时按编号读回来。
 */
export interface VideoStudioMusicChoice extends VideoStudioMusic {
  clipSound: VideoStudioClipSound
}

export interface VideoStudioShot {
  id: string
  prompt: string
  caption: string
  /** 生成时从这张图开始动起来；没有就只按画面描述出。换图不动已经生成好的片段，重新生成才用上。 */
  image?: VideoStudioShotImage
  /** 生成好的片段；重新生成成功前一直留着上一段。 */
  clip?: AiVideoClip
  /** 拼片时这一段开头、结尾各剪掉几秒（videoStudioTrimChoices 里的一档，0 不存）。跟着片段走，换了新片段就清掉。 */
  trimStart?: number
  trimEnd?: number
  /**
   * 正在生成、或者没等到结果就失败了的那一次请求。会存下来：关掉软件再打开，拿它回主进程把那一段接回来，
   * 钱已经扣了的片段不会只留在作品库里、镜头上却显示「还没生成」。
   */
  requestId?: string
  /**
   * 上一次提交没等到服务端的答复（回包丢了、服务端出错、提交到一半点了停止）：那一单可能已经扣了钱，
   * 却没有任务号，接不回来。跟请求号一起存下，重开以后照样是「没生成出来」加主进程那句提醒，
   * 不能变回「还没生成」；再生成时确认框另外说清可能多扣一次，并沿用这个请求号（#1489 N2）。
   * 沿用请求号重新出着的时候也留着，只是不存；出成了才去掉。
   */
  unconfirmed?: boolean
  // 下面几项只在这一次打开页面时有，不存。
  /** 正在让 AI 画这一镜的图：那一次的请求号（停下时拿它去取消）。 */
  drawing?: string
  /** 上一次让 AI 画图没画出来的原因。 */
  drawError?: string
  status: VideoStudioShotStatus
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
  /** 「让 AI 画一张」用的画图模型和它的分组。 */
  imageModel: string
  imageGroup: string
  resolution: VideoStudioResolution
  fit: VideoStudioFit
}

export interface VideoStudioProject {
  version: 1
  settings: VideoStudioSettings
  title: string
  shots: VideoStudioShot[]
  /** 背景音乐；没有就只用片段原声。 */
  music?: VideoStudioMusicChoice
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
export const videoStudioClipSounds = ['normal', 'quiet', 'off'] as const satisfies readonly VideoStudioClipSound[]
export const videoStudioClipSoundNames: Readonly<Record<VideoStudioClipSound, string>> = { normal: '照常', quiet: '调小', off: '关掉' }
// 两路声音各放多大。照常：人声、现场声在前，歌垫在底下；调小：歌在前，原声留一点；关掉：只剩歌，
// 留一点余量不顶满（两路相加超过满格的会被截掉，听着发闷）。
const clipSoundGains: Readonly<Record<VideoStudioClipSound, { clip: number, music: number }>> = {
  normal: { clip: 1, music: 0.3 },
  quiet: { clip: 0.3, music: 0.7 },
  off: { clip: 0, music: 0.9 },
}

export function createVideoStudioId(): string {
  return crypto.randomUUID()
}

export function defaultVideoStudioSettings(): VideoStudioSettings {
  return { idea: '', shotCount: 4, secondsPerShot: 6, aspect: '9:16', captions: true, textModel: '', textGroup: '', videoModel: '', videoGroup: '', imageModel: '', imageGroup: '', resolution: 720, fit: 'cover' }
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

export interface VideoStudioCatalogs { text: ChatCatalogEntry[]; video: ChatCatalogEntry[]; image: ChatCatalogEntry[] }

function usableModel(entry: ChatCatalogEntry): boolean {
  try { const capability = inspectModel(entry.model); return capability.available && !capability.hidden } catch { return false }
}

/** 各分组读到的模型并成三张表：写分镜用的文字模型、出片段用的视频模型、画镜头图用的画图模型。 */
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
  const text = buildChatCatalog(groups, preparations, 'text').filter(usableModel)
  const image = buildChatCatalog(groups, preparations, 'image').filter(usableModel)
  return { text, video: [...video.values()], image }
}

export interface VideoStudioModelContext { groups: readonly (Pick<AiChatGroupSummary, 'name' | 'recommended'> & Partial<Pick<AiChatGroupSummary, 'ratio'>>)[]; site: ChatSite; settled: boolean }

/**
 * 记着的两个模型按这两张表落定，同聊天页 settleChatModel 的规矩：模型还在就挑一个有它的分组；不在了，
 * 等各分组都读完再换成默认的。视频模型按出图的规矩挑分组（先挑图片分组，视频模型都在那里）。
 */
export function settleVideoStudioModels(settings: VideoStudioSettings, catalogs: VideoStudioCatalogs, context: VideoStudioModelContext): Pick<VideoStudioSettings, 'textModel' | 'textGroup' | 'videoModel' | 'videoGroup' | 'imageModel' | 'imageGroup' | 'secondsPerShot'> {
  const text = settleOne(settings.textModel, settings.textGroup, catalogs.text, context, 'text', (models) => resolveDefaultChatModel('text', models))
  const video = settleOne(settings.videoModel, settings.videoGroup, catalogs.video, context, 'image', (models) => preferredVideoModels.find((model) => models.includes(model)) ?? models[0] ?? '')
  // 画图模型的默认同聊天页出图那一档（chat/state.ts 的 DEFAULT_IMAGE_MODELS），没有就取表里第一个。
  const image = settleOne(settings.imageModel, settings.imageGroup, catalogs.image, context, 'image', (models) => resolveDefaultChatModel('image', models))
  return {
    textModel: text.model, textGroup: text.group, videoModel: video.model, videoGroup: video.group, imageModel: image.model, imageGroup: image.group,
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

/**
 * 分镜写好了：换上新的镜头。原来的镜头和片段都不要了（片段还在作品库里）。客户给镜头选过的图按位置留下：
 * 第几镜选的图还给新的第几镜，商品图、人物照片不用重选；多出来的那几张不要了。
 */
export function applyVideoStudioPlan(project: VideoStudioProject, plan: VideoStudioPlan, createId: () => string = createVideoStudioId): VideoStudioProject {
  const { exported: _previous, ...rest } = project
  return {
    ...rest,
    title: plan.title,
    shots: plan.shots.map((shot, index) => {
      const image = project.shots[index]?.image
      return { id: createId(), prompt: shot.prompt, caption: shot.caption ?? '', ...(image ? { image } : {}), status: 'idle' }
    }),
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

/**
 * 每段开头、结尾能剪掉的几档秒数（0 是不剪）。AI 片段常见开头一秒发呆、结尾一秒走样，这几档够用；
 * 页面里放不了视频（主窗口不开 media-src），拖动条找不准位置，按档选反而好用。
 */
export const videoStudioTrimChoices: readonly number[] = [0, 0.5, 1, 1.5, 2, 3]
export type VideoStudioTrimSide = 'start' | 'end'
// 剪完至少留这么长，不然这一段在成片里一闪就过去了。
const minimumTrimmedSeconds = 1

function isVideoStudioTrim(value: unknown): value is number {
  return typeof value === 'number' && videoStudioTrimChoices.includes(value)
}

/** 这一镜这一头能选哪几档：剪完至少留 1 秒（片段时长读不到就按「每段时长」算）；现在选着的那档总在里面。 */
export function videoStudioTrimOptions(shot: Pick<VideoStudioShot, 'clip' | 'trimStart' | 'trimEnd'>, side: VideoStudioTrimSide, secondsPerShot: number): number[] {
  const current = (side === 'start' ? shot.trimStart : shot.trimEnd) ?? 0
  const other = (side === 'start' ? shot.trimEnd : shot.trimStart) ?? 0
  const duration = shot.clip?.durationSeconds ?? secondsPerShot
  return videoStudioTrimChoices.filter((choice) => choice === current || duration - other - choice >= minimumTrimmedSeconds)
}

/**
 * 改这一段剪掉多少。只有生成好、没在重新生成的片段能剪；不在可选那几档里的不收。
 * 剪的长短一变，上一次的成片就跟现在对不上了，不再挂在这里（文件还在作品库里）。
 */
export function setVideoStudioShotTrim(project: VideoStudioProject, id: string, side: VideoStudioTrimSide, seconds: number): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot?.clip || isVideoStudioShotBusy(shot) || !videoStudioTrimOptions(shot, side, project.settings.secondsPerShot).includes(seconds)) return project
  if (((side === 'start' ? shot.trimStart : shot.trimEnd) ?? 0) === seconds) return project
  const start = side === 'start' ? seconds : shot.trimStart ?? 0
  const end = side === 'end' ? seconds : shot.trimEnd ?? 0
  const updated = updateVideoStudioShot(project, id, ({ trimStart: _start, trimEnd: _end, ...rest }) => ({ ...rest, ...(start ? { trimStart: start } : {}), ...(end ? { trimEnd: end } : {}) }))
  return { ...updated, exported: undefined }
}

/** 换上新片段时用：上一段剪掉多少对新片段没有意义。 */
export function withoutVideoStudioTrim<T extends Pick<VideoStudioShot, 'trimStart' | 'trimEnd'>>(shot: T): Omit<T, 'trimStart' | 'trimEnd'> {
  const { trimStart: _start, trimEnd: _end, ...rest } = shot
  return rest
}

/** 分镜卡上「共约 T 秒」：每段按「每段时长」算，减掉剪掉的。 */
export function videoStudioTotalSeconds(project: VideoStudioProject): number {
  const { secondsPerShot } = project.settings
  return Math.round(project.shots.reduce((total, shot) => total + secondsPerShot - (shot.trimStart ?? 0) - (shot.trimEnd ?? 0), 0))
}

/** 这一镜正在让 AI 画图。画着的时候不出这一镜的视频、不换它的图，不然画好的图和片段对不上。 */
export function isVideoStudioShotDrawing(shot: VideoStudioShot): boolean {
  return Boolean(shot.drawing)
}

/** 开始给这一镜画图：记下请求号，清掉上一次没画出来的原因。正在出视频、已经在画的不动。 */
export function startVideoStudioShotDrawing(project: VideoStudioProject, id: string, requestId: string): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot || isVideoStudioShotBusy(shot) || shot.drawing) return project
  return updateVideoStudioShot(project, id, ({ drawError: _error, ...rest }) => ({ ...rest, drawing: requestId }))
}

/**
 * 这一次画图有了结果：画好了就换上这张图（和自己选的图一样用），没画出来就记下原因，停下了两样都不留。
 * 只认还挂着同一个请求号的那一镜：中途停了又重画、镜头被删了，迟到的结果不会盖上去。
 */
export function finishVideoStudioShotDrawing(project: VideoStudioProject, id: string, requestId: string, result: { assetId: string } | { error: string } | 'stopped'): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot || shot.drawing !== requestId) return project
  const image = typeof result === 'object' && 'assetId' in result ? videoStudioShotImage(result.assetId) : null
  return updateVideoStudioShot(project, id, ({ drawing: _drawing, drawError: _error, ...rest }) => ({
    ...rest,
    ...(image ? { image } : {}),
    ...(typeof result === 'object' && 'error' in result ? { drawError: result.error } : {}),
  }))
}

/** 作品库里一张图的编号换成这一镜存的样子；编号不对是 null。 */
export function videoStudioShotImage(assetId: unknown): VideoStudioShotImage | null {
  return typeof assetId === 'string' && assetIdPattern.test(assetId) ? { assetId, url: `xingmang-asset://image/${assetId}` } : null
}

/**
 * 一次选了几张图：第一张给点按钮的那一镜，剩下的按顺序给它后面还没有图、也没在生成的镜头，放不下的不要。
 * 一张一张点太累，客户多选了几张多半就是想一镜一张。
 */
export function assignVideoStudioShotImages(project: VideoStudioProject, id: string, assetIds: readonly string[]): VideoStudioProject {
  const images = assetIds.flatMap((assetId) => videoStudioShotImage(assetId) ?? [])
  const from = project.shots.findIndex((shot) => shot.id === id)
  if (from < 0 || !images.length || isVideoStudioShotBusy(project.shots[from])) return project
  const [first, ...rest] = images
  return {
    ...project,
    shots: project.shots.map((shot, index) => {
      if (index === from) return { ...shot, image: first }
      if (index < from || shot.image || isVideoStudioShotBusy(shot)) return shot
      const next = rest.shift()
      return next ? { ...shot, image: next } : shot
    }),
  }
}

export function removeVideoStudioShotImage(project: VideoStudioProject, id: string): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot?.image || isVideoStudioShotBusy(shot)) return project
  return updateVideoStudioShot(project, id, (item) => {
    const { image: _image, ...rest } = item
    return rest
  })
}

// 想法和画面描述是多行输入框里打的字，粘贴时可能带进看不见的控制字符（垂直制表、退格这类）。主进程见到就整句拒掉，
// 报的是对不上原因的「想法要写 1 到 2000 个字」；发之前先去掉，换行和制表照留（同主进程那条规矩，canvas-request-parser.ts）。
const invisibleControls = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/** 交给主进程的那句话：去掉看不见的控制字符和首尾空白。 */
export function videoStudioPlainText(value: string): string {
  return value.replace(invisibleControls, '').trim()
}

/** 这一镜交给视频模型之前要先改好的地方；没问题是 null。 */
export function videoStudioShotProblem(shot: VideoStudioShot, index: number): string | null {
  if (!videoStudioPlainText(shot.prompt)) return `第 ${index + 1} 个镜头还没写画面描述`
  if (shot.prompt.length > videoStudioPlanLimits.maximumPromptLength) return `第 ${index + 1} 个镜头的画面描述太长了，删到 ${videoStudioPlanLimits.maximumPromptLength} 个字以内`
  return null
}

const aspectRatios: Readonly<Record<VideoStudioAspect, number>> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

/**
 * 画镜头图的尺寸跟「画面」那一项走。只收固定几种尺寸的模型挑长宽比最接近的那一种（只有 auto 的就交给它自己定）；
 * 能自己定长宽的按 720p 算（短边 720，同片段默认的清晰度；模型上限更小就整体缩到上限），两边都取它要的倍数。
 * 图再大也只是拿来当第一帧，出得越大越贵。
 */
export function videoStudioImageSize(policy: ImageSizePolicy, aspect: VideoStudioAspect): string {
  const ratio = aspectRatios[aspect]
  if (policy.kind === 'allow-list') {
    let best = policy.default, distance = Number.POSITIVE_INFINITY
    for (const value of policy.values) {
      const match = /^(\d+)x(\d+)$/.exec(value)
      if (!match) continue
      const gap = Math.abs(Math.log(Number(match[1]) / Number(match[2]) / ratio))
      if (gap < distance) { best = value; distance = gap }
    }
    return best
  }
  const short = 720
  const width = ratio >= 1 ? short * ratio : short, height = ratio >= 1 ? short : short / ratio
  const scale = Math.min(1, policy.max / Math.max(width, height))
  const fit = (side: number) => Math.min(policy.max, Math.max(policy.min, Math.round(side * scale / policy.divisor) * policy.divisor))
  return `${fit(width)}x${fit(height)}`
}

/** 让 AI 按这一镜的画面描述画一张图的请求；画质用模型自己的缺省（最便宜的那一档），先出图就是为了省钱。 */
export function buildVideoStudioImageRequest(settings: VideoStudioSettings, shot: VideoStudioShot, requestId: string): AiChatImageInput {
  let size: string | undefined
  try {
    const capability = inspectModel(settings.imageModel)
    if (capability.kind === 'image') size = videoStudioImageSize(capability.sizePolicy, settings.aspect)
  } catch {
    // 认不出的模型交给主进程去拒。
  }
  return { requestId, group: settings.imageGroup, model: settings.imageModel, prompt: videoStudioPlainText(shot.prompt), ...(size ? { size } : {}) }
}

/**
 * 出一段片段的请求。视频模型按它自己那家的写法给画面比例。这一镜选了图就从这张图开头：Grok 拿它当第一帧，
 * MiniMax 换成「图生视频」（i2va，只收一张图）。
 */
export function buildVideoStudioClipRequest(settings: VideoStudioSettings, shot: VideoStudioShot, requestId: string): AiVideoGenerateInput {
  const base = {
    requestId, group: settings.videoGroup, model: settings.videoModel, prompt: videoStudioPlainText(shot.prompt), seconds: String(settings.secondsPerShot),
    ...(shot.image ? { imageAssetIds: [shot.image.assetId] } : {}),
  }
  let provider = ''
  try {
    const capability = inspectModel(settings.videoModel)
    if (capability.kind === 'video') provider = capability.provider
  } catch {
    // 认不出的模型交给主进程报错。
  }
  if (provider === 'minimax-h3') return { ...base, mode: shot.image ? 'i2va' : 't2va', resolution: '720p', aspectRatio: settings.aspect, promptOptimization: false }
  return { ...base, ...grokDimensions[settings.aspect] }
}

/** 这几个镜头里上次提交结果不明、再生成可能多扣一次的，按在分镜里的位置给出第几个（从 0 数）。 */
export function videoStudioUnconfirmedIndexes(project: VideoStudioProject, ids: readonly string[]): number[] {
  return project.shots.flatMap((shot, index) => ids.includes(shot.id) && shot.unconfirmed ? [index] : [])
}

/** 能拼了：至少一个镜头，每个镜头都有片段、没有正在生成的。 */
export function videoStudioReadyToCompose(project: VideoStudioProject): boolean {
  return project.shots.length > 0 && project.shots.every((shot) => shot.clip && !isVideoStudioShotBusy(shot))
}

/** 拼片时每一段烧上的字幕；关了字幕就都不烧。 */
export function videoStudioComposeCaptions(project: VideoStudioProject): string[] {
  return project.shots.map((shot) => project.settings.captions ? normalizeVideoStudioCaption(shot.caption) : '')
}

/** 拼片时两路声音的音量：没配乐就是片段原声照常，什么都不用传。 */
export function videoStudioComposeSound(project: VideoStudioProject): { music?: { assetId: string, gain: number }, clipGain?: number } {
  if (!project.music) return {}
  const gains = clipSoundGains[project.music.clipSound]
  return { music: { assetId: project.music.assetId, gain: gains.music }, clipGain: gains.clip }
}

/** 一次拼片用到的全部东西：哪几段、什么顺序、烧什么字、什么画面、配什么歌。拼完时和工程对不上，说明中途改过，成片不能挂到改过的分镜上。 */
export function videoStudioComposeKey(project: VideoStudioProject): string {
  const { aspect, resolution, fit } = project.settings
  const sound = project.music ? [project.music.assetId, project.music.clipSound] : []
  return JSON.stringify([aspect, resolution, fit, project.shots.map((shot) => [shot.clip?.assetId ?? '', shot.trimStart ?? 0, shot.trimEnd ?? 0]), videoStudioComposeCaptions(project), sound])
}

/**
 * 选好一首歌：换一首时原声那一项照旧，头一回选默认「调小」（加了配乐多半是想听歌）。
 * 配乐一变，上一次的成片就跟现在对不上了，不再挂在这里。
 */
export function setVideoStudioMusic(project: VideoStudioProject, music: VideoStudioMusic): VideoStudioProject {
  return { ...project, music: { ...music, clipSound: project.music?.clipSound ?? 'quiet' }, exported: undefined }
}

export function removeVideoStudioMusic(project: VideoStudioProject): VideoStudioProject {
  return project.music ? { ...project, music: undefined, exported: undefined } : project
}

export function setVideoStudioClipSound(project: VideoStudioProject, clipSound: VideoStudioClipSound): VideoStudioProject {
  return project.music && project.music.clipSound !== clipSound ? { ...project, music: { ...project.music, clipSound }, exported: undefined } : project
}

// —— 存到这台电脑上 ——
// 存的是想法、设置、分镜和片段编号，片段本身在作品库里。排队、进度这类只在这次打开时有的状态不存；
// 正在生成的那一段存下请求号，重开以后先当它还在生成，由 useVideoStudio 拿请求号去接回来。
// 提交结果不明的那一段连同这个标记一起存：重开以后直接是失败加那句提醒，不去接（没有任务号，接不回来）。

const maxStoredIdeaLength = videoStudioPlanLimits.maximumIdeaLength
const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
const requestIdPattern = /^[A-Za-z0-9-]{1,64}$/

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

function isVideoStudioClipSound(value: unknown): value is VideoStudioClipSound {
  return (videoStudioClipSounds as readonly unknown[]).includes(value)
}

// 歌名是主进程按文件名给的（electron/ipc/handlers/ai-video.ts 的 videoStudioMusicName），存着的照那个规矩再收一遍。
function readMusic(value: unknown): VideoStudioMusicChoice | undefined {
  if (!isRecord(value) || typeof value.assetId !== 'string' || !assetIdPattern.test(value.assetId)) return undefined
  const name = typeof value.name === 'string' ? value.name.replace(/[\x00-\x1F\x7F\s]+/g, ' ').trim().slice(0, 80).trim() : ''
  if (!name) return undefined
  const durationSeconds = readPositive(value.durationSeconds)
  const clipSound = isVideoStudioClipSound(value.clipSound) ? value.clipSound : 'quiet'
  return { assetId: value.assetId, name, ...(durationSeconds ? { durationSeconds } : {}), clipSound }
}

function readClip(value: unknown): AiVideoClip | undefined {
  if (!isRecord(value) || typeof value.assetId !== 'string' || !assetIdPattern.test(value.assetId)) return undefined
  // 缩略图地址只收主进程给的那种（electron/asset-thumbnail.ts），而且要是同一段视频的。存着的地址带着当时的版本号，
  // 缩略图一升版主进程就不认旧的了（回 404，镜头上全是裂图），所以按编号换成现在的版本再用。
  if (typeof value.thumbnailUrl !== 'string' || !/^xingmang-asset:\/\/thumb\/v[0-9]{1,4}\/video\/[A-Za-z0-9_-]{43}$/.test(value.thumbnailUrl) || !value.thumbnailUrl.endsWith(`/${value.assetId}`)) return undefined
  const width = readPositive(value.width), height = readPositive(value.height), durationSeconds = readPositive(value.durationSeconds)
  return {
    assetId: value.assetId, thumbnailUrl: assetThumbnailUrl(value.assetId, 'video'),
    ...(width ? { width } : {}), ...(height ? { height } : {}), ...(durationSeconds ? { durationSeconds } : {}),
  }
}

export function serializeVideoStudioProject(project: VideoStudioProject): unknown {
  return {
    version: 1,
    settings: project.settings,
    title: project.title,
    shots: project.shots.map((shot) => ({
      id: shot.id, prompt: shot.prompt, caption: shot.caption, ...(shot.image ? { image: { assetId: shot.image.assetId } } : {}), ...(shot.clip ? { clip: shot.clip } : {}),
      ...(shot.clip && shot.trimStart ? { trimStart: shot.trimStart } : {}), ...(shot.clip && shot.trimEnd ? { trimEnd: shot.trimEnd } : {}),
      // 沿用请求号重新出着的那一单不记 unconfirmed：重开以后照样去接，主进程那边记着上一次结果不明，接回时会照实回答。
      ...(shot.requestId ? { requestId: shot.requestId, ...(shot.unconfirmed && shot.status !== 'generating' ? { unconfirmed: true } : {}) } : {}),
    })),
    ...(project.music ? { music: project.music } : {}),
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
    imageModel: readModelName(stored.imageModel),
    imageGroup: readModelName(stored.imageGroup),
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
    const image = isRecord(entry.image) ? videoStudioShotImage(entry.image.assetId) : null
    const requestId = typeof entry.requestId === 'string' && requestIdPattern.test(entry.requestId) ? entry.requestId : undefined
    const unconfirmed = Boolean(requestId) && entry.unconfirmed === true
    // 剪掉多少只跟着片段读；两头加起来剪得超过可选范围的整个不认，免得拼的时候才报「剪掉首尾后没法用」。
    const trimStart = clip && isVideoStudioTrim(entry.trimStart) ? entry.trimStart : 0
    const trimEnd = clip && isVideoStudioTrim(entry.trimEnd) ? entry.trimEnd : 0
    const trimmed = videoStudioTrimOptions({ clip, trimEnd }, 'start', settings.secondsPerShot).includes(trimStart)
    shots.push({
      id,
      prompt: readText(entry.prompt, videoStudioPlanLimits.maximumPromptLength),
      caption: readText(entry.caption, videoStudioPlanLimits.maximumCaptionLength),
      ...(image ? { image } : {}),
      ...(clip ? { clip } : {}),
      ...(trimmed && trimStart ? { trimStart } : {}),
      ...(trimmed && trimEnd ? { trimEnd } : {}),
      ...(requestId ? { requestId } : {}),
      ...(unconfirmed ? { unconfirmed, error: aiVideoUnconfirmedSubmissionMessage } : {}),
      status: unconfirmed ? 'failed' : requestId ? 'generating' : clip ? 'done' : 'idle',
    })
  }
  const music = readMusic(value.music)
  const exported = readClip(value.exported)
  return { version: 1, settings, title: readText(value.title, videoStudioPlanLimits.maximumTitleLength), shots, ...(music ? { music } : {}), ...(exported ? { exported } : {}) }
}

export function videoStudioStorageKey(scope: string): string {
  return `xingmang-ui-v2:video-studio:${scope}`
}
