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

/** The active installation decides MSIX virtualization; leftover directories do not. */
export function resolveClaudeDesktopPaths(options: ClaudeDesktopPathOptions): ClaudeDesktopPaths {
  const { platform } = options
  const paths = platform === 'win32' ? path.win32 : path.posix
  const userHome = absoluteDirectory(options.userHome, '用户目录', platform)
  // Test/development homes must never inherit the operator's real AppData paths.
  const sameHome = platform === 'win32'
    ? userHome.toLowerCase() === path.win32.normalize(os.homedir()).toLowerCase()
    : userHome === os.homedir()
  const env = options.env ?? (sameHome ? process.env : {})
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
      const cache = paths.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache')
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
