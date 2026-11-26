import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import type { AiChatAsset, AiLibraryEntry, AiLibraryPage, AiVideoClip } from '../../../../electron/ipc-contract'
import type { Conversation } from '../chat/state'
import { chatVideoMade, type ChatVideoMade } from '../chat/video'
import { videoStudioItemName, type VideoStudioItem } from '../video-studio/library'
import type { VideoStudioClipSource } from '../video-studio/project'
import { createTimeText } from './list'

// 主窗口的作品库（融合第 3 步）。这里全是纯计算：一件作品是哪段对话、哪条视频里来的，搜索时哪些对得上，
// 每一格、点开以后那几行字怎么写。主进程只列得出编号和时间（不读文件），「哪来的」「当时写的那句话」
// 在对话和视频里记着，所以由这一层按编号对回去。

/** clip：不是成片的视频；video：片段和成片都算（选择框里「选择片段」用，筛选那一排不列）。 */
export type LibraryKind = 'all' | 'image' | 'video' | 'clip' | 'film'

/** 筛选那一排，按这个先后排：图片、视频片段、成片三样互不重叠，加起来就是「全部」。 */
export const libraryKinds: readonly LibraryKind[] = ['all', 'image', 'clip', 'film']
export const libraryKindNames: Readonly<Record<LibraryKind, string>> = { all: '全部', image: '图片', video: '视频', clip: '视频片段', film: '成片' }
/** 一次读多少格；点「加载更多」再读这么多。 */
export const libraryPageSize = 24
/** 交给主进程的两份编号最多带多少个（同 electron/ai-media-asset-service.ts 的上限）。 */
export const maxLibraryFilmIds = 200
export const maxLibraryMatchedIds = 2_000
export const maxLibrarySearchLength = 128

/** 一件作品是哪来的。 */
export interface LibraryOrigin {
  /** chat：对话里出的、或者发过的；video：一条视频里的镜头图、片段、成片；canvas：一个画布项目里生成的，或者它的节点上放着的（融合第 5 步）。 */
  from: 'chat' | 'video' | 'canvas'
  /**
   * 不是在那里做出来的，只是在那里用过：对话里客户自己发的图，镜头的开头图，镜头上拿来的现成片段，画布节点上放着的别处的图。
   * 页面上说「用于」不说「出自」；同一件作品别处记着是在哪做的，就认做的那一处。
   */
  used?: boolean
  /** 那段对话、那条视频、那个画布项目的编号。 */
  id: string
  /** 那段对话、那条视频、那个画布项目的名字。 */
  title: string
  /** 当时写的那句话；成片没有（它是几个镜头拼的），对话里客户自己发的图也没有（那句话说的是拿它做什么，不是它是什么）。 */
  prompt: string
  /** 视频：当时主进程量出来的尺寸和时长。 */
  clip?: AiVideoClip
  /** 视频：是照什么出的（「添加到视频 › 新建视频」时新的那一条跟着它走）。 */
  made?: ChatVideoMade
  /** 视频：从哪张图开始出的。 */
  imageAssetId?: string
  /** 图片：对话里记着的宽高。 */
  width?: number
  height?: number
}

export type LibraryOrigins = ReadonlyMap<string, LibraryOrigin>

type Found = Array<[string, LibraryOrigin]>
/** made：在这里做出来的；used：只是在这里用过。 */
interface Sources { made: Found, used: Found }

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
// 一段对话、一条视频没变（对象还是同一个）就不重算：回复一段段到的时候只有正在回的那一段是新对象，
// 别的直接拿上一次的结果，同一件作品交出去的也还是同一个对象（格子是 memo 的，不用跟着重画）。
const conversationCache = new WeakMap<Conversation, Sources>()
const filmCache = new WeakMap<VideoStudioItem, Sources>()

function conversationOrigins(conversation: Conversation): Sources {
  const known = conversationCache.get(conversation)
  if (known) return known
  const made: Found = [], used: Found = []
  let asked: Conversation['messages'][number] | undefined
  for (const message of conversation.messages) {
    if (message.role === 'user') {
      asked = message
      for (const asset of message.assets ?? []) used.push([asset.assetId, { from: 'chat', used: true, id: conversation.id, title: conversation.title, prompt: '', ...imageSize(asset) }])
      continue
    }
    const prompt = asked?.content ?? ''
    for (const asset of message.assets ?? []) made.push([asset.assetId, { from: 'chat', id: conversation.id, title: conversation.title, prompt, ...imageSize(asset) }])
    const clip = message.video?.clip
    if (clip) {
      const imageAssetId = asked?.assets?.[0]?.assetId
      made.push([clip.assetId, { from: 'chat', id: conversation.id, title: conversation.title, prompt, clip, made: chatVideoMade(message.settings ?? conversation.settings, clip), ...(imageAssetId ? { imageAssetId } : {}) }])
    }
  }
  const found = { made, used }
  conversationCache.set(conversation, found)
  return found
}

