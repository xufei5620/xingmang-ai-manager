import { describe, expect, it } from 'vitest'
import type { MultiProviderSessionPage } from '../../../../electron/ipc-contract'
import {
  folderConversations,
  isMissingWorkspace,
  latestSessionIdsByWorkspace,
  launchWorkspaces,
  opensUntouchedStarterWorkspace,
  recentWorkspaces,
  resumeLaunchChoice,
  resumeNeedsRecheck,
  resumeStillLatest,
  startsInNewFolder,
  workspaceButtonLabel,
  workspaceName,
} from './recent-workspaces'

type SessionSummary = MultiProviderSessionPage['items'][number]

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'claude:fixture', provider: 'claude', nativeId: 'fixture', title: '会话',
    cwd: 'C:\\work\\alpha', model: 'fixture-model', archived: false, readonly: true,
    createdAt: 1000, updatedAt: 2000, messageCount: 3, sourcePath: 'C:\\fixture.jsonl',
    detailAvailable: true,
    ...overrides,
  } as SessionSummary
}

describe('launchWorkspaces', () => {
  it('prefers the tool\'s own session history', () => {
    const items = launchWorkspaces([
      session({ id: 'a', provider: 'claude', cwd: 'C:\\work\\alpha' }),
    ], 'claude', 'D:\\picked\\beta')
    expect(items).toEqual([{ path: 'C:\\work\\alpha', name: 'alpha' }])
  })

  it('falls back to the folder picked earlier when the tool has no sessions', () => {
    const items = launchWorkspaces([
      session({ id: 'a', provider: 'codex', cwd: 'C:\\work\\alpha' }),
    ], 'claude', 'D:\\picked\\beta')
    expect(items).toEqual([{ path: 'D:\\picked\\beta', name: 'beta' }])
  })

  it('returns nothing when there is neither history nor a remembered folder', () => {
    expect(launchWorkspaces([], 'claude')).toEqual([])
    expect(launchWorkspaces([], 'claude', '   ')).toEqual([])
    expect(launchWorkspaces([], 'claude', null)).toEqual([])
  })
})

// 已知40 / D46：首页卡片和引导最后一步的「打开」按同一条判要不要替他新建项目文件夹。
describe('startsInNewFolder', () => {
  function page(byProvider: Partial<MultiProviderSessionPage['stats']['byProvider']>): Pick<MultiProviderSessionPage, 'stats'> {
    return { stats: { total: 0, byProvider: { claude: 0, codex: 0, gemini: 0, grok: 0, ...byProvider } } }
  }

  it('creates a folder only for a tool with no sessions and no folder to open', () => {
    expect(startsInNewFolder(page({}), 'claude', [])).toBe(true)
    expect(startsInNewFolder(page({ codex: 4 }), 'claude', [])).toBe(true)
  })

  it('opens the known folder instead when there is one', () => {
    expect(startsInNewFolder(page({}), 'claude', [{ path: 'D:\\picked\\beta', name: 'beta' }])).toBe(false)
  })

  // 用得少的工具挤不进最近那一页，记录里没有它的目录也不等于没用过。
  it('does not create one for a tool that has sessions outside the page it read', () => {
    expect(startsInNewFolder(page({ claude: 2 }), 'claude', [])).toBe(false)
  })

  it('does not guess before the sessions have been read', () => {
    expect(startsInNewFolder(null, 'claude', [])).toBe(false)
  })
})

// D45：「打开」会落在星芒刚建、还空着的项目文件夹里时，第一句话换成让它动手做点东西。
describe('opensUntouchedStarterWorkspace', () => {
  const starter = 'C:\\Users\\peaker\\Documents\\XingmangProjects\\my-project'

  it('counts a launch that will create the folder', () => {
    expect(opensUntouchedStarterWorkspace({ createsFolder: true }, undefined)).toBe(true)
    expect(opensUntouchedStarterWorkspace({ createsFolder: true, workspace: null }, { rememberedWorkspace: 'C:\\work\\alpha' })).toBe(true)
  })

  it('counts the remembered folder only while the main process says it is still untouched', () => {
    expect(opensUntouchedStarterWorkspace({ createsFolder: false, workspace: starter }, { rememberedWorkspace: starter, rememberedWorkspaceFresh: true })).toBe(true)
    expect(opensUntouchedStarterWorkspace({ createsFolder: false, workspace: starter }, { rememberedWorkspace: starter })).toBe(false)
    expect(opensUntouchedStarterWorkspace({ createsFolder: false, workspace: starter }, { rememberedWorkspace: starter, rememberedWorkspaceFresh: false })).toBe(false)
  })

  // 这个工具自己的记录里另有一个文件夹，「打开」去的是那里，不是记着的那个空文件夹。
  it('leaves any other folder with the usual sentence', () => {
    const config = { rememberedWorkspace: starter, rememberedWorkspaceFresh: true }
    expect(opensUntouchedStarterWorkspace({ createsFolder: false, workspace: 'C:\\work\\alpha' }, config)).toBe(false)
    expect(opensUntouchedStarterWorkspace({ createsFolder: false }, config)).toBe(false)
    expect(opensUntouchedStarterWorkspace({ createsFolder: false, workspace: starter }, null)).toBe(false)
  })
})

