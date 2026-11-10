import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { relayProviderBaseUrls } from '../../../../electron/relay-sites'
import { OtherAppsCard } from './OtherApps'
import { copyOtherAppAddress, otherAppAddresses, otherAppsCopied, otherAppsCopyFailed, otherAppsFootnote, otherAppsLead, otherAppsTitle } from './other-apps'

describe('renderer-v2 other apps addresses', () => {
  it('gives the bare host, the /v1 address and the full chat address of a xingmang account', () => {
    expect(otherAppAddresses('solov').map((row) => [row.id, row.url])).toEqual([
      ['host', 'https://xm.solov.cc'],
      ['v1', 'https://xm.solov.cc/v1'],
      ['chat', 'https://xm.solov.cc/v1/chat/completions'],
    ])
  })

  it('gives the historical account its own site', () => {
    expect(otherAppAddresses('solov-api').map((row) => row.url)).toEqual([
      'https://api.solov.cc',
      'https://api.solov.cc/v1',
      'https://api.solov.cc/v1/chat/completions',
    ])
  })

  it('stays on line 1 and never hands out the backup line', () => {
    for (const site of ['solov', 'solov-api'] as const) {
      const direct = new URL(relayProviderBaseUrls(site, 'direct').claude).host
      for (const row of otherAppAddresses(site)) {
        expect(new URL(row.url).origin).toBe(relayProviderBaseUrls(site, 'primary').claude)
        expect(row.url).not.toContain(direct)
      }
    }
  })

  it('tells which apps take which form, without naming the site', () => {
    const hints = otherAppAddresses('solov').map((row) => row.hint)
    expect(hints[0]).toContain('Cherry Studio、Chatbox')
    expect(hints[0]).toContain('Anthropic')
    expect(hints[1]).toContain('/v1 结尾')
    expect(hints[2]).toContain('沉浸式翻译')
    for (const text of [...hints, otherAppsTitle, otherAppsLead, otherAppsFootnote]) {
      expect(text).not.toMatch(/xm|api\.|solov|Sub2API|站点/i)
    }
  })

  it('says the address was copied', async () => {
    const copied: string[] = []
    const shown: Array<[string, string]> = []
    await copyOtherAppAddress('https://xm.solov.cc', async (text) => { copied.push(text) }, (text, tone) => shown.push([text, tone]))
    expect(copied).toEqual(['https://xm.solov.cc'])
    expect(shown).toEqual([[otherAppsCopied, 'ok']])
  })

  it('asks to copy by hand when the clipboard refuses', async () => {
    const shown: Array<[string, string]> = []
    await copyOtherAppAddress('https://xm.solov.cc', () => Promise.reject(new Error('Document is not focused.')), (text, tone) => shown.push([text, tone]))
    expect(shown).toEqual([[otherAppsCopyFailed, 'warn']])
  })
})

describe('renderer-v2 other apps card', () => {
  it('shows every address with its own copy button under the search landing', () => {
    const markup = renderToStaticMarkup(<OtherAppsCard siteId="solov" onRequestApp={() => undefined} />)
    expect(markup).toContain('data-anchor="other-apps"')
    expect(markup).toContain('用在别的软件里')
    expect(markup).toContain(otherAppsLead)
    for (const id of ['host', 'v1', 'chat']) expect(markup).toContain(`data-testid="account-other-apps-copy-${id}"`)
    expect(markup).toContain('>https://xm.solov.cc/v1/chat/completions</code>')
    expect(markup).toContain(otherAppsFootnote)
    expect(markup).toContain('想让星芒直接接入某个软件？')
    expect(markup).toContain('data-testid="account-other-apps-request"')
  })

  it('leaves out the feedback line when there is nowhere to send it', () => {
    const markup = renderToStaticMarkup(<OtherAppsCard siteId="solov-api" />)
    expect(markup).toContain('>https://api.solov.cc</code>')
    expect(markup).not.toContain('account-other-apps-request')
  })
})
