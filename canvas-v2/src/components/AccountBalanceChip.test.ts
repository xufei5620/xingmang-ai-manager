import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasAccountSummary } from '../host'
import type { CanvasAccountSummaryState } from '../runtime/account-summary'
import { AccountBalanceChipView } from './AccountBalanceChip'

// 画布顶上的余额条（桌面仓画布完善第 2b 条）：哪个账号、打码的账号名、余额，写法跟主窗口一样。

const summary: CanvasAccountSummary = { siteLabel: '星芒账号', accountLabel: 'yo***3', balanceUsd: 12.4, subscriptionLabel: null, readAt: '2026-11-10T03:00:00.000Z' }
const at = Date.parse('2026-11-10T03:02:00.000Z')

function chip(state: CanvasAccountSummaryState) {
  return renderToStaticMarkup(createElement(AccountBalanceChipView, { state, now: at, onRefresh: () => undefined }))
}

describe('canvas balance chip', () => {
  it('shows the account kind, the masked name and the balance', () => {
    const html = chip({ view: { state: 'ready', summary }, refreshing: false })
    expect(html).toContain('<span class="canvas-account-balance-site">星芒账号</span><span class="canvas-account-balance-name">yo***3</span><strong>$12.40</strong>')
    expect(html).toContain('aria-label="余额 $12.40，星芒账号 · yo***3，点一下重新读"')
    expect(html).toContain('title="星芒账号 · yo***3\n余额 $12.40（2 分钟前读的）\n画布出图用的就是这个账号的额度，点一下重新读余额"')
    expect(html).not.toContain('is-unread')
    expect(html).not.toContain('aria-busy')
  })

  it('leaves the name out when the host has none, and greys a balance it has not read', () => {
    const html = chip({ view: { state: 'ready', summary: { ...summary, siteLabel: '历史账号', accountLabel: null, balanceUsd: null } }, refreshing: false })
    expect(html).toContain('<span class="canvas-account-balance-site">历史账号</span><strong>—</strong>')
    expect(html).not.toContain('canvas-account-balance-name')
    expect(html).toContain('canvas-account-balance is-unread')
  })

  it('writes a dash while reading or after a failed read, and is gone when nobody is signed in', () => {
    expect(chip({ view: { state: 'loading' }, refreshing: true })).toContain('aria-busy="true"')
    expect(chip({ view: { state: 'loading' }, refreshing: true })).toContain('<strong>—</strong>')
    const failed = chip({ view: { state: 'failed' }, refreshing: false })
    expect(failed).toContain('title="余额暂时没有读到，点一下再试"')
    expect(failed).toContain('is-unread')
    expect(chip({ view: { state: 'ready', summary, refreshFailed: true }, refreshing: false })).toContain('is-unread')
    expect(chip({ view: null, refreshing: false })).toBe('')
  })

  it('is only in the editor toolbar where the host offers it, and asks again after every run', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('{hostEntryPoints.accountSummary && <AccountBalanceChip refreshSignal={accountSummarySignal} />}')
    const terminal = app.slice(app.indexOf("if (event.type === 'run-terminal') {"))
    expect(terminal.slice(0, terminal.indexOf('}), [confirmedRunGroups'))).toContain('setAccountSummarySignal((signal) => signal + 1)')
  })

  it('starts no timer of its own', () => {
    const source = readFileSync(new URL('./AccountBalanceChip.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/)
  })
})
