import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SafeMarkdownPreview } from './SafeMarkdownPreview'
import { markdownPreviewCharacterLimit, parseSafeMarkdown, safeMarkdownHref } from './safe-markdown'

function markup(value: string, downloadable?: boolean) { return renderToStaticMarkup(createElement(SafeMarkdownPreview, { value, downloadable })) }
describe('bounded safe text preview', () => {
  it('renders supported formatting, lists, quoted text and fenced code', () => {
    const html = markup('# Heading\n## Two\n### Three\n\n**bold** *italic* ~~strike~~ `code`\n\n- first\n- second\n\n3. third\n4. fourth\n\n> a quote\n> next line\n\n```ts\nconst x = "<script>"\n```\n\n---')
    expect(html).toContain('<h1>Heading</h1>'); expect(html).toContain('<h2>Two</h2>'); expect(html).toContain('<h3>Three</h3>')
    expect(html).toContain('<strong>bold</strong>'); expect(html).toContain('<em>italic</em>'); expect(html).toContain('<del>strike</del>')
    expect(html).toContain('<ul><li>first</li><li>second</li></ul>'); expect(html).toContain('<ol start="3">'); expect(html).toContain('<blockquote>a quote\nnext line</blockquote>')
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('<hr/>')
  })
  it('renders hostile HTML literally and never creates image resource requests', () => {
    const html = markup('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n![private](https://example.com/tracker.png)\n![inline](data:image/svg+xml,evil)\n[bad](javascript:alert(1))\n[ok](https://example.com/a?q=1)')
    expect(html).not.toMatch(/<(?:img|script|iframe)\b/); expect(html).not.toMatch(/<[^>]+\ssrc=/); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('href="data:')
    expect(html).toContain('&lt;img'); expect(html).toContain('图片不会自动加载'); expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('href="https://example.com/tracker.png"'); expect(html).toContain('target="_blank"')
  })
  it.each(['javascript:alert(1)', 'data:text/html,x', '//example.com', '/path', 'https://user:secret@example.com', 'https://example.com/\nfoo', 'https://example.com/ foo', 'file:///etc/passwd', 'https://'])('rejects unsafe or ambiguous navigation %s', (url) => { expect(safeMarkdownHref(url)).toBeNull() })
  it('preserves escaped formatting and nested link parentheses as text-safe nodes', () => {
    const html = markup('\\*plain\\* and [page](https://example.com/path_(part))\n\n``a ` b``')
    expect(html).toContain('*plain*'); expect(html).toContain('href="https://example.com/path_(part)"'); expect(html).toContain('<code>a ` b</code>')
  })
  it('does not point at downloading where the host blocks page downloads', () => {
    const html = markup('字'.repeat(100_000), false)
    expect(html).toContain('源码和复制保留全文'); expect(html).not.toContain('下载')
  })
  it('limits preview only with a visible disclosure and retains the complete input', () => {
    const value = '字'.repeat(100_000), preview = parseSafeMarkdown(value)
    expect(preview.truncated).toBe(true); expect(preview.displayedCharacters).toBe(markdownPreviewCharacterLimit)
    expect(markup(value)).toContain('源码、复制和下载保留全文'); expect(value.length).toBe(100_000)
    const surrogate = 'x'.repeat(markdownPreviewCharacterLimit - 1) + '😀'
    expect(parseSafeMarkdown(surrogate).displayedCharacters).toBe(markdownPreviewCharacterLimit - 1)
  })
  it('bounds adversarial block and inline structure without losing remaining preview text', () => {
    const blocks = parseSafeMarkdown('# x\n'.repeat(8_000) + 'END')
    expect(blocks.blocks.length).toBeLessThanOrEqual(1_001)
    expect(JSON.stringify(blocks)).toContain('END')
    const dense = parseSafeMarkdown('**x** '.repeat(6_000))
    expect(JSON.stringify(dense).length).toBeLessThan(500_000)
    expect(markup('<script>'.repeat(5_000))).not.toContain('<script>')
  })
})
