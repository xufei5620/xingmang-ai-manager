// 主窗口业务通道的处理器：Codex 会话与各工具 AI 会话的列表、详情、导出、归档、删除。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { dialog } from 'electron'
import { resolveOpenableSessionWorkspace } from '../../session-workspace'
import { requiredString } from '../parsers/common'
import { parseProviderSessionListQuery, parseSessionId, parseSessionListQuery } from '../parsers/sessions'
import type { IpcHandlerContext } from './context'

export function registerSessionHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, externalShell, rememberExportedFile } = ctx
  registerTrustedHandler('sessions:list', (_event, query: unknown) => (
    options.sessionsService.list(parseSessionListQuery(query))
  ))
  registerTrustedHandler('sessions:detail', (_event, sessionId: unknown) => (
    options.sessionsService.detail(parseSessionId(sessionId))
  ))
  registerTrustedHandler('sessions:export', async (_event, sessionId: unknown) => {
    const id = parseSessionId(sessionId)
    const result = await dialog.showSaveDialog({
      title: '导出 Codex 会话',
      defaultPath: `codex-session-${id.slice(0, 8)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    const exported = await options.sessionsService.exportMarkdown(id, result.filePath)
    rememberExportedFile(exported.outputPath)
    return exported
  })
  registerTrustedHandler('sessions:archive', (_event, sessionId: unknown) => (
    options.sessionsService.archive(parseSessionId(sessionId))
  ))
  registerTrustedHandler('sessions:restore', (_event, sessionId: unknown) => (
    options.sessionsService.restore(parseSessionId(sessionId))
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
