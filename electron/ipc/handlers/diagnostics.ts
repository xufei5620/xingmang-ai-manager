// 主窗口业务通道的处理器：检查页的自检、连接检查、导出诊断报告、清旧代理设置、打开文件夹、就地修复。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { dialog } from 'electron'
import os from 'node:os'
import { resolveStarterWorkspaceContainer } from '../../starter-workspace'
import { cliCatalog, isActiveProviderId, type ProviderId } from '../../catalog'
import { findAccountKeyById } from '../../account-key-quota'
import { isExternalToolId } from '../../external-client-contract'
import { ensureSafeDataDirectory, writeAtomicSafeUtf8File } from '../../safe-local-data'
import type { DiagnosticFolderTarget } from '../../diagnostics'
import { isCappedKeyUsedUp, withKeyQuotaExhausted, type ConnectionCheckResult } from '../../connection-check'
import { clearStaleUserProxyVariables } from '../../stale-proxy-environment'
import { parseDiagnosticsRunOptions } from '../parsers/system'
import type { IpcHandlerContext } from './context'

export function registerDiagnosticsHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, accountService, externalShell, rememberExportedFile } = ctx
  registerTrustedHandler('diagnostics:run', (_event, input: unknown) => options.diagnosticsService.run(parseDiagnosticsRunOptions(input)))
  registerTrustedHandler('diagnostics:export', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出脱敏诊断报告',
      defaultPath: `xingmang-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(
      result.filePath,
      options.diagnosticsService.exportLatest(),
      '诊断报告导出文件',
    )
    rememberExportedFile(result.filePath)
    return { outputPath: result.filePath }
  })
  // A used-up per-tool cap reaches the self-check as the same 401 a revoked
  // key does, and the 401 advice (rewrite the key) would sign a fresh
  // unlimited key around the cap. So a rejected key that is the one this app
  // issued for the tool is looked up in the account's key list: if it is a
  // capped key with nothing left, say so instead. Any doubt keeps the original
  // verdict -- this only ever narrows "密钥被拒绝" to its quota case.
  const explainRejectedManagedKey = async (provider: ProviderId, result: ConnectionCheckResult): Promise<ConnectionCheckResult> => {
    if (result.ok || result.layer !== 'credential' || !options.managedCliKeys || options.previewOnboarding) return result
    const userId = accountService.getSessionState().account?.userId
    if (!userId) return result
    try {
      const cached = (await options.managedCliKeys.read(userId)).find((entry) => entry.provider === provider)
      if (!cached || service.revealApiKey(provider, options.previewOnboarding) !== cached.key) return result
      const key = await findAccountKeyById((query) => accountService.listKeys(query), cached.id)
      if (accountService.getSessionState().account?.userId !== userId) return result
      return key && isCappedKeyUsedUp(key) ? withKeyQuotaExhausted(result, cliCatalog[provider].name) : result
    } catch {
      return result
    }
  }
  registerTrustedHandler('diagnostics:check-connection', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    return options.diagnosticsService.checkConnection(provider).then((result) => explainRejectedManagedKey(provider, result))
  })

  registerTrustedHandler('diagnostics:probe-codex-responses', (_event, acknowledgeBilling: unknown, expectedAccountScope: unknown) => {
    if (acknowledgeBilling !== true) throw new Error('请先勾选确认：这次检查会用当前账号的一点额度')
    if (typeof expectedAccountScope !== 'string'
      || !/^(?:xm-account|api-account):(?:guest|[1-9]\d{0,14})$/.test(expectedAccountScope)) {
      throw new Error('账号信息不对，请重新勾选确认后再检查')
    }
    if (!options.diagnosticsService.probeCodexResponses) throw new Error('这个版本还不能做 Codex 干活检查')
    return options.diagnosticsService.probeCodexResponses(expectedAccountScope)
  })

  registerTrustedHandler('diagnostics:check-external-connection', (_event, tool: unknown) => {
    if (!isExternalToolId(tool)) throw new Error('未知的外部客户端类型')
    return options.diagnosticsService.checkExternalConnection(tool)
  })
  registerTrustedHandler('diagnostics:clear-stale-proxy', () => {
    const clear = options.diagnosticsService.clearStaleProxy ?? (() => clearStaleUserProxyVariables())
    return clear()
  })
  // 下面两个认名字的函数跟整套检查在一起，开机不加载（见 bootstrap/diagnostics.ts），点到时才取。
  registerTrustedHandler('diagnostics:open-folder', async (_event, rawTarget: unknown) => {
    const { isDiagnosticFolderTarget } = await import('../../diagnostics')
    if (!isDiagnosticFolderTarget(rawTarget)) throw new Error('不认识要打开的文件夹')
    const directory = resolveDiagnosticFolder(rawTarget)
    if (directory === null) return false
    // 新项目那个容器可能还没建过（还没点过新建）：建一个空的再打开，和日志目录一样
    // 先过 I8 的检查，路径上被换成联接的会在这里被拒。
    ensureSafeDataDirectory(directory, rawTarget === 'projects' ? '项目文件夹' : 'AI 作品保存位置')
    await externalShell.openPath(directory)
    return true
  })
  registerTrustedHandler('diagnostics:fix', async (_event, rawKind: unknown) => {
    const { isDiagnosticFixKind } = await import('../../diagnostic-fixes')
    if (!isDiagnosticFixKind(rawKind)) throw new Error('不认识要处理的是哪一项')
    const fix = options.diagnosticsService.fix
    if (!fix) throw new Error('这一项暂时不能在这里处理，请在「反馈与客服」页导出报告发给客服')
    return fix(rawKind)
  })
  function resolveDiagnosticFolder(target: DiagnosticFolderTarget): string | null {
    if (target === 'ai-output') return options.aiOutputDirectory?.() ?? null
    return resolveStarterWorkspaceContainer(options.homeDirectory?.() ?? os.homedir(), process.platform)
  }
}
