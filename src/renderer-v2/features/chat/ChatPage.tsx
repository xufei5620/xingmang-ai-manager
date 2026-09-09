import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ArrowUpRight, ChevronDown, Copy, Download, Image as ImageIcon, MessageSquare, MoreHorizontal, Pencil, Plus, RefreshCw, Search, SlidersHorizontal, Square, Trash2, User, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AiChatAsset, XingmangApi } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Confirm, Dialog, Empty, Input, Menu, Pill, Popover, SearchInput, Segment, Select, Textarea } from '../../ui'
import { createChatApi, inspectModel, type ChatApi } from './api'
import { chatErrorMessage, isGenerating, shouldSendOnEnter, type ChatMessage, type ChatMode } from './state'
import { ParametersPanel } from './ParametersPanel'
import { useChatController } from './useChatController'
import './chat.css'

export interface ChatPageProps { bridge: XingmangApi; accountScope: string; active?: boolean }
type Confirmation = { kind: 'retry' | 'delete-message' | 'delete-conversation' | 'clear' | 'stop'; id?: string; mayStillComplete?: boolean } | null

export function ChatPage({ bridge, accountScope, active = true }: ChatPageProps) {
  const api = useMemo(() => createChatApi(bridge), [bridge])
  return <ChatScope key={accountScope} api={api} scope={accountScope} active={active} />
}

