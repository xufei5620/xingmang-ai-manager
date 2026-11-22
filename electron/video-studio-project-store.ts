import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { VideoStudioProjectFile, VideoStudioProjectsSnapshot, VideoStudioProjectsWrite } from './ipc-contract'
import { readDirectoryEntries } from './bounded-directory'
import { isRecord } from './input-guards'
import { assertSafeDataFiles, ensureSafeDataDirectory, readSafeUtf8File, removeSafeDataFile, writeAtomicSafeUtf8File } from './safe-local-data'

// 视频的分镜（想法、镜头、片段编号、没等到结果的那一单的请求号）以前存在渲染层 localStorage 里：Chromium 攒几秒
// 才落盘，草稿最多 20 条，再多就存不进去（总单 #79）。现在一条视频一个文件放在用户数据目录，照聊天记录那套
// 原子写（ai-chat-history-store.ts）。这里不看文件里写了什么，内容由渲染层自己读、自己认；主进程只管
// 放在哪、多大、多少个。上限只是防止撑爆磁盘的安全阀，远高于正常用会碰到的量。
//
// 与渲染层 features/video-studio/library.ts 的 maxVideoStudioProjects（200 条）是有意重复：electron 不 import src（同 I6/I7）。
export const MAX_VIDEO_STUDIO_PROJECTS = 200
// 一条视频最多十几个镜头，每个镜头几百字，存下来几十 KB；1 MB 是它的几十倍。
export const MAX_VIDEO_STUDIO_PROJECT_FILE_BYTES = 1024 * 1024
export const MAX_VIDEO_STUDIO_PROJECTS_TOTAL_BYTES = 64 * 1024 * 1024
// 一台电脑上登录过的账号数（同聊天记录）：挡住渲染层被攻破后换着 scope 无限开新目录。
export const MAX_VIDEO_STUDIO_PROJECT_SCOPES = 64
const MAX_SCOPE_LENGTH = 256
// 200 条视频 + 索引，外加原子写入残留的临时文件，留足余量。
const MAX_DIRECTORY_ENTRIES = 1024
export const videoStudioProjectKeyPattern = /^[A-Za-z0-9_-]{1,64}$/
const KEY_PATTERN = videoStudioProjectKeyPattern
const PROJECT_FILE = /^p-([A-Za-z0-9_-]{1,64})\.json$/
const INDEX_FILE = 'index.json'
const label = '视频草稿'

