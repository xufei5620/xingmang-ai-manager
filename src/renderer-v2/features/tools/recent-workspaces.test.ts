import { describe, expect, it } from 'vitest'
import type { MultiProviderSessionPage } from '../../../../electron/ipc-contract'
import {
  isMissingWorkspace,
  latestSessionIdsByWorkspace,
  recentWorkspaces,
  workspaceButtonLabel,
  workspaceChoices,
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

describe('workspaceChoices', () => {
  it('always offers the directory picker after the remembered directories', () => {
    const choices = workspaceChoices([
      { path: 'C:\\work\\alpha', name: 'alpha' },
      { path: 'C:\\work\\beta', name: 'beta' },
    ])
    expect(choices).toEqual([
      { path: 'C:\\work\\alpha', label: 'C:\\work\\alpha' },
      { path: 'C:\\work\\beta', label: 'C:\\work\\beta' },
      { path: null, label: '选择其他目录…' },
    ])
  })

  it('offers the picker alone when nothing was remembered', () => {
    expect(workspaceChoices([])).toEqual([{ path: null, label: '选择其他目录…' }])
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

  // 没记下目录的记录没法接：CLI 要按目录才找得到会话。
  it('offers nothing for a record with no folder', () => {
    expect([...latestSessionIdsByWorkspace([session({ id: 'claude:blank', cwd: '   ' })])])
      .toEqual([])
  })
})
