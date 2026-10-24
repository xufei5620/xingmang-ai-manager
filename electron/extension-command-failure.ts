// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * 装插件、加外接工具失败时，命令行自己说的原因里认得出的几种。主进程据此挑出要带上屏的那几行
 * （extension-command-output.ts），错误框照同一份认法配中文标题（operation-error.ts），两边不各写一套。
 * 认法取自命令行的原话：缺 Git 和重名两句是 Claude Code 2.1 在测试机上跑出来的，连不上 GitHub 认的是
 * git 自己报网络错的说法（curl、OpenSSL、GnuTLS 那几种），并且这一行要说到 github.com。
 */
export type ExtensionCommandFailure = 'gitMissing' | 'githubUnreachable' | 'nameTaken'

/** 主进程把命令输出接在原话后面时用的开头；错误框只在带着它的话里认这几种，别处的英文不认。 */
export const commandOutputMarker = '（命令输出：'

const gitMissingPattern = /Executable not found in \$PATH: "git(?:\.exe)?"|spawn git(?:\.exe)? ENOENT|ENOENT: git\b|'git' is not recognized|\bgit: (?:command )?not found|git is not installed/i
const githubNetworkPattern = /Could not resolve host|Failed to connect to|Couldn't connect to server|Connection (?:timed out|refused|reset|was reset)|Recv failure|SSL_connect|SSL_ERROR_SYSCALL|GnuTLS recv error|early EOF|RPC failed|unexpected disconnect|Operation timed out/i
const nameTakenPattern = /\balready exists\b/i

export function extensionCommandFailure(text: string): ExtensionCommandFailure | null {
  if (gitMissingPattern.test(text)) return 'gitMissing'
  if (/github\.com/i.test(text) && githubNetworkPattern.test(text)) return 'githubUnreachable'
  if (nameTakenPattern.test(text)) return 'nameTaken'
  return null
}

/** 错误框用：只认主进程带着命令输出的那种话。 */
export function extensionCommandFailureInMessage(message: string): ExtensionCommandFailure | null {
  return message.includes(commandOutputMarker) ? extensionCommandFailure(message) : null
}
