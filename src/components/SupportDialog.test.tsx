import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SupportDialog } from './SupportDialog'

describe('SupportDialog', () => {
  it('renders a modal contract with a recoverable QR loading state', () => {
    const markup = renderToStaticMarkup(
      <SupportDialog url="https://example.com/support" onClose={vi.fn()} onOpen={vi.fn()} />,
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('aria-labelledby="support-dialog-title"')
    expect(markup).toContain('正在生成二维码')
    expect(markup).toContain('直接联系')
  })
})
