import { useEffect, useRef, useState } from 'react'
import { aiVideoUnconfirmedSubmissionMessage, isAiVideoUnconfirmedSubmission } from '../../../../electron/ai-video-submission'
import { AI_CHAT_LIMITS } from '../../../../electron/ai-chat-protocol'
import { resolveMissingAiAssetMessage } from '../../../../electron/ai-asset-missing'
import type { AiChatGroupSummary, AiVideoClip, XingmangApi } from '../../../../electron/ipc-contract'
import { matchRelayQuotaFailureMessage, relayQuotaFailureMessages } from '../../../../electron/relay-quota-failure'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { speaksChinese, userFacingErrorMessage } from '../../business-common'
import { useBackgroundWork } from '../../background-work'
import { useLatestRequest } from '../../latest-request'
import { platformApi } from '../../platform-api'
import { diagnosticFolderUnavailableMessage } from '../app/diagnostic-folder'
import { inspectModel } from '../chat/api'
import { isWindowInFront } from '../tools/install-notice'
import { pendingChatGroups, type ChatGroupPreparation, type ChatSite } from '../chat/state'
import type { VideoStudioCatalogCache } from './catalog-cache'
import { composeInVideoStudioWorker } from './compose-client'
import { addVideoStudioClipBytes, videoStudioMusicUnreadableMessage, videoStudioTotalBytesLimit, type VideoStudioComposeProgress, type VideoStudioComposeRequest, type VideoStudioComposeResult } from './compose-protocol'
import { VideoStudioError, describeVideoStudioFailure, isVideoStudioAbort } from './errors'
import {
  addVideoStudioShot,
  applyVideoStudioPlan,
  assignVideoStudioShotClip,
  assignVideoStudioShotImages,
  buildVideoStudioCatalogs,
  buildVideoStudioClipRequest,
  buildVideoStudioImageRequest,
  changeVideoStudioSettings,
  createVideoStudioId,
  finishVideoStudioShotDrawing,
  isVideoStudioShotBusy,
  isVideoStudioShotDrawing,
  moveVideoStudioShot,
  removeVideoStudioMusic,
  removeVideoStudioShot,
  removeVideoStudioShotClip,
  removeVideoStudioShotImage,
  selectVideoStudioVideoModel,
  setVideoStudioClipSound,
  setVideoStudioMusic,
  setVideoStudioShotSeconds,
  setVideoStudioShotTrim,
  settleVideoStudioModels,
  startVideoStudioShotDrawing,
  updateVideoStudioShot,
  videoStudioComposeCaptions,
  videoStudioComposeKey,
  withoutVideoStudioBorrowed,
  withoutVideoStudioTrim,
  videoStudioComposeSound,
  videoStudioPlainText,
  videoStudioReadyToCompose,
  videoStudioShotProblem,
  type VideoStudioClipSound,
  type VideoStudioClipSource,
  type VideoStudioImageDraft,
  type VideoStudioProject,
  type VideoStudioSettings,
  type VideoStudioShot,
  type VideoStudioTrimSide,
} from './project'
import type { VideoStudioSource } from './useVideoStudioLibrary'

// 借对话那一类的说法（「视频已生成」，点开回「创作」页，见 electron/platform/notifications.ts 的 video: 前缀）。
// 同一个编号主进程只报一次，所以拿这一轮第一段的请求号、成片的编号当编号。
function announceVideo(key: string) {
  if (isWindowInFront(typeof document === 'undefined' ? undefined : document)) return
  void platformApi()?.notifyActivity('task', `video:${key}`).catch(() => undefined)
}

export type VideoStudioBridge = Pick<XingmangApi, 'listAiChatGroups' | 'prepareAiChatGroup' | 'planVideoStudio' | 'generateAiVideo' | 'resumeAiVideo' | 'cancelAiVideo' | 'onAiVideoProgress' | 'readAiVideoClip' | 'storeVideoStudioExport' | 'openAiVideo' | 'saveAiVideo' | 'openDiagnosticFolder' | 'pickAiChatImages' | 'pickVideoStudioMusic' | 'readVideoStudioMusic' | 'generateAiImage' | 'cancelAiChat'>

export interface VideoStudioOptions {
  /** 测试里换成在当前线程拼的那一份；缺省在后台线程拼。 */
  compose?: (request: VideoStudioComposeRequest, options: { signal: AbortSignal, onProgress(progress: VideoStudioComposeProgress): void }) => Promise<VideoStudioComposeResult>
  /** 同一个账号里几条视频共用的模型表（「创作」页给）；不给就每次挂上都读一遍。 */
  catalog?: VideoStudioCatalogCache
}

/** 这一处改动怎么存：缺省是客户动的（时间记成现在）、攒一会儿再交给主进程。 */
interface CommitOptions {
  /** false：不是客户动的（模型表读完换默认模型、进度往前走），不把这一条排到列表前面。 */
  touch?: boolean
  /** true：马上交给主进程。请求号、付了钱的结果这类丢不得的用它。 */
  urgent?: boolean
}

export type VideoStudioComposeState =
  | { phase: 'idle' }
  | { phase: 'reading', done: number, total: number }
  | { phase: 'composing', progress: VideoStudioComposeProgress }
  | { phase: 'storing' }

