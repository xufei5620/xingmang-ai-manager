import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AnnouncementContent,
  PromoBar,
  PromoCard,
  announcementErrorOffersSite,
  announcementTextPreview,
  formatAnnouncementError,
  formatAnnouncementLoadError,
  isSafeNativeAnnouncementCssValue,
  isSafeNativeAnnouncementSelector,
  safeAnnouncementHref,
  safeAnnouncementImage,
} from './Announcement'
import { AnnouncementCollectionError } from './newapi-announcements'

describe('renderer-v2 announcement error mapping', () => {
  it('turns the bounded-response failure into an actionable, non-raw message', () => {
    const result = formatAnnouncementError(new Error("Error invoking remote method 'account:get-notice': Error: 公告读取响应超过 512 KB 安全上限"))
    expect(result).toEqual({
      responseTooLarge: true,
      message: '这条公告里的图片或视频太大，这里显示不了，可以到官网看完整公告。',
    })
  })

  it('shows one plain sentence when a notice read fails and leaves the raw reason to the log', () => {
    const plain = { responseTooLarge: false, message: '公告暂时没读到，过一会儿点铃铛再看。' }
    expect(formatAnnouncementLoadError(new Error("Error invoking remote method 'account:get-notice': Error: 公告读取失败，服务返回 HTTP 502"))).toEqual(plain)
    expect(formatAnnouncementLoadError(new Error("Error invoking remote method 'account:get-notice': Error: upstream connect error or disconnect/reset before headers"))).toEqual(plain)
    expect(formatAnnouncementLoadError(null)).toEqual(plain)
    expect(formatAnnouncementLoadError(new Error("Error invoking remote method 'account:get-notice': Error: 公告读取响应超过 512 KB 安全上限"))).toEqual({
      responseTooLarge: true,
      message: '这条公告里的图片或视频太大，这里显示不了，可以到官网看完整公告。',
    })
    expect(formatAnnouncementLoadError(new AnnouncementCollectionError())).toEqual({
      responseTooLarge: false,
      collectionUnreadable: true,
      message: '公告没读出来，可以点「重新读取」，或到官网查看。',
    })
  })

  it('offers the official site only when the message points the customer there', () => {
    // 合集读不出来那句说「或到官网查看」，得跟公告太大一样摆出去官网的按钮；只说「暂时没读到」的不摆。
    expect(announcementErrorOffersSite(formatAnnouncementLoadError(new AnnouncementCollectionError()))).toBe(true)
    expect(announcementErrorOffersSite(formatAnnouncementLoadError(new Error("Error invoking remote method 'account:get-notice': Error: 公告读取响应超过 512 KB 安全上限")))).toBe(true)
    expect(announcementErrorOffersSite(formatAnnouncementLoadError(new Error("Error invoking remote method 'account:get-notice': Error: 公告读取失败，服务返回 HTTP 502")))).toBe(false)
    expect(announcementErrorOffersSite(formatAnnouncementError(new Error('网络暂时不可用')))).toBe(false)
  })

  it('keeps ordinary failures distinguishable and retryable', () => {
    expect(formatAnnouncementError(new Error("Error invoking remote method 'account:get-notice': RealmAccountError: 账号服务暂时无法连接"))).toEqual({
      responseTooLarge: false,
      message: '账号服务暂时无法连接',
    })
    expect(formatAnnouncementError(new Error("Error invoking remote method 'account:get-notice': Error: 网络暂时不可用"))).toEqual({
      responseTooLarge: false,
      message: '网络暂时不可用',
    })
    expect(formatAnnouncementError(null)).toEqual({
      responseTooLarge: false,
      message: '公告读取失败',
    })
  })

  it('reduces rich HTML to a bounded readable banner preview', () => {
    expect(announcementTextPreview('<style>.x{background:url(data:image/png;base64,abc)}</style><h1>重要通知</h1><p>请查看详情</p>')).toBe('重要通知 请查看详情')
    expect(announcementTextPreview('x'.repeat(200))).toHaveLength(161)
    expect(announcementTextPreview('# 重要通知\n\n- **请查看** [详情](https://xm.solov.cc/help)')).toBe('重要通知 请查看 详情')
  })

  it('accepts only safe announcement links and same-origin or inert raster images', () => {
    expect(safeAnnouncementHref('https://xm.solov.cc/help')).toBe('https://xm.solov.cc/help')
    expect(safeAnnouncementHref('javascript:alert(1)')).toBeNull()
    expect(safeAnnouncementHref('https://user:pass@xm.solov.cc/help')).toBeNull()
    expect(safeAnnouncementImage('https://xm.solov.cc/banner.png', 'https://xm.solov.cc')).toBe('https://xm.solov.cc/banner.png')
    expect(safeAnnouncementImage('https://cdn.example.test/banner.png', 'https://xm.solov.cc')).toBeNull()
    expect(safeAnnouncementImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'https://xm.solov.cc')).toBeNull()
    expect(safeAnnouncementImage('data:image/png;base64,AAAA', 'https://xm.solov.cc')).toBe('data:image/png;base64,AAAA')
  })

  it('renders Markdown headings, GFM lists, emphasis and safe links in a styled content region', () => {
    const html = renderToStaticMarkup(
      <AnnouncementContent
        text={'# 服务公告\n\n- 第一项\n- 第二项\n\n**重点提醒**：请查看 [官方说明](https://xm.solov.cc/help)。'}
        noticeUrl="https://xm.solov.cc"
        openExternal={async () => undefined}
        onError={() => undefined}
      />,
    )
    expect(html).toContain('class="v2-announcement-content"')
    expect(html).toContain('<h1>服务公告</h1>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>第一项</li>')
    expect(html).toContain('<strong>重点提醒</strong>')
    expect(html).toContain('href="https://xm.solov.cc/help"')
    expect(html).toContain('rel="noreferrer"')
  })

  it('keeps unsafe Markdown links and remote images inert, and never points an image at the network', () => {
    const text = '[危险链接](javascript:alert(1))\n\n![官方二维码](https://xm.solov.cc/qr.png)\n\n![外部图片](https://attacker.invalid/qr.png)'
    const html = renderToStaticMarkup(
      <AnnouncementContent
        text={text}
        noticeUrl="https://xm.solov.cc"
        openExternal={async () => undefined}
        onError={() => undefined}
      />,
    )
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<span>危险链接</span>')
    // 页面的安全设置不放网上图片（D89 a）：没有主进程代下（readImage）时，官网的图也只显示说明。
    expect(html).toContain('[图片：官方二维码]')
    expect(html).toContain('[图片：外部图片]')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('attacker.invalid/qr.png')

    // 有代下时官网的图先空着，等主进程交回 data: 地址；外站的图照旧只显示说明。
    const withDownloads = renderToStaticMarkup(
      <AnnouncementContent
        text={text}
        noticeUrl="https://xm.solov.cc"
        readImage={async () => 'data:image/png;base64,AAAA'}
        openExternal={async () => undefined}
        onError={() => undefined}
      />,
    )
    expect(withDownloads).not.toContain('<img')
    expect(withDownloads).not.toContain('[图片：官方二维码]')
    expect(withDownloads).toContain('[图片：外部图片]')
  })

  it('requires every native CSS selector to stay inside its random announcement scope', () => {
    const root = 'xm-native-2a02f9cc7aced2e7'
    expect(isSafeNativeAnnouncementSelector(`.${root} .card, html.dark .${root}>[data-xm-state]`, root)).toBe(true)
    expect(isSafeNativeAnnouncementSelector(`html:not(.dark) .${root} .card`, root)).toBe(true)
    expect(isSafeNativeAnnouncementSelector(`.${root}, body`, root)).toBe(false)
    expect(isSafeNativeAnnouncementSelector(`.${root}-escape .card`, root)).toBe(false)
    expect(isSafeNativeAnnouncementSelector('html[lang^="en"] body', root)).toBe(false)
  })

  it('allows verified inline PNG artwork but rejects CSS network and executable values', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    expect(isSafeNativeAnnouncementCssValue('background-image:var(--xm-native-art-0)')).toBe(true)
    expect(isSafeNativeAnnouncementCssValue(`url("${png}")`)).toBe(true)
    expect(isSafeNativeAnnouncementCssValue('url("https://attacker.invalid/pixel.png")')).toBe(false)
    expect(isSafeNativeAnnouncementCssValue('url("data:text/html;base64,PHNjcmlwdD4=")')).toBe(false)
    expect(isSafeNativeAnnouncementCssValue('expression(alert(1))')).toBe(false)
    expect(isSafeNativeAnnouncementCssValue(String.raw`\75\72\6c(\68\74\74\70\73\3a//attacker.invalid/p.png)`)).toBe(false)
  })
})

