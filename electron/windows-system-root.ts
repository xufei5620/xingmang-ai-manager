import fs from 'node:fs'
import path from 'node:path'

// The one place that decides which directory is the real Windows SystemRoot.
// windows-machine-paths.ts builds every machine path on it, and the release
// gate (scripts/windows-machine-paths.cjs) uses it to find the PowerShell that
// checks installer signatures. They used to carry a copy each, and the copies
// drifted on a root holding a NUL (#1225).
//
// Leaf module on purpose: the release gate has to run without a compiled main
// process, so it loads this file straight from source and lets it require
// node: built-ins and nothing else. Keep it that way.

export const SYSTEM_ROOT_DEVICE_PATH = '\\\\?\\GLOBALROOT\\SystemRoot'

export interface WindowsSystemRootOptions {
  platform?: NodeJS.Platform
  sharedObjects?: readonly string[]
  /** Answers the object-manager lookup in place of fs.realpathSync.native (the release gate's tests). */
  realpathSystemRoot?: (devicePath: string) => string
}

export function absoluteWindowsDirectory(value: string | null | undefined, label: string): string {
  const candidate = value?.trim()
  if (!candidate || candidate.includes('\0') || !path.win32.isAbsolute(candidate)) {
    throw new Error(`无法解析可信的 Windows ${label} 目录`)
  }
  return path.win32.normalize(candidate).replace(/[\\/]$/, '')
}

function systemRootFromObjectManager(realpathSystemRoot?: (devicePath: string) => string): string {
  try {
    return realpathSystemRoot
      ? realpathSystemRoot(SYSTEM_ROOT_DEVICE_PATH)
      : fs.realpathSync.native(SYSTEM_ROOT_DEVICE_PATH)
  } catch {
    throw new Error('无法通过 Windows 系统设备路径解析真实 SystemRoot')
  }
}

function loadedSharedObjects(): readonly string[] {
  try {
    const report = process.report.getReport() as { sharedObjects?: unknown }
    return Array.isArray(report.sharedObjects)
      ? report.sharedObjects.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function deriveWindowsSystemRoot(
  options: Pick<WindowsSystemRootOptions, 'platform' | 'sharedObjects'> = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Windows 真实系统目录解析仅支持 Windows')
  const candidates = new Map<string, Set<string>>()
  for (const filePath of options.sharedObjects ?? loadedSharedObjects()) {
    if (!path.win32.isAbsolute(filePath)) continue
    const fileName = path.win32.basename(filePath).toLowerCase()
    if (fileName !== 'ntdll.dll' && fileName !== 'kernel32.dll') continue
    const system32 = path.win32.dirname(filePath)
    if (path.win32.basename(system32).toLowerCase() !== 'system32') continue
    const root = path.win32.dirname(system32)
    const key = root.toLowerCase()
    const modules = candidates.get(key) ?? new Set<string>()
    modules.add(fileName)
    candidates.set(key, modules)
    if (modules.has('ntdll.dll') && modules.has('kernel32.dll')) return path.win32.normalize(root)
  }
  throw new Error('无法从已加载的 Windows 核心模块解析真实系统目录')
}

/**
 * The loaded core modules name SystemRoot when they can; the object manager
 * is asked only when they name nothing. Whichever answered is then held to the
 * absolute-directory check, outside that fallback: a root the core modules do
 * name but the check rejects is refused, not traded for a second opinion.
 */
export function resolveWindowsSystemRoot(options: WindowsSystemRootOptions = {}): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Windows 真实系统目录解析仅支持 Windows')
  let systemRoot: string
  try {
    systemRoot = deriveWindowsSystemRoot(options)
  } catch {
    systemRoot = systemRootFromObjectManager(options.realpathSystemRoot)
  }
  return absoluteWindowsDirectory(systemRoot, 'SystemRoot')
}

export function pathWithinWindowsRoot(candidate: string, root: string): boolean {
  if (!path.win32.isAbsolute(candidate) || !path.win32.isAbsolute(root)) return false
  const candidateKey = path.win32.normalize(candidate).replace(/[\\/]+$/, '').toLowerCase()
  const rootKey = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase()
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`)
}
