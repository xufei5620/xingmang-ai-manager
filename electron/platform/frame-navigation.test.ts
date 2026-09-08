import fs from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  installMainWindowFrameNavigationGuard,
  shouldPreventMainWindowFrameNavigation,
} from './frame-navigation'

function indexContentSecurityPolicy(): Map<string, string[]> {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8')
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/s)
  if (!match) throw new Error('index.html is missing its Content-Security-Policy meta tag')

  return new Map(match[1].split(';').map((rawDirective) => {
    const [name, ...sources] = rawDirective.trim().split(/\s+/)
    return [name, sources]
  }))
}

describe('main-window embedded frame security', () => {
  it('keeps the parent CSP at the strict srcdoc-compatible frame policy', () => {
    expect(indexContentSecurityPolicy().get('frame-src')).toEqual(["'none'"])
  })

  it('installs the frame guard at the main-window integration point', () => {
    const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8')
    expect(mainSource).toContain('installMainWindowFrameNavigationGuard(window.webContents)')
  })

  it('allows only inline Chromium frame documents below the main frame', () => {
    expect(shouldPreventMainWindowFrameNavigation('about:srcdoc', false)).toBe(false)
    expect(shouldPreventMainWindowFrameNavigation('about:blank', false)).toBe(false)
    expect(shouldPreventMainWindowFrameNavigation('about:srcdoc#section', false)).toBe(true)
    expect(shouldPreventMainWindowFrameNavigation('data:text/html,notice', false)).toBe(true)
    expect(shouldPreventMainWindowFrameNavigation('https://example.com/', false)).toBe(true)
    expect(shouldPreventMainWindowFrameNavigation('xingmang://app/index.html', false)).toBe(true)
    expect(shouldPreventMainWindowFrameNavigation('https://example.com/', true)).toBe(false)
  })

  it('prevents a subframe from leaving its inline document', () => {
    let listener: ((event: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void) | undefined
    const contents = {
      on: vi.fn((eventName: string, candidate: typeof listener) => {
        expect(eventName).toBe('will-frame-navigate')
        listener = candidate
        return contents
      }),
    }
    installMainWindowFrameNavigationGuard(contents as unknown as WebContents)

    const preventExternal = vi.fn()
    listener?.({ url: 'https://example.com/', isMainFrame: false, preventDefault: preventExternal })
    expect(preventExternal).toHaveBeenCalledOnce()

    const permitSrcdoc = vi.fn()
    listener?.({ url: 'about:srcdoc', isMainFrame: false, preventDefault: permitSrcdoc })
    expect(permitSrcdoc).not.toHaveBeenCalled()

    const leaveMainFrameToExistingGuard = vi.fn()
    listener?.({ url: 'https://example.com/', isMainFrame: true, preventDefault: leaveMainFrameToExistingGuard })
    expect(leaveMainFrameToExistingGuard).not.toHaveBeenCalled()
  })
})
