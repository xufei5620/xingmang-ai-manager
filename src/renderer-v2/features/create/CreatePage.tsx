import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Clapperboard, Film, Infinity as InfinityIcon, Pencil, Trash2, type LucideIcon } from 'lucide-react'
import type { CanvasProjectListEntry, XingmangApi } from '../../../../electron/ipc-contract'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { Button, Confirm, Dialog, Input, Notice, useToast } from '../../ui'
import { dollars } from '../../business-common'
import { useLatestRequest } from '../../latest-request'
import { useSharedBalanceSelector } from '../app/balance-context'
import { diagnosticFolderUnavailableMessage } from '../app/diagnostic-folder'
import { PageLoading } from '../app/PageLoading'
import { ChatPage, type ChatPageCreate, type ChatPageProps, type ChatPageVideo } from '../chat/ChatPage'
import type { ChatVideoFilm } from '../chat/ChatVideo'
import { chatAssetSaveErrorMessage, type ChatSite } from '../chat/state'
import { cleanVideoStudioItemName, maxVideoStudioItemNameLength, maxVideoStudioProjects, videoStudioItemName, type VideoStudioItem } from '../video-studio/library'
import { useVideoStudioPriceList, videoStudioPerCallUsd, videoStudioQuoteText } from '../video-studio/prices'
import { appendVideoStudioClip, canAddVideoStudioShot, createVideoStudioProjectFromClip, createVideoStudioProjectFromClips, videoStudioDraftProgress, type VideoStudioClipSource } from '../video-studio/project'
import { videoStudioErrorMessage } from '../video-studio/useVideoStudio'
import { useVideoStudioLibrary, useVideoStudioSession } from '../video-studio/useVideoStudioLibrary'
import type { VideoStudioAccess, VideoStudioLibraryPicker } from '../video-studio/VideoStudioPage'
import { CreateLibraryPane, LibraryPicker, measureLibraryVideo, type CreateLibraryActions, type LibraryPicked } from './CreateLibrary'
import { libraryClipMade, libraryClipSource, libraryFilmAssetIds, libraryKindCount, type LibraryOrigin } from './library'
import { createTimeText, type CreateExtraItem, type CreateExtraKind, type CreateSelection } from './list'
import { useCreateLibrary } from './useCreateLibrary'
import './create.css'

// 视频工作台连着拼片那一套（WebCodecs、后台线程）比较重，打开第一条视频时才读。
const VideoStudioPage = lazy(() => import('../video-studio/VideoStudioPage').then((module) => ({ default: module.VideoStudioPage })))

export interface CreatePageProps extends Omit<ChatPageProps, 'create'> {
  site: ChatSite
  /** 这个账号能不能做视频：历史账号没有视频模型是 unsupported；状态文件临时关掉是 suspended（以前做的照样列着）。 */
  videoAccess: Exclude<VideoStudioAccess, 'guest'>
  /** 从教程、引导点「打开视频剪辑」过来：接着最近那一条视频，一条都没有就新开一条。接住以后调 onVideoOpened 放下。 */
  openVideo?: boolean
  onVideoOpened?: () => void
  /** 顶部搜索的「作品库」：为 true 时右边换成作品库，接住以后调 onLibraryOpened 放下。 */
  openLibrary?: boolean
  onLibraryOpened?: () => void
  /** 打开画布窗口（落在它的项目中心）。 */
  onOpenCanvas: () => void
  /** 把画布窗口开在这个项目上；开没开成都交回，这边好重读一遍项目。 */
  onOpenCanvasProject: (projectId: string) => Promise<void>
}

/**
 * 「创作」：聊天、画布、视频剪辑合成的一页（融合第 1 步，方案见 0.2.25 三块融合）。左边一列是做过的东西，
 * 对话、视频、画布项目排在一起；右边是点开的那一样。对话那一半还是 ChatPage，这里管视频、画布项目和作品库（第 3 步）。
 */
export function CreatePage(props: CreatePageProps) {
  return <CreateScope key={props.accountScope} {...props} />
}

const videoKinds: readonly CreateExtraKind[] = ['video', 'canvas']
const canvasOnlyKinds: readonly CreateExtraKind[] = ['canvas']
// 只出现一次的那条提示看没看过。记在这台电脑上，不分账号：说的是界面换了样子。
const introSeenKey = 'xingmang-ui-v2:create-intro-seen'

