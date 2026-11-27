import { Fragment, isValidElement, memo, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { ArrowUp, ArrowUpRight, Brush, Check, ChevronDown, Clapperboard, Copy, Download, FileText, Image as ImageIcon, ImagePlus, Images, Infinity as InfinityIcon, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Plus, RefreshCw, SlidersHorizontal, Square, Trash2, X, Paperclip, Bookmark, type LucideIcon } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AiChatAsset, AiChatTextFile, XingmangApi } from '../../../../electron/ipc-contract'
import { AI_CHAT_TEXT_FILE_LIMITS } from '../../../../electron/ai-chat-protocol'
import { missingAiAssetMessages } from '../../../../electron/ai-asset-missing'
import { formatDownloadBytes } from '../../registry/business'
import { BrandIcon, Button, Chips, ChoiceMenu, Confirm, Dialog, Input, Logo, Menu, Pill, SearchInput, Segment, Textarea, useToast } from '../../ui'
import { useBackgroundWork } from '../../background-work'
import { useChatImageWork } from '../../chat-image-work'
import { useLatestRequest } from '../../latest-request'
import { failureWithDetail } from '../../business-common'
import { exportFailureSentence } from '../../operation-error'
import { PageLoading } from '../app/PageLoading'
import { canEditImages, canReadImages, canStartVideoFromImage, chatLimits, createChatApi, inspectModel, noImageEditModelMessage, type ChatApi } from './api'
import { buildChatCatalog, chatAssetSaveErrorMessage, chatCutOffNotice, chatErrorAction, chatExampleDraft, chatExamples, chatErrorMessage, chatModelVendor, chatModelVendors, draftLengthError, filterConversations, groupConversationList, isConversationTooLongMessage, MAX_CONVERSATION_TITLE_LENGTH, isGenerating, isGeneratingImage, isGeneratingReply, isGeneratingVideo, noImageModelMessage, offlineSendMessage, pendingChatGroups, pickChatGroup, shouldPasteScreenshot, shouldSendOnEnter, shouldShowLengthNotice, type ChatMessage, type ChatMode, type ChatVideoAspect, type ChatWorkspace, type Conversation, chatVideoAspect, modeFilesMessage, noVideoStartImageMessage, offlineReplyNotice, shouldShowOfflineReplyNotice, draftWithPhrase, videoPromptLengthError, videoStartImageLimitMessage } from './state'
import { ChatImage } from './ChatImage'
import { ImageOptionMenus } from './ImageOptions'
import { ChatVideoClip, ChatVideoPending, type ChatVideoFilm } from './ChatVideo'
import { chatVideoMade, chatVideoSecondsChoices, chatVideoSecondsFor, chatVideoSource, type ChatVideoMade, type ChatVideoProgress } from './video'
import { ParametersDialog } from './ParametersDialog'
import { PhrasesDialog } from './PhrasesDialog'
import { useChatController } from './useChatController'
import { useOnlineStatus } from '../shell/useOnlineStatus'
import { inspectChatLink, plainText } from './links'
import { prepareChatMath, readChatMath, renderChatMath, type ChatMath } from './math'
import { conversationExport, loadChatHistory, mergeSessionIntoHistory, type LoadedChatHistory } from './storage'
import { videoStudioAspectNames, videoStudioUnconfirmedWarning, type VideoStudioClipSource } from '../video-studio/project'
import { videoStudioAspects } from '../video-studio/timeline'
import { videoStudioErrorMessage } from '../video-studio/useVideoStudio'
import { createFilterOptions, filterCreateExtras, groupCreateList, resolveCreateFilter, type CreateExtraItem, type CreateExtraKind, type CreateFilter, type CreateKind, type CreateSelection } from '../create/list'
import { AddToCanvasMenu, type CanvasIntakeProject } from '../create/canvas-intake'
import { ImageUpscaleMenu, useImageUpscale, type ImageUpscaleControl, type ImageUpscaleScale } from '../create/image-upscale'
import './chat.css'

const remarkPlugins = [remarkGfm]
// 点了只填进输入框，不直接发：发一句就要花钱，得让人看一眼再发。

export interface ChatPageProps {
  bridge: XingmangApi
  accountScope: string
  active?: boolean
  onOpenAccount?: (tab: 'recharge' | 'keys') => void
  /** 顶部搜索的「聊天参数设置」：为 true 时打开参数对话框，打开后调 onParametersOpened 把它放下。 */
  openParameters?: boolean
  onParametersOpened?: () => void
  /** 「创作」页（features/create）加进这一页的东西：左边那一列里的视频和画布项目、右边换上去的那一块、起始页上的卡。 */
  create?: ChatPageCreate
}

/**
 * 融合第 1 步：这一页就是「创作」。对话的那一半照旧在这里；视频和画布项目由 CreatePage 给，这里只管把它们
 * 跟对话排进同一列、把右边让出来。
 */
export interface ChatPageCreate {
  /** 对话以外的行，按最后动过的时间跟对话混排。 */
  items: readonly CreateExtraItem[]
  /** 这个账号有的那几类（没有出视频这一项的账号不给「视频」）。 */
  kinds: readonly CreateExtraKind[]
  /** 右边开着的是对话以外的哪一行；null = 右边是对话或起始页。 */
  selected: CreateSelection | null
  /** 这一条视频手上有事在做，先不让删。 */
  lockedVideoId: string | null
  actions: ChatPageCreateActions
  /** 右边那一块。selected 不是 null 时摆它，对话那一块只藏不卸（回复照收）。 */
  pane: ReactNode
  /** 起始页六句示例下面的那几张卡。 */
  cards?: ReactNode
  /** 起始页最上面那条只出现一次的提示；拿到现在存着几段对话。 */
  intro?: (conversationCount: number) => ReactNode
  /** 列表最下面的小字：哪一类这一次没读出来；给了 retry 的后面跟一个「重新读取」。 */
  notes?: readonly ChatPageNote[]
  /** 输入框的第三档「生成视频」（融合第 2 步）。不给就没有这一档。 */
  video?: ChatPageVideo
  /** 生成的图下面的「添加到画布」（融合第 5 步）。不给就没有这个按钮。 */
  canvas?: ChatPageCanvas
  /** 左下角的「作品库」和右边换上去的那一块（融合第 3 步）。不给就没有。 */
  library?: ChatPageLibrary
}
export interface ChatPageNote {
  text: string
  /** 给了就在小字后面放一个「重新读取」：不然这一类要等换账号或重开软件才会再读（同对话红条上那个）。 */
  retry?: () => void
}
/** 主窗口的作品库：这一页只管左下角那一行和把右边让出来，里面的东西由「创作」页给。 */
export interface ChatPageLibrary {
  /** 右边现在摆的是不是作品库。 */
  open: boolean
  /** 一共多少件；还没读到是 null。没读到、一件都没有时不写数。 */
  count: number | null
  onOpen: () => void
  /** 对话里刚出完东西：再数一遍。 */
  refresh: () => void
  /** 右边那一块，和从别处叫出来的选择框。要用对话这边的东西（有哪些对话、怎么把一张图放进输入框），所以由这一页来摆。 */
  render: (context: ChatLibraryContext) => ReactNode
}
export interface ChatLibraryContext {
  conversations: readonly Conversation[]
  /** 回到这段对话。 */
  openConversation: (id: string) => void
  /** 把这张图放进输入框接着改；回到对话这边。当前对话正在生成就放进一段新的。 */
  reuseImage: (asset: AiChatAsset) => void
  /** 把这张图当开头图、换到「生成视频」；prompt 是当初那句描述。 */
  animateImage: (asset: AiChatAsset, prompt: string) => void
  /** 这个账号现在能不能出视频。 */
  canAnimate: boolean
  /** 「变清晰」：对话里的图和作品库里点开的图共用一份，哪张正在做两边看到的一样。 */
  upscale: ImageUpscaleControl
}
/** 「生成视频」那一档要「创作」页给的东西：这个账号用不用得了、价目和余额、做过的视频。 */
export interface ChatPageVideo {
  /** ready 能用；unsupported 这个账号没有出视频这一项；suspended 远程暂时停用。后两种那一档灰着，悬停说原因。 */
  access: 'ready' | 'unsupported' | 'suspended'
  /** 确认框里那句「预计约 $x（估算）」；没有按次的价是 null，不编一个数。 */
  quote: (model: string, group: string) => string | null
  /** 打开确认框时再读一次价目（放久了的换新）。 */
  refreshPrices: () => void
  /** 确认框里「当前余额」后面的数（带 $）；读不到是 null，不写那一句。 */
  balance: string | null
  /** 「添加到视频」菜单里列的视频，新的在前。 */
  films: readonly ChatVideoFilm[]
  /** 把这一段接到这条视频的最后（null 是新建一条）。成了交回那条视频；没成交回一句能上屏的原因。 */
  addClip: (filmId: string | null, source: VideoStudioClipSource, made: ChatVideoMade) => { id: string; title: string } | { error: string }
  openFilm: (id: string) => void
}
export type { ChatVideoMade }
/** 「添加到画布」要「创作」页给的东西：有哪些画布项目，和把一张图抄进去的那一下（结果由它用右下角的提示说）。 */
export interface ChatPageCanvas {
  /** 菜单里列的画布项目，最近改过的在前。 */
  projects: readonly CanvasIntakeProject[]
  /** 把这张图抄一份进这个画布项目的素材库；projectId 是 null 就新建一个，名字取 description 开头的几个字。 */
  addImage: (projectId: string | null, assetId: string, description: string) => void
}
export interface ChatPageCreateActions {
  open: (item: CreateExtraItem) => void
  /** 回到对话这边：点了一段对话，或点了「新建」。 */
  leave: () => void
  renameVideo: (id: string) => void
  removeVideo: (id: string) => void
  openCanvas: (id: string) => void
}
// video：发一段视频之前先问的那一句（每次都问：一段单独计费）。
type Confirmation = { kind: 'retry' | 'delete-message' | 'delete-conversation' | 'clear' | 'clear-all' | 'stop' | 'video'; id?: string; mayStillComplete?: boolean } | null

