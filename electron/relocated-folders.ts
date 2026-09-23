import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDarwinForeignWritablePath } from './darwin-path-trust'
import { sameLocalPathIdentity } from './path-identity'

/**
 * Relocated user folders (「C 盘搬家」, `mklink /J`, a symlinked home on macOS).
 *
 * I8 rejects every link on a data path because the paths live in user-writable
 * places: a planted junction would redirect a write somewhere the writer never
 * meant to touch. That attack needs a privilege gap between whoever plants the
 * link and whoever follows it. The classic case is a medium-integrity process
 * pointing `%APPDATA%\xingmang` at `C:\Windows\System32\...` and waiting for an
 * elevated run of this app to write `settings.json` there.
 *
 * When the app runs with the user's own, unelevated token that gap is gone. A
 * link inside the user's profile can only be created by that user or by an
 * administrator, and whatever the link points at, the write still happens under
 * the user's token, so the OS denies anything the user could not have written
 * by hand. Refusing those links protects nothing and breaks every machine whose
 * profile was moved to another disk (可能没想到的问题 第 7 条): keys not written,
 * settings reset on every launch, no runtime log.
 *
 * So a link is followed only when all of these hold, and every other link is
 * still rejected exactly as before:
 *
 * - The process runs without elevation (`same-user`; on POSIX, not as root).
 *   Until startup has settled the execution mode nothing is followed, and
 *   afterwards this follows that mode exactly, failed probe included.
 * - The link sits at the user's home directory, above it, or inside it. Only
 *   the user or an administrator can create entries there. Links in shared
 *   locations (ProgramData, a drive root, /tmp) stay rejected, because another
 *   account could plant those to make this user's process overwrite its own data.
 * - Its target is somewhere this user's data may live: on Windows a directory
 *   on a local drive letter (never a network share, whose contents another
 *   machine controls); on POSIX a directory no one but root and the user can
 *   modify.
 *
 * Callers swap the lexical path for the resolved one and then run the usual
 * strict checks on it, so nothing after the relocated folder is relaxed: a second
 * link below it is judged again on its own, and the file itself must still be a
 * single-link regular file.
 */

export interface RelocatedFolderPolicy {
  /** A link counts only when it is one of these, an ancestor of one, or inside one. */
  homeDirectories: readonly string[]
  /** Whether the fully resolved location may hold this user's data. */
  acceptsTarget: (target: string) => boolean
}

export type RelocatedFolderAccessMode = 'same-user' | 'trusted-only'

export interface RelocatedFolderAccessOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  geteuid?: () => number
}

let activePolicy: RelocatedFolderPolicy | null = null

/** Tests install a policy directly; production goes through `configureRelocatedFolderAccess`. */
export function setRelocatedFolderPolicy(policy: RelocatedFolderPolicy | null): void {
  activePolicy = policy
}

