// 主窗口业务通道的处理器：导出这段对话、「迁移到新电脑」的导出与导入。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { writeAtomicSafeUtf8File } from '../../safe-local-data'
import { readBoundedUtf8File } from '../../bounded-file'
import {
  buildDataTransferFile,
  conversationFileName,
  dataTransferFileName,
  dataTransferFolderName,
  dataTransferReadFailureMessage,
  MAX_DATA_TRANSFER_BYTES,
  parseChatConversationExport,
  parseDataTransferExportInput,
  parseDataTransferFile,
  planPortableSettingsImport,
} from '../../data-transfer'
import { inspectWorksFolder, summarizeAccountWorks, type ParsedWorksManifest } from '../../data-transfer-works'
import { inspectCanvasProjectsFolder, type CanvasProjectsImportSource } from '../../data-transfer-canvas'
import type { DataTransferCanvasProjectsPreview, DataTransferWorksImportResult, DataTransferWorksPreview } from '../../ipc-contract'
import type { IpcHandlerContext } from './context'

export function registerDataTransferHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, rememberExportedFile, accountService } = ctx
  // 默认存到「下载」，不存桌面（D16）：Windows「受控文件夹访问」默认保护桌面、不保护下载。
  // 星芒没签名，开着它的电脑上多半不在放行名单里（推测），往桌面导出会被拦。
  function downloadsDirectory(): string {
    try {
      if (options.downloadsDirectory) return options.downloadsDirectory()
    } catch {
      // app.getPath 拿不到「下载」时退到主目录下的 Downloads，保存框里用户还能自己换。
    }
    return path.join(os.homedir(), 'Downloads')
  }
  // 「匿名使用统计」在系统界面设置那份文件里（X-3）。没接上或读的时候出错都按读不出来算：导出不带、导入不碰。
  function anonymousUsageHere(): boolean | null {
    try {
      return options.readAnonymousUsagePreference?.() ?? null
    } catch {
      return null
    }
  }
  // 作品按账号分开存，带作品的导出、导入都要先登录。
  function currentUserId(): number {
    const session = accountService.getSessionState()
    const userId = session.authenticated ? session.account?.userId : undefined
    if (!userId) throw new Error('请先登录星芒账号')
    return userId
  }
  function worksTransfer() {
    if (!options.worksTransfer) throw new Error('作品库未就绪')
    return options.worksTransfer
  }
  // 最近一次「导入」选的那份文件旁边的作品和画布项目：路径只留在这里，渲染层拿 token 来导，交不进别的位置。
  // 只认最近一次，导一次就作废。
  let pendingWorks: { token: string; folder: string; manifest: ParsedWorksManifest; canvas?: CanvasProjectsImportSource } | null = null
  registerTrustedHandler('chat-history:export-text', async (_event, input: unknown) => {
    const { title, text } = parseChatConversationExport(input)
    const result = await dialog.showSaveDialog({
      title: '导出这段对话',
      defaultPath: path.join(downloadsDirectory(), conversationFileName(title)),
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, text, '聊天对话导出文件')
    rememberExportedFile(result.filePath)
    return { outputPath: result.filePath }
  })
  // 导出前问带不带作品时报的数（「搬作品改」）。
  registerTrustedHandler('data-transfer:inspect-works', async () => {
    const session = accountService.getSessionState()
    const userId = session.authenticated ? session.account?.userId : undefined
    if (!userId) return null
    return worksTransfer().summarize(userId)
  })
  // 「迁移到新电脑」：设置由这里自己从 settings.json 和系统界面设置里挑，渲染层只交对话和视频；文件里没有 Key、
  // 密码和登录状态（data-transfer.ts）。带作品时作品是哪些由这里按当前账号找，渲染层只说要不要。
  registerTrustedHandler('data-transfer:export', async (_event, input: unknown) => {
    const exportInput = parseDataTransferExportInput(input)
    const now = new Date()
    const settings = service.readStoredConfig()
    const anonymousUsage = anonymousUsageHere()
    const counts = { conversations: exportInput.conversations.length, videoProjects: exportInput.videoProjects?.length ?? 0 }
    if (exportInput.includeWorks) {
      const userId = currentUserId()
      const transfer = worksTransfer()
      // 对话太多、一份文件放不下的，选位置之前就说。
      buildDataTransferFile(settings, exportInput, now, anonymousUsage, summarizeAccountWorks([]))
      const picked = await dialog.showOpenDialog({
        title: '选择导出位置',
        buttonLabel: '保存到此处',
        defaultPath: downloadsDirectory(),
        properties: ['openDirectory', 'createDirectory'],
      })
      const parentDirectory = picked.canceled ? undefined : picked.filePaths[0]
      if (!parentDirectory) return null
      const written = await transfer.exportTo(userId, {
        parentDirectory,
        folderName: dataTransferFolderName(now),
        dataContent: (works) => buildDataTransferFile(settings, exportInput, now, anonymousUsage, works),
      })
      // 读不了、没导出的那几件（被别的程序占着、导出途中被改过）客户那句不说，客服看日志知道。
      if (written.skipped) options.runtimeLog.log('warn', 'data-transfer', 'works.export.skipped', '有几件作品读不了，没有导出', { skipped: written.skipped })
      rememberExportedFile(written.dataFilePath)
      return {
        outputPath: written.dataFilePath,
        ...counts,
        works: { folderName: path.basename(written.folderPath), count: written.works, ...(written.canvasProjects ? { canvasProjects: written.canvasProjects } : {}) },
      }
    }
    const content = buildDataTransferFile(settings, exportInput, now, anonymousUsage)
    const result = await dialog.showSaveDialog({
      title: '导出聊天记录和设置',
      defaultPath: path.join(downloadsDirectory(), dataTransferFileName(now)),
      filters: [{ name: '星芒聊天记录与设置', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, content, '聊天记录与设置导出文件')
    rememberExportedFile(result.filePath)
    return { outputPath: result.filePath, ...counts }
  })
  // 只读、只解析，什么都不写：对话、视频交给渲染层逐条校验后合并，设置由渲染层走 settings:save（匿名使用统计
  // 走系统界面设置那条，长期嘱咐走保存嘱咐那条），改过的那几项先问用户。作品在这里只看旁边有没有「作品」文件夹、清单读不读得出来，
  // 导不导等渲染层把对话和设置弄完再走 data-transfer:import-works。
  registerTrustedHandler('data-transfer:import', async () => {
    pendingWorks = null
    const result = await dialog.showOpenDialog({
      title: '选择导出的聊天记录和设置',
      properties: ['openFile'],
      filters: [{ name: '星芒聊天记录与设置', extensions: ['json'] }],
    })
    const filePath = result.canceled ? undefined : result.filePaths[0]
    if (!filePath) return null
    let raw: string
    try {
      raw = await readBoundedUtf8File(filePath, MAX_DATA_TRANSFER_BYTES, '聊天记录与设置文件')
    } catch (error) {
      // 被占着、没权限单独说一句；太大、是链接照旧是「这不是一份能导入的文件」。原话挂在 cause 上进运行日志。
      throw new Error(dataTransferReadFailureMessage(error), { cause: error })
    }
    const parsed = parseDataTransferFile(raw)
    let works: DataTransferWorksPreview | undefined
    let canvasProjects: DataTransferCanvasProjectsPreview | undefined
    if (parsed.works) {
      // 画布项目要从「作品」里拿回项目生成的作品，「作品」不在时项目也导不了，报跟它一样的样子。
      const expectedProjects = parsed.works.canvasProjects ?? 0
      const inspection = await inspectWorksFolder(filePath)
      if (inspection.state === 'ready') {
        const projects = expectedProjects ? await inspectCanvasProjectsFolder(filePath) : undefined
        const canvas = projects?.state === 'ready' ? { folder: projects.folder, manifest: projects.manifest } : undefined
        pendingWorks = { token: randomUUID(), folder: inspection.folder, manifest: inspection.manifest, ...(canvas ? { canvas } : {}) }
        works = { ...summarizeAccountWorks(inspection.manifest.files), state: 'ready', token: pendingWorks.token }
        if (canvas) canvasProjects = { count: canvas.manifest.projects.length, state: 'ready' }
        else if (projects && projects.state !== 'ready') canvasProjects = { count: expectedProjects, state: projects.state }
      } else {
        works = { ...parsed.works, state: inspection.state }
        if (expectedProjects) canvasProjects = { count: expectedProjects, state: inspection.state }
      }
    }
    const stored = service.readStoredConfig()
    return {
      conversations: parsed.conversations,
      phrases: parsed.phrases,
      ...planPortableSettingsImport(stored, parsed.settings, { here: anonymousUsageHere(), incoming: parsed.anonymousUsage }, {
        here: stored.standingInstructions ?? '',
        ...(parsed.standingInstructions ? { incoming: parsed.standingInstructions } : {}),
      }),
      ...(parsed.videoProjects.length ? { videoProjects: parsed.videoProjects } : {}),
      ...(works ? { works } : {}),
      ...(canvasProjects ? { canvasProjects } : {}),
    }
  })
  // 本机已有的同名作品不覆盖（「搬作品改」）；空间不够一件都不导，告诉渲染层差多少。
  registerTrustedHandler('data-transfer:import-works', async (_event, token: unknown): Promise<DataTransferWorksImportResult> => {
    const pending = pendingWorks
    if (typeof token !== 'string' || !pending || pending.token !== token) throw new Error('请再次点击「导入」。')
    const userId = currentUserId()
    pendingWorks = null
    const result = await worksTransfer().importFrom(userId, pending.folder, pending.manifest, pending.canvas)
    // 画布项目几个没进来、为什么，客户那句只说个数，客服看日志知道是哪一类。
    if (result.canvasProjects && (result.canvasProjects.full || result.canvasProjects.failed)) {
      options.runtimeLog.log('warn', 'data-transfer', 'works.import.canvas-projects', '有几个画布项目没有导入', { ...result.canvasProjects })
    }
    if (result.status === 'no-space') return result
    if (result.metadataFailed) options.runtimeLog.log('warn', 'data-transfer', 'works.import.metadata-failed', '作品已导入，名字、标签没带上')
    return {
      status: 'done',
      added: result.added,
      existing: result.existing,
      failed: result.failed,
      ...(result.canvasProjects ? { canvasProjects: result.canvasProjects } : {}),
    }
  })
}
