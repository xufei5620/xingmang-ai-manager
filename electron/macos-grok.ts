import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { releaseStagedDarwinCli, stageVerifiedDarwinCli } from './darwin-cli-staging'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import { sameLocalPathIdentity } from './path-identity'
import type {
  NativeCliDirectoryIdentity,
  NativeCliRegularFileIdentity,
  NativeCliResolvedSymbolicLinkTarget,
  NativeCliSymbolicLinkIdentity,
} from './native-cli-uninstall'

const xaiTeamId = '5Y6N3AJ54S'
const grokReleaseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,126})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,126})?$/
const grokVersionOutputPattern = /^grok\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,126})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,126})?)(?:\s+\([^\r\n]*\))?$/

export interface DarwinGrokCanonicalSelection {
  canonicalLinkPath: string
  executablePath: string
  linkIdentity: NativeCliSymbolicLinkIdentity
  linkTarget: string
  version: string
  fileIdentity: DarwinGrokFileIdentity
}

export interface DarwinGrokFileIdentity extends NativeCliRegularFileIdentity {}

export type DarwinGrokCanonicalLinkSnapshot =
  | { canonicalLinkPath: string; existed: false }
  | { canonicalLinkPath: string; existed: true; linkTarget: string }

export interface DarwinGrokCommandResult {
  stdout: string
  stderr: string
}

export interface VerifyDarwinGrokCanonicalInstallationOptions {
  homeDirectory: string
  expectedVersion: string
  runCommand: (spec: { executable: string; argv: readonly string[] }) => Promise<DarwinGrokCommandResult>
}

export interface VerifyDarwinGrokExecutableOptions {
  executablePath: string
  expectedVersion: string
  runCommand: VerifyDarwinGrokCanonicalInstallationOptions['runCommand']
  assertUnchanged?: () => void
}

export interface StageDarwinGrokCanonicalSelectionOptions {
  homeDirectory: string
  selection: DarwinGrokCanonicalSelection
  expectedVersion: string
  runCommand: VerifyDarwinGrokCanonicalInstallationOptions['runCommand']
  retention?: 'ephemeral' | 'retained'
}

export interface VerifyDarwinGrokUninstallPlanOptions {
  homeDirectory: string
  runCommand: VerifyDarwinGrokCanonicalInstallationOptions['runCommand']
}

export interface DarwinGrokUninstallPlan {
  rootDirectory: string
  rootDirectoryIdentity: NativeCliDirectoryIdentity
  directory: string
  directoryIdentity: NativeCliDirectoryIdentity
  expectedSymbolicLinks: Readonly<Record<string, string>>
  expectedSymbolicLinkIdentities: Readonly<Record<string, NativeCliSymbolicLinkIdentity>>
  expectedResolvedSymbolicLinkTargets: Readonly<Record<string, NativeCliResolvedSymbolicLinkTarget>>
  expectedOwnerUid: number
}

function directoryIdentity(stats: fs.Stats): NativeCliDirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid }
}

function requirePlainOwnedDirectory(
  directory: string,
  expectedOwnerUid: number,
): NativeCliDirectoryIdentity {
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== expectedOwnerUid) {
    throw new Error(`Grok uninstall path ${directory} must be a plain owned directory`)
  }
  if (!sameLocalPathIdentity(fs.realpathSync(directory), directory)) {
    throw new Error(`Grok uninstall path ${directory} must be a plain owned directory`)
  }
  return directoryIdentity(stats)
}

function assertPlainOwnedDirectoryUnchanged(
  directory: string,
  expectedOwnerUid: number,
  expectedIdentity: NativeCliDirectoryIdentity,
): void {
  const current = requirePlainOwnedDirectory(directory, expectedOwnerUid)
  if (
    current.dev !== expectedIdentity.dev
    || current.ino !== expectedIdentity.ino
    || current.mode !== expectedIdentity.mode
    || current.uid !== expectedIdentity.uid
  ) {
    throw new Error(`Grok uninstall path ${directory} changed while building the uninstall plan`)
  }
}

export interface DarwinGrokPostInstallTransactionOptions<T> {
  homeDirectory: string
  lifecycle: () => Promise<void>
  verify: () => Promise<T>
}

export interface InspectDarwinGrokVerifiedSelectionOptions<T> {
  homeDirectory: string
  selection: DarwinGrokCanonicalSelection
  expectedVersion: string
  runCommand: VerifyDarwinGrokCanonicalInstallationOptions['runCommand']
  inspect: (executablePath: string) => Promise<T>
}

