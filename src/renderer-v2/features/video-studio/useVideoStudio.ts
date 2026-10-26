import { useEffect, useRef, useState } from 'react'
import type { AiChatGroupSummary, AiVideoClip, XingmangApi } from '../../../../electron/ipc-contract'
import { matchRelayQuotaFailureMessage, relayQuotaFailureMessages } from '../../../../electron/relay-quota-failure'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { speaksChinese, userFacingErrorMessage } from '../../business-common'
import { useBackgroundWork } from '../../background-work'
import { useLatestRequest } from '../../latest-request'
import { diagnosticFolderUnavailableMessage } from '../app/diagnostic-folder'
import { inspectModel } from '../chat/api'
import { pendingChatGroups, type ChatGroupPreparation, type ChatSite } from '../chat/state'
import { composeInVideoStudioWorker } from './compose-client'
import type { VideoStudioComposeProgress, VideoStudioComposeRequest, VideoStudioComposeResult } from './compose-protocol'
import { VideoStudioError, describeVideoStudioFailure, isVideoStudioAbort } from './errors'
import {
  addVideoStudioShot,
  applyVideoStudioPlan,
  buildVideoStudioCatalogs,
  buildVideoStudioClipRequest,
  clampVideoStudioSeconds,
  createVideoStudioId,
  createVideoStudioProject,
  isVideoStudioShotBusy,
  moveVideoStudioShot,
  removeVideoStudioShot,
  restoreVideoStudioProject,
  serializeVideoStudioProject,
  settleVideoStudioModels,
  updateVideoStudioShot,
  videoStudioComposeCaptions,
  videoStudioComposeKey,
  videoStudioReadyToCompose,
  videoStudioShotProblem,
  videoStudioStorageKey,
  type VideoStudioProject,
  type VideoStudioSettings,
  type VideoStudioShot,
} from './project'

export type VideoStudioBridge = Pick<XingmangApi, 'listAiChatGroups' | 'prepareAiChatGroup' | 'planVideoStudio' | 'generateAiVideo' | 'resumeAiVideo' | 'cancelAiVideo' | 'onAiVideoProgress' | 'readAiVideoClip' | 'storeVideoStudioExport' | 'openAiVideo' | 'saveAiVideo' | 'openDiagnosticFolder'>
export type VideoStudioStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface VideoStudioOptions {
  /** 测试里换成在当前线程拼的那一份；缺省在后台线程拼。 */
  compose?: (request: VideoStudioComposeRequest, options: { signal: AbortSignal, onProgress(progress: VideoStudioComposeProgress): void }) => Promise<VideoStudioComposeResult>
  /** 缺省是这个窗口的 localStorage。 */
  storage?: VideoStudioStorage | null
}

export type VideoStudioComposeState =
  | { phase: 'idle' }
  | { phase: 'reading', done: number, total: number }
  | { phase: 'composing', progress: VideoStudioComposeProgress }
  | { phase: 'storing' }

// 一次最多同时生成三段：生成一段要几分钟，一段一段来太慢；全部一起发又容易被服务端限流。
const maxParallelClips = 3
const genericFailure = '这一步没有完成，请稍后再试'

/** 主进程的报错原话是中文就照原样上屏（脱掉路径和密钥）；英文的换成一句兜底话。 */
export function videoStudioErrorMessage(error: unknown, fallback = genericFailure): string {
  const message = userFacingErrorMessage(error)
  const quota = matchRelayQuotaFailureMessage(message)
  if (quota) return relayQuotaFailureMessages[quota]
  return message && speaksChinese(message) ? redactSecretPatterns(message) : fallback
}

function defaultStorage(): VideoStudioStorage | null {
  try { return window.localStorage } catch { return null }
}

function loadProject(storage: VideoStudioStorage | null, scope: string): VideoStudioProject {
  try {
    const raw = storage?.getItem(videoStudioStorageKey(scope))
    if (raw) return restoreVideoStudioProject(JSON.parse(raw)) ?? createVideoStudioProject()
  } catch {
    // 读不出来就从空的开始；下次保存会盖掉坏掉的那份。
  }
  return createVideoStudioProject()
}

/**
 * 片段停下或失败以后回到什么样：有上一段就还是「已生成」，没有就是「没生成」。失败的留着请求号：
 * 「暂时查不到进度」这类失败时服务端多半还在出，下次打开页面拿它接回来；真失败了主进程回 null，照样回到「没生成」。
 */
