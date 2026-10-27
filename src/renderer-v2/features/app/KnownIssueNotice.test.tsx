import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KnownIssueNotice, knownIssueBody, knownIssueFor, knownIssueKey } from './KnownIssueNotice'
import { StartupNotices } from './StartupNotices'

const recharge = { page: 'recharge' as const, message: '支付宝暂时打不开付款页，请先用微信付款。', action: 'support' as const }
const everywhere = { page: 'all' as const, message: '今晚 22 点前聊天可能慢一点。' }
const home = { page: 'home' as const, message: '首页那条', action: 'update' as const }

describe('KnownIssueNotice', () => {
  it('shows the issue for this page first, then one meant for every page, one at a time', () => {
    const issues = [everywhere, recharge, home]
    expect(knownIssueFor(issues, { page: 'account', accountTab: 'recharge' }, [])).toBe(recharge)
    expect(knownIssueFor(issues, { page: 'home' }, [])).toBe(home)
    expect(knownIssueFor(issues, { page: 'chat' }, [])).toBe(everywhere)
    // 充值那条只在个人中心的充值页签上出，别的页签照「每一页」那条走。
    expect(knownIssueFor(issues, { page: 'account', accountTab: 'keys' }, [])).toBe(everywhere)
    expect(knownIssueFor([recharge], { page: 'settings' }, [])).toBeNull()
    expect(knownIssueFor(undefined, { page: 'home' }, [])).toBeNull()
  })

  it('skips an issue the user closed until its wording changes', () => {
    const issues = [everywhere, recharge]
    const place = { page: 'account' as const, accountTab: 'recharge' as const }
    expect(knownIssueFor(issues, place, [knownIssueKey(recharge)])).toBe(everywhere)
    expect(knownIssueFor(issues, place, [knownIssueKey(recharge), knownIssueKey(everywhere)])).toBeNull()
    const reworded = { ...recharge, message: '支付宝修好了一半，大额先用微信。' }
    expect(knownIssueFor([reworded], place, [knownIssueKey(recharge)])).toBe(reworded)
  })

  it('always tells the user there is nothing to fix on their side', () => {
    expect(knownIssueBody(recharge)).toBe('支付宝暂时打不开付款页，请先用微信付款。 这不是你这边的问题，修好以后这条提示会自己消失。')
  })

  it('renders in the startup corner with the one button the publisher picked', () => {
    const markup = renderToStaticMarkup(<StartupNotices notices={[]} onDismiss={() => undefined} onOpen={() => undefined}
      leading={[<KnownIssueNotice key="known-issue" issue={recharge} onDismiss={() => undefined} onAction={() => undefined} />]} />)
    expect(markup).toContain('data-testid="known-issue-notice"')
    expect(markup).toContain('我们已经知道这个问题')
    expect(markup).toContain('data-testid="known-issue-notice-support"')
    expect(markup).toContain('>找客服<')
    expect(markup).toContain('aria-label="关闭"')
    expect(markup).not.toContain('href=')
    const update = renderToStaticMarkup(<KnownIssueNotice issue={home} onDismiss={() => undefined} onAction={() => undefined} />)
    expect(update).toContain('>查看更新<')
    const plain = renderToStaticMarkup(<KnownIssueNotice issue={everywhere} onDismiss={() => undefined} onAction={() => undefined} />)
    expect(plain).not.toContain('xm-notice-actions')
  })
})
