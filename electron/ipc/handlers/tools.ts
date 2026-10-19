// 主窗口业务通道的处理器：Node.js、Python、Git 和命令行工具、Codex 桌面端的安装、卸载、更新与状态。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { cliCatalog, isActiveProviderId } from '../../catalog'
import { isInstallCancelledError } from '../../install-cancellation'
import { parseNodeRuntimeInstallRequest } from '../parsers/system'
import { parseCliInstallVersion, parseCliUninstallOptions, parseCodexDesktopLocale } from '../parsers/tools'
import type { IpcHandlerContext } from './context'

export function registerToolHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service } = ctx
  registerTrustedHandler('runtime:install-node', async (event, rawRequest: unknown) => {
    const request = parseNodeRuntimeInstallRequest(rawRequest)
    options.runtimeLog.log('info', 'maintenance', 'runtime.node.install.started', '开始自动安装 Node.js LTS', request.reason ? { reason: request.reason } : undefined)
    try {
      const result = await service.installNodeRuntime(event.sender, request)
      options.runtimeLog.log('info', 'maintenance', 'runtime.node.install.completed', 'Node.js LTS 自动安装完成', {
        method: result.method,
        source: result.source,
        version: result.version,
        architecture: result.architecture,
        systemRestartRequired: result.systemRestartRequired,
      })
      return result
    } catch (error) {
      options.runtimeLog.exception('maintenance', 'runtime.node.install.failed', error)
      throw error
    }
  })
  registerTrustedHandler('runtime:restart-windows', async () => {
    options.runtimeLog.log('info', 'maintenance', 'runtime.windows.restart.requested', '用户请求重启 Windows 完成系统更新')
    await service.restartWindows()
  })
  registerTrustedHandler('runtime:install-python', async (event) => {
    options.runtimeLog.log('info', 'maintenance', 'runtime.python.install.started', '开始自动安装 Python 3.12')
    try {
      const result = await service.installPythonRuntime(event.sender)
      options.runtimeLog.log('info', 'maintenance', 'runtime.python.install.completed', 'Python 3.12 自动安装完成', {
        method: result.method,
        source: result.source,
        version: result.version,
        architecture: result.architecture,
      })
      return result
    } catch (error) {
      options.runtimeLog.exception('maintenance', 'runtime.python.install.failed', error)
      throw error
    }
  })
  registerTrustedHandler('runtime:install-git', async (event) => {
    options.runtimeLog.log('info', 'maintenance', 'runtime.git.install.started', '开始自动安装 Git')
    try {
      const result = await service.installGitRuntime(event.sender)
      options.runtimeLog.log('info', 'maintenance', 'runtime.git.install.completed', 'Git 自动安装完成', {
        action: result.action,
        source: result.source,
        version: result.version,
        architecture: result.architecture,
      })
      return result
    } catch (error) {
      options.runtimeLog.exception('maintenance', 'runtime.git.install.failed', error)
      throw error
    }
  })
  registerTrustedHandler('cli:install', async (event, provider: unknown, version: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    const requestedVersion = parseCliInstallVersion(version)
    const providerName = cliCatalog[provider].name
    options.runtimeLog.log('info', 'maintenance', 'cli.install.started', `开始安装或更新 ${providerName}`, {
      provider,
      ...(requestedVersion ? { requestedVersion } : {}),
    })
    try {
      await service.installCli(provider, event.sender, requestedVersion)
      options.runtimeLog.log('info', 'maintenance', 'cli.install.completed', `${providerName} 安装或更新完成`, { provider })
    } catch (error) {
      // 用户按的取消不是故障,记成 info,免得诊断导出里一片红。
      if (isInstallCancelledError(error)) {
        options.runtimeLog.log('info', 'maintenance', 'cli.install.cancelled', `${providerName} 安装已被用户取消`, { provider })
        throw error
      }
      options.runtimeLog.exception('maintenance', 'cli.install.failed', error, { provider })
      throw error
    }
  })
  registerTrustedHandler('cli:cancel-install', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    const outcome = service.cancelCliInstall(provider)
    options.runtimeLog.log('info', 'maintenance', 'cli.install.cancel-requested', `收到取消 ${cliCatalog[provider].name} 安装的请求`, {
      provider,
      cancelled: outcome.cancelled,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
    return outcome
  })
  registerTrustedHandler('cli:uninstall', async (_event, provider: unknown, input: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    const uninstallOptions = parseCliUninstallOptions(input)
    const providerName = cliCatalog[provider].name
    options.runtimeLog.log('info', 'maintenance', 'cli.uninstall.started', `开始卸载 ${providerName}`, {
      provider,
      ...(uninstallOptions.reinstall ? { reinstall: true } : {}),
    })
    try {
      const result = await service.uninstallCli(provider, uninstallOptions)
      options.runtimeLog.log('info', 'maintenance', 'cli.uninstall.completed', `${providerName} 卸载完成`, {
        provider,
        outcome: result.outcome,
        previousVersion: result.previousVersion,
        // 要客户手动清理时，安全核对的英文原话不再上屏（已知48），记在这里给客服看。
        ...(result.outcome === 'manual-required' ? { reason: result.error } : {}),
      })
      return result
    } catch (error) {
      options.runtimeLog.exception('maintenance', 'cli.uninstall.failed', error, { provider })
      throw error
    }
  })
  // 只收工具名：删哪几个文件由主进程按那次卸载自己记下的定，渲染层多传什么都不看。
  registerTrustedHandler('cli:clean-uninstall-leftovers', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    return service.cleanUninstallLeftovers(provider)
  })
  registerTrustedHandler('cli:check-update', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    return service.inspectCliUpdate(provider, true)
  })
  registerTrustedHandler('setup:codex-status', () => service.inspectCodexSetupStatus())
  registerTrustedHandler('desktop:install-codex', (event) => service.installCodexDesktop(event.sender))
  registerTrustedHandler('desktop:cancel-install-codex', () => {
    const outcome = service.cancelCodexDesktopInstall()
    options.runtimeLog.log('info', 'maintenance', 'desktop.codex.install.cancel-requested', '收到取消 Codex 桌面端安装的请求', {
      cancelled: outcome.cancelled,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
    return outcome
  })
  registerTrustedHandler('desktop:uninstall-codex', () => service.uninstallCodexDesktop())
  registerTrustedHandler('desktop:reset-codex', () => service.resetCodexDesktop())
  registerTrustedHandler('desktop:check-update-codex', () => service.inspectCodexDesktopUpdate(true))
  registerTrustedHandler('desktop:codex-status', () => service.inspectCodexDesktop())
  registerTrustedHandler('desktop:codex-locale-status', () => service.inspectCodexDesktopLocale())
  registerTrustedHandler('desktop:codex-permissions-status', () => service.inspectCodexWorkspacePermissions())
  registerTrustedHandler('desktop:trust-workspace', (event) => (
    service.trustCodexWorkspace(event.sender)
  ))
  registerTrustedHandler('desktop:set-codex-locale', (event, locale: unknown) => (
    service.setCodexDesktopLocale(parseCodexDesktopLocale(locale), event.sender)
  ))
}