export function ChatPage({ bridge, accountScope, active = true, onOpenAccount, openParameters, onParametersOpened, create }: ChatPageProps) {
  const api = useMemo(() => createChatApi(bridge), [bridge])
  return <ChatScope key={accountScope} api={api} scope={accountScope} active={active} onOpenAccount={onOpenAccount} openParameters={openParameters} onParametersOpened={onParametersOpened} create={create} />
}

interface ChatScopeProps { api: ChatApi; scope: string; active: boolean; onOpenAccount?: ChatPageProps['onOpenAccount']; openParameters?: boolean; onParametersOpened?: () => void; create?: ChatPageCreate }

// History lives in files read through the main process, so it arrives
// asynchronously. The page waits for it instead of starting empty: an early
// autosave or keystroke must never race the record it is about to replace.
function ChatScope(props: ChatScopeProps) {
  const [history, setHistory] = useState<{ loaded: LoadedChatHistory; generation: number } | null>(null)
  useEffect(() => {
    let current = true
    void loadChatHistory(props.api, window.localStorage, props.scope).then((loaded) => { if (current) setHistory({ loaded, generation: 0 }) })
    return () => { current = false }
  }, [props.api, props.scope])
  // While the old record cannot be read, nothing is written to it. Reading it again only swaps in a new view
  // once it reads cleanly, carrying over what was said meanwhile; a reply still arriving would be cut off, so
  // the swap waits until nothing is generating. A read that still fails hands its reason back to be said again.
  const reload = async (session: () => ChatWorkspace): Promise<string | undefined> => {
    const loaded = await loadChatHistory(props.api, window.localStorage, props.scope)
    if (loaded.warning) return loaded.warning
    const latest = session()
    if (latest.conversations.some(isGenerating) || isGenerating(latest.draftConversation)) return
    setHistory((previous) => ({ loaded: { ...loaded, state: mergeSessionIntoHistory(loaded.state, latest) }, generation: (previous?.generation ?? 0) + 1 }))
  }
  if (!history) return <section className="chat-page" hidden={!props.active} data-testid="page-chat" data-page-id="ai-chat" data-account-scope={props.scope} data-loading="true" aria-busy="true"><PageLoading /></section>
  return <ChatView key={history.generation} {...props} history={history.loaded} onReloadHistory={reload} />
}