function introSeen(): boolean {
  // 读不了本机存储就当看过了：不然每次打开都说一遍。
  try { return window.localStorage.getItem(introSeenKey) === '1' } catch { return true }
}

function rememberIntroSeen() {
  try { window.localStorage.setItem(introSeenKey, '1') } catch { /* 记不下就算了，最多下次再说一遍。 */ }
}

/**
 * 从作品库里选东西的那个框开着是为了什么：给一个镜头选图、选一段现成的片段（选完交回视频工作台），
 * 或者起始页第三张卡挑几段新建一条视频。
 */
type Picking = { kind: 'image', done: (assetId: string | null) => void } | { kind: 'clip', done: (source: VideoStudioClipSource | null) => void } | { kind: 'film' }

// 关掉没选：等着的那一头拿到 null。
function settlePicking(picking: Picking | null) {
  if (picking?.kind === 'image') picking.done(null)
  else if (picking?.kind === 'clip') picking.done(null)
}

interface CanvasProjects {
  /** unreadable：这一次没读出来，先不列画布项目。 */
  status: 'loading' | 'ready' | 'unreadable'
  projects: CanvasProjectListEntry[]
}

/**
 * 当前账号的画布项目（名字和时间）。项目在画布窗口里新建、改名、删除，这边没有事件可听，
 * 所以这一页每次露面、窗口每次回到前台时重读一遍；读不出来时留着上一次读到的。
 */
function useCanvasProjects(bridge: Pick<XingmangApi, 'listCanvasProjects'>, active: boolean) {
  const latest = useLatestRequest()
  const [state, setState] = useState<CanvasProjects>({ status: 'loading', projects: [] })
  const refresh = () => {
    const current = latest.begin()
    bridge.listCanvasProjects().then(
      (projects) => { if (current()) setState({ status: 'ready', projects }) },
      () => { if (current()) setState((previous) => previous.status === 'ready' ? previous : { status: 'unreadable', projects: [] }) },
    )
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!active) return
    refreshRef.current()
    const onFocus = () => refreshRef.current()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, bridge])
  return { ...state, refresh }
}