function settleShot(shot: VideoStudioShot, error?: string): VideoStudioShot {
  const { requestId, stage: _stage, progress: _progress, delayed: _delayed, error: _error, ...rest } = shot
  if (error) return { ...rest, ...(requestId ? { requestId } : {}), status: 'failed', error }
  return { ...rest, status: rest.clip ? 'done' : 'idle' }
}

export function useVideoStudio(bridge: VideoStudioBridge, scope: string, site: ChatSite, enabled: boolean, options: VideoStudioOptions = {}) {
  const [storage] = useState(() => options.storage === undefined ? defaultStorage() : options.storage)
  const [project, setProjectState] = useState(() => loadProject(storage, scope))
  const projectRef = useRef(project)
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
  const [storageWarning, setStorageWarning] = useState('')
  const owner = useLatestRequest()
  const catalogAttempt = useLatestRequest()
  const queue = useRef<string[]>([])
  const running = useRef(new Map<string, string>())
  const canceled = useRef(new Set<string>())
  const composeAbort = useRef<AbortController | null>(null)

  const commit = (change: (current: VideoStudioProject) => VideoStudioProject) => {
    const next = change(projectRef.current)
    if (next === projectRef.current) return
    projectRef.current = next
    setProjectState(next)
    try {
      storage?.setItem(videoStudioStorageKey(scope), JSON.stringify(serializeVideoStudioProject(next)))
      setStorageWarning('')
    } catch {
      setStorageWarning('这台电脑上存不下这份分镜，关掉软件以后要重新写。生成好的片段照样在作品库里。')
    }
  }
  const changeSettings = (patch: Partial<VideoStudioSettings>) => commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }))
  const settleModels = () => {
    const current = projectRef.current.settings
    const context = { groups: groupsRef.current, site, settled: pendingChatGroups(groupsRef.current, preparationsRef.current).size === 0 }
    const next = settleVideoStudioModels(current, buildVideoStudioCatalogs(groupsRef.current, preparationsRef.current), context)
    if (Object.entries(next).some(([key, value]) => current[key as keyof typeof next] !== value)) changeSettings(next)
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
      if (listed.length && listed.every((group) => preparationsRef.current[group.name]?.phase === 'error')) setCatalogError('没读到模型，点「刷新模型」再试')
    } catch (reason) {
      if (current()) setCatalogError(videoStudioErrorMessage(reason, '没读到模型，点「刷新模型」再试'))
    } finally {
      if (current()) setCatalogLoading(false)
    }
  }

  useEffect(() => {
    if (!enabled) return
    void refreshModels()
    // 只在打开页面（或换了账号重新挂上）时读一次；之后靠「刷新模型」。
  }, [enabled])

  useEffect(() => bridge.onAiVideoProgress((event) => {
    for (const [shotId, requestId] of running.current) {
      if (requestId !== event.requestId) continue
      commit((current) => updateVideoStudioShot(current, shotId, (shot) => shot.requestId === requestId
        ? { ...shot, status: 'generating', stage: event.stage, ...(event.value === undefined ? {} : { progress: event.value }), delayed: event.delayed === true }
        : shot))
    }
  }), [bridge])

  // 关掉页面（换账号时整页重挂）就停下拼片；正在生成的片段主进程换账号时自己会停。
  useEffect(() => () => composeAbort.current?.abort(), [])

  // 上次关掉软件（或刷新页面）时还在生成、没等到结果的那几段：拿记着的请求号回主进程接回来。主进程只查不提交，
  // 同一个请求号问两遍（开发版 StrictMode 会把这里跑两遍）接的也是同一份。
  useEffect(() => {
    if (!enabled) return
    for (const shot of projectRef.current.shots) {
      const { requestId } = shot
      if (shot.status === 'generating' && requestId) void awaitClip(shot.id, requestId, () => bridge.resumeAiVideo(requestId))
    }
  }, [enabled])

  const writePlan = async () => {
    const { settings } = projectRef.current
    if (!settings.idea.trim()) { setError('先写一句想拍什么'); return }
    if (!settings.textModel || !settings.textGroup) { setError('还没有能写分镜的文字模型，点「刷新模型」再试'); return }
    // 拼片读的是现在这份分镜，写新分镜会把它换掉，两件事不能同时做。
    if (planning || running.current.size || queue.current.length || composeAbort.current) return
    const requestId = createVideoStudioId(), alive = owner.capture()
    setPlanning(requestId); setError(''); setNotice('')
    try {
      const plan = await bridge.planVideoStudio({
        requestId, group: settings.textGroup, model: settings.textModel, idea: settings.idea.trim(),
        shotCount: settings.shotCount, secondsPerShot: settings.secondsPerShot, aspect: settings.aspect, captions: settings.captions,
      })
      if (!alive()) return
      commit((current) => applyVideoStudioPlan(current, plan))
      if (plan.shots.length < settings.shotCount) setNotice(`AI 只写了 ${plan.shots.length} 个镜头，可以自己再加几个。`)
    } catch (reason) {
      if (!alive()) return
      const message = videoStudioErrorMessage(reason, '分镜没写出来，请稍后再试')
      if (message !== '已停止写分镜') setError(message)
    } finally {
      if (alive()) setPlanning(null)
    }
  }
  const stopPlan = async () => {
    if (!planning) return
    try { await bridge.cancelAiVideo(planning) } catch { /* 停不下来就等它自己写完，写完照样能用。 */ }
  }

  /** 等一段片段回来：新发的（generateAiVideo）和重开页面接回来的（resumeAiVideo）走同一套收尾。接回来是 null 就是没有这一单。 */
  async function awaitClip(shotId: string, requestId: string, request: () => Promise<AiVideoClip | null>) {
    const alive = owner.capture()
    running.current.set(shotId, requestId)
    try {
      const clip = await request()
      if (!alive()) return
      commit((current) => {
        const next = updateVideoStudioShot(current, shotId, (item) => item.requestId === requestId ? settleShot(clip ? { ...item, clip } : item) : item)
        return clip ? { ...next, exported: undefined } : next
      })
    } catch (reason) {
      if (!alive()) return
      const stopped = canceled.current.has(requestId)
      commit((current) => updateVideoStudioShot(current, shotId, (item) => item.requestId === requestId
        ? settleShot(item, stopped ? undefined : videoStudioErrorMessage(reason, '这一段没生成出来，请稍后重新生成'))
        : item))
    } finally {
      canceled.current.delete(requestId)
      if (running.current.get(shotId) === requestId) running.current.delete(shotId)
      if (alive()) pump()
    }
  }
  const runShot = (shotId: string) => {
    const shot = projectRef.current.shots.find((item) => item.id === shotId)
    if (!shot) return
    const requestId = createVideoStudioId()
    commit((current) => updateVideoStudioShot(current, shotId, (item) => ({ ...settleShot(item), status: 'generating', requestId })))
    void awaitClip(shotId, requestId, () => bridge.generateAiVideo(buildVideoStudioClipRequest(projectRef.current.settings, shot, requestId)))
  }
  function pump() {
    while (running.current.size < maxParallelClips && queue.current.length) {
      const next = queue.current.shift()
      if (next && projectRef.current.shots.some((shot) => shot.id === next)) void runShot(next)
    }
  }
  /** 生成这几个镜头的片段（已经有片段的就是重新生成）。先检查每一镜都写好了，有一处没写好就一段都不发。 */
  const generate = (shotIds: readonly string[]) => {
    const { shots, settings } = projectRef.current
    if (!settings.videoModel || !settings.videoGroup) { setError('还没有能出视频的模型，点「刷新模型」再试'); return }
    const chosen = shots.filter((shot) => shotIds.includes(shot.id) && !isVideoStudioShotBusy(shot))
    for (const shot of chosen) {
      const problem = videoStudioShotProblem(shot, shots.indexOf(shot))
      if (problem) { setError(problem); return }
    }
    setError(''); setNotice('')
    queue.current.push(...chosen.map((shot) => shot.id))
    commit((current) => chosen.reduce((next, shot) => updateVideoStudioShot(next, shot.id, (item) => ({ ...settleShot(item), status: 'queued' })), current))
    pump()
  }
  /** 全部停下。已经交给服务端的照样生成、照样扣费，好了会放进作品库，只是这里不再等它。 */
  const stopGenerating = async () => {
    const queued = queue.current.splice(0)
    commit((current) => queued.reduce((next, id) => updateVideoStudioShot(next, id, (shot) => shot.status === 'queued' ? settleShot(shot) : shot), current))
    const requests = [...running.current.values()]
    let stillRunning = 0
    await Promise.all(requests.map(async (requestId) => {
      canceled.current.add(requestId)
      try {
        const result = await bridge.cancelAiVideo(requestId)
        if (result.mayStillComplete) stillRunning += 1
      } catch {
        stillRunning += 1
      }
    }))
    if (stillRunning) setNotice(`已经停下。其中 ${stillRunning} 段已经交给服务端，会照样生成、照样扣费，好了会存进 AI 作品文件夹，这里不会自动换上。`)
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
      for (const [index, shot] of current.shots.entries()) {
        setComposeState({ phase: 'reading', done: index, total: current.shots.length })
        let bytes: Uint8Array
        try {
          bytes = await bridge.readAiVideoClip(shot.clip!.assetId)
        } catch (reason) {
          const message = userFacingErrorMessage(reason)
          throw new Error(/不存在|无权访问/.test(message) ? `第 ${index + 1} 段片段在作品库里找不到了，重新生成这一段再拼` : videoStudioErrorMessage(reason, `第 ${index + 1} 段片段读不出来，请稍后再试`))
        }
        if (controller.signal.aborted || !alive()) return
        // 交给后台线程时字节是转移过去的，要一份自己独占的 ArrayBuffer。
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        clips.push({ data: data instanceof ArrayBuffer ? data : new Uint8Array(bytes).buffer, ...(captions[index] ? { caption: captions[index] } : {}) })
      }
      const run = options.compose ?? ((request, composeOptions) => composeInVideoStudioWorker(request, composeOptions))
      const result = await run({ clips, options: { aspect: current.settings.aspect, resolution: current.settings.resolution, fit: current.settings.fit, frameRate: 24 } }, {
        signal: controller.signal,
        onProgress: (progress) => { if (alive()) setComposeState({ phase: 'composing', progress }) },
      })
      if (controller.signal.aborted || !alive()) return
      setComposeState({ phase: 'storing' })
      const stored = await bridge.storeVideoStudioExport(new Uint8Array(result.data))
      if (!alive()) return
      if (videoStudioComposeKey(projectRef.current) !== inputs) { setNotice('成片已经存进 AI 作品文件夹。拼的时候分镜改过了，这里没有换上，要用新的分镜就再拼一次。'); return }
      commit((latest) => ({ ...latest, exported: stored }))
      setNotice(result.audioCodec === null && current.shots.length ? '拼好了。这几段片段都没有声音，成片也没有声音。' : '拼好了，成片已经存进 AI 作品文件夹。')
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

  const openClip = async (assetId: string) => {
    try { await bridge.openAiVideo(assetId) } catch (reason) { setError(videoStudioErrorMessage(reason, '没打开这段视频，请稍后再试')) }
  }
  const saveClip = async (assetId: string): Promise<boolean> => {
    try { return (await bridge.saveAiVideo(assetId)).saved } catch (reason) { setError(videoStudioErrorMessage(reason, '没存下来，请换个位置再试')); return false }
  }
  // 页面上好几处说「存进 AI 作品文件夹」，这里直接打开它。用的是检查页那条：路径由主进程算、过了 I8 检查才打开，这里只说要哪一个。
  const openFolder = async () => {
    try {
      if (!(await bridge.openDiagnosticFolder('ai-output'))) setError(diagnosticFolderUnavailableMessage)
    } catch (reason) {
      setError(videoStudioErrorMessage(reason, diagnosticFolderUnavailableMessage))
    }
  }

  const busy = Boolean(planning) || project.shots.some(isVideoStudioShotBusy) || composeState.phase !== 'idle'
  // 写分镜、出片、拼片都靠这一页接着往下走：做着的时候窗口缩到托盘也不关界面（electron/renderer-release.ts）。
  useBackgroundWork('video-studio', busy)
  return {
    site, project, groups, preparations, catalogLoading, catalogError, planning: Boolean(planning), composeState, error, notice, storageWarning, busy,
    catalogs: buildVideoStudioCatalogs(groups, preparations),
    setError, setNotice, changeSettings, refreshModels, writePlan, stopPlan, generate, stopGenerating, compose, stopCompose, openClip, saveClip, openFolder,
    selectVideoModel: (model: string, group: string) => changeSettings({ videoModel: model, videoGroup: group, secondsPerShot: clampVideoStudioSeconds(projectRef.current.settings.secondsPerShot, model) }),
    selectTextModel: (model: string, group: string) => changeSettings({ textModel: model, textGroup: group }),
    editShot: (id: string, patch: Partial<Pick<VideoStudioShot, 'prompt' | 'caption'>>) => commit((current) => ({ ...updateVideoStudioShot(current, id, (shot) => ({ ...shot, ...patch })), ...(patch.caption === undefined ? {} : { exported: undefined }) })),
    moveShot: (id: string, offset: -1 | 1) => commit((current) => ({ ...moveVideoStudioShot(current, id, offset), exported: undefined })),
    removeShot: (id: string) => commit((current) => ({ ...removeVideoStudioShot(current, id), exported: undefined })),
    addShot: () => commit((current) => addVideoStudioShot(current)),
    reset: () => commit((current) => createVideoStudioProject({ ...current.settings, idea: '' })),
  }
}

export type VideoStudioController = ReturnType<typeof useVideoStudio>
