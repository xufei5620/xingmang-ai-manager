import os from 'node:os'

/**
 * 命令行工具按用户装的那几处（~/.grok/bin、~/.local/bin）挂在哪个主目录下。装、判断能不能卸、
 * 真去卸，三处都得按这一个算，不然刚装好的就被判成「不能安全卸载」（11-18 复核 D17）。
 *
 * Windows 上是个人文件夹（USERPROFILE，os.homedir() 读的也是它，command-runner.ts 给 PATH 补的
 * %USERPROFILE%\.grok\bin 也是它），不看 HOME：HOME 在 Windows 上是 Git、MSYS 那一套的约定，
 * 不少客户把它指到别的盘，可星芒替客户装 Grok、官方安装器装 Claude Code 都不跟着它走。
 * 以前判断能不能卸、真去卸时先看 HOME，一设了 HOME 就对不上刚装的那份。
 * macOS、Linux 上就是 HOME，xAI 的 npm 安装脚本和官方安装器都按它放。
 */
export function resolveCliUserHomeDirectory(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? env.USERPROFILE : env.HOME)?.trim() || os.homedir()
}
