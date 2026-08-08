import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'

const execFileAsync = promisify(execFile)
const bundleIdentifier = 'com.openai.codex'
const openAiTeamIdentifier = '2DC432GLL2'
const maximumInfoPlistBytes = 1024 * 1024
const maximumCommandOutputBytes = 64 * 1024
const commandTimeoutMs = 5_000

export interface MacosCodexAppInfo {
  path: string
  version: string | null
  running: boolean
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

async function runSystemCommand(executable: string, argv: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(executable, [...argv], {
    encoding: 'utf8',
    shell: false,
    timeout: commandTimeoutMs,
    maxBuffer: maximumCommandOutputBytes,
    windowsHide: true,
  })
  return executable === '/usr/bin/codesign' ? `${stdout}\n${stderr}` : stdout
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

async function inspectCandidate(
  candidate: string,
  inspectedPaths: Set<string>,
  command: SystemCommandRunner,
  architecture: NodeJS.Architecture,
): Promise<{ path: string, version: string | null } | null> {
  const canonical = await canonicalAppCandidate(candidate)
  if (!canonical || inspectedPaths.has(canonical)) return null
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
    if (identifier !== bundleIdentifier) return null

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
    ) return null
    const executablePath = path.join(canonical, 'Contents', 'MacOS', executableName)
    const executableStats = await fs.promises.lstat(executablePath)
    if (!executableStats.isFile() || executableStats.isSymbolicLink() || (executableStats.mode & 0o111) === 0) {
      return null
    }

    const expectedArchitecture = architecture === 'arm64'
      ? 'arm64'
      : architecture === 'x64'
        ? 'x86_64'
        : null
    if (!expectedArchitecture) return null
    const architectures = (await command('/usr/bin/lipo', ['-archs', executablePath]))
      .trim()
      .split(/\s+/)
    if (!architectures.includes(expectedArchitecture)) return null

    await command('/usr/bin/codesign', darwinDeveloperIdVerificationArgv(
      openAiTeamIdentifier,
      canonical,
      { bundleIdentifier, deep: true },
    ))

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
    return { path: canonical, version }
  } catch {
    return null
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
): Promise<MacosCodexAppInfo | null> {
  const command = options.runSystemCommand ?? runSystemCommand
  const architecture = options.architecture ?? process.arch
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const systemApplicationsDirectory = options.systemApplicationsDirectory ?? '/Applications'
  const inspectedPaths = new Set<string>()
  const standardCandidates = [
    standardCandidate(systemApplicationsDirectory),
    standardCandidate(homeDirectory && path.join(homeDirectory, 'Applications')),
  ]

  for (const candidate of standardCandidates) {
    if (!candidate) continue
    const app = await inspectCandidate(candidate, inspectedPaths, command, architecture)
    if (app) return { ...app, running: await isCodexRunning(command) }
  }

  let spotlightOutput: string
  try {
    spotlightOutput = await command('/usr/bin/mdfind', [
      'kMDItemCFBundleIdentifier == "com.openai.codex"',
    ])
  } catch {
    return null
  }

  for (const candidate of spotlightOutput.split('\n').map((line) => line.replace(/\r$/, ''))) {
    const app = await inspectCandidate(candidate, inspectedPaths, command, architecture)
    if (app) return { ...app, running: await isCodexRunning(command) }
  }
  return null
}
