import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OfficialChatGptAccount } from '../../../../electron/ipc-contract'
import { OfficialQuotaDialog } from './OfficialQuotaDialog'

const account: OfficialChatGptAccount = { planLabel: 'Plus', renewsAt: null, resetCredits: 2, windows: [{ id: 'weekly', label: '周限额', remainingPercent: 20, resetAt: null }], checkedAt: new Date().toISOString() }

function render(initial: OfficialChatGptAccount) {
  return renderToStaticMarkup(<OfficialQuotaDialog initial={initial} refresh={async () => initial} onClose={() => undefined} />)
}

describe('renderer-v2 official ChatGPT quota dialog', () => {
  // 主进程给的是还能重置几次（rate_limit_reset_credits.available_count），不是金额也不是百分比（D59）。
  it('counts the reset credits as times rather than an amount', () => {
    const markup = render(account)
    expect(markup).toContain('已用 80%')
    expect(markup).toContain('<p>还能手动恢复额度 2 次</p>')
    expect(markup).not.toContain('剩余额度')
  })

  it('leaves the line out when ChatGPT did not say', () => {
    expect(render({ ...account, resetCredits: null })).not.toContain('还能手动恢复额度')
  })
})