function ChatView({ api, scope, active, onOpenAccount, openParameters, onParametersOpened, create, history, onReloadHistory }: ChatScopeProps & { history: LoadedChatHistory; onReloadHistory: (session: () => ChatWorkspace) => Promise<string | undefined> }) {
  const chat = useChatController(api, scope, history, active)
  const toast = useToast()
  const { offline } = useOnlineStatus()
  const { conversation, preparations } = chat
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<CreateFilter>('all')
  const [confirmationState, setConfirmation] = useState<Confirmation>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)
  const [copyFallback, setCopyFallback] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ asset: AiChatAsset; mine: boolean } | null>(null)
  const [stopping, setStopping] = useState(false)
  const [customSize, setCustomSize] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [parametersOpen, setParametersOpen] = useState(false)
  const [phrasesOpen, setPhrasesOpen] = useState(false)
  const composing = useRef(false)
  const latestState = useRef(chat.state)
  latestState.current = chat.state
  const surface = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const navigationScroll = useRef(0)
  const lastDisplayedConversation = useRef<string | null>(null)
  const scrolls = useRef(new Map<string, number>())
  const stickToBottom = useRef(true)
  const owner = useLatestRequest()
  // 清晰版存进作品库：左下角那个数和开着的作品库跟着再数一遍。
  const upscale = useImageUpscale(api.upscaleAsset, () => create?.library?.refresh())
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      if (list.current) {
        const following = lastDisplayedConversation.current === conversation.id && stickToBottom.current
        // 起始页（还没有消息）从头看起：窗口矮、放不下时先看到「今天想创作什么？」，不是两张卡的下半截。发了第一句照旧跟到底。
        list.current.scrollTop = !conversation.messages.length ? 0 : following ? list.current.scrollHeight : scrolls.current.get(conversation.id) ?? list.current.scrollHeight
        stickToBottom.current = !conversation.messages.length || list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80
        lastDisplayedConversation.current = conversation.id
      }
      const navigation = surface.current?.querySelector<HTMLElement>('.chat-conversation-list')
      if (navigation) navigation.scrollTop = navigationScroll.current
    })
    return () => cancelAnimationFrame(frame)
  }, [conversation.id, active])
  useEffect(() => { if (active && stickToBottom.current && list.current) list.current.scrollTop = conversation.messages.length ? list.current.scrollHeight : 0 }, [conversation.messages, active])
  useEffect(() => { setCustomSize(false); setEditing(null); setConfirmation(null); setParametersOpen(false); setPhrasesOpen(false) }, [conversation.id])
  // 参数对话框跟着页面走：切走就关掉（没应用的改动不留），跟原来的弹出层一样。
  useEffect(() => { if (!active) { setParametersOpen(false); setPhrasesOpen(false) } }, [active])
  useEffect(() => { if (active && openParameters) { setParametersOpen(true); onParametersOpened?.() } }, [active, openParameters])
  const pending = isGenerating(conversation)
  const activeRequest = conversation.messages.find((message) => message.status === 'pending' || message.status === 'streaming')
  const preparation = preparations[conversation.settings.group]
  // 菜单里列的是全部分组的模型（yoyo 10-25：只选厂商和模型），选了哪个就用有它的分组计费。
  const catalog = useMemo(() => buildChatCatalog(chat.groups, preparations, conversation.settings.mode), [chat.groups, preparations, conversation.settings.mode])
  const models = catalog.map((entry) => entry.model)
  const pendingGroups = pendingChatGroups(chat.groups, preparations)
  const preparing = chat.groups.some((group) => preparations[group.name]?.phase === 'loading')
  const failedGroups = chat.groups.filter((group) => preparations[group.name]?.phase === 'error')
  const allGroupsFailed = chat.groups.length > 0 && failedGroups.length === chat.groups.length
  const preparationWarning = chat.groups.map((group) => preparations[group.name]?.warning).find(Boolean)
  const capability = conversation.settings.model ? inspectModel(conversation.settings.model) : null
  const imageCapability = capability?.kind === 'image' ? capability : null
  const draftImages = conversation.draftImages ?? []
  const draftFiles = conversation.draftFiles ?? []
  const textMode = conversation.settings.mode === 'text'
  const videoMode = conversation.settings.mode === 'video'
  // 「生成视频」那一档（融合第 2 步）：「创作」页给了、这个账号用得了才能发。
  const videoFeature = create?.video
  const videoReady = videoFeature?.access === 'ready' && Boolean(api.video)
  const videoAspect = chatVideoAspect(conversation.settings)
  const videoSeconds = chatVideoSecondsFor(conversation.settings)
  // 切到「生成视频」那一档就把价目读好，确认框打开时已经在手上（放久了的，打开确认框时再读一次）。
  const refreshVideoPrices = videoFeature?.refreshPrices
  useEffect(() => { if (active && videoMode && videoReady) refreshVideoPrices?.() }, [active, videoMode, videoReady, refreshVideoPrices])
  // 文件只在聊天时带；换到「生成图片」「生成视频」时卡片还留着，说清要先去掉，发送按钮灰着。
  const filesBlocked = draftFiles.length > 0 && !textMode
  const filesFull = draftFiles.length >= AI_CHAT_TEXT_FILE_LIMITS.filesPerMessage
  // 聊天时带的图给模型看；生成图片时带的是参考图，照着它改（要模型能改图）；生成视频时带的是开头图，只收一张。
  const seesImages = Boolean(conversation.settings.model) && (textMode ? canReadImages(conversation.settings.model) : videoMode ? canStartVideoFromImage(conversation.settings.model) : canEditImages(conversation.settings.model))
  const imageLimit = videoMode ? 1 : chatLimits.imagesPerMessage
  const imagesBlocked = draftImages.length > 0 && (!seesImages || draftImages.length > imageLimit)
  const imagesBlockedMessage = textMode ? noImageModelMessage : videoMode ? seesImages ? videoStartImageLimitMessage : noVideoStartImageMessage : noImageEditModelMessage
  const attachTitle = videoMode ? '添加开头图' : !seesImages ? textMode ? '当前模型不支持识别图片，请更换支持图片的模型后发送' : '当前模型不支持图片编辑，请更换支持图片编辑的模型后再添加图片' : draftImages.length >= chatLimits.imagesPerMessage ? `每条消息最多附带 ${chatLimits.imagesPerMessage} 张图片` : textMode ? '添加图片（也可直接粘贴截图）' : '添加参考图（也可直接粘贴截图）'
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!shouldPasteScreenshot(event.clipboardData)) return
    // 截图只在主进程从剪贴板里读，这里只负责拦下默认粘贴。
    event.preventDefault()
    if (pending) return
    if (!seesImages) { chat.setError(imagesBlockedMessage); return }
    void chat.pasteImage()
  }
  const candidates = useMemo(() => active ? filterConversations(chat.state.conversations, search) : [], [active, chat.state.conversations, search])
  // 左边那一列：对话、视频、画布项目排在一起（融合第 1 步）。没有 create 时就只有对话。
  const extraKinds = create?.kinds ?? noExtraKinds
  const extraItems = create?.items ?? noExtraItems
  const filter = resolveCreateFilter(kind, extraKinds)
  const filterOptions = useMemo(() => createFilterOptions(extraKinds).map((option) => ({ ...option, testId: `create-filter-${option.value}` })), [extraKinds])
  const extraCandidates = useMemo(() => active ? filterCreateExtras(extraItems, search) : [], [active, extraItems, search])
  const listGroups = useMemo(() => groupCreateList(candidates, extraCandidates, filter), [candidates, extraCandidates, filter])
  const extraSelected = create?.selected ?? null
  // 右边摆着作品库（融合第 3 步）：同点了一条视频，对话那一块只藏不卸。
  const library = create?.library
  const paneCovered = Boolean(extraSelected) || Boolean(library?.open)
  // 列表最下面的小字：哪一类这一次没读出来。对话读不出来、列表里又有视频或画布项目时也说在这里（一行都没有时照旧说在空状态里）。
  const listNotes: ChatPageNote[] = [...(chat.historyUnreadable && listGroups.length > 0 && filter !== 'video' && filter !== 'canvas' ? [{ text: unreadableHistoryNote }] : []), ...(create?.notes ?? [])]
  const task = async (work: () => Promise<unknown>, done: string) => {
    const ticket = owner.capture()
    try { await work(); if (ticket()) chat.setNotice(done) }
    catch (reason) { if (ticket()) chat.setError(chatErrorMessage(reason)) }
  }
  const copyText = async (text: string, done = '已复制') => {
    const ticket = owner.capture()
    try { await api.copyText(text); if (ticket()) toast.show(done, 'ok') }
    catch { if (ticket()) setCopyFallback(text) }
  }
  const copyCode = async (text: string) => {
    const ticket = owner.capture()
    try { await api.copyText(text); if (ticket()) toast.show('代码已复制', 'ok'); return true }
    catch { if (ticket()) setCopyFallback(text); return false }
  }
  const copyCodeRef = useRef(copyCode)
  copyCodeRef.current = copyCode
  const copyLink = async (url: string) => {
    const ticket = owner.capture()
    try { await api.copyText(url); if (ticket()) toast.show('网址已复制，粘贴到浏览器地址栏即可打开', 'ok') }
    catch { if (ticket()) setCopyFallback(url) }
  }
  const copyLinkRef = useRef(copyLink)
  copyLinkRef.current = copyLink
  // react-markdown treats each renderer as a component type, so a new function
  // every render would remount the code blocks and drop their 已复制 state.
  const markdownComponents = useMemo<Components>(() => ({ a: ({ href, children }) => <ChatLinkText href={href} onCopy={(url) => void copyLinkRef.current(url)}>{children}</ChatLinkText>, img: ({ alt }) => <span>{alt ?? '图片链接'}</span>, pre: ({ children }) => <CodeBlock onCopy={(text) => copyCodeRef.current(text)}>{children}</CodeBlock> }), [])
  // Only replies get formulas: what the user typed shows exactly as typed.
  const replyComponents = useMemo<Components>(() => ({ ...markdownComponents, code: ({ children, className }) => { const math = readChatMath(children); return math ? <ChatFormula math={math} /> : <code className={className}>{children}</code> } }), [markdownComponents])
  const saveAsset = async (assetId: string) => {
    const ticket = owner.capture()
    try { const result = await api.saveAsset(assetId); if (ticket() && result.saved) chat.setNotice('图片已保存') }
    catch (reason) { if (ticket()) chat.setError(chatAssetSaveErrorMessage(reason)) }
  }
  // Rows are memoized, so they get one stable object that always calls the
  // latest handlers instead of fresh closures that would re-render all of them.
  const latestMessageActions = useRef<MessageActions | null>(null)
  const focusComposer = () => requestAnimationFrame(() => surface.current?.querySelector<HTMLTextAreaElement>('#chatIn')?.focus())
  // 「用此图生成视频」：这张图当开头图，当初让它画这张图的那句话填回输入框（方案 2.5）。
  const animateImage = (messageId: string, asset: AiChatAsset) => {
    const index = conversation.messages.findIndex((message) => message.id === messageId)
    const asked = conversation.messages.slice(0, Math.max(index, 0)).reverse().find((message) => message.role === 'user')
    chat.animateImage(asset, asked?.content ?? '')
    focusComposer()
  }
  // 「添加到画布」：新建项目时拿当初让它画这张图的那句话起名。
  const addToCanvas = (messageId: string, assetId: string, projectId: string | null) => {
    const index = conversation.messages.findIndex((message) => message.id === messageId)
    const asked = conversation.messages.slice(0, Math.max(index, 0)).reverse().find((message) => message.role === 'user')
    create?.canvas?.addImage(projectId, assetId, asked?.content ?? '')
  }
  // 「变清晰」：生成的图，清晰版在作品库里沿用它的描述（改写过的那句，没有就用当初让它画的那句）；客户自己发的图没有描述。
  const upscaleAsset = (messageId: string, assetId: string, scale: ImageUpscaleScale) => {
    const index = conversation.messages.findIndex((message) => message.id === messageId)
    const message = conversation.messages[index]
    if (message?.role !== 'assistant') { upscale.run(assetId, scale); return }
    const asked = conversation.messages.slice(0, Math.max(index, 0)).reverse().find((candidate) => candidate.role === 'user')
    upscale.run(assetId, scale, message.assets?.find((asset) => asset.assetId === assetId)?.revisedPrompt || asked?.content)
  }
  // 另存时保存框里默认用那句描述开头的几个字当文件名（主进程洗成干净的文件名），没有描述就用作品库原来的名字。
  const saveVideo = async (messageId: string) => {
    const source = chatVideoSource(conversation, messageId)
    if (!source || !api.video) return
    const ticket = owner.capture()
    try { const result = await api.video.save(source.clip.assetId, source.prompt.trim().slice(0, 40) || undefined); if (ticket() && result.saved) chat.setNotice('视频已保存') }
    catch (reason) { if (ticket()) chat.setError(videoStudioErrorMessage(reason, '保存失败，请更换位置后重试')) }
  }
  const openVideo = async (assetId: string) => {
    const ticket = owner.capture()
    try { await api.video?.open(assetId) } catch (reason) { if (ticket()) chat.setError(videoStudioErrorMessage(reason, '视频打开失败，请稍后重试')) }
  }
  // 「添加到视频」：接到选的那条视频最后一个镜头（或新建一条），不用再生成。
  const composeVideo = (messageId: string, filmId: string | null) => {
    const source = chatVideoSource(conversation, messageId)
    if (!videoFeature || !source) return
    const settings = conversation.messages.find((message) => message.id === messageId)?.settings ?? conversation.settings
    const result = videoFeature.addClip(filmId, source, chatVideoMade(settings, source.clip))
    if ('error' in result) { toast.show(result.error, 'warn'); return }
    toast.show(`已添加为「${result.title}」的最后一个镜头`, 'ok', { label: '查看', onSelect: (dismiss) => { dismiss(); videoFeature.openFilm(result.id) } })
  }
  // 重新生成一条视频回复也要报价：打开确认框时把价目读新。
  const confirmFromMessage = (value: NonNullable<Confirmation>) => {
    if (value.kind === 'retry' && conversation.messages.find((message) => message.id === value.id)?.video) videoFeature?.refreshPrices()
    setConfirmation(value)
  }
  latestMessageActions.current = { copyText: (text, done) => void copyText(text, done), preview: (asset, mine) => setPreview({ asset, mine }), reuseImage: (asset) => void chat.reuseImage(asset), animateImage, addToCanvas, copyAsset: (assetId) => void task(() => api.copyAsset(assetId), '图片已复制'), saveAsset: (assetId) => void saveAsset(assetId), upscaleAsset, assetMenu: (assetId) => void task(() => api.assetMenu(assetId), ''), stopVideo: () => void stop(), saveVideo: (messageId) => void saveVideo(messageId), openVideo: (assetId) => void openVideo(assetId), composeVideo, confirm: confirmFromMessage, edit: setEditing, openAccount: (tab) => onOpenAccount?.(tab) }
  const messageActions = useMemo<MessageActions>(() => ({ copyText: (text, done) => latestMessageActions.current?.copyText(text, done), preview: (asset, mine) => latestMessageActions.current?.preview(asset, mine), reuseImage: (asset) => latestMessageActions.current?.reuseImage(asset), animateImage: (messageId, asset) => latestMessageActions.current?.animateImage(messageId, asset), addToCanvas: (messageId, assetId, projectId) => latestMessageActions.current?.addToCanvas(messageId, assetId, projectId), copyAsset: (assetId) => latestMessageActions.current?.copyAsset(assetId), saveAsset: (assetId) => latestMessageActions.current?.saveAsset(assetId), upscaleAsset: (messageId, assetId, scale) => latestMessageActions.current?.upscaleAsset(messageId, assetId, scale), assetMenu: (assetId) => latestMessageActions.current?.assetMenu(assetId), stopVideo: () => latestMessageActions.current?.stopVideo(), saveVideo: (messageId) => latestMessageActions.current?.saveVideo(messageId), openVideo: (assetId) => latestMessageActions.current?.openVideo(assetId), composeVideo: (messageId, filmId) => latestMessageActions.current?.composeVideo(messageId, filmId), confirm: (value) => latestMessageActions.current?.confirm(value), edit: (value) => latestMessageActions.current?.edit(value), openAccount: (tab) => latestMessageActions.current?.openAccount(tab) }), [])
  const exportConversation = async (id: string) => {
    const item = chat.state.conversations.find((candidate) => candidate.id === id)
    if (!item) return
    const ticket = owner.capture()
    try {
      const result = await api.exportText(conversationExport(item))
      if (ticket() && result) chat.setNotice('这段对话已存成文本文件')
    } catch (cause) {
      // 没权限、盘满了跟设置页导出同一套说法（D16）；认不出原因的照旧说可以重试。
      if (ticket()) chat.setError(exportFailureSentence(failureWithDetail(cause)) ?? '对话导出失败，请重试')
    }
  }
  const stop = async () => { const ticket = owner.capture(); setStopping(true); await chat.stop(); if (ticket()) setStopping(false) }
  const reloadHistory = async () => {
    const ticket = owner.capture()
    setReloading(true)
    try {
      const warning = await onReloadHistory(() => latestState.current)
      // 还是读不出来时红条原样不变，转一下圈就停，客户分不清读过没有：把读不出来的原因再说一遍。
      if (warning && ticket()) toast.show(warning, 'warn')
    } finally { if (ticket()) setReloading(false) }
  }
  const fillExample = (example: string) => {
    const text = chatExampleDraft(example)
    chat.setDraft(text)
    const input = surface.current?.querySelector<HTMLTextAreaElement>('#chatIn')
    input?.focus()
    requestAnimationFrame(() => input?.setSelectionRange(text.length, text.length))
  }
  const fillPhrase = (phrase: string) => {
    const text = draftWithPhrase(conversation.draft, phrase)
    setPhrasesOpen(false)
    chat.setDraft(text)
    // 弹窗关掉时会把焦点还给「常用」按钮：等它关完再把光标放进输入框末尾，客户接着打字。
    requestAnimationFrame(() => {
      const input = surface.current?.querySelector<HTMLTextAreaElement>('#chatIn')
      input?.focus()
      input?.setSelectionRange(text.length, text.length)
    })
  }
  const confirmAction = () => {
    const action = confirmation
    setConfirmation(null)
    if (!action) return
    if (action.kind === 'retry' && action.id) void chat.send({ retryId: action.id })
    if (action.kind === 'video') void chat.send()
    if (action.kind === 'delete-message' && action.id) chat.deleteFrom(action.id)
    if (action.kind === 'delete-conversation' && action.id) chat.removeConversation(action.id)
    if (action.kind === 'clear') chat.clearConversation()
    if (action.kind === 'clear-all' && chat.clearAllConversations()) toast.show('对话已清空', 'ok')
    if (action.kind === 'stop') void stop()
  }
  const switchConversation = (id: string) => { if (list.current) scrolls.current.set(conversation.id, list.current.scrollTop); chat.openConversation(id); create?.actions.leave() }
  const startNew = () => { chat.newConversation(); create?.actions.leave() }
  // 起始页：还没发过话、也没自己起过名的那一段。顶上写「新建」，发了第一句才换成对话的名字。
  const startPage = !chat.state.activeId || (!conversation.messages.length && !conversation.renamed)
  // 对话列表的行也是 memo 的，同样只拿一个稳定的对象，里面总是调最新的处理函数。
  const latestConversationActions = useRef<ConversationActions | null>(null)
  latestConversationActions.current = { open: switchConversation, exportText: (id) => void exportConversation(id), remove: (id) => setConfirmation({ kind: 'delete-conversation', id }), rename: (id) => { const item = chat.state.conversations.find((candidate) => candidate.id === id); if (item) setRenaming({ id, text: item.title }) }, pin: chat.pinConversation }
  const conversationActions = useMemo<ConversationActions>(() => ({ open: (id) => latestConversationActions.current?.open(id), exportText: (id) => latestConversationActions.current?.exportText(id), remove: (id) => latestConversationActions.current?.remove(id), rename: (id) => latestConversationActions.current?.rename(id), pin: (id, pinned) => latestConversationActions.current?.pin(id, pinned) }), [])
  // 视频和画布项目那几行同样是 memo 的，拿的也是一个不变的对象。
  const latestExtraActions = useRef<ChatPageCreateActions | undefined>(undefined)
  latestExtraActions.current = create?.actions
  const extraActions = useMemo<ExtraActions>(() => ({ open: (item) => latestExtraActions.current?.open(item), renameVideo: (id) => latestExtraActions.current?.renameVideo(id), removeVideo: (id) => latestExtraActions.current?.removeVideo(id), openCanvas: (id) => latestExtraActions.current?.openCanvas(id) }), [])
  // 作品库里「基于此图继续编辑」「用此图生成视频」：回到对话这边，图放进输入框。当前对话正在生成就放进一段新的（生成着的那一段输入框是锁着的）。
  const latestLibraryActions = useRef<Pick<ChatLibraryContext, 'openConversation' | 'reuseImage' | 'animateImage'> | null>(null)
  latestLibraryActions.current = {
    openConversation: switchConversation,
    reuseImage: (asset) => { if (pending) chat.newConversation(); create?.actions.leave(); void chat.reuseImage(asset); focusComposer() },
    animateImage: (asset, prompt) => { if (pending) chat.newConversation(); create?.actions.leave(); chat.animateImage(asset, prompt); focusComposer() },
  }
  const libraryContext = useMemo<ChatLibraryContext>(() => ({
    conversations: chat.state.conversations, canAnimate: videoReady, upscale,
    openConversation: (id) => latestLibraryActions.current?.openConversation(id), reuseImage: (asset) => latestLibraryActions.current?.reuseImage(asset), animateImage: (asset, prompt) => latestLibraryActions.current?.animateImage(asset, prompt),
  }), [chat.state.conversations, videoReady, upscale])
  const renamingFrom = renaming ? chat.state.conversations.find((item) => item.id === renaming.id)?.title : undefined
  const renameReady = Boolean(renaming && renaming.text.trim() && renaming.text.trim() !== renamingFrom)
  const saveRename = () => { if (!renaming || !renameReady) return; chat.renameConversation(renaming.id, renaming.text); setRenaming(null) }
  const onModeChange = (mode: string) => { chat.selectMode(mode as ChatMode); setCustomSize(false) }
  const selectedModelMissing = conversation.settings.model && !models.includes(conversation.settings.model)
  const selectedGroup = chat.groups.find((group) => group.name === conversation.settings.group)
  // 尺寸框收起来了（换过对话再回来）就直接说，不然客户看不到哪里填错了。
  const showSizeRule = Boolean(chat.sizeRule) && (chat.sizeRuleRevealed || !customSize)
  // Enter 跟发送按钮同一个条件：按钮灰着时按 Enter 什么都不做，不再弹一句说错原因的红条（#1101 第 3 条）。
  const draftTooLong = videoMode ? videoPromptLengthError(conversation.draft) : draftLengthError(conversation.draft, textMode ? draftFiles : undefined)
  const editTooLong = editing ? draftLengthError(editing.text, conversation.messages.find((message) => message.id === editing.id)?.files) : ''
  const sendDisabled = !selectedGroup || (!conversation.draft.trim() && (!(draftImages.length || draftFiles.length) || !textMode)) || Boolean(draftTooLong) || imagesBlocked || filesBlocked || chat.attaching || preparation?.phase !== 'ready' || !conversation.settings.model || (videoMode && !videoReady)
  // 发一段视频之前先问一句、报个价（方案 2.6）：点发送和按 Enter 都先到这里，点了「开始生成」才真的发。
  const submit = () => { if (videoMode) { videoFeature?.refreshPrices(); setConfirmation({ kind: 'video' }) } else void chat.send() }
  const selectedGroupMissing = chat.groupsLoaded && Boolean(conversation.settings.group) && !selectedGroup
  const modelKind = textMode ? '聊天' : videoMode ? '视频' : '图片'
  // 按钮上写模型；还没得选的时候写卡在哪一步。
  // 原来的分组没了时照旧写着那个模型：下面那句「当前模型已不可用」说的就是它。
  const modelLabel = !chat.groupsLoaded && chat.groupLoading ? '正在读取模型' : conversation.settings.model && (!selectedModelMissing || selectedGroupMissing) ? conversation.settings.model : pendingGroups.size ? '正在准备模型' : !models.length ? '暂无可用模型' : '请选择模型'
  const modelsEmpty = !chat.groupsLoaded && chat.groupLoading ? '正在读取模型' : pendingGroups.size ? '正在准备模型' : allGroupsFailed ? '未获取到模型，请点击「刷新模型」' : !chat.groups.length ? '暂无可用模型' : `暂无可用的${modelKind}模型`
  // 同一个模型几个分组都有时，小字写的是选它以后按哪个分组计费；正选着的就是对话现在用的那个。
  const billingGroup = (entry: (typeof catalog)[number]) => entry.model === conversation.settings.model && entry.groups.includes(conversation.settings.group) ? conversation.settings.group : pickChatGroup(entry.groups, { current: conversation.settings.group, mode: conversation.settings.mode, groups: chat.groups, site: chat.site })
  const vendorSections = chatModelVendors.map((vendor) => ({ vendor, entries: catalog.filter((entry) => chatModelVendor(entry.model) === vendor) })).filter((section) => section.entries.length > 0)
  const modelSections = vendorSections.length ? vendorSections.map(({ vendor, entries }) => ({ label: vendor, value: conversation.settings.model, options: entries.map((entry) => ({ value: entry.model, label: entry.model, hint: `${billingGroup(entry)}分组` })), onChange: (model: string) => { chat.selectModel(model); setCustomSize(false) }, testId: `chat-model-vendor-${chatModelVendors.indexOf(vendor)}` })) : [{ label: '模型', value: '', options: [], empty: modelsEmpty, onChange: () => undefined, testId: 'chat-model-options' }]
  const refreshModels = async () => {
    const ticket = owner.capture()
    const prepared = await chat.refreshModels()
    if (!ticket() || !prepared) return
    toast.show(`已刷新：有 ${prepared.length} 个模型可用`, 'ok')
  }
  const confirmation = active ? confirmationState : null
  const retryMessage = confirmation?.kind === 'retry' ? conversation.messages.find((message) => message.id === confirmation.id) : undefined
  const retrySettings = retryMessage?.settings
  // 要出视频的那一问（新发的，或者重新生成一条视频回复）：照哪份设置出、多少钱、还剩多少钱。
  const videoAsk = confirmation?.kind === 'video' ? conversation.settings : retryMessage?.video ? retrySettings : undefined
  const videoQuote = videoAsk ? videoFeature?.quote(videoAsk.model, videoAsk.group) : null
  const videoAskLine = videoAsk ? `用「${videoAsk.model}」生成 1 段、${chatVideoSecondsFor(videoAsk)} 秒，单独计费${videoQuote ? `，${videoQuote}` : ''}。${videoFeature?.balance ? `当前余额 ${videoFeature.balance}。` : ''}` : ''
  // 上一次提交结果不明的那一段：再生成可能多扣一次，要先勾「我已了解影响」（同视频工作台）。
  const videoUnconfirmed = Boolean(retryMessage?.video?.unconfirmed)
  const confirmTitle = confirmation?.kind === 'video' ? '生成 1 段视频？' : confirmation?.kind === 'retry' ? '是否重新生成此回复？' : confirmation?.kind === 'stop' ? '停止等待图片生成？' : confirmation?.kind === 'clear' ? '清空当前对话？' : confirmation?.kind === 'clear-all' ? '清空全部对话？' : confirmation?.kind === 'delete-conversation' ? `删除「${chat.state.conversations.find((item) => item.id === confirmation.id)?.title ?? '新对话'}」？` : '是否删除此条及之后的消息？'
  const running = chat.state.conversations.some(isGenerating) || Object.values(preparations).some((item) => item.phase === 'loading')
  const anyGenerating = chat.state.conversations.some(isGenerating)
  // 对话里刚出完一张图、一段视频：左下角「作品库」的数再数一遍（只在从「正在生成」变回来的那一下）。
  const refreshLibrary = library?.refresh
  const wasGenerating = useRef(anyGenerating)
  useEffect(() => {
    if (wasGenerating.current && !anyGenerating) refreshLibrary?.()
    wasGenerating.current = anyGenerating
  }, [anyGenerating, refreshLibrary])
  // 回复是界面一段段接着收、收完写进聊天记录的：在回复的时候窗口缩到托盘也不关界面（electron/renderer-release.ts）。
  // 等视频的不算在这里面：它关了界面也不断（请求号存着，回来接），重启装更新、导入聊天记录都不用为它等几分钟。
  useBackgroundWork('chat', chat.state.conversations.some(isGeneratingReply) || isGeneratingReply(chat.state.draftConversation), 'chat')
  // 等视频时界面也先别关（同视频工作台出片）：片段一回来就挂回对话、弹一下任务栏，不用等客户再打开窗口。
  useBackgroundWork('chat-video', chat.state.conversations.some(isGeneratingVideo))
  // 换账号会停掉对话页正在出的图：「切换账号」框按这个先问一句（D44）。
  useChatImageWork(chat.state.conversations.some(isGeneratingImage) || isGeneratingImage(chat.state.draftConversation))
  const searchText = search.trim()
  return <section ref={surface} className="chat-page" hidden={!active} data-testid="page-chat" data-page-id="ai-chat" data-account-scope={scope} onKeyDownCapture={(event) => { if (!active) { event.preventDefault(); event.stopPropagation() } }} onScrollCapture={(event) => { if (active && event.target instanceof HTMLElement && event.target.classList.contains('chat-conversation-list')) navigationScroll.current = event.target.scrollTop }}>
    <aside className="chat-conversations" aria-label="做过的东西">
      <div className="chat-conversations-top"><Button icon={Plus} onClick={startNew} testId="chat-conversation-new">新建</Button></div>
      <div className="chat-conversation-search"><SearchInput value={search} onChange={setSearch} placeholder="搜索做过的东西" testId="chat-conversation-search" /></div>
      {filterOptions.length > 2 && <div className="chat-conversation-kinds"><Chips label="只看哪一类" value={filter} onChange={(value) => setKind(filterOptions.find((option) => option.value === value)?.value ?? 'all')} options={filterOptions} testId="create-filter" /></div>}
      <nav className="chat-conversation-list" aria-label="做过的东西列表">{listGroups.map(({ label, rows }) => <Fragment key={label}><div className="chat-conversation-day">{label}</div>{rows.map((row) => row.kind === 'chat'
        ? <ConversationListItem key={`chat:${row.conversation.id}`} item={row.conversation} current={!paneCovered && row.conversation.id === chat.state.activeId} pageActive={active} actions={conversationActions} />
        : <ExtraListItem key={`${row.kind}:${row.item.id}`} item={row.item} current={extraSelected?.kind === row.kind && extraSelected.id === row.item.id} locked={row.kind === 'video' && create?.lockedVideoId === row.item.id} pageActive={active} actions={extraActions} />)}</Fragment>)}{listGroups.length === 0 && (searchText
        ? <p className="chat-conversation-empty" data-testid="chat-conversation-search-empty">未找到「{searchText}」相关的内容</p>
        : <p className="chat-conversation-empty" data-testid="chat-conversation-empty">{chat.historyUnreadable && (filter === 'all' || filter === 'chat') ? unreadableHistoryNote : filter !== 'all' ? '该分类下暂无内容。' : '暂无内容。请在右侧输入框中输入您的需求。'}</p>)}{listNotes.map((note) => <div key={note.text} className="chat-list-note"><p className="chat-conversation-empty" data-testid="create-list-note">{note.text}</p>{note.retry && <Button variant="ghost" size="xs" icon={RefreshCw} onClick={note.retry} testId="create-list-note-retry">重新读取</Button>}</div>)}</nav>
      {library && <div className="chat-library-foot"><button type="button" className="chat-library-entry" data-active={library.open} aria-current={library.open ? 'page' : undefined} onClick={library.onOpen} data-testid="create-library-open"><span className="chat-conversation-kind" data-kind="library"><Images size={15} aria-hidden="true" /></span><strong>作品库</strong>{library.count ? <b data-testid="create-library-count">{library.count}</b> : null}</button></div>}
      {chat.state.conversations.length > 1 && <div className="chat-conversations-foot"><Button variant="ghost" size="xs" icon={Trash2} disabled={anyGenerating} onClick={() => setConfirmation({ kind: 'clear-all' })} testId="chat-conversations-clear">清空全部对话</Button></div>}
    </aside>
    {create?.pane}
    {library?.render(libraryContext)}
    <div className="chat-conversation" hidden={paneCovered}>
      <header className="chat-bar"><strong title={startPage ? undefined : conversation.title}>{startPage ? '新建' : conversation.title}</strong><div className="chat-bar-actions"><Button icon={SlidersHorizontal} variant="ghost" size="sm" aria-label="参数设置" title="参数设置" onClick={() => setParametersOpen(true)} testId="chat-parameters-open" /><Button icon={Trash2} variant="ghost" size="sm" aria-label="清空对话" title="清空对话" disabled={pending || !conversation.messages.length} onClick={() => setConfirmation({ kind: 'clear' })} testId="chat-conversation-clear" /><Button icon={FileText} variant="ghost" size="sm" aria-label="导出此对话" title="导出此对话" disabled={pending || !conversation.messages.length} onClick={() => void exportConversation(conversation.id)} testId="chat-conversation-export" /></div></header>
      {(chat.groupError || chat.error || chat.notice || chat.storageError || preparationWarning) && <div className="chat-banner" data-tone={chat.groupError || chat.error || chat.storageError ? 'bad' : 'neutral'} role={chat.groupError || chat.error || chat.storageError ? 'alert' : 'status'}><span>{chat.storageError || chat.groupError || chat.error || chat.notice || preparationWarning}</span>{chat.historyUnreadable && chat.storageError && <Button size="xs" icon={RefreshCw} loading={reloading} disabled={running} onClick={() => void reloadHistory()} testId="chat-history-reload">重新读取</Button>}{chat.groupError && <Button size="xs" icon={RefreshCw} onClick={() => void chat.refreshGroups()} testId="chat-groups-retry">重试</Button>}{!chat.groupError && !chat.storageError && chat.error === offlineSendMessage && <Button size="xs" icon={RefreshCw} disabled={pending} onClick={() => void chat.retryOfflineSend()} testId="chat-send-retry">重试</Button>}{!chat.groupError && !chat.storageError && isConversationTooLongMessage(chat.error) && <Button size="xs" variant="primary" icon={Plus} onClick={chat.continueInNew} testId="chat-continue-new">带着这句话开新对话</Button>}{!chat.groupError && !chat.storageError && !preparationWarning && <Button variant="ghost" size="xs" icon={X} aria-label="关闭提示" title="关闭提示" onClick={() => { chat.setError(''); chat.setNotice('') }} />}</div>}
      <div className="chat-messages" ref={list} aria-label="消息记录" onScroll={(event) => { if (!active) return; const element = event.currentTarget; stickToBottom.current = !conversation.messages.length || element.scrollHeight - element.scrollTop - element.clientHeight < 80; scrolls.current.set(conversation.id, element.scrollTop) }}>
        {!conversation.messages.length && create?.intro?.(chat.state.conversations.length)}
        {!conversation.messages.length && <div className="chat-empty" data-start={create?.cards ? 'true' : undefined} data-testid="chat-empty"><Logo kind="symbol" height={create?.cards ? 44 : 56} /><h2>今天想创作什么？</h2><p>{videoFeature?.access === 'ready' ? '提问、写作、绘图、制作视频均可在下方输入框中完成，额度与工具共用同一账号。' : '提问、写作、绘图均可在下方输入框中完成，额度与工具共用同一账号。'}</p>{textMode && !conversation.draft.trim() && <div className="chat-empty-examples">{chatExamples.map((text, index) => <Button key={text} size="sm" onClick={() => fillExample(text)} testId={`chat-example-${index + 1}`}>{text}</Button>)}</div>}</div>}
        {!conversation.messages.length && create?.cards}
        {conversation.messages.map((message) => <ChatMessageItem key={message.id} message={message} model={message.settings?.model ?? conversation.settings.model} pending={pending} offlineNotice={shouldShowOfflineReplyNotice(message, offline)} canAnimate={videoReady} upscaling={upscale.busy} videoProgress={message.video && message.requestId ? chat.videoProgress[message.requestId] : undefined} videoStopping={stopping && Boolean(message.video) && message.status === 'pending'} videoFilms={message.video?.clip && videoReady ? videoFeature?.films : undefined} canvasProjects={message.role === 'assistant' && message.assets?.length ? create?.canvas?.projects : undefined} canRetry={chat.groups.some((group) => group.name === (message.settings?.group ?? conversation.settings.group))} canOpenAccount={Boolean(onOpenAccount)} markdownComponents={markdownComponents} replyComponents={replyComponents} actions={messageActions} />)}
      </div>
      <div className="chat-composer">
        {shouldShowLengthNotice(conversation) && !isConversationTooLongMessage(chat.error) && <div className="chat-length-notice" role="status" data-testid="chat-length-notice"><span>当前对话已较长。每次发送时，之前的内容会一并发送给 AI，对话越长，每次回复的费用通常越高、速度越慢。如需切换话题，请点击「新对话」，已输入的内容将一并带入。</span><Button size="xs" icon={Plus} disabled={pending} onClick={chat.continueInNew} testId="chat-length-new">新对话</Button><Button size="xs" variant="ghost" onClick={chat.dismissLengthNotice} testId="chat-length-dismiss">知道了</Button></div>}
        {selectedGroupMissing && <p className="chat-message-error" role="alert" data-testid="chat-group-unavailable">当前模型已不可用，请更换模型。已保存的消息和草稿将继续保留。</p>}{allGroupsFailed && <p className="chat-message-error" role="alert">{preparations[failedGroups[0].name]?.error}</p>}{!allGroupsFailed && failedGroups.length > 0 && !pendingGroups.size && <p className="chat-hint" data-testid="chat-groups-partly-failed">部分分组的模型未能获取，请点击模型菜单中的「刷新模型」。</p>}{chat.groups.length > 0 && !pendingGroups.size && !allGroupsFailed && models.length === 0 && <p className="chat-hint">暂无可用的{modelKind}模型</p>}
        {draftImages.length > 0 && <div className="chat-draft-images" data-testid="chat-draft-images">{draftImages.map((image) => <div className="chat-draft-image" key={image.assetId}><ChatImage asset={image} alt="要发的图片" /><Button size="xs" variant="ghost" icon={X} aria-label="去掉这张图片" title="去掉这张图片" disabled={pending} onClick={() => chat.removeImage(image.assetId)} testId="chat-draft-image-remove" /></div>)}</div>}
        {draftFiles.length > 0 && <div className="chat-files" data-testid="chat-draft-files">{draftFiles.map((file, index) => <ChatFileCard key={`${index}:${file.name}`} file={file}><Button size="xs" variant="ghost" icon={X} aria-label="移除此文件" title="移除此文件" disabled={pending} onClick={() => chat.removeFile(index)} testId="chat-draft-file-remove" /></ChatFileCard>)}</div>}
        {imagesBlocked && <p className="chat-message-error" role="alert" data-testid="chat-images-unsupported">{imagesBlockedMessage}</p>}
        {filesBlocked && <p className="chat-message-error" role="alert" data-testid="chat-files-image-mode">{modeFilesMessage(conversation.settings.mode)}</p>}
        <div className="chat-compose-box">
          <Textarea id="chatIn" aria-label={conversation.settings.mode === 'image' ? '图片描述' : videoMode ? '视频描述' : '消息内容'} value={conversation.draft} onChange={(event) => chat.setDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (shouldSendOnEnter(event.nativeEvent, composing.current)) { event.preventDefault(); if (!pending && !sendDisabled) submit() } }} onPaste={onPaste} rows={1} aria-describedby={draftTooLong ? 'chatInTooLong' : undefined} placeholder={conversation.settings.mode === 'image' ? '描述您想要的画面，例如：星空下的山野，一轮金色落日' : videoMode ? '描述您想要的视频，例如：海边日落，镜头慢慢拉远' : seesImages ? '输入消息，Enter 发送，也可以粘贴截图' : '输入消息，Enter 发送'} testId="chat-composer-input" />
          {/* 切走时菜单跟着关：重新挂一遍，开着的弹出层随之收起，回来时不会还悬在那里。 */}
          <div className="chat-compose-bar" key={active ? 'active' : 'hidden'}>
            <Segment options={[{ value: 'text', label: '文本对话' }, { value: 'image', label: '生成图片' }, ...(videoFeature ? [{ value: 'video', label: '生成视频', disabled: !videoReady, title: videoFeature.access === 'unsupported' ? '当前账号不支持生成视频' : videoFeature.access === 'suspended' ? '生成视频暂时停用' : undefined }] : [])]} value={conversation.settings.mode} onChange={onModeChange} testId="chat-mode" />
            <span className="chat-model-picker"><ChoiceMenu label="模型" align="start" onOpen={chat.refreshOnInteraction} anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title={[conversation.settings.group, conversation.settings.model].filter(Boolean).join(' · ') || undefined} disabled={!chat.groupsLoaded && chat.groupLoading} data-group={conversation.settings.group} data-model={conversation.settings.model} data-preparing={preparing} testId="chat-model"><span aria-hidden="true"><BrandIcon model={conversation.settings.model} size={16} /></span><span className="chat-model-name">{modelLabel}</span></Button>} sections={modelSections} actions={[{ label: '刷新模型', icon: RefreshCw, loading: preparing, keepOpen: true, onSelect: () => void refreshModels(), testId: 'chat-group-prepare' }]} /></span>
            {conversation.settings.mode === 'image' && imageCapability && <>
              <ImageOptionMenus capability={imageCapability} values={conversation.settings} customSize={customSize} onCustomSize={setCustomSize} onChange={chat.changeSettings} onLeaveCustomSize={chat.revealSizeRule} sizeRuleId={showSizeRule ? 'chatImageSizeRule' : undefined} testIdPrefix="chat-image" />
            </>}
            {videoMode && <>
              <ChoiceMenu label="画面" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="画面" data-value={videoAspect} testId="chat-video-aspect">{videoStudioAspectNames[videoAspect]}</Button>} sections={[{ label: '画面', value: videoAspect, options: videoStudioAspects.map((aspect) => ({ value: aspect, label: videoStudioAspectNames[aspect] })), onChange: (value) => { const aspect = videoStudioAspects.find((item) => item === value); if (aspect) chat.changeSettings({ videoAspect: aspect }) } }]} />
              <ChoiceMenu label="时长" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="时长" data-value={videoSeconds} testId="chat-video-seconds">{videoSeconds} 秒</Button>} sections={[{ label: '时长', value: String(videoSeconds), options: chatVideoSecondsChoices(conversation.settings.model).map((seconds) => ({ value: String(seconds), label: `${seconds} 秒` })), onChange: (value) => chat.changeSettings({ videoSeconds: Number(value) }) }]} />
            </>}
            {/* 右边这几个按钮是一组：一行放不下时整组换到下一行、还靠右，不会只剩发送按钮掉到左下角。 */}
            <span className="chat-compose-actions">
            <Button variant="ghost" size="sm" icon={Bookmark} title="保存常用语，点击即可填入输入框" onClick={() => setPhrasesOpen(true)} testId="chat-phrases-open">常用</Button>
            {textMode && <Button variant="ghost" size="sm" icon={Paperclip} aria-label="添加文件" title={filesFull ? `每条消息最多附带 ${AI_CHAT_TEXT_FILE_LIMITS.filesPerMessage} 个文件` : '添加文本类文件（txt、md、csv、json、代码、日志）'} loading={chat.attaching} disabled={pending || filesFull} onClick={() => void chat.pickFiles()} testId="chat-attach-file" />}
            <Button variant="ghost" size="sm" icon={ImagePlus} aria-label="加图片" title={attachTitle} loading={chat.attaching} disabled={pending || !seesImages || draftImages.length >= imageLimit} onClick={() => void chat.pickImages()} testId="chat-attach-image" />
            {pending ? <Button size="sm" icon={Square} aria-label="停止生成" title="停止生成" loading={stopping} onClick={() => { if (activeRequest?.settings?.mode === 'image') setConfirmation({ kind: 'stop' }); else void stop() }} testId="chat-stop" /> : <Button variant="primary" size="sm" icon={conversation.settings.mode === 'image' ? ImageIcon : videoMode ? Clapperboard : ArrowUp} aria-label={conversation.settings.mode === 'image' ? '生成图片' : videoMode ? '生成视频' : '发送消息'} title={conversation.settings.mode === 'image' ? '生成图片' : videoMode ? '生成视频' : '发送消息'} disabled={sendDisabled} onClick={submit} testId="chat-send" />}
            </span>
          </div>
        </div>
        {draftTooLong && <p className="chat-message-error" id="chatInTooLong" role="status" data-testid="chat-draft-too-long">{draftTooLong}</p>}
        {showSizeRule && <p className="chat-message-error" id="chatImageSizeRule" role="status" data-testid="chat-image-size-rule">{chat.sizeRule}</p>}
        <div className="chat-compose-foot">{videoMode ? <span data-testid="chat-cost-note">生成一段视频需要几分钟，按段计费，发送前将显示预计费用。</span> : <span data-testid="chat-compose-note">{textMode ? '回答由模型生成，可能有误，重要内容请核对。' : '图片由模型生成，'}<span data-testid="chat-cost-note">{draftImages.length ? textMode ? '按实际用量计费，带图片的提问会更贵一些。' : '按实际用量计费，带参考图的会更贵一些。' : textMode ? '按实际用量计费，回复越长花得越多。' : '按实际用量计费。'}</span></span>}{pending && <Pill tone="accent">正在生成</Pill>}</div>
      </div>
    </div>
    {confirmation && <Confirm title={confirmTitle} body={confirmation.kind === 'video' ? <><p>{videoAskLine}</p><p>{videoWaitNote}</p></>
      : confirmation.kind === 'retry' && videoAsk ? <><p>重新生成会发起新的付费请求，并替换此条及之后的回复。</p><p>{videoAskLine}</p>{videoUnconfirmed && <p data-testid="chat-confirm-unconfirmed">{videoStudioUnconfirmedWarning([0], 1)}</p>}<p>{videoWaitNote}</p></>
      : confirmation.kind === 'retry' ? <><p>{confirmation.mayStillComplete ? '上次请求可能仍在服务端处理。' : ''}重新生成会发起新的付费请求，并替换此条及之后的回复。</p>{retrySettings && <p>{retrySettings.group} · {retrySettings.model}</p>}</> : confirmation.kind === 'stop' ? <p>停止等待后服务端仍可能继续生成图片并计费。已产生的费用不会自动退回。</p> : confirmation.kind === 'clear-all' ? <p>聊天记录将从本机全部删除且无法恢复，用量账单不受影响。</p> : confirmation.kind === 'delete-conversation' ? <p>该对话将从本机删除且无法恢复，已产生的用量不受影响。</p> : <p>将移除对应的本地消息记录，无法撤销。已产生的用量不会改变。</p>} okLabel={confirmation.kind === 'video' ? '开始生成' : confirmation.kind === 'retry' ? '重新生成' : confirmation.kind === 'stop' ? '停止等待' : confirmation.kind === 'clear-all' ? '全部清空' : confirmation.kind === 'delete-conversation' ? '删除' : '确认删除'} danger={(confirmation.kind !== 'retry' && confirmation.kind !== 'video') || videoUnconfirmed} requireAck={confirmation.mayStillComplete || confirmation.kind === 'stop' || videoUnconfirmed} onOk={confirmAction} onClose={() => setConfirmation(null)} testId="chat-confirm" />}
    {active && parametersOpen && <ParametersDialog key={conversation.id} settings={conversation.settings} onApply={(patch) => { chat.changeSettings(patch); setParametersOpen(false); toast.show('参数已应用到当前对话', 'ok') }} onClose={() => setParametersOpen(false)} />}
    {active && phrasesOpen && <PhrasesDialog phrases={chat.state.phrases ?? []} draft={conversation.draft} onUse={fillPhrase} onSave={chat.savePhrase} onRemove={chat.removePhrase} onClose={() => setPhrasesOpen(false)} />}
    {active && editing && <Dialog open title="编辑消息" subtitle="修改后重新发送，将移除此消息之后的回复，并产生新的请求用量。" width={480} onClose={() => setEditing(null)} dirty={editing.text !== conversation.messages.find((message) => message.id === editing.id)?.content} footer={<><Button onClick={() => setEditing(null)}>取消</Button><Button variant="primary" icon={ArrowUp} disabled={!editing.text.trim() || Boolean(editTooLong)} onClick={() => { const value = editing; setEditing(null); void chat.send({ editId: value.id, prompt: value.text }) }} testId="chat-edit-send">修改并重发</Button></>} testId="chat-edit-dialog"><Textarea label="消息内容" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} rows={8} error={editTooLong || undefined} testId="chat-edit-input" /></Dialog>}
    {active && renaming && <Dialog open title="重命名对话" width={480} onClose={() => setRenaming(null)} dirty={renameReady} footer={<><Button onClick={() => setRenaming(null)}>取消</Button><Button variant="primary" disabled={!renameReady} onClick={saveRename} testId="chat-rename-save">保存</Button></>} testId="chat-rename-dialog"><Input aria-label="对话名字" value={renaming.text} onChange={(event) => setRenaming({ ...renaming, text: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); saveRename() } }} maxLength={MAX_CONVERSATION_TITLE_LENGTH} autoFocus testId="chat-rename-input" /></Dialog>}
    {active && copyFallback !== null && <Dialog open title="手动复制内容" subtitle="无法访问剪贴板，选中文字后使用系统复制操作。" width={640} onClose={() => setCopyFallback(null)} footer={<Button variant="primary" onClick={() => setCopyFallback(null)}>关闭</Button>} testId="chat-copy-fallback"><Textarea label="待复制内容" value={copyFallback} readOnly rows={12} onFocus={(event) => event.currentTarget.select()} /></Dialog>}
    {active && preview && <Dialog open title={preview.mine ? '您发送的图片' : '生成的图片'} width={640} onClose={() => setPreview(null)} footer={<><Button icon={Copy} onClick={() => void task(() => api.copyAsset(preview.asset.assetId), '图片已复制')}>复制图片</Button><Button icon={Download} onClick={() => void saveAsset(preview.asset.assetId)}>另存图片</Button><Button icon={ArrowUpRight} onClick={() => void task(() => api.assetMenu(preview.asset.assetId), '')}>更多操作</Button></>} testId="chat-image-preview"><img className="chat-preview-image" src={preview.asset.localUrl} alt={preview.mine ? '您发送的图片' : preview.asset.revisedPrompt || '生成的图片'} onError={(event) => { event.currentTarget.alt = missingAiAssetMessages.image }} /></Dialog>}
  </section>
}

