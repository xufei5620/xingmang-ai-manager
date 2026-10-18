// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

interface ParsedVersion {
  numbers: [number, number, number]
  prerelease: string | null
}

/** Exact registry versions, never npm ranges, tags or command-line options. */
export function isExactCliVersion(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,126})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,126})?$/.test(value)
}

/** Supported CLI packages require Node.js 20 or newer. */
export const minimumSupportedNodeVersion = Object.freeze({ major: 20, minor: 0, patch: 0 })

export interface NodeVersion {
  major: number
  minor: number
  patch: number
}

export type NodeVersionStatus = 'supported' | 'too-old' | 'unknown'

export function parseNodeVersion(value: string | null): NodeVersion | null {
  if (!value) return null
  const match = value.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function nodeVersionStatus(value: string | null): NodeVersionStatus {
  const parsed = parseNodeVersion(value)
  if (!parsed) return 'unknown'
  const minimum = minimumSupportedNodeVersion
  return compareVersionNumbers([parsed.major, parsed.minor, parsed.patch], [minimum.major, minimum.minor, minimum.patch]) >= 0
    ? 'supported'
    : 'too-old'
}

/**
 * 主进程里判断版本新旧都用这一个函数：逐段比两组版本数字，左边新返回正数、右边新返回负数、
 * 一样返回 0，返回值是第一处不同那一段的差。
 *
 * 各处认什么写法不一样，那是各自的来源定的（npm 和 CLI 输出、本程序的更新目录、上次运行记录、
 * nodejs.org、python.org），由这个文件里各个 parse*Version 分别认，名字写明是哪一处的。
 * 摆在一起是为了差别看得见：改哪一种认法，都会改变那一处客户看到的结果，所以只照那一处的
 * 来源改，不要顺手拉齐。
 */
export function compareVersionNumbers(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/** 两边按同一种认法读出来再比新旧；任一边认不出返回 null。 */
export function compareVersionsBy(
  parse: (value: string) => readonly number[] | null,
  left: string,
  right: string,
): number | null {
  const leftNumbers = parse(left)
  const rightNumbers = parse(right)
  if (!leftNumbers || !rightNumbers) return null
  return compareVersionNumbers(leftNumbers, rightNumbers)
}

/**
 * 本程序自己的版本（运行中的版本、更新目录给的版本、状态文件里的最低版本）：去掉首尾空白，
 * 开头可带小写 v，只读开头的 x.y.z，后面跟什么都不看，所以 0.3.0-beta.1 和 0.3.0 算同一版。
 */
export function parseUpdateVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** 上次运行版本记录：只认 x.y.z，每段 1 到 6 位数字，不带 v，前后不许有空白或别的字。 */
export function parseInstalledReleaseVersion(value: string): [number, number, number] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** nodejs.org 的发布索引：必须小写 v 开头，每段不许前导零、必须是安全整数，不带预发布号。 */
export function parseNodeReleaseVersion(value: string): [number, number, number] | null {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) return null
  return [parts[0], parts[1], parts[2]]
}

/** python.org 发布列表里的版本：不带 v，每段不许前导零。 */
export function parsePythonReleaseVersion(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** npm 包和 CLI 输出：从串里找出第一个前后断开的 x.y.z，可带 v 和预发布号；数字一样时再比预发布号。 */
function parseVersion(value: string | null): ParsedVersion | null {
  if (!value) return null
  const match = value.match(/\bv?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\b/)
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  }
}

export function isNewerVersion(current: string | null, latest: string | null): boolean {
  const currentVersion = parseVersion(current)
  const latestVersion = parseVersion(latest)
  if (!currentVersion || !latestVersion) return false

  const comparison = compareVersionNumbers(latestVersion.numbers, currentVersion.numbers)
  if (comparison !== 0) return comparison > 0

  if (currentVersion.prerelease && !latestVersion.prerelease) return true
  if (!currentVersion.prerelease || !latestVersion.prerelease) return false
  return latestVersion.prerelease.localeCompare(currentVersion.prerelease, undefined, { numeric: true }) > 0
}
