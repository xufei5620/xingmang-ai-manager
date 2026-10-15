import type { ExternalToolId, ProviderId } from '../../../electron/ipc-contract'
import type { ActiveProviderId } from '../../../electron/catalog'

export const clientConnections: ReadonlyArray<{
  id: ExternalToolId
  name: string
  vendor: string
  brandIcon: string
  /** 首页卡片第二行写「命令行工具」还是「桌面应用」；OpenCode 命令行版和桌面版共用配置，照原型算命令行。 */
  kind: 'cli' | 'desktop'
  description: string
  preferredProvider: ProviderId
}> = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', brandIcon: 'WorkBuddy', kind: 'desktop', description: '腾讯 WorkBuddy 自定义模型', preferredProvider: 'codex' },
  { id: 'claudeDesktop', name: 'Claude Desktop', vendor: 'Anthropic', brandIcon: 'Claude', kind: 'desktop', description: 'Claude 桌面端第三方推理网关', preferredProvider: 'claude' },
  { id: 'opencode', name: 'OpenCode', vendor: 'OpenCode', brandIcon: 'OpenCode', kind: 'cli', description: 'OpenCode CLI 与桌面端共享配置', preferredProvider: 'codex' },
]

// 外部客户端能借用哪个工具的 Key。已下线的 CLI（Gemini）不在其中：界面不再替它做任何事。
export const clientKeySources: ReadonlyArray<{ id: ActiveProviderId; name: string }> = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'grok', name: 'Grok CLI' },
]