function CreateScope({ bridge, accountScope, active = true, site, videoAccess, openVideo, onVideoOpened, openLibrary, onLibraryOpened, onOpenCanvas, onOpenCanvasProject, ...chat }: CreatePageProps) {
  const toast = useToast()
  const library = useVideoStudioLibrary(bridge, accountScope)
  const session = useVideoStudioSession(library)
  const canvas = useCanvasProjects(bridge, active)
  const owner = useLatestRequest()
  const [selected, setSelected] = useState<CreateSelection | null>(null)
  const [renaming, setRenaming] = useState<{ id: string, text: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [intro, setIntro] = useState<'undecided' | 'shown' | 'gone'>(() => introSeen() ? 'gone' : 'undecided')
  const videosListed = videoAccess !== 'unsupported'
  const videos = useStableList(videosListed ? library.items : noVideos)
  // 主窗口的作品库（融合第 3 步）：右边换成它时对话、视频那一块只藏不卸，跟点一条视频一样。
  const assets = useCreateLibrary(bridge, active, useStableList(libraryFilmAssetIds(videos)))
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [picking, setPicking] = useState<Picking | null>(null)
  const pickingRef = useRef(picking)
  pickingRef.current = picking
  // 输入框「生成视频」那一档发送前问价用的价目和余额，同视频工作台的确认框。价目不随这一页露面就读：
  // 切到那一档、打开确认框时对话页来要（refresh），不做视频的客户不用白读一次。
  const balance = useSharedBalanceSelector((state) => state.scope === accountScope ? state.balance : null)
  const prices = useVideoStudioPriceList(bridge, accountScope, false)
  // 列表的行是 memo 的：同一条视频、同一个项目没变时交出去的还是同一个对象。
  const rows = useRef({ videos: new WeakMap<VideoStudioItem, CreateExtraItem>(), projects: new WeakMap<CanvasProjectListEntry, CreateExtraItem>(), films: new WeakMap<VideoStudioItem, ChatVideoFilm>() })
  const items: CreateExtraItem[] = [
    ...videos.map((item) => cached<VideoStudioItem, CreateExtraItem>(rows.current.videos, item, () => ({ kind: 'video', id: item.id, title: videoStudioItemName(item), detail: videoStudioDraftProgress(item.project), updatedAt: item.updatedAt }))),
    ...canvas.projects.map((entry) => cached<CanvasProjectListEntry, CreateExtraItem>(rows.current.projects, entry, () => ({ kind: 'canvas', id: entry.id, title: entry.name, detail: '画布项目', updatedAt: entry.updatedAt }))),
  ]
  const stableItems = useStableList(items)
  // 「添加到视频」菜单里列的视频：一行一条，「橘猫回家　4 个镜头」；镜头放满了的灰着。
  const films = useStableList(videos.map((item) => cached<VideoStudioItem, ChatVideoFilm>(rows.current.films, item, () => createVideoFilm(item))))

  const openItem = session.openId ? library.get(session.openId) : null
  const openName = openItem ? videoStudioItemName(openItem) : ''
  const videoShown = selected?.kind === 'video' && selected.id === session.openId && Boolean(openItem)
  const project = selected?.kind === 'canvas' ? canvas.projects.find((entry) => entry.id === selected.id) ?? null : null
  // 开着的那一条视频手上有事（写分镜、出片、画图、拼片）时不换别的：出好的东西要挂回它身上。
  const sayBusy = () => toast.show(`「${openName}」正在处理中（编写分镜、生成或合成），请待其完成后再打开其他视频。`, 'warn')
  const showVideo = (id: string) => {
    const result = session.open(id)
    if (result === 'busy') sayBusy()
    if (result === 'opened') { setLibraryOpen(false); setSelected({ kind: 'video', id }) }
  }
  const startVideo = () => {
    const started = session.start()
    if (started === 'busy') sayBusy()
    else if (started === 'full') toast.show(`最多保存 ${maxVideoStudioProjects} 条视频，请先删除不需要的视频后再新建。`, 'warn')
    else { setLibraryOpen(false); setSelected({ kind: 'video', id: started.id }) }
  }
  // 每次点开都再读一遍：视频工作台里刚出的片段、刚拼好的成片要在里面。
  const showLibrary = () => { setSelected(null); setLibraryOpen(true); assets.refresh() }
  const leave = () => { setSelected(null); setLibraryOpen(false) }
  // 对话里的一段视频「添加到视频」：接到选的那一条最后（null 是新建一条）。开着的正是那一条时，写完它按新的重新读
  // （library.replace 换版本号，下面工作台的 key 跟着换）；它手上有事（写分镜、生成、拼片）就先不加，等它停下。
  const addClip: ChatPageVideo['addClip'] = (filmId, source, made) => {
    const id = filmId ?? library.create()
    if (!id) return { error: `最多保存 ${maxVideoStudioProjects} 条视频，请先删除不需要的视频后再新建。` }
    const item = library.get(id)
    const refusal = videoClipRefusal(item, filmId === null, id === session.openId && session.busy)
    if (!item || refusal) return { error: refusal ?? '' }
    library.replace(id, filmId === null ? createVideoStudioProjectFromClip(source, made, item.project.settings) : appendVideoStudioClip(item.project, source))
    return { id, title: videoStudioItemName(library.get(id) ?? item) }
  }
  // 作品库里要这一页办的几件事。另存、打开的结果用右下角那条提示说：对话那一块这时藏着，它顶上的横条看不到。
  const saveImage = (assetId: string) => {
    const ticket = owner.capture()
    bridge.saveAiChatAsset(assetId).then((result) => { if (ticket() && result.saved) toast.show('图片已保存', 'ok') }, (reason) => { if (ticket()) toast.show(chatAssetSaveErrorMessage(reason), 'bad') })
  }
  const saveVideo = (assetId: string, suggestedName: string) => {
    const ticket = owner.capture()
    bridge.saveAiVideo(assetId, suggestedName || undefined).then((result) => { if (ticket() && result.saved) toast.show('视频已保存', 'ok') }, (reason) => { if (ticket()) toast.show(videoStudioErrorMessage(reason, '保存失败，请更换位置后重试'), 'bad') })
  }
  const openVideoFile = (assetId: string) => {
    const ticket = owner.capture()
    bridge.openAiVideo(assetId).catch((reason) => { if (ticket()) toast.show(videoStudioErrorMessage(reason, '视频打开失败，请稍后重试'), 'bad') })
  }
  const openFolder = () => {
    const ticket = owner.capture()
    bridge.openDiagnosticFolder('ai-output').then((opened) => { if (ticket() && !opened) toast.show(diagnosticFolderUnavailableMessage, 'warn') }, (reason) => { if (ticket()) toast.show(videoStudioErrorMessage(reason, diagnosticFolderUnavailableMessage), 'warn') })
  }
  const addLibraryClip: CreateLibraryActions['addClip'] = (filmId, source, made) => {
    const result = addClip(filmId, source, made)
    if ('error' in result) { toast.show(result.error, 'warn'); return }
    toast.show(`已添加为「${result.title}」的最后一个镜头`, 'ok', { label: '查看', onSelect: (dismiss) => { dismiss(); showVideo(result.id) } })
  }
  // 选择框一次只开一个：前一个还等着就先按「没选」交回。
  const startPicking = (next: Picking) => { settlePicking(pickingRef.current); setPicking(next) }
  const closePicking = () => { settlePicking(pickingRef.current); setPicking(null) }
  const startPickingRef = useRef(startPicking)
  startPickingRef.current = startPicking
  // 交给视频工作台的那一个对象不变：它拿去等结果，这一页重画不会让它以为换了一个。
  const [studioLibrary] = useState<VideoStudioLibraryPicker>(() => ({
    pickImage: () => new Promise((resolve) => startPickingRef.current({ kind: 'image', done: resolve })),
    pickClip: () => new Promise((resolve) => startPickingRef.current({ kind: 'clip', done: resolve })),
  }))
  // 起始页第三张卡挑好了：新建一条视频，一个镜头一段，照挑的先后排。
  const startFilmFromClips = (sources: VideoStudioClipSource[], origin: LibraryOrigin | undefined) => {
    const started = session.start()
    if (started === 'busy') { sayBusy(); return }
    if (started === 'full') { toast.show(`最多保存 ${maxVideoStudioProjects} 条视频，请先删除不需要的视频后再新建。`, 'warn'); return }
    const item = library.get(started.id)
    if (!item) return
    library.replace(started.id, createVideoStudioProjectFromClips(sources, libraryClipMade(sources[0].clip, origin), item.project.settings))
    setLibraryOpen(false)
    setSelected({ kind: 'video', id: started.id })
  }
  const finishPicking = async (picked: LibraryPicked[]) => {
    const current = pickingRef.current
    if (!current || !picked.length) return
    if (current.kind === 'image') { setPicking(null); current.done(picked[0].entry.assetId); return }
    const ticket = owner.capture()
    // 对话和视频里没记着尺寸、时长的片段，交出去之前在页面上量一下（量不出来就不写，拼片时照文件本身来）。
    const sources = await Promise.all(picked.map(async ({ entry, origin }) => libraryClipSource(entry, origin, origin?.clip ? null : await measureLibraryVideo(entry.assetId))))
    if (!ticket() || pickingRef.current !== current) return
    setPicking(null)
    if (current.kind === 'clip') current.done(sources[0])
    else startFilmFromClips(sources, picked[0].origin)
  }
  // 开着的那一条视频手上有事时不新开别的：先说一句，不白让人挑一遍。
  const startClipFilm = () => { if (session.busy && session.openId) sayBusy(); else startPicking({ kind: 'film' }) }
  const openCanvasProject = (projectId: string) => {
    if (opening) return
    const ticket = owner.capture()
    setOpening(projectId)
    void onOpenCanvasProject(projectId).finally(() => { if (ticket()) { setOpening(null); canvas.refresh() } })
  }
  const removeVideo = () => {
    const id = removing
    setRemoving(null)
    if (!id) return
    if (!session.remove(id)) { sayBusy(); return }
    if (selected?.kind === 'video' && selected.id === id) setSelected(null)
  }
  const renamingItem = renaming ? library.get(renaming.id) : null
  const renameReady = Boolean(renaming && renamingItem && cleanVideoStudioItemName(renaming.text) && cleanVideoStudioItemName(renaming.text) !== videoStudioItemName(renamingItem))
  const saveRename = () => { if (!renaming || !renameReady) return; library.rename(renaming.id, renaming.text); setRenaming(null) }
  const startRename = (id: string) => { const item = library.get(id); if (item) setRenaming({ id, text: videoStudioItemName(item) }) }
  const removingItem = removing ? library.get(removing) : null

  // 选着的那个画布项目在画布窗口里被删了、归档了：右边回到对话这边。
  useEffect(() => {
    if (selected?.kind === 'canvas' && canvas.status === 'ready' && !canvas.projects.some((entry) => entry.id === selected.id)) setSelected(null)
  }, [selected, canvas.status, canvas.projects])
  // 教程、引导里的「打开视频剪辑」：接着开着的或最近的那一条，一条都没有就新开一条。
  useEffect(() => {
    if (!active || !openVideo || library.status === 'loading') return
    onVideoOpened?.()
    if (!videosListed) return
    if (session.openId && library.get(session.openId)) setSelected({ kind: 'video', id: session.openId })
    else if (library.items[0]) showVideo(library.items[0].id)
    else if (videoAccess === 'ready') startVideo()
  }, [active, openVideo, library.status])
  // 顶部搜索的「作品库」。
  useEffect(() => {
    if (!active || !openLibrary) return
    onLibraryOpened?.()
    showLibrary()
  }, [active, openLibrary])
  // 视频工作台忙完一轮（出好了片段、拼好了成片）：作品库里多了东西，左下角那个数跟着变。
  const wasBusy = useRef(session.busy)
  useEffect(() => {
    if (wasBusy.current && !session.busy && active) assets.refresh()
    wasBusy.current = session.busy
  }, [session.busy])
  // 切到别的页面，开着的选择框关掉（等着的那一头按没选算）；这一页卸掉时也一样。
  useEffect(() => { if (!active && pickingRef.current) closePicking() }, [active])
  useEffect(() => () => settlePicking(pickingRef.current), [])

  const pane = <>
    {openItem && <div className="chat-conversation create-pane" hidden={!videoShown} data-testid="create-video-pane">
      <header className="chat-bar"><strong title={openName} data-testid="create-video-name">{openName}</strong><div className="chat-bar-actions">
        <Button icon={Pencil} variant="ghost" size="sm" aria-label="重命名" title="重命名" onClick={() => startRename(openItem.id)} testId="create-video-rename" />
        <Button icon={Trash2} variant="ghost" size="sm" aria-label="删除此视频" title="删除此视频" disabled={session.busy} onClick={() => setRemoving(openItem.id)} testId="create-video-remove" />
      </div></header>
      <div className="create-studio"><Suspense fallback={<PageLoading />}>
        <VideoStudioPage key={`${openItem.id}:${library.revision(openItem.id)}`} bridge={bridge} accountScope={accountScope} site={site} access={videoAccess} active={active && videoShown}
          source={library.source(openItem.id)} onBusyChange={session.setBusy} onOpenAccount={chat.onOpenAccount} library={studioLibrary} />
      </Suspense></div>
    </div>}
    {project && <CanvasProjectPane project={project} opening={opening === project.id} onOpen={() => openCanvasProject(project.id)} />}
  </>

  const create: ChatPageCreate = {
    items: stableItems,
    kinds: videosListed ? videoKinds : canvasOnlyKinds,
    selected: videoShown || project ? selected : null,
    lockedVideoId: session.busy ? session.openId : null,
    actions: {
      open: (item) => { if (item.kind === 'video') showVideo(item.id); else { setLibraryOpen(false); setSelected({ kind: 'canvas', id: item.id }) } },
      leave,
      renameVideo: startRename,
      removeVideo: setRemoving,
      openCanvas: openCanvasProject,
    },
    pane,
    // 第三张卡要作品库里有视频才出：一段都没有时点进去是个空框。
    cards: <CreateStartCards video={videoAccess === 'ready'} clips={videoAccess === 'ready' && (assets.counts?.video ?? 0) > 0} onVideo={startVideo} onCanvas={onOpenCanvas} onClips={startClipFilm} />,
    intro: (conversationCount) => <CreateIntro state={intro} ready={active && library.status !== 'loading' && canvas.status !== 'loading'}
      hasEarlierWork={conversationCount > 0 || library.items.length > 0 || canvas.projects.length > 0}
      onDecide={(show) => { rememberIntroSeen(); setIntro(show ? 'shown' : 'gone') }} onDismiss={() => setIntro('gone')} />,
    notes: [...(videosListed && library.status === 'unreadable' ? ['历史视频读取失败'] : []), ...(canvas.status === 'unreadable' ? ['画布项目读取失败'] : [])],
    video: {
      access: videoAccess,
      quote: (model, group) => videoStudioQuoteText(videoStudioPerCallUsd(prices.list, model, group), 1, true),
      refreshPrices: prices.refresh,
      balance: balance ? dollars(balance.displayAmount) : null,
      films,
      addClip,
      openFilm: showVideo,
    },
    library: {
      open: libraryOpen,
      count: assets.counts ? libraryKindCount(assets.counts, 'all') : null,
      onOpen: showLibrary,
      refresh: assets.refresh,
      render: (context) => <>
        {libraryOpen && <CreateLibraryPane library={assets} conversations={context.conversations} films={videos} videoReady={context.canAnimate} videoFilms={films}
          actions={{ openFolder, openConversation: context.openConversation, openFilm: showVideo, reuseImage: context.reuseImage, animateImage: context.animateImage, saveImage, saveVideo, openVideo: openVideoFile, addClip: addLibraryClip }} />}
        {active && picking && <LibraryPicker key={picking.kind} bridge={bridge} kind={picking.kind === 'image' ? 'image' : 'video'} limit={picking.kind === 'film' ? videoStudioPlanLimits.maximumShots : 1}
          conversations={context.conversations} films={videos} onPick={finishPicking} onClose={closePicking} />}
      </>,
    },
  }

  return <>
    <ChatPage {...chat} bridge={bridge} accountScope={accountScope} active={active} create={create} />
    {active && renaming && <Dialog open title="重命名视频" width={480} onClose={() => setRenaming(null)} dirty={renameReady} testId="create-video-rename-dialog"
      footer={<><Button onClick={() => setRenaming(null)}>取消</Button><Button variant="primary" disabled={!renameReady} onClick={saveRename} testId="create-video-rename-save">保存</Button></>}>
      <Input aria-label="视频名称" value={renaming.text} onChange={(event) => setRenaming({ ...renaming, text: event.target.value })}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); saveRename() } }} maxLength={maxVideoStudioItemNameLength} autoFocus testId="create-video-rename-input" />
    </Dialog>}
    {active && removingItem && <Confirm testId="create-video-remove-confirm" title={`是否删除「${videoStudioItemName(removingItem)}」？`}
      body={<p>分镜和设置将被删除，已生成的片段和成片仍保留在作品库中。</p>} okLabel="删除" danger onOk={removeVideo} onClose={() => setRemoving(null)} />}
  </>
}

