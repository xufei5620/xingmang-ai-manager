import { aiVideoUnconfirmedSubmissionMessage } from '../../../../electron/ai-video-submission'
import type { ImageSizePolicy } from '../../../../electron/ai-chat-protocol'
import type { AiChatGroupSummary, AiChatImageInput, AiVideoClip, AiVideoGenerateInput, AiVideoProgressEvent, VideoStudioMusic, VideoStudioPlan } from '../../../../electron/ipc-contract'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { buildChatCatalog, DEFAULT_VIDEO_MODELS, pickChatGroup, resolveDefaultChatModel, type ChatCatalogEntry, type ChatGroupContext, type ChatGroupPreparation, type ChatSite } from '../chat/state'
import { defaultImageOptions, fitImageOptions, type ImageOptionValues, type SharedImageSettings } from '../chat/image-settings'
import { inspectModel } from '../chat/api'
import { readVideoClip, readVideoRequestId } from './clip'
import { isVideoStudioCaptionPosition, isVideoStudioCaptionSize, type VideoStudioCaptionPosition, type VideoStudioCaptionSize } from './captions'
import { isVideoStudioAspect, isVideoStudioFit, isVideoStudioResolution, isVideoStudioTransition, normalizeVideoStudioCaption, type VideoStudioAspect, type VideoStudioFit, type VideoStudioResolution, type VideoStudioTransition } from './timeline'

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
  /** 这一镜单独定的时长（秒）；没定就跟「每段时长」。和图一样，重新生成才用上。 */
  seconds?: number
  /** 生成好的片段；重新生成成功前一直留着上一段。 */
  clip?: AiVideoClip
  /** 这一段不是这一镜自己生成的，是从作品库里拿来的现成片段（「使用已有片段」，融合第 3 步）。换成新生成的片段就去掉。 */
  borrowed?: boolean
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
   * 沿用请求号重新出着的时候也留着，只是不存（存成下面的 unrecorded）；出成了才去掉。
   */
  unconfirmed?: boolean
  /**
   * 正在出的这一单交出去前，主进程没能在本机记下「交出去了、还没回音」（磁盘满、文件被杀毒软件占着），由页面替它记着，
   * 跟请求号一起存下；沿用请求号重新出的那一单（上一次结果不明，主进程也可能没记下）存的时候同样记成这个。
   * 重开以后先拿请求号去主进程查（任务、出好的片段、结果不明的记录）；都查不到也不能当它没发过，
   * 照「提交结果不明」提醒可能已扣费，再生成时确认框说清可能多扣一次（总单 #42，N2）。等到这一单的结果就去掉。
   */
  unrecorded?: boolean
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
  /** 「AI 生成图片」用的画图模型和它的分组。 */
  imageModel: string
  imageGroup: string
  resolution: VideoStudioResolution
  fit: VideoStudioFit
  /** 镜头之间直接切还是淡入淡出；缺省直接切，和加这一项以前拼出来的一样。 */
  transition: VideoStudioTransition
  /** 成片结尾淡出；缺省不淡。 */
  fadeOut: boolean
  /** 字幕大小、放哪儿；缺省中号、底部，和加这两项以前印出来的一样。 */
  captionSize: VideoStudioCaptionSize
  captionPosition: VideoStudioCaptionPosition
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
// Grok 视频只认这几种宽高（ai-chat-protocol.ts 的 allowedVideoDimensions）。
const grokDimensions: Readonly<Record<VideoStudioAspect, { width: number, height: number }>> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1024, height: 1024 },
}

export const videoStudioAspectNames: Readonly<Record<VideoStudioAspect, string>> = { '16:9': '横屏 16:9', '9:16': '竖屏 9:16', '1:1': '方形 1:1' }
export const videoStudioFitNames: Readonly<Record<VideoStudioFit, string>> = { cover: '裁边铺满', contain: '补黑边' }
export const videoStudioTransitionNames: Readonly<Record<VideoStudioTransition, string>> = { cut: '直接切', fade: '淡入淡出' }
export const videoStudioCaptionSizeNames: Readonly<Record<VideoStudioCaptionSize, string>> = { small: '小', medium: '中', large: '大' }
export const videoStudioCaptionPositionNames: Readonly<Record<VideoStudioCaptionPosition, string>> = { bottom: '底部', middle: '中间', top: '顶部' }
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
  return { idea: '', shotCount: 4, secondsPerShot: 6, aspect: '9:16', captions: true, textModel: '', textGroup: '', videoModel: '', videoGroup: '', imageModel: '', imageGroup: '', resolution: 720, fit: 'cover', transition: 'cut', fadeOut: false, captionSize: 'medium', captionPosition: 'bottom' }
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

