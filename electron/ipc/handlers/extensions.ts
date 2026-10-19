// 主窗口业务通道的处理器：MCP、Skill、插件、插件市场和各工具扩展页。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { cliCatalog, isActiveProviderId } from '../../catalog'
import type { ProviderExtensionsSnapshot } from '../../provider-extensions'
import { optionalString, requiredString } from '../parsers/common'
import { parseMarketplaceInput, parseMcpInput, parseProviderExtensionMutation, parseSkillInput } from '../parsers/extensions'
import type { IpcHandlerContext } from './context'

export function registerExtensionHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler } = ctx
  registerTrustedHandler('mcp:list', () => options.extensionService.listMcpServers())
  registerTrustedHandler('mcp:add', (_event, input: unknown) => (
    options.extensionService.addMcpServer(parseMcpInput(input))
  ))
  registerTrustedHandler('mcp:remove', (_event, name: unknown) => (
    options.extensionService.removeMcpServer(requiredString(name, 'MCP 名称', 128))
  ))
  registerTrustedHandler('mcp:login', (_event, name: unknown) => (
    options.extensionService.loginMcpServer(requiredString(name, 'MCP 名称', 128))
  ))
  registerTrustedHandler('mcp:cancel-login', (_event, name: unknown) => (
    options.extensionService.cancelMcpLogin(requiredString(name, 'MCP 名称', 128))
  ))
  registerTrustedHandler('mcp:logout', (_event, name: unknown) => (
    options.extensionService.logoutMcpServer(requiredString(name, 'MCP 名称', 128))
  ))
  registerTrustedHandler('skills:list', () => options.extensionService.listSkills())
  registerTrustedHandler('skills:import', (_event, input: unknown) => (
    options.extensionService.importSkill(parseSkillInput(input))
  ))
  registerTrustedHandler('skills:toggle', (_event, skillPath: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Skill 状态格式错误')
    return options.extensionService.setSkillEnabled(requiredString(skillPath, 'Skill 路径', 32_767), enabled)
  })
  registerTrustedHandler('skills:uninstall', (_event, skillPath: unknown) => (
    options.extensionService.uninstallSkill(requiredString(skillPath, 'Skill 路径', 32_767))
  ))
  registerTrustedHandler('plugins:list', () => options.extensionService.listPlugins())
  registerTrustedHandler('plugins:add', (_event, selector: unknown) => (
    options.extensionService.addPlugin(requiredString(selector, 'Plugin ID', 256))
  ))
  registerTrustedHandler('plugins:remove', (_event, selector: unknown) => (
    options.extensionService.removePlugin(requiredString(selector, 'Plugin ID', 256))
  ))
  registerTrustedHandler('plugins:toggle', (_event, selector: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Plugin 状态格式错误')
    return options.extensionService.setPluginEnabled(requiredString(selector, 'Plugin ID', 256), enabled)
  })
  registerTrustedHandler('marketplaces:add', (_event, input: unknown) => (
    options.extensionService.addMarketplace(parseMarketplaceInput(input))
  ))
  registerTrustedHandler('marketplaces:upgrade', (_event, name: unknown) => (
    options.extensionService.upgradeMarketplace(optionalString(name, '市场名称', 256))
  ))
  registerTrustedHandler('marketplaces:remove', (_event, name: unknown) => (
    options.extensionService.removeMarketplace(requiredString(name, '市场名称', 256))
  ))
  const recordExtensionWarnings = (snapshot: ProviderExtensionsSnapshot): ProviderExtensionsSnapshot => {
    if (snapshot.warnings.length > 0) {
      options.runtimeLog.log(
        'warn',
        'extensions',
        'list.degraded',
        `${cliCatalog[snapshot.provider].name} 扩展列表部分读取失败：${snapshot.warnings.join('；')}`,
        {
          provider: snapshot.provider,
          unavailable: Object.entries(snapshot.capabilities)
            .filter(([, capability]) => !capability.list)
            .map(([kind, capability]) => ({ kind, reason: capability.reason })),
        },
      )
    }
    return snapshot
  }
  registerTrustedHandler('extensions:list', async (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 AI 工具')
    return recordExtensionWarnings(await options.providerExtensionService.list(provider))
  })
  registerTrustedHandler('extensions:list-all', async () => {
    const snapshots = await options.providerExtensionService.listAll()
    return snapshots.map(recordExtensionWarnings)
  })
  registerTrustedHandler('extensions:mutate', (_event, input: unknown) => (
    options.providerExtensionService.mutate(parseProviderExtensionMutation(input))
  ))
  registerTrustedHandler('extensions:ensure-marketplace', async (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 AI 工具')
    return recordExtensionWarnings(await options.providerExtensionService.ensureMarketplace(provider))
  })
  registerTrustedHandler('extensions:check-mcp-health', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 AI 工具')
    return options.providerExtensionService.checkMcpHealth(provider)
  })
  registerTrustedHandler('extensions:choose-directory', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '选择允许 AI 读写的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })
}
