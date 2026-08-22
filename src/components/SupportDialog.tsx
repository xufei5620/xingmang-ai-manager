import { useEffect, useState } from 'react'
import { ExternalLink, Headset, LoaderCircle, X } from 'lucide-react'
import QRCode from 'qrcode'
import { dialogAriaProps } from './Dialog'

export function SupportDialog({
  url,
  onClose,
  onOpen,
}: {
  url: string
  onClose: () => void
  onOpen: () => void
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setQrDataUrl(null)
    setQrError(null)
    void QRCode.toDataURL(url, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#172126', light: '#ffffff' },
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl)
    }).catch(() => {
      if (active) setQrError('二维码生成失败，请使用下方按钮直接联系售后')
    })
    return () => { active = false }
  }, [url])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
      <section className="support-dialog" {...dialogAriaProps('support-dialog-title')}>
        <header className="support-dialog-head">
          <span className="support-dialog-icon"><Headset size={19} /></span>
          <div>
            <h2 id="support-dialog-title">联系客服</h2>
            <small>扫码添加客服，获取使用帮助</small>
          </div>
          <button className="icon-button compact" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="support-dialog-body">
          <div className="support-qr-panel">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="售后服务二维码" className="support-qr-image" />
            ) : qrError ? (
              <div className="support-qr-error" role="alert">{qrError}</div>
            ) : (
              <div className="support-qr-loading" role="status">
                <LoaderCircle className="spin" size={24} />
                <span>正在生成二维码</span>
              </div>
            )}
          </div>
          <p className="support-dialog-hint">微信扫码添加客服，也可以直接打开客服页面。</p>
        </div>

        <footer className="support-dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          <button type="button" className="primary-button" onClick={onOpen}>
            <ExternalLink size={16} />
            直接联系
          </button>
        </footer>
      </section>
  )
}