// 一次最多同时生成三段：生成一段要几分钟，一段一段来太慢；全部一起发又容易被服务端限流。
const maxParallelClips = 3
const genericFailure = '此步骤未完成，请稍后重试'

/** 主进程的报错原话是中文就照原样上屏（脱掉路径和密钥）；英文的换成一句兜底话。 */
export function videoStudioErrorMessage(error: unknown, fallback = genericFailure): string {
  const message = userFacingErrorMessage(error)
  const quota = matchRelayQuotaFailureMessage(message)
  if (quota) return relayQuotaFailureMessages[quota]
  return message && speaksChinese(message) ? redactSecretPatterns(message) : fallback
}

// 片段、配乐在作品库里没了：文件在外面被删掉时主进程说「已经不在电脑上了」（D37），
// 编号不是这个账号的还是老说法「不存在或无权访问」，两种都算找不到。
function isGoneFromLibrary(message: string): boolean {
  return resolveMissingAiAssetMessage(message) !== null || /不存在|无权访问/.test(message)
}

/** 只留镜头本身和上一段片段，这一次出片的请求号、进度和报错都去掉。 */
function shotWithoutRun(shot: VideoStudioShot) {
  const { requestId: _requestId, unconfirmed: _unconfirmed, unrecorded: _unrecorded, stage: _stage, progress: _progress, delayed: _delayed, error: _error, ...rest } = shot
  return rest
}

/**
 * 片段停下或失败以后回到什么样：有上一段就还是「已生成」，没有就是「没生成」。失败的留着请求号：
 * 「暂时查不到进度」这类失败时服务端多半还在出，下次打开页面拿它接回来；真失败了主进程回 null，照样回到「没生成」。
 * 提交结果不明的（主进程那句「提交结果不明确」）另外记下 unconfirmed：钱可能扣了、却接不回来，重开也照样提醒。
 * 沿用请求号重新提交的那一单没交出去就停下、或者被服务端明确拒掉，上一次那一单照样可能扣了钱，这个提醒也不丢。
 */
function settleShot(shot: VideoStudioShot, error?: string): VideoStudioShot {
  const rest = shotWithoutRun(shot)
  const { requestId } = shot
  const unconfirmed = Boolean(requestId) && (shot.unconfirmed === true || (error !== undefined && isAiVideoUnconfirmedSubmission(error)))
  const message = error || (unconfirmed ? aiVideoUnconfirmedSubmissionMessage : '')
  if (message) return { ...rest, ...(requestId ? { requestId } : {}), ...(unconfirmed ? { unconfirmed: true } : {}), status: 'failed', error: message }
  return { ...rest, status: rest.clip ? 'done' : 'idle' }
}

/**
 * 排队时不动请求号：失败的那一镜还记着上一单，轮到它时先拿去接回（runShot），不能在排队这一步就丢掉。
 * 排着队被停下，有请求号的回到「失败」（原来那句报错还在），没有的同 settleShot。
 */
function unqueueShot(shot: VideoStudioShot): VideoStudioShot {
  return shot.requestId ? { ...shot, status: 'failed' } : settleShot(shot)
}

/**
 * 点了停下以后，主进程那边这一单是什么情况：billed 是已经交给服务端（钱扣了、停不下来，cancel 报错时也按这个算，
 * 宁可多等一会儿也不让客户再付一次）；stopped 是还没交出去就停住了；finished 是停下时它已经自己结束了，按它自己的结果收尾。
 */
type StopOutcome = 'billed' | 'stopped' | 'finished'

/**
 * 排着队的一镜，连同客户在确认框里点头时的设置：轮到它时照这份出片，不看那之后的设置。页面刚打开、模型表还没读完时
 * 点了生成，读完以后记着的模型可能被换成默认的、时长跟着挪，排在后面的几段不能悄悄换成客户没确认过的模型和时长
 * （#1489 R28-4）。那个模型真的用不了了，主进程在扣费之前就拒掉，报错照样落在这一镜上。
 */
interface QueuedShot { id: string, settings: VideoStudioSettings }

/**
 * 一条视频的工作台。一个实例只管一条：换一条视频就是重新挂一个（外面按视频编号给 key），所以出着的片段、
 * 画着的图、开着的对话框都只会挂回它自己这一条。存到哪由 source 定（useVideoStudioLibrary）。
 */
