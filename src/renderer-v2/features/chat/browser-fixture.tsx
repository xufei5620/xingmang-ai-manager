import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AiChatAsset, AiChatGroupSummary, AiChatHistoryFlushRequest, AiChatHistorySnapshot, AiChatHistoryWrite, AiChatPreparedGroup, AiChatStreamEvent, AiChatTextFile, AiVideoClip, AiVideoGenerateInput, AiVideoProgressEvent, XingmangApi } from '../../../../electron/ipc-contract'
import { missingAiAssetMessages } from '../../../../electron/ai-asset-missing'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import type { ChatBridge, ChatVideoBridge } from './api'
import { writeSharedImageSettings, type SharedImageSettings } from './image-settings'
import { answerHistoryFlushRequests } from './storage'
import { ChatPage, type ChatPageCreate, type ChatPageVideo } from './ChatPage'
import { videoStudioQuoteText } from '../video-studio/prices'
import { ToastProvider } from '../../ui'
import { OnlineStatusContext, useBrowserOnline } from '../shell/useOnlineStatus'

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') ?? 'light'
document.documentElement.dataset.os = query.get('os') ?? 'win'
document.body.style.margin = '0'
document.body.style.height = '100vh'
document.getElementById('root')!.style.height = '100%'
const calls: Array<{ method: string; input?: unknown }> = []
const listeners = new Set<(event: AiChatStreamEvent) => void>()
const images = new Map<string, { resolve: (assets: AiChatAsset[]) => void; reject: (reason: Error) => void }>()
const preparations: Array<{ group: string; resolve: (prepared: AiChatPreparedGroup) => void }> = []
let userId = 7
let failedGroupList = query.has('groupFail')
let groupOverride: AiChatGroupSummary[] | undefined = query.has('emptyGroups') ? [] : undefined
// 读某个分组的模型失败（all = 每个分组都失败）；harness 能放开，点「刷新模型」再读就好了。
let failingPreparation = query.get('prepareFail')
let groupGate: Promise<void> | undefined
let releaseGroupGate: (() => void) | undefined
// 图片文件在外面被删了（D37）：预览读不出来，复制、另存时主进程那句原话经 IPC 带着通道名交过来。
const assetGone = query.has('assetGone')
function assetGoneError(channel: string): Error { return new Error(`Error invoking remote method '${channel}': Error: ${missingAiAssetMessages.image}`) }
const imageAsset: AiChatAsset = { assetId: 'a'.repeat(43), localUrl: assetGone ? '/assets/brand/v3/fixture-gone.png' : '/assets/brand/v3/symbol-standard.svg', mimeType: 'image/png', fileName: 'fixture.png', width: 288, height: 256 }
function record(method: string, input?: unknown) { calls.push({ method, input }) }
function noRecheck() {}
// ?video：对话页带上「创作」页给的「生成视频」那一档（融合第 2 步）。视频那几条通道接在下面几张表上，由测试放行。
const videoFeature = query.has('video')
const videoJobs = new Map<string, { input: AiVideoGenerateInput; resolve: (clip: AiVideoClip) => void; reject: (reason: Error) => void }>()
const videoResumes = new Map<string, Array<{ resolve: (clip: AiVideoClip | null) => void; reject: (reason: Error) => void }>>()
const videoListeners = new Set<(event: AiVideoProgressEvent) => void>()
// 还没交给服务端的那几单：这时停下不扣费（主进程回 mayStillComplete: false）。别的都当已经交出去了。
const unsentVideos = new Set<string>()
// 片段的编号从请求号来，同一单出的总是同一段；缩略图地址是主进程给的那种（存盘再读回来只认这种），?videoPortrait 出竖屏的一段（截图用）。
function videoClipFor(requestId: string): AiVideoClip {
  const assetId = `${requestId.replace(/[^A-Za-z0-9]/g, '')}${'v'.repeat(43)}`.slice(0, 43)
  return { assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'video'), width: query.has('videoPortrait') ? 720 : 1280, height: query.has('videoPortrait') ? 1280 : 720, durationSeconds: 5 }
}
function videoError(channel: string, message: string): Error { return new Error(`Error invoking remote method '${channel}': Error: ${message}`) }
const videoBridge: ChatVideoBridge = {
  generateAiVideo: (input) => { record('video', input); return new Promise((resolve, reject) => { videoJobs.set(input.requestId, { input, resolve, reject }) }) },
  resumeAiVideo: (requestId) => { record('video-resume', requestId); return new Promise((resolve, reject) => { videoResumes.set(requestId, [...videoResumes.get(requestId) ?? [], { resolve, reject }]) }) },
  cancelAiVideo: async (requestId) => {
    record('video-cancel', requestId)
    const job = videoJobs.get(requestId)
    if (!job) return { canceled: false, mayStillComplete: false }
    videoJobs.delete(requestId)
    // 主进程的原话（electron/ai-video-service.ts）：还没交出去是「已取消视频请求」，交出去了是「已停止等待…」。
    const sent = !unsentVideos.has(requestId)
    job.reject(videoError('video:generate', sent ? '已停止等待；服务端可能仍在生成视频，下次启动会继续查询' : '已取消视频请求'))
    return { canceled: true, mayStillComplete: sent }
  },
  onAiVideoProgress: (listener) => { videoListeners.add(listener); return () => { videoListeners.delete(listener) } },
  openAiVideo: async (assetId) => { record('video-open', assetId) },
  saveAiVideo: async (assetId, suggestedName) => { record('video-save', { assetId, suggestedName }); if (query.has('videoSaveFail')) throw videoError('video:save', missingAiAssetMessages.video); return { saved: !query.has('saveCancel') } },
}
// 「创作」页给对话页的那一份：价目、余额、做过的视频。真应用里在 CreatePage，这里是定死的假数据。
const videoPrices: Record<string, number> = { 'grok-imagine-video-1.5': 0.25 }
const videoFilms = [{ id: 'film-cat', title: '橘猫回家', detail: '4 个镜头' }, { id: 'film-full', title: '新品口红 15 秒', detail: '12 个镜头，已满', full: true }]
const createVideo: ChatPageVideo = {
  access: query.get('videoAccess') === 'unsupported' ? 'unsupported' : query.get('videoAccess') === 'suspended' ? 'suspended' : 'ready',
  quote: (model) => videoStudioQuoteText(videoPrices[model] ?? null, 1, true),
  refreshPrices: () => record('video-prices'),
  balance: query.has('noBalance') ? null : '$12.40',
  films: videoFilms,
  addClip: (filmId, source, made) => {
    record('video-compose', { filmId, source, made })
    if (query.has('composeFail')) return { error: '「橘猫回家」正在进行其他操作（编写分镜、生成或合成），请待其完成后再添加。' }
    return { id: filmId ?? 'film-new', title: videoFilms.find((film) => film.id === filmId)?.title ?? source.prompt }
  },
  openFilm: (id) => record('video-open-film', id),
}
const create: ChatPageCreate | undefined = videoFeature
  ? { items: [], kinds: ['video', 'canvas'], selected: null, lockedVideoId: null, actions: { open: noRecheck, leave: noRecheck, renameVideo: noRecheck, removeVideo: noRecheck, openCanvas: noRecheck }, pane: null, video: createVideo }
  : undefined
