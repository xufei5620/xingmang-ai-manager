import { lazy, Suspense, type ReactNode } from 'react'
import type { MarkdownRendererProps } from './markdown-renderer'

let renderer: Promise<{ default: (props: MarkdownRendererProps) => ReactNode }> | undefined

/**
 * 公告和用户协议、隐私政策的 Markdown 渲染不放进首屏包（总单 77，R9）：打开那个框时再从本机读进来，
 * 不出网。打开框就先调这个，跟读公告、读协议并着走，内容回来时渲染多半已经就位。
 * 这份文件读不进来（极少见）时退成原文照排，不让整个界面掉进出错页。
 */
export function preloadMarkdown() {
  renderer ??= import('./markdown-renderer').then(
    (module) => ({ default: module.MarkdownRenderer }),
    () => ({ default: PlainMarkdownText }),
  )
  return renderer
}

const LazyMarkdownRenderer = lazy(preloadMarkdown)

function PlainMarkdownText({ text }: MarkdownRendererProps) {
  return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
}

/** 读进来之前显示 fallback（缺省什么都不画），读进来以后跟原来直接用 react-markdown 排出来的一样。 */
export function MarkdownView({ fallback = null, ...props }: MarkdownRendererProps & { fallback?: ReactNode }) {
  return <Suspense fallback={fallback}><LazyMarkdownRenderer {...props} /></Suspense>
}
