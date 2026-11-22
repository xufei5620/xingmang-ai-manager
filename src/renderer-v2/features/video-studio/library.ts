import type { VideoStudioProjectFile, VideoStudioProjectsSnapshot, VideoStudioProjectsWrite, XingmangApi } from '../../../../electron/ipc-contract'
import {
  isVideoStudioProjectEmpty,
  restoreVideoStudioDrafts,
  restoreVideoStudioProject,
  serializeVideoStudioProject,
  videoStudioDraftName,
  videoStudioDraftsStorageKey,
  videoStudioStorageKey,
  type VideoStudioProject,
} from './project'

// 做过的视频：一条视频一个文件，放在主进程管的用户数据目录里（electron/video-studio-project-store.ts，总单 #79）。
// 这里全是纯计算：文件里写什么、读回来怎么认、老版本存在 localStorage 里的那几份怎么抄过来。读写在 useVideoStudioLibrary 里发。

/** 「创作」左边那一列里的一条视频。 */
export interface VideoStudioItem {
  id: string
  /** 客户自己起的名字；没起的叫什么见 videoStudioItemName。 */
  name?: string
  /** 最后一次动它的时间（毫秒），列表按它排、按它分「今天」「昨天」「更早」。 */
  updatedAt: number
  project: VideoStudioProject
}

// 与主进程 electron/video-studio-project-store.ts 的 MAX_VIDEO_STUDIO_PROJECTS 是有意重复：那边不 import src。
export const maxVideoStudioProjects = 200
export const maxVideoStudioItemNameLength = 40
// 与主进程的 KEY_PATTERN 同一个写法：编号就是文件名的一部分。
const itemIdPattern = /^[A-Za-z0-9_-]{1,64}$/
/** 老版本手头那一条抄过来以后用的编号：写死一个，抄到一半重来也还是同一个文件，不会抄出两份。 */
export const legacyCurrentVideoStudioItemId = 'legacy-current'
/**
 * index.json 只是一个记号：「老版本存在 localStorage 里的草稿已经抄过来、核对过了」。列表不靠它，靠的是目录里的每个文件，
 * 所以它丢了、坏了最多是再抄一遍（已经有的文件不会被盖掉）。
 */
export const videoStudioLibraryIndex = JSON.stringify({ version: 1, migrated: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 名字收成一行、最多 40 个字；空的就是没起名。 */
export function cleanVideoStudioItemName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1F\x7F\s]+/g, ' ').trim().slice(0, maxVideoStudioItemNameLength).trim() : ''
}

/** 列表和顶栏上叫它什么：自己起的名字，没起就用片名，再没有用想法开头那几个字；什么都还没写的是「新视频」。 */
export function videoStudioItemName(item: Pick<VideoStudioItem, 'name' | 'project'>): string {
  return item.name || (isVideoStudioProjectEmpty(item.project) ? '新视频' : videoStudioDraftName(item.project))
}

/** 存下来的那份工程（JSON 文本）：两次一样就是没有要存的改动。 */
export function videoStudioProjectContent(project: VideoStudioProject): string {
  return JSON.stringify(serializeVideoStudioProject(project))
}

export function serializeVideoStudioItem(item: VideoStudioItem): VideoStudioProjectFile {
  return {
    key: item.id,
    content: JSON.stringify({ version: 1, ...(item.name ? { name: item.name } : {}), updatedAt: item.updatedAt, project: serializeVideoStudioProject(item.project) }),
  }
}

/** 读回一个文件。编号只认文件名上的那个；内容认不出就是 null，文件原样留在盘上。 */
export function restoreVideoStudioItem(file: VideoStudioProjectFile): VideoStudioItem | null {
  if (!itemIdPattern.test(file.key)) return null
  let value: unknown
  try { value = JSON.parse(file.content) } catch { return null }
  if (!isRecord(value) || value.version !== 1) return null
  const project = restoreVideoStudioProject(value.project)
  if (!project) return null
  const name = cleanVideoStudioItemName(value.name)
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : 0
  return { id: file.key, ...(name ? { name } : {}), updatedAt, project }
}