function filmOrigins(item: VideoStudioItem): Sources {
  const known = filmCache.get(item)
  if (known) return known
  const made: Found = [], used: Found = []
  const title = videoStudioItemName(item)
  for (const shot of item.project.shots) {
    // 拿来的现成片段（「使用已有片段」）只是在这条视频里用了；这一镜自己生成的才算在这里做的。
    if (shot.clip) (shot.borrowed ? used : made).push([shot.clip.assetId, { from: 'video', ...(shot.borrowed ? { used: true } : {}), id: item.id, title, prompt: shot.prompt, clip: shot.clip, ...(shot.image ? { imageAssetId: shot.image.assetId } : {}) }])
    // 开头图可能是 AI 给这一镜画的，也可能是从电脑、从作品库选的，镜头上分不出来：都按「用过」算，描述还是这一镜的那句。
    if (shot.image) used.push([shot.image.assetId, { from: 'video', used: true, id: item.id, title, prompt: shot.prompt }])
  }
  const exported = item.project.exported
  if (exported) made.push([exported.assetId, { from: 'video', id: item.id, title, prompt: '', clip: exported }])
  const found = { made, used }
  filmCache.set(item, found)
  return found
}

/**
 * 按编号记下每件作品是哪来的。同一件在几处都出现时，先认「做出来的地方」：对话里 AI 出的图和视频，
 * 再是视频里生成的片段和成片；都没有才认「用过它的地方」：镜头的开头图、拿来的现成片段，最后是对话里客户自己发的图。
 */
export function buildLibraryOrigins(conversations: readonly Conversation[], films: readonly VideoStudioItem[]): LibraryOrigins {
  const origins = new Map<string, LibraryOrigin>()
  const keep = ([assetId, origin]: Found[number]) => { if (!origins.has(assetId) && assetIdPattern.test(assetId)) origins.set(assetId, origin) }
  const chats = conversations.map(conversationOrigins)
  const videos = films.map(filmOrigins)
  for (const { made } of chats) made.forEach(keep)
  for (const { made } of videos) made.forEach(keep)
  for (const { used } of videos) used.forEach(keep)
  for (const { used } of chats) used.forEach(keep)
  return origins
}

// 同一件作品、对话和视频里记着的那一份没变，交出去的还是同一个对象（格子是 memo 的）。
const canvasOriginCache = new WeakMap<AiLibraryEntry, { recorded: LibraryOrigin | undefined, origin: LibraryOrigin }>()

/**
 * 一件作品是哪来的，连画布一起算（融合第 5 步）。对话和视频里记着的由 origins 按编号给；是哪个画布项目的，
 * 主进程列的时候带在这一件上（项目名是画布那边写的，主进程洗成一行字才交过来，这里只当字显示）。
 * 先认做出来的地方：对话、视频里做的，再是画布项目里生成的；都没有才认用过它的地方，对话和视频排在画布前面。
 */
export function libraryEntryOrigin(entry: AiLibraryEntry, origins: LibraryOrigins): LibraryOrigin | undefined {
  const recorded = origins.get(entry.assetId)
  const canvas = entry.canvas
  if (!canvas || (recorded && (!recorded.used || canvas.used))) return recorded
  const known = canvasOriginCache.get(entry)
  if (known && known.recorded === recorded) return known.origin
  const origin: LibraryOrigin = {
    from: 'canvas', ...(canvas.used ? { used: true } : {}), id: canvas.projectId, title: canvas.projectName, prompt: canvas.used ? '' : entry.prompt ?? '',
    // 尺寸、时长是这件作品自己的：别处用它时记下的照样拿来用。
    ...(recorded?.clip ? { clip: recorded.clip } : {}), ...imageSize(recorded ?? {}),
  }
  canvasOriginCache.set(entry, { recorded, origin })
  return origin
}

