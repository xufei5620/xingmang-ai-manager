import { describe, expect, it } from 'vitest'
import { providerConfigDirectoryNames } from './catalog'
import {
  buildSensitiveWorkspacePrompt,
  classifyWorkspace,
  sensitiveWorkspaceLabel,
  sensitiveWorkspacePolicy,
  type SensitiveWorkspaceKind,
  type WorkspaceGuardContext,
} from './workspace-guard'

const allKinds: readonly SensitiveWorkspaceKind[] = [
  'home', 'drive-root', 'desktop', 'downloads', 'documents',
  'users-root', 'onedrive-root', 'app-data', 'system', 'provider-config',
]

const windowsContext: WorkspaceGuardContext = { platform: 'win32', home: 'C:\\Users\\peaker' }
const macContext: WorkspaceGuardContext = { platform: 'darwin', home: '/Users/alex' }

describe('classifyWorkspace on Windows', () => {
  it('treats the user home directory as sensitive', () => {
    expect(classifyWorkspace('C:\\Users\\peaker', windowsContext)).toBe('home')
    expect(classifyWorkspace('C:\\Users\\peaker\\', windowsContext)).toBe('home')
    expect(classifyWorkspace('c:\\users\\PEAKER', windowsContext)).toBe('home')
  })

  it('treats any drive root as sensitive', () => {
    expect(classifyWorkspace('C:\\', windowsContext)).toBe('drive-root')
    expect(classifyWorkspace('D:\\', windowsContext)).toBe('drive-root')
    expect(classifyWorkspace('D:/', windowsContext)).toBe('drive-root')
    expect(classifyWorkspace('\\\\server\\share', windowsContext)).toBe('drive-root')
  })

  it('treats desktop, downloads and documents as sensitive', () => {
    expect(classifyWorkspace('C:\\Users\\peaker\\Desktop', windowsContext)).toBe('desktop')
    expect(classifyWorkspace('C:\\Users\\peaker\\downloads', windowsContext)).toBe('downloads')
    expect(classifyWorkspace('C:\\Users\\peaker\\Documents', windowsContext)).toBe('documents')
  })

  it('follows OneDrive known-folder redirection, including the Chinese folder names', () => {
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive\\Desktop', windowsContext)).toBe('desktop')
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive\\桌面', windowsContext)).toBe('desktop')
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive\\文档', windowsContext)).toBe('documents')
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive - Contoso\\桌面', windowsContext)).toBe('desktop')
  })

  it('keeps ordinary project directories out of the guard', () => {
    expect(classifyWorkspace('C:\\Users\\peaker\\Desktop\\我的项目', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\projects', windowsContext)).toBeNull()
    expect(classifyWorkspace('D:\\work\\app', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDriveStuff', windowsContext)).toBeNull()
  })

  it('treats the folder holding every profile as sensitive, but not its other children', () => {
    expect(classifyWorkspace('C:\\Users', windowsContext)).toBe('users-root')
    expect(classifyWorkspace('c:\\users\\', windowsContext)).toBe('users-root')
    expect(classifyWorkspace('D:\\Users', windowsContext)).toBe('users-root')
    expect(classifyWorkspace('C:\\Users', { platform: 'win32', home: '' })).toBe('users-root')
    expect(classifyWorkspace('C:\\Users\\Public', windowsContext)).toBeNull()
    expect(classifyWorkspace('D:\\Profiles', { platform: 'win32', home: 'D:\\Profiles\\peaker' })).toBe('users-root')
  })

  it('treats the OneDrive root as sensitive, but not the folders inside it', () => {
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive', windowsContext)).toBe('onedrive-root')
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive - Contoso', windowsContext)).toBe('onedrive-root')
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive\\work', windowsContext)).toBeNull()
  })

  it('treats the top-level system folders on any drive as sensitive, but not what is inside them', () => {
    expect(classifyWorkspace('C:\\Windows', windowsContext)).toBe('system')
    expect(classifyWorkspace('C:\\Program Files', windowsContext)).toBe('system')
    expect(classifyWorkspace('C:\\program files (x86)\\', windowsContext)).toBe('system')
    expect(classifyWorkspace('D:\\ProgramData', windowsContext)).toBe('system')
    expect(classifyWorkspace('C:\\Windows\\Temp\\build', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Program Files\\MyTool', windowsContext)).toBeNull()
  })

  it('treats the app-data roots as sensitive, but not a folder inside them', () => {
    expect(classifyWorkspace('C:\\Users\\peaker\\AppData', windowsContext)).toBe('app-data')
    expect(classifyWorkspace('C:\\Users\\peaker\\AppData\\Roaming', windowsContext)).toBe('app-data')
    expect(classifyWorkspace('C:\\Users\\peaker\\appdata\\local', windowsContext)).toBe('app-data')
    expect(classifyWorkspace('C:\\Users\\peaker\\AppData\\LocalLow', windowsContext)).toBe('app-data')
    expect(classifyWorkspace('C:\\Users\\peaker\\AppData\\Local\\Temp', windowsContext)).toBeNull()
  })

  it('treats every CLI configuration folder from the catalog as sensitive', () => {
    for (const folder of Object.values(providerConfigDirectoryNames)) {
      expect(classifyWorkspace(`C:\\Users\\peaker\\${folder}`, windowsContext)).toBe('provider-config')
      expect(classifyWorkspace(`C:\\Users\\peaker\\${folder.toUpperCase()}`, windowsContext)).toBe('provider-config')
      expect(classifyWorkspace(`C:\\Users\\peaker\\${folder}\\projects`, windowsContext)).toBeNull()
    }
  })

  it('keeps the default new-project locations out of the guard, even under OneDrive', () => {
    expect(classifyWorkspace('C:\\Users\\peaker\\Documents\\XingmangProjects\\my-project', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\Documents\\XingmangProjects\\my-project-2', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\XingmangProjects\\my-project', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\XingmangProjects', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive\\Documents\\XingmangProjects\\my-project', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive\\文档\\XingmangProjects\\my-project', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive - Contoso\\Documents\\XingmangProjects\\my-project', windowsContext)).toBeNull()
  })

  it('never mistakes a sibling home directory for the home directory', () => {
    expect(classifyWorkspace('C:\\Users\\peaker2', windowsContext)).toBeNull()
    expect(classifyWorkspace('C:\\Users\\peaker2\\Desktop', windowsContext)).toBeNull()
  })

  it('reports nothing for input it cannot reason about', () => {
    expect(classifyWorkspace('project', windowsContext)).toBeNull()
    expect(classifyWorkspace('', windowsContext)).toBeNull()
    // 主目录读不到时只剩盘根这一类还能判，其余一律按普通目录放行。
    expect(classifyWorkspace('C:\\Users\\peaker\\Desktop', { platform: 'win32', home: '' })).toBeNull()
    expect(classifyWorkspace('C:\\', { platform: 'win32', home: '' })).toBe('drive-root')
  })
})

describe('classifyWorkspace on macOS', () => {
  it('treats the home directory, the boot volume and mounted volumes as sensitive', () => {
    expect(classifyWorkspace('/Users/alex', macContext)).toBe('home')
    expect(classifyWorkspace('/Users/alex/', macContext)).toBe('home')
    expect(classifyWorkspace('/', macContext)).toBe('drive-root')
    expect(classifyWorkspace('/Volumes/Backup', macContext)).toBe('drive-root')
    expect(classifyWorkspace('/Volumes/Backup/projects', macContext)).toBeNull()
  })

  it('treats desktop, downloads and documents as sensitive, case-insensitively', () => {
    expect(classifyWorkspace('/Users/alex/Desktop', macContext)).toBe('desktop')
    expect(classifyWorkspace('/Users/alex/downloads', macContext)).toBe('downloads')
    expect(classifyWorkspace('/Users/alex/Documents', macContext)).toBe('documents')
    expect(classifyWorkspace('/Users/alex/Documents/app', macContext)).toBeNull()
  })

  it('treats /Users, the system folders and ~/Library as sensitive, but not their children', () => {
    expect(classifyWorkspace('/Users', macContext)).toBe('users-root')
    expect(classifyWorkspace('/Users/Shared', macContext)).toBeNull()
    for (const folder of ['/System', '/Library', '/Applications', '/usr', '/bin', '/etc', '/private', '/opt']) {
      expect(classifyWorkspace(folder, macContext)).toBe('system')
    }
    expect(classifyWorkspace('/Applications/MyTool.app', macContext)).toBeNull()
    expect(classifyWorkspace('/usr/local/src/app', macContext)).toBeNull()
    expect(classifyWorkspace('/Users/alex/Library', macContext)).toBe('app-data')
    expect(classifyWorkspace('/Users/alex/Library/Application Support', macContext)).toBeNull()
  })

  it('treats every CLI configuration folder from the catalog as sensitive', () => {
    for (const folder of Object.values(providerConfigDirectoryNames)) {
      expect(classifyWorkspace(`/Users/alex/${folder}`, macContext)).toBe('provider-config')
      expect(classifyWorkspace(`/Users/alex/${folder}/work`, macContext)).toBeNull()
    }
  })

  it('keeps the default new-project locations out of the guard, even when Documents syncs to iCloud', () => {
    expect(classifyWorkspace('/Users/alex/Documents/XingmangProjects/my-project', macContext)).toBeNull()
    expect(classifyWorkspace('/Users/alex/XingmangProjects/my-project', macContext)).toBeNull()
    expect(classifyWorkspace('/Users/alex/XingmangProjects/my-project-2', macContext)).toBeNull()
  })

  it('keeps case significant on platforms whose file systems are case-sensitive', () => {
    const linux: WorkspaceGuardContext = { platform: 'linux', home: '/home/dev' }
    expect(classifyWorkspace('/home/dev/Desktop', linux)).toBe('desktop')
    expect(classifyWorkspace('/home/dev/desktop', linux)).toBeNull()
    expect(classifyWorkspace('/home/DEV', linux)).toBeNull()
  })
})

describe('buildSensitiveWorkspacePrompt', () => {
  it('names the folder and offers a way out without blocking the launch', () => {
    const prompt = buildSensitiveWorkspacePrompt('home')

    expect(prompt.message).toContain(sensitiveWorkspaceLabel('home'))
    expect(prompt.detail).toContain('AGENTS.md')
    expect(prompt.buttons[prompt.continueIndex]).toBe('仍然打开')
    expect(prompt.buttons[prompt.cancelIndex]).toBe('换一个文件夹')
    expect(prompt.continueIndex).not.toBe(prompt.cancelIndex)
  })

  it('offers to create a project folder for users who do not have one yet', () => {
    const prompt = buildSensitiveWorkspacePrompt('desktop')

    expect(prompt.createIndex).toBe(0)
    expect(prompt.buttons[0]).toBe('新建一个项目文件夹')
    expect(new Set([prompt.createIndex, prompt.continueIndex, prompt.cancelIndex]).size).toBe(3)
    expect(prompt.detail).toContain('新建一个项目文件夹')
  })

  it('describes every kind in Chinese', () => {
    for (const kind of allKinds) {
      expect(buildSensitiveWorkspacePrompt(kind).message).toContain(sensitiveWorkspaceLabel(kind))
    }
  })

  it('keeps technical folder names out of what a beginner reads', () => {
    for (const kind of allKinds) {
      const prompt = buildSensitiveWorkspacePrompt(kind)
      const text = [prompt.title, prompt.message, prompt.detail].join('\n')
      expect(text).not.toMatch(/AppData|Library|配置目录|\.claude|\.codex|\.gemini|\.grok/)
    }
  })

  it('asks every time for system and CLI configuration folders and says it will not remember them', () => {
    expect(allKinds.filter((kind) => sensitiveWorkspacePolicy(kind) === 'every-time')).toEqual(['system', 'provider-config'])
    for (const kind of ['system', 'provider-config'] as const) {
      const prompt = buildSensitiveWorkspacePrompt(kind)
      expect(prompt.title).toBe('不建议在这个文件夹里打开')
      expect(prompt.detail).toContain('不会记住')
      expect(prompt.buttons[prompt.cancelIndex]).toBe('换一个文件夹')
    }
    expect(buildSensitiveWorkspacePrompt('provider-config').detail).toContain('密钥')
    expect(buildSensitiveWorkspacePrompt('onedrive-root').title).toBe('这个文件夹范围太大')
  })

  it('offers 先不打开 instead of another folder when a conversation is being resumed', () => {
    const prompt = buildSensitiveWorkspacePrompt('system', { allowChooseAnother: false })
    expect(prompt.buttons).toEqual(['先不打开', '仍然打开'])
    expect(prompt.buttons[prompt.cancelIndex]).toBe('先不打开')
    expect(prompt.buttons[prompt.continueIndex]).toBe('仍然打开')
    expect(prompt.createIndex).toBeNull()
    expect(prompt.detail).not.toContain('新建一个项目文件夹')
  })
})
