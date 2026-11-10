import { currentAccountGroupName } from '../../../../electron/catalog'
import { redactSecretShapes } from '../../../../electron/redaction-patterns'
import type { AiChatAsset, AiChatHistorySnapshot, AiChatHistoryWrite, XingmangApi } from '../../../../electron/ipc-contract'
import { createConversation, createId, createWorkspace, defaultChatSettings, type ChatMessage, type ChatSettings, type ChatWorkspace, type Conversation } from './state'

// 读不出来时那条红条的前半句；后半句「现在聊的内容不会保存……」在 useChatController 里接上。
// 下面各处 ChatStorageError 的原文是给排查看的，只写进日志，上屏一律说这一句（W24）。
const unreadableHistory = '以前的聊天记录暂时读不出来，原文件没动'

// localStorage 现在只是旧版本留下的迁移来源，新记录一律写到主进程的文件里。读迁移来源时只读；
// 文件里有了这个账号的记录之后，才把旧副本删掉并记一个「已迁移」标记（forgetLegacyHistory）。
export interface ChatStorage { getItem: (key: string) => string | null; setItem?: (key: string, value: string) => void; removeItem?: (key: string) => void }
const MAX_CONVERSATIONS = 50
const HISTORY_VERSION = 3
const ASSET_ID = /^[A-Za-z0-9_-]{43}$/
const FILE_KEY = /^[A-Za-z0-9_-]{1,64}$/
export class ChatStorageError extends Error {}
// 超过上限是唯一一种原文就是说给客户听的：读的时候、存的时候都照这句上屏（W24）。
class ChatHistoryLimitError extends ChatStorageError {}
const limitMessage = `聊天记录超过 ${MAX_CONVERSATIONS} 个，这台电脑存不下，原来的记录没动`

