import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OfficialAccountDialog } from './OfficialAccountDialog'

describe('OfficialAccountDialog', () => {
  it('asks before switching to the official ChatGPT account', () => {
    const markup = renderToStaticMarkup(
      <OfficialAccountDialog
        provider="codex"
        label="ChatGPT 账号"
        mode="official"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(markup).toContain('切换为你自己的ChatGPT 账号？')
    expect(markup).toContain('撤掉中转地址与 API Key')
    expect(markup).toContain('确认后会自动重启 Codex 桌面端')
  })

  it('asks before writing the Xingmang relay key back', () => {
    const markup = renderToStaticMarkup(
      <OfficialAccountDialog
        provider="codex"
        label="ChatGPT 账号"
        mode="relay"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(markup).toContain('切换为星芒中转？')
    expect(markup).toContain('星芒 API Key 和中转地址')
    expect(markup).toContain('ChatGPT 登录和 config.toml 会各存一份')
    expect(markup).toContain('确认后会自动重启 Codex 桌面端')
    expect(markup).not.toContain('请重启 Codex')
    expect(markup).not.toContain('撤掉中转地址与 API Key')
  })
})