interface MessageActions { copyText: (text: string, done?: string) => void; preview: (asset: AiChatAsset, mine: boolean) => void; reuseImage: (asset: AiChatAsset) => void; animateImage: (messageId: string, asset: AiChatAsset) => void; addToCanvas: (messageId: string, assetId: string, projectId: string | null) => void; stopVideo: () => void; saveVideo: (messageId: string) => void; openVideo: (assetId: string) => void; composeVideo: (messageId: string, filmId: string | null) => void; copyAsset: (assetId: string) => void; saveAsset: (assetId: string) => void; upscaleAsset: (messageId: string, assetId: string, scale: ImageUpscaleScale) => void; assetMenu: (assetId: string) => void; confirm: (confirmation: NonNullable<Confirmation>) => void; edit: (editing: { id: string; text: string }) => void; openAccount: NonNullable<ChatPageProps['onOpenAccount']> }
interface ConversationActions { open: (id: string) => void; exportText: (id: string) => void; remove: (id: string) => void; rename: (id: string) => void; pin: (id: string, pinned: boolean) => void }
interface ConversationListItemProps { item: Conversation; current: boolean; pageActive: boolean; actions: ConversationActions }
type ExtraActions = Omit<ChatPageCreateActions, 'leave'>
interface ExtraListItemProps { item: CreateExtraItem; current: boolean; locked: boolean; pageActive: boolean; actions: ExtraActions }
const unreadableHistoryNote = '历史对话读取失败'
// 出视频的两处确认框（新发的、重新生成的）都带这一句，同视频工作台的确认框（那边说「那几段」）。
const videoWaitNote = '生成一段需要几分钟。中途停止时，已提交至服务端的片段仍会继续生成并扣费。'
const noExtraKinds: readonly CreateExtraKind[] = []
const noExtraItems: readonly CreateExtraItem[] = []
// 每一行前面的小图标：一眼分得出是对话、视频还是画布。
const kindIcons: Record<CreateKind, LucideIcon> = { chat: MessageSquare, video: Clapperboard, canvas: InfinityIcon }
function KindIcon({ kind }: { kind: CreateKind }) {
  const Icon = kindIcons[kind]
  return <span className="chat-conversation-kind" data-kind={kind}><Icon size={15} aria-hidden="true" /></span>
}

