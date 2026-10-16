/**
 * 检查页 v4 分三组（第 10 批）：「需要处理」「可选」「正常」。
 *
 * 「可选」是没装、也不是非装不可的那几项：Python、Git、命令行工具和 Codex 桌面端没装时
 * 诊断报「需留意」，可一个只用 Claude Code 的客户不该在「需要处理」里看到 Grok CLI 没装。
 * Node.js、npm 没装照旧算要处理（主进程判成「待处理」，命令行工具都靠它们）。别的「需留意」
 * （系统代理、公司证书、被别的设置盖住……）是真要看一眼的事，仍归「需要处理」。
 */
export type DiagnosticGroup = 'problem' | 'optional' | 'ok'

export const diagnosticGroupOrder: readonly DiagnosticGroup[] = ['problem', 'optional', 'ok']

interface GroupedDiagnostic {
  code: string
  state: string
  details?: Record<string, unknown> | null
}

function optionalWhenMissing(code: string): boolean {
  return code === 'RUNTIME_PYTHON' || code === 'RUNTIME_GIT' || code === 'CODEX_DESKTOP' || code.startsWith('CLI_')
}

export function diagnosticGroup(item: GroupedDiagnostic): DiagnosticGroup {
  if (item.state === 'pass') return 'ok'
  if (item.state === 'warn' && item.details?.installed === false && optionalWhenMissing(item.code)) return 'optional'
  return 'problem'
}

/** 按组分好，每组里照传进来的次序（调用方先按轻重排过）。 */
export function groupDiagnostics<T extends GroupedDiagnostic>(items: readonly T[]): Record<DiagnosticGroup, T[]> {
  const groups: Record<DiagnosticGroup, T[]> = { problem: [], optional: [], ok: [] }
  for (const item of items) groups[diagnosticGroup(item)].push(item)
  return groups
}

/** 行首状态图标的无障碍名称：照用原来那三个小标的字。 */
export function diagnosticStateLabel(state: string): string {
  return state === 'pass' ? '正常' : state === 'warn' ? '需留意' : '待处理'
}
