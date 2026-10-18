import { isChineseSentence } from './chinese-sentence'
import { npmErrorCodeIn, npmErrorCodesClause, npmFailureReasonFor, pickNpmNextStep, type NpmFailureReason } from './npm-failure-reasons'

/**
 * 主进程交给界面的失败句里，原话是英文时换成的那几句（#1100 第1、4条）。英文原话客户看不懂，
 * 照着去搜也多半搜不到；调用点把原来的错误挂在 cause 上，运行日志照样记得到（ipc.ts 记失败时
 * 连同 cause 一起写进去）。原话本来就是中文的照旧接在后面：那是我们自己或系统写好的说法。
 */

/** 说不清是哪一类时接在句子后面的下一步：原话已经进了运行日志，点「重试」，不行就把报告发给客服。 */
export const loggedFailureNextStep = '原因已经记进运行日志。点「重试」；还不行到「反馈与客服」把报告发给客服。'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

/**
 * 留在句尾「（错误码 X）」里的那个码：Node 挂在 code 上的 errno（EPERM、ENOSPC），没有就从原话里找。
 * 界面的错误分类（磁盘满、没权限、文件被占用）靠它认。
 */
export function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code)) return code
  return npmErrorCodeIn(errorText(error))
}

/** 「（错误码 X）」；没有码就是空串。 */
export function errorCodeClause(error: unknown): string {
  const code = errorCodeOf(error)
  return code ? `（错误码 ${code}）` : ''
}

/** 首页点「打开」没打开时上屏那句。 */
export function toolLaunchFailureMessage(name: string, error: unknown): string {
  const detail = errorText(error).trim()
  return detail && isChineseSentence(detail) ? `未能打开 ${name}：${detail}` : `未能打开 ${name}，${loggedFailureNextStep}`
}

/**
 * 一个 npm 源（或一次卸载）没成时说的那一段。commandFailed：原话是 npm 自己退出非 0 时命令运行器那句
 * 「命令执行失败（退出码 1）：npm-cli.js（…英文…）」，看着是中文其实不是，认不出码就说「npm 没有装成」；
 * 别的中文原话（清单对不上、主程序包缺了、命令运行器自己那几句）照旧接在后面。
 */
export function npmSourceFailure(raw: string, options: { commandFailed: boolean; uninstall?: boolean }): NpmFailureReason {
  const known = npmFailureReasonFor(raw, options)
  if (known) return known
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!options.commandFailed && text && isChineseSentence(text)) return { reason: text.replace(/[。.]+$/, ''), code: null, kind: 'other', nextStep: null }
  return { reason: options.uninstall ? '卸载命令没有成功' : 'npm 没有装成', code: npmErrorCodeIn(raw), kind: 'other', nextStep: loggedFailureNextStep }
}

export interface NpmFailurePart {
  /** 「npm 官方源」「国内 npm 镜像」；卸载那句没有。 */
  label?: string
  reason: NpmFailureReason
}

/** 「{开头}npm 官方源：{原因}；国内 npm 镜像：{原因}（错误码 X、Y）。{下一步}」 */
export function npmFailureSentence(lead: string, parts: readonly NpmFailurePart[]): string {
  const body = parts.map(({ label, reason }) => (label ? `${label}：${reason.reason}` : reason.reason)).join('；')
  const reasons = parts.map((part) => part.reason)
  return `${lead}${body}${npmErrorCodesClause(reasons)}。${pickNpmNextStep(reasons) ?? ''}`
}
