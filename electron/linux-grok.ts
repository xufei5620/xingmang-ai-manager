import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { readBoundedUtf8File } from './bounded-file'
import { cliNativePackageMissingMessage } from './cli-native-package'
import {
  assertDarwinGrokSelectionUnchanged,
  captureDarwinGrokCanonicalLink,
  ensureDarwinGrokAgentLink,
  resolveDarwinGrokCanonicalSelection,
  runDarwinGrokPostInstallTransaction,
  type DarwinGrokCanonicalSelection,
  type DarwinGrokPostInstallTransactionOptions,
} from './macos-grok'
import {
  uninstallVerifiedNativeCliFiles,
  type NativeCliDirectoryIdentity,
  type NativeCliResolvedSymbolicLinkTarget,
  type NativeCliSymbolicLinkIdentity,
} from './native-cli-uninstall'
import { sameLocalPathIdentity } from './path-identity'

/**
 * Grok CLI on Linux (Linux 版拆分 ③).
 *
 * Installed the way macOS installs it: `npm ci` with lifecycle scripts inside a throwaway
 * resolution directory whose lock was reconciled against the official registry. The
 * package's postinstall then brotli-decompresses the binary from the per-platform optional
 * package (@xai-official/grok-linux-x64 / -arm64) into ~/.grok/bin/grok-<version> and points
 * ~/.grok/bin/grok at it with a relative link. That layout is identical on both platforms, so
 * the link snapshot, rollback, canonical selection and `agent` companion link come straight
 * from macos-grok.ts.
 *
 * What macOS proves with codesign (xAI's Team ID) Linux has no equivalent for. The trust
 * anchor here is the official-registry SHA-512 that `npm ci` already enforced on the
 * platform package: after postinstall, the installed file must be byte-identical to that
 * package's compressed binary, decompressed by us. Then the binary must report the exact
 * version. Nothing here talks to x.ai: the install, like the other three CLIs, only needs
 * the npm registries, which mainland networks reach through the mirror.
 */

const grokPackagePrefix = '@xai-official/grok-linux-'
const maximumPlatformManifestBytes = 64 * 1024
/** The 1.0.46 linux-x64 grok.br is 48 MiB; generous headroom without reading anything unbounded. */
const maximumCompressedBinaryBytes = 256 * 1024 * 1024
/** It decompresses to 163 MiB. */
const maximumBinaryBytes = 1024 * 1024 * 1024
const npmLayoutVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,62})?$/
const grokVersionOutputPattern = /^grok\s+(\S+)(?:\s+\([^\r\n]*\))?$/

export interface LinuxGrokCommandResult {
  stdout: string
  stderr: string
}

export type LinuxGrokCommandRunner = (
  spec: { executable: string; argv: readonly string[] },
) => Promise<LinuxGrokCommandResult>

export interface VerifyLinuxGrokPostInstallOptions {
  homeDirectory: string
  expectedVersion: string
  /** Where `npm ci` ran; its node_modules holds the lock-verified platform package. */
  resolutionDirectory: string
  architecture: string
  runCommand: LinuxGrokCommandRunner
}

export interface UninstallVerifiedLinuxGrokInstallationOptions {
  homeDirectory: string
  installDirectory: string
}

export interface LinuxGrokUninstallResult {
  /** Program files that are still on disk after the command entries were removed. */
  retainedFiles: string[]
}

/** npm only publishes Grok for x64 and arm64 Linux. */
export function linuxGrokPlatformPackageName(architecture: string): string | null {
  return architecture === 'x64' || architecture === 'arm64' ? `${grokPackagePrefix}${architecture}` : null
}

/** Name postinstall gives the binary for one version: `grok-<version>`, beside the `grok` link. */
export function isLinuxGrokVersionFileName(fileName: string): boolean {
  return fileName.startsWith('grok-') && npmLayoutVersionPattern.test(fileName.slice('grok-'.length))
}

function npmLayoutVersion(linkTarget: string): string | null {
  return isLinuxGrokVersionFileName(linkTarget) ? linkTarget.slice('grok-'.length) : null
}

/**
 * The version of an install in the npm postinstall layout, read from the link the way xAI's
 * own launcher selects it. Anything else at that path (a hand-made link, the official
 * installer's downloads layout) answers null and the caller falls back to version.json.
 */
