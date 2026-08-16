import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeCell } from './RuntimeCell'

describe('RuntimeCell install action', () => {
  it('does not offer an install action for an already usable Python version', () => {
    const markup = renderToStaticMarkup(
      <RuntimeCell
        label="Python"
        status={{
          installed: true,
          version: 'Python 3.11.9',
          path: 'C:\Python311\python.exe',
          installDirectory: 'C:\Python311',
        }}
        loading={false}
        optional
        actionLabel="一键安装"
        onInstall={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain('3.11.9')
    expect(markup).not.toContain('一键安装')
  })

  it('offers installation only when Python is missing', () => {
    const markup = renderToStaticMarkup(
      <RuntimeCell
        label="Python"
        status={{ installed: false, version: null, path: null, installDirectory: null }}
        loading={false}
        optional
        actionLabel="一键安装"
        onInstall={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain('未安装')
    expect(markup).toContain('一键安装')
  })
})