const noVideos: readonly VideoStudioItem[] = []

/** 「添加到视频」菜单里的一行：名字、几个镜头；放满了的点不了。没写分镜的那句跟左边那一列用同一个出处，两处不会说得不一样。 */
export function createVideoFilm(item: VideoStudioItem): ChatVideoFilm {
  const count = item.project.shots.length
  const full = !canAddVideoStudioShot(item.project)
  return { id: item.id, title: videoStudioItemName(item), detail: full ? `${count} 个镜头，已满` : count ? `${count} 个镜头` : videoStudioDraftProgress(item.project), ...(full ? { full } : {}) }
}

/**
 * 对话里的一段视频现在接不到这条视频上时要说的那句话；能接是 null。fresh：这一条是为这一段刚新建的（不用看放没放满）。
 * busy：它正开着，手上有事（写分镜、生成、拼片），出好的东西要挂回它身上，这时从外面改会被盖掉。
 */
export function videoClipRefusal(item: VideoStudioItem | null, fresh: boolean, busy: boolean): string | null {
  if (!item) return '该视频已删除，请选择其他视频。'
  const name = videoStudioItemName(item)
  if (busy) return `「${name}」正在进行其他操作（编写分镜、生成或合成），请待其完成后再添加。`
  if (!fresh && !canAddVideoStudioShot(item.project)) return `「${name}」的镜头数量已达上限，请选择其他视频，或新建视频。`
  return null
}

