import { resolveDefaultCliModel } from '../../../../electron/cli-model-defaults'
import type { AccountKey, AppConfigSummary, ExternalToolId, ProviderId } from '../../../../electron/ipc-contract'

type Providers = AppConfigSummary['providers']

/**
 * 这个型号放进这个客户端拿不拿得准。Claude Desktop 走的是 Claude 那条接口，只认 Claude 型号；
 * WorkBuddy、OpenCode 不挑。
 */
export function modelFitsClient(tool: ExternalToolId, model: string): boolean {
  return tool !== 'claudeDesktop' || /claude/i.test(model)
}

/** 本机配着当前账号密钥的工具，客户端自己那一家排最前（Claude Desktop 先列 Claude Code）。 */
export function configuredKeySources<T extends { id: ProviderId }>(sources: readonly T[], preferred: ProviderId, providers: Providers | null): T[] {
  const usable = sources.filter((item) => providers?.[item.id].hasApiKey && providers[item.id].matchesRelay)
  return [...usable.filter((item) => item.id === preferred), ...usable.filter((item) => item.id !== preferred)]
}

/**
 * 打开弹窗时默认选哪把密钥：先用客户端自己那一家工具的；它没配当前账号时，Claude Desktop 先找账号里
 * 挂在 Claude 分组的那把，再轮到别的工具。Codex 的密钥只能用 GPT 型号，排在前面就会让 Claude Desktop
 * 默认配上 GPT 型号（yoyo 10-16 在 0.2.19 测试包里看到默认成了 gpt-6.1-sol）。
 */
export function initialClientSource(
  tool: ExternalToolId,
  preferred: ProviderId,
  sources: readonly { id: ProviderId }[],
  providers: Providers | null,
  keys: readonly Pick<AccountKey, 'id' | 'group'>[],
): string {
  const configured = configuredKeySources(sources, preferred, providers)
  if (configured[0]?.id === preferred) return `configured:${preferred}`
  const claudeKey = tool === 'claudeDesktop' ? keys.find((key) => /claude/i.test(key.group)) : undefined
  if (claudeKey) return `account:${claudeKey.id}`
  if (configured[0]) return `configured:${configured[0].id}`
  return keys.length ? `account:${keys[0].id}` : 'manual'
}

/** 选「使用某工具当前的密钥」时先填那个工具自己配着的型号；不合这个客户端的不填，检测完再挑。 */
export function configuredSourceModel(tool: ExternalToolId, source: string, providers: Providers | null): string {
  if (!source.startsWith('configured:') || !providers) return ''
  const model = providers[source.slice(11) as ProviderId]?.model ?? ''
  return modelFitsClient(tool, model) ? model : ''
}

/**
 * 检测完替用户选哪个型号。原来就填着、这把密钥也能用、又合这个客户端的，留着；Claude Desktop 退一步在
 * 列表里的 Claude 型号里按 Claude Code 那套挑（默认、上一代、同系列，再 Opus > Sonnet > Haiku），不按字母序
 * 拿第一个，那会挑到 Haiku（#1154）。都不成就是 null：界面先摆第一项，但不替他保存，让他自己挑。
 */
export function detectedClientModel(tool: ExternalToolId, current: string, values: readonly string[]): string | null {
  if (current && values.includes(current) && modelFitsClient(tool, current)) return current
  if (tool !== 'claudeDesktop') return null
  return resolveDefaultCliModel('claude', values.filter((id) => modelFitsClient(tool, id)), current || undefined)
}
