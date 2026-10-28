// 主窗口业务通道的处理器：运行日志、反馈报告的预览复制导出、定位导出的文件、渲染层报错。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { clipboard, dialog, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { ensureSafeDataDirectory, writeAtomicSafeUtf8File } from '../../safe-local-data'
import { resolveRevealableExportedFile } from '../../exported-file'
import { requiredString } from '../parsers/common'
import { parseRendererError } from '../parsers/system'
import type { IpcHandlerContext } from './context'

// The preview travels whole to the renderer and into a read-only textarea.
const FEEDBACK_REPORT_MAX_LENGTH = 2_000_000

export function registerRuntimeLogHandlers(ctx: IpcHandlerContext): () => void {
  const { options, registerTrustedHandler, externalShell, exportedFiles, rememberExportedFile } = ctx
  const revealInFolder = options.revealInFolder ?? ((filePath: string) => shell.showItemInFolder(filePath))
  registerTrustedHandler('runtime-logs:list', (_event, limit: unknown) => {
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 2_000)) {
      throw new Error('日志数量格式错误')
    }
    return options.runtimeLog.snapshot(limit as number | undefined)
  })
  const feedbackPreviews = new Map<number, { id: string; text: string; entries: number; selfChecked?: boolean; expiresAt: number }>()
  const captureFeedbackPreview = async (senderId: number) => {
    const report = await options.runtimeLog.captureFeedbackReport(600, FEEDBACK_REPORT_MAX_LENGTH)
    // captureFeedbackReport already trims the oldest log lines to fit; this
    // only guards a runtime log implementation that ignored the budget.
    if (report.text.length > FEEDBACK_REPORT_MAX_LENGTH) throw new Error('反馈报告太大了，请在「反馈与客服」页的「运行日志」里点「打开日志文件夹」，把日志文件直接发给客服')
    const selfChecked = options.diagnosticsService.hasSelfCheckResult?.()
    const preview = {
      id: randomUUID(),
      ...report,
      ...(selfChecked === undefined ? {} : { selfChecked }),
      expiresAt: Date.now() + 30 * 60 * 1_000,
    }
    feedbackPreviews.delete(senderId)
    feedbackPreviews.set(senderId, preview)
    if (feedbackPreviews.size > 8) feedbackPreviews.delete(feedbackPreviews.keys().next().value!)
    return preview
  }
  // 预览开着去截图、问客服，回来超过 30 分钟再点复制/导出，以前只给一句「请重新生成」，
  // 小白不知道去哪生成。现在过期或被新预览顶掉的标识就地按最新日志重生成一份，
  // 连同新文本一起交回去让对话框换掉旧内容；只有重生成本身失败才报错。
  const resolveFeedbackPreview = async (senderId: number, id: unknown) => {
    const reportId = requiredString(id, '反馈报告标识', 64)
    const preview = feedbackPreviews.get(senderId)
    if (preview && preview.id === reportId && preview.expiresAt >= Date.now()) return { preview, regenerated: false }
    return { preview: await captureFeedbackPreview(senderId), regenerated: true }
  }
  const publicFeedbackPreview = (preview: { id: string; text: string; entries: number; selfChecked?: boolean }) => (
    {
      id: preview.id,
      text: preview.text,
      entries: preview.entries,
      ...(preview.selfChecked === undefined ? {} : { selfChecked: preview.selfChecked }),
    }
  )
  registerTrustedHandler('runtime-logs:preview-feedback', async (event) => {
    return publicFeedbackPreview(await captureFeedbackPreview(event.sender.id))
  })
  registerTrustedHandler('runtime-logs:copy-feedback', async (event, reportId?: unknown) => {
    if (reportId !== undefined) {
      const { preview, regenerated } = await resolveFeedbackPreview(event.sender.id, reportId)
      await clipboard.writeText(preview.text)
      return regenerated
        ? { entries: preview.entries, regenerated: publicFeedbackPreview(preview) }
        : { entries: preview.entries }
    }
    const [report, snapshot] = await Promise.all([
      options.runtimeLog.feedbackReport(),
      options.runtimeLog.snapshot(),
    ])
    await clipboard.writeText(report)
    return { entries: snapshot.total }
  })
  registerTrustedHandler('runtime-logs:export-feedback', async (event, reportId?: unknown) => {
    const captured = reportId !== undefined ? await resolveFeedbackPreview(event.sender.id, reportId) : undefined
    const result = await dialog.showSaveDialog({
      title: '导出反馈与诊断',
      defaultPath: `xingmang-feedback-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(
      result.filePath,
      captured?.preview.text ?? await options.runtimeLog.feedbackReport(),
      '反馈报告导出文件',
    )
    rememberExportedFile(result.filePath)
    return captured?.regenerated
      ? { outputPath: result.filePath, regenerated: publicFeedbackPreview(captured.preview) }
      : { outputPath: result.filePath }
  })
  registerTrustedHandler('exports:reveal-file', async (_event, filePath: unknown) => {
    const target = requiredString(filePath, '导出文件路径', 4_096)
    // The renderer only echoes back a path this process itself just wrote
    // through a save dialog; anything else is refused, so a compromised
    // renderer cannot point Explorer at an arbitrary location.
    if (!exportedFiles.includes(target)) throw new Error('只能定位本次打开软件后导出的文件，请重新导出一次')
    await revealInFolder(await resolveRevealableExportedFile(target))
    return true
  })
  registerTrustedHandler('runtime-logs:open-directory', async () => {
    ensureSafeDataDirectory(options.runtimeLog.directory, '运行日志目录')
    await externalShell.openPath(options.runtimeLog.directory)
    return true
  })
  registerTrustedHandler('runtime-logs:clear', () => options.runtimeLog.clear())
  registerTrustedHandler('runtime-logs:renderer-error', (_event, payload: unknown) => {
    const { level, ...error } = parseRendererError(payload)
    options.runtimeLog.log(level, 'renderer', `renderer.${level}`, error.message, {
      context: error.context ?? null,
      stack: error.stack ?? null,
    })
    // 只有真正的渲染层错误才上报崩溃：info / warn 是渲染层留给排障的决策记录，
    // 一并上报会把真正的异常淹没，也会把本该只留在本机的线索发出去。
    if (level === 'error') options.onRendererError?.(error)
  })
  return () => {
    feedbackPreviews.clear()
  }
}