export function useVideoStudio(bridge: VideoStudioBridge, source: VideoStudioSource, site: ChatSite, enabled: boolean, options: VideoStudioOptions = {}) {
  const [project, setProjectState] = useState(() => source.read())
  const projectRef = useRef(project)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const [groups, setGroups] = useState<AiChatGroupSummary[]>([])
  const groupsRef = useRef<AiChatGroupSummary[]>([])
  const [preparations, setPreparations] = useState<Record<string, ChatGroupPreparation>>({})
  const preparationsRef = useRef<Record<string, ChatGroupPreparation>>({})
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [planning, setPlanning] = useState<string | null>(null)
  const [composeState, setComposeState] = useState<VideoStudioComposeState>({ phase: 'idle' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const owner = useLatestRequest()
  const catalogAttempt = useLatestRequest()
  // 每点一次「停止生成」翻一页：之前排定的「接不回来就重新提交」都不再提交。
  const stops = useLatestRequest()
  const queue = useRef<QueuedShot[]>([])
  const running = useRef(new Map<string, string>())
  const canceled = useRef(new Map<string, Promise<StopOutcome>>())
  // 在接回的那几单：只查不提交，停了也省不下钱，「停止生成」不去碰它们，免得这一镜又变回「还没生成」。
  const billed = useRef(new Set<string>())
  const composeAbort = useRef<AbortController | null>(null)
  // 点过「停止生成图片」的那几次画图：主进程随后回的「已取消」不当成没画出来。
  const stoppedDrawings = useRef(new Set<string>())
  // 这一轮出成了的片段（请求号）：一轮都回来了再一起报一声，不是回来一段报一声。
  const finishedClips = useRef<string[]>([])

  const commit = (change: (current: VideoStudioProject) => VideoStudioProject, { touch = true, urgent = false }: CommitOptions = {}) => {
    const next = change(projectRef.current)
    if (next === projectRef.current) return
    projectRef.current = next
    setProjectState(next)
    sourceRef.current.write(next, { touch, urgent })
  }
  const changeSettings = (patch: Partial<VideoStudioSettings>, how?: CommitOptions) => commit((current) => changeVideoStudioSettings(current, patch), how)
  const settleModels = () => {
    const current = projectRef.current.settings
    const context = { groups: groupsRef.current, site, settled: pendingChatGroups(groupsRef.current, preparationsRef.current).size === 0 }
    const next = settleVideoStudioModels(current, buildVideoStudioCatalogs(groupsRef.current, preparationsRef.current), context)
    // 模型表读完自己换的默认模型，不算客户动了这一条。
    if (Object.entries(next).some(([key, value]) => current[key as keyof typeof next] !== value)) changeSettings(next, { touch: false })
  }
  const setPreparation = (group: string, preparation: ChatGroupPreparation) => {
    preparationsRef.current = { ...preparationsRef.current, [group]: preparation }
    setPreparations(preparationsRef.current)
  }

  // 同聊天页：每个分组都准备一遍（星芒账号上只读模型、不签密钥），模型表才列得全。一次最多三个。
  const refreshModels = async () => {
    const attempt = catalogAttempt.begin(), alive = owner.capture()
    const current = () => attempt() && alive()
    setCatalogLoading(true); setCatalogError('')
    try {
      const listed = await bridge.listAiChatGroups()
      if (!current()) return
      groupsRef.current = listed; setGroups(listed)
      const pending = listed.map((group) => group.name)
      for (const name of pending) setPreparation(name, { phase: 'loading', models: preparationsRef.current[name]?.models ?? [] })
      const worker = async () => {
        for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
          try {
            const prepared = await bridge.prepareAiChatGroup(name)
            if (!current()) return
            const models = [...new Set(prepared.models)].filter((model) => { try { const capability = inspectModel(model); return capability.available && !capability.hidden } catch { return false } })
            setPreparation(name, { phase: 'ready', models })
          } catch {
            if (!current()) return
            setPreparation(name, { phase: 'error', models: [] })
          }
          settleModels()
        }
      }
      await Promise.all([worker(), worker(), worker()])
      if (!current()) return
      settleModels()
      options.catalog?.save({ groups: groupsRef.current, preparations: preparationsRef.current })
      if (listed.length && listed.every((group) => preparationsRef.current[group.name]?.phase === 'error')) setCatalogError('未获取到模型，请点击「刷新模型」')
    } catch (reason) {
      if (current()) setCatalogError(videoStudioErrorMessage(reason, '未获取到模型，请点击「刷新模型」'))
    } finally {
      if (current()) setCatalogLoading(false)
    }
  }

  useEffect(() => {
    if (!enabled) return
    // 只在打开页面（或换了账号重新挂上）时读一次；之后靠「刷新模型」。同一个账号里刚读全过的就照用，换着开视频不再重读。
    const cached = options.catalog?.fresh()
    if (!cached) { void refreshModels(); return }
    groupsRef.current = cached.groups; setGroups(cached.groups)
    preparationsRef.current = cached.preparations; setPreparations(cached.preparations)
    settleModels()
  }, [enabled])

  useEffect(() => bridge.onAiVideoProgress((event) => {
    for (const [shotId, requestId] of running.current) {
      if (requestId !== event.requestId) continue
      // 主进程没能记下这一单（unrecorded）时由页面替它记着，这一笔马上存：重开以后才提醒得了「可能已扣费」。
      commit((current) => updateVideoStudioShot(current, shotId, (shot) => shot.requestId === requestId
        ? { ...shot, status: 'generating', stage: event.stage, ...(event.value === undefined ? {} : { progress: event.value }), delayed: event.delayed === true, ...(event.unrecorded ? { unrecorded: true } : {}) }
        : shot), { touch: false, urgent: event.unrecorded === true })
    }
  }), [bridge])

  // 关掉页面（换账号时整页重挂）就停下拼片；正在生成的片段主进程换账号时自己会停。
  useEffect(() => () => composeAbort.current?.abort(), [])

  // 上次关掉软件（或刷新页面）时还在生成、没等到结果的那几段：拿记着的请求号回主进程接回来。主进程只查不提交，
  // 同一个请求号问两遍（开发版 StrictMode 会把这里跑两遍）接的也是同一份。
  const resumeOpenClips = () => {
    for (const shot of projectRef.current.shots) {
      const { requestId } = shot
      if (shot.status === 'generating' && requestId) resumeClip(shot.id, requestId)
    }
  }
  useEffect(() => {
    if (!enabled) return
    resumeOpenClips()
  }, [enabled])

  const writePlan = async () => {
    const { settings } = projectRef.current
    const idea = videoStudioPlainText(settings.idea)
    if (!idea) { setError('请先描述想拍摄的内容'); return }
    if (!settings.textModel || !settings.textGroup) { setError('暂无可编写分镜的文字模型，请点击「刷新模型」'); return }
    // 拼片读的是现在这份分镜，写新分镜会把它换掉，两件事不能同时做。
    // 画着图的镜头也一样：新分镜换掉镜头以后，画好的图找不到它那一镜。
    if (planning || running.current.size || queue.current.length || composeAbort.current || projectRef.current.shots.some(isVideoStudioShotDrawing)) return
    const requestId = createVideoStudioId(), alive = owner.capture()
    setPlanning(requestId); setError(''); setNotice('')
    try {
      const plan = await bridge.planVideoStudio({
        requestId, group: settings.textGroup, model: settings.textModel, idea,
        shotCount: settings.shotCount, secondsPerShot: settings.secondsPerShot, aspect: settings.aspect, captions: settings.captions,
      })
      if (!alive()) return
      commit((current) => applyVideoStudioPlan(current, plan))
      if (plan.shots.length < settings.shotCount) setNotice(`AI 仅生成了 ${plan.shots.length} 个镜头，您可自行添加。`)
    } catch (reason) {
      if (!alive()) return
      const message = videoStudioErrorMessage(reason, '分镜生成失败，请稍后重试')
      // 客户自己点了停：主进程那句不上屏。11-22 由「已停止写分镜」改成「已停止生成分镜」（界面文案正式化第 17 批），两种都认。
      if (message !== '已停止生成分镜' && message !== '已停止写分镜') setError(message)
    } finally {
      if (alive()) setPlanning(null)
    }
  }
  const stopPlan = async () => {
    if (!planning) return
    try { await bridge.cancelAiVideo(planning) } catch { /* 停不下来就等它自己写完，写完照样能用。 */ }
  }

  /**
   * 等一段片段回来：新发的（generateAiVideo）和接回来的（resumeAiVideo）走同一套收尾。接回来是 null 就是主进程没有这一单，
   * 缺省回到「还没生成」，给了 onMissing 就交给它；主进程当初没记下的那一单（unrecorded）查不到不等于没发过，照「提交结果不明」算。
   * 停下时已经交给服务端的那一单，不收尾，接着拿请求号去接回。
   */
  async function awaitClip(shotId: string, requestId: string, request: () => Promise<AiVideoClip | null>, onMissing?: () => void) {
    const alive = owner.capture()
    running.current.set(shotId, requestId)
    // 腾出这个位置以后接着做的事：这一镜还占着位置，不能先让排队的顶上来。
    let next: (() => void) | undefined
    try {
      const clip = await request()
      if (!alive()) return
      if (!clip && onMissing) { next = onMissing; return }
      // 付了钱的片段回来了：马上存，不等攒那一会儿。
      commit((current) => {
        const updated = updateVideoStudioShot(current, shotId, (item) => item.requestId !== requestId ? item
          : clip ? { ...withoutVideoStudioBorrowed(withoutVideoStudioTrim(shotWithoutRun(item))), clip, status: 'done' }
            : settleShot(item, item.unrecorded ? aiVideoUnconfirmedSubmissionMessage : undefined))
        return clip ? { ...updated, exported: undefined } : updated
      }, { urgent: true })
      if (clip) finishedClips.current.push(requestId)
    } catch (reason) {
      if (!alive()) return
      const message = videoStudioErrorMessage(reason, '此片段生成失败，请稍后重新生成')
      const stop = canceled.current.get(requestId)
      const outcome = stop ? await stop : 'finished'
      if (!alive()) return
      if (outcome === 'billed') {
        // 主进程说这一单可能照样出、照样扣费：钱已经花了，接着等它回来挂回这一镜。主进程那边没有这一单
        // （提交到一半就停了，拿不到结果）时，按刚才那句报错算失败，不让它悄悄变回「还没生成」。
        next = () => resumeClip(shotId, requestId, () => commit((current) => updateVideoStudioShot(current, shotId, (item) => item.requestId === requestId ? settleShot(item, message) : item), { urgent: true }))
        return
      }
      commit((current) => updateVideoStudioShot(current, shotId, (item) => item.requestId === requestId
        ? settleShot(item, outcome === 'stopped' ? undefined : message)
        : item), { urgent: true })
    } finally {
      canceled.current.delete(requestId)
      if (running.current.get(shotId) === requestId) running.current.delete(shotId)
      if (next) next()
      else if (alive()) pump()
      if (alive()) announceClips()
    }
  }
  /**
   * 排着的、在出的都没了：这一轮至少出成了一段、窗口又不在前台时发一条系统通知，同对话里出视频（创作页复查第 5 条）。
   * 片段常要好几分钟，客户多半切走了；以前工作台这边出完不说，只有对话里出的才说。
   */
  function announceClips() {
    if (running.current.size || queue.current.length || !finishedClips.current.length) return
    const [first] = finishedClips.current
    finishedClips.current = []
    announceVideo(first)
  }
  /** 接回已经交给服务端的那一单：只查不提交，那一单的钱已经付过了。停下不碰它。 */
  function resumeClip(shotId: string, requestId: string, onMissing?: () => void) {
    billed.current.add(requestId)
    void awaitClip(shotId, requestId, () => bridge.resumeAiVideo(requestId), onMissing).finally(() => {
      if (running.current.get(shotId) !== requestId) billed.current.delete(requestId)
    })
  }
  /**
   * 新提交一单：这一步开始花钱。按确认时的那份设置出（QueuedShot）。上一次提交结果不明的那一镜沿用原来的请求号：
   * MiniMax 拿它当去重的凭据，服务端其实收下过那一单时不会再出一份。在出的这段时间 unconfirmed 还留在这一镜上
   * （不存，见 project.ts），这一单没出成时那句提醒跟着回来。
   */
  function submitShot(shotId: string, settings: VideoStudioSettings, requestId = createVideoStudioId()) {
    const shot = projectRef.current.shots.find((item) => item.id === shotId)
    if (!shot) return
    const unconfirmed = shot.unconfirmed === true && shot.requestId === requestId
    // 沿用的请求号这回是新交出去的一单，停下时要去停它，不能还按「在接回的」跳过。
    billed.current.delete(requestId)
    // 请求号先交给主进程存下，再提交这一单：主进程等这一笔写完才往外发（video:generate 里等 videoStudioProjects.idle()），
    // 提交完就崩了，重开以后也拿得回这一段。
    commit((current) => updateVideoStudioShot(current, shotId, (item) => ({ ...shotWithoutRun(item), status: 'generating', requestId, ...(unconfirmed ? { unconfirmed } : {}) })), { urgent: true })
    void awaitClip(shotId, requestId, () => bridge.generateAiVideo(buildVideoStudioClipRequest(settings, shot, requestId)))
  }
  /**
   * 轮到这一镜。上一单没等到结果就失败了的（「暂时查不到进度」这类，服务端多半还在出），先拿记着的请求号接回：
   * 接得回来就不用再付一次钱；主进程那边确实没有这一单，才重新提交。提交结果不明的那一镜没有任务号、接不回来，
   * 客户已经在确认框里看过「可能多扣一次」，直接沿用原来的请求号重新提交。
   */
  function runShot(shotId: string, settings: VideoStudioSettings) {
    const shot = projectRef.current.shots.find((item) => item.id === shotId)
    if (!shot) return
    const { requestId: previous } = shot
    if (!previous) { submitShot(shotId, settings); return }
    if (shot.unconfirmed) { submitShot(shotId, settings, previous); return }
    commit((current) => updateVideoStudioShot(current, shotId, (item) => {
      const { error: _error, ...rest } = item
      return { ...rest, status: 'generating' }
    }))
    // 接回期间点了「停止生成」，主进程又说没有这一单：停下以后不再花钱，回到没在生成的样子。
    const going = stops.capture()
    resumeClip(shotId, previous, () => {
      if (projectRef.current.shots.find((item) => item.id === shotId)?.requestId !== previous) return
      if (going()) submitShot(shotId, settings)
      else commit((current) => updateVideoStudioShot(current, shotId, (item) => item.requestId === previous ? settleShot(item) : item))
    })
  }
  function pump() {
    while (running.current.size < maxParallelClips && queue.current.length) {
      const next = queue.current.shift()
      if (next && projectRef.current.shots.some((shot) => shot.id === next.id)) void runShot(next.id, next.settings)
    }
  }
  /** 生成这几个镜头的片段（已经有片段的就是重新生成）。先检查每一镜都写好了，有一处没写好就一段都不发。 */
  const generate = (shotIds: readonly string[]) => {
    // 写分镜会把镜头整个换掉，付了钱的片段回来时就找不到镜头；拼片读的是现在这几段。这两件事做着时不出片，
    // 同 writePlan 那边（按钮这时也是灰的，这里兜住以后别的入口）。
    if (planning || composeAbort.current) return
    const { shots, settings } = projectRef.current
    if (!settings.videoModel || !settings.videoGroup) { setError('暂无可生成视频的模型，请点击「刷新模型」'); return }
    // 正在画图的那一镜不出：图还没定，出来的片段会和它对不上（按钮这时也是灰的）。
    const chosen = shots.filter((shot) => shotIds.includes(shot.id) && !isVideoStudioShotBusy(shot) && !isVideoStudioShotDrawing(shot))
    for (const shot of chosen) {
      const problem = videoStudioShotProblem(shot, shots.indexOf(shot))
      if (problem) { setError(problem); return }
    }
    setError(''); setNotice('')
    queue.current.push(...chosen.map((shot) => ({ id: shot.id, settings })))
    commit((current) => chosen.reduce((next, shot) => updateVideoStudioShot(next, shot.id, (item) => ({ ...item, status: 'queued' })), current))
    pump()
  }
  /**
   * 全部停下：排着队的和还没交给服务端的不再发。已经交给服务端的停不下来、钱已经扣了，接着等它回来挂回原来的镜头，
   * 不能让它变回「还没生成」——那样「生成剩下的」一点就是同一段再付一次钱。
   */
  const stopGenerating = async () => {
    stops.invalidate()
    const queued = queue.current.splice(0)
    commit((current) => queued.reduce((next, { id }) => updateVideoStudioShot(next, id, (shot) => shot.status === 'queued' ? unqueueShot(shot) : shot), current))
    const requests = [...running.current.values()]
    let stillRunning = 0
    await Promise.all(requests.map(async (requestId) => {
      if (billed.current.has(requestId)) { stillRunning += 1; return }
      const stop: Promise<StopOutcome> = bridge.cancelAiVideo(requestId).then(
        (result) => !result.canceled ? 'finished' : result.mayStillComplete ? 'billed' : 'stopped',
        () => 'billed',
      )
      canceled.current.set(requestId, stop)
      if (await stop === 'billed') stillRunning += 1
    }))
    if (stillRunning) setNotice(`已停止。其中 ${stillRunning} 段已提交至服务端并完成扣费，无法中止；将继续等待生成完成，完成后自动放回对应镜头。`)
  }

  const compose = async () => {
    const current = projectRef.current
    if (!videoStudioReadyToCompose(current) || composeAbort.current || planning) return
    const controller = new AbortController(), alive = owner.capture()
    composeAbort.current = controller
    setError(''); setNotice('')
    const captions = videoStudioComposeCaptions(current)
    const inputs = videoStudioComposeKey(current)
    try {
      const clips: VideoStudioComposeRequest['clips'] = []
      let totalBytes = 0
      const totalBytesLimit = videoStudioTotalBytesLimit()
      for (const [index, shot] of current.shots.entries()) {
        setComposeState({ phase: 'reading', done: index, total: current.shots.length })
        let bytes: Uint8Array
        try {
          bytes = await bridge.readAiVideoClip(shot.clip!.assetId)
        } catch (reason) {
          const message = userFacingErrorMessage(reason)
          throw new Error(isGoneFromLibrary(message) ? `作品库中未找到第 ${index + 1} 段片段，请重新生成该段后再合成` : videoStudioErrorMessage(reason, `第 ${index + 1} 段片段读取失败，请稍后重试`))
        }
        if (controller.signal.aborted || !alive()) return
        totalBytes = addVideoStudioClipBytes(totalBytes, bytes.byteLength, totalBytesLimit)
        // 交给后台线程时字节是转移过去的，要一份自己独占的 ArrayBuffer。
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        clips.push({
          data: data instanceof ArrayBuffer ? data : new Uint8Array(bytes).buffer,
          ...(captions[index] ? { caption: captions[index] } : {}),
          ...(shot.trimStart ? { trimStart: shot.trimStart } : {}), ...(shot.trimEnd ? { trimEnd: shot.trimEnd } : {}),
        })
      }
      const sound = videoStudioComposeSound(current)
      let music: VideoStudioComposeRequest['music']
      if (sound.music) {
        let bytes: Uint8Array
        try {
          bytes = await bridge.readVideoStudioMusic(sound.music.assetId)
        } catch (reason) {
          // 作品库里没了（客户删了那个文件）也是「这首歌用不了」；别的（没登录、排队满了）照主进程原话说。
          throw new Error(isGoneFromLibrary(userFacingErrorMessage(reason)) ? videoStudioMusicUnreadableMessage : videoStudioErrorMessage(reason, videoStudioMusicUnreadableMessage))
        }
        if (controller.signal.aborted || !alive()) return
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        music = { data: data instanceof ArrayBuffer ? data : new Uint8Array(bytes).buffer, gain: sound.music.gain }
      }
      const run = options.compose ?? ((request, composeOptions) => composeInVideoStudioWorker(request, composeOptions))
      const request: VideoStudioComposeRequest = {
        clips,
        options: { aspect: current.settings.aspect, resolution: current.settings.resolution, fit: current.settings.fit, frameRate: 24, transition: current.settings.transition, fadeOut: current.settings.fadeOut,
          captionSize: current.settings.captionSize, captionPosition: current.settings.captionPosition },
        ...(music ? { music } : {}),
        ...(sound.clipGain === undefined ? {} : { clipGain: sound.clipGain }),
      }
      const result = await run(request, {
        signal: controller.signal,
        onProgress: (progress) => { if (alive()) setComposeState({ phase: 'composing', progress }) },
      })
      if (controller.signal.aborted || !alive()) return
      setComposeState({ phase: 'storing' })
      const stored = await bridge.storeVideoStudioExport(new Uint8Array(result.data))
      if (!alive()) return
      announceVideo(stored.assetId)
      if (videoStudioComposeKey(projectRef.current) !== inputs) { setNotice('成片已保存至作品库。合成期间分镜已修改，此处未更新，如需使用新分镜请重新合成。'); return }
      commit((latest) => ({ ...latest, exported: stored }), { urgent: true })
      setNotice(result.audioCodec === null && current.shots.length ? '合成完成。所选片段均无声音，成片同样无声音。' : '合成完成，成片已保存至作品库。')
    } catch (reason) {
      if (!alive() || controller.signal.aborted || isVideoStudioAbort(reason)) return
      // 拼片引擎的报错已经是中文；读片段、存成片走主进程，原话隔着一层 IPC 前缀。
      setError(reason instanceof VideoStudioError ? reason.message : videoStudioErrorMessage(reason, describeVideoStudioFailure(reason)))
    } finally {
      if (composeAbort.current === controller) composeAbort.current = null
      if (alive()) setComposeState({ phase: 'idle' })
    }
  }
  const stopCompose = () => composeAbort.current?.abort()

  // 「用一张图开头」：用对话页选图那条通道（原生对话框、过大的图主进程先缩好、存进作品库），这里只拿编号。
  // 一次能多选几张，多出来的按顺序给后面的镜头（assignVideoStudioShotImages）；一次最多几张照对话那条的上限。
  const pickShotImage = async (id: string) => {
    const alive = owner.capture()
    try {
      const picked = await bridge.pickAiChatImages(AI_CHAT_LIMITS.imagesPerMessage)
      if (!alive() || !picked.length) return
      commit((current) => assignVideoStudioShotImages(current, id, picked.map((asset) => asset.assetId)))
    } catch (reason) {
      if (alive()) setError(videoStudioErrorMessage(reason))
    }
  }

  // 「从作品库选图」「使用已有片段」（融合第 3 步）：选择框由「创作」页开（pick），这里只等它交回编号，挂到这一镜上。
  // 选的时候换成了别的视频（这个工作台卸掉了），选好的不挂到换上来的那一条上。
  const pickLibraryImage = async (id: string, pick: () => Promise<string | null>) => {
    const alive = owner.capture()
    const assetId = await pick()
    if (alive() && assetId) commit((current) => assignVideoStudioShotImages(current, id, [assetId]))
  }
  const pickLibraryClip = async (id: string, pick: () => Promise<VideoStudioClipSource | null>) => {
    const alive = owner.capture()
    const picked = await pick()
    if (alive() && picked) commit((current) => assignVideoStudioShotClip(current, id, picked))
  }

  // 「加配乐」：歌由主进程弹系统对话框选、存进作品库，这里只拿编号、歌名和时长。
  const pickMusic = async () => {
    // 对话框开着时换成了别的视频（这个工作台卸掉了），选好的歌不挂到换上来的那一条上（歌照样在作品库里）。
    const alive = owner.capture()
    try {
      const picked = await bridge.pickVideoStudioMusic()
      if (!alive() || !picked) return
      commit((current) => setVideoStudioMusic(current, picked))
    } catch (reason) {
      if (alive()) setError(videoStudioErrorMessage(reason, videoStudioMusicUnreadableMessage))
    }
  }

  // 「AI 生成图片」：用对话页出图那条（chat:generate-image，凭据在主进程、画好的图存进作品库），这里只拿编号，
  // 画好以后和自己选的图一样用。先出图便宜，客户满意了再拿它出视频。余额、额度不够照页面顶上那条说（带「前往充值」）。
  // 画面描述、型号、尺寸这些是出图框里填好交过来的（融合第 4 步，ShotImageDialog），不再读这条视频自己记的画图型号。
  const drawShotImage = async (id: string, draft: VideoStudioImageDraft) => {
    if (planning || composeAbort.current) return
    const shot = projectRef.current.shots.find((item) => item.id === id)
    if (!shot || isVideoStudioShotBusy(shot) || isVideoStudioShotDrawing(shot) || !draft.model || !draft.group || !videoStudioPlainText(draft.prompt)) return
    const requestId = createVideoStudioId(), alive = owner.capture()
    setError(''); setNotice('')
    commit((current) => startVideoStudioShotDrawing(current, id, requestId))
    try {
      const [asset] = await bridge.generateAiImage(buildVideoStudioImageRequest(draft, requestId))
      if (!alive()) return
      // 付了钱的图回来了：同片段，马上存。
      commit((current) => finishVideoStudioShotDrawing(current, id, requestId, asset ? { assetId: asset.assetId } : { error: '未收到生成的图片' }), { urgent: true })
    } catch (reason) {
      if (!alive()) return
      if (stoppedDrawings.current.has(requestId)) { commit((current) => finishVideoStudioShotDrawing(current, id, requestId, 'stopped')); return }
      const message = videoStudioErrorMessage(reason)
      if (matchRelayQuotaFailureMessage(message)) {
        commit((current) => finishVideoStudioShotDrawing(current, id, requestId, 'stopped'))
        setError(message)
      } else {
        commit((current) => finishVideoStudioShotDrawing(current, id, requestId, { error: message }))
      }
    } finally {
      stoppedDrawings.current.delete(requestId)
    }
  }
  // 「停止生成图片」：已经交给服务端的这一张照样扣费（出图框里说过）。主进程说已经画完、正在回的，就等它回来照常换上。
  const stopDrawing = async (id: string) => {
    const requestId = projectRef.current.shots.find((item) => item.id === id)?.drawing
    if (!requestId || stoppedDrawings.current.has(requestId)) return
    const alive = owner.capture()
    stoppedDrawings.current.add(requestId)
    try {
      const result = await bridge.cancelAiChat(requestId)
      if (!alive()) return
      if (result.canceled) commit((current) => finishVideoStudioShotDrawing(current, id, requestId, 'stopped'))
      else stoppedDrawings.current.delete(requestId)
    } catch {
      stoppedDrawings.current.delete(requestId)
    }
  }

  const openClip = async (assetId: string) => {
    try { await bridge.openAiVideo(assetId) } catch (reason) { setError(videoStudioErrorMessage(reason, '视频打开失败，请稍后重试')) }
  }
  // 另存时对话框里默认用片名当文件名（主进程洗成干净的文件名），没有片名就用作品库原来的名字。
  const saveClip = async (assetId: string, name?: string): Promise<boolean> => {
    try { return (await bridge.saveAiVideo(assetId, name?.trim() || undefined)).saved } catch (reason) { setError(videoStudioErrorMessage(reason, '保存失败，请更换位置后重试')); return false }
  }
  // 页面上好几处说「存入作品库」，这里直接打开它（磁盘上那个 AI 作品文件夹）。用的是检查页那条：路径由主进程算、过了 I8 检查才打开，这里只说要哪一个。
  const openFolder = async () => {
    try {
      if (!(await bridge.openDiagnosticFolder('ai-output'))) setError(diagnosticFolderUnavailableMessage)
    } catch (reason) {
      setError(videoStudioErrorMessage(reason, diagnosticFolderUnavailableMessage))
    }
  }

  const busy = Boolean(planning) || project.shots.some((shot) => isVideoStudioShotBusy(shot) || isVideoStudioShotDrawing(shot)) || composeState.phase !== 'idle'
  // 写分镜、出片、拼片都靠这一页接着往下走：做着的时候窗口缩到托盘也不关界面（electron/renderer-release.ts）。
  useBackgroundWork('video-studio', busy)
  // 拼片也在这一页里跑，重启装更新会把它停下、重开以后要从头再拼：主进程要点名问一句（D10）。
  // 出片交给服务端，重开以后接着取回来，不在这一样里。
  useBackgroundWork('video-compose', composeState.phase !== 'idle', 'video-compose')
  return {
    site, project, groups, preparations, catalogLoading, catalogError, planning: Boolean(planning), composeState, error, notice, storageWarning: source.warning, busy,
    catalogs: buildVideoStudioCatalogs(groups, preparations),
    setError, setNotice, changeSettings, refreshModels, writePlan, stopPlan, generate, stopGenerating, compose, stopCompose, openClip, saveClip, openFolder,
    selectVideoModel: (model: string, group: string) => commit((current) => selectVideoStudioVideoModel(current, model, group)),
    setShotSeconds: (id: string, seconds: number) => commit((current) => setVideoStudioShotSeconds(current, id, seconds)),
    selectTextModel: (model: string, group: string) => changeSettings({ textModel: model, textGroup: group }),
    setShotTrim: (id: string, side: VideoStudioTrimSide, seconds: number) => commit((current) => setVideoStudioShotTrim(current, id, side, seconds)),
    drawShotImage,
    stopDrawing,
    editShot: (id: string, patch: Partial<Pick<VideoStudioShot, 'prompt' | 'caption'>>) => commit((current) => ({ ...updateVideoStudioShot(current, id, (shot) => ({ ...shot, ...patch })), ...(patch.caption === undefined ? {} : { exported: undefined }) })),
    moveShot: (id: string, offset: -1 | 1) => commit((current) => ({ ...moveVideoStudioShot(current, id, offset), exported: undefined })),
    removeShot: (id: string) => commit((current) => ({ ...removeVideoStudioShot(current, id), exported: undefined })),
    addShot: () => commit((current) => addVideoStudioShot(current)),
    pickShotImage,
    // 出图框「添加参考图」：同对话里加图片那条（chat:pick-images），选好的图存进作品库、回编号。出错由出图框自己说。
    pickReferenceImages: (room: number) => bridge.pickAiChatImages(room),
    removeShotImage: (id: string) => commit((current) => removeVideoStudioShotImage(current, id)),
    pickLibraryImage,
    pickLibraryClip,
    removeShotClip: (id: string) => commit((current) => removeVideoStudioShotClip(current, id)),
    pickMusic,
    removeMusic: () => commit((current) => removeVideoStudioMusic(current)),
    setClipSound: (clipSound: VideoStudioClipSound) => commit((current) => setVideoStudioClipSound(current, clipSound)),
  }
}

export type VideoStudioController = ReturnType<typeof useVideoStudio>