function cached<Key extends object, Value>(cache: WeakMap<Key, Value>, key: Key, build: () => Value): Value {
  const known = cache.get(key)
  if (known) return known
  const value = build()
  cache.set(key, value)
  return value
}

/** 每一项都没变就交回上一次那个数组：对话页拿它做 useMemo 的依赖，回复一段段到的时候不用重排这一列。 */
function useStableList<Item>(next: readonly Item[]): readonly Item[] {
  const previous = useRef(next)
  if (previous.current.length !== next.length || previous.current.some((item, index) => item !== next[index])) previous.current = next
  return previous.current
}

function StartCard({ icon: Icon, title, body, note, onClick, testId }: { icon: LucideIcon, title: string, body: string, note?: string, onClick: () => void, testId: string }) {
  return <button type="button" className="create-card" onClick={onClick} data-testid={testId}>
    <span className="create-card-icon"><Icon size={18} aria-hidden="true" /></span><strong>{title}</strong><span>{body}</span>
    {note && <small><ArrowUpRight size={12} aria-hidden="true" />{note}</small>}
  </button>
}

/**
 * 起始页六句示例下面的卡：一句话说不清的几样从这里进。
 * video：这个账号现在能不能新做视频（历史账号、临时停用时不出第一张）。clips：出不出第三张「用已有片段合成视频」
 * （能做视频、作品库里又有视频时才出，融合第 3 步）。
 */
