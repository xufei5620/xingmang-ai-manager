import { useEffect, useRef, useState } from 'react'
import { platformApi } from '../../platform-api'
import type { AiChatGroupSummary } from '../../../../electron/ipc-contract'
import { inspectModel, validateChatRequest, validateImageRequest, type ChatApi } from './api'
import { activeConversation, applyStreamEvent, changeConversation, chatErrorMessage, completeImages, createConversation, createId, DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, isGenerating, planTurn, resolveChatGroup, resolveChatModel, saveConversation, updateRequest, type ChatMode, type ChatSettings, type ChatWorkspace, type Conversation } from './state'
import { importLegacyHistory, readWorkspace, writeWorkspace } from './storage'

export interface GroupPreparation { phase: 'loading' | 'ready' | 'error'; models: string[]; error?: string; warning?: string }
interface PendingRequest { conversationId: string; assistantId: string; mode: ChatMode; epoch: number; cancelRequested?: boolean; failureDuringCancel?: unknown }

export function useChatController(api: ChatApi, scope: string) {
  const [initial] = useState(() => readWorkspace(window.localStorage, scope))
  const [state, setState] = useState(initial.state)
  const [groups, setGroups] = useState<AiChatGroupSummary[]>([])
  const [groupLoading, setGroupLoading] = useState(false)
  const [groupError, setGroupError] = useState('')
  const [preparations, setPreparations] = useState<Record<string, GroupPreparation>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState(initial.warning ? `${initial.warning}。当前会话暂未启用保存。` : '')
  const stateRef = useRef(state)
  const alive = useRef(false)
  const epoch = useRef(0)
  const requests = useRef(new Map<string, PendingRequest>())
  const prepareAttempts = useRef(new Map<string, number>())
  const groupAttempt = useRef(0)
  const initialLoad = useRef(!initial.exists)
  const persist = useRef(!initial.warning)
  const commit = (change: (current: ChatWorkspace) => ChatWorkspace) => {
    const next = change(stateRef.current)
    stateRef.current = next
    setState(next)
  }
  const prepareGroup = async (group: string) => {
    if (!group) return
    const owner = epoch.current
    const attempt = (prepareAttempts.current.get(group) ?? 0) + 1
    prepareAttempts.current.set(group, attempt)
    setPreparations((current) => ({ ...current, [group]: { phase: 'loading', models: current[group]?.models ?? [] } }))
    try {
      const prepared = await api.prepareGroup(group)
      if (!alive.current || owner !== epoch.current || prepareAttempts.current.get(group) !== attempt) return
      if (prepared.group !== group) throw new Error('所选分组与返回分组不一致')
      const models = [...new Set(prepared.models)].filter((model) => { try { const cap = inspectModel(model); return cap.available && !cap.hidden && cap.kind !== 'video' } catch { return false } })
      setPreparations((current) => ({ ...current, [group]: { phase: 'ready', models, warning: prepared.storageWarning ? '分组已准备，但本机密钥缓存未能保存，下次可能需要重新准备' : undefined } }))
      const updateModel = (conversation: Conversation) => {
        if (conversation.settings.group !== group || isGenerating(conversation)) return conversation
        const mode = conversation.settings.mode
        const choices = models.filter((model) => inspectModel(model).kind === (mode === 'image' ? 'image' : 'chat'))
        const model = resolveChatModel(choices, conversation.settings.model, mode === 'image' ? DEFAULT_IMAGE_MODEL : DEFAULT_CHAT_MODEL)
        return { ...conversation, settings: normalizeModel({ ...conversation.settings, model }) }
      }
      commit((current) => ({ ...current, conversations: current.conversations.map(updateModel), draftConversation: updateModel(current.draftConversation) }))
    } catch (reason) {
      if (alive.current && owner === epoch.current && prepareAttempts.current.get(group) === attempt) setPreparations((current) => ({ ...current, [group]: { phase: 'error', models: [], error: chatErrorMessage(reason) } }))
    }
  }
  const refreshGroups = async () => {
    const owner = epoch.current, attempt = ++groupAttempt.current
    setGroupLoading(true); setGroupError('')
    try {
      const result = await api.listGroups()
      if (!alive.current || owner !== epoch.current || attempt !== groupAttempt.current) return
      setGroups(result)
      const conversation = activeConversation(stateRef.current)
      const hasConversationChoice = stateRef.current.activeId !== null || Boolean(conversation.draft.trim() || conversation.settings.model)
      const selected = resolveChatGroup(result, hasConversationChoice ? conversation.settings.group : '')
      if (selected !== conversation.settings.group) commit((current) => changeConversation(current, conversation.id, (item) => ({ ...item, settings: { ...item.settings, group: selected, model: '' } })))
      if (selected) void prepareGroup(selected)
    } catch (reason) { if (alive.current && owner === epoch.current && attempt === groupAttempt.current) setGroupError(chatErrorMessage(reason)) }
    finally { if (alive.current && owner === epoch.current && attempt === groupAttempt.current) setGroupLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    const owner = ++epoch.current
    const unsubscribe = api.subscribe((event) => {
      if (!alive.current || epoch.current !== owner || !requests.current.has(event.requestId)) return
      commit((current) => applyStreamEvent(current, event))
      if (event.type === 'complete') void platformApi()?.notifyActivity('task', `chat:${event.requestId}`).catch(() => undefined)
      if (event.type === 'complete' || event.type === 'error' || event.type === 'canceled') requests.current.delete(event.requestId)
    })
    void refreshGroups()
    if (initialLoad.current) void api.readSession().then((session) => {
      if (!alive.current || epoch.current !== owner || !session.authenticated || !session.account || stateRef.current.conversations.length || stateRef.current.draftConversation.draft) return
      try {
        const migrated = importLegacyHistory(window.localStorage, scope, session.account.userId)
        if (migrated) { commit(() => migrated); setNotice('已载入之前的聊天记录，旧记录仍保留'); if (migrated.conversations[0].settings.group) void prepareGroup(migrated.conversations[0].settings.group) }
      } catch { setNotice('之前的聊天记录暂时无法读取，原始数据已保留') }
    }, () => undefined)
    return () => {
      alive.current = false; epoch.current++; groupAttempt.current++; unsubscribe()
      for (const requestId of requests.current.keys()) void api.cancel(requestId).catch(() => undefined)
      requests.current.clear()
    }
  }, [api, scope])
  useEffect(() => {
    if (!persist.current) return
    const timer = window.setTimeout(() => {
      try { writeWorkspace(window.localStorage, stateRef.current); setStorageError('') }
      catch { setStorageError('聊天记录没有保存到本机，当前内容仍保留在窗口中') }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [state])
  useEffect(() => () => {
    if (persist.current) try { writeWorkspace(window.localStorage, stateRef.current) } catch { /* Keep the previous atomic localStorage value when storage is full. */ }
  }, [])
  const conversation = activeConversation(state)
  const updateActive = (change: (conversation: Conversation) => Conversation) => { const id = activeConversation(stateRef.current).id; commit((current) => changeConversation(current, id, change)) }
  const changeSettings = (patch: Partial<ChatSettings>) => updateActive((item) => ({ ...item, settings: { ...item.settings, ...patch } }))
  const selectGroup = (group: string) => { changeSettings({ group, model: '' }); void prepareGroup(group) }
  const selectModel = (model: string) => updateActive((item) => ({ ...item, settings: normalizeModel({ ...item.settings, model }) }))
  const selectMode = (mode: ChatMode) => {
    const current = activeConversation(stateRef.current)
    const candidates = preparations[current.settings.group]?.models.filter((model) => inspectModel(model).kind === (mode === 'image' ? 'image' : 'chat')) ?? []
    updateActive((item) => ({ ...item, settings: normalizeModel({ ...item.settings, mode, model: resolveChatModel(candidates, item.settings.model, mode === 'image' ? DEFAULT_IMAGE_MODEL : DEFAULT_CHAT_MODEL) }) }))
  }
  const openConversation = (id: string | null) => {
    commit((current) => ({ ...current, activeId: id }))
    setError('')
    const group = activeConversation(stateRef.current).settings.group
    if (group && !preparations[group]) void prepareGroup(group)
  }
  const newConversation = () => {
    const current = activeConversation(stateRef.current)
    const keepDraft = current.id === stateRef.current.draftConversation.id && Boolean(current.draft.trim())
    if (stateRef.current.conversations.length + (keepDraft ? 2 : 1) > 50) { setError('最多保存 50 个对话，请先删除不再需要的对话'); return }
    const next = createConversation(current.settings)
    commit((workspace) => {
      const preserved = keepDraft ? saveConversation(workspace, { ...current, title: current.draft.trim().slice(0, 32) }) : workspace
      return { ...preserved, conversations: [next, ...preserved.conversations], activeId: next.id }
    })
    setError('')
  }
  const send = async (options: { prompt?: string; retryId?: string; editId?: string } = {}) => {
    const current = activeConversation(stateRef.current)
    const owner = epoch.current
    if (!alive.current || isGenerating(current)) return
    if (!stateRef.current.conversations.some((item) => item.id === current.id) && stateRef.current.conversations.length >= 50) { setError('最多保存 50 个对话，请先删除不再需要的对话'); return }
    if (requests.current.size >= 4) { setError('已有 4 个对话正在处理，请等待一个完成后再试'); return }
    try {
      const plan = planTurn(current, { prompt: options.prompt ?? current.draft, requestId: createId(), assistantId: createId(), userMessageId: createId(), ...options })
      const prepared = preparations[plan.settings.group]
      if (prepared?.phase !== 'ready' || !prepared.models.includes(plan.settings.model)) { setError('所选分组或模型尚未准备，请重新准备后再试'); return }
      const textInput = { requestId: plan.requestId, group: plan.settings.group, model: plan.settings.model, messages: plan.messages, parameters: plan.settings.parameters }
      const capability = inspectModel(plan.settings.model)
      const imageInput = { requestId: plan.requestId, group: plan.settings.group, model: plan.settings.model, prompt: plan.prompt, size: plan.settings.size, quality: capability.kind === 'image' && capability.qualities.length ? plan.settings.quality : undefined, imageResolution: plan.settings.imageResolution }
      if (plan.settings.mode === 'text') validateChatRequest(textInput)
      else validateImageRequest(imageInput)
      requests.current.set(plan.requestId, { conversationId: current.id, assistantId: plan.assistantId, mode: plan.settings.mode, epoch: owner })
      commit((workspace) => saveConversation(workspace, plan.conversation))
      setError(''); setNotice('')
      try {
        if (plan.settings.mode === 'image') {
          const assets = await api.generateImage(imageInput)
          if (alive.current && epoch.current === owner && requests.current.has(plan.requestId)) {
            if (!assets.length) throw new Error('没有收到生成的图片')
            commit((workspace) => completeImages(workspace, plan.requestId, assets))
            void platformApi()?.notifyActivity('task', `image:${plan.requestId}`).catch(() => undefined)
            requests.current.delete(plan.requestId)
          }
        } else {
          await api.start(textInput)
          if (!alive.current || epoch.current !== owner) void api.cancel(plan.requestId).catch(() => undefined)
        }
      } catch (reason) {
        if (alive.current && epoch.current === owner && requests.current.has(plan.requestId)) {
          const request = requests.current.get(plan.requestId)!
          if (request.cancelRequested) { request.failureDuringCancel = reason; return }
          commit((workspace) => applyStreamEvent(workspace, { requestId: plan.requestId, type: 'error', message: chatErrorMessage(reason) }))
          requests.current.delete(plan.requestId)
        }
      }
    } catch (reason) { setError(chatErrorMessage(reason)) }
  }
  const stop = async () => {
    const current = activeConversation(stateRef.current)
    const message = current.messages.find((item) => item.requestId && (item.status === 'pending' || item.status === 'streaming'))
    if (!message?.requestId) return
    const requestId = message.requestId, owner = epoch.current
    const request = requests.current.get(requestId)
    if (!request || request.cancelRequested) return
    request.cancelRequested = true
    try {
      const result = await api.cancel(requestId)
      if (!alive.current || epoch.current !== owner) return
      if (result.canceled) {
        commit((workspace) => updateRequest(workspace, requestId, (item) => item.status === 'complete' || item.status === 'error' ? item : ({ ...item, status: 'canceled', mayStillComplete: result.mayStillComplete || item.mayStillComplete })))
        requests.current.delete(requestId)
        setNotice(result.mayStillComplete ? '已停止等待，服务端仍可能继续处理并计费，请勿立即重复提交' : '已停止接收，已产生的用量仍按服务端记录结算')
      } else {
        request.cancelRequested = false
        if ('failureDuringCancel' in request) {
          commit((workspace) => applyStreamEvent(workspace, { requestId, type: 'error', message: chatErrorMessage(request.failureDuringCancel) }))
          requests.current.delete(requestId)
        }
        setNotice('任务已结束或正在返回结果，请稍候确认最后状态')
      }
    } catch {
      request.cancelRequested = false
      if (alive.current && epoch.current === owner) {
        if ('failureDuringCancel' in request) {
          commit((workspace) => applyStreamEvent(workspace, { requestId, type: 'error', message: chatErrorMessage(request.failureDuringCancel) }))
          requests.current.delete(requestId)
        }
        setError('停止请求没有成功，请检查任务的最后状态后再试')
      }
    }
  }
  const removeConversation = (id: string) => {
    const item = stateRef.current.conversations.find((candidate) => candidate.id === id)
    if (item && isGenerating(item)) { setError('请先停止这个对话的请求，再删除记录'); return }
    commit((workspace) => ({ ...workspace, conversations: workspace.conversations.filter((candidate) => candidate.id !== id), activeId: workspace.activeId === id ? null : workspace.activeId }))
  }
  const clearConversation = () => { if (!isGenerating(activeConversation(stateRef.current))) updateActive((item) => ({ ...item, messages: [], title: '新对话' })) }
  const deleteFrom = (id: string) => { if (!isGenerating(activeConversation(stateRef.current))) updateActive((item) => { const index = item.messages.findIndex((message) => message.id === id); return index < 0 ? item : { ...item, messages: item.messages.slice(0, index) } }) }
  return { state, conversation, groups, groupLoading, groupError, preparations, error, notice, storageError, setError, setNotice, changeSettings, selectGroup, selectModel, selectMode, refreshGroups, prepareGroup, newConversation, openConversation, removeConversation, clearConversation, deleteFrom, send, stop, setDraft: (draft: string) => updateActive((item) => ({ ...item, draft })), updateConversation: updateActive }
}

function normalizeModel(settings: ChatSettings): ChatSettings {
  if (!settings.model) return settings
  const capability = inspectModel(settings.model)
  if (capability.kind !== 'image') return settings
  const validSize = capability.sizePolicy.kind === 'allow-list' ? capability.sizePolicy.values.includes(settings.size) : /^\d+x\d+$/.test(settings.size) && settings.size.split('x').every((part) => { const size = Number(part); const policy = capability.sizePolicy; return policy.kind === 'divisible' && size >= policy.min && size <= policy.max && size % policy.divisor === 0 })
  return { ...settings, size: validSize ? settings.size : capability.sizePolicy.default, quality: capability.qualities.includes(settings.quality) ? settings.quality : capability.defaultQuality ?? 'auto', imageResolution: capability.resolutions.includes(settings.imageResolution) ? settings.imageResolution : capability.defaultResolution }
}
