import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSafeLocalTextFontFamily, quoteLocalTextFontFamily } from './local-font-family'

describe('local text font access', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('accepts bounded family names without allowing CSS or remote sources', () => {
    for (const family of ['Noto Sans SC', '苹方-简', 'A-OTF Gothic', 'École_1.2']) expect(isSafeLocalTextFontFamily(family)).toBe(true)
    for (const family of ['', ' Arial', 'Arial ', 'Arial,serif', 'url(https://example.test)', 'x"', 'x\n', 'a'.repeat(101), 'system-ui;']) expect(isSafeLocalTextFontFamily(family)).toBe(false)
    expect(quoteLocalTextFontFamily('Noto Sans SC')).toBe('"Noto Sans SC"')
    expect(() => quoteLocalTextFontFamily('x",serif')).toThrow('名称无效')
  })

  it('does not enumerate or load fonts until explicitly requested', async () => {
    const queryLocalFonts = vi.fn()
    vi.stubGlobal('window', { isSecureContext: true, queryLocalFonts })
    const fonts = await import('./local-text-fonts')
    expect(fonts.localTextFontAccessSupported()).toBe(true)
    expect(fonts.isLocalTextFontReady('Test Family')).toBe(false)
    expect(queryLocalFonts).not.toHaveBeenCalled()
  })

  it('returns unique safe families without reading or persisting font bytes', async () => {
    const blob = vi.fn(() => { throw new Error('must not read files') })
    const queryLocalFonts = vi.fn(async () => [{ family: 'Test Family', blob }, { family: 'Test Family', blob }, { family: '星芒字体', blob }, { family: 'url(x)', blob }])
    vi.stubGlobal('window', { isSecureContext: true, queryLocalFonts })
    const fonts = await import('./local-text-fonts')
    expect(await fonts.requestLocalTextFontFamilies()).toEqual(['Test Family', '星芒字体'].sort((a, b) => a.localeCompare(b)))
    expect(queryLocalFonts).toHaveBeenCalledTimes(1)
    expect(blob).not.toHaveBeenCalled()
    expect(fonts.isLocalTextFontReady('Test Family', 700)).toBe(true)
  })

  it('reports unsupported and denied access without choosing a fallback', async () => {
    vi.stubGlobal('window', { isSecureContext: false })
    const fonts = await import('./local-text-fonts')
    expect(fonts.localTextFontAccessSupported()).toBe(false)
    await expect(fonts.requestLocalTextFontFamilies()).rejects.toThrow('不支持')
    const denial = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    vi.stubGlobal('window', { isSecureContext: true, queryLocalFonts: vi.fn(async () => { throw denial }) })
    await expect(fonts.requestLocalTextFontFamilies()).rejects.toThrow('当前文字和字体配置已保留')
    expect(() => fonts.assertLocalTextFontReady('Unavailable Family')).toThrow('尚未就绪')
  })

  it('deduplicates a saved family check and only resolves a local source', async () => {
    let complete: (() => void) | undefined
    const load = vi.fn(() => new Promise<void>((resolve) => { complete = resolve }))
    const source = vi.fn()
    vi.stubGlobal('FontFace', class { constructor(...args: unknown[]) { source(...args) } load = load })
    const fonts = await import('./local-text-fonts')
    const a = fonts.prepareLocalTextFont('Saved Family', 600), b = fonts.prepareLocalTextFont('Saved Family', 600)
    expect(a).toBe(b)
    expect(source).toHaveBeenCalledWith('xingmang-local-font-check', 'local("Saved Family")', { weight: '600' })
    expect(fonts.isLocalTextFontReady('Saved Family', 600)).toBe(false)
    complete?.()
    await a
    expect(fonts.isLocalTextFontReady('Saved Family', 600)).toBe(true)
    expect(fonts.isLocalTextFontReady('Saved Family', 400)).toBe(false)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('retains unavailability after a timed-out font completes late', async () => {
    vi.useFakeTimers()
    let complete: (() => void) | undefined
    vi.stubGlobal('FontFace', class { load() { return new Promise<void>((resolve) => { complete = resolve }) } })
    const fonts = await import('./local-text-fonts')
    const pending = fonts.prepareLocalTextFont('Slow Family')
    const rejection = expect(pending).rejects.toThrow('加载超时')
    await vi.advanceTimersByTimeAsync(8000)
    await rejection
    complete?.()
    await Promise.resolve()
    expect(fonts.isLocalTextFontReady('Slow Family')).toBe(false)
  })

  it('rejects a missing saved family and allows an explicit later retry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('not installed')).mockResolvedValueOnce(undefined)
    vi.stubGlobal('FontFace', class { load = load })
    const fonts = await import('./local-text-fonts')
    await expect(fonts.prepareLocalTextFont('Missing Family')).rejects.toThrow('当前设备不可用')
    expect(fonts.isLocalTextFontReady('Missing Family')).toBe(false)
    await fonts.prepareLocalTextFont('Missing Family')
    expect(fonts.isLocalTextFontReady('Missing Family')).toBe(true)
  })

  it('invalidates a previously ready font after a successful inventory refresh', async () => {
    vi.stubGlobal('FontFace', class { async load() {} })
    vi.stubGlobal('window', { isSecureContext: true, queryLocalFonts: async () => [{ family: 'Still Installed' }] })
    const fonts = await import('./local-text-fonts')
    await fonts.prepareLocalTextFont('Removed Family')
    await fonts.requestLocalTextFontFamilies()
    expect(fonts.isLocalTextFontReady('Removed Family')).toBe(false)
    await expect(fonts.prepareLocalTextFont('Removed Family')).rejects.toThrow('当前设备不可用')
    expect(fonts.isLocalTextFontReady('Still Installed')).toBe(true)
  })

  it('prevents a font probe from restoring readiness after an inventory refresh', async () => {
    let finish: (() => void) | undefined
    vi.stubGlobal('FontFace', class { load() { return new Promise<void>((resolve) => { finish = resolve }) } })
    vi.stubGlobal('window', { isSecureContext: true, queryLocalFonts: async () => [{ family: 'Still Installed' }] })
    const fonts = await import('./local-text-fonts')
    const pending = fonts.prepareLocalTextFont('Removed Family')
    const rejected = expect(pending).rejects.toThrow('字体列表已更新')
    await fonts.requestLocalTextFontFamilies()
    finish?.()
    await rejected
    expect(fonts.isLocalTextFontReady('Removed Family')).toBe(false)
  })

  it('clears cached readiness when an explicit inventory is now empty', async () => {
    vi.stubGlobal('FontFace', class { async load() {} })
    vi.stubGlobal('window', { isSecureContext: true, queryLocalFonts: async () => [] })
    const fonts = await import('./local-text-fonts')
    await fonts.prepareLocalTextFont('Removed Family')
    await expect(fonts.requestLocalTextFontFamilies()).rejects.toThrow('未找到可用')
    expect(fonts.isLocalTextFontReady('Removed Family')).toBe(false)
  })
})
