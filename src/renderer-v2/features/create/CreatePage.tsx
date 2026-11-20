import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Clapperboard, Infinity as InfinityIcon, Pencil, Trash2, type LucideIcon } from 'lucide-react'
import type { CanvasProjectListEntry, XingmangApi } from '../../../../electron/ipc-contract'
import { Button, Confirm, Dialog, Input, Notice, useToast } from '../../ui'
import { useLatestRequest } from '../../latest-request'
import { PageLoading } from '../app/PageLoading'
import { ChatPage, type ChatPageCreate, type ChatPageProps } from '../chat/ChatPage'
import type { ChatSite } from '../chat/state'
import { cleanVideoStudioItemName, maxVideoStudioItemNameLength, maxVideoStudioProjects, videoStudioItemName, type VideoStudioItem } from '../video-studio/library'
import { videoStudioDraftProgress } from '../video-studio/project'
import { useVideoStudioLibrary, useVideoStudioSession } from '../video-studio/useVideoStudioLibrary'
import type { VideoStudioAccess } from '../video-studio/VideoStudioPage'
import { createTimeText, type CreateExtraItem, type CreateExtraKind, type CreateSelection } from './list'
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
  /** 打开画布窗口（落在它的项目中心）。 */
  onOpenCanvas: () => void
  /** 把画布窗口开在这个项目上；开没开成都交回，这边好重读一遍项目。 */
  onOpenCanvasProject: (projectId: string) => Promise<void>
}

