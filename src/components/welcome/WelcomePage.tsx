import { useEffect, useState } from 'react'
import { ArrowRight, LoaderCircle, PackageCheck, Sparkles, Target } from 'lucide-react'
import QRCode from 'qrcode'
import logoUrl from '../../../assets/icon.png'
import logoWhiteUrl from '../../../assets/icon-white.png'
import type { ThemeMode } from '../../app-shared'
import { providers } from '../../provider-meta'
import { supportServiceUrl, type LegalDocumentKind, type ProviderId } from '../../types'
import { LegalDocumentDialog } from '../account/LegalDocumentDialog'

interface ConstellationNode {
  id: ProviderId
  label: string
  position: 'top' | 'right' | 'bottom' | 'left'
}

// Node order/labels mirror the finalized mockup (docs/mockups/welcome-draft.html)
// verbatim; only the dot color is sourced live from provider-meta.ts instead of
// being copied as a literal hex, so it can never drift from the real brand color.
//
// 星图是固定的四方位（上/右/下/左）视觉布局，故意不从 provider-registry 派生
// provider 集合：新增第 5 个 provider 时这四个方位本就要重新设计，派生反而会
// 在布局撑不下时静默错位，硬编码在这里是有意为之。
const constellationNodes: ConstellationNode[] = [
  { id: 'claude', label: 'Claude Code', position: 'top' },
  { id: 'codex', label: 'Codex', position: 'right' },
  { id: 'gemini', label: 'Gemini', position: 'bottom' },
  { id: 'grok', label: 'Grok', position: 'left' },
]

const heroCards = [
  {
    Icon: PackageCheck,
    title: '不用敲命令',
    body: '环境、工具、配置点几下就好。装失败会自动撤回，不会留下半成品。',
  },
  {
    Icon: Target,
    title: '用的就是原厂模型',
    body: '请求转到各家官方接口，不会偷偷换成更小的模型。用量随时能对账。',
  },
  {
    Icon: Sparkles,
    title: '一个账号就够',
    body: '注册后自动准备四把 Key，额度共用，不用到处申请再一个个填。',
  },
]

