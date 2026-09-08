import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AnnouncementContent,
  announcementTextPreview,
  formatAnnouncementError,
  isSafeNativeAnnouncementCssValue,
  isSafeNativeAnnouncementSelector,
  safeAnnouncementHref,
  safeAnnouncementImage,
} from './Announcement'

describe('renderer-v2 announcement error mapping', () => {
  it('turns the bounded-response failure into an actionable, non-raw message', () => {
    const result = formatAnnouncementError(new Error("Error invoking remote method 'account:get-notice': Error: 公告读取响应超过 512 KB 安全上限"))
    expect(result).toEqual({
      responseTooLarge: true,
      message: '公告包含过大的内嵌媒体，客户端已按安全上限拦截。可打开官网查看完整公告。',
    })
  })

  it('keeps ordinary failures distinguishable and retryable', () => {
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

  it('keeps unsafe Markdown links and remote images inert while allowing same-origin raster images', () => {
    const html = renderToStaticMarkup(
      <AnnouncementContent
        text={'[危险链接](javascript:alert(1))\n\n![官方二维码](https://xm.solov.cc/qr.png)\n\n![外部图片](https://attacker.invalid/qr.png)'}
        noticeUrl="https://xm.solov.cc"
        openExternal={async () => undefined}
        onError={() => undefined}
      />,
    )
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<span>危险链接</span>')
    expect(html).toContain('<img src="https://xm.solov.cc/qr.png" alt="官方二维码"')
    expect(html).toContain('[图片：外部图片]')
    expect(html).not.toContain('attacker.invalid/qr.png')
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
