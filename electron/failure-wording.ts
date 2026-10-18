import { isChineseSentence } from './chinese-sentence'

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

/** 首页点「打开」没打开时上屏那句。 */
export function toolLaunchFailureMessage(name: string, error: unknown): string {
  const detail = errorText(error).trim()
  return detail && isChineseSentence(detail) ? `未能打开 ${name}：${detail}` : `未能打开 ${name}，${loggedFailureNextStep}`
}
