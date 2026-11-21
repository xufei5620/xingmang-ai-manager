import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export interface MarkdownRendererProps {
  text: string
  components: Components
  /** 公告要 GFM（表格、勾选框、删除线）；用户协议、隐私政策照原来只按 CommonMark 排。 */
  gfm?: boolean
}

/**
 * react-markdown 连带 remark / micromark 一整套约 150KB，只有打开公告和用户协议、隐私政策时才用。
 * 这个文件只经 markdown-view.tsx 的 import() 加载，别处不要静态引它，否则这一整套又回到首屏包里（总单 77，R9）。
 */
export function MarkdownRenderer({ text, components, gfm = false }: MarkdownRendererProps) {
  return <ReactMarkdown remarkPlugins={gfm ? [remarkGfm] : undefined} components={components}>{text}</ReactMarkdown>
}
