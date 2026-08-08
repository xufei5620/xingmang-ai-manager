import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CommandRunnerError, runCommand, trustedCommandEnvironment } from './command-runner'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import { describeProbeFailure } from './probe-failure'

const bundleIdentifier = 'com.openai.codex'
const openAiTeamIdentifier = '2DC432GLL2'
const maximumInfoPlistBytes = 1024 * 1024
const maximumCommandOutputBytes = 64 * 1024
const commandTimeoutMs = 5_000
/**
 * Deep signature verification is the only expensive step here — measured at 1.79s
 * against the 1.4 GB Codex.app on an Apple Silicon machine with a warm cache, versus
 * milliseconds for everything else — and inspectCodexDesktop reruns on every scan.
 *
 * The result is cached against a fingerprint of the bundle rather than skipped: an
 * upgrade replaces the bundle and its executable, which changes the fingerprint and
 * forces a fresh verification. The bounded lifetime exists because a directory's
 * mtime does not follow edits to files nested deep inside it, so a fingerprint alone
 * could keep a stale pass alive indefinitely; this caps that window instead.
 */
const verificationCacheTtlMs = 5 * 60_000
const verifiedBundles = new Map<string, { fingerprint: string; verifiedAt: number }>()

function bundleFingerprint(
  bundleStats: fs.Stats,
  infoStats: fs.Stats,
  executableStats: fs.Stats,
): string {
  return [
    bundleStats.dev, bundleStats.ino, bundleStats.mtimeMs,
    infoStats.mtimeMs, infoStats.size,
    executableStats.dev, executableStats.ino, executableStats.mtimeMs, executableStats.size,
  ].join(':')
}

/** Drops every cached verification. Exists so tests do not leak state into each other. */
export function resetMacosCodexAppVerificationCache(): void {
  verifiedBundles.clear()
}

export interface MacosCodexAppInfo {
  path: string
  version: string | null
  running: boolean
}

/**
 * inspectMacosCodexApp never throws — see the `inspect*` naming convention —
 * so a caller that could not reach a conclusion still needs a way to say so
 * without being confused for a confirmed absence. `app` is null both when no
 * bundle was found and when detection could not finish; `detectionFailed` is
 * what tells those two states apart. A definitive match always carries
 * `detectionFailed: false`: once one candidate is confirmed installed and
 * signed, an execution failure hit while checking some other, unrelated
 * candidate earlier in the scan is moot.
 */
export interface MacosCodexAppInspection {
  app: MacosCodexAppInfo | null
  detectionFailed: boolean
  detectionError: string | null
}

export interface MacosCodexAppInspectionOptions {
  architecture?: NodeJS.Architecture
  homeDirectory?: string
  systemApplicationsDirectory?: string
  runSystemCommand?: (
    executable: string,
    argv: readonly string[],
  ) => Promise<string>
}

type SystemCommandRunner = NonNullable<MacosCodexAppInspectionOptions['runSystemCommand']>

function isAppCandidate(value: string): boolean {
  return Boolean(value)
    && !value.includes('\0')
    && path.isAbsolute(value)
    && path.extname(value) === '.app'
}

/**
 * Every bundle-inspection command runs through runCommand.
 *
 * The result of these commands is what decides whether a bundle is the official
 * Codex.app, so their environment must not be inherited from this process: the
 * caller controls variables that change what a child loads before it runs, and
 * handing those to the very processes a trust decision reads inverts the check.
 * trustedCommandEnvironment strips that set — the same one used everywhere else a
 * command crosses a trust boundary — which is why this was the only such call site
 * left passing none.
 *
 * Going through runCommand rather than execFile directly also picks up the shared
 * output bound, the cancellable bounded lifecycle, and the credential redaction
 * applied to command errors, instead of keeping a second private implementation of
 * all three.
 */
