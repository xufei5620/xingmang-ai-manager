import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionTurnActivity } from './SessionsPage'
import { turnActivityFiles, turnActivityHasNames, turnActivitySummary, type TurnActivity } from './turn-activity'

function activity(overrides: Partial<TurnActivity> = {}): TurnActivity {
  return { commands: 3, commandNames: ['npm', 'git'], fileCount: 2, files: ['app.ts', 'README.md'], failedSteps: 0, ...overrides }
}

describe('turnActivitySummary', () => {
  it('says how many commands ran and files changed in this turn', () => {
    expect(turnActivitySummary(activity())).toBe('本轮：运行了 3 条命令，修改了 2 个文件')
  })

  it('only mentions what happened, and adds the failed steps last', () => {
    expect(turnActivitySummary(activity({ fileCount: 0, files: [] }))).toBe('本轮：运行了 3 条命令')
    expect(turnActivitySummary(activity({ commands: 0, commandNames: [] }))).toBe('本轮：修改了 2 个文件')
    expect(turnActivitySummary(activity({ failedSteps: 1 }))).toBe('本轮：运行了 3 条命令，修改了 2 个文件，有 1 步未成功')
    expect(turnActivitySummary(activity({ commands: 0, commandNames: [], fileCount: 0, files: [], failedSteps: 2 }))).toBe('本轮：有 2 步未成功')
  })
})

describe('turnActivityFiles', () => {
  it('lists the file names and says the total when the list was cut short', () => {
    expect(turnActivityFiles(activity())).toBe('app.ts、README.md')
    expect(turnActivityFiles(activity({ fileCount: 60 }))).toBe('app.ts、README.md…等 60 个')
  })
})

describe('SessionTurnActivity', () => {
  it('folds the file and command names under the summary line', () => {
    const markup = renderToStaticMarkup(<SessionTurnActivity activity={activity()} />)
    expect(markup).toContain('<details class="v2-transcript-activity" data-testid="session-detail-turn-activity">')
    expect(markup).toContain('本轮：运行了 3 条命令，修改了 2 个文件')
    expect(markup).toContain('<dt>改过的文件</dt><dd>app.ts、README.md</dd>')
    expect(markup).toContain('<dt>跑过的命令（只列名字）</dt><dd>npm、git</dd>')
  })

  it('shows a plain line when there are no names to unfold', () => {
    const bare = activity({ commands: 1, commandNames: [], fileCount: 0, files: [], failedSteps: 1 })
    expect(turnActivityHasNames(bare)).toBe(false)
    const markup = renderToStaticMarkup(<SessionTurnActivity activity={bare} />)
    expect(markup).toBe('<p class="v2-transcript-activity" data-testid="session-detail-turn-activity">本轮：运行了 1 条命令，有 1 步未成功</p>')
  })
})
