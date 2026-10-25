import { useEffect, useRef, useState } from 'react'
import { platformApi } from '../../platform-api'
import type { AiChatAsset, AiChatGroupSummary } from '../../../../electron/ipc-contract'
import { chatLimits, inspectModel, validateChatRequest, validateImageRequest, type ChatApi } from './api'
import { activeConversation, addDraftImages, applyStreamEvent, attachmentErrorMessage, buildChatCatalog, changeConversation, chatErrorMessage, completeImages, continueInNewConversation, createConversation, createId, isConversationTooLongMessage, isGenerating, offlineSendMessage, pendingChatGroups, pickChatGroup, planTurn, removeDraftImage, saveConversation, settleChatModel, updateRequest, type ChatMode, type ChatSettings, type ChatSite, type ChatWorkspace, type Conversation } from './state'
import { ChatStorageError, createHistoryWriter, type LoadedChatHistory } from './storage'
import { useLatestRequest } from '../../latest-request'
import { useOnlineStatus } from '../shell/useOnlineStatus'
import { isWindowInFront } from '../tools/install-notice'

export interface GroupPreparation { phase: 'loading' | 'ready' | 'error'; models: string[]; error?: string; warning?: string }
interface CarriedDraft { conversationId: string; text: string; fromDraft: boolean }
interface SendOptions { prompt?: string; retryId?: string; editId?: string }
interface PendingRequest { conversationId: string; assistantId: string; mode: ChatMode; epoch: () => boolean; cancelRequested?: boolean; failureDuringCancel?: unknown }

