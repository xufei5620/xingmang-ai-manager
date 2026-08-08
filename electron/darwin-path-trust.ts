import fs from 'node:fs'
import path from 'node:path'

/**
 * Path trust for macOS.
 *
 * The Windows model asks "can any principal below Administrator write here?", because
 * there the app may hold an elevated token while an attacker holds only the user one.
 * That boundary does not exist on macOS: this app never elevates, and every CLI it
 * launches lives in a tree the invoking user owns. Porting the Windows question
 * literally would reject everything the product must run while protecting nothing —
 * whoever can rewrite ~/.local/bin/node can equally rewrite ~/.zshrc.
 *
 * So the shape of the question is kept and only the membership of the trusted set
 * changes: a path is untrusted when some principal OTHER than root or the invoking
 * user can modify what it resolves to. That still catches the exposures macOS really
 * has — world-writable directories, trees owned by a different user, and symlinks
 * escaping into either — while leaving legitimate launches untouched.
 *
 * Two properties are load-bearing:
 *
 * - The whole ancestor chain is walked, not just the leaf. Replacing a file is
 *   governed by write permission on its parent directory, so a pristine 0755 binary
 *   under a 1777 directory is still replaceable.
 * - Ownership outranks mode bits. An owner can chmod at will, so `uid === euid` means
 *   writable no matter what the mode says, and a read-only directory the user owns is
 *   not protection either.
 */

/** Group 0 is wheel. Group 80 is admin, whose members stock sudoers already makes
 * root-equivalent, so excluding them would defend a boundary that does not exist.
 * The app cannot verify that sudoers rule — /etc/sudoers is mode 0440 root — so this
 * is a deliberate product decision, not an inference. */
const trustedDarwinWriteGids = new Set([0, 80])

export interface DarwinPathStats {
  uid: number
  gid: number
  mode: number
  isSymbolicLink(): boolean
}

export interface DarwinPathTrustProbe {
  lstatSync?: (filePath: string) => DarwinPathStats
  realpathSync?: (filePath: string) => string
  geteuid?: () => number
}

/** Lists every ancestor of an absolute POSIX path, from the root down to the leaf. */
export function posixPathComponents(value: string): string[] {
  const resolved = path.posix.resolve(value)
  const components = ['/']
  let current = ''
  for (const name of resolved.split('/')) {
    if (!name) continue
    current = `${current}/${name}`
    components.push(current)
  }
  return components
}

function isForeignWritableComponent(stats: DarwinPathStats, effectiveUid: number): boolean {
  // After realpath no component can legitimately still be a link, so one here means
  // the tree changed underneath us. Fail closed rather than resolving a second time.
  if (stats.isSymbolicLink()) return true
  if (stats.uid !== 0 && stats.uid !== effectiveUid) return true
  const permissions = stats.mode & 0o7777
  // The sticky bit is deliberately given no credit: +t on /private/tmp stops one user
  // deleting another's file, but anyone may still create a new name there, so a
  // fixed-name path under a world-writable directory remains squattable.
  if ((permissions & 0o002) !== 0) return true
  return (permissions & 0o020) !== 0 && !trustedDarwinWriteGids.has(stats.gid)
}

/**
 * Reports whether a principal other than root or the invoking user can reach this
 * path for modification. Every failure — a missing target, an unreadable component, a
 * race — answers true, matching the Windows side's fail-closed stance.
 *
 * Note the name describes reachability by a foreign principal, not literal writability:
 * ~/.local/bin/node is writable by the user who runs the app and is still trusted here.
 */
export function isDarwinForeignWritablePath(
  filePath: string,
  probe: DarwinPathTrustProbe = {},
): boolean {
  const lstatSync = probe.lstatSync ?? fs.lstatSync
  const realpathSync = probe.realpathSync ?? fs.realpathSync
  // An absent geteuid never equals a real uid, so the trusted set degrades to {root}.
  const effectiveUid = probe.geteuid?.() ?? process.geteuid?.() ?? -1
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return true
  if (!path.posix.isAbsolute(filePath)) return true

  let resolved: string
  try {
    resolved = realpathSync(filePath)
  } catch {
    return true
  }
  if (typeof resolved !== 'string' || !path.posix.isAbsolute(resolved)) return true

  try {
    for (const component of posixPathComponents(resolved)) {
      if (isForeignWritableComponent(lstatSync(component), effectiveUid)) return true
    }
  } catch {
    return true
  }
  return false
}