export interface VideoStudioProjectStore {
  read(scope: string): Promise<VideoStudioProjectsSnapshot>
  write(input: VideoStudioProjectsWrite): Promise<void>
  /** Resolves once every write accepted so far has settled; quitting and paid submissions wait on it. */
  idle(): Promise<void>
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function parseVideoStudioProjectsScope(value: unknown): string {
  // The scope only names a directory through its hash, so it cannot traverse;
  // the bound and the control-character check keep log lines and hashes sane.
  if (typeof value !== 'string' || !value || value.length > MAX_SCOPE_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('视频草稿归属无效')
  }
  return value
}

function parseContent(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what}格式无效`)
  if (utf8Bytes(value) > MAX_VIDEO_STUDIO_PROJECT_FILE_BYTES) throw new Error(`${what}超过 ${MAX_VIDEO_STUDIO_PROJECT_FILE_BYTES / 1024 / 1024} MB，无法保存`)
  return value
}

function parseKeys(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_VIDEO_STUDIO_PROJECTS) throw new Error(`${what}无效`)
  const keys = value.map((key) => {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new Error(`${what}无效`)
    return key
  })
  if (new Set(keys).size !== keys.length) throw new Error(`${what}重复`)
  return keys
}

export function parseVideoStudioProjectsWrite(value: unknown): VideoStudioProjectsWrite {
  if (!isRecord(value)) throw new Error('视频草稿保存请求格式无效')
  const scope = parseVideoStudioProjectsScope(value.scope)
  const index = value.index === undefined ? undefined : parseContent(value.index, '视频草稿索引')
  if (!Array.isArray(value.put) || value.put.length > MAX_VIDEO_STUDIO_PROJECTS) throw new Error('视频草稿写入列表无效')
  const put = value.put.map((entry): VideoStudioProjectFile => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !KEY_PATTERN.test(entry.key)) throw new Error('视频草稿写入列表无效')
    return { key: entry.key, content: parseContent(entry.content, '单条视频草稿') }
  })
  if (new Set(put.map((entry) => entry.key)).size !== put.length) throw new Error('视频草稿写入列表重复')
  const remove = parseKeys(value.remove, '视频草稿删除列表')
  // 同一次里又写又删说不清要哪个：整个拒掉，不猜。
  if (remove.some((key) => put.some((entry) => entry.key === key))) throw new Error('视频草稿写入和删除列表冲突')
  return { scope, ...(index === undefined ? {} : { index }), put, remove }
}

// 32 hex digits keep the deepest temporary file under Windows' 260-character
// path limit even with a long user name; 128 bits is plenty to tell accounts apart.
export function videoStudioProjectsDirectoryName(scope: string): string {
  return createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 32)
}

function projectFile(key: string): string {
  return `p-${key}.json`
}

export function createVideoStudioProjectStore(options: { root: string; maxTotalBytes?: number }): VideoStudioProjectStore {
  const maxTotalBytes = options.maxTotalBytes ?? MAX_VIDEO_STUDIO_PROJECTS_TOTAL_BYTES
  const queues = new Map<string, Promise<void>>()
  const directoryOf = (scope: string) => path.join(options.root, videoStudioProjectsDirectoryName(scope))

  async function projectKeysOnDisk(directory: string): Promise<string[]> {
    const entries = await readDirectoryEntries(directory, MAX_DIRECTORY_ENTRIES, label)
    const keys: string[] = []
    for (const entry of entries) {
      const match = PROJECT_FILE.exec(entry.name)
      if (match && entry.isFile()) keys.push(match[1])
    }
    return keys
  }

  async function read(scope: string): Promise<VideoStudioProjectsSnapshot> {
    const directory = directoryOf(parseVideoStudioProjectsScope(scope))
    // A window reopened for the same account must see the save the previous
    // one sent on its way out.
    await queues.get(scope)
    // Nothing on disk yet is the normal first run (the one before copying the
    // drafts out of localStorage), not an error.
    if (!fs.existsSync(directory)) return { index: null, projects: [] }
    ensureSafeDataDirectory(directory, label)
    const index = await readSafeUtf8File(path.join(directory, INDEX_FILE), label, MAX_VIDEO_STUDIO_PROJECT_FILE_BYTES)
    let total = index === null ? 0 : utf8Bytes(index)
    const projects: VideoStudioProjectFile[] = []
    for (const key of await projectKeysOnDisk(directory)) {
      // 超过单个上限的那一个读不出来（readSafeUtf8File 抛错）：整次读取失败，页面照「暂时读不出来」处理，文件原样留着。
      const content = await readSafeUtf8File(path.join(directory, projectFile(key)), label, MAX_VIDEO_STUDIO_PROJECT_FILE_BYTES)
      if (content === null) continue
      total += utf8Bytes(content)
      if (total > maxTotalBytes) throw new Error(`视频草稿超过 ${Math.floor(maxTotalBytes / 1024 / 1024)} MB 安全上限，原始文件已保留`)
      projects.push({ key, content })
    }
    return { index, projects }
  }

  async function persist(input: VideoStudioProjectsWrite): Promise<void> {
    const directory = directoryOf(input.scope)
    if (!fs.existsSync(directory) && fs.existsSync(options.root)) {
      const scopes = await readDirectoryEntries(options.root, MAX_DIRECTORY_ENTRIES, label)
      if (scopes.length >= MAX_VIDEO_STUDIO_PROJECT_SCOPES) throw new Error('这台电脑上保存视频草稿的账号过多，本次没有保存')
    }
    ensureSafeDataDirectory(directory, label)
    // Refuse up front anything that would leave the folder over its bounds: a
    // save that lands and then cannot be read back is worse than a visible error.
    const written = new Set(input.put.map((entry) => entry.key))
    const removed = new Set(input.remove)
    const kept = (await projectKeysOnDisk(directory)).filter((key) => !written.has(key) && !removed.has(key))
    if (kept.length + written.size > MAX_VIDEO_STUDIO_PROJECTS) throw new Error(`视频草稿最多 ${MAX_VIDEO_STUDIO_PROJECTS} 条，本次没有保存`)
    let total = (input.index === undefined ? 0 : utf8Bytes(input.index)) + input.put.reduce((sum, entry) => sum + utf8Bytes(entry.content), 0)
    for (const size of assertSafeDataFiles(directory, kept.map(projectFile), label)) total += size ?? 0
    if (total > maxTotalBytes) throw new Error(`视频草稿超过 ${Math.floor(maxTotalBytes / 1024 / 1024)} MB 安全上限，本次没有保存`)
    // Projects first, index last: the index only says "the old drafts were
    // copied over", so it must not land before the copies it vouches for.
    // Deletions come last of all and only for the keys the page named: a file
    // this store does not recognise is never removed on its own.
    for (const entry of input.put) await writeAtomicSafeUtf8File(path.join(directory, projectFile(entry.key)), entry.content, label)
    if (input.index !== undefined) await writeAtomicSafeUtf8File(path.join(directory, INDEX_FILE), input.index, label)
    for (const key of input.remove) await removeSafeDataFile(path.join(directory, projectFile(key)), label)
  }

  function write(value: VideoStudioProjectsWrite): Promise<void> {
    const input = parseVideoStudioProjectsWrite(value)
    // Saves for one account run strictly in order, so an older snapshot of a
    // project can never land after a newer one.
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
