import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readBoundedFileSync, readBoundedUtf8FileSync } from './bounded-file'
import { releaseStagedDarwinCli, stageVerifiedDarwinCli } from './darwin-cli-staging'
import { isRecord } from './input-guards'
import { DarwinCliProvenanceError, darwinDeveloperIdVerificationArgv } from './macos-code-signing'

const OPENAI_TEAM_ID = '2DC432GLL2'
const MAX_CODEX_PACKAGE_MANIFEST_BYTES = 512 * 1024
const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+){0,2})?$/

/**
 * OpenAI also publishes a provisioned macOS package
 * (`codex-provisioned-package-<target>.tar.gz`, next to `codex-package-<target>.tar.gz`
 * in the same release and in the same SHA256SUMS). It moves the signed binary into
 * `CodexCLI.app`, whose embedded provisioning profile authorizes the binary's keychain
 * entitlements, and leaves this launcher at `bin/codex`. Copied byte for byte from
 * openai/codex `.github/scripts/macos-signing/provisioned_macos_cli_package.py`
 * (LAUNCHER), whose own verification refuses a package whose launcher differs. We never
 * run the launcher; matching it exactly is what lets us say that the visible command
 * runs nothing but the bundle we verify.
 */
export const OPENAI_PROVISIONED_CODEX_LAUNCHER = `#!/bin/sh
set -eu
entry="$0"
while [ -L "$entry" ]; do
  parent=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)
  entry=$(readlink "$entry")
  case "$entry" in /*) ;; *) entry="$parent/$entry" ;; esac
done
bin_dir=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)
exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"
`
const PROVISIONED_BUNDLE_NAME = 'CodexCLI.app'
const PROVISIONED_EXECUTABLE = path.join('Contents', 'MacOS', 'codex')
/** CODE_SIGNING_ID in the same script; login-keychain ACLs depend on it staying put. */
const PROVISIONED_SIGNING_IDENTIFIER = 'codex'
const MAX_PROVISIONED_LAUNCHER_BYTES = 4096

interface CodexStandaloneManifest {
  layoutVersion?: unknown
  version?: unknown
  target?: unknown
  variant?: unknown
  entrypoint?: unknown
}

export interface DarwinCodexFileIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  ctimeNs: bigint
  mtimeNs: bigint
}

export interface DarwinCodexStandaloneSelection {
  requestedExecutablePath: string
  codexHome: string
  releaseRoot: string
  executablePath: string
  target: string
  version: string
  fileIdentity: DarwinCodexFileIdentity
  /**
   * Set for OpenAI's provisioned package. The bundle is staged and verified as a whole,
   * because its binary is killed at launch outside the bundle that embeds its
   * provisioning profile; executablePath is then the bundle's main executable and
   * launcherPath the `bin/codex` script the visible command resolves to.
   * Absent = the canonical package, whose `bin/codex` is the signed binary itself.
   */
  bundlePath?: string
  launcherPath?: string
  /**
   * The package sits outside `CODEX_HOME/packages/standalone/releases`: something other
   * than OpenAI's installer unpacked it there (Mac acceptance R1 found one under
   * `~/.local/share/openchatcut-codex/<version>`). Only the provisioned package is
   * accepted out there, because its launcher is pinned byte for byte above.
   * Absent = inside the official installer's releases root.
   */
  relocated?: boolean
}

export interface DarwinCodexCommandResult {
  stdout: string
  stderr: string
}

export interface ResolveDarwinCodexStandaloneOptions {
  executablePath: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
}

export interface VerifyDarwinCodexStandaloneOptions extends ResolveDarwinCodexStandaloneOptions {
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<DarwinCodexCommandResult>
}

export interface VerifyDarwinCodexExecutableOptions {
  executablePath: string
  /** The private bundle copy whose signature is judged instead, for the provisioned package. */
  bundlePath?: string | null
  expectedVersion: string
  runCommand: VerifyDarwinCodexStandaloneOptions['runCommand']
}

export interface StageDarwinCodexStandaloneOptions extends ResolveDarwinCodexStandaloneOptions {
  selection: DarwinCodexStandaloneSelection
  runCommand: VerifyDarwinCodexStandaloneOptions['runCommand']
  retention?: 'ephemeral' | 'retained'
}

function targetForDarwinArchitecture(arch: NodeJS.Architecture): string | null {
  if (arch === 'arm64') return 'aarch64-apple-darwin'
  if (arch === 'x64') return 'x86_64-apple-darwin'
  return null
}

function fileIdentity(stats: fs.BigIntStats): DarwinCodexFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  }
}

function sameFileIdentity(left: DarwinCodexFileIdentity, right: DarwinCodexFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
}