/** 这一镜出多长：单独定过就用它的，没定过跟「每段时长」；视频模型出不了这么长就按最近的一档算。 */
export function videoStudioShotSeconds(shot: Pick<VideoStudioShot, 'seconds'>, settings: Pick<VideoStudioSettings, 'secondsPerShot' | 'videoModel'>): number {
  const seconds = shot.seconds ?? settings.secondsPerShot
  return settings.videoModel ? clampVideoStudioSeconds(seconds, settings.videoModel) : seconds
}

/**
 * 单独给这一镜定时长，只收视频模型能出的那几档。定成和「每段时长」一样就是不单独定，以后改「每段时长」它跟着走。
 * 正在出的、排着队的不改：那一单已经按原来的长短交出去了。
 */
export function setVideoStudioShotSeconds(project: VideoStudioProject, id: string, seconds: number): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot || isVideoStudioShotBusy(shot) || !videoStudioSecondsChoices(project.settings.videoModel).includes(seconds)) return project
  const next = seconds === project.settings.secondsPerShot ? undefined : seconds
  if (shot.seconds === next) return project
  return updateVideoStudioShot(project, id, ({ seconds: _seconds, ...rest }) => next === undefined ? rest : { ...rest, seconds: next })
}

/** 换了视频模型：每段时长和各镜单独定的时长都挪到新模型能出的、离原来最近的那一档。 */
export function selectVideoStudioVideoModel(project: VideoStudioProject, model: string, group: string): VideoStudioProject {
  const secondsPerShot = clampVideoStudioSeconds(project.settings.secondsPerShot, model)
  return {
    ...project,
    settings: { ...project.settings, videoModel: model, videoGroup: group, secondsPerShot },
    shots: project.shots.map((shot) => {
      if (shot.seconds === undefined) return shot
      const seconds = clampVideoStudioSeconds(shot.seconds, model)
      const { seconds: _seconds, ...rest } = shot
      return seconds === secondsPerShot ? rest : { ...rest, seconds }
    }),
  }
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
  const video = settleOne(settings.videoModel, settings.videoGroup, catalogs.video, context, 'image', (models) => DEFAULT_VIDEO_MODELS.find((model) => models.includes(model)) ?? models[0] ?? '')
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

/** 对话里出好的一段视频（「拿去拼成片」）：当初的那句描述、片段，从图开始出的还带着那张图。 */
export interface VideoStudioClipSource { prompt: string, clip: AiVideoClip, imageAssetId?: string }

/** 带着一段现成片段的新镜头：描述放进画面描述，片段直接挂上，记成「现成的片段」（不是这一镜自己生成的）。 */
function borrowedShot(source: VideoStudioClipSource, createId: () => string): VideoStudioShot {
  const image = source.imageAssetId ? videoStudioShotImage(source.imageAssetId) : null
  return { id: createId(), prompt: videoStudioPlainText(source.prompt).slice(0, videoStudioPlanLimits.maximumPromptLength), caption: '', ...(image ? { image } : {}), clip: source.clip, borrowed: true, status: 'done' }
}

/**
 * 把一段出好的视频（对话里的、作品库里的）接成这条视频的最后一个镜头：描述放进画面描述，片段直接挂上，不用再生成。
 * 这一镜记成用的是现成的片段（融合第 3 步）：它不是照这条视频的设置出的，页面上不给「重新生成」，作品库也不把它算成这条视频做的。
 * 镜头满了（canAddVideoStudioShot）原样交回。上一次拼好的成片不再算数：多了一段，要重新拼。
 */
export function appendVideoStudioClip(project: VideoStudioProject, source: VideoStudioClipSource, createId: () => string = createVideoStudioId): VideoStudioProject {
  if (!canAddVideoStudioShot(project)) return project
  const { exported: _exported, ...rest } = project
  return { ...rest, shots: [...project.shots, borrowedShot(source, createId)] }
}

/**
 * 「拿去拼成片 › 新建一条视频」：新的一条里只有这一个镜头。想法先填上那句描述（列表里拿它当名字），画面比例、
 * 出片的模型跟着这一段走，接着在视频工作台里加镜头时不用再选一遍。别的设置（写分镜、画图的模型，字幕这些）照 base，
 * 外面给的是最近那一条视频的，同点「新建」。
 */
export function createVideoStudioProjectFromClip(source: VideoStudioClipSource, made: { aspect: VideoStudioAspect, model: string, group: string, seconds: number }, base: VideoStudioSettings = defaultVideoStudioSettings(), createId: () => string = createVideoStudioId): VideoStudioProject {
  const settings: VideoStudioSettings = {
    ...base,
    idea: videoStudioPlainText(source.prompt).slice(0, videoStudioPlanLimits.maximumIdeaLength),
    aspect: made.aspect, videoModel: made.model, videoGroup: made.group,
    secondsPerShot: made.model ? clampVideoStudioSeconds(made.seconds, made.model) : base.secondsPerShot,
  }
  return appendVideoStudioClip(createVideoStudioProject(settings), source, createId)
}

/**
 * 起始页第三张卡「用已有片段合成视频」：新的一条里一个镜头一段现成的片段，照挑的先后排，多出上限的不要。
 * 画面比例、出片的模型照 made（第一段是照什么出的），别的设置照 base，同 createVideoStudioProjectFromClip。
 */
export function createVideoStudioProjectFromClips(sources: readonly VideoStudioClipSource[], made: { aspect: VideoStudioAspect, model: string, group: string, seconds: number }, base: VideoStudioSettings = defaultVideoStudioSettings(), createId: () => string = createVideoStudioId): VideoStudioProject {
  const first = sources.find((source) => videoStudioPlainText(source.prompt).trim())
  const settings: VideoStudioSettings = {
    ...base,
    idea: first ? videoStudioPlainText(first.prompt).slice(0, videoStudioPlanLimits.maximumIdeaLength) : '',
    aspect: made.aspect, videoModel: made.model || base.videoModel, videoGroup: made.model ? made.group : base.videoGroup,
    secondsPerShot: made.model ? clampVideoStudioSeconds(made.seconds, made.model) : base.secondsPerShot,
  }
  return { ...createVideoStudioProject(settings), shots: sources.slice(0, videoStudioPlanLimits.maximumShots).map((source) => borrowedShot(source, createId)) }
}

/**
 * 「使用已有片段」：这一镜直接用作品库里现成的一段，不用生成。画面描述空着就填上那一段当初的描述（知道的话）。
 * 原来的片段换掉，剪头剪尾跟着清，上一次拼好的成片不再算数。正在生成、画图的这一镜不动。
 * 上一次没等到结果的那一单（请求号、提交结果不明的标记、报错）原样留着：不用这一段以后回到原来的样子，
 * 再生成时该提醒可能多扣一次的照样提醒。
 */
export function assignVideoStudioShotClip(project: VideoStudioProject, id: string, source: VideoStudioClipSource): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot || isVideoStudioShotBusy(shot) || isVideoStudioShotDrawing(shot)) return project
  const { exported: _exported, ...rest } = project
  return updateVideoStudioShot(rest, id, (item) => ({
    ...withoutVideoStudioTrim(item),
    prompt: item.prompt.trim() ? item.prompt : videoStudioPlainText(source.prompt).slice(0, videoStudioPlanLimits.maximumPromptLength),
    clip: source.clip, borrowed: true, status: 'done',
  }))
}