// A streamed chunk replaces only the conversation it belongs to (see
// conversationSearchTexts in state.ts), so every other row keeps its props and
// skips the render. The list holds up to MAX_CONVERSATIONS (200) rows, each with its own
// menu; re-rendering all of them for every chunk made a reply stutter.
const ConversationListItem = memo(function ConversationListItem({ item, current, pageActive, actions }: ConversationListItemProps) {
  return <div className="chat-conversation-item" data-active={current}><button type="button" className="chat-conversation-select" onClick={() => actions.open(item.id)} aria-current={current ? 'page' : undefined} title={item.title} data-testid={`chat-conversation-${item.id}`}><KindIcon kind="chat" /><span className="chat-conversation-text"><strong>{item.title}</strong><span>{isGeneratingVideo(item) ? '正在生成视频…' : isGenerating(item) ? '正在回答…' : `${item.messages.length} 条消息`}</span></span></button><Menu key={pageActive ? 'active' : 'hidden'} label="对话操作" anchor={<Button variant="ghost" size="xs" icon={MoreHorizontal} aria-label={`「${item.title}」更多操作`} title="对话操作" />} items={[{ label: '重命名', icon: Pencil, testId: `chat-conversation-rename-${item.id}`, onSelect: () => actions.rename(item.id) }, { label: item.pinned ? '取消置顶' : '置顶', icon: item.pinned ? PinOff : Pin, testId: `chat-conversation-pin-${item.id}`, onSelect: () => actions.pin(item.id, !item.pinned) }, { label: '导出此对话', icon: FileText, disabled: isGenerating(item) || !item.messages.length, onSelect: () => actions.exportText(item.id) }, 'divider', { label: '删除此对话…', icon: Trash2, danger: true, disabled: isGenerating(item), onSelect: () => actions.remove(item.id) }]} /></div>
})

