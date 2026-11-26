import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { AccountPriceList, AiChatAsset, AiChatImageInput, AiVideoClip, AiVideoGenerateInput, AiVideoProgressEvent, VideoStudioPlan, VideoStudioPlanInput, XingmangApi } from '../../../../electron/ipc-contract'
import { missingAiAssetMessages } from '../../../../electron/ai-asset-missing'
import { ToastProvider } from '../../ui'
import { AccountBalanceContext } from '../app/balance-context'
import { createAccountBalanceStore } from '../app/balance-store'
import '../../app.css'
import './browser-fixture'
import type { VideoStudioPriceBridge } from './prices'
import { videoStudioItemName, type VideoStudioLibraryBridge } from './library'
import { createVideoStudioProject, videoStudioDraftProgress } from './project'
import type { VideoStudioBridge } from './useVideoStudio'
import { useVideoStudioLibrary, useVideoStudioSession, type VideoStudioLibrary, type VideoStudioSession, type VideoStudioSource } from './useVideoStudioLibrary'
import { VideoStudioPage } from './VideoStudioPage'

// 视频工作台在真浏览器里走一遍：假的主进程桥（分镜、出片段、读片段、存成片、存视频草稿都在这里应答），
// 片段是 browser-fixture 现做的纯色视频，拼片走真的后台线程。不碰网络。
// 真应用里开哪一条视频由「创作」页定；这里一打开就接着最近动过的那一条，一条都没有就开一条空的。

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') ?? 'light'
document.documentElement.dataset.os = 'win'
document.body.style.margin = '0'
// 真应用里 shell.css 给 body 定了字色、底色和字体，夹具不引 shell.css（它把根节点钉成满屏高），这里照抄这三项。
document.body.style.color = 'var(--text)'
document.body.style.background = 'var(--win)'
document.body.style.font = 'var(--font-body)/var(--line-body) var(--font)'
const calls: Array<{ method: string, input?: unknown }> = []
const listeners = new Set<(event: AiVideoProgressEvent) => void>()
const plans = new Map<string, { resolve: (plan: VideoStudioPlan) => void, reject: (reason: Error) => void }>()
const clips = new Map<string, { input: AiVideoGenerateInput, resolve: (clip: AiVideoClip) => void, reject: (reason: Error) => void }>()
// 重开页面后回来接的请求。开发版 StrictMode 会把发起接回的 effect 跑两遍，主进程对同一个请求号回的是同一份，这里同样一起应答。
const resumes = new Map<string, Array<{ resolve: (clip: AiVideoClip | null) => void, reject: (reason: Error) => void }>>()
// 还没交给服务端的请求：停下时主进程回「不会照样出」。没列在这里的，停下时都当已经交出去、钱扣了。
const unsent = new Set<string>()
const library = new Map<string, ArrayBuffer>()
// 「AI 生成图片」发出去、还没回的画图请求。
const drawings = new Map<string, { input: AiChatImageInput, resolve: (assets: AiChatAsset[]) => void, reject: (reason: Error) => void }>()
let exported: ArrayBuffer | null = null
let assetCounter = 0
let folderOpens = true
// 下一次「用一张图开头」选到的图（编号）；空的就是客户在对话框里点了取消。
let nextPicks: string[] = []
// 下一次「加配乐」选到的歌；null 是在对话框里点了取消，unreadable 是主进程认不出这个文件。
let nextSong: { name: string, seconds: number, frequency: number } | 'unreadable' | null = null
// 地址带 ?models=held 时各分组先不回模型表，等测试叫 releaseModels：页面刚打开、模型还没读完就点生成的那一下（#1489 R28-4）。
const modelsHeld = query.get('models') === 'held'
const heldModels: Array<() => void> = []
// 地址带 ?balance=1234.5 时挂上真应用那份余额仓库，读回这个数（确认框里那句「当前余额」）；不带 = 外壳手上没有余额。
// 再带 balanceScope 时仓库停在那个账号上：换账号那一下，页面不能报上一个账号的余额。
const balanceQuery = query.get('balance')
const balanceStore = balanceQuery === null ? null : createAccountBalanceStore({
  read: async () => ({ quota: Number(balanceQuery) * 500_000, usedQuota: 0, quotaPerUnit: 500_000, quotaDisplayType: 'USD', usdExchangeRate: 7.3, displayAmount: Number(balanceQuery) }),
})
balanceStore?.setScope(query.get('balanceScope') ?? 'xm-account:7')
// 地址带 ?prices=1 时价格表回下面这几行（主进程已经乘好分组倍率，同个人中心价格表那条通道）：确认框里那句「预计约 $x」。
// 不带 = 一行都没有，确认框照旧只报余额。同一个模型在别的分组价不同，确认框得按这次用的分组报。
const priceList: AccountPriceList = query.get('prices') === '1'
  ? { rows: [
    { model: 'grok-imagine-video-1.5', group: '图片模型', kind: 'call', perCall: 0.8 },
    { model: 'grok-imagine-video-1.5', group: 'GPT', kind: 'call', perCall: 2 },
    { model: 'gpt-image-2', group: '图片模型', kind: 'call', perCall: 0.004 },
    { model: 'minimax-h3-base', group: '图片模型', kind: 'tiered' },
  ] }
  : { rows: [] }