/** 「不使用此片段」：拿掉这一镜上那段现成的片段，回到用它之前的样子（没生成，或者上一次没生成出来）。自己生成的片段不归它管。 */
export function removeVideoStudioShotClip(project: VideoStudioProject, id: string): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot?.clip || !shot.borrowed || isVideoStudioShotBusy(shot) || isVideoStudioShotDrawing(shot)) return project
  const { exported: _exported, ...rest } = project
  return updateVideoStudioShot(rest, id, (item) => {
    const { clip: _clip, ...kept } = withoutVideoStudioBorrowed(withoutVideoStudioTrim(item))
    return { ...kept, status: kept.requestId || kept.error ? 'failed' : 'idle', ...(kept.unconfirmed && !kept.error ? { error: aiVideoUnconfirmedSubmissionMessage } : {}) }
  })
}

/** 新生成的片段换上来时用：这一段不再是「现成的片段」。 */
export function withoutVideoStudioBorrowed<T extends Pick<VideoStudioShot, 'borrowed'>>(shot: T): Omit<T, 'borrowed'> {
  const { borrowed: _borrowed, ...rest } = shot
  return rest
}

export function isVideoStudioShotBusy(shot: VideoStudioShot): boolean {
  return shot.status === 'queued' || shot.status === 'generating'
}

