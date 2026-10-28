// 主窗口业务通道的处理器：WorkBuddy、Claude Desktop、OpenCode 三个外部客户端的检测、安装、打开、切换登录。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { externalClientNames, isExternalToolId, parseDesktopAppUpdateRequest } from '../../external-client-contract'
import { runWhenOn } from '../../remote-feature-gate'
import { toolInstallOffMessage, toolLaunchOffMessage } from '../../remote-features'
import { parseExternalClientScanOptions } from '../parsers/system'
import { externalClientDetectionFailures } from './detection-failures'
import type { IpcHandlerContext } from './context'

export function registerExternalClientHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, accountService, logDetectionFailures } = ctx
  registerTrustedHandler('external-clients:scan', async (_event, force: unknown, input: unknown) => {
    if (force !== undefined && typeof force !== 'boolean') throw new Error('客户端检测参数格式错误')
    // 上次的结果只用来先把首页那几行画出来：不起盘点、不记检测失败，真的结果回来再说。
    if (parseExternalClientScanOptions(input).cachedOnly) return service.cachedExternalClients()
    const statuses = await service.scanExternalClients(force === true)
    logDetectionFailures(externalClientDetectionFailures(statuses))
    return statuses
  })
  registerTrustedHandler('external-clients:install', (_event, tool: unknown, request: unknown) => {
    if (!isExternalToolId(tool)) throw new Error('未知的外部客户端类型')
    const update = parseDesktopAppUpdateRequest(request)
    return runWhenOn(options.remoteFeatures, `install:${tool}`, toolInstallOffMessage(externalClientNames[tool]), () => (
      update ? service.installExternalClient(tool, _event.sender, update) : service.installExternalClient(tool, _event.sender)
    ))
  })
  registerTrustedHandler('external-clients:cancel-install', (_event, tool: unknown) => {
    if (!isExternalToolId(tool)) throw new Error('未知的外部客户端类型')
    const outcome = service.cancelExternalClientInstall(tool)
    options.runtimeLog.log('info', 'maintenance', 'external-client.install.cancel-requested', '收到取消外部客户端安装的请求', {
      tool,
      cancelled: outcome.cancelled,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
    return outcome
  })
  registerTrustedHandler('external-clients:launch', (_event, tool: unknown) => {
    if (!isExternalToolId(tool)) throw new Error('未知的外部客户端类型')
    return runWhenOn(options.remoteFeatures, `launch:${tool}`, toolLaunchOffMessage(externalClientNames[tool]), () => service.launchExternalClient(tool))
  })
  // 只有 Claude Desktop 有两种登录可选：WorkBuddy、OpenCode 没有官方账号这一说。
  registerTrustedHandler('external-clients:switch-source', (_event, tool: unknown, target: unknown) => {
    if (tool !== 'claudeDesktop') throw new Error('未知的外部客户端类型')
    if (target !== 'account' && target !== 'official') throw new Error('未知的账号来源')
    if (target === 'account' && !accountService.getSessionState().account?.userId) throw new Error('请先登录账号，再改用当前账号')
    const revision = accountService.getSessionRevision?.()
    const assertCurrent = () => {
      if (revision !== undefined && accountService.getSessionRevision?.() !== revision) throw new Error('账号已变化，请重新配置')
    }
    return service.switchExternalClientSource(tool, target, assertCurrent)
  })
}
