import { useMemo, type ReactNode } from 'react'
import { parseSafeMarkdown, type MarkdownInline } from './safe-markdown'

function inline(parts: MarkdownInline[]): ReactNode {
  return parts.map((part, index) => {
    if (part.kind === 'text') return part.text
    if (part.kind === 'code') return <code key={index}>{part.text}</code>
    if (part.kind === 'strong') return <strong key={index}>{inline(part.children)}</strong>
    if (part.kind === 'em') return <em key={index}>{inline(part.children)}</em>
    if (part.kind === 'strike') return <del key={index}>{inline(part.children)}</del>
    if (part.kind === 'image') return <span key={index} className="canvas-text-image-placeholder" role="note"><span>图片 · {part.label || '未命名图片'}</span><small>为保护隐私，图片不会自动加载</small>{part.href ? <a href={part.href} target="_blank" rel="noopener noreferrer nofollow">打开图片链接 ↗</a> : <small>图片地址不可打开</small>}</span>
    if (part.kind === 'link') return part.href ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.label || part.href}</a> : <span key={index} className="canvas-text-invalid-link" title="仅允许不含凭据的 HTTP / HTTPS 链接">{part.label || part.rawHref}</span>
    return null
  })
}

/** downloadable is false where the host blocks page downloads, so the note does not point at a download the client lacks. */
export function SafeMarkdownPreview({ value, downloadable = true }: { value: string; downloadable?: boolean }) {
  const preview = useMemo(() => parseSafeMarkdown(value), [value])
  return <div className="canvas-text-markdown">
    {preview.truncated && <p className="canvas-text-preview-limit" role="note">长文本预览仅展示前 {preview.displayedCharacters.toLocaleString('zh-CN')} 字符；{downloadable ? '源码、复制和下载保留全文' : '源码和复制保留全文'}。</p>}
    {!value && <p className="canvas-text-preview-empty">开始输入文字，预览会显示在这里</p>}
    {preview.blocks.map((block, index) => {
      if (block.kind === 'divider') return <hr key={index} />
      if (block.kind === 'code') return <pre key={index}>{block.language && <span className="canvas-text-code-language">{block.language}</span>}<code>{block.text}</code></pre>
      if (block.kind === 'list') return block.ordered ? <ol key={index} start={block.start}>{block.items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ol> : <ul key={index}>{block.items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>
      if (block.kind === 'heading') {
        const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return <Tag key={index}>{inline(block.children)}</Tag>
      }
      return block.kind === 'quote' ? <blockquote key={index}>{inline(block.children)}</blockquote> : <p key={index}>{inline(block.children)}</p>
    })}
  </div>
}