/**
 * 每段开头、结尾能剪掉的几档秒数（0 是不剪）。AI 片段常见开头一秒发呆、结尾一秒走样，这几档够用；
 * 这一页不在页面里放片段，拖动条找不准位置，按档选反而好用。
 */
export const videoStudioTrimChoices: readonly number[] = [0, 0.5, 1, 1.5, 2, 3]
export type VideoStudioTrimSide = 'start' | 'end'
// 剪完至少留这么长，不然这一段在成片里一闪就过去了。
const minimumTrimmedSeconds = 1

function isVideoStudioTrim(value: unknown): value is number {
  return typeof value === 'number' && videoStudioTrimChoices.includes(value)
}

/** 这一镜这一头能选哪几档：剪完至少留 1 秒（片段时长读不到就按「每段时长」算）；现在选着的那档总在里面。 */
export function videoStudioTrimOptions(shot: Pick<VideoStudioShot, 'clip' | 'trimStart' | 'trimEnd'>, side: VideoStudioTrimSide, shotSeconds: number): number[] {
  const current = (side === 'start' ? shot.trimStart : shot.trimEnd) ?? 0
  const other = (side === 'start' ? shot.trimEnd : shot.trimStart) ?? 0
  const duration = shot.clip?.durationSeconds ?? shotSeconds
  return videoStudioTrimChoices.filter((choice) => choice === current || duration - other - choice >= minimumTrimmedSeconds)
}

/**
 * 改这一段剪掉多少。只有生成好、没在重新生成的片段能剪；不在可选那几档里的不收。
 * 剪的长短一变，上一次的成片就跟现在对不上了，不再挂在这里（文件还在作品库里）。
 */
