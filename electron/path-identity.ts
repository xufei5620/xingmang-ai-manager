import path from 'node:path'

function normalizedLocalPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]$/, '')
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

/** Compares path identity without accepting arbitrary filesystem links. */
export function sameLocalPathIdentity(left: string, right: string): boolean {
  const normalizedLeft = normalizedLocalPath(left)
  const normalizedRight = normalizedLocalPath(right)
  if (normalizedLeft === normalizedRight) return true
  if (process.platform !== 'darwin') return false
  return normalizedDarwinSystemAlias(normalizedLeft) === normalizedDarwinSystemAlias(normalizedRight)
}
