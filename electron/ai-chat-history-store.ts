import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AiChatHistoryFile, AiChatHistorySnapshot, AiChatHistoryWrite } from './ipc-contract'
import { readDirectoryEntries } from './bounded-directory'
import { assertSafeDataFile, ensureSafeDataDirectory, readSafeUtf8File, removeSafeDataFile, writeAtomicSafeUtf8File } from './safe-local-data'

// 聊天记录以前整份存在渲染层 localStorage 里，超过 4 MB 就整份不写，退出后新内容
// 全丢。现在按对话拆成文件放在用户数据目录：一次保存只重写改过的那几个对话，
// 索引最后写，删掉的对话等索引落盘后才清理。上限只是防止撑爆内存的安全阀，
// 远高于正常使用会碰到的量。
//
// 与渲染层 storage.ts 的 50 个对话上限是有意重复：electron 不 import src（同 I6/I7）。
export const MAX_CHAT_HISTORY_CONVERSATIONS = 50
export const MAX_CHAT_HISTORY_FILE_BYTES = 64 * 1024 * 1024
export const MAX_CHAT_HISTORY_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_SCOPE_LENGTH = 256
// 50 个对话 + 索引，外加原子写入残留的临时文件，留足余量。
const MAX_DIRECTORY_ENTRIES = 256
// 一台电脑上登录过的账号数。每个账号各有 256 MB 的上限，这里再挡住渲染层被攻破后
// 换着 scope 无限开新目录把磁盘写满。
export const MAX_CHAT_HISTORY_SCOPES = 64
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const CONVERSATION_FILE = /^c-([A-Za-z0-9_-]{1,64})\.json$/
const INDEX_FILE = 'index.json'
const label = '聊天记录'

