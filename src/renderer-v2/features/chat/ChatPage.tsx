import { Fragment, isValidElement, memo, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { ArrowUp, ArrowUpRight, Brush, Check, ChevronDown, Copy, Download, FileText, Image as ImageIcon, ImagePlus, MoreHorizontal, Pencil, Plus, RefreshCw, SlidersHorizontal, Square, Trash2, X } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AiChatAsset, XingmangApi } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, ChoiceMenu, Confirm, Dialog, Input, Logo, Menu, Pill, SearchInput, Segment, Textarea, useToast } from '../../ui'
import { useLatestRequest } from '../../latest-request'
import { PageLoading } from '../app/PageLoading'
import { canEditImages, canReadImages, chatLimits, createChatApi, inspectModel, noImageEditModelMessage, type ChatApi } from './api'
import { buildChatCatalog, chatErrorAction, chatErrorMessage, chatModelVendor, chatModelVendors, filterConversations, groupConversationsByDay, isConversationTooLongMessage, isGenerating, noImageModelMessage, offlineSendMessage, pendingChatGroups, pickChatGroup, shouldSendOnEnter, shouldShowLengthNotice, type ChatMessage, type ChatMode, type ChatSettings, type ChatWorkspace } from './state'
import { ParametersDialog } from './ParametersDialog'
import { useChatController } from './useChatController'
import { inspectChatLink, plainText } from './links'
import { prepareChatMath, readChatMath, renderChatMath, type ChatMath } from './math'
import { conversationPlainText, loadChatHistory, mergeSessionIntoHistory, type LoadedChatHistory } from './storage'
import './chat.css'

const remarkPlugins = [remarkGfm]
// 点了只填进输入框，不直接发：发一句就要花钱，得让人看一眼再发。
const chatExamples = ['用大白话解释什么是 API Key', '帮我写一个批量重命名文件的脚本', '这段报错是什么意思']
const qualityNames: Record<ChatSettings['quality'], string> = { low: '低', medium: '中', high: '高', auto: '自动' }

export interface ChatPageProps {
  bridge: XingmangApi
  accountScope: string
  active?: boolean
  onOpenAccount?: (tab: 'recharge' | 'keys') => void
  /** 顶部搜索的「聊天参数设置」：为 true 时打开参数对话框，打开后调 onParametersOpened 把它放下。 */
  openParameters?: boolean
  onParametersOpened?: () => void
}
type Confirmation = { kind: 'retry' | 'delete-message' | 'delete-conversation' | 'clear' | 'clear-all' | 'stop'; id?: string; mayStillComplete?: boolean } | null

export function ChatPage({ bridge, accountScope, active = true, onOpenAccount, openParameters, onParametersOpened }: ChatPageProps) {
  const api = useMemo(() => createChatApi(bridge), [bridge])
  return <ChatScope key={accountScope} api={api} scope={accountScope} active={active} onOpenAccount={onOpenAccount} openParameters={openParameters} onParametersOpened={onParametersOpened} />
}

interface ChatScopeProps { api: ChatApi; scope: string; active: boolean; onOpenAccount?: ChatPageProps['onOpenAccount']; openParameters?: boolean; onParametersOpened?: () => void }

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