// Stands in for the main-process history files. IndexedDB survives page.reload()
// like the files survive a restart, and has room for records far past the
// localStorage quota this fixture used to depend on.
let failHistoryWrites = false
// 主进程读记录失败（比如被别的程序占着）；之后能读了，「重新读取」才读得出来。
let failHistoryReads = query.has('historyReadFail')
// 导出这段对话存不进去时主进程交过来的原话（经 IPC 带着通道名，D16）：没权限、盘满了、别的。
const exportFailures: Record<string, string> = {
  denied: "Error invoking remote method 'chat-history:export-text': Error: EPERM: operation not permitted, open 'C:\\Users\\fixture\\Desktop\\.今天聊的.txt.tmp'",
  full: "Error invoking remote method 'chat-history:export-text': Error: ENOSPC: no space left on device, write",
  other: "Error invoking remote method 'chat-history:export-text': Error: 聊天对话导出文件写入被系统占用，请稍后重试",
}
const exportFailure = exportFailures[query.get('exportFail') ?? '']
// 读记录一直不回（比如磁盘正忙）：第一次进聊天页先看到「正在加载页面」，放行以后才出现输入框。
let openHistoryReads: (() => void) | undefined
const heldHistoryReads = query.has('historyReadHold') ? new Promise<void>((resolve) => { openHistoryReads = resolve }) : undefined
function historyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-history-fixture', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('files') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
// aside 是主进程挪进备份文件夹的那几个读不出来的对话文件（electron/ai-chat-history-store.ts 的 setAside）。
interface FixtureHistory extends AiChatHistorySnapshot { aside?: AiChatHistorySnapshot['conversations'] }
async function historyFiles(scope: string): Promise<FixtureHistory> {
  const database = await historyDatabase()
  return new Promise((resolve, reject) => {
    const request = database.transaction('files').objectStore('files').get(scope)
    request.onsuccess = () => resolve(request.result ?? { index: null, conversations: [] })
    request.onerror = () => reject(request.error)
  })
}
async function putHistoryFiles(scope: string, history: FixtureHistory): Promise<void> {
  const database = await historyDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('files', 'readwrite')
    transaction.objectStore('files').put(history, scope)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}