export function historyKey(scope: string): string { return `xingmang-ui-v2:chat:${encodeURIComponent(scope)}` }
function migratedKey(scope: string): string { return `xingmang-ui-v2:chat-migrated:${encodeURIComponent(scope)}` }
// Every localStorage key readWorkspace may read for this scope: its own, and for
// the xm realm the two old site aliases and the v1 key (see importLegacyHistory).
export function legacyHistoryKeys(scope: string): string[] {
  const keys = [historyKey(scope)]
  const xm = /^xm-account:([1-9][0-9]*)$/.exec(scope)
  if (xm && Number.isSafeInteger(Number(xm[1]))) keys.push(historyKey(`solov:${xm[1]}`), historyKey(`sub2api:${xm[1]}`), `xingmang-ai-chat:v1:${encodeURIComponent(xm[1])}`)
  return keys
}
function hasMigrated(storage: ChatStorage, scope: string): boolean {
  try { return storage.getItem(migratedKey(scope)) !== null } catch { return false }
}
// Called only once the file store holds a record for this account, so the
// localStorage copies are stale duplicates nothing reads again. Left in place, a
// conversation deleted in the app would survive there verbatim, and a cleared
// history folder would bring it back as a fresh migration. The marker goes first
// so that even a removal that fails can never be read back. Best effort: storage
// may be disabled or full, and the file store is already authoritative.
export function forgetLegacyHistory(storage: ChatStorage, scope: string): void {
  try { storage.setItem?.(migratedKey(scope), '1') } catch { /* The removals below still apply. */ }
  for (const key of legacyHistoryKeys(scope)) {
    try { storage.removeItem?.(key) } catch { /* Keep trying the remaining keys. */ }
  }
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ChatStorageError('聊天记录包含无法完整读取的文本，原始记录已保留')
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160) throw new ChatStorageError('聊天记录标识无效，原始记录已保留')
  return value
}
function timestamp(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function readSettings(value: unknown): ChatSettings {
  const settings = object(value)
  if (!settings) {
    if (value !== undefined && value !== null) throw new ChatStorageError('聊天参数格式无效，原始记录已保留')
    return defaultChatSettings()
  }
  // xm 站删了的老分组名换成现在的名字（catalog.ts 的 retiredAccountGroups），老对话打开就能接着聊，不用重选分组。
  const result = { ...defaultChatSettings(), mode: settings.mode === 'image' ? 'image' as const : 'text' as const, group: currentAccountGroupName(text(settings.group)), model: text(settings.model), systemPrompt: text(settings.systemPrompt) }
  const parameters = object(settings.parameters)
  for (const key of ['temperature', 'topP', 'maxTokens', 'frequencyPenalty', 'presencePenalty', 'seed'] as const) if (parameters && typeof parameters[key] === 'number' && Number.isFinite(parameters[key])) result.parameters[key] = parameters[key]
  if (typeof settings.size === 'string' && /^(auto|\d{3,4}x\d{3,4})$/.test(settings.size)) result.size = settings.size
  if (settings.quality === 'low' || settings.quality === 'medium' || settings.quality === 'high' || settings.quality === 'auto') result.quality = settings.quality
  if (settings.imageResolution === '1K' || settings.imageResolution === '2K' || settings.imageResolution === '4K') result.imageResolution = settings.imageResolution
  return result
}
function readAsset(value: unknown): AiChatAsset {
  const asset = object(value)
  if (!asset || typeof asset.assetId !== 'string' || !ASSET_ID.test(asset.assetId)) throw new ChatStorageError('聊天图片记录无效，原始记录已保留')
  const mimeType = asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/webp' ? asset.mimeType : 'image/png'
  return { assetId: asset.assetId, localUrl: `xingmang-asset://image/${asset.assetId}`, mimeType, fileName: text(asset.fileName) || '星芒图片.png', ...(timestamp(asset.width) ? { width: timestamp(asset.width) } : {}), ...(timestamp(asset.height) ? { height: timestamp(asset.height) } : {}), ...(asset.revisedPrompt ? { revisedPrompt: text(asset.revisedPrompt) } : {}) }
}
function readMessage(value: unknown): ChatMessage {
  const message = object(value)
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) throw new ChatStorageError('聊天消息格式无效，原始记录已保留')
  const images = Array.isArray(message.assets) ? message.assets : Array.isArray(message.images) ? message.images : []
  if ((message.assets !== undefined && !Array.isArray(message.assets)) || (message.images !== undefined && !Array.isArray(message.images))) throw new ChatStorageError('聊天图片列表无效，原始记录已保留')
  const assets = images.map(readAsset)
  const status = message.status === 'complete' || message.status === 'error' || message.status === 'canceled' ? message.status : 'canceled'
  return { id: id(message.id), role: message.role, content: text(message.content), reasoning: text(message.reasoning), status, createdAt: timestamp(message.createdAt), ...(assets.length ? { assets } : {}), ...(message.settings ? { settings: readSettings(message.settings) } : {}), ...(status === 'error' ? { error: text(message.error) || '上次请求未完成，可以重新生成' } : {}), ...(message.mayStillComplete === true ? { mayStillComplete: true } : {}) }
}
function assertUniqueIds(items: { id: string }[]): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new ChatStorageError('聊天记录包含重复标识，原始记录已保留')
}
function readConversation(value: unknown): Conversation {
  const conversation = object(value)
  if (!conversation || !Array.isArray(conversation.messages)) throw new ChatStorageError('聊天对话格式无效，原始记录已保留')
  const messages = conversation.messages.map(readMessage)
  assertUniqueIds(messages)
  if (conversation.draftImages !== undefined && !Array.isArray(conversation.draftImages)) throw new ChatStorageError('聊天图片列表无效，原始记录已保留')
  const draftImages = (conversation.draftImages ?? []).map(readAsset)
  return { id: id(conversation.id), title: text(conversation.title) || '新对话', createdAt: timestamp(conversation.createdAt), updatedAt: timestamp(conversation.updatedAt), draft: text(conversation.draft), ...(draftImages.length ? { draftImages } : {}), settings: readSettings(conversation.settings), messages, ...(conversation.lengthNoticeDismissed === true ? { lengthNoticeDismissed: true } : {}) }
}
function parseWorkspace(raw: string, scope: string): ChatWorkspace {
  const parsed = object(JSON.parse(raw))
  if (!parsed || parsed.version !== 2 || parsed.owner !== scope || !Array.isArray(parsed.conversations)) throw new Error('invalid owner or version')
  if (parsed.conversations.length > MAX_CONVERSATIONS) throw new ChatHistoryLimitError(limitMessage)
  const conversations = parsed.conversations.map(readConversation)
  const draftConversation = parsed.draftConversation === undefined ? createConversation() : readConversation(parsed.draftConversation)
  assertUniqueIds([...conversations, draftConversation])
  const activeId = typeof parsed.activeId === 'string' && conversations.some((item) => item.id === parsed.activeId) ? parsed.activeId : null
  return { version: 2, owner: scope, conversations, activeId, draftConversation }
}