function ChatView({ api, scope, active, onOpenAccount, openParameters, onParametersOpened, history, onReloadHistory }: ChatScopeProps & { history: LoadedChatHistory; onReloadHistory: (session: () => ChatWorkspace) => Promise<string | undefined> }) {
  const chat = useChatController(api, scope, history, active)
  const toast = useToast()
  const { conversation, preparations } = chat
  const [search, setSearch] = useState('')
  const [confirmationState, setConfirmation] = useState<Confirmation>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [copyFallback, setCopyFallback] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ asset: AiChatAsset; mine: boolean } | null>(null)
  const [stopping, setStopping] = useState(false)
  const [customSize, setCustomSize] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [parametersOpen, setParametersOpen] = useState(false)
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
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      if (list.current) {
        const following = lastDisplayedConversation.current === conversation.id && stickToBottom.current
        list.current.scrollTop = following ? list.current.scrollHeight : scrolls.current.get(conversation.id) ?? list.current.scrollHeight
        stickToBottom.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80
        lastDisplayedConversation.current = conversation.id
      }
      const navigation = surface.current?.querySelector<HTMLElement>('.chat-conversation-list')
      if (navigation) navigation.scrollTop = navigationScroll.current
    })
    return () => cancelAnimationFrame(frame)
  }, [conversation.id, active])
  useEffect(() => { if (active && stickToBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight }, [conversation.messages, active])
  useEffect(() => { setCustomSize(false); setEditing(null); setConfirmation(null); setParametersOpen(false) }, [conversation.id])
  // 参数对话框跟着页面走：切走就关掉（没应用的改动不留），跟原来的弹出层一样。
  useEffect(() => { if (!active) setParametersOpen(false) }, [active])
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
  const textMode = conversation.settings.mode === 'text'
  // 聊天时带的图给模型看；生成图片时带的是参考图，照着它改（要模型能改图）。
  const seesImages = Boolean(conversation.settings.model) && (textMode ? canReadImages(conversation.settings.model) : canEditImages(conversation.settings.model))
  const imagesBlocked = draftImages.length > 0 && !seesImages
  const imagesBlockedMessage = textMode ? noImageModelMessage : noImageEditModelMessage
  const attachTitle = !seesImages ? textMode ? '当前模型看不了图片，换一个能看图的模型才能发图' : '这个模型不能照着图片改，换一个能改图的模型才能加图片' : draftImages.length >= chatLimits.imagesPerMessage ? `一条消息最多带 ${chatLimits.imagesPerMessage} 张图片` : textMode ? '加图片（也可以直接粘贴截图）' : '加参考图（也可以直接粘贴截图）'
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const hasImage = [...event.clipboardData.items].some((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (!hasImage) return
    // 截图只在主进程从剪贴板里读，这里只负责拦下默认粘贴。
    event.preventDefault()
    if (pending) return
    if (!seesImages) { chat.setError(imagesBlockedMessage); return }
    void chat.pasteImage()
  }
  const candidates = useMemo(() => active ? filterConversations(chat.state.conversations, search) : [], [active, chat.state.conversations, search])
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
    try { await api.copyText(url); if (ticket()) toast.show('网址已复制，粘贴到浏览器地址栏就能打开', 'ok') }
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
    catch { if (ticket()) chat.setError('图片没有保存成功，可以重试') }
  }
  // Rows are memoized, so they get one stable object that always calls the
  // latest handlers instead of fresh closures that would re-render all of them.
  const latestMessageActions = useRef<MessageActions | null>(null)
  latestMessageActions.current = { copyText: (text, done) => void copyText(text, done), preview: (asset, mine) => setPreview({ asset, mine }), reuseImage: (asset) => void chat.reuseImage(asset), copyAsset: (assetId) => void task(() => api.copyAsset(assetId), '图片已复制'), saveAsset: (assetId) => void saveAsset(assetId), assetMenu: (assetId) => void task(() => api.assetMenu(assetId), ''), confirm: setConfirmation, edit: setEditing, openAccount: (tab) => onOpenAccount?.(tab) }
  const messageActions = useMemo<MessageActions>(() => ({ copyText: (text, done) => latestMessageActions.current?.copyText(text, done), preview: (asset, mine) => latestMessageActions.current?.preview(asset, mine), reuseImage: (asset) => latestMessageActions.current?.reuseImage(asset), copyAsset: (assetId) => latestMessageActions.current?.copyAsset(assetId), saveAsset: (assetId) => latestMessageActions.current?.saveAsset(assetId), assetMenu: (assetId) => latestMessageActions.current?.assetMenu(assetId), confirm: (value) => latestMessageActions.current?.confirm(value), edit: (value) => latestMessageActions.current?.edit(value), openAccount: (tab) => latestMessageActions.current?.openAccount(tab) }), [])
  const exportConversation = async (id: string) => {
    const item = chat.state.conversations.find((candidate) => candidate.id === id)
    if (!item) return
    const ticket = owner.capture()
    try {
      const result = await api.exportText({ title: item.title, text: conversationPlainText(item) })
      if (ticket() && result) chat.setNotice('这段对话已存成文本文件')
    } catch { if (ticket()) chat.setError('这段对话没有导出成功，可以重试') }
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
  const fillExample = (text: string) => {
    chat.setDraft(text)
    const input = surface.current?.querySelector<HTMLTextAreaElement>('#chatIn')
    input?.focus()
    requestAnimationFrame(() => input?.setSelectionRange(text.length, text.length))
  }
  const confirmAction = () => {
    const action = confirmation
    setConfirmation(null)
    if (!action) return
    if (action.kind === 'retry' && action.id) void chat.send({ retryId: action.id })
    if (action.kind === 'delete-message' && action.id) chat.deleteFrom(action.id)
    if (action.kind === 'delete-conversation' && action.id) chat.removeConversation(action.id)
    if (action.kind === 'clear') chat.clearConversation()
    if (action.kind === 'clear-all' && chat.clearAllConversations()) toast.show('对话已清空', 'ok')
    if (action.kind === 'stop') void stop()
  }
  const switchConversation = (id: string) => { if (list.current) scrolls.current.set(conversation.id, list.current.scrollTop); chat.openConversation(id) }
  const onModeChange = (mode: string) => { chat.selectMode(mode as ChatMode); setCustomSize(false) }
  const imageSizes = imageCapability?.sizePolicy.kind === 'allow-list' ? [...imageCapability.sizePolicy.values] : [...new Set(['1024x1024', '1536x1024', '1024x1536', conversation.settings.size])].filter((size) => {
    if (imageCapability?.sizePolicy.kind !== 'divisible') return true
    const policy = imageCapability.sizePolicy
    return size.split('x').every((part) => Number(part) >= policy.min && Number(part) <= policy.max && Number(part) % policy.divisor === 0)
  })
  const selectedModelMissing = conversation.settings.model && !models.includes(conversation.settings.model)
  const selectedGroup = chat.groups.find((group) => group.name === conversation.settings.group)
  // Enter 跟发送按钮同一个条件：按钮灰着时按 Enter 什么都不做，不再弹一句说错原因的红条（#1101 第 3 条）。
  const sendDisabled = !selectedGroup || (!conversation.draft.trim() && (!draftImages.length || !textMode)) || imagesBlocked || chat.attaching || preparation?.phase !== 'ready' || !conversation.settings.model
  const selectedGroupMissing = chat.groupsLoaded && Boolean(conversation.settings.group) && !selectedGroup
  const modelKind = textMode ? '聊天' : '图片'
  // 按钮上写模型；还没得选的时候写卡在哪一步。
  // 原来的分组没了时照旧写着那个模型：下面那句「当前模型已不可用」说的就是它。
  const modelLabel = !chat.groupsLoaded && chat.groupLoading ? '正在读取模型' : conversation.settings.model && (!selectedModelMissing || selectedGroupMissing) ? conversation.settings.model : pendingGroups.size ? '正在准备模型' : !models.length ? '暂无可用模型' : '请选择模型'
  const modelsEmpty = !chat.groupsLoaded && chat.groupLoading ? '正在读取模型' : pendingGroups.size ? '正在准备模型' : allGroupsFailed ? '没读到模型，点「刷新模型」再试' : !chat.groups.length ? '暂无可用模型' : `暂无可用的${modelKind}模型`
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
  const retrySettings = confirmation?.kind === 'retry' ? conversation.messages.find((message) => message.id === confirmation.id)?.settings : undefined
  const confirmTitle = confirmation?.kind === 'retry' ? '重新生成这条回复？' : confirmation?.kind === 'stop' ? '停止等待图片生成？' : confirmation?.kind === 'clear' ? '清空当前对话？' : confirmation?.kind === 'clear-all' ? '清空全部对话？' : confirmation?.kind === 'delete-conversation' ? `删除「${chat.state.conversations.find((item) => item.id === confirmation.id)?.title ?? '新对话'}」？` : '删除这条及之后的消息？'
  const running = chat.state.conversations.some(isGenerating) || Object.values(preparations).some((item) => item.phase === 'loading')
  const anyGenerating = chat.state.conversations.some(isGenerating)
  const searchText = search.trim()
  return <section ref={surface} className="chat-page" hidden={!active} data-testid="page-chat" data-page-id="ai-chat" data-account-scope={scope} onKeyDownCapture={(event) => { if (!active) { event.preventDefault(); event.stopPropagation() } }} onScrollCapture={(event) => { if (active && event.target instanceof HTMLElement && event.target.classList.contains('chat-conversation-list')) navigationScroll.current = event.target.scrollTop }}>
    <aside className="chat-conversations" aria-label="聊天会话">
      <div className="chat-conversations-top"><Button icon={Plus} onClick={chat.newConversation} testId="chat-conversation-new">新对话</Button></div>
      <div className="chat-conversation-search"><SearchInput value={search} onChange={setSearch} placeholder="搜索对话" testId="chat-conversation-search" /></div>
      <nav className="chat-conversation-list" aria-label="已保存的对话">{groupConversationsByDay(candidates).map(({ day, conversations }) => <Fragment key={day}><div className="chat-conversation-day">{day}</div>{conversations.map((item) => <div key={item.id} className="chat-conversation-item" data-active={item.id === chat.state.activeId}><button type="button" className="chat-conversation-select" onClick={() => switchConversation(item.id)} aria-current={item.id === chat.state.activeId ? 'page' : undefined} title={item.title} data-testid={`chat-conversation-${item.id}`}><strong>{item.title}</strong><span>{isGenerating(item) ? '正在回答…' : `${item.messages.length} 条消息`}</span></button><Menu key={active ? 'active' : 'hidden'} label="对话操作" anchor={<Button variant="ghost" size="xs" icon={MoreHorizontal} aria-label={`「${item.title}」更多操作`} title="对话操作" />} items={[{ label: '导出这段对话', icon: FileText, disabled: isGenerating(item) || !item.messages.length, onSelect: () => void exportConversation(item.id) }, 'divider', { label: '删除这段对话…', icon: Trash2, danger: true, disabled: isGenerating(item), onSelect: () => setConfirmation({ kind: 'delete-conversation', id: item.id }) }]} /></div>)}</Fragment>)}{candidates.length === 0 && (searchText ? <p className="chat-conversation-empty" data-testid="chat-conversation-search-empty">没有找到「{searchText}」相关的对话</p> : <p className="chat-conversation-empty" data-testid="chat-conversation-empty">{chat.historyUnreadable ? '以前的对话暂时读不出来' : '聊过的对话会存在这里'}</p>)}</nav>
      {chat.state.conversations.length > 1 && <div className="chat-conversations-foot"><Button variant="ghost" size="xs" icon={Trash2} disabled={anyGenerating} onClick={() => setConfirmation({ kind: 'clear-all' })} testId="chat-conversations-clear">清空全部对话</Button></div>}
    </aside>
    <div className="chat-conversation">
      <header className="chat-bar"><strong title={conversation.title}>{chat.state.activeId ? conversation.title : '聊天'}</strong><div className="chat-bar-actions"><Button icon={SlidersHorizontal} variant="ghost" size="sm" aria-label="参数设置" title="参数设置" onClick={() => setParametersOpen(true)} testId="chat-parameters-open" /><Button icon={Trash2} variant="ghost" size="sm" aria-label="清空对话" title="清空对话" disabled={pending || !conversation.messages.length} onClick={() => setConfirmation({ kind: 'clear' })} testId="chat-conversation-clear" /><Button icon={FileText} variant="ghost" size="sm" aria-label="导出这段对话" title="导出这段对话" disabled={pending || !conversation.messages.length} onClick={() => void exportConversation(conversation.id)} testId="chat-conversation-export" /></div></header>
      {(chat.groupError || chat.error || chat.notice || chat.storageError || preparationWarning) && <div className="chat-banner" data-tone={chat.groupError || chat.error || chat.storageError ? 'bad' : 'neutral'} role={chat.groupError || chat.error || chat.storageError ? 'alert' : 'status'}><span>{chat.storageError || chat.groupError || chat.error || chat.notice || preparationWarning}</span>{chat.historyUnreadable && chat.storageError && <Button size="xs" icon={RefreshCw} loading={reloading} disabled={running} onClick={() => void reloadHistory()} testId="chat-history-reload">重新读取</Button>}{chat.groupError && <Button size="xs" icon={RefreshCw} onClick={() => void chat.refreshGroups()} testId="chat-groups-retry">重试</Button>}{!chat.groupError && !chat.storageError && chat.error === offlineSendMessage && <Button size="xs" icon={RefreshCw} disabled={pending} onClick={() => void chat.retryOfflineSend()} testId="chat-send-retry">重试</Button>}{!chat.groupError && !chat.storageError && isConversationTooLongMessage(chat.error) && <Button size="xs" variant="primary" icon={Plus} onClick={chat.continueInNew} testId="chat-continue-new">带着这句话开新对话</Button>}{!chat.groupError && !chat.storageError && !preparationWarning && <Button variant="ghost" size="xs" icon={X} aria-label="关闭提示" title="关闭提示" onClick={() => { chat.setError(''); chat.setNotice('') }} />}</div>}
      <div className="chat-messages" ref={list} aria-label="消息记录" onScroll={(event) => { if (!active) return; const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; scrolls.current.set(conversation.id, element.scrollTop) }}>
        {!conversation.messages.length && <div className="chat-empty" data-testid="chat-empty"><Logo kind="symbol" height={56} /><h2>有什么想问的？</h2><p>不开终端，直接和模型对话。额度与工具共用同一个账号。</p>{textMode && !conversation.draft.trim() && <div className="chat-empty-examples">{chatExamples.map((text, index) => <Button key={text} size="sm" onClick={() => fillExample(text)} testId={`chat-example-${index + 1}`}>{text}</Button>)}</div>}</div>}
        {conversation.messages.map((message) => <ChatMessageItem key={message.id} message={message} model={message.settings?.model ?? conversation.settings.model} pending={pending} canRetry={chat.groups.some((group) => group.name === (message.settings?.group ?? conversation.settings.group))} canOpenAccount={Boolean(onOpenAccount)} markdownComponents={markdownComponents} replyComponents={replyComponents} actions={messageActions} />)}
      </div>
      <div className="chat-composer">
        {shouldShowLengthNotice(conversation) && !isConversationTooLongMessage(chat.error) && <div className="chat-length-notice" role="status" data-testid="chat-length-notice"><span>这段对话已经很长了。每发一句，前面的内容都会一起发给 AI，对话越长，每次回复一般花得越多、也越慢。要换个话题，点「新对话」接着聊，刚写的话会一起带过去。</span><Button size="xs" icon={Plus} disabled={pending} onClick={chat.continueInNew} testId="chat-length-new">新对话</Button><Button size="xs" variant="ghost" onClick={chat.dismissLengthNotice} testId="chat-length-dismiss">知道了</Button></div>}
        {selectedGroupMissing && <p className="chat-message-error" role="alert" data-testid="chat-group-unavailable">当前模型已不可用，请换一个模型。已保存的消息和草稿继续保留。</p>}{allGroupsFailed && <p className="chat-message-error" role="alert">{preparations[failedGroups[0].name]?.error}</p>}{!allGroupsFailed && failedGroups.length > 0 && !pendingGroups.size && <p className="chat-hint" data-testid="chat-groups-partly-failed">有几个分组的模型没读到，可以点模型菜单里的「刷新模型」再试。</p>}{chat.groups.length > 0 && !pendingGroups.size && !allGroupsFailed && models.length === 0 && <p className="chat-hint">暂无可用的{modelKind}模型</p>}
        {draftImages.length > 0 && <div className="chat-draft-images" data-testid="chat-draft-images">{draftImages.map((image) => <div className="chat-draft-image" key={image.assetId}><img src={image.localUrl} alt="要发的图片" onError={(event) => { event.currentTarget.dataset.failed = 'true' }} /><Button size="xs" variant="ghost" icon={X} aria-label="去掉这张图片" title="去掉这张图片" disabled={pending} onClick={() => chat.removeImage(image.assetId)} testId="chat-draft-image-remove" /></div>)}</div>}
        {imagesBlocked && <p className="chat-message-error" role="alert" data-testid="chat-images-unsupported">{imagesBlockedMessage}</p>}
        <div className="chat-compose-box">
          <Textarea id="chatIn" aria-label={conversation.settings.mode === 'image' ? '图片描述' : '消息内容'} value={conversation.draft} onChange={(event) => chat.setDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (shouldSendOnEnter(event.nativeEvent, composing.current)) { event.preventDefault(); if (!pending && !sendDisabled) void chat.send() } }} onPaste={onPaste} rows={1} maxLength={40000} placeholder={conversation.settings.mode === 'image' ? '描述你想要的画面，比如：星空下的山野，一轮金色落日' : seesImages ? '输入消息，Enter 发送，也可以粘贴截图' : '输入消息，Enter 发送'} testId="chat-composer-input" />
          {/* 切走时菜单跟着关：重新挂一遍，开着的弹出层随之收起，回来时不会还悬在那里。 */}
          <div className="chat-compose-bar" key={active ? 'active' : 'hidden'}>
            <Segment options={[{ value: 'text', label: '文本对话' }, { value: 'image', label: '生成图片' }]} value={conversation.settings.mode} onChange={onModeChange} testId="chat-mode" />
            <span className="chat-model-picker"><ChoiceMenu label="模型" align="start" onOpen={chat.refreshOnInteraction} anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title={[conversation.settings.group, conversation.settings.model].filter(Boolean).join(' · ') || undefined} disabled={!chat.groupsLoaded && chat.groupLoading} data-group={conversation.settings.group} data-model={conversation.settings.model} data-preparing={preparing} testId="chat-model"><span aria-hidden="true"><BrandIcon model={conversation.settings.model} size={16} /></span><span className="chat-model-name">{modelLabel}</span></Button>} sections={modelSections} actions={[{ label: '刷新模型', icon: RefreshCw, loading: preparing, keepOpen: true, onSelect: () => void refreshModels(), testId: 'chat-group-prepare' }]} /></span>
            {conversation.settings.mode === 'image' && imageCapability && <>
              <ChoiceMenu label="尺寸" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="尺寸" data-value={customSize ? 'custom' : conversation.settings.size} testId="chat-image-size">{customSize ? '自定义尺寸' : conversation.settings.size === 'auto' ? '自动尺寸' : conversation.settings.size.replace('x', ' × ')}</Button>} sections={[{ label: '尺寸', value: customSize ? 'custom' : conversation.settings.size, options: [...imageSizes.map((size) => ({ value: size, label: size === 'auto' ? '自动尺寸' : size.replace('x', ' × ') })), ...(imageCapability.sizePolicy.kind === 'divisible' ? [{ value: 'custom', label: '自定义尺寸' }] : [])], onChange: (value) => { setCustomSize(value === 'custom'); if (value !== 'custom') chat.changeSettings({ size: value }) } }]} />
              {imageCapability.qualities.length > 0 && <ChoiceMenu label="画质" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="画质" data-value={conversation.settings.quality} testId="chat-image-quality">画质：{qualityNames[conversation.settings.quality]}</Button>} sections={[{ label: '画质', value: conversation.settings.quality, options: imageCapability.qualities.map((quality) => ({ value: quality, label: qualityNames[quality] })), onChange: (value) => chat.changeSettings({ quality: value as ChatSettings['quality'] }) }]} />}
              {imageCapability.resolutions.length > 1 && <ChoiceMenu label="分辨率" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="分辨率" data-value={conversation.settings.imageResolution} testId="chat-image-resolution">分辨率：{conversation.settings.imageResolution}</Button>} sections={[{ label: '分辨率', value: conversation.settings.imageResolution, options: imageCapability.resolutions.map((resolution) => ({ value: resolution, label: resolution })), onChange: (value) => chat.changeSettings({ imageResolution: value as ChatSettings['imageResolution'] }) }]} />}
              {customSize && imageCapability.sizePolicy.kind === 'divisible' && <span className="chat-image-custom"><Input type="number" aria-label="图片宽度" min={imageCapability.sizePolicy.min} max={imageCapability.sizePolicy.max} step={imageCapability.sizePolicy.divisor} value={conversation.settings.size.split('x')[0]} onChange={(event) => chat.changeSettings({ size: `${event.target.value}x${conversation.settings.size.split('x')[1]}` })} /><span>×</span><Input type="number" aria-label="图片高度" min={imageCapability.sizePolicy.min} max={imageCapability.sizePolicy.max} step={imageCapability.sizePolicy.divisor} value={conversation.settings.size.split('x')[1]} onChange={(event) => chat.changeSettings({ size: `${conversation.settings.size.split('x')[0]}x${event.target.value}` })} /></span>}
            </>}
            <span className="chat-compose-spacer" />
            <Button variant="ghost" size="sm" icon={ImagePlus} aria-label="加图片" title={attachTitle} loading={chat.attaching} disabled={pending || !seesImages || draftImages.length >= chatLimits.imagesPerMessage} onClick={() => void chat.pickImages()} testId="chat-attach-image" />
            {pending ? <Button size="sm" icon={Square} aria-label="停止生成" title="停止生成" loading={stopping} onClick={() => { if (activeRequest?.settings?.mode === 'image') setConfirmation({ kind: 'stop' }); else void stop() }} testId="chat-stop" /> : <Button variant="primary" size="sm" icon={conversation.settings.mode === 'image' ? ImageIcon : ArrowUp} aria-label={conversation.settings.mode === 'image' ? '生成图片' : '发送消息'} title={conversation.settings.mode === 'image' ? '生成图片' : '发送消息'} disabled={sendDisabled} onClick={() => void chat.send()} testId="chat-send" />}
          </div>
        </div>
        <div className="chat-compose-foot"><span>回答由模型生成，可能有误，重要内容请核对。<span data-testid="chat-cost-note">{draftImages.length ? textMode ? '按实际用量计费，带图片的提问会更贵一些。' : '按实际用量计费，带参考图的会更贵一些。' : textMode ? '按实际用量计费，回复越长花得越多。' : '按实际用量计费。'}</span></span>{pending && <Pill tone="accent">正在生成</Pill>}</div>
      </div>
    </div>
    {confirmation && <Confirm title={confirmTitle} body={confirmation.kind === 'retry' ? <><p>{confirmation.mayStillComplete ? '上次请求可能仍在服务端处理。' : ''}重新生成会发起新的付费请求，并替换这条及之后的回复。</p>{retrySettings && <p>{retrySettings.group} · {retrySettings.model}</p>}</> : confirmation.kind === 'stop' ? <p>停止等待后服务端仍可能继续生成图片并计费。已产生的费用不会自动退回。</p> : confirmation.kind === 'clear-all' ? <p>聊天记录会从这台电脑上全部删掉，找不回来。用量账单不受影响。</p> : confirmation.kind === 'delete-conversation' ? <p>这段对话会从这台电脑上删掉，找不回来。已产生的用量不会改变。</p> : <p>将移除对应的本地消息记录，无法撤销。已产生的用量不会改变。</p>} okLabel={confirmation.kind === 'retry' ? '重新生成' : confirmation.kind === 'stop' ? '停止等待' : confirmation.kind === 'clear-all' ? '全部清空' : confirmation.kind === 'delete-conversation' ? '删除' : '确认删除'} danger={confirmation.kind !== 'retry'} requireAck={confirmation.mayStillComplete || confirmation.kind === 'stop'} onOk={confirmAction} onClose={() => setConfirmation(null)} testId="chat-confirm" />}
    {active && parametersOpen && <ParametersDialog key={conversation.id} settings={conversation.settings} onApply={(patch) => { chat.changeSettings(patch); setParametersOpen(false); toast.show('参数已应用到当前对话', 'ok') }} onClose={() => setParametersOpen(false)} />}
    {active && editing && <Dialog open title="编辑消息" subtitle="修改后重新发送，将移除这条消息之后的回复，并产生新的请求用量。" width={480} onClose={() => setEditing(null)} dirty={editing.text !== conversation.messages.find((message) => message.id === editing.id)?.content} footer={<><Button onClick={() => setEditing(null)}>取消</Button><Button variant="primary" icon={ArrowUp} disabled={!editing.text.trim()} onClick={() => { const value = editing; setEditing(null); void chat.send({ editId: value.id, prompt: value.text }) }} testId="chat-edit-send">修改并重发</Button></>} testId="chat-edit-dialog"><Textarea label="消息内容" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} rows={8} maxLength={40000} testId="chat-edit-input" /></Dialog>}
    {active && copyFallback !== null && <Dialog open title="手动复制内容" subtitle="无法访问剪贴板，选中文字后使用系统复制操作。" width={640} onClose={() => setCopyFallback(null)} footer={<Button variant="primary" onClick={() => setCopyFallback(null)}>关闭</Button>} testId="chat-copy-fallback"><Textarea label="待复制内容" value={copyFallback} readOnly rows={12} onFocus={(event) => event.currentTarget.select()} /></Dialog>}
    {active && preview && <Dialog open title={preview.mine ? '你发的图片' : '生成的图片'} width={640} onClose={() => setPreview(null)} footer={<><Button icon={Copy} onClick={() => void task(() => api.copyAsset(preview.asset.assetId), '图片已复制')}>复制图片</Button><Button icon={Download} onClick={() => void saveAsset(preview.asset.assetId)}>另存图片</Button><Button icon={ArrowUpRight} onClick={() => void task(() => api.assetMenu(preview.asset.assetId), '')}>更多操作</Button></>} testId="chat-image-preview"><img className="chat-preview-image" src={preview.asset.localUrl} alt={preview.mine ? '你发的图片' : preview.asset.revisedPrompt || '生成的图片'} /></Dialog>}
  </section>
}