export function setVideoStudioShotTrim(project: VideoStudioProject, id: string, side: VideoStudioTrimSide, seconds: number): VideoStudioProject {
  const shot = project.shots.find((item) => item.id === id)
  if (!shot?.clip || isVideoStudioShotBusy(shot) || !videoStudioTrimOptions(shot, side, videoStudioShotSeconds(shot, project.settings)).includes(seconds)) return project
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

/**
 * 这一镜在成片里占多长。用着作品库里现成片段、又知道那一段多长的，按片段本身算：它不是照「时长」那一格出的，
 * 可能长也可能短。别的照定的时长。
 */
function videoStudioShotLength(shot: VideoStudioShot, settings: VideoStudioSettings): number {
  return shot.borrowed && shot.clip?.durationSeconds ? shot.clip.durationSeconds : videoStudioShotSeconds(shot, settings)
}

/** 分镜卡上「共约 T 秒」：每段按它的时长算，减掉剪掉的。只算 shots 里列的那几镜（确认框只算要生成的那几段）。 */
export function videoStudioTotalSeconds(project: VideoStudioProject, shots: readonly VideoStudioShot[] = project.shots): number {
  return Math.round(shots.reduce((total, shot) => total + videoStudioShotLength(shot, project.settings) - (shot.trimStart ?? 0) - (shot.trimEnd ?? 0), 0))
}

/** 这几镜要是一样长就是这个秒数，长短不一是 null（分镜卡、确认框就不说「每段 S 秒」）。 */
export function videoStudioCommonSeconds(project: VideoStudioProject, shots: readonly VideoStudioShot[] = project.shots): number | null {
  const lengths = new Set(shots.map((shot) => Math.round(videoStudioShotLength(shot, project.settings))))
  return lengths.size === 1 ? [...lengths][0] : null
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
  if (!videoStudioPlainText(shot.prompt)) return `第 ${index + 1} 个镜头尚未填写画面描述`
  if (shot.prompt.length > videoStudioPlanLimits.maximumPromptLength) return `第 ${index + 1} 个镜头的画面描述过长，请删减至 ${videoStudioPlanLimits.maximumPromptLength} 个字以内`
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

/** 出图框里填好的那一份（融合第 4 步）：画面描述、型号和计费分组、尺寸、画质、分辨率；带了参考图就照图改。 */
export interface VideoStudioImageDraft extends ImageOptionValues {
  prompt: string
  model: string
  group: string
  sourceAssetIds?: readonly string[]
}

/** 出图框交出去的请求，写法同对话里「生成图片」那一档（useChatController 的 imageInput）：型号没有画质档位就不带画质。 */
export function buildVideoStudioImageRequest(draft: VideoStudioImageDraft, requestId: string): AiChatImageInput {
  let quality: AiChatImageInput['quality']
  try {
    const capability = inspectModel(draft.model)
    if (capability.kind === 'image' && capability.qualities.length) quality = draft.quality
  } catch {
    // 认不出的模型交给主进程去拒。
  }
  return {
    requestId, group: draft.group, model: draft.model, prompt: videoStudioPlainText(draft.prompt), size: draft.size,
    ...(quality ? { quality } : {}), imageResolution: draft.imageResolution,
    ...(draft.sourceAssetIds?.length ? { sourceAssetIds: [...draft.sourceAssetIds] } : {}),
  }
}

/**
 * 出图框一打开选哪个型号：记的那一份（对话里「生成图片」用的也是它）→ 这条视频以前在「画镜头图」里选的 →
 * 默认的出图型号。计费分组跟着记的走，记的那个分组里没有这个型号了就按 pickChatGroup 的次序另挑。表是空的就都是空串。
 */
export function videoStudioImageModelChoice(shared: Pick<SharedImageSettings, 'model' | 'group'> | null, settings: Pick<VideoStudioSettings, 'imageModel' | 'imageGroup'>, catalog: readonly ChatCatalogEntry[], context: ChatGroupContext): { model: string, group: string } {
  const pick = (model: string, group: string) => {
    const entry = model ? catalog.find((item) => item.model === model) : undefined
    return entry ? { model: entry.model, group: entry.groups.includes(group) ? group : pickChatGroup(entry.groups, { ...context, current: '', mode: 'image' }) } : null
  }
  return (shared && pick(shared.model, shared.group)) ?? pick(settings.imageModel, settings.imageGroup) ?? pick(resolveDefaultChatModel('image', catalog.map((item) => item.model)), '') ?? { model: '', group: '' }
}

function imageSizeShape(size: string): 'wide' | 'tall' | 'square' | null {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) return null
  const ratio = Number(match[1]) / Number(match[2])
  return ratio > 1.05 ? 'wide' : ratio < 0.95 ? 'tall' : 'square'
}

/**
 * 出图框里这个型号用什么尺寸、画质、分辨率。客户在框里改过的（touched）优先，其次是记的那一份，一次都没记过就是
 * 对话里的默认；型号不收的换成它自己的默认。尺寸客户没改过时，记的那个横竖跟这条视频的画面对不上，就按画面另挑
 * （videoStudioImageSize）：这张图是拿来当第一帧的，横竖不对出来的视频就不对。手填到一半的尺寸原样留着，点「生成图片」前再核。
 */
export function videoStudioImageOptions(model: string, aspect: VideoStudioAspect, shared: ImageOptionValues | null, touched: Partial<ImageOptionValues>): ImageOptionValues {
  const base = shared ?? defaultImageOptions()
  const fitted = fitImageOptions(model, { size: base.size, quality: touched.quality ?? base.quality, imageResolution: touched.imageResolution ?? base.imageResolution })
  if (touched.size !== undefined) return { ...fitted, size: touched.size }
  let capability: ReturnType<typeof inspectModel>
  try { capability = inspectModel(model) } catch { return fitted }
  if (capability.kind !== 'image') return fitted
  const wanted = aspect === '16:9' ? 'wide' : aspect === '9:16' ? 'tall' : 'square'
  return imageSizeShape(fitted.size) === wanted ? fitted : { ...fitted, size: videoStudioImageSize(capability.sizePolicy, aspect) }
}

/**
 * 点了「生成图片」以后记下的那一份：型号、画质、分辨率照框里的。尺寸只有客户在框里改过才记；按这条视频的画面
 * 自动挑的那个不记，不然对话里的尺寸会跟着某条视频的横竖变。
 */
export function videoStudioImageSettingsToShare(draft: VideoStudioImageDraft, shared: ImageOptionValues | null, sizeTouched: boolean): SharedImageSettings {
  const size = sizeTouched ? draft.size : fitImageOptions(draft.model, { size: (shared ?? defaultImageOptions()).size, quality: draft.quality, imageResolution: draft.imageResolution }).size
  return { model: draft.model, group: draft.group, size, quality: draft.quality, imageResolution: draft.imageResolution }
}

/**
 * 出一段片段的请求。视频模型按它自己那家的写法给画面比例。这一镜选了图就从这张图开头：Grok 拿它当第一帧，
 * MiniMax 换成「图生视频」（i2va，只收一张图）。
 */
export function buildVideoStudioClipRequest(settings: VideoStudioSettings, shot: VideoStudioShot, requestId: string): AiVideoGenerateInput {
  return buildVideoClipRequest({ requestId, group: settings.videoGroup, model: settings.videoModel, prompt: shot.prompt, seconds: videoStudioShotSeconds(shot, settings), aspect: settings.aspect, ...(shot.image ? { imageAssetId: shot.image.assetId } : {}) })
}

export interface VideoClipRequestInput { requestId: string, group: string, model: string, prompt: string, seconds: number, aspect: VideoStudioAspect, imageAssetId?: string }

/** 出一段视频的请求本身：视频工作台的一个镜头和对话里「生成视频」的一句话（chat/video.ts）都从这里出，两边交给主进程的写法一样。 */
export function buildVideoClipRequest(input: VideoClipRequestInput): AiVideoGenerateInput {
  const base = {
    requestId: input.requestId, group: input.group, model: input.model, prompt: videoStudioPlainText(input.prompt), seconds: String(input.seconds),
    ...(input.imageAssetId ? { imageAssetIds: [input.imageAssetId] } : {}),
  }
  let provider = ''
  try {
    const capability = inspectModel(input.model)
    if (capability.kind === 'video') provider = capability.provider
  } catch {
    // 认不出的模型交给主进程报错。
  }
  if (provider === 'minimax-h3') return { ...base, mode: input.imageAssetId ? 'i2va' : 't2va', resolution: '720p', aspectRatio: input.aspect, promptOptimization: false }
  return { ...base, ...grokDimensions[input.aspect] }
}

/** 这几个镜头里上次提交结果不明、再生成可能多扣一次的，按在分镜里的位置给出第几个（从 0 数）。 */
export function videoStudioUnconfirmedIndexes(project: VideoStudioProject, ids: readonly string[]): number[] {
  return project.shots.flatMap((shot, index) => ids.includes(shot.id) && shot.unconfirmed ? [index] : [])
}

/**
 * 确认框里那句「可能多扣一次」。indexes 是这几段在分镜里的位置（从 0 数），total 是这次要生成几段。
 * 对话里重新生成一段视频时说的也是这一句（total 是 1）。
 */
export function videoStudioUnconfirmedWarning(indexes: readonly number[], total: number): string {
  const subject = total === 1 ? '这一段' : indexes.length === total ? '这几段' : `其中第 ${indexes.map((index) => index + 1).join('、')} 段`
  return `${subject}上次提交时未收到星芒的响应：费用可能已扣除，但片段无法取回。重新生成将再次计费，可能产生重复扣费。`
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
  const { aspect, resolution, fit, transition, fadeOut, captionSize, captionPosition } = project.settings
  const sound = project.music ? [project.music.assetId, project.music.clipSound] : []
  return JSON.stringify([aspect, resolution, fit, transition, fadeOut, captionSize, captionPosition, project.shots.map((shot) => [shot.clip?.assetId ?? '', shot.trimStart ?? 0, shot.trimEnd ?? 0]), videoStudioComposeCaptions(project), sound])
}

/**
 * 改设置。画面比例、铺法、转场、淡出、字幕开关和大小位置这些拼片用得上的一变，上一次的成片就跟现在对不上了，
 * 不再挂在这里（文件还在作品库里），同剪片段、换配乐（Mac 验收 R8）；只换模型、改想法这类拼片用不上的，成片照旧挂着。
 */
export function changeVideoStudioSettings(project: VideoStudioProject, patch: Partial<VideoStudioSettings>): VideoStudioProject {
  const next = { ...project, settings: { ...project.settings, ...patch } }
  return next.exported && videoStudioComposeKey(next) !== videoStudioComposeKey(project) ? { ...next, exported: undefined } : next
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

export function serializeVideoStudioProject(project: VideoStudioProject): unknown {
  return {
    version: 1,
    settings: project.settings,
    title: project.title,
    shots: project.shots.map((shot) => ({
      id: shot.id, prompt: shot.prompt, caption: shot.caption, ...(shot.image ? { image: { assetId: shot.image.assetId } } : {}), ...(shot.seconds ? { seconds: shot.seconds } : {}), ...(shot.clip ? { clip: shot.clip } : {}), ...(shot.clip && shot.borrowed ? { borrowed: true } : {}),
      ...(shot.clip && shot.trimStart ? { trimStart: shot.trimStart } : {}), ...(shot.clip && shot.trimEnd ? { trimEnd: shot.trimEnd } : {}),
      // 沿用请求号重新出着的那一单不记 unconfirmed：重开以后照样去接，主进程那边记着上一次结果不明，接回时会照实回答。
      // 可上一次也可能是主进程没记下的那种（写不进去），所以记成 unrecorded：接不回来时照样提醒，同这一单交出去前没记下。
      ...(shot.requestId ? {
        requestId: shot.requestId,
        ...(shot.unconfirmed && shot.status !== 'generating' ? { unconfirmed: true } : {}),
        ...(shot.unrecorded || (shot.unconfirmed && shot.status === 'generating') ? { unrecorded: true } : {}),
      } : {}),
    })),
    ...(project.music ? { music: project.music } : {}),
    ...(project.exported ? { exported: project.exported } : {}),
  }
}

function isStoredSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= videoStudioPlanLimits.minimumSecondsPerShot && value <= videoStudioPlanLimits.maximumSecondsPerShot
}

/** 读回存着的工程。认不出的项换成缺省，整份认不出就是 null。 */
export function restoreVideoStudioProject(value: unknown, createId: () => string = createVideoStudioId): VideoStudioProject | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.settings)) return null
  const stored = value.settings
  const defaults = defaultVideoStudioSettings()
  const shotCount = typeof stored.shotCount === 'number' && (videoStudioShotCounts as readonly number[]).includes(stored.shotCount) ? stored.shotCount : defaults.shotCount
  const seconds = isStoredSeconds(stored.secondsPerShot) ? stored.secondsPerShot : defaults.secondsPerShot
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
    transition: isVideoStudioTransition(stored.transition) ? stored.transition : defaults.transition,
    fadeOut: typeof stored.fadeOut === 'boolean' ? stored.fadeOut : defaults.fadeOut,
    captionSize: isVideoStudioCaptionSize(stored.captionSize) ? stored.captionSize : defaults.captionSize,
    captionPosition: isVideoStudioCaptionPosition(stored.captionPosition) ? stored.captionPosition : defaults.captionPosition,
  }
  const ids = new Set<string>()
  const shots: VideoStudioShot[] = []
  for (const entry of Array.isArray(value.shots) ? value.shots.slice(0, videoStudioPlanLimits.maximumShots) : []) {
    if (!isRecord(entry)) continue
    let id = typeof entry.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(entry.id) ? entry.id : createId()
    if (ids.has(id)) id = createId()
    ids.add(id)
    const clip = readVideoClip(entry.clip)
    const image = isRecord(entry.image) ? videoStudioShotImage(entry.image.assetId) : null
    const requestId = readVideoRequestId(entry.requestId)
    const unconfirmed = Boolean(requestId) && entry.unconfirmed === true
    // 主进程没记下的那一单照样去接（status 是 generating）：接不回来时页面按这一笔提醒，不变回「还没生成」。
    const unrecorded = Boolean(requestId) && !unconfirmed && entry.unrecorded === true
    // 剪掉多少只跟着片段读；两头加起来剪得超过可选范围的整个不认，免得拼的时候才报「剪掉首尾后没法用」。
    const trimStart = clip && isVideoStudioTrim(entry.trimStart) ? entry.trimStart : 0
    const trimEnd = clip && isVideoStudioTrim(entry.trimEnd) ? entry.trimEnd : 0
    const seconds = isStoredSeconds(entry.seconds) && entry.seconds !== settings.secondsPerShot ? entry.seconds : undefined
    const trimmed = videoStudioTrimOptions({ clip, trimEnd }, 'start', seconds ?? settings.secondsPerShot).includes(trimStart)
    shots.push({
      id,
      prompt: readText(entry.prompt, videoStudioPlanLimits.maximumPromptLength),
      caption: readText(entry.caption, videoStudioPlanLimits.maximumCaptionLength),
      ...(image ? { image } : {}),
      ...(seconds ? { seconds } : {}),
      ...(clip ? { clip } : {}),
      ...(clip && entry.borrowed === true ? { borrowed: true } : {}),
      ...(trimmed && trimStart ? { trimStart } : {}),
      ...(trimmed && trimEnd ? { trimEnd } : {}),
      ...(requestId ? { requestId } : {}),
      ...(unconfirmed ? { unconfirmed, error: aiVideoUnconfirmedSubmissionMessage } : {}),
      ...(unrecorded ? { unrecorded } : {}),
      status: unconfirmed ? 'failed' : requestId ? 'generating' : clip ? 'done' : 'idle',
    })
  }
  const music = readMusic(value.music)
  const exported = readVideoClip(value.exported)
  return { version: 1, settings, title: readText(value.title, videoStudioPlanLimits.maximumTitleLength), shots, ...(music ? { music } : {}), ...(exported ? { exported } : {}) }
}