function mergeAliases(candidates: ChatWorkspace[], scope: string): ChatWorkspace {
  const state: ChatWorkspace = { ...candidates[0], owner: scope, conversations: [] }
  const used = new Set([state.draftConversation.id])
  const originals = new Set<string>()
  const append = (conversation: Conversation) => {
    const serialized = JSON.stringify(conversation)
    if (originals.has(serialized)) return
    originals.add(serialized)
    let conversationId = conversation.id
    while (used.has(conversationId)) conversationId = createId()
    used.add(conversationId)
    state.conversations.push({ ...conversation, id: conversationId })
  }
  for (const candidate of candidates) {
    candidate.conversations.forEach(append)
    if (candidate !== candidates[0] && (candidate.draftConversation.draft || candidate.draftConversation.messages.length || candidate.draftConversation.settings.systemPrompt)
      && JSON.stringify(candidate.draftConversation) !== JSON.stringify(state.draftConversation)) append(candidate.draftConversation)
  }
  return state
}
// Reads what earlier versions left in localStorage. It never writes: the
// caller saves the result to the file store, and every source key stays as it
// was, so a failed first save can simply be retried from the same source.
export function readWorkspace(storage: ChatStorage, scope: string): { state: ChatWorkspace; warning?: string; problem?: string; exists: boolean } {
  const empty = () => ({ state: createWorkspace(scope), exists: false })
  try {
    const raw = storage.getItem(historyKey(scope))
    if (raw !== null) return { state: parseWorkspace(raw, scope), exists: true }
    // The old site names both referred to xm. Migrate only into its canonical
    // realm, only when the destination is absent, and validate each source's
    // original owner before assigning the new one. Source records stay intact.
    const xm = /^xm-account:([1-9][0-9]*)$/.exec(scope)
    if (xm && Number.isSafeInteger(Number(xm[1]))) {
      const candidates: ChatWorkspace[] = []
      for (const alias of ['solov', 'sub2api']) {
        const oldScope = `${alias}:${xm[1]}`
        const previous = storage.getItem(historyKey(oldScope))
        if (previous !== null) candidates.push(parseWorkspace(previous, oldScope))
      }
      const modifiedAt = (workspace: ChatWorkspace) => Math.max(workspace.draftConversation.updatedAt, ...workspace.conversations.map((item) => item.updatedAt))
      // Both aliases could have been used over time. Keep the most recent
      // selection, while merging unique conversations and conflicting versions.
      candidates.sort((left, right) => modifiedAt(right) - modifiedAt(left))
      if (candidates[0]) return { state: mergeAliases(candidates, scope), exists: true }
      // Scope is already the authenticated account boundary, also used above
      // for alias ownership. Resolve v1 synchronously before any autosave can
      // establish an empty v2 destination and permanently hide the old history.
      const legacy = importLegacyHistory(storage, scope, Number(xm[1]))
      if (legacy) return { state: legacy, exists: true }
    }
    return empty()
  } catch (error) { return { ...empty(), exists: true, warning: historyWarning(error), problem: historyProblem(error) } }
}