describe('recentWorkspaces', () => {
  it('keeps only the requested provider', () => {
    const items = recentWorkspaces([
      session({ id: 'a', provider: 'claude', cwd: 'C:\\work\\alpha', updatedAt: 30 }),
      session({ id: 'b', provider: 'codex', cwd: 'C:\\work\\beta', updatedAt: 40 }),
    ], 'claude')
    expect(items.map((item) => item.path)).toEqual(['C:\\work\\alpha'])
  })

  it('orders by the most recent use and drops duplicates', () => {
    const items = recentWorkspaces([
      session({ id: 'a', cwd: 'C:\\work\\alpha', updatedAt: 10 }),
      session({ id: 'b', cwd: 'C:\\work\\beta', updatedAt: 30 }),
      session({ id: 'c', cwd: 'C:\\work\\alpha', updatedAt: 20 }),
    ], 'claude')
    expect(items.map((item) => item.path)).toEqual(['C:\\work\\beta', 'C:\\work\\alpha'])
  })

  it('treats the same Windows directory written in two cases as one entry', () => {
    const items = recentWorkspaces([
      session({ id: 'a', cwd: 'C:\\Work\\Alpha', updatedAt: 40 }),
      session({ id: 'b', cwd: 'c:\\work\\alpha', updatedAt: 20 }),
    ], 'claude')
    expect(items).toEqual([{ path: 'C:\\Work\\Alpha', name: 'Alpha' }])
  })

  it('falls back to the creation time when a session has no update time', () => {
    const items = recentWorkspaces([
      session({ id: 'a', cwd: '/home/u/alpha', updatedAt: null, createdAt: 50 }),
      session({ id: 'b', cwd: '/home/u/beta', updatedAt: 20, createdAt: 20 }),
    ], 'claude')
    expect(items.map((item) => item.path)).toEqual(['/home/u/alpha', '/home/u/beta'])
  })

  it('skips sessions with no recorded directory', () => {
    const items = recentWorkspaces([
      session({ id: 'a', cwd: '  ' }),
      session({ id: 'b', cwd: '' }),
    ], 'claude')
    expect(items).toEqual([])
  })

  it('returns nothing when the tool has never been opened', () => {
    expect(recentWorkspaces([], 'grok')).toEqual([])
  })

  it('keeps at most five directories', () => {
    const items = recentWorkspaces(Array.from({ length: 9 }, (_, index) => session({
      id: `s${index}`, cwd: `C:\\work\\p${index}`, updatedAt: 100 - index,
    })), 'claude')
    expect(items).toHaveLength(5)
    expect(items[0].path).toBe('C:\\work\\p0')
    expect(items[4].path).toBe('C:\\work\\p4')
  })
})

describe('workspaceName', () => {
  it('reads the last segment of a Windows path', () => {
    expect(workspaceName('C:\\work\\my-app')).toBe('my-app')
  })

  it('reads the last segment of a POSIX path', () => {
    expect(workspaceName('/home/alex/my-app')).toBe('my-app')
  })

  it('ignores a trailing separator', () => {
    expect(workspaceName('C:\\work\\my-app\\')).toBe('my-app')
  })

  it('keeps a drive or filesystem root readable', () => {
    expect(workspaceName('C:\\')).toBe('C:')
    expect(workspaceName('/')).toBe('/')
  })
})

