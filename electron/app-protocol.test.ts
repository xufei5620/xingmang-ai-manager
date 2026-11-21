import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applicationContentSecurityPolicy,
  applicationResponseHeaders,
  applicationSecurityResponseHeaders,
  rendererCallStackDocumentPolicy,
} from './app-protocol'

function declaredPagePolicy(): string {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)
  if (!match?.[1]) throw new Error('index.html declares no Content-Security-Policy')
  return match[1]
}

function directives(policy: string): Map<string, string> {
  return new Map(policy.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [name = '', ...sources] = entry.split(/\s+/)
    return [name, sources.join(' ')]
  }))
}

describe('applicationSecurityResponseHeaders', () => {
  it('sends exactly the policy index.html declares, so the page loses nothing and its worker gains the same rules', () => {
    expect(applicationContentSecurityPolicy).toBe(declaredPagePolicy())
    expect(applicationSecurityResponseHeaders()).toEqual({ 'Content-Security-Policy': [applicationContentSecurityPolicy] })
  })

  it('keeps the compose worker on the app origin for scripts and connections', () => {
    const rules = directives(applicationContentSecurityPolicy)
    expect(rules.get('default-src')).toBe("'self'")
    expect(rules.get('script-src')).toBe("'self'")
    expect(rules.get('connect-src')).toBe("'self'")
    // Workers fall back to script-src, so no blob: or remote worker can be started either.
    expect(rules.has('worker-src')).toBe(false)
    expect(rules.has('child-src')).toBe(false)
  })

  // Why this is safe: the only scheme media may load from is xingmang-asset:, which the main process answers
  // itself and only with the signed-in account's own library files (ai-asset-protocol.ts). Leaving out 'self',
  // blob:, data: and every remote origin means a compromised page still cannot play, or beacon through, anything else.
  it('lets the page play media from the asset library only', () => {
    const rules = directives(applicationContentSecurityPolicy)
    expect(rules.get('media-src')).toBe('xingmang-asset:')
    expect(rules.get('img-src')).toBe("'self' data: xingmang-asset:")
    for (const [name, sources] of rules) {
      expect(sources, name).not.toMatch(/\*|https?:|wss?:|blob:|filesystem:/)
      if (name !== 'style-src') expect(sources, name).not.toContain('unsafe')
    }
  })

  it('hands every response its own header list', () => {
    const first = applicationSecurityResponseHeaders()
    first['Content-Security-Policy']?.push("connect-src *")
    expect(applicationSecurityResponseHeaders()['Content-Security-Policy']).toEqual([applicationContentSecurityPolicy])
  })
})

describe('applicationResponseHeaders', () => {
  it('is the security headers unchanged plus the policy that lets a hung page report its call stack', () => {
    expect(applicationResponseHeaders()).toEqual({
      ...applicationSecurityResponseHeaders(),
      'Document-Policy': [rendererCallStackDocumentPolicy],
    })
    expect(applicationResponseHeaders()['Content-Security-Policy']).toEqual([applicationContentSecurityPolicy])
    expect(rendererCallStackDocumentPolicy).toBe('include-js-call-stacks-in-crash-reports')
  })

  it('hands every response its own header lists', () => {
    const first = applicationResponseHeaders()
    first['Content-Security-Policy']?.push('connect-src *')
    first['Document-Policy']?.push('anything')
    expect(applicationResponseHeaders()['Content-Security-Policy']).toEqual([applicationContentSecurityPolicy])
    expect(applicationResponseHeaders()['Document-Policy']).toEqual([rendererCallStackDocumentPolicy])
  })
})