/** 读不出来时上屏的那句：超过上限照原文说，别的一律是 unreadableHistory（W24）。 */
function historyWarning(error: unknown): string {
  return error instanceof ChatHistoryLimitError ? error.message : unreadableHistory
}
/** 读不出来的原文，只进日志。 */
function historyProblem(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}
/** 读不出来的原文写进本机运行日志：只记不报，客户看不到它。 */
export function chatHistoryLogger(bridge: Pick<XingmangApi, 'reportRendererError'>): (detail: string) => void {
  return (detail) => { void bridge.reportRendererError({ message: detail, context: 'chat-history', level: 'warn' }).catch(() => undefined) }
}
/** 有几段对话读不出来、已经挪开时，页面上那句（D40）。 */
export function unreadableConversationsNotice(count: number): string {
  return `有 ${count} 段对话读不出来，已经单独留着，其余照常。`
}
// The history files sit unencrypted in the user profile, and chat text is the one
// surface where a pasted key, an Authorization header or a whole base64 image
// arrives verbatim. Redacting on the way out keeps those out of the record that
// survives the window they were typed in, without touching the copy on screen.
// 只剥凭据与运行时专用负载：普通链接和正文照原样存，本地记录仍然是无损的。
// 刻意不照搬旧渲染层的两条规则：整条抹掉 http(s) 链接，以及把任意超长字母数字块
// 当成编码数据。前者在 v2 没有收益（素材只存 assetId，运行时 URL 早已剥离），
// 后者会把普通长文本也吞掉，与这里「只对真实内容无损」的既有约定冲突。
// 原有的几条规则先照原样跑完，再过一遍日志、诊断、崩溃报告共用的那张认密钥的表
// （redaction-patterns.ts），只是换成聊天自己的字样：以前这里只有自己抄的几条，表后来加的
// Grok、GitHub、JWT、网址里的密码都没跟上。共用表放在最后，只会在原有结果上再多遮：
// 放在前面，它认出的 `sk-…`、`ghp_…` 会连着吞掉紧挨着的 `api_key=` 这类名字，下面
// 「名字 = 值」那条就认不出名字、把值漏存了。
const secretNotSaved = '[密钥未保存]'
const inlineImageData = /data:[^\s,;]+(?:;[^\s,;]+)*;base64,[A-Za-z0-9+/=_-]+/gi
const runtimeBlobUrl = /blob:[^\s)\]}>"']+/gi
// 和共用表那条一样，但要赶在下面几条之前：`?token=` 和「名字 = 值」两条吞到空格为止，
// 碰上 `?token=Bearer 值` 只吞掉 `Bearer` 这个词，后面的值共用表就再也认不出来了。
const bearerValue = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi
// 比共用表那条多收 `.`，后面那截才不会漏。结尾不用 `\b`，否则以 `-` 结尾的密钥会漏掉
// 尾巴（共用表 KEY_TAIL 那段注释说的同一件事）。
const relayKeyWithDots = /\bsk-[A-Za-z0-9._-]{7,}[A-Za-z0-9_-](?![A-Za-z0-9_-])/gi
const secretQueryParameter = /([?&](?:api[_-]?key|token)=)[^&\s]+/gi
// 「名字: 值」「名字 = 值」：名字是这几个词时，后面那一截整段不存。
const namedSecretValue = /((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi

export function redactPersistentChatText(value: string): string {
  // 图片数据和临时链接先整段换掉：base64 里随时可能夹着 `eyJ`、`sk-` 这类片段，
  // 先过密钥规则会把它们切碎，后面就认不出整段了。
  const ownRules = value
    .replace(inlineImageData, '[图片数据未保存]')
    .replace(runtimeBlobUrl, '[本地临时链接未保存]')
    .replace(bearerValue, `$1${secretNotSaved}`)
    .replace(relayKeyWithDots, secretNotSaved)
    .replace(secretQueryParameter, `$1${secretNotSaved}`)
    .replace(namedSecretValue, `$1${secretNotSaved}`)
  return redactSecretShapes(ownRules, secretNotSaved)
}
function persistedSettings(settings: ChatSettings): ChatSettings {
  return { ...settings, systemPrompt: redactPersistentChatText(settings.systemPrompt) }
}
function persistedAsset({ localUrl: _runtimeUrl, ...asset }: AiChatAsset) {
  return { ...asset, ...(asset.revisedPrompt === undefined ? {} : { revisedPrompt: redactPersistentChatText(asset.revisedPrompt) }) }
}
function persistedMessage(message: ChatMessage) {
  return {
    ...message,
    requestId: undefined,
    content: redactPersistentChatText(message.content),
    reasoning: redactPersistentChatText(message.reasoning),
    ...(message.error === undefined ? {} : { error: redactPersistentChatText(message.error) }),
    ...(message.settings ? { settings: persistedSettings(message.settings) } : {}),
    assets: message.assets?.map(persistedAsset),
  }
}
function persistedConversation(conversation: Conversation) {
  return { ...conversation, title: redactPersistentChatText(conversation.title), draft: redactPersistentChatText(conversation.draft), draftImages: conversation.draftImages?.map(persistedAsset), settings: persistedSettings(conversation.settings), messages: conversation.messages.map((message) => persistedMessage(message)) }
}

// What the file store holds after the last successful save. Conversations are
// compared by identity: state updates replace only the conversation they
// touch, so a save rewrites just those files instead of the whole history.
// setAside names the files of conversations that could not be read: the next
// save asks the main process to move them into a backup folder instead of
// deleting them, and no other conversation may take their file name meanwhile.
export interface SavedHistory { index: string; keys: ReadonlyMap<string, string>; conversations: ReadonlyMap<string, Conversation>; setAside?: readonly string[] }
// afterFirstSave is set only when the state came from localStorage (or from nothing,
// before any migration): the writer runs it once the first save has succeeded.
// warning = 整份读不出来，这一回不往本机写；unreadable = 只有这几段读不出来、已经挪开，其余照常读写（D40）。
export interface LoadedChatHistory { state: ChatWorkspace; exists: boolean; warning?: string; unreadable?: number; saved: SavedHistory | null; afterFirstSave?: () => void }
// 读的时候只要能读；日志是可选的（设置页「搬到新电脑」、测试里不一定接）。
export interface ChatHistoryReader { readHistory: (scope: string) => Promise<AiChatHistorySnapshot>; logHistoryProblem?: (detail: string) => void }

export function planHistoryWrite(state: ChatWorkspace, previous: SavedHistory | null): { write: AiChatHistoryWrite; saved: SavedHistory } | null {
  if (state.conversations.length > MAX_CONVERSATIONS) throw new ChatHistoryLimitError(limitMessage)
  const keys = new Map<string, string>()
  // 还没挪走的坏文件占着它的名字：新对话拿了它，主进程就会把新内容写到坏文件头上。
  const used = new Set<string>(previous?.setAside)
  for (const conversation of state.conversations) {
    let key = previous?.keys.get(conversation.id) ?? (FILE_KEY.test(conversation.id) ? conversation.id : createId())
    while (used.has(key)) key = createId()
    used.add(key)
    keys.set(conversation.id, key)
  }
  const put = state.conversations
    .filter((conversation) => previous?.conversations.get(conversation.id) !== conversation || previous.keys.get(conversation.id) !== keys.get(conversation.id))
    .map((conversation) => ({ key: keys.get(conversation.id)!, content: JSON.stringify({ version: HISTORY_VERSION, owner: state.owner, conversation: persistedConversation(conversation) }) }))
  const index = JSON.stringify({ version: HISTORY_VERSION, owner: state.owner, activeId: state.activeId, draftConversation: persistedConversation(state.draftConversation), conversations: state.conversations.map((conversation) => ({ id: conversation.id, key: keys.get(conversation.id) })) })
  const setAside = previous?.setAside?.length ? { setAside: [...previous.setAside] } : {}
  if (previous && !put.length && index === previous.index && !previous.setAside?.length) return null
  return {
    write: { scope: state.owner, index, keys: [...keys.values()], put, ...setAside },
    saved: { index, keys, conversations: new Map(state.conversations.map((conversation) => [conversation.id, conversation])) },
  }
}

/** 一段读不出来的对话：kept = 文件还在、下一次保存挪进备份文件夹；false = 文件已经没了，只从索引里拿掉。 */
export interface UnreadableConversation { key: string; reason: string; kept: boolean }

// 索引是一次原子写下的整份，它本身坏了（读不出、归属或版本不对、条目不成样、超过上限）就整份不读，
// 这一回也不写，原文件不动。索引好好的，只有某一段对话的文件坏了、没了，就只跳过那一段，其余照常读写：
// 以前一段坏了整份都读不出来，以后聊的也不存，「重新读取」永远读不出来（0.2.24 深查聊天页 C2）。
export function parseHistorySnapshot(snapshot: AiChatHistorySnapshot, scope: string): { state: ChatWorkspace; saved: SavedHistory; unreadable: UnreadableConversation[] } {
  if (snapshot.index === null) throw new ChatStorageError('聊天记录不存在')
  let parsed: Record<string, unknown> | null
  try { parsed = object(JSON.parse(snapshot.index)) } catch { throw new ChatStorageError('聊天记录索引无法读取，原始记录已保留') }
  if (!parsed || parsed.version !== HISTORY_VERSION || parsed.owner !== scope || !Array.isArray(parsed.conversations)) throw new ChatStorageError('聊天记录归属或版本无效，原始记录已保留')
  if (parsed.conversations.length > MAX_CONVERSATIONS) throw new ChatHistoryLimitError(limitMessage)
  const entries = parsed.conversations.map((value) => {
    const entry = object(value)
    const key = entry?.key
    if (!entry || typeof key !== 'string' || !FILE_KEY.test(key)) throw new ChatStorageError('聊天记录索引无效，原始记录已保留')
    return { id: id(entry.id), key }
  })
  const draftConversation = parsed.draftConversation === undefined ? createConversation() : readConversation(parsed.draftConversation)
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new ChatStorageError('聊天记录索引无效，原始记录已保留')
  assertUniqueIds([...entries, draftConversation])
  const files = new Map(snapshot.conversations.map((file) => [file.key, file.content]))
  const keys = new Map<string, string>()
  const conversations: Conversation[] = []
  const unreadable: UnreadableConversation[] = []
  for (const entry of entries) {
    const content = files.get(entry.key)
    if (content === undefined) { unreadable.push({ key: entry.key, reason: '聊天记录缺少这段对话的文件', kept: false }); continue }
    try {
      conversations.push(readStoredConversation(content, entry.id, scope))
      keys.set(entry.id, entry.key)
    } catch (error) { unreadable.push({ key: entry.key, reason: historyProblem(error), kept: true }) }
  }
  const activeId = typeof parsed.activeId === 'string' && conversations.some((item) => item.id === parsed.activeId) ? parsed.activeId : null
  const setAside = unreadable.filter((item) => item.kept).map((item) => item.key)
  return {
    state: { version: 2, owner: scope, conversations, activeId, draftConversation },
    saved: { index: snapshot.index, keys, conversations: new Map(conversations.map((conversation) => [conversation.id, conversation])), ...(setAside.length ? { setAside } : {}) },
    unreadable,
  }
}

function readStoredConversation(content: string, expectedId: string, scope: string): Conversation {
  let file: Record<string, unknown> | null
  try { file = object(JSON.parse(content)) } catch { throw new ChatStorageError('聊天对话无法读取，原始记录已保留') }
  if (!file || file.version !== HISTORY_VERSION || file.owner !== scope) throw new ChatStorageError('聊天对话归属或版本无效，原始记录已保留')
  const conversation = readConversation(file.conversation)
  if (conversation.id !== expectedId) throw new ChatStorageError('聊天记录索引与对话不一致，原始记录已保留')
  return conversation
}

// The file store wins once it has a record for this account. Before that the
// localStorage record of earlier versions (and its account aliases and the v1
// key) is loaded and becomes the first save, which is the whole migration. The
// source keys are removed only after that save succeeded; a failed save keeps
// them for the next attempt. Once migrated, a missing file store stays empty.
// An import running for this account is waited out first (runHistoryImport).
export async function loadChatHistory(api: ChatHistoryReader, storage: ChatStorage, scope: string): Promise<LoadedChatHistory> {
  await settleHistoryImports(scope)
  return readChatHistory(api, storage, scope)
}

async function readChatHistory(api: ChatHistoryReader, storage: ChatStorage, scope: string): Promise<LoadedChatHistory> {
  function log(detail: string): void {
    try { api.logHistoryProblem?.(detail) } catch { /* Logging must never change what the page shows. */ }
  }
  function unreadable(error: unknown): LoadedChatHistory {
    log(`聊天记录读不出来，这一回不保存：${historyProblem(error)}`)
    return { state: createWorkspace(scope), exists: true, warning: historyWarning(error), saved: null }
  }
  let snapshot: AiChatHistorySnapshot
  try { snapshot = await api.readHistory(scope) } catch (error) { return unreadable(error) }
  if (snapshot.index === null) {
    if (hasMigrated(storage, scope)) return { state: createWorkspace(scope), exists: false, saved: null }
    const { problem, ...legacy } = readWorkspace(storage, scope)
    if (problem) log(`以前存在本机的聊天记录读不出来，这一回不保存：${problem}`)
    return legacy.warning ? { ...legacy, saved: null } : { ...legacy, saved: null, afterFirstSave: () => forgetLegacyHistory(storage, scope) }
  }
  let parsed: ReturnType<typeof parseHistorySnapshot>
  try { parsed = parseHistorySnapshot(snapshot, scope) } catch (error) { return unreadable(error) }
  for (const item of parsed.unreadable) log(item.kept ? `聊天对话 c-${item.key}.json 读不出来，下次保存时挪进备份文件夹：${item.reason}` : `聊天对话 c-${item.key}.json 不见了，已从记录里拿掉`)
  // Also covers earlier versions, which migrated without removing anything.
  forgetLegacyHistory(storage, scope)
  const kept = parsed.unreadable.filter((item) => item.kept).length
  return { state: parsed.state, saved: parsed.saved, exists: true, ...(kept ? { unreadable: kept } : {}) }
}

// Saves still on their way to the file store, from every writer including
// ones whose chat page has just unmounted (its last save runs after unmount).
// Importing waits on these so an older snapshot cannot land on top of it.
const inFlightSaves = new Set<Promise<void>>()
export async function settleHistoryWrites(): Promise<void> {
  while (inFlightSaves.size) await Promise.allSettled([...inFlightSaves])
}

// 自动保存等字停下 autosaveQuietMs 再存；可是回复出字时主进程每 50 毫秒推一段，一直停不下来，以前要等整段说完
// 才存第一次，这时退出或崩了，已经扣了费的回复一个字都不剩（0.2.24 深查聊天页 C1）。所以从头一处没存的改动算起，
// 最多等 autosaveMaxWaitMs 就存一次。
export const autosaveQuietMs = 250
export const autosaveMaxWaitMs = 2_000
/** 从 firstChangeAt（头一处还没存的改动）起，到 now 这次改动之后还要等多久再存。 */
export function autosaveDelay(firstChangeAt: number, now: number): number {
  return Math.max(0, Math.min(autosaveQuietMs, firstChangeAt + autosaveMaxWaitMs - now))
}

// 退出前主进程来要一次（electron/chat-history-flush.ts）：开着的聊天页各自把手上的那一份交出来存一次。
const historyFlushers = new Set<() => Promise<void>>()
/** 聊天页挂上时登记它的「马上存一次」，卸下时撤掉。 */
export function registerHistoryFlusher(flush: () => Promise<void>): () => void {
  historyFlushers.add(flush)
  return () => { historyFlushers.delete(flush) }
}
/** 开着的聊天页都马上存一次，连同刚卸下的那页还在路上的最后一次，写完或失败了才交回；不抛错。 */
export async function flushChatHistory(): Promise<void> {
  const saves: Promise<void>[] = []
  for (const flush of [...historyFlushers]) {
    try { saves.push(flush()) } catch { /* One page failing must not keep the others from saving. */ }
  }
  await Promise.allSettled([...saves, ...inFlightSaves])
}
/**
 * 接住主进程退出前的那一声：存完回话，主进程这才去等写盘。存失败也照样回话，原来的文件没动，
 * 退出不该被它拦住。聊天页开没开都要回，所以挂在 App 上，不挂在聊天页上。
 */
export function answerHistoryFlushRequests(bridge: Pick<XingmangApi, 'onAiChatHistoryFlushRequested' | 'confirmAiChatHistoryFlushed'>): () => void {
  return bridge.onAiChatHistoryFlushRequested(({ requestId }) => {
    void flushChatHistory().then(() => bridge.confirmAiChatHistoryFlushed(requestId)).catch(() => undefined)
  })
}

// Imports still merging into an account's files (R28-2). The main process puts
// a read behind the writes it has already been sent, not behind the one an
// import has yet to send: a chat page opened meanwhile loaded the record the
// import was replacing, and its next autosave deleted the imported
// conversations again. loadChatHistory waits for these instead.
const importsInFlight = new Map<string, Promise<unknown>>()

/**
 * Runs an import into this account's history; loadChatHistory for the account
 * waits until it is done, and imports for one account run one at a time. work
 * starts on a microtask, after it is registered, so a chat page that remounts
 * synchronously inside it already waits.
 */
export function runHistoryImport<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const run = (importsInFlight.get(scope) ?? Promise.resolve()).catch(() => undefined).then(work)
  importsInFlight.set(scope, run)
  void run.catch(() => undefined).then(() => { if (importsInFlight.get(scope) === run) importsInFlight.delete(scope) })
  return run
}

async function settleHistoryImports(scope: string): Promise<void> {
  for (let running = importsInFlight.get(scope); running; running = importsInFlight.get(scope)) await running.catch(() => undefined)
}

// One save runs at a time; a save requested meanwhile only replaces the
// pending snapshot, so bursts of edits collapse into the newest one.
export function createHistoryWriter(api: { writeHistory: (input: AiChatHistoryWrite) => Promise<void> }, saved: SavedHistory | null, afterFirstSave?: () => void) {
  let committed = saved
  let firstSaved = afterFirstSave
  let pending: ChatWorkspace | null = null
  let running: Promise<void> | null = null
  async function drain(): Promise<void> {
    try {
      while (pending) {
        const state = pending
        pending = null
        const plan = planHistoryWrite(state, committed)
        if (!plan) continue
        await api.writeHistory(plan.write)
        committed = plan.saved
        const run = firstSaved
        firstSaved = undefined
        run?.()
      }
    } finally { running = null }
  }
  return {
    save(state: ChatWorkspace): Promise<void> {
      pending = state
      // Start on a microtask so `running` is assigned before drain can clear it.
      if (!running) {
        const started = Promise.resolve().then(drain)
        running = started
        inFlightSaves.add(started)
        void started.catch(() => undefined).then(() => { inFlightSaves.delete(started) })
      }
      return running
    },
  }
}

export function importLegacyHistory(storage: ChatStorage, scope: string, userId: number): ChatWorkspace | null {
  // The v1 key had no site component. It can therefore only be imported for
  // the original xm account realm (including its historical sub2api alias).
  // A same-number account on api.solov must start with an empty workspace;
  // importing by userId alone would cross the realm boundary.
  const legacyOwner = /^(xm-account|solov|sub2api):([1-9][0-9]*)$/.exec(scope)
  if (!legacyOwner || Number(legacyOwner[2]) !== userId) return null
  const raw = storage.getItem(`xingmang-ai-chat:v1:${encodeURIComponent(String(userId))}`)
  if (raw === null) return null
  try {
    const envelope = object(JSON.parse(raw)); const data = object(envelope?.data)
    if (envelope?.version !== 1 || envelope.userId !== String(userId) || !data || !Array.isArray(data.messages)) throw new ChatStorageError('旧版聊天记录格式或归属无效，原始记录已保留')
    const settings = { ...defaultChatSettings(), group: text(data.group), model: text(data.model) }
    const system = data.messages.map(object).filter((item) => item?.role === 'system').map((item) => text(item?.content)).join('\n\n')
    settings.systemPrompt = system
    const messages = data.messages.filter((item) => object(item)?.role !== 'system').map(readMessage)
    assertUniqueIds(messages)
    if (!messages.length && !settings.systemPrompt) return null
    const conversation = { ...createConversation(settings), title: '之前的聊天', messages }
    return { ...createWorkspace(scope), conversations: [conversation], activeId: conversation.id }
  } catch (error) { throw error instanceof ChatStorageError ? error : new ChatStorageError('之前的聊天记录暂时无法读取，原始数据已保留') }
}

// ---- 搬到新电脑 ----
const transferInvalidMessage = '这个文件不是星芒导出的，或者已经损坏，没有导入任何内容。'
const imageLeftBehind = '[图片没有一起搬过来]'

function portableMessage(message: ReturnType<typeof persistedMessage>) {
  // 图片文件只在这台电脑上，带过去也打不开；留一句说明代替。还在等的请求到了新电脑上
  // 也不会再回来，不带「可能还会完成」。
  const { assets, requestId: _requestId, mayStillComplete: _pending, ...rest } = message
  if (!assets?.length) return rest
  return { ...rest, content: rest.content ? `${rest.content}\n\n${imageLeftBehind}` : imageLeftBehind }
}

/** 导出给新电脑的对话：和存盘时一样去掉密钥样的文字，再去掉图片和运行时字段。 */
export function exportableConversations(state: ChatWorkspace): unknown[] {
  return state.conversations.map((conversation) => {
    const persisted = persistedConversation(conversation)
    return { ...persisted, messages: persisted.messages.map(portableMessage) }
  })
}

// 文件是用户随便选来的：每个对话都按读本机记录的同一套规则严格校验，有一个不对就
// 整份不导入，不写一半（I5）。
export function parseImportedConversations(values: unknown[]): Conversation[] {
  if (values.length > MAX_CONVERSATIONS) throw new ChatStorageError(transferInvalidMessage)
  try {
    const conversations = values.map(readConversation).map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map(({ mayStillComplete: _pending, ...message }) => message),
    }))
    assertUniqueIds(conversations)
    return conversations
  } catch { throw new ChatStorageError(transferInvalidMessage) }
}