function canonicalLinkPath(homeDirectory: string): string {
  return path.join(homeDirectory, '.grok', 'bin', 'grok')
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function symbolicLinkIdentity(stats: fs.BigIntStats): NativeCliSymbolicLinkIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: stats.nlink,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  }
}

function sameSymbolicLinkIdentity(
  left: NativeCliSymbolicLinkIdentity,
  right: NativeCliSymbolicLinkIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs
}

function requiredRelativeLink(linkPath: string): {
  identity: NativeCliSymbolicLinkIdentity
  target: string
} {
  const stats = fs.lstatSync(linkPath, { bigint: true })
  if (!stats.isSymbolicLink()) throw new Error('Grok canonical link must be a symbolic link')
  const target = fs.readlinkSync(linkPath)
  if (!target || target.includes('\0') || path.isAbsolute(target)) {
    throw new Error('Grok canonical link must use a relative target')
  }
  return { identity: symbolicLinkIdentity(stats), target }
}

function versionFromOfficialLinkTarget(linkTarget: string): string | null {
  const fileName = path.basename(linkTarget)
  const platformTarget = /^grok-(.+)-macos-(?:aarch64|x86_64)$/.exec(fileName)?.[1]
  const versionOnlyTarget = /^grok-(.+)$/.exec(fileName)?.[1]
  const version = platformTarget ?? versionOnlyTarget
  return version && grokReleaseVersionPattern.test(version) ? version : null
}

function isOfficialUninstallLinkTarget(linkTarget: string): boolean {
  if (/^grok-.+$/.test(linkTarget) && path.basename(linkTarget) === linkTarget) {
    return versionFromOfficialLinkTarget(linkTarget) !== null
  }
  const parts = linkTarget.split(path.sep)
  return parts.length === 3
    && parts[0] === '..'
    && parts[1] === 'downloads'
    && /^grok-.+-macos-(?:aarch64|x86_64)$/.test(parts[2])
    && versionFromOfficialLinkTarget(linkTarget) !== null
}

function fileIdentity(stats: fs.BigIntStats): DarwinGrokFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  }
}

function sameFileIdentity(left: DarwinGrokFileIdentity, right: DarwinGrokFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
}

interface DarwinGrokOfficialLinkSelection {
  executablePath: string
  fileIdentity: DarwinGrokFileIdentity
  linkIdentity: NativeCliSymbolicLinkIdentity
  linkPath: string
  linkTarget: string
  version: string
}

