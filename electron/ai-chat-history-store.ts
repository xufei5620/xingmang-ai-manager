import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AiChatHistoryFile, AiChatHistorySnapshot, AiChatHistoryWrite } from './ipc-contract'
import { readDirectoryEntries } from './bounded-directory'
import { assertSafeDataFile, ensureSafeDataDirectory, readSafeUtf8File, removeSafeDataFile, renameWithTransientRetry, writeAtomicSafeUtf8File } from './safe-local-data'
import { isRecord } from './input-guards'

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
// 一段对话的文件坏了、渲染层读不出来时，挪到这里原样留着，其余照常读写（0.2.24 深查聊天页 C2）。
// 它是子目录，读记录、清理旧文件时只看这一层的 c-*.json，碰不到这里面的。
export const UNREADABLE_CHAT_DIRECTORY = 'unreadable'
// 挪进来的只会是真坏了的那几段，正常用碰不到这个数。它挡的是渲染层被攻破后反复写满、反复挪走，
// 绕过上面那个总大小把磁盘写满；满了就这次不保存，原来的文件一个不动。
export const MAX_UNREADABLE_CHAT_FILES = 64

export interface AiChatHistoryStore {
  read(scope: string): Promise<AiChatHistorySnapshot>
  write(input: AiChatHistoryWrite): Promise<void>
  /** Resolves once every write accepted so far has settled; quitting waits on it. */
  idle(): Promise<void>
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
  if (value.setAside === undefined) return { scope, index, keys, put }
  if (!Array.isArray(value.setAside) || value.setAside.length > MAX_CHAT_HISTORY_CONVERSATIONS) throw new Error('读不出来的聊天对话列表无效')
  const setAside = value.setAside.map((key) => {
    // 还在索引里的对话不能挪走，否则索引指向的文件就没了。
    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || keys.includes(key)) throw new Error('读不出来的聊天对话列表无效')
    return key
  })
  if (new Set(setAside).size !== setAside.length) throw new Error('读不出来的聊天对话列表重复')
  return { scope, index, keys, put, ...(setAside.length ? { setAside } : {}) }
}

// 32 hex digits keep the deepest temporary file under Windows' 260-character
// path limit even with a long user name; 128 bits is plenty to tell accounts apart.
export function chatHistoryDirectoryName(scope: string): string {
  return createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 32)
}

function conversationFile(key: string): string {
  return `c-${key}.json`
}

// 挪进去的文件名带上挪走的时间：同一段对话坏过两次也不会盖掉上一份。
function unreadableFile(key: string, stamp: number, attempt: number): string {
  return attempt ? `c-${key}.${stamp}-${attempt}.json` : `c-${key}.${stamp}.json`
}

function pathTaken(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
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
    const setAside = new Set(input.setAside)
    if (setAside.size) await assertRoomToSetAside(directory, setAside)
    // Conversations first, index last: until the index lands, the previous
    // index still names only files that exist, so a crash in between loses
    // at most this save, never an older one.
    for (const entry of input.put) await writeAtomicSafeUtf8File(path.join(directory, conversationFile(entry.key)), entry.content, label)
    await writeAtomicSafeUtf8File(path.join(directory, INDEX_FILE), input.index, label)
    const kept = new Set(input.keys)
    for (const key of await conversationKeysOnDisk(directory)) {
      if (kept.has(key)) continue
      if (setAside.has(key)) await moveAside(directory, key)
      else await removeSafeDataFile(path.join(directory, conversationFile(key)), label)
    }
  }

  // Checked before anything is written, like the size bound above: once the index
  // lands without these keys, a file that cannot be moved must not be deleted instead.
  async function assertRoomToSetAside(directory: string, keys: ReadonlySet<string>): Promise<void> {
    let count = 0
    let bytes = 0
    for (const key of keys) {
      const filePath = path.join(directory, conversationFile(key))
      if (!assertSafeDataFile(filePath, label)) continue
      count += 1
      bytes += fs.lstatSync(filePath).size
    }
    if (!count) return
    const aside = path.join(directory, UNREADABLE_CHAT_DIRECTORY)
    if (fs.existsSync(aside)) {
      ensureSafeDataDirectory(aside, label)
      const entries = await readDirectoryEntries(aside, MAX_UNREADABLE_CHAT_FILES, label)
      count += entries.length
      for (const entry of entries) bytes += fs.lstatSync(path.join(aside, entry.name)).size
    }
    if (count > MAX_UNREADABLE_CHAT_FILES || bytes > maxTotalBytes) throw new Error('读不出来的聊天对话留得太多，本次没有保存')
  }

  // A rename keeps the bytes exactly as they were. The folder is checked to be a
  // plain directory and the source a single-link regular file right before every
  // attempt (I8), and an earlier copy is never replaced: lstat, so a planted link
  // counts as taken too.
  async function moveAside(directory: string, key: string): Promise<void> {
    const source = path.join(directory, conversationFile(key))
    const aside = path.join(directory, UNREADABLE_CHAT_DIRECTORY)
    ensureSafeDataDirectory(aside, label)
    if (!assertSafeDataFile(source, label)) return
    const stamp = Date.now()
    let attempt = 0
    while (pathTaken(path.join(aside, unreadableFile(key, stamp, attempt)))) {
      attempt += 1
      if (attempt > MAX_UNREADABLE_CHAT_FILES) throw new Error('读不出来的聊天对话没能挪走')
    }
    const target = path.join(aside, unreadableFile(key, stamp, attempt))
    await renameWithTransientRetry(source, target, () => {
      ensureSafeDataDirectory(aside, label)
      if (!assertSafeDataFile(source, label) || pathTaken(target)) throw new Error('读不出来的聊天对话没能挪走')
    })
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
