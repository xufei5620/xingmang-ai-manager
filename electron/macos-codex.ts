import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readBoundedUtf8FileSync } from './bounded-file'
import { releaseStagedDarwinCli, stageVerifiedDarwinCli } from './darwin-cli-staging'

const OPENAI_TEAM_ID = '2DC432GLL2'
const MAX_CODEX_PACKAGE_MANIFEST_BYTES = 512 * 1024
const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+){0,2})?$/

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
  expectedVersion: string
  runCommand: VerifyDarwinCodexStandaloneOptions['runCommand']
  assertUnchanged?: () => void
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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

/** Resolves only the official versioned layout selected by the visible command. */
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
  const codexHome = fs.realpathSync(configuredCodexHome(env))
  const configuredReleasesRoot = path.join(codexHome, 'packages', 'standalone', 'releases')
  const releasesRoot = fs.realpathSync(configuredReleasesRoot)
  if (releasesRoot !== configuredReleasesRoot) {
    throw new Error('Codex standalone releases 根目录不能包含符号链接')
  }
  const executablePath = fs.realpathSync(requestedExecutablePath)
  const relativeExecutable = path.relative(releasesRoot, executablePath)
  const parts = relativeExecutable.split(path.sep)
  if (
    relativeExecutable.startsWith(`..${path.sep}`)
    || relativeExecutable === '..'
    || path.isAbsolute(relativeExecutable)
    || parts.length !== 3
    || parts[1] !== 'bin'
    || parts[2] !== 'codex'
  ) {
    throw new Error('Codex standalone 可执行文件必须位于 releases/<version>-<target>/bin/codex')
  }

  const releaseRoot = fs.realpathSync(path.join(releasesRoot, parts[0]))
  const expectedExecutablePath = path.join(releaseRoot, 'bin', 'codex')
  if (executablePath !== expectedExecutablePath) {
    throw new Error('Codex standalone entrypoint 未绑定到发布目录')
  }
  const stats = fs.statSync(executablePath, { bigint: true })
  if (!stats.isFile() || (stats.mode & 0o111n) === 0n) {
    throw new Error('Codex standalone entrypoint 必须是普通可执行文件')
  }

  const manifest = readManifest(releaseRoot)
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  if (
    manifest.layoutVersion !== 1
    || manifest.variant !== 'codex'
    || manifest.entrypoint !== 'bin/codex'
    || manifest.target !== expectedTarget
    || !CODEX_VERSION_PATTERN.test(version)
    || path.basename(releaseRoot) !== `${version}-${expectedTarget}`
  ) {
    throw new Error('Codex standalone manifest 与当前发布目录、架构或 entrypoint 不一致')
  }

  return {
    requestedExecutablePath,
    codexHome,
    releaseRoot,
    executablePath,
    target: expectedTarget,
    version,
    fileIdentity: fileIdentity(stats),
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
    || !sameFileIdentity(current.fileIdentity, expected.fileIdentity)
  ) {
    throw new Error('Codex standalone selection 在验证期间发生变化')
  }
}

/** Verifies OpenAI identity and the exact expected runtime version for one executable. */
async function verifyDarwinCodexExecutable(
  options: VerifyDarwinCodexExecutableOptions,
): Promise<void> {
  await options.runCommand({
    executable: '/usr/bin/codesign',
    argv: ['--verify', '--strict', options.executablePath],
  })
  options.assertUnchanged?.()

  const signature = await options.runCommand({
    executable: '/usr/bin/codesign',
    argv: ['-dv', '--verbose=4', options.executablePath],
  })
  options.assertUnchanged?.()
  const signatureDetails = `${signature.stdout}\n${signature.stderr}`
  if (!new RegExp(`^TeamIdentifier=${OPENAI_TEAM_ID}$`, 'm').test(signatureDetails)) {
    throw new Error('Codex standalone signature Team ID 与 OpenAI 不匹配')
  }
  if (!new RegExp(
    `^Authority=Developer ID Application: OpenAI OpCo, LLC \\(${OPENAI_TEAM_ID}\\)$`,
    'm',
  ).test(signatureDetails)) {
    throw new Error('Codex standalone signature 缺少 OpenAI Developer ID authority')
  }

  const versionResult = await options.runCommand({
    executable: options.executablePath,
    argv: ['--version'],
  })
  options.assertUnchanged?.()
  if (versionResult.stdout.trim() !== `codex-cli ${options.expectedVersion}`) {
    throw new Error('Codex standalone runtime version 与 manifest version 不一致')
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
      retention: options.retention,
      verify: (stagedExecutable) => verifyDarwinCodexExecutable({
        executablePath: stagedExecutable,
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
