import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CodexLaunchDialog } from './CodexLaunchDialog'

describe('CodexLaunchDialog', () => {
  it('names the ChatGPT account source so restart is not framed as a Xingmang-only action', () => {
    const markup = renderToStaticMarkup(
      <CodexLaunchDialog
        accountSource="official"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(markup).toContain('Codex 已在运行')
    expect(markup).toContain('当前账号来源是 ChatGPT')
    expect(markup).toContain('打开窗口')
    expect(markup).toContain('重启 Codex')
    expect(markup).toContain('星芒中转和 ChatGPT 账号都会重新读取')
    expect(markup).not.toContain('reset-option')
  })

  it('names the Xingmang relay when that is the current source', () => {
    const markup = renderToStaticMarkup(
      <CodexLaunchDialog
        accountSource="relay"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(markup).toContain('当前账号来源是星芒中转')
    expect(markup).not.toContain('当前账号来源是 ChatGPT')
  })
})
