import { CommandRunnerError } from './command-runner'
import { commandOutputMarker, extensionCommandFailure } from './extension-command-failure'

// 命令失败只说「执行失败（退出码 1）」等于什么都没说，真正的原因全在命令自己的
// 输出里。只取几行：这段话会直接上屏，而 CLI 失败时往往先吐一大段帮助。
// 认得出原因的行（缺 Git、连不上 GitHub、重名，extension-command-failure.ts）优先：
// Claude Code 加市场时 HTTPS、SSH 两次都试，真正的原因夹在中间，最后三行只剩
// 「Could not read from remote repository」那一段。认得出的取最短的两行，别把一整条 git 命令端上屏。
// stdout / stderr 在 CommandRunnerError 构造时已经过一道 redactCommandText（I13）。
export function commandOutputTail(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) return ''
  const recognized = [...outputLines(error.stderr), ...outputLines(error.stdout)]
    .filter((line) => extensionCommandFailure(line) !== null)
    .sort((left, right) => left.length - right.length)
  if (recognized.length) return recognized.slice(0, 2).join(' / ').slice(0, 240)
  const lines = outputLines(error.stderr.trim() || error.stdout.trim())
  if (!lines.length) return ''
  return lines.slice(-3).join(' / ').slice(0, 240)
}

function outputLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

/**
 * 装、加、删这类改动失败时交给界面的那句话：原话后面接上命令自己说的原因，错误框才认得出
 * 是哪一种（以前只剩「命令执行失败（退出码 1）」）。原来的错误挂在 cause 上，运行日志照旧记全。
 */
export function withCommandOutput(error: unknown): unknown {
  const tail = commandOutputTail(error)
  if (!tail || !(error instanceof Error)) return error
  return new Error(`${error.message}${commandOutputMarker}${tail}）`, { cause: error })
}
