import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applicationContentSecurityPolicy, applicationSecurityResponseHeaders } from './app-protocol'

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

  it('hands every response its own header list', () => {
    const first = applicationSecurityResponseHeaders()
    first['Content-Security-Policy']?.push("connect-src *")
    expect(applicationSecurityResponseHeaders()['Content-Security-Policy']).toEqual([applicationContentSecurityPolicy])
  })
})
