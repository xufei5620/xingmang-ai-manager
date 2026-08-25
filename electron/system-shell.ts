import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { trustedCommandEnvironment } from './command-runner'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

export interface ExternalShellLauncher {
  openExternal(url: string): Promise<void>
  openPath(targetPath: string): Promise<void>
}

export interface WindowsShellLaunchPlan {
  executable: string
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  windowsHide: true
}

interface WindowsExplorerResolutionOptions {
  platform?: NodeJS.Platform
  machinePaths?: WindowsMachinePaths
  isFile?: (candidate: string) => boolean
  realPath?: (candidate: string) => string
}

interface ExternalShellLauncherOptions extends WindowsExplorerResolutionOptions {
  env?: NodeJS.ProcessEnv
  fallbackShell?: Pick<typeof shell, 'openExternal' | 'openPath'>
  launchWindowsPlan?: (plan: WindowsShellLaunchPlan) => Promise<void>
}

function regularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function normalizedWindowsPath(candidate: string): string {
  return path.win32.normalize(candidate).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Resolve Explorer from the trusted SystemRoot itself. Explorer is not located
 * in System32, and neither PATH nor a user-configured file association may
 * participate in locating the broker executable.
 */
export function resolveWindowsExplorerExecutable(
  options: WindowsExplorerResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Windows 外壳代理仅支持 Windows')
  const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
  const expected = path.win32.join(machinePaths.systemRoot, 'explorer.exe')
  const isFile = options.isFile ?? regularFile
  if (!isFile(expected)) throw new Error('未找到受信任的 Windows Explorer')
  let canonical: string
  try {
    canonical = (options.realPath ?? fs.realpathSync.native)(expected)
  } catch {
    throw new Error('无法解析受信任的 Windows Explorer')
  }
  if (normalizedWindowsPath(canonical) !== normalizedWindowsPath(expected)) {
    throw new Error('Windows Explorer 路径经过了符号链接或目录联接，已停止打开')
  }
  return canonical
}

function validatedTarget(kind: 'url' | 'path', target: string): string {
  if (!target.trim() || target.includes('\0') || target.length > 32_767) {
    throw new Error(kind === 'url' ? '外部链接格式错误' : '外部路径格式错误')
  }
  if (kind === 'url') {
    try {
      const url = new URL(target)
      if (
        !['https:', 'ms-windows-store:'].includes(url.protocol)
        || url.username !== ''
        || url.password !== ''
      ) throw new Error('unsupported-protocol')
    } catch {
      throw new Error('外部链接格式错误')
    }
  } else if (!path.win32.isAbsolute(target)) {
    throw new Error('外部路径必须是绝对路径')
  }
  return target
}

export function buildWindowsShellLaunchPlan(
  kind: 'url' | 'path',
  target: string,
  explorerExecutable: string,
  env: NodeJS.ProcessEnv = process.env,
  machinePaths: WindowsMachinePaths = resolveWindowsMachinePaths(),
): WindowsShellLaunchPlan {
  const value = validatedTarget(kind, target)
  const expectedExplorer = path.win32.join(machinePaths.systemRoot, 'explorer.exe')
  if (normalizedWindowsPath(explorerExecutable) !== normalizedWindowsPath(expectedExplorer)) {
    throw new Error('Windows Explorer 启动路径不可信')
  }
  return {
    executable: explorerExecutable,
    argv: [value],
    cwd: machinePaths.systemRoot,
    env: trustedCommandEnvironment(env, machinePaths, 'win32'),
    windowsHide: true,
  }
}

function launchWindowsShell(plan: WindowsShellLaunchPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.argv, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: plan.windowsHide,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * On Windows, hand HTTPS/file association resolution to the interactive
 * Explorer shell instead of invoking ShellExecute from the elevated Electron
 * process. Microsoft Store URIs are the exception: Explorer can report a
 * successful spawn without activating the Store protocol, so the already
 * allowlisted URI must use ShellExecute directly.
 */
export function createExternalShellLauncher(
  options: ExternalShellLauncherOptions = {},
): ExternalShellLauncher {
  const platform = options.platform ?? process.platform
  const fallback = options.fallbackShell ?? shell
  if (platform !== 'win32') {
    return {
      async openExternal(url) {
        await fallback.openExternal(url)
      },
      async openPath(targetPath) {
        const failure = await fallback.openPath(targetPath)
        if (failure) throw new Error(failure)
      },
    }
  }

  const launch = options.launchWindowsPlan ?? launchWindowsShell
  const openExternal = async (url: string) => {
    const target = validatedTarget('url', url)
    if (new URL(target).protocol === 'ms-windows-store:') {
      await fallback.openExternal(target)
      return
    }
    await open('url', target)
  }
  const open = async (kind: 'url' | 'path', target: string) => {
    const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
    const explorerExecutable = resolveWindowsExplorerExecutable({
      platform,
      machinePaths,
      isFile: options.isFile,
      realPath: options.realPath,
    })
    const plan = buildWindowsShellLaunchPlan(
      kind,
      target,
      explorerExecutable,
      options.env,
      machinePaths,
    )
    await launch(plan)
  }
  return {
    openExternal,
    openPath: (targetPath) => open('path', targetPath),
  }
}