export function activeRelocatedFolderPolicy(): RelocatedFolderPolicy | null {
  return activePolicy
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const flavor = platform === 'win32' ? path.win32 : path.posix
  const resolved = flavor.resolve(value).replace(/[\\/]+$/, '')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** True when `component` is `home`, one of its ancestors, or inside it. */
export function isWithinHomeLineage(
  component: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const separator = platform === 'win32' ? '\\' : '/'
  const left = comparablePath(component, platform)
  const right = comparablePath(home, platform)
  return left === right
    || right.startsWith(`${left}${separator}`)
    || left.startsWith(`${right}${separator}`)
}

function isDirectoryWithoutLink(target: string): boolean {
  try {
    const stats = fs.lstatSync(target)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

/** Strips the `\\?\` prefix libuv sometimes keeps, so only `X:\...` shapes remain. */
function windowsDrivePath(target: string): string | null {
  const normalized = target.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '')
  return /^[A-Za-z]:\\/.test(normalized) ? normalized : null
}

/**
 * A junction can only name a local volume, but a symlink can name a share, and a
 * mapped network drive resolves to its UNC form. Either one hands the contents
 * to another machine, and a volume without a drive letter is too unusual to trust.
 */
export function acceptsWindowsRelocationTarget(target: string): boolean {
  const drivePath = windowsDrivePath(target)
  return drivePath !== null && isDirectoryWithoutLink(drivePath)
}

export function acceptsPosixRelocationTarget(target: string): boolean {
  return path.posix.isAbsolute(target)
    && isDirectoryWithoutLink(target)
    && !isDarwinForeignWritablePath(target)
}

/**
 * Called once startup knows how the process runs. Anything but an unelevated
 * user keeps every link rejected.
 */
export function configureRelocatedFolderAccess(
  mode: RelocatedFolderAccessMode,
  options: RelocatedFolderAccessOptions = {},
): RelocatedFolderPolicy | null {
  const platform = options.platform ?? process.platform
  const effectiveUid = options.geteuid?.() ?? process.geteuid?.()
  if (mode !== 'same-user' || (platform !== 'win32' && (effectiveUid === undefined || effectiveUid === 0))) {
    activePolicy = null
    return null
  }
  const home = options.homeDirectory ?? os.homedir()
  if (!home || !path.isAbsolute(home)) {
    activePolicy = null
    return null
  }
  const homeDirectories = [home]
  try {
    // When the home directory itself was moved, some callers hand in paths that
    // already start from where it lives now.
    const resolvedHome = fs.realpathSync.native(home)
    if (comparablePath(resolvedHome, platform) !== comparablePath(home, platform)) homeDirectories.push(resolvedHome)
  } catch {
    // A home that cannot be resolved still bounds the lexical check.
  }
  activePolicy = {
    homeDirectories,
    acceptsTarget: platform === 'win32' ? acceptsWindowsRelocationTarget : acceptsPosixRelocationTarget,
  }
  return activePolicy
}

type ComponentState =
  | { kind: 'missing' }
  | { kind: 'plain' }
  | { kind: 'link'; target: string | null }
  | { kind: 'unreadable' }

function inspectComponent(component: string): ComponentState {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(component)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  let realPath: string
  try {
    realPath = fs.realpathSync(component)
  } catch {
    return { kind: 'unreadable' }
  }
  if (sameLocalPathIdentity(realPath, component)) return { kind: 'plain' }
  // Only an actual link is a relocation. Anything else realpath disagrees with
  // (an 8.3 short name, a race) is left for the strict check to judge.
  if (!stats.isSymbolicLink()) return { kind: 'unreadable' }
  try {
    return { kind: 'link', target: fs.realpathSync.native(component) }
  } catch {
    return { kind: 'link', target: null }
  }
}

/**
 * Rewrites `targetPath` so every relocated folder the policy accepts is replaced
 * by where it really lives. The result is meant for the strict I8 checks: if any
 * link on the path is not accepted, the path comes back with that link still in
 * it (or unchanged), and those checks reject it as they always did. Missing tail
 * components are carried over as-is, so directories about to be created resolve too.
 */
export function resolveRelocatedPath(
  targetPath: string,
  policy: RelocatedFolderPolicy | null = activePolicy,
): string {
  const resolved = path.resolve(targetPath)
  if (!policy || policy.homeDirectories.length === 0) return resolved
  const parsed = path.parse(resolved)
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let lexical = parsed.root
  let current = parsed.root
  for (const [index, segment] of segments.entries()) {
    lexical = path.join(lexical, segment)
    current = path.join(current, segment)
    const state = inspectComponent(current)
    if (state.kind === 'missing') return path.join(current, ...segments.slice(index + 1))
    if (state.kind === 'plain') continue
    if (state.kind === 'unreadable' || !state.target) return resolved
    const target = state.target
    // A relocation moves a folder. A link to a file is never one, whatever the
    // policy says, so the single-link-regular-file checks still see it as a link.
    const followed = isDirectoryWithoutLink(target)
      && policy.homeDirectories.some((home) => isWithinHomeLineage(lexical, home))
      && policy.acceptsTarget(target)
    if (!followed) return resolved
    current = process.platform === 'win32' ? windowsDrivePath(target) ?? target : target
  }
  return current
}
