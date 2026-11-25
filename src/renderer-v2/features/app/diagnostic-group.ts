/**
 * 检查页 v4 分三组（第 10 批）：「需要处理」「可选」「正常」。
 *
 * 「可选」是没装、也不是非装不可的那几项：Python、Git、命令行工具和 Codex 桌面端没装时
 * 诊断报「需留意」，可一个只用 Claude Code 的客户不该在「需要处理」里看到 Grok CLI 没装。
 * Node.js、npm 没装照旧算要处理（主进程判成「待处理」，命令行工具都靠它们）；只有一个命令行
 * 工具都没装时主进程才把它俩降成「需留意」（reconcileNodeRuntimeWithClis），这时同样归「可选」，
 * 和首页运行环境卡的「可选 · 未安装」一致。别的「需留意」（系统代理、公司证书、被别的设置盖住……）
 * 是真要看一眼的事，仍归「需要处理」。
 *
 * 没装的命令行工具，它那一行「连接设置」报「尚无连接设置」也归「可选」：只装了 Claude Code 的客户，
 * 以前在「需要处理」里看到「Codex CLI 连接设置」「Grok CLI 连接设置」两行，状态栏却是「环境正常」。
 * Codex 那份配置 Codex 桌面端也读，桌面端装着时照旧要处理。
 */
export type DiagnosticGroup = 'problem' | 'optional' | 'ok'

export const diagnosticGroupOrder: readonly DiagnosticGroup[] = ['problem', 'optional', 'ok']

interface GroupedDiagnostic {
  code: string
  state: string
  details?: Record<string, unknown> | null
}

function optionalWhenMissing(code: string): boolean {
  return code === 'RUNTIME_NODE' || code === 'RUNTIME_NPM' || code === 'RUNTIME_PYTHON' || code === 'RUNTIME_GIT'
    || code === 'CODEX_DESKTOP' || code.startsWith('CLI_')
}

/**
 * 这一行是不是「没装的工具的连接设置」：同一次检查里这家命令行工具报了没装（Codex 还要桌面端也没装），
 * 它的配置文件也一份都没有。检测出错、配置写了一半（缺密钥、地址不对）都不算，照旧要处理。
 */
function settingsOfMissingTool(item: GroupedDiagnostic, missing: ReadonlySet<string>): boolean {
  if (!item.code.startsWith('PROVIDER_') || item.state !== 'warn' || item.details?.exists !== false) return false
  const tool = item.code.slice('PROVIDER_'.length)
  if (!missing.has(`CLI_${tool}`)) return false
  return tool !== 'CODEX' || missing.has('CODEX_DESKTOP')
}

/** 同一次检查里报了没装的那几项的编号。 */
function missingItemCodes(items: readonly GroupedDiagnostic[]): Set<string> {
  return new Set(items.filter((item) => item.details?.installed === false).map((item) => item.code))
}

export function diagnosticGroup(item: GroupedDiagnostic, missing: ReadonlySet<string> = new Set()): DiagnosticGroup {
  if (item.state === 'pass') return 'ok'
  if (item.state === 'warn' && item.details?.installed === false && optionalWhenMissing(item.code)) return 'optional'
  if (settingsOfMissingTool(item, missing)) return 'optional'
  return 'problem'
}

/** 按组分好，每组里照传进来的次序（调用方先按轻重排过）。 */
export function groupDiagnostics<T extends GroupedDiagnostic>(items: readonly T[]): Record<DiagnosticGroup, T[]> {
  const groups: Record<DiagnosticGroup, T[]> = { problem: [], optional: [], ok: [] }
  const missing = missingItemCodes(items)
  for (const item of items) groups[diagnosticGroup(item, missing)].push(item)
  return groups
}

/** 行首状态图标的无障碍名称：照用原来那三个小标的字。 */
export function diagnosticStateLabel(state: string): string {
  return state === 'pass' ? '正常' : state === 'warn' ? '需留意' : '待处理'
}
