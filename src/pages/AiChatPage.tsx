import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  CircleStop,
  Clipboard,
  Download,
  Edit3,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  resolveAiModelCapability,
  type AiModelCapability,
  type ImageModelCapability,
  type ImageQuality,
} from '../../electron/ai-chat-protocol'
import {
  aiChatGroupPreparationToken,
  aiChatRequestToken,
  appendAiChatImage,
  appendAiChatReasoning,
  appendAiChatText,
  beginAiChatGroupPreparation,
  beginAiChatRequest,
  cancelAiChatRequest,
  clearAiChatMessages,
  completeAiChatGroupPreparation,
  completeAiChatRequest,
  createAiChatState,
  deleteAiChatMessage,
  editAiChatMessage,
  errorAiChatRequest,
  failAiChatGroupPreparation,
  loadAiChatHistory,
  regenerateAiChatMessage,
  saveAiChatHistory,
  type AiChatImage,
  type AiChatMessage,
  type AiChatOperationToken,
  type AiChatState,
} from '../ai-chat-state'
import { errorMessage } from '../error-message'
import type {
  AiChatAsset,
  AiChatGroupSummary,
  AiChatParametersInput,
  AiChatStreamEvent,
  XingmangApi,
} from '../types'
import './AiChatPage.css'

export type AiChatPageApi = Pick<XingmangApi,
  | 'listAiChatGroups'
  | 'prepareAiChatGroup'
  | 'startAiChat'
  | 'generateAiImage'
  | 'cancelAiChat'
  | 'copyAiChatAsset'
  | 'saveAiChatAsset'
  | 'showAiChatAssetMenu'
  | 'onAiChatStream'>

export interface AiChatPageProps {
  api: AiChatPageApi
  userId: string | number
  notify: (message: { type: 'success' | 'error'; message: string }) => void
}

type ParameterKey = keyof AiChatParametersInput

interface ParameterSetting {
  key: ParameterKey
  label: string
  min: number
  max: number
  step: number
  placeholder: string
}

const parameterSettings: readonly ParameterSetting[] = [
  { key: 'temperature', label: '随机度', min: 0, max: 2, step: 0.1, placeholder: '默认' },
  { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.05, placeholder: '默认' },
  { key: 'maxTokens', label: '最大输出', min: 1, max: 131_072, step: 1, placeholder: '模型默认' },
  { key: 'frequencyPenalty', label: '频率惩罚', min: -2, max: 2, step: 0.1, placeholder: '默认' },
  { key: 'presencePenalty', label: '存在惩罚', min: -2, max: 2, step: 0.1, placeholder: '默认' },
  { key: 'seed', label: '随机种子', min: -2_147_483_648, max: 2_147_483_647, step: 1, placeholder: '随机' },
]

const commonImageSizes = ['1024x1024', '1536x1152', '1280x720', '720x1280', '3840x2160']
const imageQualityLabels: Record<ImageQuality, string> = {
  low: '低 · 最快',
  medium: '中 · 约 1 分钟',
  high: '高 · 约 2-3 分钟',
  auto: '自动 · 费用不可预测',
}

let localSequence = 0

function createLocalId(prefix: string): string {
  localSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${localSequence.toString(36)}`
}

function readInitialState(userId: string | number): AiChatState {
  if (typeof window === 'undefined') return createAiChatState(userId)
  try {
    return createAiChatState(userId, loadAiChatHistory(window.localStorage, userId))
  } catch {
    return createAiChatState(userId)
  }
}

export function resolveAiChatDisplayMode(model: string): 'chat' | 'image' {
  if (!model.trim()) return 'chat'
  return resolveAiModelCapability(model).kind
}

export function buildAiChatRequestMessages(messages: readonly AiChatMessage[]) {
  return messages
    .filter((message) => (
      ['system', 'user', 'assistant'].includes(message.role)
      && message.status !== 'pending'
      && message.status !== 'error'
      && message.content.trim()
    ))
    .map((message) => ({ role: message.role, content: message.content }))
}

export function formatAiChatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder} 秒`
}

export function imageSizeOptions(capability: ImageModelCapability): string[] {
  if (capability.sizePolicy.kind === 'allow-list') return [...capability.sizePolicy.values]
  const policy = capability.sizePolicy
  return commonImageSizes.filter((size) => {
    const [width, height] = size.split('x').map(Number)
    return width >= policy.min
      && height >= policy.min
      && width <= policy.max
      && height <= policy.max
      && width % policy.divisor === 0
      && height % policy.divisor === 0
  })
}