/** 导入对话的结果：added 是导进来的新对话，skipped 是这台电脑存满 50 个、这次放不下的新对话。 */
export interface ChatImportResult { added: number; skipped: number }

/**
 * 已有的对话不覆盖（同一个对话导两次不会多出一份）。这台电脑上的对话一个不删
 * （D02：以前合起来超过 50 个时按修改时间截断，会悄悄删掉本机最老的几个）：
 * 还有几个空位就导几个，先导最近改过的，放不下的数进 skipped，删掉一些后再导一次就能补上。
 */
export function mergeImportedConversations(state: ChatWorkspace, imported: Conversation[]): { state: ChatWorkspace } & ChatImportResult {
  const present = new Set(state.conversations.map((conversation) => conversation.id))
  const fresh = imported
    .filter((conversation) => !present.has(conversation.id))
    .map((conversation) => conversation.id === state.draftConversation.id ? { ...conversation, id: createId() } : conversation)
  const room = Math.max(0, MAX_CONVERSATIONS - state.conversations.length)
  const accepted = [...fresh].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, room)
  const conversations = [...state.conversations, ...accepted].sort((left, right) => right.updatedAt - left.updatedAt)
  return { state: { ...state, conversations }, added: accepted.length, skipped: fresh.length - accepted.length }
}

