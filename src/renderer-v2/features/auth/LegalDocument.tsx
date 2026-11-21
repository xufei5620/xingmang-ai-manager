import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { LegalDocumentKind } from '../../../../electron/ipc-contract'
import { Button, Dialog } from '../../ui'
import { BlockedLinkHint, openExternalOrCopy, type BlockedLinkNotice } from '../../external-link-fallback'
import { MarkdownView, preloadMarkdown } from '../../markdown-view'
import type { AuthApi } from './api'
import { authErrorMessage } from './state'

export function LegalDocument({ api, kind, onClose }: { api: AuthApi; kind: LegalDocumentKind; onClose: () => void }) {
  const [markdown, setMarkdown] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [blockedLink, setBlockedLink] = useState<BlockedLinkNotice | null>(null)
  useEffect(() => {
    let current = true
    setBusy(true); setMarkdown(''); setError(''); setBlockedLink(null)
    // 排版那份代码不在首屏包里（R9），跟读协议并着从本机读进来。
    void preloadMarkdown()
    void api.getLegal(kind).then((document) => { if (current) setMarkdown(document.markdown) }, (reason: unknown) => { if (current) setError(authErrorMessage(reason, '读取文档')) }).finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [api, kind, revision])
  return <Dialog open title={kind === 'user-agreement' ? '用户协议' : '隐私政策'} width={640} onClose={onClose} testId="legal-document-dialog" footer={<Button variant="primary" onClick={onClose} testId="legal-document-close">返回</Button>}>
    <div className="auth-legal-document" aria-busy={busy}>
      {busy && <p role="status">正在读取文档</p>}
      {blockedLink && <BlockedLinkHint notice={blockedLink} testId="legal-document-blocked-link" />}
      {error && <div role="alert"><p className="auth-error">{error}</p><Button icon={RefreshCw} onClick={() => setRevision((value) => value + 1)} testId="legal-document-retry">重新读取</Button></div>}
      {!busy && !error && (markdown ? <MarkdownView fallback={<p role="status">正在读取文档</p>} text={markdown} components={{ img: ({ alt }) => <span>{alt ?? ''}</span>, a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void openExternalOrCopy(href, api.openExternal).then(setBlockedLink, (reason: unknown) => setError(authErrorMessage(reason, '打开链接'))) }}>{children}</a> }} /> : <p>暂未提供文档内容，请稍后重试。</p>)}
    </div>
  </Dialog>
}