function nearestUserPrompt(messages: readonly AiChatMessage[], assistantId: string): string {
  const index = messages.findIndex((message) => message.id === assistantId)
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') return messages[cursor].content
  }
  return ''
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children }) => <span className="ai-chat-blocked-link">{children}</span>,
        img: ({ alt }) => <span className="ai-chat-blocked-media">[图片：{alt || '未命名'}]</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function ImageResult({
  image,
  api,
  notify,
}: {
  image: AiChatImage
  api: AiChatPageApi
  notify: AiChatPageProps['notify']
}) {
  const copy = async () => {
    try {
      await api.copyAiChatAsset(image.assetId)
      notify({ type: 'success', message: '图片已复制' })
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    }
  }
  const save = async () => {
    try {
      const result = await api.saveAiChatAsset(image.assetId)
      if (result.saved) notify({ type: 'success', message: '图片已保存' })
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    }
  }
  return (
    <figure
      className="ai-chat-image-result"
      onContextMenu={(event) => {
        event.preventDefault()
        void api.showAiChatAssetMenu(image.assetId).catch((error) => {
          notify({ type: 'error', message: errorMessage(error) })
        })
      }}
    >
      {image.previewUrl ? (
        <img src={image.previewUrl} alt={image.revisedPrompt || 'AI 生成图片'} />
      ) : (
        <div className="ai-chat-image-missing"><ImageIcon size={24} /><span>本地产物不可用</span></div>
      )}
      <figcaption>
        <span>{image.width && image.height ? `${image.width} × ${image.height}` : image.mimeType || '生成图片'}</span>
        <div className="ai-chat-inline-actions">
          <button type="button" title="复制图片" aria-label="复制图片" onClick={() => void copy()}><Clipboard size={15} /></button>
          <button type="button" title="另存图片" aria-label="另存图片" onClick={() => void save()}><Download size={15} /></button>
          <button
            type="button"
            title="更多操作（也可右键图片）"
            aria-label="更多图片操作"
            onClick={() => {
              void api.showAiChatAssetMenu(image.assetId).catch((error) => {
                notify({ type: 'error', message: errorMessage(error) })
              })
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      </figcaption>
    </figure>
  )
}

function MessageItem({
  message,
  activeRequest,
  api,
  notify,
  onStop,
  onEdit,
  onDelete,
  onRetry,
}: {
  message: AiChatMessage
  activeRequest: boolean
  api: AiChatPageApi
  notify: AiChatPageProps['notify']
  onStop: () => void
  onEdit: (message: AiChatMessage) => void
  onDelete: (message: AiChatMessage) => void
  onRetry: (message: AiChatMessage) => void
}) {
  const roleLabel = message.role === 'user' ? '你' : message.role === 'system' ? '系统' : '星芒 AI'
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      notify({ type: 'success', message: '内容已复制' })
    } catch {
      notify({ type: 'error', message: '复制失败，请手动选择内容' })
    }
  }
  return (
    <article className={`ai-chat-message role-${message.role}`} data-message-status={message.status}>
      <header>
        <span className="ai-chat-avatar" aria-hidden="true">
          {message.role === 'assistant' ? <Sparkles size={15} /> : message.role === 'system' ? <Settings2 size={15} /> : <MessageSquare size={15} />}
        </span>
        <strong>{roleLabel}</strong>
        <span className="ai-chat-message-status">
          {message.status === 'streaming' || message.status === 'pending' ? '生成中' : message.status === 'canceled' ? '已停止' : message.status === 'error' ? '失败' : ''}
        </span>
      </header>
      <div className="ai-chat-message-body">
        {message.reasoning && (
          <details className="ai-chat-reasoning" open={message.status === 'streaming'}>
            <summary><Brain size={14} />思考过程<ChevronDown size={14} /></summary>
            <div><MarkdownContent content={message.reasoning} /></div>
          </details>
        )}
        {message.content ? <MarkdownContent content={message.content} /> : activeRequest ? (
          <div className="ai-chat-typing" role="status"><i /><i /><i /><span>正在生成</span></div>
        ) : null}
        {message.images?.length ? (
          <div className="ai-chat-image-grid">
            {message.images.map((image) => <ImageResult key={image.assetId} image={image} api={api} notify={notify} />)}
          </div>
        ) : null}
        {message.error && <div className="ai-chat-message-error" role="alert"><AlertTriangle size={15} />{message.error}</div>}
      </div>
      <footer className="ai-chat-message-actions">
        {activeRequest ? (
          <button type="button" title="停止生成" aria-label="停止生成" onClick={onStop}><CircleStop size={15} /></button>
        ) : (
          <>
            {message.content && <button type="button" title="复制内容" aria-label="复制内容" onClick={() => void copyText()}><Clipboard size={15} /></button>}
            {message.role !== 'assistant' && <button type="button" title="编辑消息" aria-label="编辑消息" onClick={() => onEdit(message)}><Edit3 size={15} /></button>}
            {message.role === 'assistant' && <button type="button" title="重新生成" aria-label="重新生成" onClick={() => onRetry(message)}><RotateCcw size={15} /></button>}
            <button type="button" title="删除消息" aria-label="删除消息" onClick={() => onDelete(message)}><Trash2 size={15} /></button>
          </>
        )}
      </footer>
    </article>
  )
}