describe('folderConversations', () => {
  // 一个文件夹一行，放它最近的那条：「接着聊」只接得上那一条。
  it('keeps one row per folder, the newest chat in it, in the order the list gave', () => {
    const rows = folderConversations([
      session({ id: 'codex:3', provider: 'codex', cwd: 'C:\\work\\alpha', updatedAt: 30 }),
      session({ id: 'claude:9', provider: 'claude', cwd: 'C:\\work\\alpha', updatedAt: 25 }),
      session({ id: 'codex:2', provider: 'codex', cwd: 'C:\\work\\beta', updatedAt: 20 }),
      session({ id: 'codex:1', provider: 'codex', cwd: 'c:\\WORK\\alpha', updatedAt: 10 }),
    ], 'codex')
    expect(rows.map((row) => row.id)).toEqual(['codex:3', 'codex:2'])
  })

  // 归档的、没记下文件夹的都接不上，不占一行。
  it('leaves out archived chats and chats without a folder', () => {
    const rows = folderConversations([
      session({ id: 'codex:4', provider: 'codex', cwd: 'C:\\work\\alpha', archived: true }),
      session({ id: 'codex:3', provider: 'codex', cwd: '  ' }),
      session({ id: 'codex:2', provider: 'codex', cwd: 'C:\\work\\alpha' }),
    ], 'codex')
    expect(rows.map((row) => row.id)).toEqual(['codex:2'])
  })

  // 文件夹已经不在的那一行照样列出来（窗口里置灰），客户知道它去哪了。
  it('still lists a folder that is gone', () => {
    const rows = folderConversations([session({ id: 'grok:1', provider: 'grok', cwdExists: false })], 'grok')
    expect(rows.map((row) => row.id)).toEqual(['grok:1'])
  })

  it('stops at eight folders by default', () => {
    const sessions = Array.from({ length: 12 }, (_, index) => session({ id: `claude:${index}`, cwd: `C:\\work\\p${index}` }))
    expect(folderConversations(sessions, 'claude')).toHaveLength(8)
    expect(folderConversations(sessions, 'claude', 3)).toHaveLength(3)
  })
})

describe('workspaceButtonLabel', () => {
  it('leaves a short directory name alone', () => {
    expect(workspaceButtonLabel('my-app')).toBe('my-app')
  })

  it('truncates a long directory name', () => {
    expect(workspaceButtonLabel('a-very-long-directory-name')).toBe('a-very-lon…')
  })
})

describe('isMissingWorkspace', () => {
  it('recognises the main process message for a directory that is gone', () => {
    expect(isMissingWorkspace(new Error('工作目录不存在，请重新选择'))).toBe(true)
    expect(isMissingWorkspace(new Error('Codex 工作目录不存在，请重新选择'))).toBe(true)
  })

  it('leaves every other failure to the normal error path', () => {
    expect(isMissingWorkspace(new Error('请先确认账号连接，再打开工具。'))).toBe(false)
    expect(isMissingWorkspace(null)).toBe(false)
  })
})

describe('latestSessionIdsByWorkspace', () => {
  // 列表是全局按时间倒序给出来的，所以「第一次出现」就是「最近一条」。
  it('keeps only the first record of each tool and folder pair', () => {
    const ids = latestSessionIdsByWorkspace([
      session({ id: 'claude:new', provider: 'claude', cwd: 'C:\\work\\alpha' }),
      session({ id: 'codex:new', provider: 'codex', cwd: 'C:\\work\\alpha' }),
      session({ id: 'claude:old', provider: 'claude', cwd: 'C:\\work\\alpha' }),
      session({ id: 'claude:beta', provider: 'claude', cwd: 'C:\\work\\beta' }),
    ])

    expect([...ids].sort()).toEqual(['claude:beta', 'claude:new', 'codex:new'])
  })

  // 同一个目录的两种写法在 Windows 上是同一个目录，CLI 也只会找到一条。
  it('treats two spellings of one Windows path as the same folder', () => {
    const ids = latestSessionIdsByWorkspace([
      session({ id: 'claude:new', cwd: 'C:\\Work\\Alpha' }),
      session({ id: 'claude:old', cwd: 'c:\\work\\alpha' }),
    ])

    expect([...ids]).toEqual(['claude:new'])
  })

  // #497：归档的最新一条不占位置，同目录较旧、还在用的那条照样能接着聊。
  it('skips an archived newest record so the older active one stays resumable', () => {
    const ids = latestSessionIdsByWorkspace([
      session({ id: 'codex:archived', provider: 'codex', cwd: 'C:\\work\\alpha', archived: true }),
      session({ id: 'codex:active', provider: 'codex', cwd: 'C:\\work\\alpha' }),
      session({ id: 'codex:older', provider: 'codex', cwd: 'C:\\work\\alpha' }),
    ])

    expect([...ids]).toEqual(['codex:active'])
  })

  it('gives the button back to the newest record once it is restored', () => {
    const ids = latestSessionIdsByWorkspace([
      session({ id: 'codex:restored', provider: 'codex', cwd: 'C:\\work\\alpha', archived: false }),
      session({ id: 'codex:active', provider: 'codex', cwd: 'C:\\work\\alpha' }),
    ])

    expect([...ids]).toEqual(['codex:restored'])
  })

  it('offers nothing for a folder whose records are all archived', () => {
    const ids = latestSessionIdsByWorkspace([
      session({ id: 'codex:gone', provider: 'codex', cwd: 'C:\\work\\alpha', archived: true }),
      session({ id: 'codex:gone-too', provider: 'codex', cwd: 'C:\\work\\alpha', archived: true }),
    ])

    expect([...ids]).toEqual([])
  })

  // 没记下目录的记录没法接：CLI 要按目录才找得到会话。
  it('offers nothing for a record with no folder', () => {
    expect([...latestSessionIdsByWorkspace([session({ id: 'claude:blank', cwd: '   ' })])])
      .toEqual([])
  })
})

