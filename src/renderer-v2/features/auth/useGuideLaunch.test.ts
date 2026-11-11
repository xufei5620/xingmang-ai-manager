import { describe, expect, it } from 'vitest'
import type { MultiProviderSessionPage } from '../../../../electron/ipc-contract'
import { guideFolderFields, guideLaunchTarget } from './useGuideLaunch'

type SessionSummary = MultiProviderSessionPage['items'][number]

const starter = 'C:\\Users\\peaker\\Documents\\XingmangProjects\\my-project'

function recent(items: Partial<SessionSummary>[], byProvider: Partial<MultiProviderSessionPage['stats']['byProvider']> = {}): MultiProviderSessionPage {
  const sessions = items.map((item, index) => ({
    id: `claude:${index}`, provider: 'claude', nativeId: `${index}`, title: '会话', cwd: 'C:\\work\\alpha', model: 'fixture-model',
    archived: false, readonly: true, createdAt: 1000, updatedAt: 2000 - index, messageCount: 3, sourcePath: 'C:\\fixture.jsonl', detailAvailable: true,
    ...item,
  } as SessionSummary))
  return {
    items: sessions, total: sessions.length, page: 1, pageSize: 60, pages: 1,
    stats: { total: sessions.length, byProvider: { claude: 0, codex: 0, gemini: 0, grok: 0, ...byProvider } },
    capabilities: {} as MultiProviderSessionPage['capabilities'],
  }
}

// D46（新手流程 N2）：引导最后一步的「打开」以前一律弹选择窗口，首页第一次「打开」早就替他新建了（已知40）。
describe('guide launch target', () => {
  it('creates a folder for a tool that has never been used and has no folder remembered', () => {
    expect(guideLaunchTarget(recent([]), 'claude', undefined)).toEqual({ startsFresh: true })
  })

  it('opens the folder the home card would open', () => {
    expect(guideLaunchTarget(recent([{ cwd: 'C:\\work\\alpha' }], { claude: 1 }), 'claude', starter)).toEqual({ workspace: 'C:\\work\\alpha', startsFresh: false })
    expect(guideLaunchTarget(recent([]), 'codex', starter)).toEqual({ workspace: starter, startsFresh: false })
  })

  it('asks for a folder while the sessions have not been read', () => {
    expect(guideLaunchTarget(null, 'claude', undefined)).toEqual({ startsFresh: false })
    expect(guideLaunchTarget(null, 'claude', starter)).toEqual({ workspace: starter, startsFresh: false })
  })
})

describe('guide folder fields', () => {
  it('offers another folder only when opening does not ask for one', () => {
    expect(guideFolderFields({ startsFresh: true }, undefined)).toEqual({ opensIn: 'newFolder', freshFolder: true })
    expect(guideFolderFields({ workspace: 'C:\\work\\alpha', startsFresh: false }, undefined)).toEqual({ opensIn: 'lastFolder', freshFolder: false })
    expect(guideFolderFields({ startsFresh: false }, undefined)).toEqual({ freshFolder: false })
  })

  // D45 的那句话跟着「打开」会落在哪挑：记着的是星芒建的、还空着，也算。
  it('picks the fresh-folder sentence the same way as the home card', () => {
    expect(guideFolderFields({ workspace: starter, startsFresh: false }, { rememberedWorkspace: starter, rememberedWorkspaceFresh: true })).toEqual({ opensIn: 'lastFolder', freshFolder: true })
    expect(guideFolderFields({ workspace: 'C:\\work\\alpha', startsFresh: false }, { rememberedWorkspace: starter, rememberedWorkspaceFresh: true })).toEqual({ opensIn: 'lastFolder', freshFolder: false })
  })
})
