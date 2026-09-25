import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildStarterWorkspaceName,
  createStarterWorkspace,
  resolveNewProjectParent,
  resolveStarterWorkspaceContainer,
  resolveStarterWorkspaceParent,
  starterWorkspaceContainerName,
  type StarterWorkspaceLocationContext,
} from './starter-workspace'
import { classifyWorkspace } from './workspace-guard'

describe('buildStarterWorkspaceName', () => {
  it('keeps names ASCII with no spaces or parentheses', () => {
    expect(buildStarterWorkspaceName(1)).toBe('my-project')
    expect(buildStarterWorkspaceName(2)).toBe('my-project-2')
    expect(buildStarterWorkspaceName(10)).toBe('my-project-10')
    expect(starterWorkspaceContainerName).toMatch(/^[A-Za-z0-9-]+$/)
  })
})

describe('resolveStarterWorkspaceParent', () => {
  function windows(overrides: Partial<StarterWorkspaceLocationContext> = {}): StarterWorkspaceLocationContext {
    return { platform: 'win32', home: 'C:\\Users\\peaker', env: {}, directoryExists: () => true, ...overrides }
  }

  function mac(existing: readonly string[]): StarterWorkspaceLocationContext {
    return { platform: 'darwin', home: '/Users/alex', env: {}, directoryExists: (directory) => existing.includes(directory) }
  }

  it('uses the documents folder when nothing syncs it', () => {
    expect(resolveStarterWorkspaceParent('C:\\Users\\peaker\\Documents', windows())).toBe('C:\\Users\\peaker\\Documents')
    expect(resolveStarterWorkspaceParent('D:\\文档', windows())).toBe('D:\\文档')
    expect(resolveStarterWorkspaceParent('/Users/alex/Documents', mac(['/Users/alex/Documents'])))
      .toBe('/Users/alex/Documents')
  })

  it('falls back to the home folder when OneDrive has taken over documents', () => {
    expect(resolveStarterWorkspaceParent('C:\\Users\\peaker\\OneDrive\\Documents', windows())).toBe('C:\\Users\\peaker')
    expect(resolveStarterWorkspaceParent('C:\\Users\\peaker\\OneDrive\\文档', windows())).toBe('C:\\Users\\peaker')
    expect(resolveStarterWorkspaceParent('C:\\Users\\peaker\\onedrive - Contoso\\Documents', windows())).toBe('C:\\Users\\peaker')
  })

  it('follows OneDrive moved to another drive through its environment variables', () => {
    const context = windows({ env: { OneDriveConsumer: 'D:\\Cloud' } })

    expect(resolveStarterWorkspaceParent('D:\\Cloud\\Documents', context)).toBe('C:\\Users\\peaker')
    expect(resolveStarterWorkspaceParent('d:\\cloud\\documents', context)).toBe('C:\\Users\\peaker')
    expect(resolveStarterWorkspaceParent('D:\\CloudBackup\\Documents', context)).toBe('D:\\CloudBackup\\Documents')
  })

  it('falls back to the home folder when iCloud syncs Desktop & Documents on macOS', () => {
    const synced = mac(['/Users/alex/Documents', '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Documents'])

    expect(resolveStarterWorkspaceParent('/Users/alex/Documents', synced)).toBe('/Users/alex')
  })

  it('falls back to the home folder when documents is missing or unusable', () => {
    expect(resolveStarterWorkspaceParent(null, windows())).toBe('C:\\Users\\peaker')
    expect(resolveStarterWorkspaceParent('Documents', windows())).toBe('C:\\Users\\peaker')
    expect(resolveStarterWorkspaceParent('/Users/alex/Documents', mac([]))).toBe('/Users/alex')
  })

  it('never lands a starter folder inside the sensitive-workspace guard', () => {
    const cases: Array<[string, StarterWorkspaceLocationContext]> = [
      ['C:\\Users\\peaker\\Documents', windows()],
      ['C:\\Users\\peaker\\OneDrive\\文档', windows()],
      ['/Users/alex/Documents', mac(['/Users/alex/Documents'])],
      ['/Users/alex/Documents', mac([])],
    ]
    for (const [documents, context] of cases) {
      const parent = resolveStarterWorkspaceParent(documents, context)
      const container = resolveStarterWorkspaceContainer(parent, context.platform)
      const impl = context.platform === 'win32' ? path.win32 : path.posix
      expect(classifyWorkspace(impl.join(container, buildStarterWorkspaceName(3)), context)).toBeNull()
    }
  })
})