export function videoStudioStorageKey(scope: string): string {
  return `xingmang-ui-v2:video-studio:${scope}`
}

// —— 0.2.24 及以前存在 localStorage 里的那两格 ——
// 手头那一条在 videoStudioStorageKey，草稿箱（换下来的工程，最多 20 份）在 videoStudioDraftsStorageKey。
// 0.2.25 起一条视频一个文件（library.ts），这两格只在头一次打开时读一遍、各抄一份过去，之后不再读也不再写；
// 退回老版本时它们原样还在，所以这里的读法不能改。

/** 老版本草稿箱里的一份。 */
export interface VideoStudioDraft {
  id: string
  /** 放进草稿箱的时间（毫秒）。 */
  savedAt: number
  project: VideoStudioProject
}

// 老版本草稿箱的上限：一份工程存下来多是字，二十份也就几百 KB，localStorage 放得下。读回来时照这个数截。
export const maxVideoStudioDrafts = 20

export function videoStudioDraftsStorageKey(scope: string): string {
  return `${videoStudioStorageKey(scope)}:drafts`
}

/** 什么都没写的工程：没想法、没镜头。刚新建的这种不列进左边那一列，也不存；老版本手头那一条是这样的就不抄。 */
export function isVideoStudioProjectEmpty(project: VideoStudioProject): boolean {
  return !project.settings.idea.trim() && project.shots.length === 0
}