function readManifest(releaseRoot: string): CodexStandaloneManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readBoundedUtf8FileSync(
      path.join(releaseRoot, 'codex-package.json'),
      MAX_CODEX_PACKAGE_MANIFEST_BYTES,
      'Codex standalone codex-package.json',
    )) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Codex standalone manifest 无法读取：${detail}`)
  }
  if (!isRecord(parsed)) throw new Error('Codex standalone manifest 必须是 JSON 对象')
  return parsed
}

function configuredCodexHome(env: NodeJS.ProcessEnv): string {
  const homeDirectory = env.HOME?.trim() || os.homedir()
  const configured = env.CODEX_HOME?.trim() || path.join(homeDirectory, '.codex')
  if (!configured || configured.includes('\0') || !path.isAbsolute(configured)) {
    throw new Error('Codex standalone CODEX_HOME 必须是绝对路径')
  }
  return configured
}

function existingRealPath(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

function regularExecutableStats(filePath: string, message: string): fs.BigIntStats {
  const stats = fs.statSync(filePath, { bigint: true })
  if (!stats.isFile() || (stats.mode & 0o111n) === 0n) throw new Error(message)
  return stats
}

interface ProvisionedCodexBundle {
  bundlePath: string
  executablePath: string
  stats: fs.BigIntStats
}

/** Null when the package has no CodexCLI.app at all, i.e. it is the canonical package. */
function resolveProvisionedBundle(
  releaseRoot: string,
  launcherPath: string,
): ProvisionedCodexBundle | null {
  const bundlePath = path.join(releaseRoot, PROVISIONED_BUNDLE_NAME)
  try {
    fs.lstatSync(bundlePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (fs.realpathSync(bundlePath) !== bundlePath || !fs.statSync(bundlePath).isDirectory()) {
    throw new Error('Codex provisioned CodexCLI.app 必须是发布目录里的普通文件夹')
  }
  const launcher = readBoundedFileSync(
    launcherPath,
    MAX_PROVISIONED_LAUNCHER_BYTES,
    'Codex provisioned bin/codex',
  )
  if (!launcher.equals(Buffer.from(OPENAI_PROVISIONED_CODEX_LAUNCHER, 'utf8'))) {
    throw new Error('Codex provisioned bin/codex 不是 OpenAI 发布的启动脚本')
  }
  const executablePath = path.join(bundlePath, PROVISIONED_EXECUTABLE)
  if (fs.realpathSync(executablePath) !== executablePath) {
    throw new Error('Codex provisioned 程序不能经过符号链接')
  }
  return {
    bundlePath,
    executablePath,
    stats: regularExecutableStats(executablePath, 'Codex provisioned 程序必须是普通可执行文件'),
  }
}

/**
 * Resolves only OpenAI's own package layouts selected by the visible command: inside the
 * official installer's releases root either package, outside it only the provisioned one.
 */
export function resolveDarwinCodexStandaloneSelection(
  options: ResolveDarwinCodexStandaloneOptions,
): DarwinCodexStandaloneSelection {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== 'darwin') throw new Error('Codex standalone 校验仅支持 macOS')
  const expectedTarget = targetForDarwinArchitecture(arch)
  if (!expectedTarget) throw new Error('Codex standalone 不支持当前 Mac 架构')
  if (!options.executablePath || options.executablePath.includes('\0')) {
    throw new Error('Codex standalone 可执行文件路径无效')
  }

  const env = options.env ?? process.env
  const requestedExecutablePath = path.resolve(options.executablePath)
  const configuredHome = configuredCodexHome(env)
  const codexHome = existingRealPath(configuredHome) ?? configuredHome
  const configuredReleasesRoot = path.join(codexHome, 'packages', 'standalone', 'releases')
  const releasesRoot = existingRealPath(configuredReleasesRoot)
  if (releasesRoot !== null && releasesRoot !== configuredReleasesRoot) {
    throw new Error('Codex standalone releases 根目录不能包含符号链接')
  }
  const entryPath = fs.realpathSync(requestedExecutablePath)
  const relativeExecutable = releasesRoot === null ? null : path.relative(releasesRoot, entryPath)
  const relocated = relativeExecutable === null
    || relativeExecutable.startsWith(`..${path.sep}`)
    || relativeExecutable === '..'
    || path.isAbsolute(relativeExecutable)

  let releaseRoot: string
  if (relocated) {
    // What the launcher itself runs: `<resolved bin dir>/../CodexCLI.app/...`.
    if (path.basename(entryPath) !== 'codex' || path.basename(path.dirname(entryPath)) !== 'bin') {
      throw new Error('Codex standalone 可执行文件必须位于 releases/<version>-<target>/bin/codex')
    }
    releaseRoot = path.dirname(path.dirname(entryPath))
  } else {
    const parts = (relativeExecutable ?? '').split(path.sep)
    if (parts.length !== 3 || parts[1] !== 'bin' || parts[2] !== 'codex') {
      throw new Error('Codex standalone 可执行文件必须位于 releases/<version>-<target>/bin/codex')
    }
    releaseRoot = fs.realpathSync(path.join(releasesRoot ?? configuredReleasesRoot, parts[0]))
    if (entryPath !== path.join(releaseRoot, 'bin', 'codex')) {
      throw new Error('Codex standalone entrypoint 未绑定到发布目录')
    }
  }
  const entryStats = regularExecutableStats(entryPath, 'Codex standalone entrypoint 必须是普通可执行文件')

  const manifest = readManifest(releaseRoot)
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  if (
    manifest.layoutVersion !== 1
    || manifest.variant !== 'codex'
    || manifest.entrypoint !== 'bin/codex'
    || manifest.target !== expectedTarget
    || !CODEX_VERSION_PATTERN.test(version)
    // Only the official installer names its release directories; elsewhere the name is
    // whatever the other tool chose, and the version is bound by --version instead.
    || (!relocated && path.basename(releaseRoot) !== `${version}-${expectedTarget}`)
  ) {
    throw new Error('Codex standalone manifest 与当前发布目录、架构或 entrypoint 不一致')
  }

  const provisioned = resolveProvisionedBundle(releaseRoot, entryPath)
  if (relocated && !provisioned) {
    throw new Error('Codex standalone releases 以外只认 OpenAI 发布的 provisioned 包')
  }

  return {
    requestedExecutablePath,
    codexHome,
    releaseRoot,
    executablePath: provisioned?.executablePath ?? entryPath,
    target: expectedTarget,
    version,
    fileIdentity: fileIdentity(provisioned?.stats ?? entryStats),
    ...(provisioned ? { bundlePath: provisioned.bundlePath, launcherPath: entryPath } : {}),
    ...(relocated ? { relocated: true } : {}),
  }
}

export function assertDarwinCodexSelectionUnchanged(
  options: ResolveDarwinCodexStandaloneOptions,
  expected: DarwinCodexStandaloneSelection,
): void {
  let current: DarwinCodexStandaloneSelection
  try {
    current = resolveDarwinCodexStandaloneSelection(options)
  } catch (error) {
    throw new Error('Codex standalone selection 在验证期间发生变化', { cause: error })
  }
  if (
    current.requestedExecutablePath !== expected.requestedExecutablePath
    || current.codexHome !== expected.codexHome
    || current.releaseRoot !== expected.releaseRoot
    || current.executablePath !== expected.executablePath
    || current.target !== expected.target
    || current.version !== expected.version
    || current.bundlePath !== expected.bundlePath
    || current.launcherPath !== expected.launcherPath
    || current.relocated !== expected.relocated
    || !sameFileIdentity(current.fileIdentity, expected.fileIdentity)
  ) {
    throw new Error('Codex standalone selection 在验证期间发生变化')
  }
}

/** Verifies OpenAI identity and the exact expected runtime version for one executable. */
async function verifyDarwinCodexExecutable(
  options: VerifyDarwinCodexExecutableOptions,
): Promise<void> {
  try {
    await options.runCommand({
      executable: '/usr/bin/codesign',
      argv: options.bundlePath
        ? darwinDeveloperIdVerificationArgv(OPENAI_TEAM_ID, options.bundlePath, {
          bundleIdentifier: PROVISIONED_SIGNING_IDENTIFIER,
        })
        : darwinDeveloperIdVerificationArgv(OPENAI_TEAM_ID, options.executablePath),
    })
  } catch (error) {
    throw new DarwinCliProvenanceError('Codex standalone 未通过 OpenAI Developer ID 签名校验', { cause: error })
  }

  const versionResult = await options.runCommand({
    executable: options.executablePath,
    argv: ['--version'],
  })
  if (versionResult.stdout.trim() !== `codex-cli ${options.expectedVersion}`) {
    throw new DarwinCliProvenanceError('Codex standalone runtime version 与 manifest version 不一致')
  }
}

/** Copies the selected source through a bound descriptor and verifies only the private copy. */
export async function stageDarwinCodexStandaloneSelection(
  options: StageDarwinCodexStandaloneOptions,
): Promise<string> {
  let executable: string | null = null
  try {
    executable = await stageVerifiedDarwinCli({
      executableName: 'codex',
      sourcePath: options.selection.executablePath,
      sourceIdentity: options.selection.fileIdentity,
      ...(options.selection.bundlePath ? { bundleRoot: options.selection.bundlePath } : {}),
      retention: options.retention,
      verify: (stagedExecutable, stagedBundle) => verifyDarwinCodexExecutable({
        executablePath: stagedExecutable,
        bundlePath: stagedBundle,
        expectedVersion: options.selection.version,
        runCommand: options.runCommand,
      }),
    })
    assertDarwinCodexSelectionUnchanged(options, options.selection)
    return executable
  } catch (error) {
    if (executable) await releaseStagedDarwinCli(executable)
    throw error
  }
}

/** Verifies OpenAI identity, then binds the executable's runtime version to its manifest. */
export async function verifyDarwinCodexStandaloneInstallation(
  options: VerifyDarwinCodexStandaloneOptions,
): Promise<DarwinCodexStandaloneSelection> {
  const selection = resolveDarwinCodexStandaloneSelection(options)
  let executable: string | null = null
  try {
    executable = await stageDarwinCodexStandaloneSelection({
      ...options,
      selection,
      retention: 'ephemeral',
    })
    return selection
  } finally {
    if (executable) await releaseStagedDarwinCli(executable)
  }
}
