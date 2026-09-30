import type { DiagnosticFixKind, DiagnosticFixResult } from '../../../../electron/ipc-contract'

type DetailValue = boolean | number | string | null

/**
 * 检查页那一行能不能「点这里就好」：主进程只在真能处理时往 details 里放 fix
 * （Codex 文件夹里有额外设置；Windows 上当前账号下设了能删的工具地址或密钥）。
 */
export function diagnosticFixKind(item: { code: string; state: string; details?: Record<string, DetailValue> }): DiagnosticFixKind | null {
  if (item.state === 'pass') return null
  const fix = item.details?.fix
  if (item.code === 'CODEX_DOTENV' && fix === 'set-aside-codex-dotenv') return fix
  if (item.code === 'PROVIDER_ENVIRONMENT_OVERRIDE' && fix === 'clear-user-overrides') return fix
  return null
}

export const diagnosticFixLabels: Readonly<Record<DiagnosticFixKind, string>> = {
  'set-aside-codex-dotenv': '挪开这份设置',
  'clear-user-overrides': '删掉这几项设置',
}

export function diagnosticFixLabel(item: Parameters<typeof diagnosticFixKind>[0]): string | null {
  const kind = diagnosticFixKind(item)
  return kind ? diagnosticFixLabels[kind] : null
}

export const diagnosticFixConfirm: Readonly<Record<DiagnosticFixKind, { title: string; body: string; ok: string }>> = {
  'set-aside-codex-dotenv': {
    title: '挪开 Codex 的额外设置？',
    body: '这份文件会改个名字留在原来的文件夹里，不会删掉。挪开之后 Codex 就按当前账号连接。以后想用回原来的，把名字改回去就行。',
    ok: '挪开',
  },
  'clear-user-overrides': {
    title: '删掉这几项设置？',
    body: '会删掉你这个 Windows 账号下另外设的工具地址和密钥，整台电脑的设置不会动。删掉之后，以前靠它们连别家服务的用法就不再生效；从星芒打开的工具会用当前账号。已经开着的命令行窗口要关掉重开。',
    ok: '删掉',
  },
}

export function diagnosticFixMessage(result: DiagnosticFixResult): string {
  if (result.kind === 'set-aside-codex-dotenv')
    return result.fixed ? '已经挪开。Codex 现在按当前账号连接。' : '没有要挪的了：这份设置已经不在了。'
  if (result.fixed)
    return result.machineRemaining
      ? '已经删掉你这个账号下的那几项。整台电脑还有同样的设置，要管理员才能改，请在「反馈」页导出报告发给客服。'
      : '已经删掉。关掉开着的命令行窗口再打开工具就好。'
  return result.machineRemaining
    ? '这几项是给整台电脑设的，要管理员才能改，请在「反馈」页导出报告发给客服。'
    : '没有要删的了：这几项设置已经不在了。'
}
