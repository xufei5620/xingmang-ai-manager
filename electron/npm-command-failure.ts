// npm 命令没成功时，从命令运行器的错误里挑出给客户看的那句（#1070 第 2 步从 system-service.ts 原样搬来）。
// 装和卸载都用。npm-failure-reasons.ts 要进渲染层、碰不得 command-runner，所以这几个单放在这里。
import { CommandRunnerError, redactCommandText } from './command-runner'
import { npmDownloadTimedOutReason } from './npm-failure-reasons'

/**
 * 总时长到点和下载卡住被掐，对客户是一回事，都说这一句（渲染层按「超时」归成「下载超时」）。以前写的是
 *「下载超时，长时间没有完成，已中止」，句子里含着目录标题「下载超时」，错误框就不出提示（#1100 第1条）。
 */
export const npmDownloadTimedOutMessage = npmDownloadTimedOutReason

/**
 * CommandRunnerError keeps npm's stderr on the error object, but its message
 * only says "命令执行失败（退出码 1）：node". The renderer classifies install
 * failures by the tokens npm prints (ENOSPC, EPERM, ETIMEDOUT, certificate
 * codes), so without npm's own lines a full disk, a denied folder and a
 * dropped connection all looked the same and every one of them was sent to
 * customer support.
 *
 * The runner's generic timeout wording deliberately avoids "超时" because a
 * command running long is not always a network problem. Inside an npm install
 * it is: npm spends its time downloading, so here it is said plainly.
 */
/**
 * npm 自己退出非 0：命令运行器那句「命令执行失败（退出码 1）：npm-cli.js」看着是中文，后面接的却是 npm 的
 * 英文要点，不能当中文原话照旧上屏（#1100 第1条）。
 */
export function isNpmExitFailure(error: unknown): boolean {
  return error instanceof CommandRunnerError && error.code === 'EXIT_NON_ZERO'
}

export function describeNpmCommandFailure(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) {
    return error instanceof Error ? error.message : String(error)
  }
  if (error.code === 'TIMED_OUT') return npmDownloadTimedOutMessage
  const highlights = npmFailureHighlights(error.stderr)
  return highlights ? `${error.message}（${highlights}）` : error.message
}

/**
 * 换一个 npm 源，换的只是从哪儿下，换不了这台电脑（#1057 第 5a 条）。以前哪一步失败都记成
 * 「这个源不行」，换下一个源从头再下一遍（最长 30 分钟），下面两种最后报的还是同一个错：
 * - 盘满了（ENOSPC）：这一轮下的东西删掉以后，下一个源要写的还是那么多，哪一步报的都一样。
 * - 往正在用的工具目录里写的那一步，文件被占用或者没有权限（EBUSY、ETXTBSY、EPERM、EACCES）：
 *   下一个源写的还是那个目录，开着的工具也还开着。
 * 写进暂存目录（管理员身份、macOS、Linux）时撞上的占用不算：开着的工具用的是正在用的那份，
 * 不是这份；每个源都新建一份暂存目录，换个源照旧可能就过去了。
 * 先把正在用的工具目录复制进暂存目录的那一步不用这里判：它跟源无关，安装流程见它失败就停（#1157 第 14 条）。
 */
export function isMachineBoundNpmFailure(detail: string, writingFolderInUse: boolean): boolean {
  if (/\bENOSPC\b/.test(detail)) return true
  return writingFolderInUse && /\b(?:EBUSY|ETXTBSY|EPERM|EACCES)\b/.test(detail)
}

/**
 * 卸载不下载任何东西，所以不借上面那句「下载超时」：借过去渲染层会归成下载超时，
 * 叫客户换源重试。这里一律用命令运行器自己那句话（它刻意不说「超时」），后面接上
 * npm 的要点（EPERM、EBUSY 这些），文件被占用要靠它们才认得出来。
 */
export function describeNpmUninstallFailure(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) {
    return error instanceof Error ? error.message : String(error)
  }
  const highlights = npmFailureHighlights(error.stderr)
  return highlights ? `${error.message}（${highlights}）` : error.message
}

function npmFailureHighlights(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => !/^\s*npm (?:warn|notice|verbose|info|http|timing)\b/i.test(line))
    .map((line) => line.replace(/^\s*npm (?:error|ERR!)\s*/i, '').trim())
    // The pointer to npm's own log file names a folder under the user's
    // profile and says nothing about what went wrong.
    .filter((line) => line && !/complete log of this run/i.test(line))
  const codeLine = lines.find((line) => /^code\s+\S+$/.test(line))
  const picked = codeLine
    ? [
        codeLine.replace(/^code\s+/, ''),
        ...lines.filter((line) => line !== codeLine && !/^(?:syscall|errno|path|dest)\s/.test(line)).slice(0, 1),
      ]
    : lines.slice(-2)
  return redactCommandText(picked.map((line) => line.slice(0, 160)).join('；'))
}
