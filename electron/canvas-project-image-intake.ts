import {
  claimCanvasDefaultProjectFolder,
  describeCanvasDefaultProjectFolderFailure,
  releaseCanvasDefaultProjectFolderTree,
} from './canvas-default-project-folder'
import type { CanvasProjectAssetContext, CanvasProjectAssetManager } from './canvas-project-asset-manager'
import { displayCanvasProjectName, type CanvasProjectStore } from './canvas-project-store'
import type { CanvasProjectImageInput, CanvasProjectImageResult } from './ipc-contract'

// 主窗口「添加到画布」（融合第 5 步的「放进画布」）。yoyo 2026-11-22 亲手打的同意原文：
// 「同意把客户在创作页点了「放进画布」的那一张图，抄一份进他选的画布项目」。范围只有这一句：
// - 只抄客户在主窗口点的那一张。入口只有主窗口的一条通道（canvas:add-project-image），画布窗口的宿主通道一条没加，
//   画布页面自己发起不了这件事，也拿不到别的图（I15）。
// - 只限图片：只经图片库读，读的时候按文件开头认 PNG、JPEG、WebP，别的读不出来。视频不抄。
// - 抄之前照图片的老规矩查：这个账号自己的、单链接的普通文件、64 MB 以内；存进项目时图片库再认一遍文件开头和大小，
//   跟客户把一张图拖进画布走的是同一个存法（storeLocalBytes），记成「导入」的素材。
// - 不收、不回任何路径。新建的项目建在哪由主进程定（「文档 › 星芒画布」），跟画布里点「新建项目」一样。
// 画布被动了手脚以后多出来的：能看到、改名、删掉项目里的这份副本（原图不受影响），仅此而已。

export const canvasProjectImageMessages = {
  projectGone: '未找到该画布项目，可能已归档或删除。',
  folderUnreachable: '该画布项目的工作文件夹当前无法访问，图片未添加。',
  unavailable: '暂时无法添加到画布，请稍后重试。',
} as const

export interface CanvasProjectImageIntakeOptions {
  projects: Pick<CanvasProjectStore, 'list' | 'create'>
  assets: Pick<CanvasProjectAssetManager, 'holderOf' | 'forProject' | 'forNewWorkspace'>
  /** 新建的项目放在它下面，一个项目一个新文件夹（canvas-default-project-folder.ts）。 */
  defaultProjectsDirectory: () => string
  /** 图已经抄进去，只是「导入」这个来源记号没写上：不算失败，记一笔。 */
  onSourceError?(error: unknown, context: { userId: number; assetId: string }): void
}

export type CanvasProjectImageIntake = (userId: number, input: CanvasProjectImageInput) => Promise<CanvasProjectImageResult>

/**
 * Puts the picture into a library as an imported material. Bytes go through the store's own header and
 * size checks; the store is content-addressed, so adding the same picture twice keeps one copy.
 */
async function storeImported(
  context: CanvasProjectAssetContext,
  userId: number,
  bytes: Buffer,
  onSourceError: CanvasProjectImageIntakeOptions['onSourceError'],
): Promise<string> {
  const stored = await context.images.storeLocalBytes(userId, bytes)
  // setSource also takes a copy that sat in the project's bin back out of it: the user has just asked for it.
  await context.media.setSource(userId, stored.assetId, 'imported').catch((error) => onSourceError?.(error, { userId, assetId: stored.assetId }))
  return stored.assetId
}

/** Whether this library already keeps the picture under the same id (its own work, or a library the project shares). */
async function alreadyHolds(context: CanvasProjectAssetContext, userId: number, assetId: string): Promise<boolean> {
  try {
    await context.images.resolveOwnedFilePath(userId, assetId)
    return true
  } catch {
    return false
  }
}

export function createCanvasProjectImageIntake(options: CanvasProjectImageIntakeOptions): CanvasProjectImageIntake {
  async function intoNewProject(userId: number, name: string, bytes: Buffer): Promise<CanvasProjectImageResult> {
    let directory: string
    try {
      directory = claimCanvasDefaultProjectFolder(options.defaultProjectsDirectory(), name)
    } catch (error) {
      throw new Error(`无法在「星芒画布」文件夹中新建项目（${describeCanvasDefaultProjectFolderFailure(error)}），图片未添加。请在画布中新建项目后重试。`)
    }
    // 图先放进新文件夹，最后才登记项目（跟导入项目包一样）：中途出错就把刚放进去的图和空文件夹收走，
    // 项目中心里不会多出一个空项目。
    let context: CanvasProjectAssetContext | undefined
    let storedAssetId: string | undefined
    try {
      context = options.assets.forNewWorkspace(directory)
      storedAssetId = (await context.images.storeLocalBytes(userId, bytes)).assetId
      const created = await options.projects.create(userId, name, directory)
      const assetId = storedAssetId
      await context.media.setSource(userId, assetId, 'imported').catch((error) => options.onSourceError?.(error, { userId, assetId }))
      return { projectId: created.project.id, projectName: displayCanvasProjectName(created.project.name), created: true }
    } catch (error) {
      if (context && storedAssetId) await context.images.removeOwned(userId, storedAssetId).catch(() => undefined)
      releaseCanvasDefaultProjectFolderTree(directory)
      throw error
    }
  }

  return async function addImageToCanvasProject(userId, input) {
    // 先读图：读不出来（不是这个账号的、文件没了、不是图片）就到此为止，不去碰任何项目。
    const holder = await options.assets.holderOf(userId, 'image', input.assetId)
    const { bytes } = await holder.images.readOwned(userId, input.assetId)
    if ('newProjectName' in input) return intoNewProject(userId, input.newProjectName, bytes)

    // 项目编号是主窗口给的：在这个账号没归档的项目里找到才用（I5）。
    const project = (await options.projects.list(userId)).find((entry) => entry.id === input.projectId && !entry.archivedAt)
    if (!project) throw new Error(canvasProjectImageMessages.projectGone)
    let target: CanvasProjectAssetContext
    try {
      target = await options.assets.forProject(userId, project.id)
    } catch {
      // 工作文件夹在移动硬盘上、被挪走了：报的是系统的话和路径，换成一句能上屏的。
      throw new Error(canvasProjectImageMessages.folderUnreachable)
    }
    // 项目的素材库里已经有这一张（它自己生成的，或者没有自己文件夹的老项目，素材库就是这个账号的作品库）：
    // 不再抄第二份；在回收站里的话拿出来，客户刚点了要它。
    if (target === holder || await alreadyHolds(target, userId, input.assetId)) {
      if ((await target.metadata.getAll(userId))[input.assetId]?.deletedAt) await target.media.restore(userId, input.assetId)
    } else {
      await storeImported(target, userId, bytes, options.onSourceError)
    }
    return { projectId: project.id, projectName: displayCanvasProjectName(project.name), created: false }
  }
}
