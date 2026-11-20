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

type ClientKey = Pick<AccountKey, 'id' | 'group'> & { name?: string }

/**
 * Claude Desktop 在账号里挑哪把：先挑星芒替 Claude Code 签的那个分组里的（同名的那把最先），没有再挑别的
 * 分组名带 Claude 的。只看分组名会挑到账号里最新的那把，可能是 8 月 AI 对话在别的 Claude 分组里签的，
 * 那个分组后来关了，一检测就 403（2026-11-19 yoyo 看到默认成了 Claude-ANTI 那把）。
 */
function claudeDesktopAccountKey(keys: readonly ClientKey[], claudeCode: { name: string; group: string } | null): ClientKey | undefined {
  const own = claudeCode
    ? keys.find((key) => key.name === claudeCode.name && key.group === claudeCode.group) ?? keys.find((key) => key.group === claudeCode.group)
    : undefined
  return own ?? keys.find((key) => /claude/i.test(key.group))
}

/**
 * 打开弹窗时默认选哪把密钥：先用客户端自己那一家工具的；它没配当前账号时，Claude Desktop 先找账号里
 * 挂在 Claude 分组的那把（claudeCode 是星芒替 Claude Code 签密钥用的名字和分组，先挑它），再轮到别的工具。
 * Codex 的密钥只能用 GPT 型号，排在前面就会让 Claude Desktop 默认配上 GPT 型号（yoyo 10-16 在 0.2.19
 * 测试包里看到默认成了 gpt-6.1-sol）。claudeCode 缺省 = 只按分组名挑（旧行为）。
 */
export function initialClientSource(
  tool: ExternalToolId,
  preferred: ProviderId,
  sources: readonly { id: ProviderId }[],
  providers: Providers | null,
  keys: readonly ClientKey[],
  claudeCode: { name: string; group: string } | null = null,
): string {
  const configured = configuredKeySources(sources, preferred, providers)
  if (configured[0]?.id === preferred) return `configured:${preferred}`
  const claudeKey = tool === 'claudeDesktop' ? claudeDesktopAccountKey(keys, claudeCode) : undefined
  if (claudeKey) return `account:${claudeKey.id}`
  if (configured[0]) return `configured:${configured[0].id}`
  return keys.length ? `account:${keys[0].id}` : 'manual'
}

/**
 * 检测时这把密钥的分组被拒了（账号已经用不了），「换一把能用的」换成哪把：照打开时的挑法再挑一次，跳过这把和同一分组里的
 * （同一分组的一样被拒）；借工具那把被拒的，跳过那个工具。挑出来还是它、或者只剩「自己填写」，就是 null，界面改叫他去
 * 「访问密钥」里换。
 */
export function alternativeClientSource(
  tool: ExternalToolId,
  preferred: ProviderId,
  sources: readonly { id: ProviderId }[],
  providers: Providers | null,
  keys: readonly ClientKey[],
  claudeCode: { name: string; group: string } | null,
  failed: string,
): string | null {
  const failedKey = keys.find((key) => `account:${key.id}` === failed)
  const remaining = keys.filter((key) => key !== failedKey && (!failedKey?.group || key.group !== failedKey.group))
  const failedTool = failed.startsWith('configured:') ? failed.slice(11) : null
  const next = initialClientSource(tool, preferred, sources.filter((source) => source.id !== failedTool), providers, remaining, claudeCode)
  return next === failed || next === 'manual' ? null : next
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
