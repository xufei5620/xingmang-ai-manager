import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { inspectChatLink, plainText } from './links'

describe('chat link inspection', () => {
  it('copies web addresses and shows the host when the text hides it', () => {
    expect(inspectChatLink('https://docs.example.com/x', '官方文档')).toEqual({ url: 'https://docs.example.com/x', host: 'docs.example.com', showHost: true })
    expect(inspectChatLink('http://example.com', 'example')).toMatchObject({ url: 'http://example.com/', showHost: true })
  })

  it('does not repeat the host when the text already shows it', () => {
    expect(inspectChatLink('https://example.com/guide', 'https://example.com/guide')?.showHost).toBe(false)
    expect(inspectChatLink('https://Example.com/guide', 'see EXAMPLE.com')?.showHost).toBe(false)
  })

  it('shows the real host for addresses that hide it behind user info', () => {
    expect(inspectChatLink('https://xm.solov.cc@evil.example/x', 'xm.solov.cc')).toMatchObject({ host: 'evil.example', showHost: true })
  })

  it('leaves every other kind of link as plain text', () => {
    for (const href of [undefined, '', 'mailto:a@example.com', 'file:///C:/Windows', 'javascript:alert(1)', 'data:text/html,x', '/relative', '#top', 'not a url']) {
      expect(inspectChatLink(href, 'label')).toBeNull()
    }
  })

  it('reads the visible text of nested link children', () => {
    expect(plainText(['官方', createElement('strong', null, '文档'), 2])).toBe('官方文档2')
    expect(plainText(null)).toBe('')
  })
})