function ChatScope({ api, scope, active }: { api: ChatApi; scope: string; active: boolean }) {
  const chat = useChatController(api, scope, active)
  const { conversation, preparations } = chat
  const [search, setSearch] = useState('')
  const [confirmationState, setConfirmation] = useState<Confirmation>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [copyFallback, setCopyFallback] = useState<string | null>(null)
  const [preview, setPreview] = useState<AiChatAsset | null>(null)
  const [stopping, setStopping] = useState(false)
  const [customSize, setCustomSize] = useState(false)
  const composing = useRef(false)
  const surface = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const navigationScroll = useRef(0)
  const lastDisplayedConversation = useRef<string | null>(null)
  const scrolls = useRef(new Map<string, number>())
  const stickToBottom = useRef(true)
  const owner = useRef(0)
  useEffect(() => () => { owner.current++ }, [])
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
  useEffect(() => { setCustomSize(false); setEditing(null); setConfirmation(null) }, [conversation.id])
  const pending = isGenerating(conversation)
  const activeRequest = conversation.messages.find((message) => message.status === 'pending' || message.status === 'streaming')
  const preparation = preparations[conversation.settings.group]
  const models = (preparation?.models ?? []).filter((model) => inspectModel(model).kind === (conversation.settings.mode === 'image' ? 'image' : 'chat'))
  const capability = conversation.settings.model ? inspectModel(conversation.settings.model) : null
  const imageCapability = capability?.kind === 'image' ? capability : null
  const candidates = active ? chat.state.conversations.filter((item) => `${item.title} ${item.messages.map((message) => message.content).join(' ')}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : []
  const task = async (work: () => Promise<unknown>, done: string) => {
    const ticket = owner.current
    try { await work(); if (ticket === owner.current) chat.setNotice(done) }
    catch (reason) { if (ticket === owner.current) chat.setError(chatErrorMessage(reason)) }
  }
  const copyText = async (text: string) => {
    const ticket = owner.current
    try { await api.copyText(text); if (ticket === owner.current) chat.setNotice('内容已复制') }
    catch { if (ticket === owner.current) setCopyFallback(text) }
  }
  const saveAsset = async (assetId: string) => {
    const ticket = owner.current
    try { const result = await api.saveAsset(assetId); if (ticket === owner.current && result.saved) chat.setNotice('图片已保存') }
    catch { if (ticket === owner.current) chat.setError('图片没有保存成功，可以重试') }
  }
  const stop = async () => { const ticket = owner.current; setStopping(true); await chat.stop(); if (owner.current === ticket) setStopping(false) }
  const confirmAction = () => {
    const action = confirmation
    setConfirmation(null)
    if (!action) return
    if (action.kind === 'retry' && action.id) void chat.send({ retryId: action.id })
    if (action.kind === 'delete-message' && action.id) chat.deleteFrom(action.id)
    if (action.kind === 'delete-conversation' && action.id) chat.removeConversation(action.id)
    if (action.kind === 'clear') chat.clearConversation()
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
  const selectedGroupMissing = chat.groupsLoaded && Boolean(conversation.settings.group) && !selectedGroup
  const groupOptions = [...(!conversation.settings.group && chat.groups.length ? [{ value: '', label: '请选择分组', disabled: true }] : []), ...(selectedGroupMissing ? [{ value: conversation.settings.group, label: `${conversation.settings.group}（不可用）`, disabled: true }] : []), ...chat.groups.map((group) => ({ value: group.name, label: group.name }))]
  const confirmation = active ? confirmationState : null
  const retrySettings = confirmation?.kind === 'retry' ? conversation.messages.find((message) => message.id === confirmation.id)?.settings : undefined
  const running = chat.state.conversations.some(isGenerating) || Object.values(preparations).some((item) => item.phase === 'loading')
  const unsaved = Boolean(chat.state.draftConversation.draft.trim() || chat.state.conversations.some((item) => item.draft.trim()) || (editing && editing.text !== conversation.messages.find((message) => message.id === editing.id)?.content) || chat.storageError)
  return <section ref={surface} className="chat-page" hidden={!active} data-testid="page-chat" data-page-id="ai-chat" data-account-scope={scope} data-busy={running} data-unsaved={unsaved} onKeyDownCapture={(event) => { if (!active) { event.preventDefault(); event.stopPropagation() } }} onScrollCapture={(event) => { if (active && event.target instanceof HTMLElement && event.target.classList.contains('chat-conversation-list')) navigationScroll.current = event.target.scrollTop }}>
    <aside className="chat-conversations" aria-label="聊天会话">
      <div className="chat-conversations-top"><Button icon={Plus} onClick={chat.newConversation} testId="chat-conversation-new">新对话</Button></div>
      {(chat.state.conversations.length > 4 || search) && <div className="chat-conversation-search"><SearchInput value={search} onChange={setSearch} placeholder="搜索对话" testId="chat-conversation-search" /></div>}
      <nav className="chat-conversation-list" aria-label="已保存的对话">{candidates.map((item) => <div key={item.id} className="chat-conversation-item" data-active={item.id === chat.state.activeId}><button type="button" className="chat-conversation-select" onClick={() => switchConversation(item.id)} aria-current={item.id === chat.state.activeId ? 'page' : undefined} title={item.title} data-testid={`chat-conversation-${item.id}`}><strong>{item.title}</strong><span>{isGenerating(item) ? '正在生成' : new Date(item.updatedAt).toLocaleDateString('zh-CN')} · {item.messages.length} 条</span></button><Menu label="对话操作" anchor={<Button variant="ghost" size="xs" icon={MoreHorizontal} aria-label={`管理对话 ${item.title}`} title="对话操作" />} items={[{ label: '删除对话', icon: Trash2, danger: true, disabled: isGenerating(item), onSelect: () => setConfirmation({ kind: 'delete-conversation', id: item.id }) }]} /></div>)}{candidates.length === 0 && <Empty icon={search ? Search : MessageSquare} title={search ? '没找到相关对话' : '还没有对话'} description={search ? '换个词再试试' : ''} />}</nav>
    </aside>
    <div className="chat-conversation">
      <header className="chat-bar"><strong title={conversation.title}>{chat.state.activeId ? conversation.title : '聊天'}</strong><div className="chat-bar-actions">{active && <Popover label="参数设置" title="参数设置" anchor={<Button icon={SlidersHorizontal} variant="ghost" size="sm" aria-label="参数设置" title="参数设置" testId="chat-parameters-open" />}><ParametersPanel key={conversation.id} settings={conversation.settings} onChange={chat.changeSettings} /></Popover>}<Button icon={Trash2} variant="ghost" size="sm" aria-label="清空对话" title="清空对话" disabled={pending || !conversation.messages.length} onClick={() => setConfirmation({ kind: 'clear' })} testId="chat-conversation-clear" /></div></header>
      {(chat.groupError || chat.error || chat.notice || chat.storageError || preparation?.warning) && <div className="chat-banner" data-tone={chat.groupError || chat.error || chat.storageError ? 'bad' : 'neutral'} role={chat.groupError || chat.error || chat.storageError ? 'alert' : 'status'}><span>{chat.groupError || chat.error || chat.storageError || chat.notice || preparation?.warning}</span>{chat.groupError && <Button size="xs" icon={RefreshCw} onClick={() => void chat.refreshGroups()} testId="chat-groups-retry">重试</Button>}{!chat.groupError && !chat.storageError && !preparation?.warning && <Button variant="ghost" size="xs" icon={X} aria-label="关闭提示" title="关闭提示" onClick={() => { chat.setError(''); chat.setNotice('') }} />}</div>}
      <div className="chat-messages" ref={list} aria-label="消息记录" onScroll={(event) => { if (!active) return; const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; scrolls.current.set(conversation.id, element.scrollTop) }}>
        {!conversation.messages.length && <Empty icon={MessageSquare} title="开始一段新对话" description="" />}
        {conversation.messages.map((message) => <div key={message.id} className="chat-message" data-role={message.role} data-status={message.status} data-testid={`chat-message-${message.id}`}>
          <span className="chat-avatar">{message.role === 'user' ? <User size={15} aria-hidden="true" /> : <BrandIcon model={message.settings?.model ?? conversation.settings.model} size={18} />}</span>
          <div className="chat-message-main">
            {message.reasoning && <details className="chat-reasoning"><summary>思考过程 <ChevronDown size={13} aria-hidden="true" /></summary><div>{message.reasoning}</div><Button icon={Copy} size="xs" variant="ghost" aria-label="复制思考过程" title="复制思考过程" onClick={() => void copyText(message.reasoning)} /></details>}
            <div className="chat-bubble">{message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void task(() => api.openExternal(href), '已在浏览器打开') }}>{children}</a>, img: ({ alt }) => <span>{alt ?? '图片链接'}</span> }}>{message.content}</ReactMarkdown> : (message.status === 'pending' || message.status === 'streaming') && <span className="chat-generating" role="status"><RefreshCw size={15} aria-hidden="true" />{message.settings?.mode === 'image' ? '正在生成图片' : message.reasoning ? '正在思考' : '正在生成'}</span>}
              {message.assets?.map((asset) => <div className="chat-asset" key={asset.assetId}><button type="button" className="chat-asset-preview" aria-label="查看生成图片" onClick={() => setPreview(asset)} onContextMenu={(event) => { event.preventDefault(); void task(() => api.assetMenu(asset.assetId), '') }}><img src={asset.localUrl} alt={asset.revisedPrompt || '生成的图片'} onError={(event) => { event.currentTarget.dataset.failed = 'true'; event.currentTarget.alt = '预览暂不可用，仍可尝试复制或另存图片' }} /></button><div className="chat-asset-actions"><Button size="xs" icon={Copy} variant="ghost" aria-label="复制图片" title="复制图片" onClick={() => void task(() => api.copyAsset(asset.assetId), '图片已复制')} testId="chat-asset-copy" /><Button size="xs" icon={Download} variant="ghost" aria-label="另存图片" title="另存图片" onClick={() => void saveAsset(asset.assetId)} testId="chat-asset-save" /><Button size="xs" icon={MoreHorizontal} variant="ghost" aria-label="图片更多操作" title="图片更多操作" onClick={() => void task(() => api.assetMenu(asset.assetId), '')} testId="chat-asset-menu" />{asset.width && asset.height && <small>{asset.width} × {asset.height}</small>}</div></div>)}
            </div>
            {message.status === 'error' && <p className="chat-message-error" role="alert">{message.error}</p>}{message.status === 'canceled' && <p className="chat-message-note">{message.mayStillComplete ? '已停止等待，服务端仍可能处理并计费' : '已停止生成，保留已返回的内容'}</p>}
            <div className="chat-message-tools">{message.content && <Button size="xs" icon={Copy} variant="ghost" aria-label="复制内容" title="复制内容" onClick={() => void copyText(message.content)} />}{message.role === 'assistant' ? <Button size="xs" icon={RefreshCw} variant="ghost" aria-label="重新生成" title="重新生成" disabled={pending || !chat.groups.some((group) => group.name === (message.settings?.group ?? conversation.settings.group))} onClick={() => setConfirmation({ kind: 'retry', id: message.id, mayStillComplete: message.mayStillComplete })} testId={`chat-message-retry-${message.id}`} /> : <Button size="xs" icon={Pencil} variant="ghost" aria-label="编辑消息" title="编辑消息" disabled={pending} onClick={() => setEditing({ id: message.id, text: message.content })} testId={`chat-message-edit-${message.id}`} />}<Button size="xs" icon={Trash2} variant="ghost" aria-label="删除消息" title="删除消息" disabled={pending} onClick={() => setConfirmation({ kind: 'delete-message', id: message.id })} testId={`chat-message-delete-${message.id}`} /></div>
          </div>
        </div>)}
      </div>
      <div className="chat-composer">
        <div className="chat-compose-options"><Segment options={[{ value: 'text', label: '文本对话' }, { value: 'image', label: '生成图片' }]} value={conversation.settings.mode} onChange={onModeChange} testId="chat-mode" /><Select aria-label="分组" title={selectedGroup?.description || selectedGroup?.name} options={groupOptions.length ? groupOptions : [{ value: '', label: chat.groupLoading ? '正在读取分组' : '暂无可用分组' }]} value={conversation.settings.group} onChange={(event) => chat.selectGroup(event.target.value)} onPointerDown={chat.refreshOnInteraction} onFocus={chat.refreshOnInteraction} onKeyDown={(event) => { if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(event.key)) chat.refreshOnInteraction() }} aria-busy={chat.groupLoading} disabled={!chat.groupsLoaded && chat.groupLoading} testId="chat-group" /><div className="chat-model-select"><BrandIcon model={conversation.settings.model} size={16} /><Select aria-label="模型" value={conversation.settings.model} options={[...(!conversation.settings.model || selectedModelMissing ? [{ value: conversation.settings.model, label: preparation?.phase === 'loading' ? '正在准备模型' : '请选择模型' }] : []), ...models.map((model) => ({ value: model, label: model }))]} onChange={(event) => { chat.selectModel(event.target.value); setCustomSize(false) }} disabled={preparation?.phase !== 'ready' || !models.length} testId="chat-model" /></div><Button icon={RefreshCw} variant="ghost" size="sm" aria-label="刷新分组和模型" title="刷新分组和当前模型" loading={preparation?.phase === 'loading'} onClick={() => void chat.refreshGroupsAndModels()} testId="chat-group-prepare" />{conversation.settings.mode === 'text' && <span className="chat-cost-hint">自动 · 费用不可预测</span>}</div>
        {selectedGroupMissing && <p className="chat-message-error" role="alert" data-testid="chat-group-unavailable">当前分组已不可用，请选择可用分组。已保存的消息和草稿继续保留。</p>}{preparation?.phase === 'error' && <p className="chat-message-error" role="alert">{preparation.error}</p>}{preparation?.phase === 'ready' && models.length === 0 && <p className="chat-hint">这个分组暂未提供{conversation.settings.mode === 'image' ? '图片' : '聊天'}模型，请切换分组。</p>}
        {conversation.settings.mode === 'image' && imageCapability && <div className="chat-image-options"><Select aria-label="图片尺寸" value={customSize ? 'custom' : conversation.settings.size} options={[...imageSizes.map((size) => ({ value: size, label: size === 'auto' ? '自动尺寸' : size.replace('x', ' × ') })), ...(imageCapability.sizePolicy.kind === 'divisible' ? [{ value: 'custom', label: '自定义尺寸' }] : [])]} onChange={(event) => { const value = event.target.value; setCustomSize(value === 'custom'); if (value !== 'custom') chat.changeSettings({ size: value }) }} testId="chat-image-size" />{imageCapability.qualities.length > 0 && <Select aria-label="画质" value={conversation.settings.quality} options={imageCapability.qualities.map((quality) => ({ value: quality, label: ({ low: '低画质', medium: '中画质', high: '高画质', auto: '自动画质' })[quality] }))} onChange={(event) => chat.changeSettings({ quality: event.target.value as 'low' | 'medium' | 'high' | 'auto' })} testId="chat-image-quality" />}{imageCapability.resolutions.length > 1 && <Select aria-label="分辨率" value={conversation.settings.imageResolution} options={imageCapability.resolutions.map((resolution) => ({ value: resolution, label: resolution }))} onChange={(event) => chat.changeSettings({ imageResolution: event.target.value as '1K' | '2K' | '4K' })} testId="chat-image-resolution" />}{customSize && imageCapability.sizePolicy.kind === 'divisible' && <><Input type="number" aria-label="图片宽度" min={imageCapability.sizePolicy.min} max={imageCapability.sizePolicy.max} step={imageCapability.sizePolicy.divisor} value={conversation.settings.size.split('x')[0]} onChange={(event) => chat.changeSettings({ size: `${event.target.value}x${conversation.settings.size.split('x')[1]}` })} /><span>×</span><Input type="number" aria-label="图片高度" min={imageCapability.sizePolicy.min} max={imageCapability.sizePolicy.max} step={imageCapability.sizePolicy.divisor} value={conversation.settings.size.split('x')[1]} onChange={(event) => chat.changeSettings({ size: `${conversation.settings.size.split('x')[0]}x${event.target.value}` })} /></>}</div>}
        <div className="chat-compose-box"><Textarea id="chatIn" aria-label={conversation.settings.mode === 'image' ? '图片描述' : '消息内容'} value={conversation.draft} onChange={(event) => chat.setDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (shouldSendOnEnter(event.nativeEvent, composing.current)) { event.preventDefault(); if (!pending) void chat.send() } }} rows={3} maxLength={40000} placeholder={conversation.settings.mode === 'image' ? '描述画面、风格、构图和细节' : '输入消息'} testId="chat-composer-input" />{pending ? <Button icon={Square} aria-label="停止生成" title="停止生成" loading={stopping} onClick={() => { if (activeRequest?.settings?.mode === 'image') setConfirmation({ kind: 'stop' }); else void stop() }} testId="chat-stop" /> : <Button variant="primary" icon={conversation.settings.mode === 'image' ? ImageIcon : ArrowUp} aria-label={conversation.settings.mode === 'image' ? '生成图片' : '发送消息'} title={conversation.settings.mode === 'image' ? '生成图片' : '发送消息'} disabled={!selectedGroup || !conversation.draft.trim() || preparation?.phase !== 'ready' || !conversation.settings.model} onClick={() => void chat.send()} testId="chat-send" />}</div>
        <div className="chat-compose-foot"><span>按服务端实际用量计费</span>{pending && <Pill tone="accent">正在生成</Pill>}</div>
      </div>
    </div>
    {confirmation && <Confirm title={confirmation.kind === 'retry' ? '重新生成这条回复？' : confirmation.kind === 'stop' ? '停止等待图片生成？' : confirmation.kind === 'clear' ? '清空当前对话？' : confirmation.kind === 'delete-conversation' ? '删除这段对话？' : '删除这条及之后的消息？'} body={confirmation.kind === 'retry' ? <><p>{confirmation.mayStillComplete ? '上次请求可能仍在服务端处理。' : ''}重新生成会发起新的付费请求，并替换这条及之后的回复。</p>{retrySettings && <p>{retrySettings.group} · {retrySettings.model}</p>}</> : confirmation.kind === 'stop' ? <p>停止等待后服务端仍可能继续生成图片并计费。已产生的费用不会自动退回。</p> : <p>将移除对应的本地消息记录，无法撤销。已产生的用量不会改变。</p>} okLabel={confirmation.kind === 'retry' ? '重新生成' : confirmation.kind === 'stop' ? '停止等待' : '确认删除'} danger={confirmation.kind !== 'retry'} requireAck={confirmation.mayStillComplete || confirmation.kind === 'stop'} onOk={confirmAction} onClose={() => setConfirmation(null)} testId="chat-confirm" />}
    {active && editing && <Dialog open title="编辑消息" subtitle="修改后重新发送，将移除这条消息之后的回复，并产生新的请求用量。" width={480} onClose={() => setEditing(null)} dirty={editing.text !== conversation.messages.find((message) => message.id === editing.id)?.content} footer={<><Button onClick={() => setEditing(null)}>取消</Button><Button variant="primary" icon={ArrowUp} disabled={!editing.text.trim()} onClick={() => { const value = editing; setEditing(null); void chat.send({ editId: value.id, prompt: value.text }) }} testId="chat-edit-send">修改并重发</Button></>} testId="chat-edit-dialog"><Textarea label="消息内容" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} rows={8} maxLength={40000} testId="chat-edit-input" /></Dialog>}
    {active && copyFallback !== null && <Dialog open title="手动复制内容" subtitle="无法访问剪贴板，选中文字后使用系统复制操作。" width={640} onClose={() => setCopyFallback(null)} footer={<Button variant="primary" onClick={() => setCopyFallback(null)}>关闭</Button>} testId="chat-copy-fallback"><Textarea label="待复制内容" value={copyFallback} readOnly rows={12} onFocus={(event) => event.currentTarget.select()} /></Dialog>}
    {active && preview && <Dialog open title="生成的图片" width={640} onClose={() => setPreview(null)} footer={<><Button icon={Copy} onClick={() => void task(() => api.copyAsset(preview.assetId), '图片已复制')}>复制图片</Button><Button icon={Download} onClick={() => void saveAsset(preview.assetId)}>另存图片</Button><Button icon={ArrowUpRight} onClick={() => void task(() => api.assetMenu(preview.assetId), '')}>更多操作</Button></>} testId="chat-image-preview"><img className="chat-preview-image" src={preview.localUrl} alt={preview.revisedPrompt || '生成的图片'} /></Dialog>}
  </section>
}
