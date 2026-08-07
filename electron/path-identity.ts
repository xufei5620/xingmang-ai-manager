import fs from 'node:fs'
import path from 'node:path'

function normalizedLocalPath(value: string): string {
  const pathFlavor = process.platform === 'win32' ? path.win32 : path
  const resolved = pathFlavor.resolve(value).replace(/[\\/]$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function normalizedDarwinSystemAlias(value: string): string {
  for (const [alias, target] of [
    ['/var', '/private/var'],
    ['/tmp', '/private/tmp'],
    ['/etc', '/private/etc'],
  ] as const) {
    if (value === alias || value.startsWith(`${alias}${path.sep}`)) {
      return `${target}${value.slice(alias.length)}`
    }
  }
  return value
}

function sameWindowsPathComponent(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
}

function windowsPathComponents(value: string): string[] {
  const resolved = path.win32.resolve(value)
  const extendedUncRoot = /^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.exec(resolved)?.[0]
  const root = extendedUncRoot ?? path.win32.parse(resolved).root
  const components = [root]
  let current = root
  for (const name of resolved.slice(root.length).split(path.win32.sep)) {
    if (!name) continue
    current = path.win32.join(current, name)
    components.push(current)
  }
  return components
}

function normalizedWindowsRoot(value: string): string | null {
  if (!path.win32.isAbsolute(value)) return null
  const resolved = path.win32.resolve(value)
  const extendedUnc = /^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)(?:\\|$)/i.exec(resolved)
  if (extendedUnc) return `unc:${extendedUnc[1].toLowerCase()}\\${extendedUnc[2].toLowerCase()}`
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/i.exec(resolved)
  if (unc) return `unc:${unc[1].toLowerCase()}\\${unc[2].toLowerCase()}`
  const extendedDrive = /^\\\\\?\\([a-z]:)(?:\\|$)/i.exec(resolved)
  if (extendedDrive) return `drive:${extendedDrive[1].toLowerCase()}`
  const drive = /^([a-z]:)(?:\\|$)/i.exec(resolved)
  return drive ? `drive:${drive[1].toLowerCase()}` : null
}

interface StableWindowsPathIdentity {
  nativePath: string
  stats: fs.BigIntStats
}

function normalizedWindowsNativePath(value: string): string {
  return path.win32.normalize(value).replace(/[\\/]$/, '').toLowerCase()
}

function stableWindowsPathIdentity(value: string): StableWindowsPathIdentity | null {
  const inputRoot = normalizedWindowsRoot(value)
  if (!inputRoot) return null
  const nativeBefore = fs.realpathSync.native(value)
  if (normalizedWindowsRoot(nativeBefore) !== inputRoot) return null

  let finalStats: fs.BigIntStats | null = null
  for (const component of windowsPathComponents(value)) {
    const before = fs.lstatSync(component, { bigint: true })
    if (before.isSymbolicLink()) return null
    const dereferenced = fs.statSync(component, { bigint: true })
    const after = fs.lstatSync(component, { bigint: true })
    if (
      after.isSymbolicLink()
      || !sameWindowsPathComponent(before, dereferenced)
      || !sameWindowsPathComponent(before, after)
    ) {
      return null
    }
    finalStats = after
  }

  const nativeAfter = fs.realpathSync.native(value)
  if (
    !finalStats
    || normalizedWindowsRoot(nativeAfter) !== inputRoot
    || normalizedWindowsNativePath(nativeBefore) !== normalizedWindowsNativePath(nativeAfter)
  ) {
    return null
  }
  return { nativePath: nativeAfter, stats: finalStats }
}

function sameWindowsPathIdentity(left: string, right: string): boolean {
  try {
    const leftIdentity = stableWindowsPathIdentity(left)
    const rightIdentity = stableWindowsPathIdentity(right)
    return Boolean(
      leftIdentity
      && rightIdentity
      && sameWindowsPathComponent(leftIdentity.stats, rightIdentity.stats)
      && normalizedWindowsNativePath(leftIdentity.nativePath)
        === normalizedWindowsNativePath(rightIdentity.nativePath),
    )
  } catch {
    return false
  }
}

/** Compares path identity without accepting arbitrary filesystem links. */
export function sameLocalPathIdentity(left: string, right: string): boolean {
  if (process.platform === 'win32') return sameWindowsPathIdentity(left, right)
  const normalizedLeft = normalizedLocalPath(left)
  const normalizedRight = normalizedLocalPath(right)
  if (normalizedLeft === normalizedRight) return true
  if (process.platform === 'darwin') {
    return normalizedDarwinSystemAlias(normalizedLeft) === normalizedDarwinSystemAlias(normalizedRight)
  }
  return false
}
