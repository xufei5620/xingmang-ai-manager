import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ExternalUrlBlockedError } from '../../electron/external-url-blocked'
import { BlockedLinkHint, blockedLinkMessage, copyableBlockedLink, openExternalOrCopy } from './external-link-fallback'

// What ipcRenderer.invoke actually rejects with: the main-process error is
// flattened to its toString() behind Electron's channel prefix.
function bridgedBlockedError() {
  return new Error(`Error invoking remote method 'external:open': ${new ExternalUrlBlockedError().toString()}`)
}

describe('external-link-fallback', () => {
  it('hands over only plain http and https links without a credential part', () => {
    expect(copyableBlockedLink('https://xm.solov.cc/campaign?id=1')).toBe('https://xm.solov.cc/campaign?id=1')
    expect(copyableBlockedLink('http://example.test/page')).toBe('http://example.test/page')
    expect(copyableBlockedLink('https://xm.solov.cc@evil.example/login')).toBeNull()
    expect(copyableBlockedLink('https://user:pass@example.test/')).toBeNull()
    expect(copyableBlockedLink('javascript:alert(1)')).toBeNull()
    expect(copyableBlockedLink('file:///C:/Windows/System32/calc.exe')).toBeNull()
    expect(copyableBlockedLink('ms-windows-store://pdp/?ProductId=OTHER')).toBeNull()
    expect(copyableBlockedLink('not a url')).toBeNull()
  })

  it('returns nothing and copies nothing when the link opens', async () => {
    const copy = vi.fn(async () => undefined)
    await expect(openExternalOrCopy('https://xm.solov.cc/help', async () => true, copy)).resolves.toBeNull()
    expect(copy).not.toHaveBeenCalled()
  })

  it('copies a blocked web link and reports it instead of failing', async () => {
    const copy = vi.fn(async () => undefined)
    const notice = await openExternalOrCopy('https://xm.solov.cc/campaign', async () => { throw bridgedBlockedError() }, copy)
    expect(copy).toHaveBeenCalledWith('https://xm.solov.cc/campaign')
    expect(notice).toEqual({ copied: true, url: 'https://xm.solov.cc/campaign' })
  })

  it('still shows the address when the clipboard refuses the write', async () => {
    const notice = await openExternalOrCopy('https://xm.solov.cc/campaign', async () => { throw bridgedBlockedError() }, async () => { throw new Error('denied') })
    expect(notice).toEqual({ copied: false, url: 'https://xm.solov.cc/campaign' })
  })

  it('keeps other protocols blocked and never copies them', async () => {
    const copy = vi.fn(async () => undefined)
    const error = bridgedBlockedError()
    await expect(openExternalOrCopy('file:///etc/passwd', async () => { throw error }, copy)).rejects.toBe(error)
    expect(copy).not.toHaveBeenCalled()
  })

  it('rethrows failures that are not the blocked-link code, even with the same sentence', async () => {
    const copy = vi.fn(async () => undefined)
    const plain = new Error("Error invoking remote method 'external:open': Error: 不允许打开该链接")
    await expect(openExternalOrCopy('https://xm.solov.cc/campaign', async () => { throw plain }, copy)).rejects.toBe(plain)
    const shellFailure = new Error("Error invoking remote method 'external:open': Error: 系统浏览器没有响应")
    await expect(openExternalOrCopy('https://xm.solov.cc/help', async () => { throw shellFailure }, copy)).rejects.toBe(shellFailure)
    expect(copy).not.toHaveBeenCalled()
  })

  it('tells the user what to do in plain words and shows the address', () => {
    for (const copied of [true, false]) {
      const message = blockedLinkMessage({ copied, url: 'https://xm.solov.cc/campaign' })
      expect(message).toContain('浏览器')
      expect(message).not.toMatch(/白名单|允许列表|协议|不允许/)
    }
    expect(blockedLinkMessage({ copied: true, url: 'x' })).toContain('已经帮你复制好了')
    const html = renderToStaticMarkup(<BlockedLinkHint notice={{ copied: false, url: 'https://xm.solov.cc/a?b=1&c=2' }} testId="blocked" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('data-testid="blocked"')
    expect(html).toContain('https://xm.solov.cc/a?b=1&amp;c=2')
  })
})
