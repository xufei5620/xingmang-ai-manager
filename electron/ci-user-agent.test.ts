import { describe, expect, it } from 'vitest'
import { ciUserAgentMarker, ensureCiUserAgentMarker } from './ci-user-agent'

const electronUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) xingmang-ai-manager/0.2.24 Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36'

describe('ci-user-agent', () => {
  it('appends the marker the server filters on when the process runs under CI', () => {
    const target = { userAgentFallback: electronUserAgent }
    expect(ensureCiUserAgentMarker(target, { CI: 'true' })).toBe(true)
    expect(target.userAgentFallback).toBe(`${electronUserAgent} ci`)
    expect(target.userAgentFallback.endsWith(ciUserAgentMarker)).toBe(true)
  })

  it('leaves customer launches untouched', () => {
    for (const env of [{}, { CI: 'false' }, { CI: '' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }]) {
      const target = { userAgentFallback: electronUserAgent }
      expect(ensureCiUserAgentMarker(target, env)).toBe(false)
      expect(target.userAgentFallback).toBe(electronUserAgent)
    }
  })

  it('adds the marker once however often it is asked', () => {
    const target = { userAgentFallback: electronUserAgent }
    ensureCiUserAgentMarker(target, { CI: 'true' })
    expect(ensureCiUserAgentMarker(target, { CI: 'true' })).toBe(false)
    expect(target.userAgentFallback).toBe(`${electronUserAgent} ci`)
  })

  it('keeps the version the login device list and the feed stats read', () => {
    const target = { userAgentFallback: electronUserAgent }
    ensureCiUserAgentMarker(target, { CI: 'true' })
    expect(/\bxingmang-ai-manager\/(\d+\.\d+\.\d+)/.exec(target.userAgentFallback)?.[1]).toBe('0.2.24')
  })

  it('never blocks startup when the fallback cannot be read or written', () => {
    const unreadable = Object.defineProperty({}, 'userAgentFallback', {
      get() { throw new Error('not ready') },
      set() { throw new Error('not ready') },
    }) as { userAgentFallback: string }
    expect(ensureCiUserAgentMarker(unreadable, { CI: 'true' })).toBe(false)
    const empty = { userAgentFallback: '' }
    expect(ensureCiUserAgentMarker(empty, { CI: 'true' })).toBe(false)
    expect(empty.userAgentFallback).toBe('')
  })
})
