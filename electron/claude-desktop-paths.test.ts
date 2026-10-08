import { describe, expect, it } from 'vitest'
import { listClaudeDesktopProfileCandidates, resolveClaudeDesktopPaths } from './claude-desktop-paths'

const windowsHome = 'C:\\Users\\fixture'
const windowsOptions = { platform: 'win32' as const, userHome: windowsHome, env: {}, pathExists: () => false }
const storeExecutable = 'C:\\Program Files\\WindowsApps\\Claude_2.2553.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'
const storeVirtualization = { localProfileVirtualized: true, roamingProfileVirtualized: true, roamingDeveloperVirtualized: true }

describe('resolveClaudeDesktopPaths', () => {
  it('selects Local for inference and Roaming for first-party developer settings', () => {
    expect(resolveClaudeDesktopPaths(windowsOptions)).toEqual({
      profileDirectory: 'C:\\Users\\fixture\\AppData\\Local\\Claude-3p',
      developerDirectories: ['C:\\Users\\fixture\\AppData\\Roaming\\Claude', 'C:\\Users\\fixture\\AppData\\Local\\Claude-3p'],
    })
  })

  it('uses MSIX virtualization only for the verified active Store executable', () => {
    const root = 'C:\\Users\\fixture\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache'
    expect(resolveClaudeDesktopPaths({ ...windowsOptions, installationPath: storeExecutable, storeVirtualization })).toEqual({
      profileDirectory: `${root}\\Local\\Claude-3p`,
      developerDirectories: [`${root}\\Roaming\\Claude`, `${root}\\Local\\Claude-3p`],
    })
  })

  it('requires verified manifest routing for Store installations', () => {
    expect(() => resolveClaudeDesktopPaths({ ...windowsOptions, installationPath: storeExecutable })).toThrow('目录规则尚未核实')
  })

  it('keeps the current Store third-party profile outside the virtual cache', () => {
    expect(resolveClaudeDesktopPaths({
      ...windowsOptions, installationPath: storeExecutable,
      storeVirtualization: { ...storeVirtualization, localProfileVirtualized: false },
    })).toEqual({
      profileDirectory: 'C:\\Users\\fixture\\AppData\\Local\\Claude-3p',
      developerDirectories: [
        'C:\\Users\\fixture\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude',
        'C:\\Users\\fixture\\AppData\\Local\\Claude-3p',
      ],
    })
  })

  it('keeps all paths unvirtualized when the manifest disables filesystem virtualization', () => {
    expect(resolveClaudeDesktopPaths({
      ...windowsOptions, installationPath: storeExecutable,
      storeVirtualization: { localProfileVirtualized: false, roamingProfileVirtualized: false, roamingDeveloperVirtualized: false },
    })).toEqual(resolveClaudeDesktopPaths(windowsOptions))
  })

  it('does not use a stale virtual Local profile instead of the excluded current profile', () => {
    expect(resolveClaudeDesktopPaths({
      ...windowsOptions, installationPath: storeExecutable,
      storeVirtualization: { ...storeVirtualization, localProfileVirtualized: false },
      pathExists: (candidate) => candidate.includes('LocalCache\\Local'),
    }).profileDirectory).toBe('C:\\Users\\fixture\\AppData\\Local\\Claude-3p')
  })

  it('checks migration from the separately virtualized legacy Roaming profile', () => {
    expect(() => resolveClaudeDesktopPaths({
      ...windowsOptions, installationPath: storeExecutable,
      storeVirtualization: { ...storeVirtualization, localProfileVirtualized: false },
      pathExists: (candidate) => candidate.endsWith('LocalCache\\Roaming\\Claude-3p'),
    })).toThrow('先打开一次 Claude Desktop')
  })

  it('does not prefer leftover Store directories over an ordinary installation', () => {
    expect(resolveClaudeDesktopPaths({
      ...windowsOptions, installationPath: 'C:\\Users\\fixture\\AppData\\Local\\AnthropicClaude\\Claude.exe',
      pathExists: () => true,
    }).profileDirectory).toBe('C:\\Users\\fixture\\AppData\\Local\\Claude-3p')
  })

  it('requires the known Store publisher and app executable suffix', () => {
    for (const executable of [storeExecutable.replace('pzs8sxrjxfjjc', 'unknown'), storeExecutable.replace('Claude.exe', 'Other.exe')]) {
      expect(resolveClaudeDesktopPaths({ ...windowsOptions, installationPath: executable }).profileDirectory).not.toContain('Packages')
    }
  })

  it('uses explicit redirected AppData roots', () => {
    expect(resolveClaudeDesktopPaths({ ...windowsOptions, env: { LOCALAPPDATA: 'D:\\Local', APPDATA: 'D:\\Roaming' } })).toEqual({
      profileDirectory: 'D:\\Local\\Claude-3p', developerDirectories: ['D:\\Roaming\\Claude', 'D:\\Local\\Claude-3p'],
    })
  })

  it('does not create Local first when Claude still needs to migrate Roaming data', () => {
    expect(() => resolveClaudeDesktopPaths({ ...windowsOptions, pathExists: (candidate) => candidate.includes('Roaming') })).toThrow('先打开一次 Claude Desktop')
  })

  it('does not reject an already migrated profile because the legacy directory remains', () => {
    expect(resolveClaudeDesktopPaths({ ...windowsOptions, pathExists: () => true }).profileDirectory).toContain('Local\\Claude-3p')
  })

  it('resolves macOS paths independently of the host platform', () => {
    expect(resolveClaudeDesktopPaths({ platform: 'darwin', userHome: '/Users/fixture', env: {} })).toEqual({
      profileDirectory: '/Users/fixture/Library/Application Support/Claude-3p',
      developerDirectories: ['/Users/fixture/Library/Application Support/Claude', '/Users/fixture/Library/Application Support/Claude-3p'],
    })
  })

  it('honors Linux XDG config paths', () => {
    expect(resolveClaudeDesktopPaths({ platform: 'linux', userHome: '/home/fixture', env: { XDG_CONFIG_HOME: '/data/settings' } })).toEqual({
      profileDirectory: '/data/settings/Claude-3p', developerDirectories: ['/data/settings/Claude', '/data/settings/Claude-3p'],
    })
  })

  it('honors an explicit user data directory for both deployment modes', () => {
    expect(resolveClaudeDesktopPaths({ ...windowsOptions, env: { CLAUDE_USER_DATA_DIR: 'D:\\ClaudeProfile' } })).toEqual({
      profileDirectory: 'D:\\ClaudeProfile', developerDirectories: ['D:\\ClaudeProfile'],
    })
    expect(resolveClaudeDesktopPaths({ ...windowsOptions, installationPath: storeExecutable, env: { CLAUDE_USER_DATA_DIR: 'D:\\ClaudeProfile' } }).profileDirectory).toBe('D:\\ClaudeProfile')
  })

  it('rejects relative or drive-relative environment paths', () => {
    for (const value of ['relative', 'C:relative', '\\relative']) {
      expect(() => resolveClaudeDesktopPaths({ ...windowsOptions, env: { CLAUDE_USER_DATA_DIR: value } })).toThrow('绝对目录')
      expect(() => resolveClaudeDesktopPaths({ ...windowsOptions, env: { LOCALAPPDATA: value } })).toThrow('绝对目录')
    }
    expect(() => resolveClaudeDesktopPaths({ platform: 'linux', userHome: '/home/fixture', env: { XDG_CONFIG_HOME: 'relative' } })).toThrow('绝对目录')
  })

  it('isolates an injected home without requiring tests to sanitize the host environment', () => {
    expect(resolveClaudeDesktopPaths({ platform: 'win32', userHome: windowsHome, pathExists: () => false }).profileDirectory).toBe('C:\\Users\\fixture\\AppData\\Local\\Claude-3p')
  })
})