export function CreateStartCards({ video, clips = false, onVideo, onCanvas, onClips }: { video: boolean, clips?: boolean, onVideo: () => void, onCanvas: () => void, onClips?: () => void }) {
  return <div className="create-start" data-testid="create-start">
    <div className="create-start-label">复杂创作从这里开始</div>
    <div className="create-cards">
      {video && <StartCard icon={Clapperboard} title="做一条带字幕的短视频" body="输入创意，AI 将编写分镜、分段生成并合成为完整视频" onClick={onVideo} testId="create-card-video" />}
      <StartCard icon={InfinityIcon} title="在画布中分步创作" body="支持多图、精修、模板，以及保持人物在各镜头中一致" note="开在大窗口里" onClick={onCanvas} testId="create-card-canvas" />
      {clips && onClips && <StartCard icon={Film} title="用已有片段合成视频" body="从作品库选择片段，添加字幕和配乐，在本机合成，不产生费用" onClick={onClips} testId="create-card-clips" />}
    </div>
  </div>
}

/**
 * 点了一个画布项目：名字、什么时候改过、「打开画布」。封面和「这个项目里做出来的」等画布的东西进了作品库（融合第 5 步）再加。
 * 项目名是画布那边写的，这里只当一行字显示。
 */
export function CanvasProjectPane({ project, opening, onOpen, now }: { project: CanvasProjectListEntry, opening: boolean, onOpen: () => void, now?: number }) {
  return <div className="chat-conversation create-pane" data-testid="create-canvas-pane">
    <header className="chat-bar"><strong title={project.name}>{project.name}</strong></header>
    <div className="create-canvas">
      <div className="create-canvas-card">
        <span className="create-canvas-icon" aria-hidden="true"><InfinityIcon size={30} /></span>
        <div className="create-canvas-copy">
          <strong data-testid="create-canvas-name">{project.name}</strong>
          <span data-testid="create-canvas-time">{project.updatedAt > 0 ? `画布项目 · ${createTimeText(project.updatedAt, now)} 修改` : '画布项目'}</span>
          <div className="create-canvas-actions"><Button variant="primary" icon={ArrowUpRight} loading={opening} onClick={onOpen} testId="create-canvas-open">打开画布</Button></div>
          <small>画布在独立窗口中打开，运行期间可返回此处继续其他操作。</small>
        </div>
      </div>
      <p className="create-quiet">重命名、复制、归档和删除请在画布窗口的「项目中心」中操作。</p>
    </div>
  </div>
}

/**
 * 只出现一次的提示。头一次看到起始页时定：以前做过东西的（升级上来的）说这一句；什么都没有的是新客户，
 * 不用知道以前是三页。两种都只定一次。后半句说做过的图和视频去哪看（融合第 3 步有了作品库以后加的）。
 */
export function CreateIntro({ state, ready, hasEarlierWork, onDecide, onDismiss }: { state: 'undecided' | 'shown' | 'gone', ready: boolean, hasEarlierWork: boolean, onDecide: (show: boolean) => void, onDismiss: () => void }) {
  useEffect(() => { if (state === 'undecided' && ready) onDecide(hasEarlierWork) }, [state, ready, hasEarlierWork])
  if (state !== 'shown') return null
  return <Notice tone="accent" title="聊天、画布和视频剪辑已合并至此页" body="历史对话、画布项目和视频草稿均已保留在左侧列表中。生成的图片和视频可在左下角「作品库」中查看。" onDismiss={onDismiss} testId="create-intro" />
}
