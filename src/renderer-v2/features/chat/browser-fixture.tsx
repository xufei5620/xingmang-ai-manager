import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AiChatAsset, AiChatGroupSummary, AiChatHistorySnapshot, AiChatHistoryWrite, AiChatPreparedGroup, AiChatStreamEvent, XingmangApi } from '../../../../electron/ipc-contract'
import type { ChatBridge } from './api'
import { ChatPage } from './ChatPage'
import { ToastProvider } from '../../ui'

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') ?? 'light'
document.documentElement.dataset.skin = query.get('skin') ?? (document.documentElement.dataset.theme === 'dark' ? 'obsidian' : 'dawn')
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
let groupGate: Promise<void> | undefined
let releaseGroupGate: (() => void) | undefined
const imageAsset: AiChatAsset = { assetId: 'a'.repeat(43), localUrl: '/assets/brand/v3/symbol-standard.svg', mimeType: 'image/png', fileName: 'fixture.png', width: 288, height: 256 }
function record(method: string, input?: unknown) { calls.push({ method, input }) }
// Stands in for the main-process history files. IndexedDB survives page.reload()
// like the files survive a restart, and has room for records far past the
// localStorage quota this fixture used to depend on.
let failHistoryWrites = false
function historyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-history-fixture', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('files') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function historyFiles(scope: string): Promise<AiChatHistorySnapshot> {
  const database = await historyDatabase()
  return new Promise((resolve, reject) => {
    const request = database.transaction('files').objectStore('files').get(scope)
    request.onsuccess = () => resolve(request.result ?? { index: null, conversations: [] })
    request.onerror = () => reject(request.error)
  })
}
async function writeHistoryFiles(input: AiChatHistoryWrite): Promise<void> {
  if (failHistoryWrites) throw new Error('disk full')
  const current = await historyFiles(input.scope)
  const files = new Map(current.conversations.map((file) => [file.key, file.content]))
  for (const file of input.put) files.set(file.key, file.content)
  const conversations = input.keys.map((key) => ({ key, content: files.get(key) ?? '' }))
  const database = await historyDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('files', 'readwrite')
    transaction.objectStore('files').put({ index: input.index, conversations }, input.scope)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}
async function savedWorkspace(scope = 'xm-account:7') {
  const snapshot = await historyFiles(scope)
  if (snapshot.index === null) return null
  const index = JSON.parse(snapshot.index)
  const files = new Map(snapshot.conversations.map((file) => [file.key, JSON.parse(file.content).conversation]))
  return { ...index, conversations: index.conversations.map((entry: { key: string }) => files.get(entry.key)) }
}
const bridge: ChatBridge = {
  listAiChatGroups: async () => {
    record('groups')
    if (groupGate) await groupGate
    if (failedGroupList) throw new Error('network error')
    if (groupOverride) return groupOverride
    return query.has('preferredGroup')
      ? [{ name: 'default', description: '用户分组', ratio: 1 }, { name: query.has('sub2api') ? 'Codex_pro' : 'GPT-中转/订阅', description: 'gpt-image-1 / 1.5 / 2（官方按 token 计费）', ratio: 1 }]
      : [{ name: 'group-a', description: '文本与图片以及一段不应进入选项标题的超长能力说明', ratio: 1 }, { name: 'group-b', description: '另一分组', ratio: 1 }]
  },
  prepareAiChatGroup: async (group) => { record('prepare', group); if (query.has('deferPreparation') && group === 'group-a') return new Promise<AiChatPreparedGroup>((resolve) => { preparations.push({ group, resolve }) }); const models = query.has('preferredGroup') && group === (query.has('sub2api') ? 'Codex_pro' : 'GPT-中转/订阅') ? ['other-model', 'gpt-5.6-sol'] : group === 'group-a' ? ['gpt-test', 'gpt-image-2', 'gpt-image-1.5', 'gemini-3.1-flash-image'] : ['other-model', 'grok-imagine-image']; return { group, models, keyCreated: false } },
  startAiChat: async (input) => { record('start', input); return { accepted: true, requestId: input.requestId } },
  generateAiImage: async (input) => { record('image', input); return new Promise<AiChatAsset[]>((resolve, reject) => { images.set(input.requestId, { resolve, reject }) }) },
  cancelAiChat: async (requestId) => { record('cancel', requestId); if (query.has('cancelReject')) { images.get(requestId)?.reject(new Error('request canceled')); await Promise.resolve() } return { canceled: true, mayStillComplete: images.has(requestId) } },
  onAiChatStream: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  copyAiChatAsset: async (assetId) => { record('copy-asset', assetId) },
  saveAiChatAsset: async (assetId) => { record('save-asset', assetId); return { saved: !query.has('saveCancel') } },
  showAiChatAssetMenu: async (assetId) => { record('menu-asset', assetId) },
  readAiChatHistory: (scope) => historyFiles(scope),
  writeAiChatHistory: (input) => writeHistoryFiles(input),
  exportAiChatConversation: async (input) => { record('export-text', input); return query.has('exportCancel') ? null : { outputPath: `C:\\Users\\fixture\\Desktop\\${input.title}.txt` } },
  getAccountSession: async () => ({ authenticated: true, account: { userId, username: `fixture-${userId}`, quota: 10, usedQuota: 0, group: 'default', role: 1 } }),
}
declare global {
  interface Window { chatHarness: { calls: typeof calls; emit: (event: AiChatStreamEvent) => void; completeImage: (requestId: string) => void; failImage: (requestId: string) => void; finishPreparation: () => void; switchScope: (id: number) => void; resetGroupFailure: () => void; setActive: (active: boolean) => void; setGroups: (names: string[]) => void; failGroupList: () => void; deferGroupList: () => void; releaseGroupList: () => void; savedWorkspace: typeof savedWorkspace; failHistoryWrites: (fail: boolean) => void } }
}
function Fixture() {
  const [scope, setScope] = useState(query.has('sub2api') ? 'api-account:7' : 'xm-account:7')
  const [active, setActive] = useState(true)
  window.chatHarness = { calls, emit: (event) => { for (const listener of listeners) listener(event) }, completeImage: (id) => images.get(id)?.resolve([imageAsset]), failImage: (id) => images.get(id)?.reject(new Error('network error')), finishPreparation: () => { for (const item of preparations) item.resolve({ group: item.group, models: ['gpt-test', 'gpt-image-2'], keyCreated: false }) }, switchScope: (id) => { userId = id; setScope(`xm-account:${id}`) }, resetGroupFailure: () => { failedGroupList = false }, setActive,
    setGroups: (names) => { groupOverride = names.map((name) => ({ name, description: name, ratio: 1 })) },
    failGroupList: () => { failedGroupList = true },
    deferGroupList: () => { groupGate = new Promise<void>((resolve) => { releaseGroupGate = resolve }) },
    releaseGroupList: () => { releaseGroupGate?.(); groupGate = undefined; releaseGroupGate = undefined },
    savedWorkspace,
    failHistoryWrites: (fail) => { failHistoryWrites = fail },
  }
  return <ToastProvider testId="chat-toasts"><ChatPage bridge={bridge as XingmangApi} accountScope={scope} active={active} /></ToastProvider>
}
createRoot(document.getElementById('root')!).render(query.has('strict') ? <StrictMode><Fixture /></StrictMode> : <Fixture />)
