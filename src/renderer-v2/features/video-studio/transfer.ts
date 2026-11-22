import type { VideoStudioProjectFile } from '../../../../electron/ipc-contract'
import {
  maxVideoStudioItemNameLength,
  maxVideoStudioProjects,
  restoreVideoStudioItem,
  serializeVideoStudioItem,
  videoStudioItemName,
  videoStudioProjectContent,
  type VideoStudioLibraryBridge,
} from './library'

// 设置页「迁移到新电脑」里「创作」的视频那一半（「搬作品改」，yoyo 2026-11-22）。分镜是文字，跟聊天记录一起放进
// 那一份文件；视频里的片段、成片、图、配乐是作品，跟着「作品」文件夹走，编号不变，导进来就接上。
// 写之前设置页已经把「创作」卸下（chat/transfer.ts），这里只算要写哪几个文件、写进去。

/** 导出带走的：读得出来的那几条，文件原样（编号、名字、时间都不变）。认不出的不带，留在这台电脑上。 */
export function exportableVideoStudioProjects(files: readonly VideoStudioProjectFile[]): VideoStudioProjectFile[] {
  return files.filter((file) => restoreVideoStudioItem(file) !== null).slice(0, maxVideoStudioProjects)
}

// 同一条视频两边都改过时另存的那一份：编号固定，重复导入同一份文件不会越存越多（同对话的 X-4）。
const forkTail = '-imported'
const forkNameTail = '（导入）'
const maxKeyLength = 64

function forkKey(key: string, attempt: number): string {
  const tail = attempt === 1 ? forkTail : `${forkTail}-${attempt}`
  return `${key.slice(0, maxKeyLength - tail.length)}${tail}`
}

export interface VideoStudioImportPlan {
  /** 要写的文件，都是这台电脑上还没有的编号：本机的视频一条都不改。 */
  put: VideoStudioProjectFile[]
  /** 导进来的（另存的那一份也算）。 */
  added: number
  /** 这台电脑存满了、放不下的。 */
  skipped: number
}

/**
 * 编号相同、内容一样的不再写；编号相同、内容不同的另存一份，名称后面加「（导入）」，本机那份不动（「搬作品改」：
 * 同名不覆盖）。这台电脑最多存 maxVideoStudioProjects 条，放不下的算 skipped，本机的不会为了它们被删掉。
 * 文件里认不出的那几条不导。
 */
export function planVideoStudioImport(local: readonly VideoStudioProjectFile[], incoming: readonly VideoStudioProjectFile[]): VideoStudioImportPlan {
  const here = new Map(local.map((file) => [file.key, file]))
  const sameProject = (file: VideoStudioProjectFile | undefined, content: string) => {
    const item = file ? restoreVideoStudioItem(file) : null
    return item !== null && videoStudioProjectContent(item.project) === content
  }
  const put: VideoStudioProjectFile[] = []
  let skipped = 0
  for (const file of incoming) {
    const item = restoreVideoStudioItem(file)
    if (!item) continue
    const content = videoStudioProjectContent(item.project)
    let target: VideoStudioProjectFile | null = file
    if (here.has(file.key)) {
      if (sameProject(here.get(file.key), content)) continue
      target = null
      for (let attempt = 1; attempt <= maxVideoStudioProjects; attempt += 1) {
        const key = forkKey(file.key, attempt)
        if (here.has(key)) {
          if (sameProject(here.get(key), content)) break
          continue
        }
        const name = `${videoStudioItemName(item).slice(0, maxVideoStudioItemNameLength - forkNameTail.length)}${forkNameTail}`
        target = serializeVideoStudioItem({ ...item, id: key, name })
        break
      }
      if (!target) continue
    }
    if (here.size >= maxVideoStudioProjects) {
      skipped += 1
      continue
    }
    put.push(target)
    here.set(target.key, target)
  }
  return { put, added: put.length, skipped }
}

/** 读这个账号现有的视频，算好再一次写进去。读不出来就抛错，什么都不写，免得把本机的当成没有。 */
export async function importVideoStudioProjects(
  bridge: Pick<VideoStudioLibraryBridge, 'readVideoStudioProjects' | 'writeVideoStudioProjects'>,
  scope: string,
  incoming: readonly VideoStudioProjectFile[],
): Promise<{ added: number; skipped: number }> {
  if (!incoming.length) return { added: 0, skipped: 0 }
  const snapshot = await bridge.readVideoStudioProjects(scope)
  const plan = planVideoStudioImport(snapshot.projects, incoming)
  if (plan.put.length) await bridge.writeVideoStudioProjects({ scope, put: plan.put, remove: [] })
  return { added: plan.added, skipped: plan.skipped }
}
