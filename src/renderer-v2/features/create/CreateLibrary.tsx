import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowUpRight, Brush, Clapperboard, Download, Film, FolderOpen, Image as ImageIcon, Infinity as InfinityIcon, MessageSquare, Play, Plus, RefreshCw } from 'lucide-react'
import { missingAiAssetMessages } from '../../../../electron/ai-asset-missing'
import type { AiChatAsset, AiLibraryEntry } from '../../../../electron/ipc-contract'
import { Button, Chips, Dialog, Menu, SearchInput, Skeleton } from '../../ui'
import type { ChatVideoFilm } from '../chat/ChatVideo'
import type { Conversation } from '../chat/state'
import type { ChatVideoMade } from '../chat/video'
import { videoClipPlayUrl } from '../video-studio/clip'
import type { VideoStudioItem } from '../video-studio/library'
import type { VideoStudioClipSource } from '../video-studio/project'
import {
  buildLibraryOrigins, libraryBadge, libraryCaption, libraryChatAsset, libraryClipMade, libraryClipSource, libraryDetailLine, libraryEntryOrigin, libraryFilmAssetIds, libraryImageUrl,
  libraryKindCount, libraryKindNames, libraryKinds, libraryMatchedAssetIds, libraryPlayerRatio, libraryThumbnailUrl, libraryTitle, type LibraryMeasured, type LibraryOrigin, type LibraryOrigins,
} from './library'
import { AddToCanvasMenu, type CanvasIntakeProject } from './canvas-intake'
import { ImageUpscaleMenu, type ImageUpscaleControl } from './image-upscale'
import { useCreateLibrary, type CreateLibrary, type CreateLibraryBridge } from './useCreateLibrary'

// 主窗口的作品库（融合第 3 步）：右边那一块、点开一件、从别处叫出来的选择框。字照方案第 2.9 节，
// 按 2026-11-21 定的正式口吻写。数据在 useCreateLibrary，「哪来的」那一层纯计算在 library.ts。
// 第 5 步起画布项目里生成的也列在里面，点开一个画布项目时那一块（CanvasProjectWorks）也在这里。

const searchDelayMs = 250

interface LibraryBrowserProps {
  library: CreateLibrary
  origins: LibraryOrigins
  /** 每条视频上一次拼好的成片：格子角上写「成片」。 */
  films: ReadonlySet<string>
  /** 出不出「全部 / 图片 / 视频 / 成片」那一排；选择框只挑一类，不出。 */
  kinds: boolean
  /** 选着的那几件（选择框里用），按选的先后。 */
  selected?: readonly string[]
  onSelect: (entry: AiLibraryEntry) => void
  testId: string
}

/** 筛选、搜索、一格一格的作品、「加载更多」，作品库那一块和选择框共用。 */
function LibraryBrowser({ library, origins, films, kinds, selected, onSelect, testId }: LibraryBrowserProps) {
  const [text, setText] = useState(library.search)
  const latest = useRef({ origins, setSearch: library.setSearch })
  latest.current = { origins, setSearch: library.setSearch }
  // 打字停一下再搜：一个字搜一次没必要。清空了马上回到全部。
  useEffect(() => {
    const timer = window.setTimeout(() => latest.current.setSearch(text, libraryMatchedAssetIds(latest.current.origins, text)), text.trim() ? searchDelayMs : 0)
    return () => window.clearTimeout(timer)
  }, [text])
  const kindOptions = useMemo(() => libraryKinds.map((kind) => ({ value: kind, label: libraryKindNames[kind], ...(library.counts ? { count: libraryKindCount(library.counts, kind) } : {}), testId: `${testId}-kind-${kind}` })), [library.counts, testId])
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const select = useMemo(() => (entry: AiLibraryEntry) => selectRef.current(entry), [])
  return <>
    <div className="create-library-tools">
      {kinds && <Chips label="作品类别" value={library.kind} onChange={(value) => library.setKind(libraryKinds.find((kind) => kind === value) ?? 'all')} options={kindOptions} testId={`${testId}-kinds`} />}
      <SearchInput value={text} onChange={setText} placeholder="按描述搜索" testId={`${testId}-search`} />
    </div>
    {library.status === 'loading' ? <Skeleton rows={4} testId={`${testId}-loading`} />
      : library.status === 'unreadable' ? <div className="create-library-empty" role="alert" data-testid={`${testId}-unreadable`}><p>作品库读取失败，请稍后重试</p><Button size="sm" icon={RefreshCw} onClick={library.refresh} testId={`${testId}-retry`}>重试</Button></div>
      : library.items.length === 0 ? <div className="create-library-empty" data-testid={`${testId}-empty`}><p>{library.search ? `未找到与「${library.search}」相关的作品` : library.kind !== 'all' ? '该分类下暂无作品。' : '暂无作品。生成的图片和视频将显示在此处。'}</p></div>
      : <>
        <div className="create-library-grid" data-testid={`${testId}-grid`}>
          {library.items.map((entry) => <LibraryTile key={entry.assetId} entry={entry} origin={libraryEntryOrigin(entry, origins)} film={films.has(entry.assetId)} order={selected ? selected.indexOf(entry.assetId) + 1 : undefined} onSelect={select} />)}
        </div>
        {library.hasMore && <div className="create-library-more"><Button size="sm" loading={library.loadingMore} onClick={library.loadMore} testId={`${testId}-more`}>加载更多</Button></div>}
      </>}
  </>
}