export function resolveLinuxGrokInstalledVersion(homeDirectory: string, executablePath: string): string | null {
  try {
    return npmLayoutVersion(resolveDarwinGrokCanonicalSelection(homeDirectory, executablePath).linkTarget)
  } catch {
    return null
  }
}

/**
 * Same snapshot and rollback of ~/.grok/bin/grok and agent as macOS; see macos-grok.ts.
 * A `grok` link this layout cannot describe (xAI's own installer, a hand-made link) could
 * not be put back if the install failed, so the snapshot refuses it. That refusal is said
 * in words the customer can act on before npm runs, instead of the English internal one.
 */
export function runLinuxGrokPostInstallTransaction<T>(options: DarwinGrokPostInstallTransactionOptions<T>): Promise<T> {
  try {
    captureDarwinGrokCanonicalLink(options.homeDirectory)
  } catch (error) {
    return Promise.reject(new Error(
      '这台电脑上已经有一份 Grok CLI，不是用星芒装的。为了不弄坏它，已停止安装。请先用你原来装它的方式卸载，再回来点「安装」。',
      { cause: error },
    ))
  }
  return runDarwinGrokPostInstallTransaction(options)
}

async function readPlatformPackageVersion(packageDirectory: string, packageName: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readBoundedUtf8File(
      path.join(packageDirectory, 'package.json'),
      maximumPlatformManifestBytes,
      `${packageName} package.json`,
    )) as unknown
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
    const record = manifest as Record<string, unknown>
    return record.name === packageName && typeof record.version === 'string' ? record.version : null
  } catch {
    return null
  }
}

/**
 * npm ci hoists the optional dependency to the top of the resolution's node_modules. An
 * absent one is what npm leaves behind when its download failed: it still exits 0.
 */
async function resolveVerifiedVendorBinary(
  resolutionDirectory: string,
  packageName: string,
  expectedVersion: string,
): Promise<string> {
  const nodeModules = path.join(resolutionDirectory, 'node_modules')
  const candidates = [
    path.join(nodeModules, ...packageName.split('/')),
    path.join(nodeModules, '@xai-official', 'grok', 'node_modules', ...packageName.split('/')),
  ]
  for (const candidate of candidates) {
    const version = await readPlatformPackageVersion(candidate, packageName)
    if (version === null) continue
    if (version !== expectedVersion) throw new Error('Grok CLI 的主程序包和这次要装的版本不一致')
    const realResolution = await fs.promises.realpath(resolutionDirectory)
    let vendor: string
    try {
      vendor = await fs.promises.realpath(path.join(candidate, 'bin', 'grok.br'))
    } catch {
      throw new Error(cliNativePackageMissingMessage('Grok CLI'))
    }
    const relative = path.relative(realResolution, vendor)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Grok CLI 的主程序包不在这次安装的目录里')
    }
    return vendor
  }
  throw new Error(cliNativePackageMissingMessage('Grok CLI'))
}

/** Hashes the inode the selection was bound to, not whatever the path names by the time we read. */
async function hashSelectedExecutable(selection: DarwinGrokCanonicalSelection): Promise<string> {
  const handle = await fs.promises.open(selection.executablePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile()
      || opened.dev !== selection.fileIdentity.dev
      || opened.ino !== selection.fileIdentity.ino
      || opened.size > BigInt(maximumBinaryBytes)
    ) {
      throw new Error('Grok CLI 程序文件在核对期间发生变化')
    }
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function hashDecompressedVendorBinary(vendorPath: string): Promise<string> {
  const handle = await fs.promises.open(vendorPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maximumCompressedBinaryBytes) {
      throw new Error('Grok CLI 的主程序包内容异常')
    }
    const hash = createHash('sha256')
    let total = 0
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      zlib.createBrotliDecompress(),
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) {
          total += chunk.length
          if (total > maximumBinaryBytes) throw new Error('Grok CLI 的主程序包内容异常')
          hash.update(chunk)
        }
      },
    )
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

function assertOwnedSingleLinkFile(selection: DarwinGrokCanonicalSelection): void {
  const ownerUid = process.getuid?.()
  const stats = fs.lstatSync(selection.executablePath)
  if (!stats.isFile() || stats.nlink !== 1 || (ownerUid !== undefined && stats.uid !== ownerUid)) {
    throw new Error('Grok CLI 程序文件不是当前用户自己的普通文件')
  }
}