// 一条视频或一个画布项目。视频的「改名」「删除此视频…」在这里；画布项目的改名、复制、归档、删除还在画布窗口的项目中心，这里只有「打开画布」。
const ExtraListItem = memo(function ExtraListItem({ item, current, locked, pageActive, actions }: ExtraListItemProps) {
  const video = item.kind === 'video'
  return <div className="chat-conversation-item" data-active={current}><button type="button" className="chat-conversation-select" onClick={() => actions.open(item)} aria-current={current ? 'page' : undefined} title={item.title} data-testid={`create-item-${item.kind}-${item.id}`}><KindIcon kind={item.kind} /><span className="chat-conversation-text"><strong>{item.title}</strong><span>{item.detail}</span></span></button><Menu key={pageActive ? 'active' : 'hidden'} label={video ? '视频操作' : '画布项目操作'} anchor={<Button variant="ghost" size="xs" icon={MoreHorizontal} aria-label={`「${item.title}」更多操作`} title={video ? '视频操作' : '画布项目操作'} testId={`create-item-menu-${item.kind}-${item.id}`} />} items={video
    ? [{ label: '重命名', icon: Pencil, testId: `create-video-rename-${item.id}`, onSelect: () => actions.renameVideo(item.id) }, 'divider', { label: '删除此视频…', icon: Trash2, danger: true, disabled: locked, testId: `create-video-remove-${item.id}`, onSelect: () => actions.removeVideo(item.id) }]
    : [{ label: '打开画布', icon: ArrowUpRight, testId: `create-canvas-open-${item.id}`, onSelect: () => actions.openCanvas(item.id) }]} /></div>
})