/** 新的在前；同一时刻的按编号排，免得每次读回来先后不一样。 */
export function sortVideoStudioItems(items: readonly VideoStudioItem[]): VideoStudioItem[] {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** 读回目录里的每一条。认不出的那个不列（文件留着），别的照列。 */
export function restoreVideoStudioLibrary(files: readonly VideoStudioProjectFile[]): VideoStudioItem[] {
  const items: VideoStudioItem[] = []
  for (const file of files) {
    const item = restoreVideoStudioItem(file)
    if (item) items.push(item)
  }
  return sortVideoStudioItems(items).slice(0, maxVideoStudioProjects)
}

/**
 * 老版本（0.2.24 及以前）存在 localStorage 里的草稿：手头那一条加草稿箱里最多 20 条。只读不写、不删，
 * 退回老版本时它们原样还在。手头那一条是空的（没想法、没镜头）就不算；它没有时间，按 now 算，排在最前面，
 * 和它在老版本里「正开着」的位置一样。
 */
export function readLegacyVideoStudioDrafts(storage: Pick<Storage, 'getItem'> | null, scope: string, now: number): VideoStudioItem[] {
  if (!storage) return []
  const items: VideoStudioItem[] = []
  try {
    const raw = storage.getItem(videoStudioStorageKey(scope))
    const current = raw ? restoreVideoStudioProject(JSON.parse(raw)) : null
    if (current && !isVideoStudioProjectEmpty(current)) items.push({ id: legacyCurrentVideoStudioItemId, updatedAt: now, project: current })
  } catch {
    // 手头那一条读不出来不耽误草稿箱里的。
  }
  try {
    const raw = storage.getItem(videoStudioDraftsStorageKey(scope))
    for (const draft of raw ? restoreVideoStudioDrafts(JSON.parse(raw)) : []) {
      if (itemIdPattern.test(draft.id) && !items.some((item) => item.id === draft.id)) items.push({ id: draft.id, updatedAt: draft.savedAt, project: draft.project })
    }
  } catch {
    // 同上。
  }
  return items
}

/** 这次要抄的：老草稿里还没有对应文件的那几条。已经有文件的不碰，那份可能是抄过以后又改过的。 */
export function pendingVideoStudioMigration(legacy: readonly VideoStudioItem[], snapshot: VideoStudioProjectsSnapshot): VideoStudioItem[] {
  const stored = new Set(snapshot.projects.map((file) => file.key))
  return legacy.filter((item) => !stored.has(item.id))
}

export function videoStudioMigrationWrite(scope: string, items: readonly VideoStudioItem[]): VideoStudioProjectsWrite {
  return { scope, put: items.map(serializeVideoStudioItem), remove: [] }
}

/**
 * 抄完再读回来核对：老草稿的每一条都有文件，而且读回来的镜头数、有片段的镜头数、片名和想法都对得上。
 * 对不上就不算抄完（不写 index.json），下次打开再试。返回的是没对上的那几条的编号。
 */
export function verifyVideoStudioMigration(legacy: readonly VideoStudioItem[], snapshot: VideoStudioProjectsSnapshot): string[] {
  const stored = new Map(snapshot.projects.map((file) => [file.key, file]))
  return legacy.filter((item) => {
    const file = stored.get(item.id)
    const copy = file ? restoreVideoStudioItem(file) : null
    if (!copy) return true
    const before = item.project, after = copy.project
    return after.shots.length !== before.shots.length
      || after.shots.filter((shot) => shot.clip).length !== before.shots.filter((shot) => shot.clip).length
      || after.title !== before.title
      || after.settings.idea !== before.settings.idea
  }).map((item) => item.id)
}

export type VideoStudioLibraryBridge = Pick<XingmangApi, 'readVideoStudioProjects' | 'writeVideoStudioProjects' | 'reportRendererError'>

// 设置页「搬到新电脑」往这个账号写视频的那一会儿（transfer.ts）：「创作」这时重新挂上、读文件，要等它写完，
// 不然刚导进来的视频这一回列不出来（同聊天记录的 runHistoryImport）。
const importsInFlight = new Map<string, Promise<unknown>>()

export function runVideoStudioImport<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const run = (importsInFlight.get(scope) ?? Promise.resolve()).catch(() => undefined).then(work)
  importsInFlight.set(scope, run)
  void run.catch(() => undefined).then(() => { if (importsInFlight.get(scope) === run) importsInFlight.delete(scope) })
  return run
}

