interface ParsedVersion {
  numbers: [number, number, number]
  prerelease: string | null
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
  if (parsed.major !== minimumSupportedNodeVersion.major) {
    return parsed.major > minimumSupportedNodeVersion.major ? 'supported' : 'too-old'
  }
  if (parsed.minor !== minimumSupportedNodeVersion.minor) {
    return parsed.minor > minimumSupportedNodeVersion.minor ? 'supported' : 'too-old'
  }
  return parsed.patch >= minimumSupportedNodeVersion.patch ? 'supported' : 'too-old'
}

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

  for (let index = 0; index < currentVersion.numbers.length; index += 1) {
    const difference = latestVersion.numbers[index] - currentVersion.numbers[index]
    if (difference !== 0) return difference > 0
  }

  if (currentVersion.prerelease && !latestVersion.prerelease) return true
  if (!currentVersion.prerelease || !latestVersion.prerelease) return false
  return latestVersion.prerelease.localeCompare(currentVersion.prerelease, undefined, { numeric: true }) > 0
}
