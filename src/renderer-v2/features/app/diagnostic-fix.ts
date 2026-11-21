import type { DiagnosticFixKind, DiagnosticFixResult } from '../../../../electron/ipc-contract'

type DetailValue = boolean | number | string | null

/**
 * 检查页那一行能不能「点这里就好」：主进程只在真能处理时往 details 里放 fix
 * （Codex 文件夹里有额外设置；Windows 上当前账号下设了能删的工具地址或密钥；
 * 个人文件夹里有一份星芒早先放、客户没改过的项目说明）。
 */
export function diagnosticFixKind(item: { code: string; state: string; details?: Record<string, DetailValue> }): DiagnosticFixKind | null {
  if (item.state === 'pass') return null
  const fix = item.details?.fix
  if (item.code === 'CODEX_DOTENV' && fix === 'set-aside-codex-dotenv') return fix
  if (item.code === 'PROVIDER_ENVIRONMENT_OVERRIDE' && fix === 'clear-user-overrides') return fix
  if (item.code === 'HOME_FOLDER_LEFTOVERS' && fix === 'set-aside-home-agents-md') return fix
  return null
}

export const diagnosticFixLabels: Readonly<Record<DiagnosticFixKind, string>> = {
  'set-aside-codex-dotenv': '停用此设置',
  'clear-user-overrides': '删除这些设置',
  'set-aside-home-agents-md': '停用此说明',
}

export function diagnosticFixLabel(item: Parameters<typeof diagnosticFixKind>[0]): string | null {
  const kind = diagnosticFixKind(item)
  return kind ? diagnosticFixLabels[kind] : null
}

export const diagnosticFixConfirm: Readonly<Record<DiagnosticFixKind, { title: string; body: string; ok: string }>> = {
  'set-aside-codex-dotenv': {
    title: '是否停用 Codex 的额外设置？',
    body: '该文件将重命名并保留在原文件夹中，不会删除。停用后 Codex 将使用当前账号连接。如需恢复，将文件名改回即可。',
    ok: '停用',
  },
  'clear-user-overrides': {
    title: '是否删除这些设置？',
    body: '将删除当前 Windows 用户下单独设置的工具地址和密钥，系统级设置不受影响。删除后，依赖这些设置连接其他服务的方式将失效，从星芒打开的工具将使用当前账号。已打开的命令行窗口需关闭后重新打开。',
    ok: '删除',
  },
  'set-aside-home-agents-md': {
    title: '是否停用此项目说明？',
    body: '该文件将重命名并保留在个人文件夹中，不会删除。停用后，工具仅读取各项目自身的说明。如需恢复，将文件名改回 AGENTS.md 即可。',
    ok: '停用',
  },
}

export function diagnosticFixMessage(result: DiagnosticFixResult): string {
  if (result.kind === 'set-aside-codex-dotenv')
    return result.fixed ? '已停用，Codex 将使用当前账号连接。' : '无需处理：该设置已不存在。'
  if (result.kind === 'set-aside-home-agents-md')
    return result.fixed ? '已停用。' : '无需处理：该说明已不存在。'
  if (result.fixed)
    return result.machineRemaining
      ? '已删除当前用户下的相关设置。系统级仍存在相同设置，需管理员权限修改，请在「反馈与客服」页导出报告并发送给客服。'
      : '已删除。请关闭已打开的命令行窗口后重新打开工具。'
  return result.machineRemaining
    ? '这些为系统级设置，需管理员权限修改，请在「反馈与客服」页导出报告并发送给客服。'
    : '无需处理：这些设置已不存在。'
}
