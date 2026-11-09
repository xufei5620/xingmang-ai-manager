import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { canvasHostKind } from '../host-kind'
import { parseSafeMarkdown, type MarkdownInline } from './safe-markdown'

// 桌面画布窗口不许打开别的网站（宿主把画布开的新窗口一律拒掉，外链白名单也不会为模型写出来的网址放宽），
// 链接照网页那样开新标签，在桌面上就是蓝字可点、点了什么都不发生。桌面上改成点一下复制网址，
// 跟桌面主窗口聊天页一样只复制不打开；网页、嵌入照旧开新标签。
export type MarkdownLinkAction = 'open' | 'copy'

const defaultLinkAction: MarkdownLinkAction = canvasHostKind === 'desktop' ? 'copy' : 'open'

type ClipboardWriter = Pick<Clipboard, 'writeText'> | undefined

/** Copies a link's address; 'failed' when the page has no clipboard or the write is refused. */
export async function copyMarkdownLink(href: string, clipboard: ClipboardWriter = typeof navigator === 'undefined' ? undefined : navigator.clipboard): Promise<'copied' | 'failed'> {
  try {
    if (!clipboard?.writeText) return 'failed'
    await clipboard.writeText(href)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/**
 * The host a copied link leads to, shown beside a label that does not name it,
 * so a label like "官网" cannot hide where the address really goes. The host
 * comes from URL parsing: https://xm.solov.cc@evil.example shows evil.example.
 */
export function markdownLinkHost(href: string, label: string): string | null {
  let host: string
  try { host = new URL(href).hostname } catch { return null }
  if (!host) return null
  return label.toLowerCase().includes(host.toLowerCase()) ? null : host
}

function CopyLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), state === 'copied' ? 2400 : 8000)
    return () => window.clearTimeout(timer)
  }, [state])
  const host = markdownLinkHost(href, label)
  return <span className="canvas-text-link-wrap">
    <button type="button" className="canvas-text-link" title={`点一下复制网址：${href}`} onClick={() => { void copyMarkdownLink(href).then(setState) }}>{children}{host && <span className="canvas-text-link-host">（{host}）</span>}</button>
    {state === 'copied' && <span className="canvas-text-link-note" role="status">网址已复制，粘贴到浏览器地址栏就能打开</span>}
    {state === 'failed' && <span className="canvas-text-link-note" role="alert">没复制上，网址是 {href}</span>}
  </span>
}

function inline(parts: MarkdownInline[], links: MarkdownLinkAction): ReactNode {
  return parts.map((part, index) => {
    if (part.kind === 'text') return part.text
    if (part.kind === 'code') return <code key={index}>{part.text}</code>
    if (part.kind === 'strong') return <strong key={index}>{inline(part.children, links)}</strong>
    if (part.kind === 'em') return <em key={index}>{inline(part.children, links)}</em>
    if (part.kind === 'strike') return <del key={index}>{inline(part.children, links)}</del>
    if (part.kind === 'image') {
      const target = !part.href
        ? <small>图片地址不可打开</small>
        : links === 'copy'
          ? <CopyLink href={part.href} label="">复制图片链接</CopyLink>
          : <a href={part.href} target="_blank" rel="noopener noreferrer nofollow">打开图片链接 ↗</a>
      return <span key={index} className="canvas-text-image-placeholder" role="note"><span>图片 · {part.label || '未命名图片'}</span><small>为保护隐私，图片不会自动加载</small>{target}</span>
    }
    if (part.kind === 'link') {
      if (!part.href) return <span key={index} className="canvas-text-invalid-link" title="仅允许不含凭据的 HTTP / HTTPS 链接">{part.label || part.rawHref}</span>
      if (links === 'copy') return <CopyLink key={index} href={part.href} label={part.label}>{part.label || part.href}</CopyLink>
      return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.label || part.href}</a>
    }
    return null
  })
}

/**
 * downloadable is false where the host blocks page downloads, so the note does not point at a download the client lacks.
 * links is 'copy' where the host cannot open other sites (the desktop); see defaultLinkAction.
 */
export function SafeMarkdownPreview({ value, downloadable = true, links = defaultLinkAction }: { value: string; downloadable?: boolean; links?: MarkdownLinkAction }) {
  const preview = useMemo(() => parseSafeMarkdown(value), [value])
  return <div className="canvas-text-markdown">
    {preview.truncated && <p className="canvas-text-preview-limit" role="note">长文本预览仅展示前 {preview.displayedCharacters.toLocaleString('zh-CN')} 字符；{downloadable ? '源码、复制和下载保留全文' : '源码和复制保留全文'}。</p>}
    {!value && <p className="canvas-text-preview-empty">开始输入文字，预览会显示在这里</p>}
    {preview.blocks.map((block, index) => {
      if (block.kind === 'divider') return <hr key={index} />
      if (block.kind === 'code') return <pre key={index}>{block.language && <span className="canvas-text-code-language">{block.language}</span>}<code>{block.text}</code></pre>
      if (block.kind === 'list') return block.ordered ? <ol key={index} start={block.start}>{block.items.map((item, i) => <li key={i}>{inline(item, links)}</li>)}</ol> : <ul key={index}>{block.items.map((item, i) => <li key={i}>{inline(item, links)}</li>)}</ul>
      if (block.kind === 'heading') {
        const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return <Tag key={index}>{inline(block.children, links)}</Tag>
      }
      return block.kind === 'quote' ? <blockquote key={index}>{inline(block.children, links)}</blockquote> : <p key={index}>{inline(block.children, links)}</p>
    })}
  </div>
}
