import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ImageToolControls } from './ImageToolControls'
import { defaultImageTransformRecipe, type ImageCollageRecipe } from './recipe'

const styles = readFileSync(new URL('./image-tools.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))
  if (!match) throw new Error(`Missing style rule: ${selector}`)
  return match[1]
}

function resultPreview(width: number, height: number, localUrl = `xingmang-asset://image/${'a'.repeat(43)}`, dirty = false) {
  const onChange = vi.fn()
  const recipe: ImageCollageRecipe = { ...defaultImageTransformRecipe('collage') as ImageCollageRecipe, layout: 'horizontal', autoSize: true }
  const html = renderToStaticMarkup(createElement(ImageToolControls, {
    kind: 'image-collage', references: [], disabled: false, onChange,
    data: { prompt: '', model: '', status: 'succeeded', dirty, settings: { imageTransform: recipe }, result: { kind: 'image', assetId: 'a'.repeat(43), width, height, localUrl } },
  }))
  expect(onChange).not.toHaveBeenCalled()
  return html
}

describe('image tool result measurement boundary', () => {
  it.each([{ width: 2688, height: 640 }, { width: 960, height: 2320 }])('reserves the authoritative result ratio before decoding for %j', ({ width, height }) => {
    const html = resultPreview(width, height)
    expect(html).toContain(`class="image-tool-output-preview" style="aspect-ratio:${width / height}"`)
    expect(html).toContain('alt="图像处理结果"')
    const container = rule('.image-tool-output-preview')
    expect(container).toMatch(/position:\s*relative/)
    expect(container).toMatch(/max-height:\s*240px/)
    expect(container).toMatch(/overflow:\s*hidden/)
    // Both the loading/decoded image and SafeImage's failure element stay out
    // of flow; their intrinsic dimensions cannot enlarge the observed node.
    const media = rule('.image-tool-output-preview > img, .image-tool-output-preview > .media-unavailable')
    expect(media).toMatch(/position:\s*absolute/)
    expect(media).toMatch(/inset:\s*0/)
    expect(media).toMatch(/height:\s*100%/)
    expect(media).toMatch(/min-height:\s*0/)
    expect(media).toMatch(/object-fit:\s*contain/)
  })

  it('keeps a rejected result URL inside the same reserved frame without a network-capable image', () => {
    const html = resultPreview(640, 1920, 'https://untrusted.invalid/private-image')
    expect(html).toContain('class="image-tool-output-preview" style="aspect-ratio:0.3333333333333333"')
    expect(html).toContain('class=" media-unavailable"')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('untrusted.invalid')
  })

  it('keeps dirty configuration previews separate from the confirmed result frame', () => {
    const html = resultPreview(640, 1920, undefined, true)
    expect(html).not.toContain('class="image-tool-output-preview"')
    expect(html).toContain('编辑处理参数')
  })
})