/**
 * Runs inside runLinuxGrokPostInstallTransaction's verify step, so any throw rolls the
 * `grok` and `agent` links back to what they were before npm ran.
 */
export async function verifyLinuxGrokPostInstall(
  options: VerifyLinuxGrokPostInstallOptions,
): Promise<DarwinGrokCanonicalSelection> {
  const packageName = linuxGrokPlatformPackageName(options.architecture)
  if (!packageName) throw new Error('这台电脑的芯片类型 Grok CLI 不支持')
  const vendorPath = await resolveVerifiedVendorBinary(options.resolutionDirectory, packageName, options.expectedVersion)
  const selection = resolveDarwinGrokCanonicalSelection(options.homeDirectory)
  if (selection.linkTarget !== `grok-${options.expectedVersion}`) {
    throw new Error('Grok CLI 装完后命令没有指向这次装的版本')
  }
  assertOwnedSingleLinkFile(selection)
  // Same gap as on macOS (internal #16): postinstall only (re)creates `grok`.
  await ensureDarwinGrokAgentLink(options.homeDirectory, selection)
  const [installed, expected] = await Promise.all([
    hashSelectedExecutable(selection),
    hashDecompressedVendorBinary(vendorPath),
  ])
  if (installed !== expected) {
    throw new Error('Grok CLI 装好的程序文件和官方发布的不一致')
  }
  const versionResult = await options.runCommand({ executable: selection.executablePath, argv: ['--version'] })
  const firstLine = versionResult.stdout.trim().split(/\r?\n/, 1)[0] ?? ''
  if (grokVersionOutputPattern.exec(firstLine)?.[1] !== options.expectedVersion) {
    throw new Error('Grok CLI 装好后报告的版本和这次装的不一致')
  }
  assertDarwinGrokSelectionUnchanged(options.homeDirectory, selection)
  return selection
}

function directoryIdentity(stats: fs.Stats): NativeCliDirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid }
}

function requirePlainOwnedDirectory(directory: string, ownerUid: number): NativeCliDirectoryIdentity {
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== ownerUid) {
    throw new Error(`Grok CLI 目录 ${directory} 不是当前用户自己的普通文件夹，为避免误删已停止卸载`)
  }
  if (!sameLocalPathIdentity(fs.realpathSync(directory), directory)) {
    throw new Error(`Grok CLI 目录 ${directory} 经过了符号链接，为避免误删已停止卸载`)
  }
  return directoryIdentity(stats)
}

interface PlannedLink {
  target: string
  identity: NativeCliSymbolicLinkIdentity
  resolved: NativeCliResolvedSymbolicLinkTarget
}

/**
 * Only the npm postinstall shape is removed automatically: a relative link straight to a
 * `grok-<version>` file beside it, both the current user's. A link aimed anywhere else is
 * somebody else's layout (the official installer, a hand-made link) and is refused before
 * anything is renamed.
 */