interface LibraryTileProps {
  entry: AiLibraryEntry
  origin: LibraryOrigin | undefined
  film: boolean
  /** 选择框里：选着的是第几个（1 起），0 是没选；不在选择框里是 undefined。 */
  order?: number
  onSelect: (entry: AiLibraryEntry) => void
}

const LibraryTile = memo(function LibraryTile({ entry, origin, film, order, onSelect }: LibraryTileProps) {
  const [failed, setFailed] = useState(false)
  const video = entry.mediaType === 'video'
  const badge = video ? libraryBadge(origin, film) : ''
  const title = libraryTitle(entry, origin, film)
  return <button type="button" className="create-library-tile" aria-label={title} title={title} aria-pressed={order === undefined ? undefined : order > 0} onClick={() => onSelect(entry)} data-kind={film ? 'film' : entry.mediaType} data-testid={`create-library-item-${entry.assetId}`}>
    <span className="create-library-thumb">
      {failed ? (video ? <Clapperboard size={22} aria-hidden="true" /> : <ImageIcon size={22} aria-hidden="true" />)
        : <img src={libraryThumbnailUrl(entry)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
      {video && <b><Play size={10} aria-hidden="true" />{badge}</b>}
      {order !== undefined && order > 0 && <i aria-hidden="true">{order}</i>}
    </span>
    <small>{libraryCaption(entry, origin)}</small>
  </button>
})

/** 作品库里要外面办的事：这一块自己不碰主进程，也不知道对话那一半怎么摆。 */
export interface CreateLibraryActions {
  openFolder: () => void
  openConversation: (id: string) => void
  openFilm: (id: string) => void
  /** 右边换成这个画布项目的那一块（融合第 5 步）。 */
  openCanvasProject: (id: string) => void
  reuseImage: (asset: AiChatAsset) => void
  animateImage: (asset: AiChatAsset, prompt: string) => void
  saveImage: (assetId: string) => void
  saveVideo: (assetId: string, suggestedName: string) => void
  openVideo: (assetId: string) => void
  addClip: (filmId: string | null, source: VideoStudioClipSource, made: ChatVideoMade) => void
  /** 把这张图抄一份进这个画布项目的素材库（融合第 5 步）；projectId 是 null 就新建一个，名字取 description 开头的几个字。 */
  addToCanvas: (projectId: string | null, assetId: string, description: string) => void
  /** 「变清晰」：放大 2 倍或 4 倍另存一张，原图不动；跟对话里那张图下面的是同一份。 */
  upscale: ImageUpscaleControl
}

export interface CreateLibraryPaneProps {
  library: CreateLibrary
  conversations: readonly Conversation[]
  /** 这个账号列得出的视频（没有出视频这一项的账号是空的）。 */
  films: readonly VideoStudioItem[]
  /** 这个账号现在能不能出视频：能才有「用此图生成视频」「添加到视频」。 */
  videoReady: boolean
  /** 「添加到视频」菜单里列的视频。 */
  videoFilms: readonly ChatVideoFilm[]
  /** 「添加到画布」菜单里列的画布项目；不给就没有这个按钮。 */
  canvasProjects?: readonly CanvasIntakeProject[]
  actions: CreateLibraryActions
}

/** 右边的作品库：对话里出的图和视频、视频里的片段和成片、画布项目里生成的图和视频，按时间新的在前。 */
export function CreateLibraryPane({ library, conversations, films, videoReady, videoFilms, canvasProjects, actions }: CreateLibraryPaneProps) {
  const origins = useMemo(() => buildLibraryOrigins(conversations, films), [conversations, films])
  const filmIds = useMemo(() => new Set(libraryFilmAssetIds(films)), [films])
  const [opened, setOpened] = useState<AiLibraryEntry | null>(null)
  return <div className="chat-conversation create-pane" data-testid="create-library-pane">
    <header className="chat-bar"><strong>作品库</strong><div className="chat-bar-actions"><Button icon={FolderOpen} variant="ghost" size="sm" onClick={actions.openFolder} testId="create-library-folder">打开文件夹</Button></div></header>
    <div className="create-library">
      <LibraryBrowser library={library} origins={origins} films={filmIds} kinds onSelect={setOpened} testId="create-library" />
      <p className="create-quiet">对话、视频和画布中生成的图片、片段和成片均显示在此处。对话和视频的文件位于本机的 AI 作品文件夹，画布的文件位于各项目的工作文件夹。</p>
    </div>
    {opened && <LibraryDetail entry={opened} origin={libraryEntryOrigin(opened, origins)} film={filmIds.has(opened.assetId)} videoReady={videoReady} videoFilms={videoFilms} canvasProjects={canvasProjects} actions={actions} onClose={() => setOpened(null)} />}
  </div>
}

interface LibraryDetailProps extends Pick<CreateLibraryPaneProps, 'videoReady' | 'videoFilms' | 'canvasProjects' | 'actions'> {
  entry: AiLibraryEntry
  origin: LibraryOrigin | undefined
  film: boolean
  /** 出不出「查看对话」「查看视频」「查看画布项目」那个按钮；已经在那个画布项目里点开的不用再出。 */
  originLink?: boolean
  onClose: () => void
}

const originLinks: Readonly<Record<LibraryOrigin['from'], { label: string, icon: typeof MessageSquare }>> = {
  chat: { label: '查看对话', icon: MessageSquare },
  video: { label: '查看视频', icon: Clapperboard },
  canvas: { label: '查看画布项目', icon: InfinityIcon },
}

/** 点开一件：大图或者能直接放的视频，下面是哪来的、能拿它做什么。 */
export function LibraryDetail({ entry, origin, film, originLink = true, videoReady, videoFilms, canvasProjects, actions, onClose }: LibraryDetailProps) {
  // 页面上量出来的宽高、时长：对话和视频里没记着的那些作品，标题下面那一行和「添加到视频」靠它。
  const [measured, setMeasured] = useState<LibraryMeasured | null>(null)
  const [missing, setMissing] = useState(false)
  const video = entry.mediaType === 'video'
  const title = libraryTitle(entry, origin, film)
  const recorded = video ? origin?.clip : origin
  const asset = libraryChatAsset(entry, origin)
  const prompt = origin?.prompt || entry.prompt || ''
  const compose = (filmId: string | null) => {
    const source = libraryClipSource(entry, origin, measured)
    actions.addClip(filmId, source, libraryClipMade(source.clip, origin))
  }
  const footer = video
    ? <>
      {videoReady && <Menu label="选择要添加到的视频" heading="选择要添加到的视频" align="start" anchor={<Button icon={Film} testId="create-library-compose">添加到视频</Button>} items={[
        { label: '新建视频', icon: Plus, testId: 'create-library-compose-new', onSelect: () => compose(null) },
        ...(videoFilms.length ? ['divider' as const] : []),
        ...videoFilms.map((item) => ({ label: item.title, hint: item.detail, icon: Clapperboard, disabled: item.full, testId: `create-library-compose-${item.id}`, onSelect: () => compose(item.id) })),
      ]} />}
      <Button icon={Download} onClick={() => actions.saveVideo(entry.assetId, (film ? origin?.title ?? '' : prompt).trim().slice(0, 40))} testId="create-library-save-video">另存视频</Button>
      <Button icon={ArrowUpRight} onClick={() => actions.openVideo(entry.assetId)} testId="create-library-open-video">用播放器打开</Button>
    </>
    : <>
      {asset && <Button icon={Brush} onClick={() => { onClose(); actions.reuseImage(asset) }} testId="create-library-reuse">基于此图继续编辑</Button>}
      {asset && videoReady && <Button icon={Clapperboard} onClick={() => { onClose(); actions.animateImage(asset, prompt) }} testId="create-library-animate">用此图生成视频</Button>}
      {canvasProjects && <AddToCanvasMenu projects={canvasProjects} onPick={(projectId) => actions.addToCanvas(projectId, entry.assetId, prompt)} testId="create-library-canvas" />}
      <ImageUpscaleMenu assetId={entry.assetId} prompt={prompt} control={actions.upscale} testId="create-library-upscale" />
      <Button icon={Download} onClick={() => actions.saveImage(entry.assetId)} testId="create-library-save-image">另存图片</Button>
    </>
  return <Dialog open title={title} subtitle={libraryDetailLine(entry, origin, recorded?.width && recorded.height ? recorded : measured)} width={640} onClose={onClose} footer={footer} testId="create-library-detail">
    <div className="create-library-media" data-kind={entry.mediaType}>
      {missing ? <p role="alert">{video ? missingAiAssetMessages.video : missingAiAssetMessages.image}</p>
        : video ? <video src={videoClipPlayUrl(entry.assetId)} poster={libraryThumbnailUrl(entry)} controls playsInline
          style={{ '--create-library-player-ratio': libraryPlayerRatio(measured, recorded) } as CSSProperties}
          onLoadedMetadata={(event) => setMeasured({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight, durationSeconds: event.currentTarget.duration })}
          onError={() => setMissing(true)} data-testid="create-library-player" />
          : <img src={libraryImageUrl(entry.assetId)} alt={title} onLoad={(event) => setMeasured({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setMissing(true)} data-testid="create-library-image" />}
    </div>
    {origin && originLink && <div className="create-library-origin">
      <Button size="sm" variant="ghost" icon={originLinks[origin.from].icon} onClick={() => { onClose(); if (origin.from === 'chat') actions.openConversation(origin.id); else if (origin.from === 'video') actions.openFilm(origin.id); else actions.openCanvasProject(origin.id) }} testId="create-library-origin">{originLinks[origin.from].label}</Button>
    </div>}
  </Dialog>
}

export interface CanvasProjectWorksProps extends Pick<CreateLibraryPaneProps, 'conversations' | 'films' | 'videoReady' | 'videoFilms' | 'canvasProjects' | 'actions'> {
  bridge: CreateLibraryBridge
  active: boolean
  projectId: string
}

/**
 * 点开一个画布项目时下面那一块（融合第 5 步）：这个项目里生成的图片和视频，新的在前，点一格跟作品库里一样点开。
 * 用的地方按项目编号做 key：换一个项目是换一份新的，不会先闪一下上一个项目的东西。
 */
export function CanvasProjectWorks({ bridge, active, projectId, conversations, films, videoReady, videoFilms, canvasProjects, actions }: CanvasProjectWorksProps) {
  const filmList = useMemo(() => libraryFilmAssetIds(films), [films])
  const library = useCreateLibrary(bridge, active, filmList, 'all', projectId)
  return <CanvasProjectWorksView library={library} conversations={conversations} films={films} videoReady={videoReady} videoFilms={videoFilms} canvasProjects={canvasProjects} actions={actions} />
}

/** 上面那一块怎么摆；数据由外面给，好单独看每一种样子。 */
export function CanvasProjectWorksView({ library, conversations, films, videoReady, videoFilms, canvasProjects, actions }: Omit<CanvasProjectWorksProps, 'bridge' | 'active' | 'projectId'> & { library: CreateLibrary }) {
  const origins = useMemo(() => buildLibraryOrigins(conversations, films), [conversations, films])
  const filmIds = useMemo(() => new Set(libraryFilmAssetIds(films)), [films])
  const [opened, setOpened] = useState<AiLibraryEntry | null>(null)
  const select = useMemo(() => (entry: AiLibraryEntry) => setOpened(entry), [])
  return <section className="create-canvas-works" aria-label="此项目中的作品" data-testid="create-canvas-works">
    <header><strong>此项目中的作品</strong>{library.status === 'ready' && library.total > 0 && <span data-testid="create-canvas-works-count">{library.total} 个</span>}</header>
    {library.status === 'loading' ? <Skeleton rows={2} testId="create-canvas-works-loading" />
      : library.status === 'unreadable' ? <div className="create-library-empty" role="alert" data-testid="create-canvas-works-unreadable"><p>作品读取失败，请稍后重试</p><Button size="sm" icon={RefreshCw} onClick={library.refresh} testId="create-canvas-works-retry">重试</Button></div>
      : library.items.length === 0 ? <p className="create-quiet" data-testid="create-canvas-works-empty">此项目暂无作品。在画布中生成的图片和视频将显示在此处。</p>
      : <>
        <div className="create-library-grid" data-testid="create-canvas-works-grid">
          {library.items.map((entry) => <LibraryTile key={entry.assetId} entry={entry} origin={libraryEntryOrigin(entry, origins)} film={filmIds.has(entry.assetId)} onSelect={select} />)}
        </div>
        {library.hasMore && <div className="create-library-more"><Button size="sm" loading={library.loadingMore} onClick={library.loadMore} testId="create-canvas-works-more">加载更多</Button></div>}
      </>}
    {opened && <LibraryDetail entry={opened} origin={libraryEntryOrigin(opened, origins)} film={filmIds.has(opened.assetId)} originLink={false} videoReady={videoReady} videoFilms={videoFilms} canvasProjects={canvasProjects} actions={actions} onClose={() => setOpened(null)} />}
  </section>
}

/** 选择框里选好的一件，带着它是哪来的。 */
export interface LibraryPicked { entry: AiLibraryEntry, origin?: LibraryOrigin }

export interface LibraryPickerProps {
  bridge: CreateLibraryBridge
  /** 只挑图片，或者只挑视频（片段和成片都算）。 */
  kind: 'image' | 'video'
  /** 最多选几件；1 是单选。 */
  limit: number
  conversations: readonly Conversation[]
  films: readonly VideoStudioItem[]
  /** 点了「确定」。交回的还没落定时按钮转着圈、框不关。 */
  onPick: (picked: LibraryPicked[]) => void | Promise<void>
  onClose: () => void
}

/** 从作品库里选：镜头上的「从作品库选图」「使用已有片段」，和起始页「用已有片段合成视频」。 */
export function LibraryPicker({ bridge, kind, limit, conversations, films, onPick, onClose }: LibraryPickerProps) {
  const filmList = useMemo(() => libraryFilmAssetIds(films), [films])
  const filmIds = useMemo(() => new Set(filmList), [filmList])
  const library = useCreateLibrary(bridge, true, filmList, kind)
  const origins = useMemo(() => buildLibraryOrigins(conversations, films), [conversations, films])
  const [selected, setSelected] = useState<AiLibraryEntry[]>([])
  const [confirming, setConfirming] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const toggle = (entry: AiLibraryEntry) => setSelected((current) => {
    if (current.some((item) => item.assetId === entry.assetId)) return current.filter((item) => item.assetId !== entry.assetId)
    if (limit === 1) return [entry]
    return current.length >= limit ? current : [...current, entry]
  })
  const confirm = async () => {
    if (!selected.length || confirming) return
    setConfirming(true)
    try { await onPick(selected.map((entry) => { const origin = libraryEntryOrigin(entry, origins); return { entry, ...(origin ? { origin } : {}) } })) }
    finally { if (mounted.current) setConfirming(false) }
  }
  return <Dialog open title={kind === 'image' ? '选择图片' : '选择片段'} subtitle={limit > 1 ? `最多选择 ${limit} 段，按选择顺序排列。` : undefined} width={640} onClose={onClose} busy={confirming} testId="create-library-picker"
    footer={<><Button onClick={onClose} disabled={confirming} testId="create-library-picker-cancel">取消</Button><Button variant="primary" disabled={!selected.length} loading={confirming} onClick={() => void confirm()} testId="create-library-picker-ok">确定</Button></>}>
    <div className="create-library-picker">
      <LibraryBrowser library={library} origins={origins} films={filmIds} kinds={false} selected={selected.map((entry) => entry.assetId)} onSelect={toggle} testId="create-library-picker" />
    </div>
  </Dialog>
}

/**
 * 量一段视频的宽高和时长：只读到文件开头（主窗口放得了作品库里当前账号的音视频）。几秒读不出来、文件不在了交回 null，
 * 用的地方按不知道处理。
 */
export function measureLibraryVideo(assetId: string, timeoutMs = 4_000): Promise<LibraryMeasured | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    const finish = (value: LibraryMeasured | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolve(value)
    }
    const timer = window.setTimeout(() => finish(null), timeoutMs)
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => finish({ width: video.videoWidth, height: video.videoHeight, durationSeconds: video.duration })
    video.onerror = () => finish(null)
    video.src = videoClipPlayUrl(assetId)
  })
}