/**
 * 「重新读取」读出了以前的记录：这一回在窗口里聊的对话还没存过，一个不丢地排在读出来的
 * 前面。合起来超过 50 个时照常存不进去、提示先删掉一些，不替用户删。这一回什么都没动过
 * 就停在上次看的那段，动过就停在正在看的那段；输入框里这一回打了字就留这一回的。
 */
export function mergeSessionIntoHistory(loaded: ChatWorkspace, session: ChatWorkspace): ChatWorkspace {
  // Ids are random, so a clash is not expected; a duplicate would make the saved record unreadable, though.
  const used = new Set([loaded.draftConversation.id, ...loaded.conversations.map((conversation) => conversation.id)])
  function unused(id: string): string {
    let candidate = id
    while (used.has(candidate)) candidate = createId()
    used.add(candidate)
    return candidate
  }
  const ids = new Map<string, string>()
  const added = session.conversations.map((conversation) => {
    const id = unused(conversation.id)
    ids.set(conversation.id, id)
    return id === conversation.id ? conversation : { ...conversation, id }
  })
  const typed = Boolean(session.draftConversation.draft.trim() || session.draftConversation.draftImages?.length)
  const draftId = typed ? unused(session.draftConversation.id) : ''
  const draftConversation = !typed ? loaded.draftConversation : draftId === session.draftConversation.id ? session.draftConversation : { ...session.draftConversation, id: draftId }
  const activeId = session.activeId ? ids.get(session.activeId) ?? null : typed || added.length ? null : loaded.activeId
  return { ...loaded, activeId, conversations: [...added, ...loaded.conversations], draftConversation }
}