export async function runSystemCommand(executable: string, argv: readonly string[]): Promise<string> {
  const result = await runCommand({ executable, argv }, {
    env: trustedCommandEnvironment(),
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: maximumCommandOutputBytes,
    windowsHide: true,
  })
  return executable === '/usr/bin/codesign' ? `${result.stdout}\n${result.stderr}` : result.stdout
}

function standardCandidate(directory: string | undefined): string | null {
  if (!directory || directory.includes('\0') || !path.isAbsolute(directory)) return null
  return path.join(directory, 'Codex.app')
}

async function canonicalAppCandidate(candidate: string): Promise<string | null> {
  if (!isAppCandidate(candidate)) return null
  try {
    const canonical = await fs.promises.realpath(candidate)
    if (!isAppCandidate(canonical) || !(await fs.promises.stat(canonical)).isDirectory()) return null
    const info = await fs.promises.lstat(path.join(canonical, 'Contents', 'Info.plist'))
    if (!info.isFile() || info.size > maximumInfoPlistBytes) return null
    return canonical
  } catch {
    return null
  }
}

function propertyValue(output: string): string | null {
  const value = output.trim()
  return value && !value.includes('\0') && !/[\r\n]/.test(value) ? value : null
}

function versionValue(output: string): string | null {
  const value = propertyValue(output)
  return value && /^\d+(?:\.\d+){1,3}$/.test(value) ? value : null
}

interface CandidateInspection {
  app: { path: string, version: string | null } | null
  detectionFailed: boolean
  detectionError: string | null
}

/** Shared by every early "this candidate is not a match" exit below. */
const notAMatch: CandidateInspection = { app: null, detectionFailed: false, detectionError: null }

/**
 * codesign — and, incidentally, plutil and lipo, which run inside the same
 * try/catch below — communicate a genuine rejection exclusively through a
 * non-zero exit; see macos-code-signing.ts for why codesign's stdout/stderr
 * must never be read to reach that conclusion instead. Anything else thrown
 * here — a timeout, a spawn failure, an aborted run, output exceeding the
 * bound, or any other unexpected error, including from an injected test
 * double — means the check itself never produced an answer, which is not the
 * same thing as the answer being "no".
 */
function isConclusiveRejection(error: unknown): boolean {
  return error instanceof CommandRunnerError && error.code === 'EXIT_NON_ZERO'
}

async function inspectCandidate(
  candidate: string,
  inspectedPaths: Set<string>,
  command: SystemCommandRunner,
  architecture: NodeJS.Architecture,
): Promise<CandidateInspection> {
  const canonical = await canonicalAppCandidate(candidate)
  if (!canonical || inspectedPaths.has(canonical)) return notAMatch
  inspectedPaths.add(canonical)

  const infoPath = path.join(canonical, 'Contents', 'Info.plist')
  try {
    const identifier = propertyValue(await command('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      infoPath,
    ]))
    if (identifier !== bundleIdentifier) return notAMatch

    const executableName = propertyValue(await command('/usr/bin/plutil', [
      '-extract',
      'CFBundleExecutable',
      'raw',
      '-o',
      '-',
      infoPath,
    ]))
    if (
      !executableName
      || executableName === '.'
      || executableName === '..'
      || path.basename(executableName) !== executableName
    ) return notAMatch
    const executablePath = path.join(canonical, 'Contents', 'MacOS', executableName)
    const executableStats = await fs.promises.lstat(executablePath)
    if (!executableStats.isFile() || executableStats.isSymbolicLink() || (executableStats.mode & 0o111) === 0) {
      return notAMatch
    }

    const expectedArchitecture = architecture === 'arm64'
      ? 'arm64'
      : architecture === 'x64'
        ? 'x86_64'
        : null
    if (!expectedArchitecture) return notAMatch
    const architectures = (await command('/usr/bin/lipo', ['-archs', executablePath]))
      .trim()
      .split(/\s+/)
    if (!architectures.includes(expectedArchitecture)) return notAMatch

    const [bundleStats, infoStats] = await Promise.all([
      fs.promises.lstat(canonical),
      fs.promises.lstat(infoPath),
    ])
    const fingerprint = bundleFingerprint(bundleStats, infoStats, executableStats)
    const cached = verifiedBundles.get(canonical)
    const stillVerified = cached !== undefined
      && cached.fingerprint === fingerprint
      && Date.now() - cached.verifiedAt < verificationCacheTtlMs
    if (!stillVerified) {
      await command('/usr/bin/codesign', darwinDeveloperIdVerificationArgv(
        openAiTeamIdentifier,
        canonical,
        { bundleIdentifier, deep: true },
      ))
      // Only a pass is remembered. A failure must be retried on the next scan, or a
      // single transient error would be cached as if the bundle were rejected.
      verifiedBundles.set(canonical, { fingerprint, verifiedAt: Date.now() })
    }

    let version: string | null = null
    try {
      version = versionValue(await command('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        infoPath,
      ]))
    } catch {
      // A valid bundle remains installed when its optional display version is unavailable.
    }
    return { app: { path: canonical, version }, detectionFailed: false, detectionError: null }
  } catch (error) {
    if (isConclusiveRejection(error)) return notAMatch
    return { app: null, detectionFailed: true, detectionError: describeProbeFailure(error) }
  }
}

