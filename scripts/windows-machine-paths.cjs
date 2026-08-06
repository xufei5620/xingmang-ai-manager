const fs = require('node:fs')
const path = require('node:path')

const SYSTEM_ROOT_DEVICE_PATH = '\\\\?\\GLOBALROOT\\SystemRoot'

function pathError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}

function absoluteWindowsDirectory(value, label) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!candidate || candidate.includes('\0') || !path.win32.isAbsolute(candidate)) {
    throw pathError('WINDOWS_SYSTEM_ROOT_UNTRUSTED', `无法解析可信的 Windows ${label} 目录`)
  }
  return path.win32.normalize(candidate).replace(/[\\/]$/, '')
}

function loadedSharedObjects() {
  try {
    const report = process.report.getReport()
    return Array.isArray(report.sharedObjects)
      ? report.sharedObjects.filter((entry) => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

function deriveWindowsSystemRoot(sharedObjects) {
  const candidates = new Map()
  for (const filePath of sharedObjects) {
    if (typeof filePath !== 'string' || !path.win32.isAbsolute(filePath)) continue
    const fileName = path.win32.basename(filePath).toLowerCase()
    if (fileName !== 'ntdll.dll' && fileName !== 'kernel32.dll') continue
    const system32 = path.win32.dirname(filePath)
    if (path.win32.basename(system32).toLowerCase() !== 'system32') continue
    const root = path.win32.dirname(system32)
    const key = root.toLowerCase()
    const modules = candidates.get(key) || new Set()
    modules.add(fileName)
    candidates.set(key, modules)
    if (modules.has('ntdll.dll') && modules.has('kernel32.dll')) {
      return absoluteWindowsDirectory(root, 'SystemRoot')
    }
  }
  throw pathError(
    'WINDOWS_SYSTEM_ROOT_UNTRUSTED',
    '无法从已加载的 Windows 核心模块解析真实 SystemRoot',
  )
}

function systemRootFromObjectManager(realpathSystemRoot = fs.realpathSync.native) {
  try {
    return absoluteWindowsDirectory(realpathSystemRoot(SYSTEM_ROOT_DEVICE_PATH), 'SystemRoot')
  } catch (cause) {
    throw pathError(
      'WINDOWS_SYSTEM_ROOT_UNTRUSTED',
      '无法通过 Windows 核心模块或系统设备路径解析真实 SystemRoot',
      cause,
    )
  }
}

function resolveWindowsSystemRoot(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') {
    throw pathError('WINDOWS_PLATFORM_UNSUPPORTED', 'Windows 机器路径解析仅支持 Windows')
  }
  try {
    return deriveWindowsSystemRoot(options.sharedObjects || loadedSharedObjects())
  } catch {
    return systemRootFromObjectManager(options.realpathSystemRoot)
  }
}

function pathWithinWindowsRoot(candidate, root) {
  if (!path.win32.isAbsolute(candidate) || !path.win32.isAbsolute(root)) return false
  const candidateKey = path.win32.normalize(candidate).replace(/[\\/]+$/, '').toLowerCase()
  const rootKey = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase()
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`)
}

function resolveTrustedWindowsPowerShell(options = {}) {
  const systemRoot = resolveWindowsSystemRoot(options)
  const system32 = path.win32.join(systemRoot, 'System32')
  const candidate = path.win32.join(
    system32,
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const lstatSync = options.lstatSync || fs.lstatSync
  const realpathSync = options.realpathSync || fs.realpathSync.native
  try {
    const stats = lstatSync(candidate)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('not a regular file')
    const executable = path.win32.normalize(realpathSync(candidate))
    if (!pathWithinWindowsRoot(executable, system32)) throw new Error('canonical path escaped System32')
    return { systemRoot, system32, executable }
  } catch (cause) {
    throw pathError(
      'TRUSTED_POWERSHELL_MISSING',
      '未找到可信的系统 Windows PowerShell，已停止发布签名校验',
      cause,
    )
  }
}

module.exports = {
  SYSTEM_ROOT_DEVICE_PATH,
  deriveWindowsSystemRoot,
  pathWithinWindowsRoot,
  resolveTrustedWindowsPowerShell,
  resolveWindowsSystemRoot,
}