/**
 * Reads this account's record the same way the chat page does, merges the
 * imported conversations and saves once. The caller runs it inside
 * runHistoryImport, unmounts the chat page and waits on settleHistoryWrites
 * first, so nothing else reads or writes this account's history in between.
 */
export async function importConversationsIntoHistory(
  api: ChatHistoryReader & { writeHistory: (input: AiChatHistoryWrite) => Promise<void> },
  storage: ChatStorage,
  scope: string,
  imported: Conversation[],
): Promise<ChatImportResult> {
  // Not loadChatHistory: inside runHistoryImport that would wait on itself.
  const loaded = await readChatHistory(api, storage, scope)
  if (loaded.warning) throw new ChatStorageError('这台电脑上的聊天记录现在读不出来，为了不弄丢它，这次没有导入对话')
  const { state, added, skipped } = mergeImportedConversations(loaded.state, imported)
  if (!added) return { added, skipped }
  const plan = planHistoryWrite(state, loaded.saved)
  if (plan) await api.writeHistory(plan.write)
  loaded.afterFirstSave?.()
  return { added, skipped }
}

function timeText(value: number): string {
  if (!value) return ''
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 「导出这段对话」的纯文本：标题、每条消息谁说的和什么时候，图片只留一句说明。 */
export function conversationPlainText(conversation: Conversation): string {
  const lines = [conversation.title || '新对话', '']
  for (const message of conversation.messages) {
    const who = message.role === 'user' ? '我' : 'AI'
    const when = timeText(message.createdAt)
    lines.push(when ? `${who}（${when}）：` : `${who}：`)
    const content = redactPersistentChatText(message.content)
    if (content) lines.push(content)
    if (message.assets?.length) lines.push(`[${message.assets.length} 张图片，没有放进这个文件]`)
    if (message.status === 'error' && message.error) lines.push(`[没有回复成功：${redactPersistentChatText(message.error)}]`)
    lines.push('')
  }
  return lines.join('\n')
}
