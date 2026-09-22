import { describe, expect, it } from 'vitest'
import {
  buildSensitiveWorkspacePrompt,
  classifyWorkspace,
  sensitiveWorkspaceLabel,
  type WorkspaceGuardContext,
} from './workspace-guard'

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
    expect(classifyWorkspace('C:\\Users\\peaker\\OneDrive', windowsContext)).toBeNull()
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

  it('describes every kind in Chinese', () => {
    for (const kind of ['home', 'drive-root', 'desktop', 'downloads', 'documents'] as const) {
      expect(buildSensitiveWorkspacePrompt(kind).message).toContain(sensitiveWorkspaceLabel(kind))
    }
  })
})