interface MessageActions { copyText: (text: string, done?: string) => void; preview: (asset: AiChatAsset, mine: boolean) => void; reuseImage: (asset: AiChatAsset) => void; copyAsset: (assetId: string) => void; saveAsset: (assetId: string) => void; assetMenu: (assetId: string) => void; confirm: (confirmation: NonNullable<Confirmation>) => void; edit: (editing: { id: string; text: string }) => void; openAccount: NonNullable<ChatPageProps['onOpenAccount']> }
interface ChatMessageItemProps { message: ChatMessage; model: string; pending: boolean; canRetry: boolean; canOpenAccount: boolean; markdownComponents: Components; replyComponents: Components; actions: MessageActions }

// Every keystroke in the composer rewrites the conversation's draft. Messages
// keep their object identity through that, so a memoized row skips parsing its
// markdown again; without it a long conversation re-parsed every reply per key.
const ChatMessageItem = memo(function ChatMessageItem({ message, model, pending, canRetry, canOpenAccount, markdownComponents, replyComponents, actions }: ChatMessageItemProps) {
  return <div className="chat-message" data-role={message.role} data-status={message.status} data-testid={`chat-message-${message.id}`}>
    {message.role === 'assistant' && <span className="chat-avatar"><BrandIcon model={model} size={18} /></span>}
    <div className="chat-message-main">
      {message.reasoning && <details className="chat-reasoning"><summary>思考过程 <ChevronDown size={13} aria-hidden="true" /></summary><div>{message.reasoning}</div><Button icon={Copy} size="xs" variant="ghost" aria-label="复制思考过程" title="复制思考过程" onClick={() => actions.copyText(message.reasoning)} /></details>}
      {(message.content || message.assets?.length || message.status === 'pending' || message.status === 'streaming') && <div className="chat-bubble">{message.content ? message.role === 'assistant' ? <ReactMarkdown remarkPlugins={remarkPlugins} components={replyComponents}>{prepareChatMath(message.content)}</ReactMarkdown> : <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>{message.content}</ReactMarkdown> : (message.status === 'pending' || message.status === 'streaming') && <span className="chat-generating" role="status"><RefreshCw size={15} aria-hidden="true" />{message.settings?.mode === 'image' ? '正在生成图片' : message.reasoning ? '正在思考' : '正在生成'}</span>}
        {message.assets?.map((asset) => <div className="chat-asset" key={asset.assetId}><button type="button" className="chat-asset-preview" aria-label={message.role === 'user' ? '查看图片' : '查看生成图片'} onClick={() => actions.preview(asset, message.role === 'user')} onContextMenu={(event) => { event.preventDefault(); actions.assetMenu(asset.assetId) }}><img src={asset.localUrl} alt={message.role === 'user' ? '你发的图片' : asset.revisedPrompt || '生成的图片'} onError={(event) => { event.currentTarget.dataset.failed = 'true'; event.currentTarget.alt = '预览暂不可用，仍可尝试复制或另存图片' }} /></button><div className="chat-asset-actions">{message.role === 'assistant' && <Button size="xs" icon={Brush} variant="ghost" aria-label="拿这张接着改" title="拿这张接着改" disabled={pending} onClick={() => actions.reuseImage(asset)} testId="chat-asset-reuse" />}<Button size="xs" icon={Copy} variant="ghost" aria-label="复制图片" title="复制图片" onClick={() => actions.copyAsset(asset.assetId)} testId="chat-asset-copy" /><Button size="xs" icon={Download} variant="ghost" aria-label="另存图片" title="另存图片" onClick={() => actions.saveAsset(asset.assetId)} testId="chat-asset-save" /><Button size="xs" icon={MoreHorizontal} variant="ghost" aria-label="图片更多操作" title="图片更多操作" onClick={() => actions.assetMenu(asset.assetId)} testId="chat-asset-menu" />{asset.width && asset.height && <small>{asset.width} × {asset.height}</small>}</div></div>)}
      </div>}
      {message.status === 'error' && <ErrorLine message={message.error} onOpenAccount={canOpenAccount ? actions.openAccount : undefined} />}{message.status === 'canceled' && <p className="chat-message-note">{message.mayStillComplete ? '已停止等待，服务端仍可能处理并计费' : '已停止生成，保留已返回的内容'}</p>}
      <div className="chat-message-tools">{message.role === 'assistant'
        ? <>{message.content && <Button size="xs" icon={Copy} variant="ghost" aria-label="复制回答" title="复制回答" onClick={() => actions.copyText(message.content, '回答已复制')} testId={`chat-message-copy-${message.id}`} />}<Button size="xs" icon={RefreshCw} variant="ghost" aria-label="重新生成" title="重新生成" disabled={pending || !canRetry} onClick={() => actions.confirm({ kind: 'retry', id: message.id, mayStillComplete: message.mayStillComplete })} testId={`chat-message-retry-${message.id}`} /></>
        : <>{message.content && <Button size="xs" icon={Copy} variant="ghost" aria-label="复制" title="复制" onClick={() => actions.copyText(message.content)} testId={`chat-message-copy-${message.id}`} />}<Button size="xs" icon={Pencil} variant="ghost" aria-label="编辑后重新发送" title="编辑后重新发送" disabled={pending} onClick={() => actions.edit({ id: message.id, text: message.content })} testId={`chat-message-edit-${message.id}`} /></>}
        <Button size="xs" icon={Trash2} variant="ghost" aria-label="删除消息" title="删除消息" disabled={pending} onClick={() => actions.confirm({ kind: 'delete-message', id: message.id })} testId={`chat-message-delete-${message.id}`} /></div>
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
  return <button type="button" className="chat-link" title="点一下复制网址" onClick={() => onCopy(link.url)} data-testid="chat-link">{children}{link.showHost && <span className="chat-link-host">（{link.host}）</span>}</button>
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
  if (html === null) return <code className="chat-math-raw" title="这个公式没能显示，保留原文">{math.source}</code>
  return <span className={math.display ? 'chat-math chat-math-block' : 'chat-math'} dangerouslySetInnerHTML={{ __html: html }} />
}

function ErrorLine({ message, onOpenAccount }: { message?: string; onOpenAccount?: ChatPageProps['onOpenAccount'] }) {
  const action = onOpenAccount ? chatErrorAction(message) : null
  return <p className="chat-message-error" role="alert">{message}{action && <Button size="xs" variant="ghost" onClick={() => onOpenAccount?.(action)} testId={`chat-error-${action}`}>{action === 'recharge' ? '去充值' : '去调额度'}</Button>}</p>
}