/**
 * 「创作」：聊天、画布、视频剪辑合成的一页（融合第 1 步，方案见 0.2.25 三块融合）。左边一列是做过的东西，
 * 对话、视频、画布项目排在一起；右边是点开的那一样。对话那一半还是 ChatPage，这里管视频和画布项目。
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

function CreateScope({ bridge, accountScope, active = true, site, videoAccess, openVideo, onVideoOpened, onOpenCanvas, onOpenCanvasProject, ...chat }: CreatePageProps) {
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
  const videos = videosListed ? library.items : noVideos
  // 列表的行是 memo 的：同一条视频、同一个项目没变时交出去的还是同一个对象。
  const rows = useRef({ videos: new WeakMap<VideoStudioItem, CreateExtraItem>(), projects: new WeakMap<CanvasProjectListEntry, CreateExtraItem>() })
  const items: CreateExtraItem[] = [
    ...videos.map((item) => cached<VideoStudioItem, CreateExtraItem>(rows.current.videos, item, () => ({ kind: 'video', id: item.id, title: videoStudioItemName(item), detail: videoStudioDraftProgress(item.project), updatedAt: item.updatedAt }))),
    ...canvas.projects.map((entry) => cached<CanvasProjectListEntry, CreateExtraItem>(rows.current.projects, entry, () => ({ kind: 'canvas', id: entry.id, title: entry.name, detail: '画布项目', updatedAt: entry.updatedAt }))),
  ]
  const stableItems = useStableList(items)

  const openItem = session.openId ? library.get(session.openId) : null
  const openName = openItem ? videoStudioItemName(openItem) : ''
  const videoShown = selected?.kind === 'video' && selected.id === session.openId && Boolean(openItem)
  const project = selected?.kind === 'canvas' ? canvas.projects.find((entry) => entry.id === selected.id) ?? null : null
  // 开着的那一条视频手上有事（写分镜、出片、画图、拼片）时不换别的：出好的东西要挂回它身上。
  const sayBusy = () => toast.show(`「${openName}」还有事在做（写分镜、生成或拼片），等它停下再打开别的视频。`, 'warn')
  const showVideo = (id: string) => {
    const result = session.open(id)
    if (result === 'busy') sayBusy()
    if (result === 'opened') setSelected({ kind: 'video', id })
  }
  const startVideo = () => {
    const started = session.start()
    if (started === 'busy') sayBusy()
    else if (started === 'full') toast.show(`视频最多存 ${maxVideoStudioProjects} 条，先删掉几条不要的再新建。`, 'warn')
    else setSelected({ kind: 'video', id: started.id })
  }
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

  const pane = <>
    {openItem && <div className="chat-conversation create-pane" hidden={!videoShown} data-testid="create-video-pane">
      <header className="chat-bar"><strong title={openName} data-testid="create-video-name">{openName}</strong><div className="chat-bar-actions">
        <Button icon={Pencil} variant="ghost" size="sm" aria-label="改名" title="改名" onClick={() => startRename(openItem.id)} testId="create-video-rename" />
        <Button icon={Trash2} variant="ghost" size="sm" aria-label="删掉这一条" title="删掉这一条" disabled={session.busy} onClick={() => setRemoving(openItem.id)} testId="create-video-remove" />
      </div></header>
      <div className="create-studio"><Suspense fallback={<PageLoading />}>
        <VideoStudioPage key={openItem.id} bridge={bridge} accountScope={accountScope} site={site} access={videoAccess} active={active && videoShown}
          source={library.source(openItem.id)} onBusyChange={session.setBusy} onOpenAccount={chat.onOpenAccount} />
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
      open: (item) => { if (item.kind === 'video') showVideo(item.id); else setSelected({ kind: 'canvas', id: item.id }) },
      leave: () => setSelected(null),
      renameVideo: startRename,
      removeVideo: setRemoving,
      openCanvas: openCanvasProject,
    },
    pane,
    cards: <CreateStartCards video={videoAccess === 'ready'} onVideo={startVideo} onCanvas={onOpenCanvas} />,
    intro: (conversationCount) => <CreateIntro state={intro} ready={active && library.status !== 'loading' && canvas.status !== 'loading'}
      hasEarlierWork={conversationCount > 0 || library.items.length > 0 || canvas.projects.length > 0}
      onDecide={(show) => { rememberIntroSeen(); setIntro(show ? 'shown' : 'gone') }} onDismiss={() => setIntro('gone')} />,
    notes: [...(videosListed && library.status === 'unreadable' ? ['以前的视频暂时读不出来'] : []), ...(canvas.status === 'unreadable' ? ['画布项目暂时读不出来'] : [])],
  }

  return <>
    <ChatPage {...chat} bridge={bridge} accountScope={accountScope} active={active} create={create} />
    {active && renaming && <Dialog open title="给这条视频改个名" width={480} onClose={() => setRenaming(null)} dirty={renameReady} testId="create-video-rename-dialog"
      footer={<><Button onClick={() => setRenaming(null)}>取消</Button><Button variant="primary" disabled={!renameReady} onClick={saveRename} testId="create-video-rename-save">保存</Button></>}>
      <Input aria-label="视频名字" value={renaming.text} onChange={(event) => setRenaming({ ...renaming, text: event.target.value })}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); saveRename() } }} maxLength={maxVideoStudioItemNameLength} autoFocus testId="create-video-rename-input" />
    </Dialog>}
    {active && removingItem && <Confirm testId="create-video-remove-confirm" title={`删掉「${videoStudioItemName(removingItem)}」？`}
      body={<p>分镜和设置会删掉。已经生成的片段和成片还在作品库里，不会删。</p>} okLabel="删掉" danger onOk={removeVideo} onClose={() => setRemoving(null)} />}
  </>
}

const noVideos: readonly VideoStudioItem[] = []

function cached<Key extends object, Value>(cache: WeakMap<Key, Value>, key: Key, build: () => Value): Value {
  const known = cache.get(key)
  if (known) return known
  const value = build()
  cache.set(key, value)
  return value
}

/** 每一项都没变就交回上一次那个数组：对话页拿它做 useMemo 的依赖，回复一段段到的时候不用重排这一列。 */
function useStableList<Item>(next: Item[]): Item[] {
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
 * 起始页六句示例下面的卡：一句话说不清的两样从这里进。第三张「把现成的片段拼成一条」等主窗口有了作品库（融合第 3 步）再加。
 * video：这个账号现在能不能新做视频（历史账号、临时停用时不出第一张）。
 */
export function CreateStartCards({ video, onVideo, onCanvas }: { video: boolean, onVideo: () => void, onCanvas: () => void }) {
  return <div className="create-start" data-testid="create-start">
    <div className="create-start-label">一句话说不清的，从这里开始</div>
    <div className="create-cards">
      {video && <StartCard icon={Clapperboard} title="做一条带字幕的短视频" body="写一句想法，AI 写分镜、一段一段出，再拼成一条" onClick={onVideo} testId="create-card-video" />}
      <StartCard icon={InfinityIcon} title="在画布上一步步做" body="多张图、精修、套模板，人物每一镜都长得一样也在这里" note="开在大窗口里" onClick={onCanvas} testId="create-card-canvas" />
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
          <span data-testid="create-canvas-time">{project.updatedAt > 0 ? `画布项目 · ${createTimeText(project.updatedAt, now)} 改过` : '画布项目'}</span>
          <div className="create-canvas-actions"><Button variant="primary" icon={ArrowUpRight} loading={opening} onClick={onOpen} testId="create-canvas-open">打开画布</Button></div>
          <small>画布开在一个大窗口里，可以一边让它跑，一边回这里做别的。</small>
        </div>
      </div>
      <p className="create-quiet">改名、复制、归档、删除在画布窗口的「项目中心」里做。</p>
    </div>
  </div>
}

/**
 * 只出现一次的提示。头一次看到起始页时定：以前做过东西的（升级上来的）说这一句；什么都没有的是新客户，
 * 不用知道以前是三页。两种都只定一次。「做过的图和视频在左下角作品库」那半句等有了作品库（融合第 3 步）再加。
 */
export function CreateIntro({ state, ready, hasEarlierWork, onDecide, onDismiss }: { state: 'undecided' | 'shown' | 'gone', ready: boolean, hasEarlierWork: boolean, onDecide: (show: boolean) => void, onDismiss: () => void }) {
  useEffect(() => { if (state === 'undecided' && ready) onDecide(hasEarlierWork) }, [state, ready, hasEarlierWork])
  if (state !== 'shown') return null
  return <Notice tone="accent" title="聊天、画布、视频剪辑合到这一页了" body="以前的对话、画布项目、视频草稿都在左边这一列，一个没少。" onDismiss={onDismiss} testId="create-intro" />
}