export interface AiChatHistoryStore {
  read(scope: string): Promise<AiChatHistorySnapshot>
  write(input: AiChatHistoryWrite): Promise<void>
  /** Resolves once every write accepted so far has settled; quitting waits on it. */
  idle(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function parseAiChatHistoryScope(value: unknown): string {
  // The scope only names a directory through its hash, so it cannot traverse;
  // the bound and the control-character check keep log lines and hashes sane.
  if (typeof value !== 'string' || !value || value.length > MAX_SCOPE_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('聊天记录归属无效')
  }
  return value
}

function parseContent(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what}格式无效`)
  if (utf8Bytes(value) > MAX_CHAT_HISTORY_FILE_BYTES) throw new Error(`${what}超过 ${MAX_CHAT_HISTORY_FILE_BYTES / 1024 / 1024} MB，无法保存`)
  return value
}

export function parseAiChatHistoryWrite(value: unknown): AiChatHistoryWrite {
  if (!isRecord(value)) throw new Error('聊天记录保存请求格式无效')
  const scope = parseAiChatHistoryScope(value.scope)
  const index = parseContent(value.index, '聊天记录索引')
  if (!Array.isArray(value.keys) || value.keys.length > MAX_CHAT_HISTORY_CONVERSATIONS) throw new Error('聊天对话数量无效')
  const keys = value.keys.map((key) => {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new Error('聊天对话标识无效')
    return key
  })
  if (new Set(keys).size !== keys.length) throw new Error('聊天对话标识重复')
  if (!Array.isArray(value.put) || value.put.length > keys.length) throw new Error('聊天对话写入列表无效')
  const put = value.put.map((entry): AiChatHistoryFile => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !keys.includes(entry.key)) throw new Error('聊天对话写入列表无效')
    return { key: entry.key, content: parseContent(entry.content, '单个聊天对话') }
  })
  if (new Set(put.map((entry) => entry.key)).size !== put.length) throw new Error('聊天对话写入列表重复')
  return { scope, index, keys, put }
}

// 32 hex digits keep the deepest temporary file under Windows' 260-character
// path limit even with a long user name; 128 bits is plenty to tell accounts apart.
export function chatHistoryDirectoryName(scope: string): string {
  return createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 32)
}

function conversationFile(key: string): string {
  return `c-${key}.json`
}

export function createAiChatHistoryStore(options: { root: string; maxTotalBytes?: number }): AiChatHistoryStore {
  const maxTotalBytes = options.maxTotalBytes ?? MAX_CHAT_HISTORY_TOTAL_BYTES
  const totalLimitMessage = `聊天记录超过 ${Math.floor(maxTotalBytes / 1024 / 1024)} MB 安全上限`
  const queues = new Map<string, Promise<void>>()
  const directoryOf = (scope: string) => path.join(options.root, chatHistoryDirectoryName(scope))

  async function conversationKeysOnDisk(directory: string): Promise<string[]> {
    const entries = await readDirectoryEntries(directory, MAX_DIRECTORY_ENTRIES, label)
    const keys: string[] = []
    for (const entry of entries) {
      const match = CONVERSATION_FILE.exec(entry.name)
      if (match && entry.isFile()) keys.push(match[1])
    }
    return keys
  }

  async function read(scope: string): Promise<AiChatHistorySnapshot> {
    const directory = directoryOf(parseAiChatHistoryScope(scope))
    // A window reopened for the same account must see the save the previous
    // one sent on its way out, and never a half-pruned directory.
    await queues.get(scope)
    // Nothing on disk yet is the normal first run (or the one before
    // migrating out of localStorage), not an error.
    if (!fs.existsSync(directory)) return { index: null, conversations: [] }
    ensureSafeDataDirectory(directory, label)
    const index = await readSafeUtf8File(path.join(directory, INDEX_FILE), label, MAX_CHAT_HISTORY_FILE_BYTES)
    if (index === null) return { index: null, conversations: [] }
    let total = utf8Bytes(index)
    const conversations: AiChatHistoryFile[] = []
    for (const key of await conversationKeysOnDisk(directory)) {
      const content = await readSafeUtf8File(path.join(directory, conversationFile(key)), label, MAX_CHAT_HISTORY_FILE_BYTES)
      if (content === null) continue
      total += utf8Bytes(content)
      if (total > maxTotalBytes) throw new Error(`${totalLimitMessage}，原始记录已保留`)
      conversations.push({ key, content })
    }
    return { index, conversations }
  }

  async function persist(input: AiChatHistoryWrite): Promise<void> {
    const directory = directoryOf(input.scope)
    if (!fs.existsSync(directory) && fs.existsSync(options.root)) {
      const scopes = await readDirectoryEntries(options.root, MAX_DIRECTORY_ENTRIES, label)
      if (scopes.length >= MAX_CHAT_HISTORY_SCOPES) throw new Error('这台电脑上保存聊天记录的账号过多，本次没有保存')
    }
    ensureSafeDataDirectory(directory, label)
    // Refuse up front anything the next read would refuse: a record that
    // saved fine and then cannot be opened is worse than a visible save error.
    const written = new Set(input.put.map((entry) => entry.key))
    let total = utf8Bytes(input.index) + input.put.reduce((sum, entry) => sum + utf8Bytes(entry.content), 0)
    for (const key of input.keys) {
      if (written.has(key)) continue
      const filePath = path.join(directory, conversationFile(key))
      if (!assertSafeDataFile(filePath, label)) throw new Error('聊天记录缺少已保存的对话，本次没有保存')
      total += fs.lstatSync(filePath).size
    }
    if (total > maxTotalBytes) throw new Error(`${totalLimitMessage}，本次没有保存`)
    // Conversations first, index last: until the index lands, the previous
    // index still names only files that exist, so a crash in between loses
    // at most this save, never an older one.
    for (const entry of input.put) await writeAtomicSafeUtf8File(path.join(directory, conversationFile(entry.key)), entry.content, label)
    await writeAtomicSafeUtf8File(path.join(directory, INDEX_FILE), input.index, label)
    const kept = new Set(input.keys)
    for (const key of await conversationKeysOnDisk(directory)) {
      if (!kept.has(key)) await removeSafeDataFile(path.join(directory, conversationFile(key)), label)
    }
  }

  function write(value: AiChatHistoryWrite): Promise<void> {
    const input = parseAiChatHistoryWrite(value)
    // Saves for one account run strictly in order, so an older snapshot can
    // never land after a newer one.
    const previous = queues.get(input.scope) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => persist(input))
    const tail = next.catch(() => undefined)
    queues.set(input.scope, tail)
    void tail.then(() => { if (queues.get(input.scope) === tail) queues.delete(input.scope) })
    return next
  }

  return {
    read,
    write,
    idle: () => Promise.all([...queues.values()]).then(() => undefined),
  }
}
