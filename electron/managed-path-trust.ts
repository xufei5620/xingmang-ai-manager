import fs from 'node:fs'
import path from 'node:path'

const trustedRoots = new Set<string>()

function normalized(value: string): string {
  return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
}

function inside(candidate: string, root: string): boolean {
  const candidateKey = normalized(candidate)
  const rootKey = normalized(root)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`)
}

export function registerTrustedManagedWindowsRoot(directory: string): void {
  if (process.platform !== 'win32' || !path.win32.isAbsolute(directory) || directory.includes('\0')) return
  trustedRoots.add(normalized(directory))
}

export function isRegisteredTrustedManagedWindowsPath(candidate: string): boolean {
  if (process.platform !== 'win32' || !path.win32.isAbsolute(candidate) || candidate.includes('\0')) return false
  for (const root of trustedRoots) {
    if (!inside(candidate, root)) continue
    try {
      const realRoot = fs.realpathSync.native?.(root) ?? fs.realpathSync(root)
      const realCandidate = fs.realpathSync.native?.(candidate) ?? fs.realpathSync(candidate)
      return inside(realCandidate, realRoot)
    } catch {
      // A not-yet-created child can inherit the already protected root. Its
      // existing parent still has to resolve beneath that registered root.
      let parent = path.win32.dirname(candidate)
      while (inside(parent, root) && parent !== path.win32.dirname(parent)) {
        try {
          const realRoot = fs.realpathSync.native?.(root) ?? fs.realpathSync(root)
          const realParent = fs.realpathSync.native?.(parent) ?? fs.realpathSync(parent)
          return inside(realParent, realRoot)
        } catch {
          parent = path.win32.dirname(parent)
        }
      }
      return false
    }
  }
  return false
}

export function clearTrustedManagedWindowsRootsForTests(): void {
  trustedRoots.clear()
}
