import { useEffect, useRef, useState } from 'react'
import { platformApi } from '../../platform-api'
import { chatTextFileFullMessage } from '../../../../electron/ai-chat-protocol'
import type { AiChatAsset, AiChatGroupSummary, AiVideoClip, AiVideoGenerateInput } from '../../../../electron/ipc-contract'
import { chatLimits, inspectModel, validateChatRequest, validateImageRequest, type ChatApi } from './api'
import { activeConversation, addDraftImages, applyStreamEvent, attachmentErrorMessage, autoConversationTitle, buildChatCatalog, changeConversation, chatErrorMessage, completeImages, continueInNewConversation, createConversation, createId, isConversationTooLongMessage, isGenerating, offlineSendMessage, pendingChatGroups, pickChatGroup, planTurn, removeDraftImage, renameConversation, saveConversation, setConversationPinned, settleChatModel, updateRequest, type ChatMessage, type ChatMode, type ChatSettings, type ChatSite, type ChatWorkspace, type Conversation, addDraftFiles, draftFileRoom, fileAttachmentErrorMessage, fileTruncationNotice, removeDraftFile, addChatPhrase, removeChatPhrase, pastedNothingMessage, customImageSizeRule, videoStartImageLimitMessage } from './state'
import { autosaveDelay, ChatStorageError, conversationLimitMessage, createHistoryWriter, MAX_CONVERSATIONS, registerHistoryFlusher, unreadableConversationsNotice, type LoadedChatHistory } from './storage'
import { useLatestRequest } from '../../latest-request'
import { videoStudioErrorMessage } from '../video-studio/useVideoStudio'
import { buildChatVideoRequest, chatVideoBilledNotice, chatVideoBusyMessage, chatVideoFailedMessage, chatVideoRetry, chatVideoSecondsFor, completeChatVideo, maxParallelChatVideos, pendingChatVideos, settleChatVideo, type ChatVideoProgress } from './video'
import { useOnlineStatus } from '../shell/useOnlineStatus'
import { applySharedImageSettings, fitImageOptions, readSharedImageSettings, sharedImageSettingsOf, subscribeSharedImageSettings, writeSharedImageSettings } from './image-settings'
import { isWindowInFront } from '../tools/install-notice'

export interface GroupPreparation { phase: 'loading' | 'ready' | 'error'; models: string[]; error?: string; warning?: string }
interface CarriedDraft { conversationId: string; text: string; fromDraft: boolean }
interface SendOptions { prompt?: string; retryId?: string; editId?: string }
interface PendingRequest { conversationId: string; assistantId: string; mode: ChatMode; epoch: () => boolean; cancelRequested?: boolean; failureDuringCancel?: unknown }
/**
 * 点了停止以后主进程那边这一单是什么情况（同视频工作台）：billed 是已经交给服务端（钱扣了、停不下来，cancel 报错时也按这个算，
 * 宁可多等一会儿也不让客户再付一次）；stopped 是还没交出去就停住了；finished 是停下时它已经自己结束了，按它自己的结果收尾。
 */
type VideoStopOutcome = 'billed' | 'stopped' | 'finished'
/**
 * 一段在出、或者在接回的视频。saving：请求号正在存盘，还没交出去；submitted：交给主进程了；
 * resuming：只查不交（那一单的钱已经付过了，停了也省不下钱，「停止」不碰它）。
 */
