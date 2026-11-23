import type { AppSettingsV2Update, DataTransferExportResult, DataTransferImportPreview, DataTransferWorksSummary } from '../../../../electron/ipc-contract'
import { formatDownloadBytes } from '../../registry/business'
import { MAX_CONVERSATIONS } from '../chat/storage'
import { maxVideoStudioProjects } from '../video-studio/library'

// 设置页「迁移到新电脑」的说法。放在这里是为了能单测，页面只管调用。

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

// 「3 个对话、2 条视频和 128 件作品」：最后一项前面用「和」，数字前留一个空格。
function joinWithAnd(parts: readonly string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join('、')}和 ${parts[parts.length - 1]}` : parts.join('')
}

// 下面这些字是 yoyo 2026-11-22 回「搬作品改」批的。

export function dataTransferExportMessage(result: DataTransferExportResult): string {
  const parts = [
    result.conversations ? `${result.conversations} 个对话` : '',
    result.videoProjects ? `${result.videoProjects} 条视频` : '',
    result.works?.count ? `${result.works.count} 件作品` : '',
    result.works?.canvasProjects ? `${result.works.canvasProjects} 个画布项目` : '',
  ].filter(Boolean)
  const content = parts.length ? ` ${parts.join('、')}及设置` : '设置'
  if (result.works) {
    return `已保存至「${result.works.folderName}」文件夹，包含${content}。请将整个文件夹复制到新电脑，在此点击「导入」并选择其中的「星芒聊天记录与设置」文件。`
  }
  return `已保存「${fileNameOf(result.outputPath)}」，包含${content}。复制到新电脑后，请在此点击「导入」。`
}

/** 作品一共几件。 */
export function worksCount(works: DataTransferWorksSummary): number {
  return works.images + works.videos + works.audios
}

/** 询问框只在有作品、或有能导出的画布项目时出现；都没有就照旧只导聊天记录和设置。 */
export function worksExportWorthAsking(works: DataTransferWorksSummary): boolean {
  return worksCount(works) > 0 || (works.canvasProjects ?? 0) > 0
}

// 下面几句里跟画布项目有关的，是第三轮复查第 6 条贴给 yoyo 的字。

/** 询问框的标题：有画布项目时连同项目一起问。 */
export function worksExportTitle(works: DataTransferWorksSummary): string {
  return works.canvasProjects ? '是否同时导出作品和画布项目？' : '是否同时导出作品？'
}

/** 导出前询问框里报的数。画布项目报的是全部（连同找不到文件夹的），找不到的那几个另说一句。 */
export function worksExportQuestion(works: DataTransferWorksSummary): string {
  const parts = [
    works.images ? `图片 ${works.images} 张` : '',
    works.videos ? `视频片段与成片 ${works.videos} 个` : '',
    works.audios ? `配乐 ${works.audios} 首` : '',
  ].filter(Boolean)
  const unreachable = works.canvasProjectsUnreachable ?? 0
  const projects = (works.canvasProjects ?? 0) + unreachable
  const size = formatDownloadBytes(works.bytes)
  const counted = !worksCount(works)
    ? `当前账号共有画布项目 ${projects} 个，约 ${size}。`
    : projects
      ? `当前账号的作品库中共有 ${worksCount(works)} 件作品（${parts.join('、')}），另有画布项目 ${projects} 个，共约 ${size}。`
      : `当前账号的作品库中共有 ${worksCount(works)} 件作品（${parts.join('、')}），约 ${size}。`
  const missing = unreachable ? `其中 ${unreachable} 个画布项目的文件夹当前无法访问，将不会导出；如需一并导出，请先连接其所在的磁盘。` : ''
  return `${counted}${missing}`
}

export const worksExportNote = '选择「导出全部」时，将在所选位置新建一个文件夹，存放聊天记录、设置和作品。作品较多时需要几分钟，导出期间请勿关闭星芒。'
const worksAndProjectsExportNote = '选择「导出全部」时，将在所选位置新建一个文件夹，存放聊天记录、设置、作品和画布项目。作品较多时需要几分钟，导出期间请勿关闭星芒。'

/** 询问框里「导出全部」的说明。 */
export function worksExportNoteFor(works: DataTransferWorksSummary): string {
  return works.canvasProjects ? worksAndProjectsExportNote : worksExportNote
}
export const worksExportingText = '正在导出作品，请勿关闭星芒…'
export const worksImportingText = '正在导入作品，请勿关闭星芒…'

/** 主进程给的设置更新去掉 version，交给设置页的保存队列；没有要改的返回 null。 */
export function settingsPatchFrom(...updates: AppSettingsV2Update[]): Omit<AppSettingsV2Update, 'version'> | null {
  const patch: Omit<AppSettingsV2Update, 'version'> = {}
  for (const { version: _version, ...rest } of updates) Object.assign(patch, rest)
  return Object.keys(patch).length ? patch : null
}

/**
 * 这次要写的「匿名使用统计」（X-3），没有要改的返回 undefined。overwrite = 询问框里点了「使用文件中的设置」；
 * 点「保留本机设置」时这台关过的照旧关着。
 */
export function anonymousUsageFrom(
  preview: Pick<DataTransferImportPreview, 'anonymousUsage' | 'conflictingAnonymousUsage'>,
  overwrite: boolean,
): boolean | undefined {
  if (overwrite && preview.conflictingAnonymousUsage !== undefined) return preview.conflictingAnonymousUsage
  return preview.anonymousUsage
}

/** 导入作品那一步怎么样了。missing / unreadable：文件里说带了作品，旁边的「作品」文件夹没有或读不出来。 */
export type DataTransferWorksOutcome =
  | { kind: 'done'; added: number; existing: number; failed: number }
  | { kind: 'no-space'; neededBytes: number; availableBytes: number }
  | { kind: 'missing' }
  | { kind: 'unreadable'; count: number }

/**
 * 导入画布项目那一步怎么样了（跟作品一起导）。missing / unreadable：文件里说带了画布项目，旁边的「画布项目」文件夹
 * （或项目要从里面拿回作品的「作品」文件夹）没有或读不出来。no-space：空间跟作品一起估，不够就一个都没导。
 */
export type DataTransferCanvasProjectsOutcome =
  | { kind: 'done'; added: number; existing: number; full: number; failed: number }
  | { kind: 'missing' }
  | { kind: 'unreadable'; count: number }
  | { kind: 'no-space' }

export interface DataTransferImportOutcome {
  /** 文件里有几个对话。 */
  fileConversations: number
  /** 文件里有几条视频、几件作品、几个画布项目（没登录时那句话要报）。旧文件没有，当 0。 */
  fileVideos?: number
  fileWorks?: number
  fileCanvasProjects?: number
  /** 视频导进来几条（另存的也算）、这台电脑存满了放不下几条。 */
  videosAdded?: number
  videosSkipped?: number
  /** 文件里带了作品、而且登录了才有。 */
  works?: DataTransferWorksOutcome
  /** 文件里带了画布项目、而且登录了才有。 */
  canvasProjects?: DataTransferCanvasProjectsOutcome
  /** 导进来的新对话（这台电脑上已有的不算；两边各聊过、另存的那一份算）。 */
  added: number
  /** 这台电脑上已有、旧电脑上又接着聊过，换成了文件里那份的对话（设置 X-4）。 */
  updated: number
  /** 这台电脑存满 MAX_CONVERSATIONS 个对话、这次放不下的新对话。本机的对话不会为了它们被删掉。 */
  skipped: number
  signedIn: boolean
  settingsChanged: boolean
}

const deleteThenRetry = '请在「创作」中删除部分不需要的记录，再次点击「导入」。'

function videosImportMessage(added: number, skipped: number): string {
  return `${added ? `已导入 ${added} 条视频。` : ''}${skipped ? `另有 ${skipped} 条视频未导入：本机最多保存 ${maxVideoStudioProjects} 条视频，请在「创作」中删除部分不需要的视频，再次点击「导入」。` : ''}`
}

const copyWholeFolder = '请将导出的整个文件夹复制到本机后再次导入。'

function worksImportMessage(works: DataTransferWorksOutcome | undefined, projects: DataTransferCanvasProjectsOutcome | undefined): string {
  if (!works) return ''
  // 画布项目要从「作品」里拿回项目生成的作品，「作品」不在时项目也没导，并成一句说。
  const projectsToo = projects?.kind === 'missing'
  if (works.kind === 'missing') {
    return projectsToo
      ? `未在文件所在位置找到「作品」和「画布项目」文件夹，作品和画布项目未导入。${copyWholeFolder}`
      : `未在文件所在位置找到「作品」文件夹，作品未导入。${copyWholeFolder}`
  }
  if (works.kind === 'unreadable') return works.count ? `另有 ${works.count} 件作品无法读取，未导入。` : ''
  if (works.kind === 'no-space') {
    // 空间是作品和画布项目一起估的，一样都没导；项目已经导进来了（估完以后盘又被别的程序写满）时只说作品。
    const what = projects?.kind === 'no-space' ? '作品和画布项目' : '作品'
    return `${what}未导入：需要约 ${formatDownloadBytes(works.neededBytes)}，本机仅剩 ${formatDownloadBytes(works.availableBytes)}。请清理磁盘后再次点击「导入」，已导入的内容不会重复。`
  }
  const { added, existing, failed } = works
  const imported = added
    ? `已导入 ${added} 件作品${existing ? `，另有 ${existing} 件已存在于本机` : ''}。`
    : existing && !failed ? '文件中的作品均已存在于本机。' : ''
  return `${imported}${failed ? `另有 ${failed} 件作品无法读取，未导入。` : ''}`
}

function canvasProjectsImportMessage(projects: DataTransferCanvasProjectsOutcome | undefined, works: DataTransferWorksOutcome | undefined): string {
  if (!projects) return ''
  if (projects.kind === 'missing') {
    // 「作品」也没找到时，作品那句已经一起说了。
    return works?.kind === 'missing' ? '' : `未在文件所在位置找到「画布项目」文件夹，画布项目未导入。${copyWholeFolder}`
  }
  if (projects.kind === 'unreadable') return projects.count ? `另有 ${projects.count} 个画布项目无法读取，未导入。` : ''
  // 作品那句已经说了两样都没导。
  if (projects.kind === 'no-space') return ''
  const { added, existing, full, failed } = projects
  const imported = added
    ? `已导入 ${added} 个画布项目${existing ? `，另有 ${existing} 个已存在于本机` : ''}。`
    : existing && !full && !failed ? '文件中的画布项目均已存在于本机。' : ''
  return `${imported}${full ? `另有 ${full} 个画布项目未导入：本机画布项目数量已达上限，请先在画布中归档或删除部分项目，再次点击「导入」。` : ''}${failed ? `另有 ${failed} 个画布项目未能导入，请再次点击「导入」。` : ''}`
}

export function dataTransferImportMessage(outcome: DataTransferImportOutcome): string {
  const { fileConversations, fileVideos = 0, fileWorks = 0, fileCanvasProjects = 0, signedIn, settingsChanged } = outcome
  if (!signedIn && (fileConversations || fileVideos || fileWorks || fileCanvasProjects)) {
    const parts = [
      fileConversations ? `${fileConversations} 个对话` : '',
      fileVideos ? `${fileVideos} 条视频` : '',
      fileWorks ? `${fileWorks} 件作品` : '',
      fileCanvasProjects ? `${fileCanvasProjects} 个画布项目` : '',
    ].filter(Boolean)
    return `${settingsChanged ? '设置已导入。' : ''}文件中的 ${joinWithAnd(parts)}需登录后再次点击「导入」。`
  }
  const rest = [
    videosImportMessage(outcome.videosAdded ?? 0, outcome.videosSkipped ?? 0),
    worksImportMessage(outcome.works, outcome.canvasProjects),
    canvasProjectsImportMessage(outcome.canvasProjects, outcome.works),
  ].join('')
  // 文件里只有视频、作品、画布项目，设置又跟本机一样：不说「无需修改」，只说它们怎么样了。
  if (!fileConversations && !settingsChanged && (fileVideos || outcome.works || outcome.canvasProjects)) return rest || '文件中的设置与本机一致，无需修改。'
  return `${conversationsImportMessage(outcome)}${rest}`
}

function conversationsImportMessage(outcome: DataTransferImportOutcome): string {
  const { fileConversations, added, updated, skipped, settingsChanged } = outcome
  if (!fileConversations) return settingsChanged ? '已导入设置。' : '文件中的设置与本机一致，无需修改。'
  const alsoUpdated = updated ? `，另有 ${updated} 个对话已更新为文件中的内容` : ''
  if (skipped && added) {
    return `已导入 ${added} 个对话${settingsChanged ? '及设置' : ''}${alsoUpdated}。另有 ${skipped} 个未导入：本机最多保存 ${MAX_CONVERSATIONS} 个对话，${deleteThenRetry}`
  }
  if (skipped) {
    return `${settingsChanged ? '设置已导入。' : ''}${updated ? `${updated} 个对话已更新为文件中的内容。` : ''}本机已保存 ${MAX_CONVERSATIONS} 个对话（已达上限），文件中的 ${skipped} 个对话未导入。${deleteThenRetry}`
  }
  // 文件里的对话全都更新了，就没有「其余」可说。
  if (!added && updated) return `${updated} 个对话已更新为文件中的内容${updated < fileConversations ? '，其余已存在于本机' : ''}${settingsChanged ? '，设置已导入' : ''}。`
  if (!added) return `文件中的对话均已存在于本机${settingsChanged ? '，设置已导入' : ''}。`
  return `已导入 ${added} 个对话${settingsChanged ? '及设置' : ''}${alsoUpdated}。`
}
