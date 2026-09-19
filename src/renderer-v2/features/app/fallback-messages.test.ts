import { describe, expect, it } from 'vitest'
import { deepLinkReadErrorText, supportQrFallbackText } from './fallback-messages'

describe('supportQrFallbackText', () => {
  const url = 'https://work.weixin.qq.com/kfid/fixture'

  it('says nothing while the code for the current address has not been generated yet', () => {
    expect(supportQrFallbackText(undefined, url)).toBeNull()
    expect(supportQrFallbackText({ url: 'https://work.weixin.qq.com/kfid/other', data: null }, url)).toBeNull()
  })

  it('says nothing once the code is ready', () => {
    expect(supportQrFallbackText({ url, data: 'data:image/png;base64,AAA' }, url)).toBeNull()
  })

  it('points at the browser button when generating the code failed', () => {
    expect(supportQrFallbackText({ url, data: null }, url)).toContain('在浏览器打开')
  })
})

describe('deepLinkReadErrorText', () => {
  it('keeps the backend reason and always names where the order can be checked', () => {
    const text = deepLinkReadErrorText(new Error('回跳参数已过期。'))
    expect(text).toContain('回跳参数已过期。')
    expect(text).toContain('订单')
    expect(text).not.toContain('。。')
  })

  it('falls back to its own wording when the failure carries no usable reason', () => {
    const text = deepLinkReadErrorText(new Error('ECONNRESET'))
    expect(text).toContain('订单')
    expect(text.startsWith('外部跳转没有读取到') || text.includes('网络')).toBe(true)
  })

  it('adds the missing full stop before the guidance', () => {
    expect(deepLinkReadErrorText(new Error('回跳参数已过期'))).toContain('回跳参数已过期。如果刚完成支付')
  })
})
