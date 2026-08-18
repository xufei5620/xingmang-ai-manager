import { describe, expect, it } from 'vitest'
import {
  canvasPackagedBaseUrl,
  canvasContentSecurityPolicy,
  canvasProtocolScheme,
  canvasSecurityResponseHeaders,
  resolveCanvasProtocolFile,
  type ApplicationUrlPolicy,
} from './canvas-protocol'

const policy: ApplicationUrlPolicy = {
  rendererRoot: 'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas',
  packagedBaseUrl: canvasPackagedBaseUrl,
}

describe('canvasProtocolScheme / canvasPackagedBaseUrl', () => {
  it('uses a distinct scheme from the main app protocol', () => {
    expect(canvasProtocolScheme).toBe('xingmang-canvas')
    expect(canvasPackagedBaseUrl).toBe('xingmang-canvas://app/')
  })

  it('forces the canvas CSP as a response header and replaces weaker copies', () => {
    const headers = canvasSecurityResponseHeaders({
      'content-security-policy': ["default-src *"],
      'Cache-Control': ['no-store'],
    })
    expect(headers['Content-Security-Policy']).toEqual([canvasContentSecurityPolicy])
    expect(headers['X-Content-Type-Options']).toEqual(['nosniff'])
    expect(headers['Cache-Control']).toEqual(['no-store'])
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'content-security-policy')).toHaveLength(1)
    expect(canvasContentSecurityPolicy).toContain('connect-src xingmang-asset:')
  })
})

describe('resolveCanvasProtocolFile', () => {
  it('resolves the root request to index.html', () => {
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\index.html',
    )
  })

  it('resolves a real asset path literally', () => {
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/assets/index-Bw0XXWX0.js', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\assets\\index-Bw0XXWX0.js',
    )
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/icons/claude.svg', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\icons\\claude.svg',
    )
  })

  it('falls back to index.html for an extensionless client-side route (SPA catch-all)', () => {
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/canvas/project/abc123', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\index.html',
    )
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/settings', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\index.html',
    )
  })

  it('does not treat a dotfile-style or trailing-dot segment as a real asset', () => {
    // Neither shape occurs in this build's actual asset names; both should
    // fall through to the SPA index rather than be served as a literal file.
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/.well-known', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\index.html',
    )
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/weird.', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\index.html',
    )
  })

  it('can never escape the packaged root via %2e%2e (WHATWG URL path normalization has no "above root" to escape to)', () => {
    // Unlike a file:// URL -- where /dist/%2e%2e/secret.txt has real path
    // segments (Program Files/.../dist) for ".." to legitimately pop past,
    // landing outside rendererRoot -- an authority-rooted custom scheme's
    // path can never go negative: new URL() itself collapses a leading (or
    // deeply repeated) "%2e%2e" down to at most the root, per the WHATWG URL
    // Standard's double-dot-segment handling. Confirmed empirically:
    // `new URL('xingmang-canvas://app/%2e%2e/secret.txt').pathname === '/secret.txt'`.
    // The request still resolves to a real, in-bounds path -- just not the
    // attacker's intended one -- so this is a "cannot escape root" guarantee,
    // not a "request is rejected" one.
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/%2e%2e/secret.txt', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\secret.txt',
    )
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/assets/%2e%2e/%2e%2e/%2e%2e/secret.txt', policy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist-canvas\\secret.txt',
    )
  })

  it('rejects encoded path-separator smuggling (%2f, %5c) the same way the main protocol does', () => {
    // These stay literally "%2f"/"%5c" in target.pathname (the URL parser
    // does not decode them, since neither is a real separator for this
    // scheme), so resolvePackagedApplicationFile's explicit /%2f|%5c/i guard
    // rejects them outright rather than letting a later decodeURIComponent
    // manufacture path structure the URL parser never saw.
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/assets%2fsecret.js', policy)).toBeNull()
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/%5c%5cserver/share', policy)).toBeNull()
  })

  it('rejects a mismatched scheme or host (cannot be redirected at the main app protocol, or vice versa)', () => {
    expect(resolveCanvasProtocolFile('xingmang://app/index.html', policy)).toBeNull()
    expect(resolveCanvasProtocolFile('xingmang-canvas://other/index.html', policy)).toBeNull()
    expect(resolveCanvasProtocolFile('https://xingmang-canvas/app/index.html', policy)).toBeNull()
  })

  it('rejects credentials embedded in the request URL', () => {
    expect(resolveCanvasProtocolFile('xingmang-canvas://user@app/index.html', policy)).toBeNull()
  })

  it('rejects malformed URLs outright', () => {
    expect(resolveCanvasProtocolFile('', policy)).toBeNull()
    expect(resolveCanvasProtocolFile('not a url', policy)).toBeNull()
  })

  it('returns null when the policy carries no packagedBaseUrl at all', () => {
    expect(resolveCanvasProtocolFile('xingmang-canvas://app/route', { rendererRoot: policy.rendererRoot })).toBeNull()
  })
})