describe('listClaudeDesktopProfileCandidates', () => {
  it('lists both Windows profiles a save could have used, whichever edition is installed now', () => {
    const candidates = listClaudeDesktopProfileCandidates(windowsOptions)
    expect(candidates).toEqual([
      'C:\\Users\\fixture\\AppData\\Local\\Claude-3p',
      'C:\\Users\\fixture\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\Claude-3p',
    ])
    for (const virtualization of [undefined, storeVirtualization]) {
      const options = virtualization ? { ...windowsOptions, installationPath: storeExecutable, storeVirtualization: virtualization } : windowsOptions
      expect(candidates).toContain(resolveClaudeDesktopPaths(options).profileDirectory)
    }
  })

  it('puts an explicit Claude data directory first and follows the profile environment variables', () => {
    expect(listClaudeDesktopProfileCandidates({ ...windowsOptions, env: { CLAUDE_USER_DATA_DIR: 'D:\\Claude', LOCALAPPDATA: 'E:\\Local' } })).toEqual([
      'D:\\Claude', 'E:\\Local\\Claude-3p', 'E:\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\Claude-3p',
    ])
    expect(listClaudeDesktopProfileCandidates({ platform: 'darwin', userHome: '/Users/fixture', env: {} }))
      .toEqual(['/Users/fixture/Library/Application Support/Claude-3p'])
    expect(listClaudeDesktopProfileCandidates({ platform: 'linux', userHome: '/home/fixture', env: { XDG_CONFIG_HOME: '/srv/config' } }))
      .toEqual(['/srv/config/Claude-3p'])
  })

  it('skips variables a save would have rejected instead of failing the whole list', () => {
    expect(listClaudeDesktopProfileCandidates({ ...windowsOptions, env: { CLAUDE_USER_DATA_DIR: 'relative\\dir', LOCALAPPDATA: 'nowhere' } })).toEqual([])
    expect(listClaudeDesktopProfileCandidates({ platform: 'darwin', userHome: '/Users/fixture', env: { CLAUDE_USER_DATA_DIR: 'relative' } }))
      .toEqual(['/Users/fixture/Library/Application Support/Claude-3p'])
  })
})
