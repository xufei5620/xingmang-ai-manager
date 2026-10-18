import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildSourceMenuItems, SourceMenu, sourceChipLabels, type SourceMenuInput } from './SourceMenu'

function noop() {}

function input(overrides: Partial<SourceMenuInput> = {}): SourceMenuInput {
  return {
    tool: 'claude', provider: 'claude',
    account: { checked: true, onSelect: noop }, official: { checked: false, onSelect: noop }, more: { onSelect: noop },
    ...overrides,
  }
}

function words(items: ReturnType<typeof buildSourceMenuItems>) {
  return items.map((item) => item === 'divider' ? item : 'note' in item ? { note: item.note }
    : { label: item.label, description: item.description, checked: item.checked, disabled: item.disabled, testId: item.testId })
}

describe('home which-account menu', () => {
  it('gives a CLI card the current account, its official account, a pasted key and more settings', () => {
    const items = buildSourceMenuItems(input({ manual: { checked: false, onSelect: noop } }))
    expect(words(items)).toEqual([
      { label: '当前账号', description: '按用量从当前账号扣费', checked: true, disabled: undefined, testId: 'tool-claude-source-account' },
      { label: 'Claude 账号', description: '用你自己的官方订阅登录', checked: false, disabled: undefined, testId: 'tool-claude-source-official' },
      { label: '自己填写密钥', description: '粘贴你在星芒创建的密钥', checked: false, disabled: undefined, testId: 'tool-claude-source-manual' },
      'divider',
      { label: '更多配置…', description: undefined, checked: undefined, disabled: undefined, testId: undefined },
    ])
  })

  it('adds the shared-config note on both Codex cards and names the ChatGPT account', () => {
    for (const tool of ['codex', 'codexDesktop']) {
      const items = buildSourceMenuItems(input({ tool, provider: 'codex', manual: { checked: false, onSelect: noop } }))
      expect(words(items)[1]).toMatchObject({ label: 'ChatGPT 账号', testId: `tool-${tool}-source-official` })
      expect(items).toContainEqual({ note: 'Codex CLI 和 Codex 桌面端共用这份配置' })
    }
    expect(words(buildSourceMenuItems(input({ tool: 'grok', provider: 'grok' })))[1]).toMatchObject({ label: 'Grok 账号' })
  })

  it('leaves the pasted key out where the card does not offer it, as on Claude Desktop', () => {
    const items = buildSourceMenuItems(input({ tool: 'claudeDesktop', more: { disabled: true, onSelect: noop } }))
    expect(words(items).map((item) => item === 'divider' ? item : 'label' in item ? item.label : item.note)).toEqual(['当前账号', 'Claude 账号', 'divider', '更多配置…'])
    expect(words(items).at(-1)).toMatchObject({ disabled: true })
  })

  it('describes a signed-in official account by who it is and falls back to how to sign in', () => {
    const signedIn = buildSourceMenuItems(input({ official: { checked: true, signedIn: 'chatgpt@example.test，Plus', onSelect: noop } }))
    expect(words(signedIn)[1]).toMatchObject({ description: 'chatgpt@example.test，Plus', checked: true })
    for (const value of [null, '']) {
      expect(words(buildSourceMenuItems(input({ official: { checked: true, signedIn: value, onSelect: noop } })))[1]).toMatchObject({ description: '用你自己的官方订阅登录' })
    }
  })

  it('passes each choice through to its own item', () => {
    const picked: string[] = []
    const items = buildSourceMenuItems(input({
      account: { checked: false, disabled: true, onSelect: () => picked.push('account') },
      official: { checked: true, onSelect: () => picked.push('official') },
      manual: { checked: false, onSelect: () => picked.push('manual') },
      more: { onSelect: () => picked.push('more') },
    }))
    for (const item of items) if (item !== 'divider' && !('note' in item)) item.onSelect()
    expect(picked).toEqual(['account', 'official', 'manual', 'more'])
    expect(words(items)[0]).toMatchObject({ disabled: true })
  })

  it('writes the chip and what a screen reader hears, spacing a Latin name from the sentence', () => {
    expect(sourceChipLabels).toEqual({ account: '当前账号', official: '官方账号', manual: '自己的密钥' })
    const markup = renderToStaticMarkup(<SourceMenu tool="claude" name="Claude Code" chip="自己的密钥" items={[]} />)
    expect(markup).toContain('data-testid="tool-claude-source-menu"')
    expect(markup).toContain('data-testid="tool-claude-source"')
    expect(markup).toContain('aria-label="Claude Code 现在用自己的密钥，点击切换"')
    expect(markup).toContain('<span>自己的密钥</span>')
    expect(renderToStaticMarkup(<SourceMenu tool="codexDesktop" name="Codex 桌面端" chip="当前账号" items={[]} />))
      .toContain('aria-label="Codex 桌面端现在用当前账号，点击切换"')
  })
})