async function settleVideoStudioImports(scope: string): Promise<void> {
  for (let running = importsInFlight.get(scope); running; running = importsInFlight.get(scope)) await running.catch(() => undefined)
}

export interface LoadedVideoStudioLibrary {
  items: VideoStudioItem[]
  /** unreadable：这一次没读出来，文件原样没动，也不去抄老草稿。 */
  status: 'ready' | 'unreadable'
}

/**
 * 打开「创作」时读这个账号做过的视频。还没有「抄过了」的记号时，先把老版本存在 localStorage 里的草稿各抄一份成文件：
 * 先写文件，读回来逐条核对，对上了才写记号。哪一步没成就这一次照老的那份用（只在内存里），下次打开再抄；
 * 已经抄过去的文件不会被再盖一遍，localStorage 里那份从头到尾不删不改。
 */
export async function loadVideoStudioLibrary(bridge: VideoStudioLibraryBridge, scope: string, storage: Pick<Storage, 'getItem'> | null, now: number = Date.now()): Promise<LoadedVideoStudioLibrary> {
  await settleVideoStudioImports(scope)
  let snapshot: VideoStudioProjectsSnapshot
  try { snapshot = await bridge.readVideoStudioProjects(scope) } catch { return { items: [], status: 'unreadable' } }
  if (snapshot.index !== null) return { items: restoreVideoStudioLibrary(snapshot.projects), status: 'ready' }
  const legacy = readLegacyVideoStudioDrafts(storage, scope, now)
  const pending = pendingVideoStudioMigration(legacy, snapshot)
  try {
    let files = snapshot.projects
    if (pending.length) {
      await bridge.writeVideoStudioProjects(videoStudioMigrationWrite(scope, pending))
      const copied = await bridge.readVideoStudioProjects(scope)
      const missing = verifyVideoStudioMigration(pending, copied)
      if (missing.length) {
        // 没对上的那几个是这一次刚写的，拿掉：留着的话下次会当它们已经抄好了，不再抄。
        await bridge.writeVideoStudioProjects({ scope, put: [], remove: missing }).catch(() => undefined)
        throw new Error(`${missing.length} of ${pending.length} drafts did not read back the same`)
      }
      files = copied.projects
    }
    // 没有老草稿的账号不写这个记号，免得每个登录过的账号都白占一个目录；下次打开再看一眼 localStorage 也不费事。
    if (legacy.length) await bridge.writeVideoStudioProjects({ scope, index: videoStudioLibraryIndex, put: [], remove: [] })
    return { items: restoreVideoStudioLibrary(files), status: 'ready' }
  } catch (reason) {
    // 只进本机运行日志，不带草稿内容。
    void Promise.resolve().then(() => bridge.reportRendererError({ level: 'warn', context: 'video-studio-drafts', message: `视频草稿这一次没抄成文件，下次打开再试：${reason instanceof Error ? reason.message.slice(0, 200) : 'unknown'}` })).catch(() => undefined)
    const stored = restoreVideoStudioLibrary(snapshot.projects)
    return { items: sortVideoStudioItems([...stored, ...pending.filter((item) => !stored.some((existing) => existing.id === item.id))]), status: 'ready' }
  }
}