/** 读回草稿箱。认不出的那一份丢掉，别的照留；整格认不出就是空的。 */
export function restoreVideoStudioDrafts(value: unknown, createId: () => string = createVideoStudioId): VideoStudioDraft[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.drafts)) return []
  const ids = new Set<string>()
  const drafts: VideoStudioDraft[] = []
  for (const entry of value.drafts) {
    if (drafts.length >= maxVideoStudioDrafts) break
    if (!isRecord(entry) || typeof entry.savedAt !== 'number' || !Number.isFinite(entry.savedAt) || entry.savedAt < 0) continue
    const project = restoreVideoStudioProject(entry.project, createId)
    if (!project || isVideoStudioProjectEmpty(project)) continue
    let id = typeof entry.id === 'string' && requestIdPattern.test(entry.id) ? entry.id : createId()
    if (ids.has(id)) id = createId()
    ids.add(id)
    drafts.push({ id, savedAt: entry.savedAt, project })
  }
  return drafts
}

/** 列表里一条视频的名字（客户没另起名时）：片名，没有就用想法开头那几个字。 */
export function videoStudioDraftName(project: VideoStudioProject): string {
  const idea = videoStudioPlainText(project.settings.idea).replace(/\s+/g, ' ')
  return project.title.trim() || (idea.length > 24 ? `${idea.slice(0, 24)}…` : idea) || '未命名视频'
}

/**
 * 列表里一条视频下面那行小字：几个镜头、生成了几段；合成过的先说合成了。左边那一列只有 224 宽，
 * 「已合成成片」放在最后总被截成「…」，最要紧的那句看不见（创作页复查第 8 条，yoyo 11-26 回「成片放前面」）。
 */
export function videoStudioDraftProgress(project: VideoStudioProject): string {
  if (!project.shots.length) return '尚未编写分镜'
  if (project.exported) return `已合成 · ${project.shots.length} 个镜头`
  const made = project.shots.filter((shot) => shot.clip).length
  return `${project.shots.length} 个镜头 · 已生成 ${made} 段`
}