describe('renderer-v2 recharge promo card', () => {
  const tiers = [
    { amount: 110, pay: 100, percent: 10 },
    { amount: 240, pay: 200, percent: 20 },
    { amount: 4000, pay: 2000, percent: 100 },
  ]

  it('lists one box per bonus tier and marks the most generous one', () => {
    const html = renderToStaticMarkup(<PromoCard title="国庆礼遇 · 中秋同庆｜充值满赠" deadline="10月8日 23:59 结束，还剩 8 天" tiers={tiers} lines={[]} others={[]}
      onTopUp={() => undefined} onDetail={() => undefined} onDismiss={() => undefined} onSnooze={() => undefined} onOpenOther={() => undefined} />)
    expect(html).toContain('data-testid="announcement-promo-card"')
    expect(html).toContain('10月8日 23:59 结束，还剩 8 天')
    expect(html).toContain('data-testid="announcement-promo-tier-110"')
    expect(html).toContain('充 2,000')
    expect(html).toContain('送 100%')
    expect(html).toContain('到账 <strong>4,000</strong>')
    expect(html.match(/送得最多/g)).toHaveLength(1)
    expect(html).toContain('点一档直接去付款。')
    for (const label of ['去充值', '活动详情', '这个活动不再提醒', '今天不再提醒']) expect(html).toContain(label)
    expect(html).not.toContain('>知道了<')
    expect(html).not.toContain('announcement-promo-lines')
  })

  it('shows the first body lines when no bonus tiers are configured', () => {
    const html = renderToStaticMarkup(<PromoCard title="充值活动" deadline={null} tiers={[]} lines={['单笔充值最高送 100%', '额度永久有效']} others={[]}
      onDetail={() => undefined} onDismiss={() => undefined} onSnooze={() => undefined} onOpenOther={() => undefined} />)
    expect(html).toContain('<p>单笔充值最高送 100%</p><p>额度永久有效</p>')
    expect(html).not.toContain('announcement-promo-tiers')
    expect(html).not.toContain('announcement-promo-topup')
    expect(html).not.toContain('announcement-promo-deadline')
  })

  it('keeps tiers readable but not clickable when the account cannot recharge in the app', () => {
    const html = renderToStaticMarkup(<PromoCard title="充值活动" deadline={null} tiers={tiers} lines={[]} others={[]}
      onDetail={() => undefined} onDismiss={() => undefined} onSnooze={() => undefined} onOpenOther={() => undefined} />)
    expect(html).toContain('<div class="v2-promo-tier" data-testid="announcement-promo-tier-110">')
    expect(html).not.toContain('点一档直接去付款')
  })

  it('folds the other running activities into one line at the bottom', () => {
    const html = renderToStaticMarkup(<PromoCard title="充值满赠" deadline={null} tiers={tiers} lines={[]} others={[{ id: 'invite', title: '国庆礼遇 · 中秋同庆｜邀请有礼' }]}
      onDetail={() => undefined} onDismiss={() => undefined} onSnooze={() => undefined} onOpenOther={() => undefined} />)
    expect(html).toContain('还有 1 条活动：国庆礼遇 · 中秋同庆｜邀请有礼')
    expect(html).toContain('announcement-promo-others-open')
  })
})

describe('renderer-v2 activity bar', () => {
  it('names each running activity with its deadline and offers top-up and a today-only close', () => {
    const html = renderToStaticMarkup(<PromoBar items={[
      { id: 'a', name: '充值满赠', deadline: '10月8日截止，还剩 8 天', onOpen: () => undefined },
      { id: 'b', name: '邀请有礼', deadline: null, onOpen: () => undefined },
    ]} onTopUp={() => undefined} onHide={() => undefined} />)
    expect(html).toContain('data-testid="announcement-promo-bar"')
    expect(html).toContain('充值满赠<small>10月8日截止，还剩 8 天</small>')
    expect(html).toContain('邀请有礼</button>')
    expect(html).toContain('去充值')
    expect(html).toContain('aria-label="今天先收起活动提醒"')
  })

  it('leaves out top-up when the account cannot recharge in the app', () => {
    const html = renderToStaticMarkup(<PromoBar items={[{ id: 'b', name: '邀请有礼', deadline: null, onOpen: () => undefined }]} onHide={() => undefined} />)
    expect(html).not.toContain('announcement-promo-bar-topup')
  })
})