function imageSize(asset: Pick<AiChatAsset, 'width' | 'height'>): { width?: number, height?: number } {
  return asset.width && asset.height ? { width: asset.width, height: asset.height } : {}
}

/** 每条视频上一次拼好的成片的编号：主进程拿它分出「成片」那一类。 */
export function libraryFilmAssetIds(films: readonly VideoStudioItem[]): string[] {
  return [...new Set(films.flatMap((item) => item.project.exported?.assetId ?? []))].filter((assetId) => assetIdPattern.test(assetId)).slice(0, maxLibraryFilmIds)
}

/** 搜索框里的字洗成交给主进程的样子：去掉看不见的控制字符，掐到上限。 */
export function cleanLibrarySearch(text: string): string {
  return text.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, maxLibrarySearchLength)
}

/** 当时写的那句话、那段对话或那条视频的名字里有这几个字的作品。主进程那边再加上它自己记着的（名字、标签）。 */
export function libraryMatchedAssetIds(origins: LibraryOrigins, search: string): string[] {
  const keyword = cleanLibrarySearch(search).toLocaleLowerCase('zh-CN')
  if (!keyword) return []
  const matched: string[] = []
  for (const [assetId, origin] of origins) {
    if (matched.length >= maxLibraryMatchedIds) break
    if (origin.prompt.toLocaleLowerCase('zh-CN').includes(keyword) || origin.title.toLocaleLowerCase('zh-CN').includes(keyword)) matched.push(assetId)
  }
  return matched
}

/** 筛选那一排后面的数：主进程数的「视频」里带着成片，「视频片段」是去掉成片以后的；「全部」是图片加视频。 */
export function libraryKindCount(counts: AiLibraryPage['counts'], kind: LibraryKind): number {
  if (kind === 'all') return counts.image + counts.video
  return kind === 'clip' ? Math.max(0, counts.video - counts.film) : counts[kind]
}

export const libraryOriginNames: Readonly<Record<LibraryOrigin['from'], string>> = { chat: '对话', video: '视频', canvas: '画布' }
/** 点开以后那一行里怎么叫：「出自画布项目「…」」。 */
const libraryOriginPlaces: Readonly<Record<LibraryOrigin['from'], string>> = { chat: '对话', video: '视频', canvas: '画布项目' }

function madeAt(entry: Pick<AiLibraryEntry, 'createdAt'>, now?: number): string {
  const time = Date.parse(entry.createdAt)
  return Number.isFinite(time) ? createTimeText(time, now) : ''
}

/** 每一格下面那行小字：「对话 · 今天 14:02」「画布 · 昨天 21:14」。对不上是哪来的就只写时间。 */
export function libraryCaption(entry: Pick<AiLibraryEntry, 'createdAt'>, origin: LibraryOrigin | undefined, now?: number): string {
  return [origin ? libraryOriginNames[origin.from] : '', madeAt(entry, now)].filter(Boolean).join(' · ')
}

