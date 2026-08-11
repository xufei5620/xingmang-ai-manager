import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, FileText, LoaderCircle, RefreshCw, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import { errorMessage } from '../../error-message'
import {
  privacyPolicyUrl,
  userAgreementUrl,
  type LegalDocument,
  type LegalDocumentKind,
} from '../../types'

const fallbackTitles: Record<LegalDocumentKind, string> = {
  'user-agreement': '用户协议',
  'privacy-policy': '隐私政策',
}

const fallbackUrls: Record<LegalDocumentKind, string> = {
  'user-agreement': userAgreementUrl,
  'privacy-policy': privacyPolicyUrl,
}

export function legalDocumentTitle(document: LegalDocument | null, kind: LegalDocumentKind): string {
  const heading = document?.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || fallbackTitles[kind]
}

export function LegalDocumentDialog({ kind, onClose }: {
  kind: LegalDocumentKind
  onClose: () => void
}) {
  const [document, setDocument] = useState<LegalDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const next = await window.xingmang.getLegalDocument(kind)
      if (requestId === requestIdRef.current) setDocument(next)
    } catch (error) {
      if (requestId === requestIdRef.current) setLoadError(errorMessage(error))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    void load()
    return () => { requestIdRef.current += 1 }
  }, [load])

  const title = legalDocumentTitle(document, kind)
  return (
    <DialogBackdrop className="config-modal-backdrop legal-document-backdrop" onDismiss={onClose}>
      <section className="legal-document-dialog" {...dialogAriaProps('legal-document-title')}>
        <header className="legal-document-head">
          <span className="legal-document-icon"><FileText size={19} /></span>
          <div>
            <h2 id="legal-document-title">{title}</h2>
            <small>星芒 AI 服务条款</small>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="legal-document-body" aria-busy={loading}>
          {loading && !document && (
            <div className="legal-document-state" role="status">
              <LoaderCircle className="spin" size={24} />
              <span>正在加载文档</span>
            </div>
          )}
          {loadError && !document && (
            <div className="legal-document-state" role="alert">
              <strong>文档加载失败</strong>
              <span>{loadError}</span>
              <div>
                <button className="secondary-button" type="button" onClick={() => void load()}>
                  <RefreshCw size={15} /> 重试
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void window.xingmang.openExternal(fallbackUrls[kind])}
                >
                  <ExternalLink size={15} /> 浏览器查看
                </button>
              </div>
            </div>
          )}
          {document && (
            <article className="legal-document-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  a: ({ children }) => <span className="legal-document-link">{children}</span>,
                  img: ({ alt }) => <span className="legal-document-image">[图片已隐藏{alt ? `：${alt}` : ''}]</span>,
                }}
              >
                {document.markdown}
              </ReactMarkdown>
            </article>
          )}
        </div>

        <footer className="legal-document-actions">
          <button className="primary-button" type="button" onClick={onClose}>知道了</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}