describe('resumeLaunchChoice', () => {
  // Codex 自己按目录找最近一条时还看连接名,切过账号就找不到,所以带上这条记录的 id。
  it('resumes Codex by the record id and the other tools by folder', () => {
    expect(resumeLaunchChoice({ id: 'codex:0199a3c2-7b1e-7d40-9f5a-2c3d4e5f6a7b', provider: 'codex' })).toEqual({ resumeSessionId: 'codex:0199a3c2-7b1e-7d40-9f5a-2c3d4e5f6a7b' })
    expect(resumeLaunchChoice({ id: 'claude:1', provider: 'claude' })).toBe('resumeLast')
    expect(resumeLaunchChoice({ id: 'grok:1', provider: 'grok' })).toBe('resumeLast')
  })
})

describe('resumeNeedsRecheck', () => {
  // 按文件夹接最近一条的几家要先对一次；Codex 带着记录 id 接，点哪条接哪条。
  it('rechecks only the tools that resume the latest record in the folder', () => {
    expect(resumeNeedsRecheck({ id: 'claude:1', provider: 'claude' })).toBe(true)
    expect(resumeNeedsRecheck({ id: 'grok:1', provider: 'grok' })).toBe(true)
    expect(resumeNeedsRecheck({ id: 'codex:1', provider: 'codex' })).toBe(false)
  })
})

describe('resumeStillLatest', () => {
  it('opens the clicked record when it is still the latest one in its folder', () => {
    const clicked = session({ id: 'claude:older', cwd: 'C:\\work\\alpha' })
    expect(resumeStillLatest(clicked, [
      session({ id: 'claude:other-folder', cwd: 'C:\\work\\beta' }),
      clicked,
    ])).toBe(true)
  })

  // 星芒在后面时又在终端里聊了一条：同一文件夹最近的换成了它，CLI 接上的会是它，不是点的这条。
  it('holds back when a newer record from the same folder showed up', () => {
    const clicked = session({ id: 'claude:older', cwd: 'C:\\work\\alpha' })
    expect(resumeStillLatest(clicked, [
      session({ id: 'claude:newer', cwd: 'c:\\WORK\\alpha' }),
      clicked,
    ])).toBe(false)
  })

  it('holds back when the clicked record was removed or archived meanwhile', () => {
    const clicked = session({ id: 'claude:older', cwd: 'C:\\work\\alpha' })
    expect(resumeStillLatest(clicked, [])).toBe(false)
    expect(resumeStillLatest(clicked, [{ ...clicked, archived: true }])).toBe(false)
  })

  it('ignores newer records of another tool in the same folder', () => {
    const clicked = session({ id: 'claude:older', cwd: 'C:\\work\\alpha' })
    expect(resumeStillLatest(clicked, [
      session({ id: 'grok:newer', provider: 'grok', cwd: 'C:\\work\\alpha' }),
      clicked,
    ])).toBe(true)
  })
})