export function WelcomePage({
  theme,
  onRegister,
  onLogin,
  onOpenSupport,
}: {
  theme: ThemeMode
  onRegister: () => void
  onLogin: () => void
  onOpenSupport: () => void
}) {
  const [legalKind, setLegalKind] = useState<LegalDocumentKind | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)
  const [qrAttempt, setQrAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setQrDataUrl(null)
    setQrError(false)
    void QRCode.toDataURL(supportServiceUrl, {
      width: 192,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#171717', light: '#ffffff' },
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl)
    }).catch(() => {
      if (active) setQrError(true)
    })
    return () => { active = false }
  }, [qrAttempt])

  const handleSupportClick = () => {
    // A support click is also a retry opportunity after a local QR renderer
    // failure; the support dialog remains the reliable direct-contact path.
    if (qrError) setQrAttempt((attempt) => attempt + 1)
    onOpenSupport()
  }

  if (legalKind) {
    return <LegalDocumentDialog kind={legalKind} onClose={() => setLegalKind(null)} />
  }

  return (
    <div className="welcome-page">
      <div className="welcome-aurora" aria-hidden="true" />
      <div className="welcome-content">
        <header className="welcome-nav">
          <div className="welcome-brand">
            <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} className="welcome-brand-logo" alt="星芒AI" />
            <span className="welcome-brand-name"><span>星芒</span>AI</span>
          </div>
        </header>

        <div className="welcome-hero">
          <div className="welcome-hero-copy">
            <span className="welcome-eyebrow">一个账号，四家工具都能用</span>
            <h1 className="welcome-title">装好就能用的<br />AI 编程工具</h1>
            <p className="welcome-sub">
              不用敲命令。登录后按提示安装，就能打开 Claude、Codex、Gemini、Grok。
            </p>

            <div className="welcome-cta-row">
              <button type="button" className="welcome-cta-primary" onClick={onRegister}>
                免费注册
                <span className="welcome-cta-arrow" aria-hidden="true"><ArrowRight size={16} /></span>
              </button>
              <button type="button" className="welcome-cta-login" onClick={onLogin}>
                登录
              </button>
            </div>

            <div className="welcome-chips">
              <span className="welcome-chip">邮箱注册，大约 1 分钟</span>
              <span className="welcome-chip">国内能直接用</span>
              <span className="welcome-chip">用多少扣多少</span>
            </div>

          </div>

          <div className="welcome-hero-visual">
            <div className="welcome-constellation">
              <svg viewBox="0 0 400 400" aria-hidden="true">
                <circle className="welcome-ring welcome-ring-inner" cx="200" cy="200" r="96" />
                <circle className="welcome-ring welcome-ring-outer" cx="200" cy="200" r="150" />
                <line className="welcome-spoke" x1="200" y1="200" x2="200" y2="60" />
                <line className="welcome-spoke" x1="200" y1="200" x2="340" y2="200" />
                <line className="welcome-spoke" x1="200" y1="200" x2="200" y2="340" />
                <line className="welcome-spoke" x1="200" y1="200" x2="60" y2="200" />
                <line className="welcome-ray" x1="200" y1="200" x2="296" y2="104" />
                <line className="welcome-ray" x1="200" y1="200" x2="296" y2="296" />
                <line className="welcome-ray" x1="200" y1="200" x2="104" y2="296" />
                <line className="welcome-ray" x1="200" y1="200" x2="104" y2="104" />
              </svg>
              <div className="welcome-star-core" aria-hidden="true">
                <Sparkles size={28} />
              </div>
              {constellationNodes.map((node) => (
                <div className={`welcome-node welcome-node-${node.position}`} key={node.id}>
                  <i style={{ background: providers[node.id].color }} aria-hidden="true" />
                  {node.label}
                </div>
              ))}
            </div>
            <p className="welcome-constell-cap">一个账号，四家工具共用余额</p>
          </div>
        </div>

        <div className="welcome-cards3">
          {heroCards.map((card) => (
            <div className="welcome-card" key={card.title}>
              <div className="welcome-card-icon"><card.Icon size={20} aria-hidden="true" /></div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </div>
          ))}
        </div>

        <footer className="welcome-foot">
          <div className="welcome-foot-left">
            <span>{`© ${new Date().getFullYear()} 星芒 AI`}</span>
            <span className="welcome-foot-dot">·</span>
            <button
              type="button"
              className="account-inline-link"
              onClick={() => setLegalKind('user-agreement')}
            >用户协议</button>
            <span className="welcome-foot-dot">·</span>
            <button
              type="button"
              className="account-inline-link"
              onClick={() => setLegalKind('privacy-policy')}
            >隐私政策</button>
            <span className="welcome-foot-dot">·</span>
            <span>账号后台 <code>xm.solov.cc</code></span>
          </div>
          <button
            type="button"
            className="welcome-cs"
            onClick={handleSupportClick}
            title={qrError ? '二维码暂不可用，直接打开客服' : '扫码添加客服'}
            aria-label={qrError ? '二维码暂不可用，直接打开客服' : '扫码添加客服'}
          >
            <span className="welcome-cs-qr">
              {qrDataUrl
                ? <img src={qrDataUrl} alt="" className="welcome-cs-qr-image" />
                : qrError
                  ? <span className="welcome-cs-qr-error" role="img" aria-label="二维码生成失败">!</span>
                  : <LoaderCircle size={18} className="spin" aria-hidden="true" />}
            </span>
            <span className="welcome-cs-copy" aria-live="polite">
              <strong>{qrError ? '直接联系客服' : '扫码加客服'}</strong>
              <span>{qrError ? '二维码暂不可用，点此打开客服' : '企业微信，点这里也能打开'}</span>
            </span>
          </button>
        </footer>
      </div>
    </div>
  )
}