interface ChatMessageItemProps { message: ChatMessage; model: string; pending: boolean; offlineNotice: boolean; canAnimate: boolean; upscaling: ReadonlySet<string>; videoProgress?: ChatVideoProgress; videoStopping: boolean; videoFilms?: readonly ChatVideoFilm[]; canvasProjects?: readonly CanvasIntakeProject[]; canRetry: boolean; canOpenAccount: boolean; markdownComponents: Components; replyComponents: Components; actions: MessageActions }

// Every keystroke in the composer rewrites the conversation's draft. Messages
// keep their object identity through that, so a memoized row skips parsing its
// markdown again; without it a long conversation re-parsed every reply per key.
// 带的文件只显示一张卡片，不把内容摊开：文件名、大小，只读了开头的写清读了多少字。
function ChatFileCard({ file, children }: { file: AiChatTextFile; children?: ReactNode }) {
  const detail = [formatDownloadBytes(file.size), ...(file.truncated ? [`只读了前 ${file.text.length.toLocaleString('zh-CN')} 字`] : [])].join(' · ')
  return <div className="chat-file" title={`${file.name} · ${detail}`} data-truncated={file.truncated || undefined}><FileText size={14} aria-hidden="true" /><span className="chat-file-name">{file.name}</span><small>· {detail}</small>{children}</div>
}

