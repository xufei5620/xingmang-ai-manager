import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { resolveManagedCliKeyLimits } from '../../../../electron/account-key-quota'
import type { AccountKey } from '../../../../electron/ipc-contract'
import { Table } from '../../ui'
import { toolUsageColumns, toolUsageRows } from './ToolUsage'
import {
  buildToolUsageSummary,
  toolUsageAllowance,
  toolUsageHeadline,
  toolUsageRemaining,
  toolUsageShare,
  toolUsageUsed,
} from './tool-usage'

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

function summaryOf(keys: AccountKey[], quotaPerUnit = 500_000) {
  return buildToolUsageSummary(resolveManagedCliKeyLimits(keys, quotaPerUnit, 'solov'))
}

const summary = summaryOf([
  key({ id: 1, name: 'xingmang-desktop-claude', unlimitedQuota: false, remainQuota: 6_000_000, usedQuota: 3_000_000 }),
  key({ id: 2, name: 'xingmang-desktop-codex', group: 'GPT-中转/订阅', usedQuota: 1_000_000 }),
])
const [claude, codex, grok, gemini] = summary.rows

describe('per-tool usage summary', () => {
  it('splits the account total across the tools that have a managed key', () => {
    expect(summary.used).toBe(8)
    expect(summary.enabledCount).toBe(2)
    expect(summary.top?.provider).toBe('claude')
    expect(toolUsageShare(claude)).toBe('75%')
    expect(toolUsageShare(codex)).toBe('25%')
  })

  it('reports a limited tool as used plus remaining and an unlimited one as unlimited', () => {
    expect(toolUsageUsed(claude)).toBe('$6.00')
    expect(toolUsageAllowance(claude)).toBe('$18.00')
    expect(toolUsageRemaining(claude)).toBe('$12.00')
    expect(toolUsageAllowance(codex)).toBe('不限额')
    expect(toolUsageRemaining(codex)).toBe('不限额')
  })

  it('leaves a tool without a key out of the split instead of counting it as zero usage', () => {
    expect(gemini.enabled).toBe(false)
    expect(gemini.share).toBeNull()
    expect(toolUsageUsed(gemini)).toBe('—')
    expect(toolUsageAllowance(gemini)).toBe('—')
    expect(toolUsageShare(grok)).toBe('—')
  })

  it('rounds a tiny share up to a visible marker rather than to zero', () => {
    const tiny = summaryOf([
      key({ id: 1, name: 'xingmang-desktop-claude', usedQuota: 5_000_000 }),
      key({ id: 2, name: 'xingmang-desktop-codex', usedQuota: 1_000 }),
    ])
    expect(toolUsageShare(tiny.rows[1])).toBe('<1%')
  })

  it('says who spent the most, and says so as the current account', () => {
    expect(toolUsageHeadline(summary)).toBe('当前账号累计已用 $8.00，其中 Claude Code 最多（75%）。')
    expect(toolUsageHeadline(summaryOf([]))).toContain('还没有为任何工具签发密钥')
    expect(toolUsageHeadline(summaryOf([key({ id: 1, name: 'xingmang-desktop-claude' })]))).toContain('还没有产生用量')
  })

  it('reads the usage as not yet available when the account gives no usable quota unit', () => {
    const unusable = summaryOf([key({ id: 1, name: 'xingmang-desktop-claude', usedQuota: 3_000_000 })], 0)
    expect(unusable.used).toBeNull()
    expect(toolUsageUsed(unusable.rows[0])).toBe('暂未读到')
    expect(toolUsageHeadline(unusable)).toBe('当前账号的用量暂未读到。')
  })
})

describe('per-tool usage table', () => {
  const html = renderToStaticMarkup(
    <Table columns={toolUsageColumns} rows={toolUsageRows(summary)} rowKey={(row) => String(row.provider)} empty="暂无工具用量" />,
  )

  it('names the tools rather than the managed key names', () => {
    for (const name of ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Grok CLI']) expect(html).toContain(name)
    expect(html).not.toContain('xingmang-desktop-')
  })

  it('marks the tools that have no key yet as not enabled', () => {
    expect(html.match(/未启用/g)).toHaveLength(2)
  })

  it('never names the account backend in what the user reads', () => {
    expect(`${html}${toolUsageHeadline(summary)}`).not.toMatch(/solov|new-api|sub2api|NewAPI|Sub2API/i)
  })
})