function planNpmLayoutLink(binDirectory: string, linkName: string, ownerUid: number): PlannedLink | null {
  const linkPath = path.join(binDirectory, linkName)
  let link: fs.BigIntStats
  try {
    link = fs.lstatSync(linkPath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const outside = `Grok CLI 的 ${linkName} 不是星芒装的那种布局，为避免误删已停止卸载`
  if (!link.isSymbolicLink() || link.uid !== BigInt(ownerUid)) throw new Error(outside)
  const target = fs.readlinkSync(linkPath)
  if (!isLinuxGrokVersionFileName(target)) throw new Error(outside)
  const resolvedPath = fs.realpathSync(path.join(binDirectory, target))
  if (path.dirname(resolvedPath) !== binDirectory) throw new Error(outside)
  const file = fs.lstatSync(resolvedPath, { bigint: true })
  if (!file.isFile() || file.nlink !== 1n || file.uid !== BigInt(ownerUid)) throw new Error(outside)
  return {
    target,
    identity: {
      dev: link.dev,
      ino: link.ino,
      mode: link.mode,
      uid: link.uid,
      gid: link.gid,
      nlink: link.nlink,
      size: link.size,
      ctimeNs: link.ctimeNs,
      birthtimeNs: link.birthtimeNs,
    },
    resolved: {
      path: resolvedPath,
      identity: {
        dev: file.dev,
        ino: file.ino,
        mode: file.mode,
        size: file.size,
        ctimeNs: file.ctimeNs,
        mtimeNs: file.mtimeNs,
      },
    },
  }
}

/**
 * Removes the `grok` / `agent` links with the verified per-file primitive, then every
 * `grok-<version>` program file postinstall left in ~/.grok/bin. ~/.grok itself holds the
 * settings this app wrote and the user's sessions, so nothing else there is looked at.
 */
export async function uninstallVerifiedLinuxGrokInstallation(
  options: UninstallVerifiedLinuxGrokInstallationOptions,
): Promise<LinuxGrokUninstallResult> {
  const ownerUid = process.getuid?.()
  if (ownerUid === undefined) throw new Error('无法确认 Grok CLI 文件的所有者，已停止卸载')
  // postinstall resolves a linked $HOME before writing (`realpath(home)/.grok`), so do we.
  const grokRoot = path.join(fs.realpathSync(options.homeDirectory), '.grok')
  const binDirectory = path.join(grokRoot, 'bin')
  requirePlainOwnedDirectory(grokRoot, ownerUid)
  const binIdentity = requirePlainOwnedDirectory(binDirectory, ownerUid)
  const grok = planNpmLayoutLink(binDirectory, 'grok', ownerUid)
  if (!grok) throw new Error('Grok CLI 命令入口已不存在，请刷新后重试')
  const agent = planNpmLayoutLink(binDirectory, 'agent', ownerUid)
  const planned: Record<string, PlannedLink> = agent ? { grok, agent } : { grok }
  const commands = await uninstallVerifiedNativeCliFiles({
    actualDirectory: options.installDirectory,
    expectedDirectory: binDirectory,
    expectedDirectoryIdentity: binIdentity,
    fileNames: Object.keys(planned),
    label: 'Grok CLI',
    platform: 'linux',
    expectedSymbolicLinks: Object.fromEntries(Object.entries(planned).map(([name, link]) => [name, link.target])),
    expectedSymbolicLinkIdentities: Object.fromEntries(Object.entries(planned).map(([name, link]) => [name, link.identity])),
    expectedSymbolicLinkRootDirectory: binDirectory,
    expectedSymbolicLinkRootDirectoryIdentity: binIdentity,
    expectedResolvedSymbolicLinkTargets: Object.fromEntries(Object.entries(planned).map(([name, link]) => [name, link.resolved])),
    expectedOwnerUid: ownerUid,
    removeDirectoryWhenEmpty: false,
  })
  const retainedFiles = [...commands.retainedQuarantineFiles]
  const versionFiles = fs.readdirSync(binDirectory).filter(isLinuxGrokVersionFileName).sort()
  for (const name of versionFiles) {
    const filePath = path.join(binDirectory, name)
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(filePath)
    } catch {
      continue
    }
    if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== ownerUid) {
      retainedFiles.push(filePath)
      continue
    }
    try {
      // One call per file: a file that changed under us must not roll back the others.
      const removed = await uninstallVerifiedNativeCliFiles({
        actualDirectory: binDirectory,
        expectedDirectory: binDirectory,
        expectedDirectoryIdentity: binIdentity,
        fileNames: [name],
        label: 'Grok CLI',
        platform: 'linux',
        removeDirectoryWhenEmpty: false,
      })
      retainedFiles.push(...removed.retainedQuarantineFiles)
    } catch {
      if (fs.existsSync(filePath)) retainedFiles.push(filePath)
    }
  }
  return { retainedFiles }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** 命令入口已经没了、只剩程序文件时给客户的那句话；null 表示已全部清理干净。 */
export function buildLinuxGrokRetainedFilesReason(retainedFiles: readonly string[]): string | null {
  if (retainedFiles.length === 0) return null
  const names = retainedFiles.slice(0, 5).map((filePath) => path.basename(filePath))
  const listed = retainedFiles.length > 5 ? `${names.join('、')} 等` : names.join('、')
  return `Grok CLI 已卸载，但 ~/.grok/bin 里有 ${retainedFiles.length} 个程序文件没能自动删除（${listed}）。关闭所有 Grok CLI 窗口后，可以用下方命令删除它们；你的 Grok 设置和会话记录不受影响。`
}

export function buildLinuxGrokRetainedFilesCommand(retainedFiles: readonly string[]): string | null {
  return retainedFiles.length === 0 ? null : `rm -f ${retainedFiles.map(shellSingleQuote).join(' ')}`
}
