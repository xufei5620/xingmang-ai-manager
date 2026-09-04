import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ExternalLink, Headset, LoaderCircle, X } from 'lucide-react'
import QRCode from 'qrcode'
import { dialogAriaProps, dialogKeyboardDecision } from './Dialog'

const SUPPORT_DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function SupportDialog({
  url,
  onClose,
  onOpen,
}: {
  url: string
  onClose: () => void
  onOpen: () => void
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrAttempt, setQrAttempt] = useState(0)

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
  }, [url, qrAttempt])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = window.setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(SUPPORT_DIALOG_FOCUSABLE_SELECTOR)
      first?.focus()
    }, 0)
    const dismissFromOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && dialogRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', dismissFromOutside)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('pointerdown', dismissFromOutside)
      previous?.focus({ preventScroll: true })
    }
  }, [onClose])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(SUPPORT_DIALOG_FOCUSABLE_SELECTOR)]
    const decision = dialogKeyboardDecision({
      key: event.key,
      shiftKey: event.shiftKey,
      activeIndex: focusable.indexOf(document.activeElement as HTMLElement),
      focusableCount: focusable.length,
    })
    if (!decision.handled) return
    event.stopPropagation()
    if (decision.preventDefault) event.preventDefault()
    if (decision.dismiss) {
      onClose()
      return
    }
    if (decision.focusIndex !== null) focusable[decision.focusIndex]?.focus()
  }

  return (
      <section
        ref={dialogRef}
        className="support-dialog"
        {...dialogAriaProps('support-dialog-title')}
        onKeyDown={handleKeyDown}
      >
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
              <div className="support-qr-error" role="alert">
                <span>{qrError}</span>
                <button type="button" className="secondary-button" onClick={() => setQrAttempt((attempt) => attempt + 1)}>
                  重试
                </button>
              </div>
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