async function writeHistoryFiles(input: AiChatHistoryWrite): Promise<void> {
  if (failHistoryWrites) throw new Error('disk full')
  const current = await historyFiles(input.scope)
  const files = new Map(current.conversations.map((file) => [file.key, file.content]))
  for (const file of input.put) files.set(file.key, file.content)
  const conversations = input.keys.map((key) => ({ key, content: files.get(key) ?? '' }))
  const aside = [...(current.aside ?? []), ...(input.setAside ?? []).flatMap((key) => files.has(key) ? [{ key, content: files.get(key)! }] : [])]
  await putHistoryFiles(input.scope, { index: input.index, conversations, ...(aside.length ? { aside } : {}) })
}
// 弄坏第 position 段对话的文件：写成半截，或者整个删掉（杀毒软件隔离、客户自己清掉一部分）。
async function breakConversation(position: number, how: 'truncate' | 'remove', scope = 'xm-account:7'): Promise<string> {
  const current = await historyFiles(scope)
  const key: string = JSON.parse(current.index ?? '{}').conversations[position].key
  const conversations = how === 'remove'
    ? current.conversations.filter((file) => file.key !== key)
    : current.conversations.map((file) => file.key === key ? { key, content: file.content.slice(0, Math.floor(file.content.length / 2)) } : file)
  await putHistoryFiles(scope, { ...current, conversations })
  return key
}
async function asideFiles(scope = 'xm-account:7') { return (await historyFiles(scope)).aside ?? [] }
async function savedWorkspace(scope = 'xm-account:7') {
  const snapshot = await historyFiles(scope)
  if (snapshot.index === null) return null
  const index = JSON.parse(snapshot.index)
  // 弄坏的那段（breakConversation）在挪走之前还在索引里，读成 null。
  const files = new Map(snapshot.conversations.map((file) => [file.key, file.content]))
  return { ...index, conversations: index.conversations.map((entry: { key: string }) => { try { return JSON.parse(files.get(entry.key) ?? '').conversation } catch { return null } }) }
}
// 选文字文件框每次交回什么由测试排好（chatHarness.queueTextFiles），排空了就当客户点了取消。
const textFilePicks: Array<AiChatTextFile[] | Error> = []
const bridge: ChatBridge = {
  listAiChatGroups: async () => {
    record('groups')
    if (groupGate) await groupGate
    if (failedGroupList) throw new Error('network error')
    if (groupOverride) return groupOverride
    return query.has('preferredGroup')
      ? [{ name: 'default', description: '用户分组', ratio: 1 }, { name: query.has('sub2api') ? 'Codex_pro' : 'GPT', description: 'gpt-image-1 / 1.5 / 2（官方按 token 计费）', ratio: 1 }]
      : [{ name: 'group-a', description: '文本与图片以及一段不应进入选项标题的超长能力说明', ratio: 1 }, { name: 'group-b', description: '另一分组', ratio: 1 }]
  },
  prepareAiChatGroup: async (group) => { record('prepare', group); if (failingPreparation === group || failingPreparation === 'all') throw new Error('network error'); if (query.has('deferPreparation') && group === 'group-a') return new Promise<AiChatPreparedGroup>((resolve) => { preparations.push({ group, resolve }) }); const models = query.has('preferredGroup') && group === (query.has('sub2api') ? 'Codex_pro' : 'GPT') ? ['other-model', 'gpt-5.6-sol'] : group === 'group-a' ? ['gpt-test', 'gpt-image-2', 'gpt-image-1.5', 'gemini-3.1-flash-image', 'claude-test', ...(videoFeature ? ['grok-imagine-video-1.5', 'minimax-h3-base'] : [])] : ['other-model', 'grok-imagine-image']; return { group, models, keyCreated: false } },
  startAiChat: async (input) => { record('start', input); return { accepted: true, requestId: input.requestId } },
  generateAiImage: async (input) => { record('image', input); return new Promise<AiChatAsset[]>((resolve, reject) => { images.set(input.requestId, { resolve, reject }) }) },
  cancelAiChat: async (requestId) => { record('cancel', requestId); if (query.has('cancelReject')) { images.get(requestId)?.reject(new Error('request canceled')); await Promise.resolve() } return { canceled: true, mayStillComplete: images.has(requestId) } },
  onAiChatStream: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  copyAiChatAsset: async (assetId) => { record('copy-asset', assetId); if (assetGone) throw assetGoneError('chat:copy-asset') },
  saveAiChatAsset: async (assetId) => { record('save-asset', assetId); if (assetGone) throw assetGoneError('chat:save-asset'); return { saved: !query.has('saveCancel') } },
  showAiChatAssetMenu: async (assetId) => { record('menu-asset', assetId) },
  pickAiChatImages: async (remaining) => { record('pick-images', remaining); return query.has('pickCancel') ? [] : [{ ...imageAsset, assetId: `p${String(calls.length).padStart(42, '0')}`, fileName: 'picked.png' }] },
  pickAiChatTextFiles: async (remainingFiles, remainingChars) => { record('pick-text-files', { remainingFiles, remainingChars }); const next = textFilePicks.shift(); if (next instanceof Error) throw next; return next ?? [] },
  pasteAiChatImage: async (remaining) => { record('paste-image', remaining); return query.has('emptyClipboard') ? [] : [{ ...imageAsset, assetId: `v${String(calls.length).padStart(42, '0')}`, fileName: 'pasted.png' }] },
  readAiChatHistory: async (scope) => { record('read-history', scope); if (heldHistoryReads) await heldHistoryReads; if (failHistoryReads) throw new Error('reparse point'); const { index, conversations } = await historyFiles(scope); return { index, conversations } },
  writeAiChatHistory: (input) => writeHistoryFiles(input),
  exportAiChatConversation: async (input) => { record('export-text', input); if (exportFailure) throw new Error(exportFailure); return query.has('exportCancel') ? null : { outputPath: `C:\\Users\\fixture\\Downloads\\${input.title}.txt` } },
  getAccountSession: async () => ({ authenticated: true, account: { userId, username: `fixture-${userId}`, quota: 10, usedQuota: 0, group: 'default', role: 1 } }),
  reportRendererError: async (payload) => { record('log', payload) },
}
// 退出前主进程那一问（electron/chat-history-flush.ts）：App 一挂上就接着，这里在模块里接，聊天页换账号、卸下都还在。
const flushListeners = new Set<(request: AiChatHistoryFlushRequest) => void>()
const flushAnswers = new Map<string, () => void>()
answerHistoryFlushRequests({
  onAiChatHistoryFlushRequested: (listener) => { flushListeners.add(listener); return () => { flushListeners.delete(listener) } },
  confirmAiChatHistoryFlushed: async (requestId) => { record('flushed', requestId); flushAnswers.get(requestId)?.(); flushAnswers.delete(requestId) },
})
function askBeforeQuit(requestId: string): Promise<void> {
  return new Promise((resolve) => {
    flushAnswers.set(requestId, resolve)
    for (const listener of flushListeners) listener({ requestId })
  })
}
declare global {
  interface Window { chatHarness: { shareImageSettings: (settings: SharedImageSettings) => void; calls: typeof calls; askBeforeQuit: typeof askBeforeQuit; emit: (event: AiChatStreamEvent) => void; completeImage: (requestId: string) => void; failImage: (requestId: string) => void; finishPreparation: () => void; switchScope: (id: number) => void; resetGroupFailure: () => void; setActive: (active: boolean) => void; setGroups: (names: string[]) => void; failGroupList: () => void; failPreparation: (group: string | null) => void; deferGroupList: () => void; releaseGroupList: () => void; savedWorkspace: typeof savedWorkspace; breakConversation: typeof breakConversation; asideFiles: typeof asideFiles; failHistoryWrites: (fail: boolean) => void; failHistoryReads: (fail: boolean) => void; releaseHistoryReads: () => void; openParameters: () => void; queueTextFiles: (files: AiChatTextFile[] | string) => void; videoProgress: (event: AiVideoProgressEvent) => void; completeVideo: (requestId: string) => void; failVideo: (requestId: string, message: string) => void; holdVideoUnsent: (requestId: string) => void; finishVideoResume: (requestId: string, outcome: string) => void; waitingVideos: () => { jobs: string[]; resumes: string[] } } }
}
function Fixture() {
  const [scope, setScope] = useState(query.has('sub2api') ? 'api-account:7' : 'xm-account:7')
  const [active, setActive] = useState(true)
  // 顶部搜索的「聊天参数设置」：App 把这个标记交给聊天页，聊天页打开参数对话框后放下。
  const [openParameters, setOpenParameters] = useState(query.has('openParameters'))
  // context.setOffline() 翻的是 navigator.onLine；App 里同一个信号交给 OnlineStatusContext。
  const online = useBrowserOnline()
  window.chatHarness = { calls, askBeforeQuit, emit: (event) => { for (const listener of listeners) listener(event) }, completeImage: (id) => images.get(id)?.resolve([imageAsset]), failImage: (id) => images.get(id)?.reject(new Error('network error')), finishPreparation: () => { for (const item of preparations) item.resolve({ group: item.group, models: ['gpt-test', 'gpt-image-2'], keyCreated: false }) }, switchScope: (id) => { userId = id; setScope(`xm-account:${id}`) }, resetGroupFailure: () => { failedGroupList = false }, setActive,
    setGroups: (names) => { groupOverride = names.map((name) => ({ name, description: name, ratio: 1 })) },
    failGroupList: () => { failedGroupList = true },
    failPreparation: (group) => { failingPreparation = group },
    deferGroupList: () => { groupGate = new Promise<void>((resolve) => { releaseGroupGate = resolve }) },
    releaseGroupList: () => { releaseGroupGate?.(); groupGate = undefined; releaseGroupGate = undefined },
    savedWorkspace,
    breakConversation,
    asideFiles,
    failHistoryWrites: (fail) => { failHistoryWrites = fail },
    failHistoryReads: (fail) => { failHistoryReads = fail },
    releaseHistoryReads: () => openHistoryReads?.(),
    openParameters: () => setOpenParameters(true),
    queueTextFiles: (files) => { textFilePicks.push(typeof files === 'string' ? new Error(files) : files) },
    videoProgress: (event) => { for (const listener of videoListeners) listener(event) },
    completeVideo: (id) => { videoJobs.get(id)?.resolve(videoClipFor(id)); videoJobs.delete(id) },
    failVideo: (id, message) => { videoJobs.get(id)?.reject(videoError('video:generate', message)); videoJobs.delete(id) },
    holdVideoUnsent: (id) => { unsentVideos.add(id) },
    // 接回的那一问怎么答：clip 是这一段已经出好了，missing 是主进程没有这一单，别的当成主进程报的一句错。
    finishVideoResume: (id, outcome) => {
      for (const waiting of videoResumes.get(id) ?? []) { if (outcome === 'clip') waiting.resolve(videoClipFor(id)); else if (outcome === 'missing') waiting.resolve(null); else waiting.reject(videoError('video:resume', outcome)) }
      videoResumes.delete(id)
    },
    waitingVideos: () => ({ jobs: [...videoJobs.keys()], resumes: [...videoResumes.keys()] }),
    // 视频工作台的出图框点了「生成图片」时做的那一下：往两边共用的那一份里记（融合第 4 步）。
    shareImageSettings: (settings) => writeSharedImageSettings(scope, settings),
  }
  return <ToastProvider testId="chat-toasts"><OnlineStatusContext.Provider value={{ offline: !online, checking: false, recheck: noRecheck }}><ChatPage bridge={(videoFeature ? { ...bridge, ...videoBridge } : bridge) as XingmangApi} create={create} accountScope={scope} active={active} openParameters={openParameters} onParametersOpened={() => setOpenParameters(false)} /></OnlineStatusContext.Provider></ToastProvider>
}
createRoot(document.getElementById('root')!).render(query.has('strict') ? <StrictMode><Fixture /></StrictMode> : <Fixture />)