export function AiChatPage({ api, userId, notify }: AiChatPageProps) {
  const [state, setState] = useState<AiChatState>(() => readInitialState(userId))
  const stateRef = useRef(state)
  const [groups, setGroups] = useState<AiChatGroupSummary[]>([])
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [parameters, setParameters] = useState<AiChatParametersInput>({})
  const [parameterEnabled, setParameterEnabled] = useState<Partial<Record<ParameterKey, boolean>>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [imageSize, setImageSize] = useState('1024x1024')
  const [imageQuality, setImageQuality] = useState<ImageQuality>('low')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [editing, setEditing] = useState<AiChatMessage | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const requestTokens = useRef(new Map<string, AiChatOperationToken>())
  const conversationEnd = useRef<HTMLDivElement | null>(null)

  const commit = useCallback((next: AiChatState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const prepareGroup = useCallback(async (group: string) => {
    const pending = beginAiChatGroupPreparation(stateRef.current, {
      group,
      requestId: createLocalId('group'),
    })
    commit(pending)
    const token = aiChatGroupPreparationToken(pending)!
    try {
      const result = await api.prepareAiChatGroup(group)
      const next = completeAiChatGroupPreparation(stateRef.current, token, {
        group: result.group,
        models: result.models,
      })
      if (next === stateRef.current) return
      commit(next)
      if (result.keyCreated) notify({ type: 'success', message: `已自动创建「${result.group}」分组 API Key` })
      if (result.storageWarning) notify({ type: 'error', message: `密钥已创建，但本地加密缓存失败：${result.storageWarning}` })
    } catch (error) {
      const next = failAiChatGroupPreparation(stateRef.current, token, errorMessage(error))
      if (next !== stateRef.current) commit(next)
    }
  }, [api, commit, notify])

  useEffect(() => {
    const next = readInitialState(userId)
    requestTokens.current.clear()
    commit(next)
    setPrompt('')
    setEditing(null)
  }, [commit, userId])

  useEffect(() => {
    let active = true
    setGroupsLoading(true)
    setGroupsError(null)
    void api.listAiChatGroups().then((nextGroups) => {
      if (!active) return
      setGroups(nextGroups)
      const remembered = stateRef.current.group
      const target = nextGroups.some((group) => group.name === remembered) ? remembered : nextGroups[0]?.name
      if (target) void prepareGroup(target)
    }).catch((error) => {
      if (active) setGroupsError(errorMessage(error))
    }).finally(() => {
      if (active) setGroupsLoading(false)
    })
    return () => { active = false }
  }, [api, prepareGroup, userId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      saveAiChatHistory(window.localStorage, state)
    } catch {
      // The live chat remains usable when renderer persistence is unavailable.
    }
  }, [state.group, state.messages, state.model, state.userId])

  useEffect(() => api.onAiChatStream((event: AiChatStreamEvent) => {
    const token = requestTokens.current.get(event.requestId)
    if (!token) return
    const current = stateRef.current
    let next = current
    if (event.type === 'content') next = appendAiChatText(current, token, event.content)
    if (event.type === 'reasoning') next = appendAiChatReasoning(current, token, event.content)
    if (event.type === 'complete') next = completeAiChatRequest(current, token)
    if (event.type === 'canceled') next = cancelAiChatRequest(current, token)
    if (event.type === 'error') next = errorAiChatRequest(current, token, event.message)
    if (next !== current) commit(next)
    if (['complete', 'canceled', 'error'].includes(event.type)) requestTokens.current.delete(event.requestId)
  }), [api, commit])

  useEffect(() => {
    if (state.request.phase !== 'running' || state.request.kind !== 'image') {
      setElapsedSeconds(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1_000)
    return () => window.clearInterval(timer)
  }, [state.request.generation, state.request.kind, state.request.phase])

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [state.messages])

  const capability: AiModelCapability | null = useMemo(() => {
    if (!state.model) return null
    try { return resolveAiModelCapability(state.model) } catch { return null }
  }, [state.model])
  const imageCapability = capability?.kind === 'image' ? capability : null
  const mode = imageCapability ? 'image' : 'chat'
  const sizeOptions = useMemo(() => imageCapability ? imageSizeOptions(imageCapability) : [], [imageCapability])
  const busy = state.request.phase === 'running'
  const groupBusy = state.groupPreparation.phase === 'pending'
  const ready = Boolean(state.group && state.model && state.availableModels.length && !groupBusy)

  useEffect(() => {
    if (!imageCapability) return
    const sizes = imageSizeOptions(imageCapability)
    if (!sizes.includes(imageSize)) setImageSize(sizes[0] ?? imageCapability.sizePolicy.default)
    if (!imageCapability.qualities.includes(imageQuality)) setImageQuality(imageCapability.defaultQuality ?? 'low')
  }, [imageCapability, imageQuality, imageSize])

  const finishImageRequest = useCallback((requestId: string, token: AiChatOperationToken, assets: AiChatAsset[]) => {
    let next = stateRef.current
    for (const asset of assets) {
      next = appendAiChatImage(next, token, {
        assetId: asset.assetId,
        previewUrl: asset.localUrl,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        revisedPrompt: asset.revisedPrompt,
      })
    }
    next = completeAiChatRequest(next, token)
    requestTokens.current.delete(requestId)
    commit(next)
  }, [commit])

  const runRequest = useCallback(async (input: {
    requestId: string
    prompt: string
    token: AiChatOperationToken
    state: AiChatState
  }) => {
    requestTokens.current.set(input.requestId, input.token)
    if (resolveAiChatDisplayMode(input.state.model) === 'image') {
      try {
        const resolved = resolveAiModelCapability(input.state.model)
        const assets = await api.generateAiImage({
          requestId: input.requestId,
          group: input.state.group,
          model: input.state.model,
          prompt: input.prompt,
          size: imageSize,
          ...(resolved.kind === 'image' && resolved.qualities.length ? { quality: imageQuality } : {}),
        })
        finishImageRequest(input.requestId, input.token, assets)
      } catch (error) {
        requestTokens.current.delete(input.requestId)
        const next = errorAiChatRequest(stateRef.current, input.token, errorMessage(error))
        if (next !== stateRef.current) commit(next)
      }
      return
    }
    try {
      await api.startAiChat({
        requestId: input.requestId,
        group: input.state.group,
        model: input.state.model,
        messages: buildAiChatRequestMessages(input.state.messages),
        parameters: Object.fromEntries(
          Object.entries(parameters).filter(([key, value]) => parameterEnabled[key as ParameterKey] && value !== undefined),
        ),
      })
    } catch (error) {
      requestTokens.current.delete(input.requestId)
      const next = errorAiChatRequest(stateRef.current, input.token, errorMessage(error))
      if (next !== stateRef.current) commit(next)
    }
  }, [api, commit, finishImageRequest, imageQuality, imageSize, parameterEnabled, parameters])

  const submitPrompt = (event?: FormEvent) => {
    event?.preventDefault()
    const content = prompt.trim()
    if (!content || busy || !ready) return
    const requestId = createLocalId('request')
    const next = beginAiChatRequest(stateRef.current, {
      requestId,
      userMessageId: createLocalId('user'),
      assistantMessageId: createLocalId('assistant'),
      content,
      kind: mode,
    })
    const token = aiChatRequestToken(next)!
    commit(next)
    setPrompt('')
    void runRequest({ requestId, prompt: content, token, state: next })
  }

  const stop = async () => {
    const token = aiChatRequestToken(stateRef.current)
    if (!token) return
    try {
      await api.cancelAiChat(token.requestId)
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      requestTokens.current.delete(token.requestId)
      const next = cancelAiChatRequest(stateRef.current, token)
      if (next !== stateRef.current) commit(next)
    }
  }

  const retry = (message: AiChatMessage) => {
    if (busy || !ready) return
    const content = nearestUserPrompt(stateRef.current.messages, message.id)
    if (!content) return
    const requestId = createLocalId('retry')
    const next = regenerateAiChatMessage(stateRef.current, {
      messageId: message.id,
      requestId,
      kind: mode,
    })
    const token = aiChatRequestToken(next)
    if (!token) return
    commit(next)
    void runRequest({ requestId, prompt: content, token, state: next })
  }

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submitPrompt()
    }
  }

  return (
    <main className="page ai-chat-page" data-page-id="ai-chat">
      <header className="page-header ai-chat-page-header">
        <div>
          <div className="eyebrow">WORKBENCH</div>
          <h1>AI聊天</h1>
        </div>
        <div className="ai-chat-header-actions">
          <button className="secondary-button square" type="button" title="参数设置" aria-label="参数设置" aria-pressed={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
            <Settings2 size={17} />
          </button>
          <button
            className="secondary-button square"
            type="button"
            title="清空对话"
            aria-label="清空对话"
            disabled={!state.messages.length}
            onClick={() => {
              if (window.confirm('确定清空当前账号的 AI聊天历史吗？')) commit(clearAiChatMessages(stateRef.current))
            }}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </header>

      <section className="ai-chat-context-bar" aria-label="聊天上下文">
        <label>
          <span>分组</span>
          <select value={state.groupPreparation.targetGroup ?? state.group} onChange={(event) => void prepareGroup(event.target.value)} disabled={groupsLoading || groupBusy || busy}>
            {groups.length === 0 && <option value="">{groupsLoading ? '正在加载分组' : '没有可用分组'}</option>}
            {groups.map((group) => <option key={group.name} value={group.name}>{group.name}</option>)}
          </select>
        </label>
        <label>
          <span>模型</span>
          <select
            value={state.model}
            onChange={(event) => commit({ ...stateRef.current, model: event.target.value })}
            disabled={!state.availableModels.length || groupBusy || busy}
          >
            {!state.availableModels.length && <option value="">请先准备分组</option>}
            {state.availableModels.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
        <span className={`ai-chat-mode-badge mode-${mode}`}>
          {mode === 'image' ? <ImageIcon size={14} /> : <MessageSquare size={14} />}
          {mode === 'image' ? '图片生成' : '文本对话'}
        </span>
        {groups.find((group) => group.name === state.group)?.ratio !== undefined && (
          <span className="ai-chat-ratio">倍率 {groups.find((group) => group.name === state.group)?.ratio}×</span>
        )}
      </section>

      {groupBusy && (
        <div className="ai-chat-notice is-loading" role="status">
          <LoaderCircle size={16} className="spin" />
          <span>正在检查「{state.groupPreparation.targetGroup}」分组密钥；如果尚未创建，将自动创建并加密保存。</span>
        </div>
      )}
      {(groupsError || state.groupPreparation.error) && (
        <div className="ai-chat-notice is-error" role="alert">
          <AlertTriangle size={16} />
          <span>{groupsError || state.groupPreparation.error}</span>
          {groupsError
            ? <button type="button" onClick={() => window.location.reload()}>重新加载</button>
            : state.group && <button type="button" onClick={() => void prepareGroup(state.group)}>重试</button>}
        </div>
      )}

      <div className={settingsOpen ? 'ai-chat-workspace settings-open' : 'ai-chat-workspace'}>
        <section className="ai-chat-conversation" aria-label="聊天消息" aria-live="polite">
          <div className="ai-chat-message-list">
            {state.messages.length === 0 ? (
              <div className="ai-chat-empty">
                <span><Sparkles size={23} /></span>
                <h2>{mode === 'image' ? '描述你想生成的画面' : '开始一段新对话'}</h2>
                <p>{mode === 'image' ? '生成完成后可以复制、另存或右键查看更多操作。' : '选择分组和模型，然后直接输入内容。'}</p>
              </div>
            ) : state.messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                activeRequest={state.request.assistantMessageId === message.id}
                api={api}
                notify={notify}
                onStop={() => void stop()}
                onEdit={(target) => { setEditing(target); setEditDraft(target.content) }}
                onDelete={(target) => commit(deleteAiChatMessage(stateRef.current, target.id))}
                onRetry={retry}
              />
            ))}
            <div ref={conversationEnd} />
          </div>

          <form className="ai-chat-composer" onSubmit={submitPrompt}>
            {mode === 'image' && (
              <div className="ai-chat-image-controls">
                <label><span>尺寸</span><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>{sizeOptions.map((size) => <option key={size}>{size}</option>)}</select></label>
                {imageCapability && imageCapability.qualities.length > 0 && (
                  <label><span>画质</span><select value={imageQuality} onChange={(event) => setImageQuality(event.target.value as ImageQuality)}>{imageCapability.qualities.map((quality) => <option key={quality} value={quality}>{imageQualityLabels[quality]}</option>)}</select></label>
                )}
                {busy && <span className="ai-chat-elapsed"><LoaderCircle size={14} className="spin" />已等待 {formatAiChatElapsed(elapsedSeconds)}</span>}
              </div>
            )}
            <div className="ai-chat-input-row">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={onPromptKeyDown}
                placeholder={mode === 'image' ? '描述画面、风格、构图和细节' : '输入消息'}
                aria-label={mode === 'image' ? '图片提示词' : '聊天消息'}
                rows={3}
                maxLength={40_000}
                disabled={busy || !ready}
              />
              {busy ? (
                <button className="ai-chat-send-button is-stop" type="button" title="停止生成" aria-label="停止生成" onClick={() => void stop()}><CircleStop size={19} /></button>
              ) : (
                <button className="ai-chat-send-button" type="submit" title={mode === 'image' ? '生成图片' : '发送消息'} aria-label={mode === 'image' ? '生成图片' : '发送消息'} disabled={!prompt.trim() || !ready}><Send size={19} /></button>
              )}
            </div>
            <div className="ai-chat-composer-meta"><span>Enter 发送 · Shift+Enter 换行</span><span>{prompt.length.toLocaleString()} / 40,000</span></div>
          </form>
        </section>

        {settingsOpen && (
          <aside className="ai-chat-settings" aria-label="参数设置">
            <header><div><Settings2 size={16} /><strong>参数设置</strong></div><button type="button" title="关闭参数设置" aria-label="关闭参数设置" onClick={() => setSettingsOpen(false)}><X size={16} /></button></header>
            {mode === 'image' ? (
              <div className="ai-chat-settings-note">
                <ImageIcon size={17} />
                <strong>图片参数由输入区控制</strong>
                <span>GPT Image 默认使用低画质，避免自动档产生不可预测费用；即梦模型不发送画质参数。</span>
              </div>
            ) : (
              <div className="ai-chat-parameter-list">
                {parameterSettings.map((setting) => {
                  const enabled = Boolean(parameterEnabled[setting.key])
                  return (
                    <label className="ai-chat-parameter" key={setting.key}>
                      <span><input type="checkbox" checked={enabled} onChange={(event) => setParameterEnabled((current) => ({ ...current, [setting.key]: event.target.checked }))} />{setting.label}</span>
                      <input
                        type="number"
                        min={setting.min}
                        max={setting.max}
                        step={setting.step}
                        value={parameters[setting.key] ?? ''}
                        placeholder={setting.placeholder}
                        disabled={!enabled}
                        onChange={(event) => setParameters((current) => ({
                          ...current,
                          [setting.key]: event.target.value === '' ? undefined : Number(event.target.value),
                        }))}
                      />
                    </label>
                  )
                })}
                <button type="button" className="ai-chat-reset-parameters" onClick={() => { setParameters({}); setParameterEnabled({}) }}><RotateCcw size={14} />恢复默认</button>
              </div>
            )}
          </aside>
        )}
      </div>

      {editing && (
        <div className="ai-chat-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null) }}>
          <section className="ai-chat-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-chat-edit-title">
            <header><h2 id="ai-chat-edit-title">编辑消息</h2><button type="button" title="关闭" aria-label="关闭编辑" onClick={() => setEditing(null)}><X size={17} /></button></header>
            <textarea value={editDraft} onChange={(event) => setEditDraft(event.target.value)} rows={8} maxLength={40_000} autoFocus />
            <footer>
              <button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消</button>
              <button type="button" className="primary-button" disabled={!editDraft.trim()} onClick={() => { commit(editAiChatMessage(stateRef.current, editing.id, editDraft)); setEditing(null) }}><Check size={16} />保存</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  )
}
