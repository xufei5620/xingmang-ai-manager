import { describe, expect, it } from 'vitest'
import { canClearStaleProxy, staleProxyClearMessage, staleProxyConfirmBody } from './stale-proxy'

describe('stale proxy clearing', () => {
  it('offers the button only for a current-user proxy the main process marked as clearable', () => {
    expect(canClearStaleProxy({ code: 'PROXY_ENVIRONMENT', details: { fix: 'clear-user-proxy', port: 7890 } })).toBe(true)
    expect(canClearStaleProxy({ code: 'PROXY_ENVIRONMENT', details: { HTTPS_PROXY: '本机 7890 端口（没开）' } })).toBe(false)
    expect(canClearStaleProxy({ code: 'PROXY_ENVIRONMENT' })).toBe(false)
    expect(canClearStaleProxy({ code: 'XINGMANG_NETWORK', details: { fix: 'clear-user-proxy' } })).toBe(false)
  })

  it('names the port and what stays untouched before clearing', () => {
    const body = staleProxyConfirmBody({ fix: 'clear-user-proxy', port: 7890 })
    expect(body).toContain('本机 7890 端口')
    expect(body).toContain('整台电脑的设置不会动')
    expect(body).toContain('再设一次')
    expect(staleProxyConfirmBody(undefined)).toContain('指向本机')
  })

  it('says plainly what happened', () => {
    expect(staleProxyClearMessage({ cleared: ['HTTPS_PROXY'], machineRemaining: false }))
      .toBe('已经清掉。以后新开的命令行窗口也不会再走这个代理。')
    expect(staleProxyClearMessage({ cleared: ['HTTPS_PROXY'], machineRemaining: true })).toContain('要管理员才能改')
    expect(staleProxyClearMessage({ cleared: [], machineRemaining: true })).toContain('给整台电脑设的')
    expect(staleProxyClearMessage({ cleared: [], machineRemaining: false })).toContain('没有要清的了')
  })

  it('keeps technical words off the screen', () => {
    const texts = [
      staleProxyConfirmBody({ port: 7890 }),
      staleProxyClearMessage({ cleared: ['HTTPS_PROXY'], machineRemaining: true }),
      staleProxyClearMessage({ cleared: [], machineRemaining: false }),
    ]
    for (const text of texts) expect(text).not.toMatch(/PROXY|环境变量|PATH|注册表/)
  })
})
