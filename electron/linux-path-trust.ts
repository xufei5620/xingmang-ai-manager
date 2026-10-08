import fs from 'node:fs'
import path from 'node:path'
import { posixPathComponents } from './darwin-path-trust'

/**
 * Path trust for Linux.
 *
 * The question is the macOS one, not the Windows one: this app never runs as root on
 * Linux (linux-launch-guard.ts refuses it) and every CLI it launches lives in a tree the
 * invoking user owns, so "can a non-administrator write here?" would reject everything
 * the product must run while protecting nothing. What Linux does have is other local
 * accounts — shared office, school and family machines are common on the domestic
 * distros this targets — so a path is untrusted when a principal OTHER than root or the
 * invoking user can modify what it resolves to.
 *
 * The answer differs from darwin-path-trust.ts in who counts as trusted for a
 * group-writable directory. macOS trusts gid 0 and gid 80 (admin) by fixed number.
 * Neither number means anything on Linux, and Ubuntu, Debian and UOS desktops default
 * to user-private groups with umask 002, so the user's own ~/.local tree is 0775 with
 * group = the user's own group. Copying the macOS set would reject that tree and accept
 * whatever happens to be gid 80. So the group is judged by who is actually in it: a
 * group-writable component is trusted only when every account that holds that group,
 * as a listed member or as its primary group, is root or the invoking user, read from
 * root-owned /etc/group and /etc/passwd. A group the files do not describe (LDAP, SSSD,
 * NIS compat lines) stays untrusted, because its membership cannot be checked.
 *
 * Three properties are load-bearing:
 *
 * - The whole ancestor chain is walked, not just the leaf, for the same reason as on
 *   macOS: replacing a file is governed by write permission on its parent.
 * - Both chains are walked. The resolved chain says what the path points at now; the
 *   lexical chain says who could repoint it later. A PATH entry is looked up by its
 *   lexical spelling at spawn time, so a symlink sitting in /tmp that happens to point
 *   at /usr/bin today is still untrusted. darwin-path-trust.ts walks only the resolved
 *   chain; that is a deliberate difference, not drift.
 * - Ownership outranks mode bits. An owner can chmod at will, so a component owned by
 *   anyone but root or the invoking user is untrusted whatever its mode.
 *
 * This is not a same-uid defence: whoever can write ~/.local/bin can write ~/.bashrc.
 */

export interface LinuxPathStats {
  uid: number
  gid: number
  mode: number
  isSymbolicLink(): boolean
}

export type LinuxAccountFile = '/etc/group' | '/etc/passwd'

export interface LinuxPathTrustProbe {
  lstatSync?: (filePath: string) => LinuxPathStats
  realpathSync?: (filePath: string) => string
  geteuid?: () => number
  /** Returns the file's text, or null when it is missing, oversized or not root-owned. */
  readAccountFile?: (filePath: LinuxAccountFile) => string | null
}

/** /etc/group and /etc/passwd on a large directory-backed workstation stay well under this. */
const maximumAccountFileBytes = 4 * 1024 * 1024

interface LinuxAccountDatabase {
  uidByName: Map<string, number>
  memberNamesByGid: Map<number, string[]>
  primaryUidsByGid: Map<number, number[]>
}

function parseId(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,10}$/.test(value) ? Number(value) : null
}

/**
 * Parses the two colon files. A NIS compat line (`+`, `-`) means part of the database
 * lives elsewhere, and a malformed line means the parse cannot be trusted to be
 * complete, so either one discards the whole database rather than half-believing it.
 */
export function parseLinuxAccountDatabase(groupText: string, passwdText: string): LinuxAccountDatabase | null {
  const uidByName = new Map<string, number>()
  const primaryUidsByGid = new Map<number, number[]>()
  for (const line of passwdText.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (line.startsWith('+') || line.startsWith('-')) return null
    const fields = line.split(':')
    const uid = parseId(fields[2])
    const gid = parseId(fields[3])
    if (fields.length < 7 || !fields[0] || uid === null || gid === null) return null
    // A name listed twice keeps the first entry, which is the one getpwnam returns.
    if (!uidByName.has(fields[0])) uidByName.set(fields[0], uid)
    primaryUidsByGid.set(gid, [...(primaryUidsByGid.get(gid) ?? []), uid])
  }
  const memberNamesByGid = new Map<number, string[]>()
  for (const line of groupText.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (line.startsWith('+') || line.startsWith('-')) return null
    const fields = line.split(':')
    const gid = parseId(fields[2])
    if (fields.length !== 4 || !fields[0] || gid === null) return null
    const members = fields[3].trim() ? fields[3].trim().split(',').map((name) => name.trim()) : []
    // Two entries may share a gid; whoever is in either one can write as that group.
    memberNamesByGid.set(gid, [...(memberNamesByGid.get(gid) ?? []), ...members])
  }
  return { uidByName, memberNamesByGid, primaryUidsByGid }
}