export function useChatController(api: ChatApi, scope: string, initial: LoadedChatHistory, active = true) {
  const [writer] = useState(() => createHistoryWriter(api, initial.saved, initial.afterFirstSave))
  const site: ChatSite = /^(api-account|solov-api):/.test(scope) ? 'solov-api' : 'solov'
  const [state, setState] = useState(initial.state)
  const [groups, setGroups] = useState<AiChatGroupSummary[]>([])
  const [groupLoading, setGroupLoading] = useState(false)
  const [groupError, setGroupError] = useState('')
  const [groupsLoaded, setGroupsLoaded] = useState(false)
  const [preparations, setPreparations] = useState<Record<string, GroupPreparation>>({})
  // 落定模型要在同一拍里看到最新的准备结果，state 赶不上，另记一份。
  const preparationsRef = useRef<Record<string, GroupPreparation>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState(initial.warning ? `${initial.warning}。现在聊的内容不会保存，关掉软件就没了。` : '')
  const [attaching, setAttaching] = useState(false)
  const attachingRef = useRef(false)
  const stateRef = useRef(state)
  const offlineRef = useRef(false)
  offlineRef.current = useOnlineStatus().offline
  const alive = useRef(false)
  const epoch = useLatestRequest()
  const requests = useRef(new Map<string, PendingRequest>())
  const prepareAttempts = useRef(new Map<string, number>())
  const groupAttempt = useLatestRequest()
  const groupsRef = useRef<AiChatGroupSummary[]>([])
  const groupsInitialized = useRef(false)
  const groupFlight = useRef<{ epoch: () => boolean; promise: Promise<boolean> } | null>(null)
  const interactionTimer = useRef<number | undefined>(undefined)
  const persist = useRef(!initial.warning)
  // 被上限拦下的那句话。编辑重发时它在编辑框里而不在输入框，得单独记住才搬得走。
  const carried = useRef<CarriedDraft | null>(null)
  // 断网时没发出去的那一下（重新生成、编辑重发也算），横幅上的「重试」原样再发一次；
  // 已经换到别的对话了，就只发那段对话输入框里的字。
  const offlineRetry = useRef<{ conversationId: string; options: SendOptions } | null>(null)
  const commit = (change: (current: ChatWorkspace) => ChatWorkspace) => {
    const next = change(stateRef.current)
    stateRef.current = next
    setState(next)
  }
  const setPreparation = (group: string, preparation: GroupPreparation) => {
    preparationsRef.current = { ...preparationsRef.current, [group]: preparation }
    setPreparations(preparationsRef.current)
  }
  // 菜单里只选模型（yoyo 10-25）：每准备完一个分组，就把各对话记着的模型按全部分组的模型表落定一次，
  // 给它挑一个有这个模型的分组计费。正在回答的不动；当前这段对话因为原分组没了换了计费分组，说一句。
  // 后台刷新（keepMissing）只换计费分组，模型哪儿都没有了就留着，页面上让用户自己换。
  const settleConversations = (keepMissing = false) => {
    const groups = groupsRef.current, prepared = preparationsRef.current
    const context = { pending: pendingChatGroups(groups, prepared), groups, site, keepMissing }
    const catalogs = { text: buildChatCatalog(groups, prepared, 'text'), image: buildChatCatalog(groups, prepared, 'image') }
    const activeId = activeConversation(stateRef.current).id
    const moved: { from?: string; to?: string } = {}
    const settle = (conversation: Conversation) => {
      if (isGenerating(conversation)) return conversation
      const next = settleChatModel(conversation.settings, catalogs[conversation.settings.mode], context)
      if (next.group === conversation.settings.group && next.model === conversation.settings.model) return conversation
      if (conversation.id === activeId && conversation.settings.group && next.model === conversation.settings.model && !groups.some((group) => group.name === conversation.settings.group)) { moved.from = conversation.settings.group; moved.to = next.group }
      return { ...conversation, settings: normalizeModel({ ...conversation.settings, ...next }) }
    }
    commit((current) => ({ ...current, conversations: current.conversations.map(settle), draftConversation: settle(current.draftConversation) }))
    if (moved.from && moved.to) setNotice(`原来的分组「${moved.from}」已不可用，已换成「${moved.to}」，之后按「${moved.to}」分组计费。`)
  }
  // 交回准备好的模型；分组不可用、准备失败或被更新的准备盖掉时是 null。
  const prepareGroup = async (group: string, keepMissing = false): Promise<string[] | null> => {
    if (!group || !groupsRef.current.some((item) => item.name === group)) {
      // 排着队时分组没了：去掉排队时记的「正在准备」，它以后再出现还会准备。
      if (preparationsRef.current[group]?.phase === 'loading') {
        const { [group]: _queued, ...rest } = preparationsRef.current
        preparationsRef.current = rest
        setPreparations(rest)
      }
      return null
    }
    const owner = epoch.capture()
    const attempt = (prepareAttempts.current.get(group) ?? 0) + 1
    prepareAttempts.current.set(group, attempt)
    setPreparation(group, { phase: 'loading', models: preparationsRef.current[group]?.models ?? [] })
    try {
      const prepared = await api.prepareGroup(group)
      if (!alive.current || !owner() || prepareAttempts.current.get(group) !== attempt) return null
      if (prepared.group !== group) throw new Error('所选分组与返回分组不一致')
      const models = [...new Set(prepared.models)].filter((model) => { try { const cap = inspectModel(model); return cap.available && !cap.hidden && cap.kind !== 'video' } catch { return false } })
      setPreparation(group, { phase: 'ready', models, warning: prepared.storageWarning ? '分组已准备，但本机密钥缓存未能保存，下次可能需要重新准备' : undefined })
      settleConversations(keepMissing)
      return models
    } catch (reason) {
      if (alive.current && owner() && prepareAttempts.current.get(group) === attempt) {
        setPreparation(group, { phase: 'error', models: [], error: chatErrorMessage(reason) })
        settleConversations(keepMissing)
      }
      return null
    }
  }
  // 打开聊天、点「刷新模型」时每个分组都准备一遍：菜单要列出全部分组的模型。还没有对话密钥的分组这时签一把，
  // 之后一直复用（yoyo 10-25 知道并同意）。一次最多同时准备三个。
  const prepareAllGroups = async (groups: readonly AiChatGroupSummary[], keepMissing = false): Promise<void> => {
    const pending = groups.map((group) => group.name)
    // 排着队的也先记成「正在准备」：菜单知道还没读完，后台刷新也不会把它再排一遍。
    for (const group of pending) setPreparation(group, { phase: 'loading', models: preparationsRef.current[group]?.models ?? [] })
    const worker = async () => { for (let group = pending.shift(); group !== undefined; group = pending.shift()) await prepareGroup(group, keepMissing) }
    await Promise.all([worker(), worker(), worker()])
  }
  const refreshGroups = (): Promise<boolean> => {
    if (groupFlight.current?.epoch()) return groupFlight.current.promise
    const owner = epoch.capture(), attempt = groupAttempt.begin()
    setGroupLoading(true); setGroupError('')
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await api.listGroups()
        if (!alive.current || !owner() || !attempt()) return false
        groupsRef.current = result
        setGroups(result); setGroupsLoaded(true)
        // A background refresh never prepares a group again. Only a group the
        // account did not have before is prepared, once, so the menu can list
        // its models; that is where its chat key gets minted.
        if (!groupsInitialized.current) {
          groupsInitialized.current = true
          void prepareAllGroups(result)
        } else {
          settleConversations(true)
          void prepareAllGroups(result.filter((group) => !preparationsRef.current[group.name]), true)
        }
        return true
      } catch (reason) {
        if (alive.current && owner() && attempt()) setGroupError(chatErrorMessage(reason))
        return false
      } finally {
        if (alive.current && owner() && attempt()) setGroupLoading(false)
        if (groupFlight.current?.promise === promise) groupFlight.current = null
      }
    })
    groupFlight.current = { epoch: owner, promise }
    return promise
  }
  // 菜单底部的「刷新模型」：分组和每个分组的模型都重读。交回这种模式下现在能选的模型，分组都没读到是 null。
  const refreshModels = async (): Promise<string[] | null> => {
    if (!await refreshGroups() || !alive.current) return null
    await prepareAllGroups(groupsRef.current)
    if (!alive.current) return null
    return buildChatCatalog(groupsRef.current, preparationsRef.current, activeConversation(stateRef.current).settings.mode).map((entry) => entry.model)
  }
  const refreshActions = useRef({ refreshGroups })
  refreshActions.current = { refreshGroups }
  const refreshOnInteraction = () => {
    if (interactionTimer.current !== undefined) return
    interactionTimer.current = window.setTimeout(() => {
      interactionTimer.current = undefined
      if (alive.current) void refreshActions.current.refreshGroups()
    }, 0)
  }
  useEffect(() => {
    alive.current = true
    const owner = epoch.begin()
    const unsubscribe = api.subscribe((event) => {
      if (!alive.current || !owner() || !requests.current.has(event.requestId)) return
      commit((current) => applyStreamEvent(current, event))
      if (event.type === 'complete' && !isWindowInFront(typeof document === 'undefined' ? undefined : document)) void platformApi()?.notifyActivity('task', `chat:${event.requestId}`).catch(() => undefined)
      if (event.type === 'complete' || event.type === 'error' || event.type === 'canceled') requests.current.delete(event.requestId)
    })
    void refreshGroups()
    return () => {
      alive.current = false; epoch.invalidate(); groupAttempt.invalidate(); unsubscribe()
      window.clearTimeout(interactionTimer.current); interactionTimer.current = undefined
      for (const requestId of requests.current.keys()) void api.cancel(requestId).catch(() => undefined)
      requests.current.clear()
    }
  }, [api, scope])
  useEffect(() => {
    if (!active) return
    // 分组列表很少变，这里不再定时拉：以前开着聊天页每 30 秒拉一次，是余额那条定时线的两倍频。
    // 进入聊天页、切回窗口、点开分组下拉框、点「刷新」和「重试」时各拉一次；分组被撤销时
    // 发消息前主进程准备分组那一步还会再核对一次，所以不靠轮询兜底。
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void refreshActions.current.refreshGroups()
    }
    refreshVisible()
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [active])
  useEffect(() => {
    if (!persist.current) return
    const timer = window.setTimeout(() => {
      writer.save(stateRef.current).then(() => { if (alive.current) setStorageError('') }, (reason: unknown) => {
        if (alive.current) setStorageError(`${reason instanceof ChatStorageError ? reason.message : '聊天记录没有保存到本机'}。当前内容仍保留在窗口中，请勿关闭窗口。`)
      })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [state])
  useEffect(() => () => {
    // A failed final save keeps the previous files as they were; nothing is left to show the error to.
    if (persist.current) void writer.save(stateRef.current).catch(() => undefined)
  }, [])
  const conversation = activeConversation(state)
  const updateActive = (change: (conversation: Conversation) => Conversation) => { const id = activeConversation(stateRef.current).id; commit((current) => changeConversation(current, id, change)) }
  const changeSettings = (patch: Partial<ChatSettings>) => updateActive((item) => ({ ...item, settings: { ...item.settings, ...patch } }))
  // 选了哪个模型，就用有它的那个分组计费（同一个模型几个分组都有时按 pickChatGroup 的次序挑）。
  const selectModel = (model: string) => {
    const current = activeConversation(stateRef.current).settings
    const entry = buildChatCatalog(groupsRef.current, preparationsRef.current, current.mode).find((item) => item.model === model)
    if (!entry) return
    const group = pickChatGroup(entry.groups, { current: current.group, mode: current.mode, groups: groupsRef.current, site })
    updateActive((item) => ({ ...item, settings: normalizeModel({ ...item.settings, model, group }) }))
  }
  const selectMode = (mode: ChatMode) => {
    const current = activeConversation(stateRef.current).settings
    const groups = groupsRef.current, prepared = preparationsRef.current
    const next = settleChatModel({ ...current, mode, model: '' }, buildChatCatalog(groups, prepared, mode), { pending: pendingChatGroups(groups, prepared), groups, site })
    updateActive((item) => ({ ...item, settings: normalizeModel({ ...item.settings, mode, ...next }) }))
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
  const send = async (options: SendOptions = {}) => {
    const current = activeConversation(stateRef.current)
    const owner = epoch.capture()
    if (!alive.current || isGenerating(current)) return
    // 断网时当场说，草稿原样留在输入框里，不先挂一条等超时的消息。
    if (offlineRef.current) { offlineRetry.current = { conversationId: current.id, options }; setError(offlineSendMessage); return }
    if (!stateRef.current.conversations.some((item) => item.id === current.id) && stateRef.current.conversations.length >= 50) { setError('最多保存 50 个对话，请先删除不再需要的对话'); return }
    if (requests.current.size >= 4) { setError('已有 4 个对话正在处理，请等待一个完成后再试'); return }
    try {
      const plan = planTurn(current, { prompt: options.prompt ?? current.draft, images: current.draftImages, requestId: createId(), assistantId: createId(), userMessageId: createId(), ...options })
      // 发送按钮灰着时 Enter 也不发，走到这里的是「编辑后重新发送」「重新生成」和断网横幅上的「重试」：按卡在哪一步说。
      if (!groupsRef.current.some((group) => group.name === plan.settings.group)) { setError(!groupsLoaded && groupLoading ? '正在读取模型，读完再发送' : '这个模型现在用不了，请换一个模型再发送'); return }
      const prepared = preparations[plan.settings.group]
      if (prepared?.phase !== 'ready' || !prepared.models.includes(plan.settings.model)) { setError(!prepared || prepared.phase === 'loading' ? '正在准备模型，准备好再发送' : prepared.phase === 'error' ? '模型没准备好，请先点模型菜单里的「刷新模型」再发送' : '请先选择模型'); return }
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
          if (alive.current && owner() && requests.current.has(plan.requestId)) {
            if (!assets.length) throw new Error('没有收到生成的图片')
            commit((workspace) => completeImages(workspace, plan.requestId, assets))
            if (!isWindowInFront(typeof document === 'undefined' ? undefined : document)) void platformApi()?.notifyActivity('task', `image:${plan.requestId}`).catch(() => undefined)
            requests.current.delete(plan.requestId)
          }
        } else {
          await api.start(textInput)
          if (!alive.current || !owner()) void api.cancel(plan.requestId).catch(() => undefined)
        }
      } catch (reason) {
        if (alive.current && owner() && requests.current.has(plan.requestId)) {
          const request = requests.current.get(plan.requestId)!
          if (request.cancelRequested) { request.failureDuringCancel = reason; return }
          commit((workspace) => applyStreamEvent(workspace, { requestId: plan.requestId, type: 'error', message: chatErrorMessage(reason) }))
          requests.current.delete(plan.requestId)
        }
      }
    } catch (reason) {
      const message = chatErrorMessage(reason)
      carried.current = isConversationTooLongMessage(message) ? { conversationId: current.id, ...(options.editId ? { text: options.prompt ?? '', fromDraft: false } : { text: current.draft, fromDraft: true }) } : null
      setError(message)
    }
  }
  const continueInNew = () => {
    const current = activeConversation(stateRef.current)
    if (stateRef.current.conversations.length + 1 > 50) { setError('最多保存 50 个对话，请先删除不再需要的对话'); return }
    const carry = carried.current?.conversationId === current.id ? carried.current : { text: current.draft, fromDraft: true }
    carried.current = null
    commit((workspace) => continueInNewConversation(workspace, current.id, carry.text, carry.fromDraft))
    setError('')
  }
  const dismissLengthNotice = () => updateActive((item) => ({ ...item, lengthNoticeDismissed: true }))
  const stop = async () => {
    const current = activeConversation(stateRef.current)
    const message = current.messages.find((item) => item.requestId && (item.status === 'pending' || item.status === 'streaming'))
    if (!message?.requestId) return
    const requestId = message.requestId, owner = epoch.capture()
    const request = requests.current.get(requestId)
    if (!request || request.cancelRequested) return
    request.cancelRequested = true
    try {
      const result = await api.cancel(requestId)
      if (!alive.current || !owner()) return
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
      if (alive.current && owner()) {
        if ('failureDuringCancel' in request) {
          commit((workspace) => applyStreamEvent(workspace, { requestId, type: 'error', message: chatErrorMessage(request.failureDuringCancel) }))
          requests.current.delete(requestId)
        }
        setError('停止请求没有成功，请检查任务的最后状态后再试')
      }
    }
  }
  // 选图框和剪贴板都在主进程里读、在那里压缩和保存，回来的只是图片引用。结果放回
  // 发起时的那个对话，中途切走了也不会贴错地方。
  const attachImages = async (work: (remaining: number) => Promise<AiChatAsset[]>) => {
    const current = activeConversation(stateRef.current)
    const owner = epoch.capture()
    const remaining = chatLimits.imagesPerMessage - (current.draftImages?.length ?? 0)
    if (remaining <= 0) { setError(`一条消息最多带 ${chatLimits.imagesPerMessage} 张图片`); return }
    if (attachingRef.current) return
    attachingRef.current = true; setAttaching(true)
    try {
      const assets = await work(remaining)
      if (!alive.current || !owner() || !assets.length) return
      commit((workspace) => changeConversation(workspace, current.id, (item) => addDraftImages(item, assets)))
      setError('')
    } catch (reason) {
      if (alive.current && owner()) setError(attachmentErrorMessage(reason))
    } finally {
      attachingRef.current = false
      if (alive.current) setAttaching(false)
    }
  }
  const pickImages = () => attachImages((remaining) => api.pickImages(remaining))
  const pasteImage = () => attachImages(async () => { const asset = await api.pasteImage(); return asset ? [asset] : [] })
  const removeImage = (assetId: string) => updateActive((item) => removeDraftImage(item, assetId))
  const removeConversation = (id: string) => {
    const item = stateRef.current.conversations.find((candidate) => candidate.id === id)
    if (item && isGenerating(item)) { setError('请先停止这个对话的请求，再删除记录'); return }
    commit((workspace) => ({ ...workspace, conversations: workspace.conversations.filter((candidate) => candidate.id !== id), activeId: workspace.activeId === id ? null : workspace.activeId }))
  }
  const retryOfflineSend = () => {
    const pending = offlineRetry.current
    return send(pending && pending.conversationId === activeConversation(stateRef.current).id ? pending.options : {})
  }
  // 正在回答的对话删不掉，所以有对话在生成时整个不动，界面上那颗按钮也是灰的。
  // 没发出去的草稿也存在本机，一起换成空白的，不然清空后它马上又冒出来；分组、模型和参数照旧。
  const clearAllConversations = () => {
    if (stateRef.current.conversations.some(isGenerating)) return false
    commit((workspace) => ({ ...workspace, conversations: [], activeId: null, draftConversation: createConversation(workspace.draftConversation.settings) }))
    return true
  }
  const clearConversation = () => { if (!isGenerating(activeConversation(stateRef.current))) updateActive((item) => ({ ...item, messages: [], title: '新对话' })) }
  const deleteFrom = (id: string) => { if (!isGenerating(activeConversation(stateRef.current))) updateActive((item) => { const index = item.messages.findIndex((message) => message.id === id); return index < 0 ? item : { ...item, messages: item.messages.slice(0, index) } }) }
  // 以前的记录没读出来：这一回不往本机写，免得空记录盖掉原文件；页面上给「重新读取」。
  const historyUnreadable = Boolean(initial.warning)
  return { site, attaching, pickImages, pasteImage, removeImage, state, conversation, groups, groupsLoaded, groupLoading, groupError, preparations, error, notice, storageError, historyUnreadable, setError, setNotice, changeSettings, selectModel, selectMode, refreshGroups, refreshModels, refreshOnInteraction, newConversation, continueInNew, retryOfflineSend, clearAllConversations, dismissLengthNotice, openConversation, removeConversation, clearConversation, deleteFrom, send, stop, setDraft: (draft: string) => updateActive((item) => ({ ...item, draft })), updateConversation: updateActive }
}

function normalizeModel(settings: ChatSettings): ChatSettings {
  if (!settings.model) return settings
  const capability = inspectModel(settings.model)
  if (capability.kind !== 'image') return settings
  const validSize = capability.sizePolicy.kind === 'allow-list' ? capability.sizePolicy.values.includes(settings.size) : /^\d+x\d+$/.test(settings.size) && settings.size.split('x').every((part) => { const size = Number(part); const policy = capability.sizePolicy; return policy.kind === 'divisible' && size >= policy.min && size <= policy.max && size % policy.divisor === 0 })
  return { ...settings, size: validSize ? settings.size : capability.sizePolicy.default, quality: capability.qualities.includes(settings.quality) ? settings.quality : capability.defaultQuality ?? 'auto', imageResolution: capability.resolutions.includes(settings.imageResolution) ? settings.imageResolution : capability.defaultResolution }
}
