import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AiChatAsset, AiChatPreparedGroup, AiChatStreamEvent, XingmangApi } from '../../../../electron/ipc-contract'
import type { ChatBridge } from './api'
import { ChatPage } from './ChatPage'
import '../../ui'

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
const imageAsset: AiChatAsset = { assetId: 'a'.repeat(43), localUrl: '/assets/brand/v3/symbol-standard.svg', mimeType: 'image/png', fileName: 'fixture.png', width: 288, height: 256 }
function record(method: string, input?: unknown) { calls.push({ method, input }) }
const bridge: ChatBridge = {
  listAiChatGroups: async () => {
    record('groups')
    if (failedGroupList) throw new Error('network error')
    return query.has('preferredGroup')
      ? [{ name: 'default', description: '用户分组', ratio: 1 }, { name: 'Codex_pro', description: 'gpt-image-1 / 1.5 / 2（官方按 token 计费）', ratio: 1 }]
      : [{ name: 'group-a', description: '文本与图片以及一段不应进入选项标题的超长能力说明', ratio: 1 }, { name: 'group-b', description: '另一分组', ratio: 1 }]
  },
  prepareAiChatGroup: async (group) => { record('prepare', group); if (query.has('deferPreparation') && group === 'group-a') return new Promise<AiChatPreparedGroup>((resolve) => { preparations.push({ group, resolve }) }); const models = query.has('preferredGroup') && group === 'Codex_pro' ? ['other-model', 'gpt-5.6-sol'] : group === 'group-a' ? ['gpt-test', 'gpt-image-2', 'gpt-image-1.5', 'gemini-3.1-flash-image'] : ['other-model', 'grok-imagine-image']; return { group, models, keyCreated: false } },
  startAiChat: async (input) => { record('start', input); return { accepted: true, requestId: input.requestId } },
  generateAiImage: async (input) => { record('image', input); return new Promise<AiChatAsset[]>((resolve, reject) => { images.set(input.requestId, { resolve, reject }) }) },
  cancelAiChat: async (requestId) => { record('cancel', requestId); if (query.has('cancelReject')) { images.get(requestId)?.reject(new Error('request canceled')); await Promise.resolve() } return { canceled: true, mayStillComplete: images.has(requestId) } },
  onAiChatStream: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  copyAiChatAsset: async (assetId) => { record('copy-asset', assetId) },
  saveAiChatAsset: async (assetId) => { record('save-asset', assetId); return { saved: !query.has('saveCancel') } },
  showAiChatAssetMenu: async (assetId) => { record('menu-asset', assetId) },
  openExternal: async (url) => { record('external', url); return true },
  getAccountSession: async () => ({ authenticated: true, account: { userId, username: `fixture-${userId}`, quota: 10, usedQuota: 0, group: 'default', role: 1 } }),
}
declare global {
  interface Window { chatHarness: { calls: typeof calls; emit: (event: AiChatStreamEvent) => void; completeImage: (requestId: string) => void; failImage: (requestId: string) => void; finishPreparation: () => void; switchScope: (id: number) => void; resetGroupFailure: () => void; setActive: (active: boolean) => void } }
}
function Fixture() {
  const [scope, setScope] = useState('xm-account:7')
  const [active, setActive] = useState(true)
  window.chatHarness = { calls, emit: (event) => { for (const listener of listeners) listener(event) }, completeImage: (id) => images.get(id)?.resolve([imageAsset]), failImage: (id) => images.get(id)?.reject(new Error('network error')), finishPreparation: () => { for (const item of preparations) item.resolve({ group: item.group, models: ['gpt-test', 'gpt-image-2'], keyCreated: false }) }, switchScope: (id) => { userId = id; setScope(`xm-account:${id}`) }, resetGroupFailure: () => { failedGroupList = false }, setActive }
  return <ChatPage bridge={bridge as XingmangApi} accountScope={scope} active={active} />
}
createRoot(document.getElementById('root')!).render(query.has('strict') ? <StrictMode><Fixture /></StrictMode> : <Fixture />)
