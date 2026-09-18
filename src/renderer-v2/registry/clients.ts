import type { ExternalToolId, ProviderId } from '../../../electron/ipc-contract'

export const clientConnections: ReadonlyArray<{
  id: ExternalToolId
  name: string
  vendor: string
  brandIcon: string
  description: string
  preferredProvider: ProviderId
}> = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', brandIcon: 'WorkBuddy', description: '腾讯 WorkBuddy 自定义模型', preferredProvider: 'codex' },
  { id: 'claudeDesktop', name: 'Claude Desktop', vendor: 'Anthropic', brandIcon: 'Claude', description: 'Claude 桌面端第三方推理网关', preferredProvider: 'claude' },
  { id: 'opencode', name: 'OpenCode', vendor: 'OpenCode', brandIcon: 'OpenCode', description: 'OpenCode CLI 与桌面端共享配置', preferredProvider: 'codex' },
]

export const clientKeySources: ReadonlyArray<{ id: ProviderId; name: string }> = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'gemini', name: 'Gemini CLI' },
  { id: 'grok', name: 'Grok CLI' },
]