describe('resolveNewProjectParent', () => {
  function mac(existing: readonly string[]): StarterWorkspaceLocationContext {
    return { platform: 'darwin', home: '/Users/alex', env: {}, directoryExists: (directory) => existing.includes(directory) }
  }

  it('puts new projects in the home folder on macOS so Terminal needs no Documents permission', () => {
    expect(resolveNewProjectParent('/Users/alex/Documents', mac(['/Users/alex/Documents']))).toBe('/Users/alex')
    expect(resolveNewProjectParent(null, mac([]))).toBe('/Users/alex')
    const container = resolveStarterWorkspaceContainer(resolveNewProjectParent('/Users/alex/Documents', mac(['/Users/alex/Documents'])), 'darwin')
    expect(container).toBe('/Users/alex/XingmangProjects')
    expect(classifyWorkspace(path.posix.join(container, buildStarterWorkspaceName(1)), mac([]))).toBeNull()
  })

  it('keeps the documents folder on Windows', () => {
    const windows: StarterWorkspaceLocationContext = { platform: 'win32', home: 'C:\\Users\\peaker', env: {}, directoryExists: () => true }

    expect(resolveNewProjectParent('C:\\Users\\peaker\\Documents', windows)).toBe('C:\\Users\\peaker\\Documents')
    expect(resolveNewProjectParent('C:\\Users\\peaker\\OneDrive\\Documents', windows)).toBe('C:\\Users\\peaker')
  })
})

describe('resolveStarterWorkspaceContainer', () => {
  it('places the container directly inside the parent on both platforms', () => {
    expect(resolveStarterWorkspaceContainer('C:\\Users\\peaker\\Documents', 'win32'))
      .toBe('C:\\Users\\peaker\\Documents\\XingmangProjects')
    expect(resolveStarterWorkspaceContainer('/Users/alex', 'darwin')).toBe('/Users/alex/XingmangProjects')
  })

  it('refuses a parent it cannot place', () => {
    expect(() => resolveStarterWorkspaceContainer('', 'win32')).toThrow('找不到可以放项目的文件夹')
    expect(() => resolveStarterWorkspaceContainer('Documents', 'darwin')).toThrow('找不到可以放项目的文件夹')
  })
})

describe('createStarterWorkspace', () => {
  let home: string
  let documents: string

  beforeEach(() => {
    // macOS 的临时目录经过 /var → /private/var 这条符号链接，不先解开会被
    // reparse 校验整个拒掉。
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-starter-workspace-')))
    documents = path.join(home, 'Documents')
    fs.mkdirSync(documents)
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function context() {
    return { platform: process.platform, home }
  }

  it('creates an empty my-project folder under the container on first use', () => {
    const created = createStarterWorkspace(documents, context())

    expect(created).toBe(path.join(documents, starterWorkspaceContainerName, 'my-project'))
    expect(fs.statSync(created).isDirectory()).toBe(true)
    expect(fs.readdirSync(created)).toEqual([])
  })

  it('never reuses an existing folder, even an empty one the user made', () => {
    const container = path.join(documents, starterWorkspaceContainerName)
    fs.mkdirSync(path.join(container, 'my-project'), { recursive: true })
    fs.writeFileSync(path.join(container, 'my-project-2'), 'a file that happens to take the name')

    const created = createStarterWorkspace(documents, context())

    expect(created).toBe(path.join(container, 'my-project-3'))
    expect(fs.readFileSync(path.join(container, 'my-project-2'), 'utf8')).toBe('a file that happens to take the name')
  })

  it('gives each call its own folder', () => {
    const first = createStarterWorkspace(documents, context())
    const second = createStarterWorkspace(documents, context())

    expect(second).not.toBe(first)
    expect(path.basename(second)).toBe('my-project-2')
  })

  it('can fall back to the home folder itself', () => {
    const created = createStarterWorkspace(home, context())

    expect(created).toBe(path.join(home, starterWorkspaceContainerName, 'my-project'))
  })

  it('stops instead of looping once every numbered name is taken', () => {
    const container = path.join(documents, starterWorkspaceContainerName)
    fs.mkdirSync(container)
    for (let index = 1; index <= 99; index += 1) fs.mkdirSync(path.join(container, buildStarterWorkspaceName(index)))

    expect(() => createStarterWorkspace(documents, context())).toThrow('同名文件夹太多了')
  })

  it('refuses to create a folder the sensitive-workspace guard would flag', () => {
    // 正常安装下走不到这里；用一个恰好等于新目录的「主目录」钉住「新建目录绝不落进
    // 敏感名单」这一条，并确认判定在动磁盘之前。
    const guardedHome = { platform: process.platform, home: path.join(documents, starterWorkspaceContainerName, 'my-project') }

    expect(() => createStarterWorkspace(documents, guardedHome)).toThrow('这个位置不适合放项目')
    expect(fs.existsSync(path.join(documents, starterWorkspaceContainerName))).toBe(false)
  })

  it('does not create a parent folder the system reported but never made', () => {
    const missing = path.join(home, 'Missing Documents')

    expect(() => createStarterWorkspace(missing, context())).toThrow('找不到可以放项目的文件夹')
    expect(fs.existsSync(missing)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('refuses to create through a symlinked container', () => {
    const elsewhere = path.join(home, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(documents, starterWorkspaceContainerName), 'dir')

    expect(() => createStarterWorkspace(documents, context())).toThrow('符号链接或目录联接')
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('reports a read-only parent folder in Chinese', () => {
    fs.chmodSync(documents, 0o555)
    try {
      expect(() => createStarterWorkspace(documents, context())).toThrow('可能是没有写入权限，或者磁盘已满')
    } finally {
      fs.chmodSync(documents, 0o755)
    }
  })
})