/**
 * Whether every account that can act as `gid` is root or `effectiveUid`. An unknown
 * gid or member name answers false: membership that cannot be read is not membership
 * that can be ruled out.
 */
export function linuxGroupHoldersAreTrusted(
  gid: number,
  effectiveUid: number,
  database: LinuxAccountDatabase | null,
): boolean {
  if (!database) return false
  const members = database.memberNamesByGid.get(gid)
  if (!members) return false
  const trusted = (uid: number | undefined) => uid === 0 || uid === effectiveUid
  if (!members.every((name) => trusted(database.uidByName.get(name)))) return false
  return (database.primaryUidsByGid.get(gid) ?? []).every(trusted)
}

function isRootControlledComponent(stats: LinuxPathStats): boolean {
  return !stats.isSymbolicLink() && stats.uid === 0 && (stats.mode & 0o022) === 0
}

/**
 * Not bounded-file.ts: that reader resolves relocated folders, and relocated-folders.ts
 * imports this module, and its ownership rule is "single link", not "root-owned". The
 * account files are only worth believing when nobody but root could have edited them,
 * so the file and both of its ancestors must be root-owned and not group- or
 * world-writable.
 */
function readRootOwnedAccountFile(filePath: LinuxAccountFile): string | null {
  let descriptor: number | null = null
  try {
    if (!isRootControlledComponent(fs.lstatSync('/')) || !isRootControlledComponent(fs.lstatSync('/etc'))) return null
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stats = fs.fstatSync(descriptor)
    if (!stats.isFile() || stats.uid !== 0 || (stats.mode & 0o022) !== 0 || stats.size > maximumAccountFileBytes) return null
    const buffer = Buffer.alloc(stats.size)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === buffer.length ? buffer.toString('utf8') : null
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch { /* the verdict is already decided */ }
    }
  }
}

/** `.` and `..` segments are refused rather than collapsed: the kernel resolves `link/..`
 * through the link, so a lexical normalisation would walk directories the lookup never
 * touches. Real PATH entries and install paths never carry them. */
function hasDotSegment(filePath: string): boolean {
  return filePath.split('/').some((segment) => segment === '.' || segment === '..')
}

/**
 * Reports whether a principal other than root or the invoking user can reach this path
 * for modification. Every failure — a missing target, an unreadable component, an
 * unreadable account database, a race — answers true.
 *
 * As on macOS the name describes reachability by a foreign principal, not literal
 * writability: ~/.local/bin/node is writable by the user who runs the app and is
 * still trusted here.
 */
export function isLinuxForeignWritablePath(
  filePath: string,
  probe: LinuxPathTrustProbe = {},
): boolean {
  const lstatSync = probe.lstatSync ?? fs.lstatSync
  const realpathSync = probe.realpathSync ?? fs.realpathSync
  const readAccountFile = probe.readAccountFile ?? readRootOwnedAccountFile
  // An absent geteuid never equals a real uid, so the trusted set degrades to {root}.
  const effectiveUid = probe.geteuid?.() ?? process.geteuid?.() ?? -1
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return true
  if (!path.posix.isAbsolute(filePath) || hasDotSegment(filePath)) return true

  let database: LinuxAccountDatabase | null | undefined
  const groupIsTrusted = (gid: number) => {
    if (gid === 0) return true
    if (database === undefined) {
      const groupText = readAccountFile('/etc/group')
      const passwdText = groupText === null ? null : readAccountFile('/etc/passwd')
      database = groupText === null || passwdText === null ? null : parseLinuxAccountDatabase(groupText, passwdText)
    }
    return linuxGroupHoldersAreTrusted(gid, effectiveUid, database)
  }
  const isForeignWritable = (stats: LinuxPathStats, linkAllowed: boolean) => {
    if (stats.uid !== 0 && stats.uid !== effectiveUid) return true
    if (stats.isSymbolicLink()) {
      // A link's own mode is always 0777 and means nothing; it can only be replaced
      // through its parent, which the walk has already judged. After realpath, though,
      // no component may still be one: that means the tree changed underneath us.
      return !linkAllowed
    }
    const permissions = stats.mode & 0o7777
    // The sticky bit gets no credit, as on macOS: +t on /tmp stops one user deleting
    // another's file, but anyone may still create a new name there.
    if ((permissions & 0o002) !== 0) return true
    return (permissions & 0o020) !== 0 && !groupIsTrusted(stats.gid)
  }

  let resolved: string
  try {
    resolved = realpathSync(filePath)
  } catch {
    return true
  }
  if (typeof resolved !== 'string' || !path.posix.isAbsolute(resolved)) return true

  try {
    for (const component of posixPathComponents(filePath)) {
      if (isForeignWritable(lstatSync(component), true)) return true
    }
    if (resolved !== path.posix.resolve(filePath)) {
      for (const component of posixPathComponents(resolved)) {
        if (isForeignWritable(lstatSync(component), false)) return true
      }
    }
  } catch {
    return true
  }
  return false
}