interface VideoRun { phase: 'saving' | 'submitted' | 'resuming'; stop?: Promise<VideoStopOutcome>; stopRequested?: boolean }

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
  // 只有几段对话读不出来时其余照常读写，说一句就行（D40）；整份读不出来的走下面那条红条。
  const [notice, setNotice] = useState(initial.unreadable ? unreadableConversationsNotice(initial.unreadable) : '')
  const [storageError, setStorageError] = useState(initial.warning ? `${initial.warning}。当前对话内容不会保存，关闭软件后将丢失。` : '')
  const [attaching, setAttaching] = useState(false)
  // 尺寸框下那句规矩等客户离开尺寸框、或者点了发送才露出来，免得一边打字它一边跳；填对了就收起（表单 F5）。
  const [sizeRuleRevealed, setSizeRuleRevealed] = useState(false)
  const attachingRef = useRef(false)
  const stateRef = useRef(state)
  const offlineRef = useRef(false)
  offlineRef.current = useOnlineStatus().offline
  const alive = useRef(false)
  const epoch = useLatestRequest()
  const requests = useRef(new Map<string, PendingRequest>())
  // 在出的视频按请求号记，跟上面那一张分开：视频一段要几分钟、关了页面也不停（回来拿请求号接），不占聊天那四个位置。
  const videoRuns = useRef(new Map<string, VideoRun>())
  // 进度只在这一次打开时有，不进对话记录：一秒一跳的数字不该每跳都去存一次盘。
  const [videoProgress, setVideoProgress] = useState<Record<string, ChatVideoProgress>>({})
  const prepareAttempts = useRef(new Map<string, number>())
  const groupAttempt = useLatestRequest()
  const groupsRef = useRef<AiChatGroupSummary[]>([])
  const groupsInitialized = useRef(false)
  const groupFlight = useRef<{ epoch: () => boolean; promise: Promise<boolean> } | null>(null)
  const interactionTimer = useRef<number | undefined>(undefined)
  const persist = useRef(!initial.warning)
  // 头一处还没存的改动是什么时候（performance.now）；存了就放下。回复出字时靠它最多隔两秒存一次。
  const unsavedSince = useRef<number | null>(null)
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
    const catalogs = { text: buildChatCatalog(groups, prepared, 'text'), image: buildChatCatalog(groups, prepared, 'image'), video: buildChatCatalog(groups, prepared, 'video') }
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
    if (moved.from && moved.to) setNotice(`原分组「${moved.from}」已不可用，已切换为「${moved.to}」，此后按「${moved.to}」分组计费。`)
    syncImageSettings()
  }
  // 出图设置对话里和视频工作台的出图框记的是同一份（image-settings.ts，融合第 4 步）。当前这段对话在「生成图片」
  // 那一档时跟着那一份走：切到这一档、打开这段对话、那边改了、模型表读完时各对一次。正在回答的不动；只换设置，
  // 不算客户动过这段对话（不改它的时间，左边那一列不重排）。
  const syncImageSettings = () => {
    const current = activeConversation(stateRef.current)
    if (current.settings.mode !== 'image' || isGenerating(current)) return
    const groups = groupsRef.current
    const settings = applySharedImageSettings(current.settings, readSharedImageSettings(scope), buildChatCatalog(groups, preparationsRef.current, 'image'), { groups, site })
    if (settings !== current.settings) commit((workspace) => changeConversation(workspace, current.id, (item) => ({ ...item, settings })))
  }
  // 客户在「生成图片」那一档改了型号、尺寸、画质、分辨率：记成那一份。
  const rememberImageSettings = (settings: ChatSettings) => {
    const shared = sharedImageSettingsOf(settings)
    if (shared) writeSharedImageSettings(scope, shared)
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
      const models = [...new Set(prepared.models)].filter((model) => { try { const cap = inspectModel(model); return cap.available && !cap.hidden } catch { return false } })
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
  // 打开聊天、点「刷新模型」时每个分组都准备一遍：菜单要列出全部分组的模型。星芒账号上准备只读模型、不签密钥，
  // 对话密钥等在这个分组发第一句话时主进程才签（0.2.22 回归审查第 1 条）。一次最多同时准备三个。
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
        // its models.
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
  // 付了钱的片段、等着的请求号都马上存，不等自动保存攒那一会儿。存失败了窗口里的内容还在，红条由自动保存那一路报。
  const saveNow = (): Promise<void> => persist.current ? writer.save(stateRef.current).then(() => undefined, () => undefined) : Promise.resolve()
  const endVideoRun = (requestId: string, run: VideoRun) => {
    if (videoRuns.current.get(requestId) !== run) return
    videoRuns.current.delete(requestId)
    setVideoProgress((current) => { if (!(requestId in current)) return current; const { [requestId]: _done, ...rest } = current; return rest })
  }
  const settleVideo = (requestId: string, change: (message: ChatMessage) => ChatMessage) => {
    commit((workspace) => updateRequest(workspace, requestId, change))
    void saveNow()
  }
  /**
   * 等一段视频回来：新发的（generate）和接回来的（resume）走同一套收尾。接回来是 null 就是主进程没有这一单，给了 onMissing
   * 就交给它，没给按「没生成出来」收尾。停下时已经交给服务端的那一单不收尾，接着拿请求号去接回。
   */
  async function awaitVideo(requestId: string, run: VideoRun, request: () => Promise<AiVideoClip | null>, onMissing?: () => void) {
    const owner = epoch.capture()
    let next: (() => void) | undefined
    try {
      const clip = await request()
      if (!alive.current || !owner() || videoRuns.current.get(requestId) !== run) return
      if (!clip && onMissing) { next = onMissing; return }
      settleVideo(requestId, (message) => clip ? completeChatVideo(message, clip) : settleChatVideo(message, chatVideoFailedMessage, true))
      if (clip && !isWindowInFront(typeof document === 'undefined' ? undefined : document)) void platformApi()?.notifyActivity('task', `video:${requestId}`).catch(() => undefined)
    } catch (reason) {
      if (!alive.current || !owner() || videoRuns.current.get(requestId) !== run) return
      const message = videoStudioErrorMessage(reason, chatVideoFailedMessage)
      const outcome = run.stop ? await run.stop : 'finished'
      if (!alive.current || !owner() || videoRuns.current.get(requestId) !== run) return
      if (outcome === 'billed') {
        // 主进程说这一单可能照样出、照样扣费：钱已经花了，接着等它回来。主进程那边没有这一单（提交到一半就停了）时，
        // 按刚才那句报错算没成功，不让它悄悄变回「已停止」。
        next = () => resumeVideo(requestId, () => settleVideo(requestId, (item) => settleChatVideo(item, message)))
        return
      }
      settleVideo(requestId, (item) => settleChatVideo(item, outcome === 'stopped' ? undefined : message))
    } finally {
      endVideoRun(requestId, run)
      next?.()
    }
  }
  /** 接回已经交给服务端的那一单：只查不交。onMissing 拿得到这一趟（期间点没点过停止）。 */
  function resumeVideo(requestId: string, onMissing?: (run: VideoRun) => void) {
    const video = api.video
    if (!video) return
    const run: VideoRun = { phase: 'resuming' }
    videoRuns.current.set(requestId, run)
    void awaitVideo(requestId, run, () => video.resume(requestId), onMissing ? () => onMissing(run) : undefined)
  }
  /**
   * 新交一单：这一步开始花钱。请求号已经在那条回复上，先等它存进本机再交给主进程：交完就崩了、断电了，
   * 重开以后也拿得回这一段（同视频工作台）。存的这一小会儿里点了停止，就不交了。
   */
  async function submitVideo(input: AiVideoGenerateInput) {
    const video = api.video
    if (!video) return
    const owner = epoch.capture()
    const run: VideoRun = { phase: 'saving' }
    videoRuns.current.set(input.requestId, run)
    await saveNow()
    if (!alive.current || !owner() || videoRuns.current.get(input.requestId) !== run) return
    if (run.stopRequested) {
      settleVideo(input.requestId, (message) => settleChatVideo(message))
      endVideoRun(input.requestId, run)
      return
    }
    run.phase = 'submitted'
    void awaitVideo(input.requestId, run, () => video.generate(input))
  }
  const stopVideo = async (requestId: string) => {
    const video = api.video, run = videoRuns.current.get(requestId), owner = epoch.capture()
    if (!video || !run || run.stop) return
    if (run.phase === 'saving') { run.stopRequested = true; return }
    // 在接回的那一单停不了（钱已经付过）。记下点过停止：主进程要是说没有这一单，就不再替客户重新交一单。
    if (run.phase === 'resuming') { run.stopRequested = true; setNotice(chatVideoBilledNotice); return }
    const stop: Promise<VideoStopOutcome> = video.cancel(requestId).then((result) => !result.canceled ? 'finished' : result.mayStillComplete ? 'billed' : 'stopped', () => 'billed')
    run.stop = stop
    const outcome = await stop
    if (!alive.current || !owner()) return
    if (outcome === 'billed') setNotice(chatVideoBilledNotice)
    else if (outcome === 'finished') { run.stop = undefined; setNotice('任务已结束或正在返回结果，请稍候确认最后状态') }
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
    const unsubscribeVideo = api.video?.subscribeProgress((event) => {
      if (!alive.current || !owner() || !videoRuns.current.has(event.requestId)) return
      setVideoProgress((current) => {
        // 这一下没带数字就留着同一步里上一次的；换了一步（生成完去下载）从头算。
        const previous = current[event.requestId]
        const value = event.value ?? (previous?.stage === event.stage ? previous.value : undefined)
        return { ...current, [event.requestId]: { stage: event.stage, ...(value === undefined ? {} : { value }), ...(event.delayed ? { delayed: true } : {}) } }
      })
      // 主进程没能记下这一单时由页面替它记着，这一笔马上存：重开以后才提醒得了「可能已扣费」。
      if (event.unrecorded) {
        commit((workspace) => updateRequest(workspace, event.requestId, (message) => message.video && !message.video.unrecorded ? { ...message, video: { ...message.video, unrecorded: true } } : message))
        void saveNow()
      }
    })
    void refreshGroups()
    // 上次关掉软件、换了账号时还没等到结果的那几段视频：拿记着的请求号回主进程接回来。主进程只查不交，
    // 同一个请求号问两遍（开发版 StrictMode 会把这里跑两遍）接的也是同一份。
    for (const pending of pendingChatVideos(stateRef.current)) resumeVideo(pending.requestId)
    return () => {
      alive.current = false; epoch.invalidate(); groupAttempt.invalidate(); unsubscribe(); unsubscribeVideo?.()
      window.clearTimeout(interactionTimer.current); interactionTimer.current = undefined
      for (const requestId of requests.current.keys()) void api.cancel(requestId).catch(() => undefined)
      requests.current.clear()
      // 在出的视频不停：钱已经花了，主进程接着出，下次打开拿请求号接回来。
      videoRuns.current.clear()
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
    const now = performance.now()
    const since = unsavedSince.current ?? now
    unsavedSince.current = since
    const timer = window.setTimeout(() => {
      unsavedSince.current = null
      writer.save(stateRef.current).then(() => { if (alive.current) setStorageError('') }, (reason: unknown) => {
        if (alive.current) setStorageError(`${reason instanceof ChatStorageError ? reason.message : '聊天记录未能保存到本机'}。当前内容仍保留在窗口中，请勿关闭窗口。`)
      })
    }, autosaveDelay(since, now))
    return () => window.clearTimeout(timer)
  }, [state])
  useEffect(() => () => {
    // A failed final save keeps the previous files as they were; nothing is left to show the error to.
    if (persist.current) void writer.save(stateRef.current).catch(() => undefined)
  }, [])
  // 退出前主进程来要的那一次（storage.ts 的 answerHistoryFlushRequests）：手上的马上存。存失败了原来的文件没动，
  // 页面上那条红条照旧由下一次自动保存来报。
  useEffect(() => registerHistoryFlusher(() => persist.current ? writer.save(stateRef.current) : Promise.resolve()), [writer])
  const conversation = activeConversation(state)
  const sizeRule = customImageSizeRule(conversation.settings)
  useEffect(() => { if (!sizeRule) setSizeRuleRevealed(false) }, [sizeRule])
  const updateActive = (change: (conversation: Conversation) => Conversation) => { const id = activeConversation(stateRef.current).id; commit((current) => changeConversation(current, id, change)) }
  const changeSettings = (patch: Partial<ChatSettings>) => {
    const next = { ...activeConversation(stateRef.current).settings, ...patch }
    updateActive((item) => ({ ...item, settings: { ...item.settings, ...patch } }))
    if (patch.size !== undefined || patch.quality !== undefined || patch.imageResolution !== undefined) rememberImageSettings(next)
  }
  // 选了哪个模型，就用有它的那个分组计费（同一个模型几个分组都有时按 pickChatGroup 的次序挑）。
  const selectModel = (model: string) => {
    const current = activeConversation(stateRef.current).settings
    const entry = buildChatCatalog(groupsRef.current, preparationsRef.current, current.mode).find((item) => item.model === model)
    if (!entry) return
    const group = pickChatGroup(entry.groups, { current: current.group, mode: current.mode, groups: groupsRef.current, site })
    const next = normalizeModel({ ...current, model, group })
    updateActive((item) => ({ ...item, settings: normalizeModel({ ...item.settings, model, group }) }))
    rememberImageSettings(next)
  }
  // 视频工作台的出图框那边改了（或者这边自己刚记下）：当前对话在「生成图片」那一档就跟上。
  useEffect(() => subscribeSharedImageSettings((changed) => { if (changed === scope) syncImageSettings() }), [scope])
  const selectMode = (mode: ChatMode) => {
    const current = activeConversation(stateRef.current).settings
    const groups = groupsRef.current, prepared = preparationsRef.current
    const next = settleChatModel({ ...current, mode, model: '' }, buildChatCatalog(groups, prepared, mode), { pending: pendingChatGroups(groups, prepared), groups, site })
    updateActive((item) => ({ ...item, settings: normalizeModel({ ...item.settings, mode, ...next }) }))
    syncImageSettings()
  }
  const openConversation = (id: string | null) => {
    commit((current) => ({ ...current, activeId: id }))
    syncImageSettings()
    setError('')
    const group = activeConversation(stateRef.current).settings.group
    if (group && !preparations[group]) void prepareGroup(group)
  }
  // 「新建」回到那段还没发过话的空白对话：它不进左边的列表，发了第一句才算一段对话（融合第 1 步；以前每点一次
  // 左边就多一条空的「新对话」，现在「新建」也是做视频、开画布的入口，点得多，不能再攒）。存满 200 段时不在这里拦，
  // 发第一句时 send 会说。
  const newConversation = () => {
    const current = activeConversation(stateRef.current)
    const onBlank = current.id === stateRef.current.draftConversation.id
    // 空白页上打了字没发又点「新建」：照旧先把它存成一段对话（名字取打的字），再给一页新的空白。
    const keepDraft = onBlank && Boolean(current.draft.trim())
    if (keepDraft && stateRef.current.conversations.length + 1 > MAX_CONVERSATIONS) { setError(conversationLimitMessage); return }
    commit((workspace) => {
      if (keepDraft) return { ...saveConversation(workspace, { ...current, title: autoConversationTitle(current.draft.trim()) }), activeId: null }
      if (onBlank) return workspace
      // 从别的对话过来：空白页跟着那段对话的模型和设置走；它自己还留着没发的字、图、文件时原样不动。
      const blank = workspace.draftConversation
      const untouched = !blank.draft.trim() && !blank.draftImages?.length && !blank.draftFiles?.length
      return { ...workspace, activeId: null, draftConversation: untouched ? createConversation(current.settings) : blank }
    })
    syncImageSettings()
    setError('')
    const group = activeConversation(stateRef.current).settings.group
    if (group && !preparations[group]) void prepareGroup(group)
  }
  const send = async (options: SendOptions = {}) => {
    const current = activeConversation(stateRef.current)
    const owner = epoch.capture()
    if (!alive.current || isGenerating(current)) return
    // 自定义尺寸不合这个型号的规矩：不发，在尺寸框下面说清规矩。重新生成用的是那条回复当时的设置，不看这里。
    if (!options.retryId && customImageSizeRule(current.settings)) { setSizeRuleRevealed(true); return }
    // 断网时当场说，草稿原样留在输入框里，不先挂一条等超时的消息。
    if (offlineRef.current) { offlineRetry.current = { conversationId: current.id, options }; setError(offlineSendMessage); return }
    if (!stateRef.current.conversations.some((item) => item.id === current.id) && stateRef.current.conversations.length >= MAX_CONVERSATIONS) { setError(conversationLimitMessage); return }
    // 重新生成一条视频回复：上一单还记着请求号的，先看拿它怎么办（chatVideoRetry）。看的是那条回复当时的模式。
    const retried = options.retryId ? current.messages.find((message) => message.id === options.retryId) : undefined
    const videoTurn = options.retryId ? retried?.settings?.mode === 'video' : current.settings.mode === 'video'
    const videoRetry = chatVideoRetry(videoTurn ? retried : undefined)
    if (videoTurn && !api.video) { setError('该模型当前不可用，请更换模型后发送'); return }
    if (videoTurn ? videoRuns.current.size >= maxParallelChatVideos : requests.current.size >= 4) { setError(videoTurn ? chatVideoBusyMessage : '已有 4 个对话正在处理，请等待其中一个完成后再发送'); return }
    try {
      const plan = planTurn(current, { prompt: options.prompt ?? current.draft, images: current.draftImages, files: current.draftFiles, requestId: videoRetry.kind === 'fresh' ? createId() : videoRetry.requestId, assistantId: createId(), userMessageId: createId(), ...(videoRetry.kind === 'reuse' ? { videoUnconfirmed: true } : {}), ...options })
      // 发送按钮灰着时 Enter 也不发，走到这里的是「编辑后重新发送」「重新生成」和断网横幅上的「重试」：按卡在哪一步说。
      if (!groupsRef.current.some((group) => group.name === plan.settings.group)) { setError(!groupsLoaded && groupLoading ? '正在获取模型，请稍后发送' : '该模型当前不可用，请更换模型后发送'); return }
      const prepared = preparations[plan.settings.group]
      if (prepared?.phase !== 'ready' || !prepared.models.includes(plan.settings.model)) { setError(!prepared || prepared.phase === 'loading' ? '模型准备中，请稍后发送' : prepared.phase === 'error' ? '模型尚未就绪，请先点击模型菜单中的「刷新模型」再发送' : '请先选择模型'); return }
      const textInput = { requestId: plan.requestId, group: plan.settings.group, model: plan.settings.model, messages: plan.messages, parameters: plan.settings.parameters }
      const capability = inspectModel(plan.settings.model)
      const imageInput = { requestId: plan.requestId, group: plan.settings.group, model: plan.settings.model, prompt: plan.prompt, size: plan.settings.size, quality: capability.kind === 'image' && capability.qualities.length ? plan.settings.quality : undefined, imageResolution: plan.settings.imageResolution, ...(plan.images.length ? { sourceAssetIds: plan.images.map((image) => image.assetId) } : {}) }
      if (plan.settings.mode === 'video') {
        const videoInput = (requestId: string) => buildChatVideoRequest(plan.settings, plan.prompt, plan.images[0]?.assetId, requestId)
        commit((workspace) => saveConversation(workspace, plan.conversation))
        setError(''); setNotice('')
        if (videoRetry.kind !== 'resume') { void submitVideo(videoInput(plan.requestId)); return }
        // 上一单没等到结果就失败了：先拿它的请求号接回，接得回来就不用再付一次钱。主进程确实没有这一单，
        // 才换一个新的请求号重新交（客户已经在确认框里点过头）。
        resumeVideo(plan.requestId, (run) => {
          // 接回期间点了停止：停下以后不再花钱，这一条回到「已停止」。
          if (run.stopRequested) { settleVideo(plan.requestId, (message) => settleChatVideo(message, undefined, true)); return }
          const requestId = createId()
          commit((workspace) => updateRequest(workspace, plan.requestId, (message) => message.video ? { ...message, requestId, video: { requestId } } : message))
          void submitVideo(videoInput(requestId))
        })
        return
      }
      if (plan.settings.mode === 'text') validateChatRequest(textInput)
      else validateImageRequest(imageInput)
      requests.current.set(plan.requestId, { conversationId: current.id, assistantId: plan.assistantId, mode: plan.settings.mode, epoch: owner })
      commit((workspace) => saveConversation(workspace, plan.conversation))
      setError(''); setNotice('')
      try {
        if (plan.settings.mode === 'image') {
          const assets = await api.generateImage(imageInput)
          if (alive.current && owner() && requests.current.has(plan.requestId)) {
            if (!assets.length) throw new Error('未收到生成的图片')
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
    if (stateRef.current.conversations.length + 1 > MAX_CONVERSATIONS) { setError(conversationLimitMessage); return }
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
    if (message.video) { await stopVideo(message.requestId); return }
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
        setError('停止请求失败，请检查任务最终状态后重试')
      }
    }
  }
  // 选图框和剪贴板都在主进程里读、在那里压缩和保存，回来的只是图片引用。结果放回
  // 发起时的那个对话，中途切走了也不会贴错地方。选图框取消了回空的不用说什么；贴了却什么都没拿到，
  // 由调用方给一句 emptyMessage。
  const attachImages = async (work: (remaining: number) => Promise<AiChatAsset[]>, emptyMessage = '') => {
    const current = activeConversation(stateRef.current)
    const owner = epoch.capture()
    // 「生成视频」带的是开头图，只收一张。
    const video = current.settings.mode === 'video'
    const remaining = (video ? 1 : chatLimits.imagesPerMessage) - (current.draftImages?.length ?? 0)
    if (remaining <= 0) { setError(video ? videoStartImageLimitMessage : `一条消息最多带 ${chatLimits.imagesPerMessage} 张图片`); return }
    if (attachingRef.current) return
    attachingRef.current = true; setAttaching(true)
    try {
      const assets = await work(remaining)
      if (!alive.current || !owner()) return
      if (!assets.length) { if (emptyMessage) setError(emptyMessage); return }
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
  const pasteImage = () => attachImages((remaining) => api.pasteImages(remaining), pastedNothingMessage)
  // 对话里生成的图拿来接着改：换到「生成图片」，这张图当参考图放进输入框。图已经在主进程存着，不用再读一遍。
  const reuseImage = (asset: AiChatAsset) => {
    if (activeConversation(stateRef.current).settings.mode !== 'image') selectMode('image')
    return attachImages(async () => [asset])
  }
  // 「用此图生成视频」：换到「生成视频」，这张图当开头图放进输入框（只收一张，原来放着的换掉），当初那句描述填回去
  // （输入框里已经打了字就不动它）。只填不发：发一段视频要花钱，得让人看一眼再发。
  const animateImage = (asset: AiChatAsset, prompt: string) => {
    if (activeConversation(stateRef.current).settings.mode !== 'video') selectMode('video')
    updateActive((item) => ({ ...item, draftImages: [asset], draft: item.draft.trim() ? item.draft : prompt }))
    setError('')
  }
  const removeImage = (assetId: string) => updateActive((item) => removeDraftImage(item, assetId))
  // 文字类文件也是主进程开选文件框、在那里读，回来的只是字；放回发起时的那个对话。跟加图片共用「正在加」，
  // 一次只开一个选择框。
  const pickFiles = async () => {
    const current = activeConversation(stateRef.current)
    const owner = epoch.capture()
    const room = draftFileRoom(current)
    if (attachingRef.current || room.files <= 0) return
    if (room.characters <= 0) { setError(chatTextFileFullMessage); return }
    attachingRef.current = true; setAttaching(true)
    try {
      const files = await api.pickTextFiles(room.files, room.characters)
      if (!alive.current || !owner() || !files.length) return
      commit((workspace) => changeConversation(workspace, current.id, (item) => addDraftFiles(item, files)))
      setError('')
      setNotice(fileTruncationNotice(files))
    } catch (reason) {
      if (alive.current && owner()) setError(fileAttachmentErrorMessage(reason))
    } finally {
      attachingRef.current = false
      if (alive.current) setAttaching(false)
    }
  }
  const removeFile = (index: number) => updateActive((item) => removeDraftFile(item, index))
  // 「常用」里的话跟着账号的聊天记录一起存，换账号各是各的。
  const savePhrase = (text: string) => commit((workspace) => ({ ...workspace, phrases: addChatPhrase(workspace.phrases, text) }))
  const removePhrase = (index: number) => commit((workspace) => ({ ...workspace, phrases: removeChatPhrase(workspace.phrases, index) }))
  const removeConversation = (id: string) => {
    const item = stateRef.current.conversations.find((candidate) => candidate.id === id)
    if (item && isGenerating(item)) { setError('请先停止该对话的请求，再删除记录'); return }
    commit((workspace) => ({ ...workspace, conversations: workspace.conversations.filter((candidate) => candidate.id !== id), activeId: workspace.activeId === id ? null : workspace.activeId }))
  }
  const renameSavedConversation = (id: string, title: string) => commit((workspace) => changeConversation(workspace, id, (item) => renameConversation(item, title)))
  const pinConversation = (id: string, pinned: boolean) => commit((workspace) => changeConversation(workspace, id, (item) => setConversationPinned(item, pinned)))
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
  const clearConversation = () => { if (!isGenerating(activeConversation(stateRef.current))) updateActive((item) => ({ ...item, messages: [], title: '新对话', renamed: undefined })) }
  const deleteFrom = (id: string) => { if (!isGenerating(activeConversation(stateRef.current))) updateActive((item) => { const index = item.messages.findIndex((message) => message.id === id); return index < 0 ? item : { ...item, messages: item.messages.slice(0, index) } }) }
  // 以前的记录没读出来：这一回不往本机写，免得空记录盖掉原文件；页面上给「重新读取」。
  const historyUnreadable = Boolean(initial.warning)
  return { site, attaching, sizeRule, sizeRuleRevealed, revealSizeRule: () => setSizeRuleRevealed(true), pickImages, pasteImage, reuseImage, animateImage, removeImage, videoProgress, state, conversation, groups, groupsLoaded, groupLoading, groupError, preparations, error, notice, storageError, historyUnreadable, setError, setNotice, changeSettings, selectModel, selectMode, refreshGroups, refreshModels, refreshOnInteraction, newConversation, continueInNew, retryOfflineSend, clearAllConversations, dismissLengthNotice, openConversation, removeConversation, renameConversation: renameSavedConversation, pinConversation, clearConversation, deleteFrom, send, stop, setDraft: (draft: string) => updateActive((item) => ({ ...item, draft })), updateConversation: updateActive, pickFiles, removeFile, savePhrase, removePhrase }
}

function normalizeModel(settings: ChatSettings): ChatSettings {
  if (!settings.model) return settings
  const capability = inspectModel(settings.model)
  // 换了视频模型：记着的时长挪到这个模型能出的、离原来最近的那一档（没设过的不写，用的时候再按型号算）。
  if (capability.kind === 'video') return settings.videoSeconds === undefined ? settings : { ...settings, videoSeconds: chatVideoSecondsFor(settings) }
  if (capability.kind !== 'image') return settings
  return fitImageOptions(settings.model, settings)
}