function shortTitle(title: string): string {
  const text = title.trim()
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

/**
 * 点开以后标题下面那一行：「出自对话「…」 · 今天 14:02 · 1024 × 1024」「出自画布项目「…」 · …」；只是在那里用过的写「用于对话「…」」。
 * 量不出来的那一项不写。
 */
export function libraryDetailLine(entry: Pick<AiLibraryEntry, 'createdAt'>, origin: LibraryOrigin | undefined, size: { width?: number, height?: number } | null, now?: number): string {
  return [
    origin ? `${origin.used ? '用于' : '出自'}${libraryOriginPlaces[origin.from]}「${shortTitle(origin.title)}」` : '',
    madeAt(entry, now),
    size?.width && size.height ? `${Math.round(size.width)} × ${Math.round(size.height)}` : '',
  ].filter(Boolean).join(' · ')
}

/** 点开以后的标题：客户自己起的名字；没有就用当时写的那句话，再没有按类别写。 */
export function libraryTitle(entry: Pick<AiLibraryEntry, 'mediaType' | 'name' | 'prompt'>, origin: LibraryOrigin | undefined, film: boolean): string {
  const text = (entry.name || origin?.prompt || entry.prompt || '').replace(/\s+/g, ' ').trim()
  if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text
  return film ? origin?.title ? shortTitle(origin.title) : '成片' : entry.mediaType === 'video' ? '视频' : '图片'
}

/** 作品库里的一张图换成对话那边用的样子（「基于此图继续编辑」「用此图生成视频」要把它放进输入框）。 */
export function libraryChatAsset(entry: AiLibraryEntry, origin?: LibraryOrigin): AiChatAsset | null {
  if (entry.mediaType !== 'image' || !entry.mimeType) return null
  return { assetId: entry.assetId, localUrl: libraryImageUrl(entry.assetId), mimeType: entry.mimeType, fileName: entry.fileName, ...(origin?.width && origin.height ? { width: origin.width, height: origin.height } : {}) }
}

export function libraryImageUrl(assetId: string): string {
  return `xingmang-asset://image/${assetId}`
}

export function libraryThumbnailUrl(entry: Pick<AiLibraryEntry, 'assetId' | 'mediaType'>): string {
  return assetThumbnailUrl(entry.assetId, entry.mediaType)
}

/** 页面上量出来的一段视频：宽高和时长（<video> 读到开头就知道）。 */
export interface LibraryMeasured { width?: number, height?: number, durationSeconds?: number }

/**
 * 点开的视频占的形状，写成 CSS 认的「宽 / 高」：排在前面的先用（页面量出来的，其次是记着的），都没有时按 16:9。
 * 这个形状要由我们定：只限最宽最高的话，按播放之前 <video> 照缩略图的大小排（缩略图是小图，读不出来时只剩
 * 300 × 150），画面只占一小块，按了播放才变回原来的大小。
 */
export function libraryPlayerRatio(...sizes: readonly (LibraryMeasured | null | undefined)[]): string {
  for (const size of sizes) {
    if (!size) continue
    const { width, height } = size
    // Number.isFinite 不认数字以外的东西，拼进样式的只会是两个正数。
    if (Number.isFinite(width) && Number.isFinite(height) && Number(width) > 0 && Number(height) > 0) return `${width} / ${height}`
  }
  return '16 / 9'
}

/**
 * 作品库里的一段视频换成视频那边用的样子。尺寸和时长先用当时主进程量的（对话、视频里记着的），
 * 没记着的用页面上量出来的，都没有就不写（拼片时照样按文件本身来）。
 */
export function libraryVideoClip(entry: Pick<AiLibraryEntry, 'assetId'>, origin?: LibraryOrigin, measured?: LibraryMeasured | null): AiVideoClip {
  const width = origin?.clip?.width ?? positive(measured?.width), height = origin?.clip?.height ?? positive(measured?.height)
  const durationSeconds = origin?.clip?.durationSeconds ?? positive(measured?.durationSeconds)
  return { assetId: entry.assetId, thumbnailUrl: assetThumbnailUrl(entry.assetId, 'video'), ...(width && height ? { width, height } : {}), ...(durationSeconds ? { durationSeconds } : {}) }
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 「添加到视频」「使用已有片段」交给视频那边的：当时那句话、片段、开头图。 */
export function libraryClipSource(entry: Pick<AiLibraryEntry, 'assetId' | 'prompt'>, origin?: LibraryOrigin, measured?: LibraryMeasured | null): VideoStudioClipSource {
  return { prompt: origin?.prompt || entry.prompt || '', clip: libraryVideoClip(entry, origin, measured), ...(origin?.imageAssetId ? { imageAssetId: origin.imageAssetId } : {}) }
}

/**
 * 「添加到视频 › 新建视频」时新的那一条照什么来。对话里出的照当时的设置；别处来的只按片段自己的宽高定画面比例，
 * 模型留空（视频工作台自己挑默认的），时长照片段的，量不出来按 5 秒。
 */
export function libraryClipMade(clip: AiVideoClip, origin?: LibraryOrigin): ChatVideoMade {
  if (origin?.made) return origin.made
  const aspect = clip.width && clip.height ? (clip.width > clip.height ? '16:9' : clip.width < clip.height ? '9:16' : '1:1') : '16:9'
  const seconds = clip.durationSeconds ? Math.round(clip.durationSeconds) : 0
  return { aspect, model: '', group: '', seconds: seconds > 0 ? seconds : 5 }
}

/** 视频格子角上的字：成片写「成片 0:15」，别的写「0:05」；不知道多长时成片只写「成片」，别的只有播放的小三角。 */
export function libraryBadge(origin: LibraryOrigin | undefined, film: boolean): string {
  const seconds = origin?.clip?.durationSeconds ? Math.round(origin.clip.durationSeconds) : 0
  const duration = seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''
  return [film ? '成片' : '', duration].filter(Boolean).join(' ')
}