async function isCodexRunning(command: SystemCommandRunner): Promise<boolean> {
  try {
    return (await command('/usr/bin/osascript', [
      '-e',
      'application id "com.openai.codex" is running',
    ])).trim() === 'true'
  } catch {
    return false
  }
}

export async function inspectMacosCodexApp(
  options: MacosCodexAppInspectionOptions = {},
): Promise<MacosCodexAppInspection> {
  const command = options.runSystemCommand ?? runSystemCommand
  const architecture = options.architecture ?? process.arch
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const systemApplicationsDirectory = options.systemApplicationsDirectory ?? '/Applications'
  const inspectedPaths = new Set<string>()
  const standardCandidates = [
    standardCandidate(systemApplicationsDirectory),
    standardCandidate(homeDirectory && path.join(homeDirectory, 'Applications')),
  ]
  // Collects every execution failure seen along the way so a definitive match
  // found later still wins outright, while an inconclusive scan reports every
  // check that never produced an answer instead of only the last one.
  const failures = new Set<string>()

  for (const candidate of standardCandidates) {
    if (!candidate) continue
    const inspected = await inspectCandidate(candidate, inspectedPaths, command, architecture)
    if (inspected.app) {
      return {
        app: { ...inspected.app, running: await isCodexRunning(command) },
        detectionFailed: false,
        detectionError: null,
      }
    }
    if (inspected.detectionError) failures.add(inspected.detectionError)
  }

  let spotlightOutput: string
  try {
    spotlightOutput = await command('/usr/bin/mdfind', [
      'kMDItemCFBundleIdentifier == "com.openai.codex"',
    ])
  } catch (error) {
    // Spotlight is the only way this function discovers a bundle outside the
    // two standard directories; if it cannot even be queried, the scan has
    // not actually ruled anything out.
    failures.add(describeProbeFailure(error))
    return { app: null, detectionFailed: true, detectionError: [...failures].join('；') }
  }

  for (const candidate of spotlightOutput.split('\n').map((line) => line.replace(/\r$/, ''))) {
    const inspected = await inspectCandidate(candidate, inspectedPaths, command, architecture)
    if (inspected.app) {
      return {
        app: { ...inspected.app, running: await isCodexRunning(command) },
        detectionFailed: false,
        detectionError: null,
      }
    }
    if (inspected.detectionError) failures.add(inspected.detectionError)
  }

  return {
    app: null,
    detectionFailed: failures.size > 0,
    detectionError: failures.size > 0 ? [...failures].join('；') : null,
  }
}
