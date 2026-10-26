import { afterEach, describe, expect, it, vi } from 'vitest'
import { markBackgroundWork } from '../../background-work'
import { pageNeedsAccount, parseReleasedPage, rendererBusy } from './useRendererRelease'

afterEach(() => { vi.unstubAllGlobals() })

describe('released page record', () => {
  it('reads back a page and its section', () => {
    expect(parseReleasedPage(JSON.stringify({ page: 'settings', section: 'about' }))).toEqual({ page: 'settings', section: 'about' })
    expect(parseReleasedPage(JSON.stringify({ page: 'chat' }))).toEqual({ page: 'chat' })
  })

  it('treats anything unexpected as no record', () => {
    expect(parseReleasedPage(null)).toBeNull()
    expect(parseReleasedPage('{oops')).toBeNull()
    expect(parseReleasedPage(JSON.stringify(['settings']))).toBeNull()
    expect(parseReleasedPage(JSON.stringify({ page: 'nowhere' }))).toBeNull()
    // The canvas opens its own window; restoring it would pop that window open.
    expect(parseReleasedPage(JSON.stringify({ page: 'canvas' }))).toBeNull()
  })

  it('drops a section that is not a short string', () => {
    expect(parseReleasedPage(JSON.stringify({ page: 'account', section: 7 }))).toEqual({ page: 'account' })
    expect(parseReleasedPage(JSON.stringify({ page: 'account', section: 'x'.repeat(65) }))).toEqual({ page: 'account' })
  })

  it('knows which pages need a signed-in account', () => {
    expect(pageNeedsAccount('chat')).toBe(true)
    expect(pageNeedsAccount('video')).toBe(true)
    expect(pageNeedsAccount('account')).toBe(true)
    expect(pageNeedsAccount('settings')).toBe(false)
  })
})

describe('renderer busy', () => {
  it('counts registered work and open modal dialogs', () => {
    let dialog: object | null = null
    vi.stubGlobal('document', { querySelector: (selector: string) => selector === 'dialog[open]' ? dialog : null })
    expect(rendererBusy()).toBe(false)
    dialog = {}
    expect(rendererBusy()).toBe(true)
    dialog = null
    const token = Symbol('install')
    markBackgroundWork(token, true)
    expect(rendererBusy()).toBe(true)
    markBackgroundWork(token, false)
    expect(rendererBusy()).toBe(false)
  })
})
