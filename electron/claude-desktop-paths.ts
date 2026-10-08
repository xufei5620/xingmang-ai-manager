import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeDesktopStoreVirtualization } from './claude-desktop-manifest'

export interface ClaudeDesktopPaths {
  profileDirectory: string
  developerDirectories: string[]
}

export interface ClaudeDesktopPathOptions {
  platform: NodeJS.Platform
  userHome: string
  env?: NodeJS.ProcessEnv
  /** Executable returned by the verified Claude runtime resolver, not renderer input. */
  installationPath?: string | null
  /** Read from this installation's manifest; never inferred from leftover directories. */
  storeVirtualization?: ClaudeDesktopStoreVirtualization
  pathExists?: (candidate: string) => boolean
}

function absoluteDirectory(value: string, name: string, platform: NodeJS.Platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!value || /[\x00-\x1f]/.test(value) || !paths.isAbsolute(value)
    || (platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value))) {
    throw new Error(`Claude Desktop 的 ${name} 必须是绝对目录`)
  }
  return paths.normalize(value)
}

// Test/development homes must never inherit the operator's real AppData paths.
function pathEnvironment(options: Pick<ClaudeDesktopPathOptions, 'platform' | 'env'>, userHome: string): NodeJS.ProcessEnv {
  const sameHome = options.platform === 'win32'
    ? userHome.toLowerCase() === path.win32.normalize(os.homedir()).toLowerCase()
    : userHome === os.homedir()
  return options.env ?? (sameHome ? process.env : {})
}

function storePackageCache(paths: typeof path.win32, local: string): string {
  return paths.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache')
}

/** The active installation decides MSIX virtualization; leftover directories do not. */
export function resolveClaudeDesktopPaths(options: ClaudeDesktopPathOptions): ClaudeDesktopPaths {
  const { platform } = options
  const paths = platform === 'win32' ? path.win32 : path.posix
  const userHome = absoluteDirectory(options.userHome, '用户目录', platform)
  const env = pathEnvironment(options, userHome)
  if (env.CLAUDE_USER_DATA_DIR) {
    const directory = absoluteDirectory(env.CLAUDE_USER_DATA_DIR, 'CLAUDE_USER_DATA_DIR', platform)
    return { profileDirectory: directory, developerDirectories: [directory] }
  }
  const directoryFromEnv = (key: string, fallback: string) => env[key]
    ? absoluteDirectory(env[key]!, key, platform)
    : fallback

  if (platform === 'win32') {
    const local = directoryFromEnv('LOCALAPPDATA', paths.join(userHome, 'AppData', 'Local'))
    const roaming = directoryFromEnv('APPDATA', paths.join(userHome, 'AppData', 'Roaming'))
    let profileDirectory = paths.join(local, 'Claude-3p')
    let legacyDirectory = paths.join(roaming, 'Claude-3p')
    let developerDirectory = paths.join(roaming, 'Claude')
    const executable = options.installationPath?.replace(/\//g, '\\') ?? ''
    if (/\\WindowsApps\\Claude_\d+(?:\.\d+){3}_(?:x64|arm64|neutral)__pzs8sxrjxfjjc\\app\\Claude\.exe$/i.test(executable)) {
      const virtualization = options.storeVirtualization
      if (!virtualization || typeof virtualization.localProfileVirtualized !== 'boolean'
        || typeof virtualization.roamingProfileVirtualized !== 'boolean' || typeof virtualization.roamingDeveloperVirtualized !== 'boolean') {
        throw new Error('Claude Desktop 商店版目录规则尚未核实，请重新检测安装包清单后重试')
      }
      const cache = storePackageCache(paths, local)
      if (virtualization.localProfileVirtualized) profileDirectory = paths.join(cache, 'Local', 'Claude-3p')
      if (virtualization.roamingProfileVirtualized) legacyDirectory = paths.join(cache, 'Roaming', 'Claude-3p')
      if (virtualization.roamingDeveloperVirtualized) developerDirectory = paths.join(cache, 'Roaming', 'Claude')
    }
    const exists = options.pathExists ?? fs.existsSync
    // Creating Local first would suppress Claude's own Roaming-to-Local migration.
    if (!exists(profileDirectory) && exists(legacyDirectory)) {
      throw new Error('检测到 Claude Desktop 旧版配置目录，请先打开一次 Claude Desktop 完成配置迁移，再完全退出后保存配置')
    }
    return { profileDirectory, developerDirectories: [developerDirectory, profileDirectory] }
  }
  const root = platform === 'darwin'
    ? paths.join(userHome, 'Library', 'Application Support')
    : directoryFromEnv('XDG_CONFIG_HOME', paths.join(userHome, '.config'))
  const profileDirectory = paths.join(root, 'Claude-3p')
  return { profileDirectory, developerDirectories: [paths.join(root, 'Claude'), profileDirectory] }
}

/**
 * 星芒可能写过第三方推理配置的每一个目录，不管现在装的是哪一版：开机修复老配置时还没
 * 盘点安装（Windows 上那要起 PowerShell 读安装包清单），所以商店版目录虚拟化前后的两处
 * 都列上，由调用方拿工具箱自己的归属记录去认领。只给目录，不看存在与否，也不报「旧版
 * 目录待迁移」：认领不到的目录调用方一个字不写。环境变量不是绝对目录的那一项直接跳过，
 * 保存配置时它同样会被拒，星芒不可能在那里写过。
 */
export function listClaudeDesktopProfileCandidates(options: Pick<ClaudeDesktopPathOptions, 'platform' | 'userHome' | 'env'>): string[] {
  const { platform } = options
  const paths = platform === 'win32' ? path.win32 : path.posix
  const userHome = absoluteDirectory(options.userHome, '用户目录', platform)
  const env = pathEnvironment(options, userHome)
  const candidates: string[] = []
  function add(build: () => string): void {
    try { candidates.push(build()) } catch { /* Not an absolute directory: nothing could have been saved there. */ }
  }
  const directoryFromEnv = (key: string, fallback: string) => env[key] ? absoluteDirectory(env[key]!, key, platform) : fallback
  if (env.CLAUDE_USER_DATA_DIR) add(() => absoluteDirectory(env.CLAUDE_USER_DATA_DIR!, 'CLAUDE_USER_DATA_DIR', platform))
  if (platform === 'win32') {
    const local = () => directoryFromEnv('LOCALAPPDATA', paths.join(userHome, 'AppData', 'Local'))
    add(() => paths.join(local(), 'Claude-3p'))
    add(() => paths.join(storePackageCache(paths, local()), 'Local', 'Claude-3p'))
  } else if (platform === 'darwin') {
    add(() => paths.join(userHome, 'Library', 'Application Support', 'Claude-3p'))
  } else {
    add(() => paths.join(directoryFromEnv('XDG_CONFIG_HOME', paths.join(userHome, '.config')), 'Claude-3p'))
  }
  const seen = new Set<string>()
  return candidates.filter((directory) => {
    const key = platform === 'win32' ? directory.toLowerCase() : directory
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
