import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { resolveManagedCliKeyLimits } from '../../../../electron/account-key-quota'
import type { AccountKey } from '../../../../electron/ipc-contract'
import { ToolKeyLimitRow, toolKeyLimitDescription, toolKeyLimitValue } from './ToolKeyLimits'

function key(overrides: Partial<AccountKey> & Pick<AccountKey, 'id' | 'name'>): AccountKey {
  return {
    maskedKey: 'sk-••••••••0001',
    group: 'Claude-MAX订阅',
    status: 1,
    remainQuota: 0,
    unlimitedQuota: true,
    usedQuota: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    expiredAt: null,
    accessedAt: null,
    ...overrides,
  }
}

const limits = resolveManagedCliKeyLimits(
  [
    key({ id: 1, name: 'xingmang-desktop-claude', unlimitedQuota: false, remainQuota: 6_000_000, usedQuota: 2_000_000 }),
    key({ id: 2, name: 'xingmang-desktop-codex', group: 'GPT-中转/订阅', usedQuota: 1_500_000 }),
  ],
  500_000,
  'solov',
)
const [claude, codex, , gemini] = limits

describe('tool key limit rows', () => {
  it('describes a limited tool, an unlimited one and a tool without a key yet', () => {
    expect(toolKeyLimitDescription(claude)).toBe('已用 $4.00 · 上限剩余 $12.00')
    expect(toolKeyLimitDescription(codex)).toBe('已用 $3.00 · 不限额度')
    expect(toolKeyLimitDescription(gemini)).toContain('在首页配置一次')
  })

  it('prefills the field with the current limit and leaves it blank when there is none', () => {
    expect(toolKeyLimitValue(claude)).toBe('12')
    expect(toolKeyLimitValue(codex)).toBe('')
    expect(toolKeyLimitValue(gemini)).toBe('')
  })

  it('renders one editable row per tool with the tool name, not the key name', () => {
    const html = renderToStaticMarkup(
      <ToolKeyLimitRow limit={claude} value="12" busy={false} disabled={false} onChange={() => undefined} onSave={() => undefined} />,
    )
    expect(html).toContain('data-testid="tool-key-limit-claude"')
    expect(html).toContain('data-testid="tool-key-limit-input-claude"')
    expect(html).toContain('Claude Code')
    expect(html).not.toContain('xingmang-desktop-claude')
    expect(html).toContain('value="12"')
    expect(html).not.toContain('disabled=""')
  })

  it('disables the field for a tool that has no managed key yet', () => {
    const html = renderToStaticMarkup(
      <ToolKeyLimitRow limit={gemini} value="" busy={false} disabled={false} onChange={() => undefined} onSave={() => undefined} />,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('Gemini CLI')
  })

  it('never names the account backend in what the user reads', () => {
    const html = limits
      .map((limit) =>
        renderToStaticMarkup(
          <ToolKeyLimitRow limit={limit} value="" busy={false} disabled={false} onChange={() => undefined} onSave={() => undefined} />,
        ),
      )
      .join('')
    expect(html).not.toMatch(/solov|new-api|sub2api|NewAPI|Sub2API/i)
  })
})
