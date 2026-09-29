/**
 * 公司的上网审计、安全软件的网页扫描、家长控制，会把自己的根证书装进这台电脑的
 * 证书库，再替换所有 HTTPS 连接的证书。星芒走 Chromium，本来就信这台电脑的证书库，
 * 所以登录、余额、聊天都正常；npm、Claude Code、Gemini CLI 是 Node 程序，默认只信
 * Node 自带的那一批根证书，于是装工具装不上、工具每次请求都失败。
 *
 * 这个模块只做两件事：给这些子进程的环境加上「也信任这台电脑的证书库」，以及在
 * 仍然失败时判断是哪一种情况，好让提示说对下一步。不读证书、不写任何文件。
 */
import type { ToolCertificateFailureKind } from './network-failure'

/**
 * Node reads this variable at startup and adds the operating system's trust
 * store to its bundled roots (nodejs/node#59276). It only ever widens trust to
 * what Chromium, and therefore this app, already trusts on the same machine.
 */
export const systemCertificateTrustVariable = 'NODE_USE_SYSTEM_CA'

/**
 * Returns a copy with the variable set, unless the environment already names
 * it in any letter case: a value the user chose (including an explicit `0`)
 * wins, and Windows would otherwise end up with two spellings of one key.
 *
 * Callers must only use this on the same-user path. `trustedCommandEnvironment`
 * strips the variable, because across an elevation boundary the current user's
 * certificate store is writable by the lower-integrity side and must not decide
 * what an administrator's npm will accept.
 */
export function withSystemCertificateTrust(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = systemCertificateTrustVariable.toLowerCase()
  if (Object.keys(env).some((name) => name.toLowerCase() === key)) return { ...env }
  return { ...env, [systemCertificateTrustVariable]: '1' }
}

interface NodeReleaseLine {
  major: number
  minor: number
}

/**
 * First release of each line that honours the environment variable. 22.15 and
 * 23.8 only had the command-line flag; 23 never received the variable and is
 * past end of life.
 */
const firstSupportingRelease: readonly NodeReleaseLine[] = [
  { major: 22, minor: 19 },
  { major: 24, minor: 6 },
]

/**
 * true / false 是确定的答案；认不出版本号时返回 null——那时不知道该怪 Node 旧，
 * 就不该叫用户去换 Node。
 */
export function nodeReadsSystemCertificates(version: string | null | undefined): boolean | null {
  const match = typeof version === 'string' ? version.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/) : null
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major >= 25) return true
  const line = firstSupportingRelease.find((release) => release.major === major)
  return line ? minor >= line.minor : false
}

/**
 * 工具那一侧报「证书被换掉」时，是哪一种情况：
 * - elevated：星芒按管理员身份在处理，为了安全不让工具信任电脑上另外装的证书；
 * - outdatedNode：电脑上的 Node.js 太旧，不认这个开关；
 * - null：开关已经生效，工具仍然不认——这台电脑自己也不信任这张证书，按「连接被
 *   证书拦截」那条原样处理。
 */
export function toolCertificateFailureKind(input: {
  trustedOnly: boolean
  nodeVersion: string | null | undefined
}): ToolCertificateFailureKind | null {
  if (input.trustedOnly) return 'elevated'
  return nodeReadsSystemCertificates(input.nodeVersion) === false ? 'outdatedNode' : null
}