const ChatMessageItem = memo(function ChatMessageItem({ message, model, pending, offlineNotice, canAnimate, upscaling, videoProgress, videoStopping, videoFilms, canvasProjects, canRetry, canOpenAccount, markdownComponents, replyComponents, actions }: ChatMessageItemProps) {
  const waiting = message.status === 'pending' || message.status === 'streaming'
  const clip = message.video?.clip
  const cutOffNotice = chatCutOffNotice(message)
  // 0.2.25 C2：出图的回复把「重新生成」「删除」接在最后一张图那排按钮后面（细竖线隔开），不再单独另起一排，
  // 免得被当成下一条消息的；带文字说明的，「复制回答」照旧在下面。
  const imageReply = message.role === 'assistant' && Boolean(message.assets?.length)
  const retryButton = <Button size="xs" icon={RefreshCw} variant="ghost" aria-label="重新生成" title="重新生成" disabled={pending || !canRetry} onClick={() => actions.confirm({ kind: 'retry', id: message.id, mayStillComplete: message.mayStillComplete })} testId={`chat-message-retry-${message.id}`} />
  const deleteButton = <Button size="xs" icon={Trash2} variant="ghost" aria-label="删除消息" title="删除消息" disabled={pending} onClick={() => actions.confirm({ kind: 'delete-message', id: message.id })} testId={`chat-message-delete-${message.id}`} />
  return <div className="chat-message" data-role={message.role} data-status={message.status} data-testid={`chat-message-${message.id}`}>
    {message.role === 'assistant' && <span className="chat-avatar"><BrandIcon model={model} size={18} /></span>}
    <div className="chat-message-main">
      {message.reasoning && <details className="chat-reasoning"><summary>思考过程 <ChevronDown size={13} aria-hidden="true" /></summary><div>{message.reasoning}</div><Button icon={Copy} size="xs" variant="ghost" aria-label="复制思考过程" title="复制思考过程" onClick={() => actions.copyText(message.reasoning)} /></details>}
      {(message.content || message.assets?.length || message.files?.length || clip || waiting) && <div className="chat-bubble">{message.files?.length ? <div className="chat-files" data-testid="chat-message-files">{message.files.map((file, index) => <ChatFileCard key={`${index}:${file.name}`} file={file} />)}</div> : null}{message.content ? message.role === 'assistant' ? <ReactMarkdown remarkPlugins={remarkPlugins} components={replyComponents}>{prepareChatMath(message.content)}</ReactMarkdown> : <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>{message.content}</ReactMarkdown> : waiting && (message.video ? <ChatVideoPending progress={videoProgress} stopping={videoStopping} onStop={actions.stopVideo} /> : <span className="chat-generating" role="status"><RefreshCw size={15} aria-hidden="true" />{message.settings?.mode === 'image' ? '正在生成图片' : message.reasoning ? '正在思考' : '正在生成'}</span>)}
        {message.assets?.map((asset, assetIndex, assets) => <div className="chat-asset" key={asset.assetId}><button type="button" className="chat-asset-preview" aria-label={message.role === 'user' ? '查看图片' : '查看生成图片'} onClick={() => actions.preview(asset, message.role === 'user')} onContextMenu={(event) => { event.preventDefault(); actions.assetMenu(asset.assetId) }}><ChatImage asset={asset} alt={message.role === 'user' ? '您发送的图片' : asset.revisedPrompt || '生成的图片'} missingAlt={missingAiAssetMessages.image} /></button><div className="chat-asset-actions">{message.role === 'assistant' && <Button size="xs" icon={Brush} variant="ghost" aria-label="基于此图继续编辑" title="基于此图继续编辑" disabled={pending} onClick={() => actions.reuseImage(asset)} testId="chat-asset-reuse" />}{message.role === 'assistant' && canAnimate && <Button size="xs" icon={Clapperboard} variant="ghost" title="以此图为开头生成视频，将切换至「生成视频」" disabled={pending} onClick={() => actions.animateImage(message.id, asset)} testId="chat-asset-animate">用此图生成视频</Button>}{message.role === 'assistant' && canvasProjects && <AddToCanvasMenu compact projects={canvasProjects} onPick={(projectId) => actions.addToCanvas(message.id, asset.assetId, projectId)} testId="chat-asset-canvas" />}<ImageUpscaleMenu compact assetId={asset.assetId} control={{ busy: upscaling, run: (assetId, scale) => actions.upscaleAsset(message.id, assetId, scale) }} testId="chat-asset-upscale" /><Button size="xs" icon={Copy} variant="ghost" aria-label="复制图片" title="复制图片" onClick={() => actions.copyAsset(asset.assetId)} testId="chat-asset-copy" /><Button size="xs" icon={Download} variant="ghost" aria-label="另存图片" title="另存图片" onClick={() => actions.saveAsset(asset.assetId)} testId="chat-asset-save" /><Button size="xs" icon={MoreHorizontal} variant="ghost" aria-label="图片更多操作" title="图片更多操作" onClick={() => actions.assetMenu(asset.assetId)} testId="chat-asset-menu" />{imageReply && assetIndex === assets.length - 1 && <><span className="chat-asset-divider" aria-hidden="true" />{retryButton}{deleteButton}</>}{asset.width && asset.height && <small>{asset.width} × {asset.height}</small>}</div></div>)}
        {clip && <ChatVideoClip clip={clip} films={videoFilms} onCompose={(filmId) => actions.composeVideo(message.id, filmId)} onSave={() => actions.saveVideo(message.id)} onOpen={() => actions.openVideo(clip.assetId)} />}
      </div>}
      {offlineNotice && <p className="chat-message-note" role="status" data-testid="chat-message-offline">{offlineReplyNotice}</p>}
      {message.status === 'error' && <ErrorLine message={message.error} onOpenAccount={canOpenAccount ? actions.openAccount : undefined} />}{message.status === 'canceled' && <p className="chat-message-note">{message.mayStillComplete ? '已停止等待，服务端仍可能处理并计费' : '已停止生成，保留已返回的内容'}</p>}{cutOffNotice && <p className="chat-message-note" data-testid={`chat-message-cut-off-${message.id}`}>{cutOffNotice}</p>}
      {(!imageReply || message.content) && <div className="chat-message-tools">{message.role === 'assistant'
        ? <>{message.content && <Button size="xs" icon={Copy} variant="ghost" aria-label="复制回答" title="复制回答" onClick={() => actions.copyText(message.content, '回答已复制')} testId={`chat-message-copy-${message.id}`} />}{!imageReply && retryButton}</>
        : <>{message.content && <Button size="xs" icon={Copy} variant="ghost" aria-label="复制" title="复制" onClick={() => actions.copyText(message.content)} testId={`chat-message-copy-${message.id}`} />}<Button size="xs" icon={Pencil} variant="ghost" aria-label="编辑后重新发送" title="编辑后重新发送" disabled={pending} onClick={() => actions.edit({ id: message.id, text: message.content })} testId={`chat-message-edit-${message.id}`} /></>}
        {!imageReply && deleteButton}</div>}
    </div>
  </div>
})

// Commands arrive wrapped in explanation, and pasting the whole reply into a
// terminal runs the explanation too. Each block copies only its own text, read
// from the rendered element so whatever markdown put inside stays exact.
// Links are copied, never opened: model output can point anywhere, and the
// main process would reject the navigation anyway (I12).
function ChatLinkText({ href, children, onCopy }: { href?: string; children: ReactNode; onCopy: (url: string) => void }) {
  const link = inspectChatLink(href, plainText(children))
  if (!link) return <span className="chat-blocked-link" title={href ? `链接不可直接打开：${href}` : undefined}>{children}</span>
  return <button type="button" className="chat-link" title="点击复制网址" onClick={() => onCopy(link.url)} data-testid="chat-link">{children}{link.showHost && <span className="chat-link-host">（{link.host}）</span>}</button>
}

function CodeBlock({ children, onCopy }: { children: ReactNode; onCopy: (text: string) => Promise<boolean> }) {
  const block = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    const text = (block.current?.textContent ?? '').replace(/\n$/, '')
    if (await onCopy(text)) setCopied(true)
  }
  return <div className="chat-code"><div className="chat-code-head"><span>{codeLanguage(children)}</span><Button size="xs" variant="ghost" icon={copied ? Check : Copy} aria-label={copied ? '已复制' : '复制这段'} title="只复制这一段" onClick={() => void copy()} testId="chat-code-copy">{copied ? '已复制' : '复制'}</Button></div><pre ref={block}>{children}</pre></div>
}

// Fenced blocks arrive as <code class="language-xxx">; the tag is whatever the
// model wrote after the backticks, so it is shown as text and never trusted.
function codeLanguage(children: ReactNode) {
  const className = isValidElement<{ className?: unknown }>(children) && typeof children.props.className === 'string' ? children.props.className : ''
  return /(?:^|\s)language-([\w#+.-]{1,24})(?:\s|$)/.exec(className)?.[1] ?? '代码'
}

// KaTeX escapes every piece of text it emits and, with trust off, emits no
// links or attributes of its own choosing, so its MathML can go in as markup.
// A formula it cannot read stays as the text the model wrote.
function ChatFormula({ math }: { math: ChatMath }) {
  const html = useMemo(() => renderChatMath(math), [math.tex, math.display])
  if (html === null) return <code className="chat-math-raw" title="公式无法显示，已保留原文">{math.source}</code>
  return <span className={math.display ? 'chat-math chat-math-block' : 'chat-math'} dangerouslySetInnerHTML={{ __html: html }} />
}

function ErrorLine({ message, onOpenAccount }: { message?: string; onOpenAccount?: ChatPageProps['onOpenAccount'] }) {
  const action = onOpenAccount ? chatErrorAction(message) : null
  return <p className="chat-message-error" role="alert">{message}{action && <Button size="xs" variant="ghost" onClick={() => onOpenAccount?.(action)} testId={`chat-error-${action}`}>{action === 'recharge' ? '前往充值' : '前往调整额度'}</Button>}</p>
}
