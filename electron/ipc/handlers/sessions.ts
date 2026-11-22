// 主窗口业务通道的处理器：Codex 会话的归档、恢复，与各工具 AI 会话的列表、详情、导出、删除。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { dialog } from 'electron'
import { resolveOpenableSessionWorkspace } from '../../session-workspace'
import { requiredString } from '../parsers/common'
import { parseProviderSessionListQuery, parseSessionId } from '../parsers/sessions'
import type { IpcHandlerContext } from './context'

export function registerSessionHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, externalShell, rememberExportedFile } = ctx
  // 归档、恢复改的是 Codex 自己的记录，记录页那份几秒内复用的列表（R-3）等它改完就作废，
  // 免得刚归档完就搜一下，搜出来的还标着没归档。会话 ID 不对照旧当场报错，不走到这里。
  async function thenForgetListedSessions<T>(change: Promise<T>): Promise<T> {
    try {
      return await change
    } finally {
      options.providerSessionsService.invalidateListCache()
    }
  }
  registerTrustedHandler('sessions:archive', (_event, sessionId: unknown) => (
    thenForgetListedSessions(options.sessionsService.archive(parseSessionId(sessionId)))
  ))
  registerTrustedHandler('sessions:restore', (_event, sessionId: unknown) => (
    thenForgetListedSessions(options.sessionsService.restore(parseSessionId(sessionId)))
  ))
  registerTrustedHandler('provider-sessions:list', (_event, query: unknown) => (
    options.providerSessionsService.list(parseProviderSessionListQuery(query))
  ))
  registerTrustedHandler('provider-sessions:detail', (_event, sessionId: unknown) => (
    options.providerSessionsService.detail(requiredString(sessionId, '会话 ID', 256))
  ))
  registerTrustedHandler('provider-sessions:export', async (_event, sessionId: unknown) => {
    const id = requiredString(sessionId, '会话 ID', 256)
    const safeId = id.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48)
    const result = await dialog.showSaveDialog({
      title: '导出 AI 会话',
      defaultPath: `ai-session-${safeId}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    const exported = await options.providerSessionsService.exportMarkdown(id, result.filePath)
    rememberExportedFile(exported.outputPath)
    return exported
  })
  registerTrustedHandler('provider-sessions:open-directory', async (_event, sessionId: unknown) => {
    const id = requiredString(sessionId, '会话 ID', 256)
    const workspace = await options.providerSessionsService.resolveWorkspace(id)
    await externalShell.openPath(await resolveOpenableSessionWorkspace(workspace))
    return true
  })
  registerTrustedHandler('provider-sessions:delete', (_event, sessionId: unknown) => (
    options.providerSessionsService.delete(requiredString(sessionId, '会话 ID', 256))
  ))
}
