import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolConversationsDialog, conversationsDialogTitle } from './ToolConversationsDialog'

function render(overrides: Partial<Parameters<typeof ToolConversationsDialog>[0]> = {}): string {
  return renderToStaticMarkup(<ToolConversationsDialog
    api={{ toolSessions: () => new Promise(() => undefined) }}
    provider="codex" toolName="Codex CLI" resumeDisabled={false} newDisabled={false}
    onResume={() => undefined} onNew={() => undefined} onAllRecords={() => undefined} onClose={() => undefined}
    {...overrides} />)
}

describe('renderer-v2 tool conversations dialog', () => {
  it('names the tool in the title', () => {
    expect(conversationsDialogTitle('Claude Code')).toBe('接着 Claude Code 之前的对话')
    expect(render()).toContain('接着 Codex CLI 之前的对话')
  })

  // 记录是打开窗口时现读的，读回来之前先说在读，不先摆一句「还没有对话记录」。
  it('says it is reading until the tool\'s records come back', () => {
    const markup = render()
    expect(markup).toContain('正在读取最近记录')
    expect(markup).not.toContain('还没有对话记录')
  })

  it('offers all records and a new chat at the bottom', () => {
    const markup = render()
    expect(markup).toContain('data-testid="tool-conversations-all"')
    expect(markup).toContain('全部记录')
    expect(markup).toMatch(/<button[^>]*data-testid="tool-conversations-new"[^>]*>(?:<[^>]+>)*开新对话/)
  })

  // 卡片上的「打开」按不动时，这里的「开新对话」也按不动。
  it('greys out a new chat when the card cannot open the tool', () => {
    expect(render({ newDisabled: true })).toMatch(/<button[^>]*data-testid="tool-conversations-new"[^>]*disabled=""/)
  })
})