const groups = [{ name: 'GPT', description: '聊天', ratio: 1, recommended: true }, { name: '图片模型', description: '图片和视频', ratio: 1 }]
const groupModels: Record<string, string[]> = { GPT: ['gpt-5.6-sol', 'claude-test'], 图片模型: ['gpt-image-2', 'gemini-3.1-flash-image', 'grok-imagine-video-1.5', 'minimax-h3-base'] }
function record(method: string, input?: unknown) { calls.push({ method, input }) }
function nextAssetId(): string {
  assetCounter += 1
  return String(assetCounter).padStart(43, 'v')
}
function clipFor(assetId: string, seconds = 1): AiVideoClip {
  return { assetId, thumbnailUrl: `xingmang-asset://thumb/v2/video/${assetId}`, width: 320, height: 240, durationSeconds: seconds }
}
// 做过的视频：真应用里主进程一条存一个文件（electron/video-studio-project-store.ts），这里记在 localStorage 里，重开页面还在。
const accountScope = 'xm-account:7'
function projectsKey(scope: string) { return `fixture:video-studio-projects:${scope}` }
function storedProjects(scope: string): { index: string | null, projects: Record<string, string> } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(projectsKey(scope)) ?? 'null')
    if (value && typeof value === 'object') {
      const { index, projects } = value as { index?: unknown, projects?: Record<string, string> }
      return { index: typeof index === 'string' ? index : null, projects: { ...projects } }
    }
  } catch {
    // 读不出就当一条都没有。
  }
  return { index: null, projects: {} }
}
// 存视频草稿的那条通道一共应答了几次、下一次要不要报错（这台电脑上存不下）。
let projectWrites = 0
let projectWritesFail = false
const bridge: VideoStudioBridge & VideoStudioPriceBridge & VideoStudioLibraryBridge = {
  readVideoStudioProjects: async (scope) => {
    const stored = storedProjects(scope)
    return { index: stored.index, projects: Object.entries(stored.projects).map(([key, content]) => ({ key, content })) }
  },
  // 当场写完再回：关页面那一下（pagehide）交出来的最后一笔，真应用里主进程接着写完，这里页面一走就没人写了。
  writeVideoStudioProjects: (input) => {
    projectWrites += 1
    if (projectWritesFail) return Promise.reject(new Error("Error invoking remote method 'video-studio:write-projects': Error: 视频草稿没有存下来"))
    const stored = storedProjects(input.scope)
    for (const file of input.put) stored.projects[file.key] = file.content
    for (const key of input.remove) delete stored.projects[key]
    if (input.index !== undefined) stored.index = input.index
    localStorage.setItem(projectsKey(input.scope), JSON.stringify(stored))
    return Promise.resolve()
  },
  reportRendererError: async (payload) => { record('report', payload) },
  getAccountPriceList: async () => { record('prices'); return priceList },
  listAiChatGroups: async () => { record('groups'); return groups },
  prepareAiChatGroup: async (group) => {
    record('prepare', group)
    if (modelsHeld) await new Promise<void>((resolve) => { heldModels.push(resolve) })
    return { group, models: groupModels[group] ?? [], keyCreated: false }
  },
  planVideoStudio: (input: VideoStudioPlanInput) => { record('plan', input); return new Promise((resolve, reject) => { plans.set(input.requestId, { resolve, reject }) }) },
  generateAiVideo: (input) => { record('generate', input); return new Promise((resolve, reject) => { clips.set(input.requestId, { input, resolve, reject }) }) },
  resumeAiVideo: (requestId) => { record('resume', requestId); return new Promise((resolve, reject) => { resumes.set(requestId, [...resumes.get(requestId) ?? [], { resolve, reject }]) }) },
  cancelAiVideo: async (requestId) => {
    record('cancel', requestId)
    const plan = plans.get(requestId)
    if (plan) { plans.delete(requestId); plan.reject(new Error("Error invoking remote method 'video-studio:plan': Error: 已停止生成分镜")); return { canceled: true, mayStillComplete: false } }
    const clip = clips.get(requestId)
    if (clip && unsent.has(requestId)) { clips.delete(requestId); clip.reject(new Error("Error invoking remote method 'video:generate': Error: 已取消视频请求")); return { canceled: true, mayStillComplete: false } }
    // 主进程的原话（electron/ai-video-service.ts）：交出去了、还没拿到任务号时是「提交结果不明确」，拿到了是「已停止等待」。
    if (clip) { clips.delete(requestId); clip.reject(new Error("Error invoking remote method 'video:generate': Error: 视频提交结果不明确，服务端可能已创建任务，请勿立即重复提交")); return { canceled: true, mayStillComplete: true } }
    return { canceled: false, mayStillComplete: false }
  },
  onAiVideoProgress: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  readAiVideoClip: async (assetId) => {
    record('read', assetId)
    const data = library.get(assetId)
    if (!data) throw new Error(`Error invoking remote method 'video:read-clip': Error: ${missingAiAssetMessages.video}`)
    return new Uint8Array(data.slice(0))
  },
  storeVideoStudioExport: async (bytes) => {
    record('store', bytes.byteLength)
    exported = bytes.slice().buffer
    const assetId = nextAssetId()
    library.set(assetId, exported)
    return { ...clipFor(assetId), width: 720, height: 1280, durationSeconds: 3 }
  },
  openAiVideo: async (assetId) => { record('open', assetId) },
  saveAiVideo: async (assetId, suggestedName) => { record('save', suggestedName === undefined ? assetId : { assetId, suggestedName }); return { saved: true } },
  openDiagnosticFolder: async (target) => { record('folder', target); return folderOpens },
  pickAiChatImages: async (remaining) => {
    record('pick-images', remaining)
    const picked = nextPicks.splice(0)
    return picked.map((assetId) => ({ assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' as const, fileName: `${assetId}.png` }))
  },
  generateAiImage: (input) => { record('image', input); return new Promise((resolve, reject) => { drawings.set(input.requestId, { input, resolve, reject }) }) },
  cancelAiChat: async (requestId) => {
    record('cancel-image', requestId)
    const drawing = drawings.get(requestId)
    if (!drawing) return { canceled: false, mayStillComplete: false }
    drawings.delete(requestId)
    drawing.reject(new Error("Error invoking remote method 'chat:generate-image': Error: 已取消"))
    return { canceled: true, mayStillComplete: true }
  },
  pickVideoStudioMusic: async () => {
    record('pick-music')
    const song = nextSong
    nextSong = null
    if (song === 'unreadable') throw new Error("Error invoking remote method 'video-studio:pick-music': Error: 该歌曲无法读取，请更换配乐后重试（支持 MP3、M4A、WAV、OGG）")
    if (!song) return null
    const assetId = nextAssetId()
    library.set(assetId, await window.videoStudioHarness!.makeSong(song.seconds, song.frequency))
    return { assetId, name: song.name, durationSeconds: song.seconds }
  },
  readVideoStudioMusic: async (assetId) => {
    record('read-music', assetId)
    const data = library.get(assetId)
    if (!data) throw new Error(`Error invoking remote method 'video-studio:read-music': Error: ${missingAiAssetMessages.audio}`)
    return new Uint8Array(data.slice(0))
  },
}

async function finishResume(requestId: string, color: string) {
  const waiting = resumes.get(requestId)
  if (!waiting) throw new Error(`no resume request ${requestId}`)
  const data = await window.videoStudioHarness!.makeClip({ width: 320, height: 240, frameRate: 24, seconds: 1, color })
  const assetId = nextAssetId()
  library.set(assetId, data)
  resumes.delete(requestId)
  for (const { resolve } of waiting) resolve(clipFor(assetId))
  return assetId
}

async function finishClip(requestId: string, color: string, sound = false, seconds = 1) {
  const clip = clips.get(requestId)
  if (!clip) throw new Error(`no clip request ${requestId}`)
  const data = await window.videoStudioHarness!.makeClip({ width: 320, height: 240, frameRate: 24, seconds, color, ...(sound ? { tone: { frequency: 440, channels: 2 } } : {}) })
  const assetId = nextAssetId()
  library.set(assetId, data)
  clips.delete(requestId)
  clip.resolve(clipFor(assetId, seconds))
  return assetId
}

declare global {
  interface Window {
    videoStudioPage?: {
      calls: typeof calls
      pendingClips(): Array<{ requestId: string, prompt: string }>
      pendingResumes(): string[]
      finishResume(requestId: string, color: string): Promise<string>
      dropResume(requestId: string): void
      failResume(requestId: string, message: string): void
      releaseModels(): void
      finishPlan(plan: VideoStudioPlan): void
      failPlan(message: string): void
      finishClip(requestId: string, color: string, sound?: boolean, seconds?: number): Promise<string>
      failClip(requestId: string, message: string): void
      unsent(requestId: string): void
      progress(event: AiVideoProgressEvent): void
      exported(): ArrayBuffer | null
      forget(assetId: string): void
      folderOpens(value: boolean): void
      pickImages(assetIds: string[]): void
      pickSong(song: { name: string, seconds: number, frequency: number } | 'unreadable' | null): void
      pendingDrawings(): Array<{ requestId: string, prompt: string, size?: string, model: string }>
      finishDrawing(requestId: string, assetId: string): void
      failDrawing(requestId: string, message: string): void
      balance(): number | null
      /** 左边那一列里会列出来的视频，新的在前；open 是现在开着的那一条。 */
      films(): Array<{ id: string, name: string, progress: string, open: boolean }>
      /** 新开一条空的并打开；开着的那一条手上有事是 busy。 */
      newFilm(): string
      openFilm(id: string): string
      removeFilm(id: string): boolean
      renameFilm(id: string, name: string): void
      /** 手上攒着没存的马上存，存完才回。 */
      flush(): Promise<void>
      projectWrites(): number
      failProjectWrites(value: boolean): void
    }
  }
}

window.videoStudioPage = {
  calls,
  pendingClips: () => [...clips.entries()].map(([requestId, clip]) => ({ requestId, prompt: clip.input.prompt })),
  pendingResumes: () => [...resumes.keys()],
  finishResume,
  dropResume: (requestId) => { const waiting = resumes.get(requestId) ?? []; resumes.delete(requestId); for (const { resolve } of waiting) resolve(null) },
  failResume: (requestId, message) => {
    const waiting = resumes.get(requestId) ?? []
    resumes.delete(requestId)
    for (const { reject } of waiting) reject(new Error(`Error invoking remote method 'video:resume': Error: ${message}`))
  },
  releaseModels: () => { for (const release of heldModels.splice(0)) release() },
  finishPlan: (plan) => { for (const [id, entry] of plans) { plans.delete(id); entry.resolve(plan) } },
  failPlan: (message) => { for (const [id, entry] of plans) { plans.delete(id); entry.reject(new Error(`Error invoking remote method 'video-studio:plan': Error: ${message}`)) } },
  finishClip,
  failClip: (requestId, message) => { const clip = clips.get(requestId); clips.delete(requestId); clip?.reject(new Error(`Error invoking remote method 'video:generate': Error: ${message}`)) },
  unsent: (requestId) => { unsent.add(requestId) },
  progress: (event) => { for (const listener of listeners) listener(event) },
  exported: () => exported,
  forget: (assetId) => { library.delete(assetId) },
  folderOpens: (value) => { folderOpens = value },
  pickImages: (assetIds) => { nextPicks = [...assetIds] },
  pickSong: (song) => { nextSong = song },
  pendingDrawings: () => [...drawings.entries()].map(([requestId, { input }]) => ({ requestId, prompt: input.prompt, model: input.model, ...(input.size ? { size: input.size } : {}) })),
  finishDrawing: (requestId, assetId) => {
    const drawing = drawings.get(requestId)
    drawings.delete(requestId)
    drawing?.resolve([{ assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: `${assetId}.png` }])
  },
  failDrawing: (requestId, message) => {
    const drawing = drawings.get(requestId)
    drawings.delete(requestId)
    drawing?.reject(new Error(`Error invoking remote method 'chat:generate-image': Error: ${message}`))
  },
  balance: () => balanceStore?.getSnapshot().balance?.displayAmount ?? null,
  films: () => host.library?.items.map((item) => ({ id: item.id, name: videoStudioItemName(item), progress: videoStudioDraftProgress(item.project), open: item.id === host.session?.openId })) ?? [],
  newFilm: () => { const started = host.session?.start(); return typeof started === 'object' ? started.id : started ?? 'loading' },
  openFilm: (id) => host.session?.open(id) ?? 'loading',
  removeFilm: (id) => host.session?.remove(id) ?? false,
  renameFilm: (id, name) => { host.library?.rename(id, name) },
  flush: async () => { await host.library?.flush() },
  projectWrites: () => projectWrites,
  failProjectWrites: (value) => { projectWritesFail = value },
}

// 页面最近一次渲染拿到的那两样，给上面那几个测试用的入口用。
const host: { library?: VideoStudioLibrary, session?: VideoStudioSession } = {}
const emptySource: VideoStudioSource = { read: () => createVideoStudioProject(), write: () => undefined, warning: '' }

const access = query.get('access') === 'guest' ? 'guest' : query.get('access') === 'unsupported' ? 'unsupported' : 'ready'

function Studio() {
  const library = useVideoStudioLibrary(bridge, accountScope)
  const session = useVideoStudioSession(library)
  host.library = library
  host.session = session
  const { openId } = session
  useEffect(() => {
    if (library.status !== 'ready' || openId) return
    const latest = library.items[0]
    if (latest) session.open(latest.id); else session.start()
  }, [library.status, openId])
  const common = { bridge: bridge as XingmangApi, accountScope, site: 'solov' as const, onLogin: () => record('login'), onOpenAccount: (tab: 'recharge' | 'keys') => record('account', tab) }
  if (access !== 'ready') return <VideoStudioPage {...common} access={access} source={emptySource} />
  if (!openId) return null
  return <VideoStudioPage key={openId} {...common} access="ready" source={library.source(openId)} onBusyChange={session.setBusy} />
}

createRoot(document.getElementById('root')!).render(<StrictMode><AccountBalanceContext.Provider value={balanceStore}><ToastProvider><div style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
  <Studio />
</div></ToastProvider></AccountBalanceContext.Provider></StrictMode>)