function resolveDarwinGrokOfficialLink(
  homeDirectory: string,
  linkName: string,
): DarwinGrokOfficialLinkSelection | null {
  const linkPath = path.join(homeDirectory, '.grok', 'bin', linkName)
  let link: ReturnType<typeof requiredRelativeLink>
  try {
    link = requiredRelativeLink(linkPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const linkTarget = link.target
  if (!isOfficialUninstallLinkTarget(linkTarget)) {
    throw new Error(`Grok ${linkName} link target is not an official uninstall layout`)
  }
  const version = versionFromOfficialLinkTarget(linkTarget)
  if (!version) throw new Error(`Grok ${linkName} link target is not an official versioned macOS binary`)
  const grokRoot = fs.realpathSync(path.join(homeDirectory, '.grok'))
  const executablePath = fs.realpathSync(path.resolve(path.dirname(linkPath), linkTarget))
  if (!isPathInside(grokRoot, executablePath)) {
    throw new Error(`Grok ${linkName} link target must remain under ~/.grok`)
  }
  const stats = fs.statSync(executablePath, { bigint: true })
  if (!stats.isFile() || (stats.mode & 0o111n) === 0n) {
    throw new Error(`Grok ${linkName} link target must be a regular executable file`)
  }
  return {
    executablePath,
    fileIdentity: fileIdentity(stats),
    linkIdentity: link.identity,
    linkPath,
    linkTarget,
    version,
  }
}

function assertOfficialLinkUnchanged(
  homeDirectory: string,
  linkName: string,
  expected: DarwinGrokOfficialLinkSelection,
): void {
  const current = resolveDarwinGrokOfficialLink(homeDirectory, linkName)
  if (
    !current
    || current.linkPath !== expected.linkPath
    || current.linkTarget !== expected.linkTarget
    || current.executablePath !== expected.executablePath
    || current.version !== expected.version
    || !sameFileIdentity(current.fileIdentity, expected.fileIdentity)
    || !sameSymbolicLinkIdentity(current.linkIdentity, expected.linkIdentity)
  ) {
    throw new Error(`Grok ${linkName} link changed while building the uninstall plan`)
  }
}

/** Resolves xAI's selected versioned binary without consulting stale version.json metadata. */
export function resolveDarwinGrokCanonicalSelection(
  homeDirectory: string,
  executablePath?: string,
): DarwinGrokCanonicalSelection {
  const linkPath = canonicalLinkPath(homeDirectory)
  const link = requiredRelativeLink(linkPath)
  const linkTarget = link.target
  const version = versionFromOfficialLinkTarget(linkTarget)
  if (!version) throw new Error('Grok canonical link target is not an official versioned macOS binary')

  const grokRoot = fs.realpathSync(path.join(homeDirectory, '.grok'))
  const executablePathResolved = fs.realpathSync(path.resolve(path.dirname(linkPath), linkTarget))
  if (!isPathInside(grokRoot, executablePathResolved)) {
    throw new Error('Grok canonical link target must remain under ~/.grok')
  }
  const executableStats = fs.statSync(executablePathResolved, { bigint: true })
  if (!executableStats.isFile() || (executableStats.mode & 0o111n) === 0n) {
    throw new Error('Grok canonical link target must be a regular executable file')
  }
  if (executablePath) {
    const suppliedExecutable = fs.realpathSync(executablePath)
    if (suppliedExecutable !== executablePathResolved) {
      throw new Error('Grok executable does not resolve to the canonical selection')
    }
  }
  return {
    canonicalLinkPath: linkPath,
    executablePath: executablePathResolved,
    linkIdentity: link.identity,
    linkTarget,
    version,
    fileIdentity: fileIdentity(executableStats),
  }
}

/** Rejects link swaps and in-place/replacement mutations after a selection was trusted. */
export function assertDarwinGrokSelectionUnchanged(
  homeDirectory: string,
  expected: DarwinGrokCanonicalSelection,
): void {
  const current = resolveDarwinGrokCanonicalSelection(homeDirectory)
  if (
    current.canonicalLinkPath !== expected.canonicalLinkPath
    || current.linkTarget !== expected.linkTarget
    || current.executablePath !== expected.executablePath
    || current.version !== expected.version
    || !sameSymbolicLinkIdentity(current.linkIdentity, expected.linkIdentity)
  ) {
    throw new Error('Grok canonical selection 在验证期间发生变化')
  }
  if (!sameFileIdentity(current.fileIdentity, expected.fileIdentity)) {
    throw new Error('Grok canonical executable 文件身份在验证期间发生变化')
  }
}

/** Captures only the canonical relative link so failed postinstall work can be rolled back. */
export function captureDarwinGrokCanonicalLink(homeDirectory: string): DarwinGrokCanonicalLinkSnapshot {
  const linkPath = canonicalLinkPath(homeDirectory)
  try {
    const selection = resolveDarwinGrokCanonicalSelection(homeDirectory)
    return {
      canonicalLinkPath: selection.canonicalLinkPath,
      existed: true,
      linkTarget: selection.linkTarget,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { canonicalLinkPath: linkPath, existed: false }
    throw error
  }
}

/** Restores the old xAI link atomically, or removes only a link created by a failed first install. */
export async function restoreDarwinGrokCanonicalLink(
  snapshot: DarwinGrokCanonicalLinkSnapshot,
): Promise<void> {
  let current: fs.Stats | null = null
  try {
    current = await fs.promises.lstat(snapshot.canonicalLinkPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current && !current.isSymbolicLink()) {
    throw new Error('Refusing to overwrite a non-symlink Grok canonical path during rollback')
  }
  if (!snapshot.existed) {
    if (current) await fs.promises.unlink(snapshot.canonicalLinkPath)
    return
  }

  const temporaryLink = path.join(
    path.dirname(snapshot.canonicalLinkPath),
    `.grok-rollback-${randomUUID()}`,
  )
  await fs.promises.symlink(snapshot.linkTarget, temporaryLink)
  try {
    await fs.promises.rename(temporaryLink, snapshot.canonicalLinkPath)
  } catch (error) {
    await fs.promises.unlink(temporaryLink).catch(() => undefined)
    throw error
  }
}

/** Keeps rollback active until lifecycle work and every caller-supplied service verification succeed. */
export async function runDarwinGrokPostInstallTransaction<T>(
  options: DarwinGrokPostInstallTransactionOptions<T>,
): Promise<T> {
  const snapshot = captureDarwinGrokCanonicalLink(options.homeDirectory)
  try {
    await options.lifecycle()
    return await options.verify()
  } catch (error) {
    try {
      await restoreDarwinGrokCanonicalLink(snapshot)
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`Grok CLI 安装后验证失败，且旧版本回滚失败：${detail}`, { cause: error })
    }
    throw error
  }
}

/** Verifies xAI identity and the exact expected runtime version for one executable. */
async function verifyDarwinGrokExecutable(
  options: VerifyDarwinGrokExecutableOptions,
): Promise<void> {
  try {
    await options.runCommand({
      executable: '/usr/bin/codesign',
      argv: darwinDeveloperIdVerificationArgv(xaiTeamId, options.executablePath),
    })
  } catch (error) {
    throw new Error('Grok 可执行文件未通过 xAI Developer ID 签名校验', { cause: error })
  }
  options.assertUnchanged?.()
  const versionResult = await options.runCommand({
    executable: options.executablePath,
    argv: ['--version'],
  })
  options.assertUnchanged?.()
  const reportedVersion = grokVersionOutputPattern.exec(versionResult.stdout.trim())?.[1] ?? null
  if (reportedVersion !== options.expectedVersion) {
    throw new Error('Grok canonical executable reported a version different from the pinned release')
  }
}

/** Copies the canonical source through a bound descriptor and verifies only the private copy. */
export async function stageDarwinGrokCanonicalSelection(
  options: StageDarwinGrokCanonicalSelectionOptions,
): Promise<string> {
  if (options.selection.version !== options.expectedVersion) {
    throw new Error('Grok canonical link version does not match the pinned release')
  }
  let executable: string | null = null
  assertDarwinGrokSelectionUnchanged(options.homeDirectory, options.selection)
  try {
    executable = await stageVerifiedDarwinCli({
      executableName: 'grok',
      sourcePath: options.selection.executablePath,
      sourceIdentity: options.selection.fileIdentity,
      retention: options.retention,
      verify: (stagedExecutable) => verifyDarwinGrokExecutable({
        executablePath: stagedExecutable,
        expectedVersion: options.expectedVersion,
        runCommand: options.runCommand,
      }),
    })
    assertDarwinGrokSelectionUnchanged(options.homeDirectory, options.selection)
    return executable
  } catch (error) {
    if (executable) await releaseStagedDarwinCli(executable)
    throw error
  }
}

interface InspectStagedDarwinGrokExecutableOptions<T> {
  executableName: string
  sourcePath: string
  sourceIdentity: DarwinGrokFileIdentity
  expectedVersion: string
  runCommand: VerifyDarwinGrokCanonicalInstallationOptions['runCommand']
  assertSourceUnchanged: () => void
  inspect: (executablePath: string) => Promise<T>
}

async function inspectStagedDarwinGrokExecutable<T>(
  options: InspectStagedDarwinGrokExecutableOptions<T>,
): Promise<T> {
  let executable: string | null = null
  let inspected = false
  let result: T
  options.assertSourceUnchanged()
  try {
    executable = await stageVerifiedDarwinCli({
      executableName: options.executableName,
      sourcePath: options.sourcePath,
      sourceIdentity: options.sourceIdentity,
      retention: 'ephemeral',
      verify: async (stagedExecutable) => {
        await verifyDarwinGrokExecutable({
          executablePath: stagedExecutable,
          expectedVersion: options.expectedVersion,
          runCommand: options.runCommand,
        })
        result = await options.inspect(stagedExecutable)
        inspected = true
      },
    })
    options.assertSourceUnchanged()
    if (!inspected) throw new Error('Grok private staged executable inspection did not complete')
    return result!
  } finally {
    if (executable) await releaseStagedDarwinCli(executable)
  }
}

/** Runs service inspection only against an identity-bound private staged executable. */
export async function inspectDarwinGrokVerifiedSelection<T>(
  options: InspectDarwinGrokVerifiedSelectionOptions<T>,
): Promise<T> {
  if (options.selection.version !== options.expectedVersion) {
    throw new Error('Grok canonical link version does not match the pinned release')
  }
  return inspectStagedDarwinGrokExecutable({
    executableName: 'grok',
    sourcePath: options.selection.executablePath,
    sourceIdentity: options.selection.fileIdentity,
    expectedVersion: options.expectedVersion,
    runCommand: options.runCommand,
    assertSourceUnchanged: () => assertDarwinGrokSelectionUnchanged(
      options.homeDirectory,
      options.selection,
    ),
    inspect: options.inspect,
  })
}

/** Verifies the exact canonical xAI executable selected by the official versioned link. */
export async function verifyDarwinGrokCanonicalInstallation(
  options: VerifyDarwinGrokCanonicalInstallationOptions,
): Promise<DarwinGrokCanonicalSelection> {
  const selection = resolveDarwinGrokCanonicalSelection(options.homeDirectory)
  if (selection.version !== options.expectedVersion) {
    throw new Error('Grok canonical link version does not match the pinned release')
  }
  let executable: string | null = null
  try {
    executable = await stageDarwinGrokCanonicalSelection({
      homeDirectory: options.homeDirectory,
      selection,
      expectedVersion: options.expectedVersion,
      runCommand: options.runCommand,
      retention: 'ephemeral',
    })
    return selection
  } finally {
    if (executable) await releaseStagedDarwinCli(executable)
  }
}

/** Verifies every official link before exposing the exact link-only uninstall plan. */
export async function verifyDarwinGrokUninstallPlan(
  options: VerifyDarwinGrokUninstallPlanOptions,
): Promise<DarwinGrokUninstallPlan> {
  const expectedOwnerUid = process.getuid?.()
  if (expectedOwnerUid === undefined) throw new Error('Grok uninstall ownership checks require Darwin UID support')
  const grokRoot = path.join(options.homeDirectory, '.grok')
  const binDirectory = path.join(grokRoot, 'bin')
  const grokRootIdentity = requirePlainOwnedDirectory(grokRoot, expectedOwnerUid)
  const binIdentity = requirePlainOwnedDirectory(binDirectory, expectedOwnerUid)
  const canonical = resolveDarwinGrokCanonicalSelection(options.homeDirectory)
  if (!isOfficialUninstallLinkTarget(canonical.linkTarget)) {
    throw new Error('Grok canonical link target is not an official uninstall layout')
  }
  await inspectStagedDarwinGrokExecutable({
    executableName: 'grok',
    sourcePath: canonical.executablePath,
    sourceIdentity: canonical.fileIdentity,
    expectedVersion: canonical.version,
    runCommand: options.runCommand,
    assertSourceUnchanged: () => assertDarwinGrokSelectionUnchanged(options.homeDirectory, canonical),
    inspect: async () => undefined,
  })

  const agent = resolveDarwinGrokOfficialLink(options.homeDirectory, 'agent')
  if (agent) {
    await inspectStagedDarwinGrokExecutable({
      executableName: 'agent',
      sourcePath: agent.executablePath,
      sourceIdentity: agent.fileIdentity,
      expectedVersion: agent.version,
      runCommand: options.runCommand,
      assertSourceUnchanged: () => assertOfficialLinkUnchanged(options.homeDirectory, 'agent', agent),
      inspect: async () => undefined,
    })
  }
  assertDarwinGrokSelectionUnchanged(options.homeDirectory, canonical)
  assertPlainOwnedDirectoryUnchanged(grokRoot, expectedOwnerUid, grokRootIdentity)
  assertPlainOwnedDirectoryUnchanged(binDirectory, expectedOwnerUid, binIdentity)

  return {
    rootDirectory: fs.realpathSync(grokRoot),
    rootDirectoryIdentity: grokRootIdentity,
    directory: fs.realpathSync(binDirectory),
    directoryIdentity: binIdentity,
    expectedSymbolicLinks: {
      grok: canonical.linkTarget,
      ...(agent ? { agent: agent.linkTarget } : {}),
    },
    expectedSymbolicLinkIdentities: {
      grok: canonical.linkIdentity,
      ...(agent ? { agent: agent.linkIdentity } : {}),
    },
    expectedResolvedSymbolicLinkTargets: {
      grok: { path: canonical.executablePath, identity: canonical.fileIdentity },
      ...(agent ? { agent: { path: agent.executablePath, identity: agent.fileIdentity } } : {}),
    },
    expectedOwnerUid,
  }
}
