import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DevelopmentPreview } from './DevelopmentPreview'

describe('DevelopmentPreview', () => {
  it('renders the redesigned welcome surface without an Electron bridge', () => {
    const markup = renderToStaticMarkup(<DevelopmentPreview />)
    expect(markup).toContain('data-development-preview="true"')
    expect(markup).toContain('免费注册')
    expect(markup).toContain('登录')
    expect(markup).toContain('开发预览')
  })
})
