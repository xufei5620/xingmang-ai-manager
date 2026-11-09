import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canvasHostKind } from '../host-kind'
import { applyCanvasAppearance, applyCanvasHost } from './canvas-theme'

// 桌面画布是雾青绿、主窗口是黑金或晨曦金（桌面 #1103）。桌面改成按深浅色交 obsidian / dawn 以后，
// 网页的两套默认配色正好挂在这两个皮肤上，桌面画布会变成网页的灰橙色，还是跟主窗口不一样。
const brand = readFileSync(new URL('./brand-appearance.css', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

function skinSelectors(source: string): string[] {
  return [...source.matchAll(/(^|\})\s*([^{}]*\[data-skin=[^{}]*)\{/g)].map((match) => match[2].trim())
}

function target() {
  return { documentElement: { dataset: {} as Record<string, string | undefined>, style: { colorScheme: '' } }, querySelector: () => null }
}

describe('canvas host palette', () => {
  it('keeps both web default palettes off the desktop page', () => {
    const selectors = skinSelectors(brand)
    expect(selectors).toHaveLength(2)
    expect(selectors.some((selector) => selector.includes("[data-theme='light'][data-skin='dawn']"))).toBe(true)
    expect(selectors.some((selector) => selector.includes("[data-theme='dark'][data-skin='obsidian']"))).toBe(true)
    for (const selector of selectors) expect(selector).toContain(":not([data-host='desktop'])")
  })

  it('marks the page with its host before it paints', () => {
    const page = target()
    applyCanvasHost('desktop', page)
    expect(page.documentElement.dataset.host).toBe('desktop')
    applyCanvasHost('web', page)
    expect(page.documentElement.dataset.host).toBe('web')
    expect(entry.indexOf('applyCanvasHost()')).toBeGreaterThan(-1)
    expect(entry.indexOf('applyCanvasHost()')).toBeLessThan(entry.indexOf('applyCanvasAppearance(initialAppearance)'))
  })

  it('marks the build host by default and leaves the host mark alone when the appearance changes', () => {
    const page = target()
    applyCanvasHost(undefined, page)
    expect(page.documentElement.dataset.host).toBe(canvasHostKind)
    applyCanvasAppearance({ theme: 'light', uiSkin: 'dawn' }, page)
    applyCanvasAppearance({ theme: 'dark', uiSkin: 'obsidian' }, page)
    expect(page.documentElement.dataset).toMatchObject({ host: canvasHostKind, theme: 'dark', skin: 'obsidian' })
  })
})
