import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prerender } from 'react-dom/static'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, describe, expect, it, vi } from 'vitest'

// prerender 等懒加载的那块读完再出 HTML；去掉它插的注释标记，跟 renderToStaticMarkup 的输出一样。
async function renderSettled(node: ReactNode) {
  const { prelude } = await prerender(node)
  return (await new Response(prelude).text()).replace(/<!--(?: |\$|\/\$)-->/g, '')
}

const sample = '# 用户协议\n\n| 项目 | 说明 |\n| --- | --- |\n| 额度 | 永久有效 |\n\n~~旧条款~~ 见 [说明](https://xm.solov.cc/help)'

afterEach(() => {
  vi.doUnmock('./markdown-renderer')
  vi.resetModules()
})

describe('renderer-v2 markdown view', () => {
  it('shows only the fallback until the Markdown renderer has been loaded', async () => {
    const { MarkdownView } = await import('./markdown-view')
    const html = renderToStaticMarkup(<MarkdownView text={sample} components={{}} fallback={<p role="status">正在读取文档</p>} />)
    expect(html).toBe('<p role="status">正在读取文档</p>')
  })

  it('renders exactly what react-markdown rendered before it was loaded on demand', async () => {
    const { MarkdownView } = await import('./markdown-view')
    const components = { a: ({ href, children }: { href?: string; children?: ReactNode }) => <a href={href} rel="noreferrer">{children}</a> }
    expect(await renderSettled(<MarkdownView gfm text={sample} components={components} />))
      .toBe(renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{sample}</ReactMarkdown>))
    // 用户协议、隐私政策原来没开 GFM：表格、删除线照原样当普通文字排。
    const plain = await renderSettled(<MarkdownView text={sample} components={components} />)
    expect(plain).toBe(renderToStaticMarkup(<ReactMarkdown components={components}>{sample}</ReactMarkdown>))
    expect(plain).not.toContain('<table>')
  })

  it('falls back to the plain text instead of failing the window when the renderer cannot be read', async () => {
    vi.doMock('./markdown-renderer', () => { throw new Error('chunk missing') })
    const { MarkdownView } = await import('./markdown-view')
    const html = await renderSettled(<MarkdownView gfm text={'[危险链接](javascript:alert(1))\n<img src=x onerror=alert(1)>'} components={{}} />)
    expect(html).toBe('<p style="white-space:pre-wrap">[危险链接](javascript:alert(1))\n&lt;img src=x onerror=alert(1)&gt;</p>')
  })
})
