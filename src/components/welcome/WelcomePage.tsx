import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, CircleHelp, LoaderCircle, PackageCheck, Sparkles, Target } from 'lucide-react'
import QRCode from 'qrcode'
import logoUrl from '../../../assets/brand/v3/micro32-standard.svg'
import logoWhiteUrl from '../../../assets/brand/v3/micro32-dark.svg'
import logoCoreUrl from '../../../assets/brand/v3/symbol-standard.svg'
import logoCoreWhiteUrl from '../../../assets/brand/v3/symbol-dark.svg'
import wordmarkUrl from '../../../assets/brand/v3/wordmark-standard.svg'
import wordmarkWhiteUrl from '../../../assets/brand/v3/wordmark-dark.svg'
import type { ThemeMode } from '../../app-shared'
import { providers } from '../../provider-meta'
import { supportServiceUrl, type LegalDocumentKind, type ProviderId } from '../../types'
import { LegalDocumentDialog } from '../account/LegalDocumentDialog'
import { WelcomeStarfield } from './WelcomeStarfield'
import './welcome-v3.css'

interface ConstellationNode {
  id: ProviderId
  label: string
  position: 'top' | 'right' | 'bottom' | 'left'
}

// The four positions are the two-orbit composition from the supplied design.
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
    body: '检测环境、安装工具、连接账号，在这里逐步完成。',
  },
  {
    Icon: Target,
    title: '保留你的使用方式',
    body: '星芒中转和已有官方账号按需选择，已有配置由你决定。',
  },
  {
    Icon: Sparkles,
    title: '一个账号就够',
    body: '统一管理工具密钥与星芒用量，准备结果逐项确认。',
  },
]

export function WelcomePage({
  theme,
  onRegister,
  onLogin,
  onOpenSupport,
  onOpenGuide,
  onOpenSavedAccounts,
  reducedMotion = false,
  onReducedMotionChange,
}: {
  theme: ThemeMode
  onRegister: () => void
  onLogin: () => void
  onOpenSupport: () => void
  onOpenGuide?: () => void
  onOpenSavedAccounts?: () => void
  reducedMotion?: boolean
  onReducedMotionChange?: (reduced: boolean) => void
}) {
  const [legalKind, setLegalKind] = useState<LegalDocumentKind | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)
  const [qrAttempt, setQrAttempt] = useState(0)
  const [localReducedMotion, setLocalReducedMotion] = useState(false)
  const [systemReducedMotion, setSystemReducedMotion] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [globalReducedMotion, setGlobalReducedMotion] = useState(false)
  const motionReduced = reducedMotion || localReducedMotion || systemReducedMotion || globalReducedMotion

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const readPreference = () => setSystemReducedMotion(preference.matches)
    const readVisibility = () => setHidden(document.hidden)
    const readGlobalMotion = () => setGlobalReducedMotion(['true', '1'].includes(document.documentElement.dataset.reducedMotion ?? ''))
    const observer = new MutationObserver(readGlobalMotion)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    preference.addEventListener('change', readPreference)
    document.addEventListener('visibilitychange', readVisibility)
    readPreference()
    readVisibility()
    readGlobalMotion()
    return () => {
      observer.disconnect()
      preference.removeEventListener('change', readPreference)
      document.removeEventListener('visibilitychange', readVisibility)
    }
  }, [])

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
    <div className="welcome-page welcome-v3" data-motion-paused={motionReduced || hidden ? 'true' : 'false'}>
      <WelcomeStarfield theme={theme} paused={motionReduced || hidden} />
      <div className="welcome-content">
        <header className="welcome-nav">
          <span className="welcome-nav-spacer" aria-hidden="true" />
          <div className="welcome-nav-actions">
            <label className="welcome-motion-toggle">
              <input type="checkbox" checked={motionReduced} disabled={systemReducedMotion} onChange={(event) => {
                if (onReducedMotionChange) onReducedMotionChange(event.target.checked)
                else setLocalReducedMotion(event.target.checked)
              }} />
              减少动画
            </label>
            <button type="button" className="icon-button" onClick={onOpenSupport} aria-label="帮助与客服" title="帮助与客服">
              <CircleHelp size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="welcome-hero">
          <div className="welcome-hero-copy">
            <div className="welcome-hero-brandline" aria-label="星芒 AI">
              <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} className="welcome-hero-brand-symbol" alt="星芒" />
              <img src={theme === 'dark' ? wordmarkWhiteUrl : wordmarkUrl} className="welcome-hero-brand-wordmark" alt="星芒 AI" />
            </div>
            <h1 className="welcome-title">装好就能用的<br /><em>AI 编程工具</em></h1>
            <p className="welcome-sub">
              一个账号，四家工具。环境、安装、Key 全都由这里帮你配好——不用敲命令，不用改配置文件。
            </p>

            <div className="welcome-cta-row">
              <button type="button" className="welcome-cta-login" onClick={onLogin}>
                已有账号，登录
                <span className="welcome-cta-arrow" aria-hidden="true"><ArrowRight size={16} /></span>
              </button>
              <button type="button" className="welcome-cta-primary" onClick={onRegister}>
                免费注册
              </button>
              {onOpenSavedAccounts && <button type="button" className="welcome-guide-link" onClick={onOpenSavedAccounts}>已保存账号</button>}
            </div>

            <div className="welcome-chips">
              {constellationNodes.map((node) => <span className="welcome-chip" data-brand={node.id} key={node.id}>
                <img src={providers[node.id].icon} alt="" aria-hidden="true" />{providers[node.id].name}
              </span>)}
            </div>
            {onOpenGuide && <button type="button" className="welcome-guide-link" onClick={onOpenGuide}>
              <BookOpen size={16} aria-hidden="true" />先看看使用步骤
            </button>}
          </div>

          <div className="welcome-hero-visual" aria-label="工具箱工作台预览">
            <div className="welcome-orbit-scene welcome-constellation" aria-hidden="true">
              <div className="welcome-orbit-glow" />
              <div className="welcome-orbit-ring welcome-orbit-ring-one">
                <span className="welcome-orbit-satellite welcome-orbit-satellite-top"><img src={providers.claude.icon} alt="" />Claude Code</span>
                <span className="welcome-orbit-satellite welcome-orbit-satellite-bottom"><img src={providers.codex.icon} alt="" />Codex CLI</span>
              </div>
              <div className="welcome-orbit-ring welcome-orbit-ring-two">
                <span className="welcome-orbit-satellite welcome-orbit-satellite-right"><img src={providers.gemini.icon} alt="" />Gemini CLI</span>
                <span className="welcome-orbit-satellite welcome-orbit-satellite-left"><img src={providers.grok.icon} alt="" />Grok CLI</span>
              </div>
              <div className="welcome-orbit-core"><img src={theme === 'dark' ? logoCoreWhiteUrl : logoCoreUrl} alt="" /></div>
            </div>
            <div className="welcome-preview-workbench" aria-hidden="true">
              <div className="welcome-preview-rail"><img src={theme === 'dark' ? logoWhiteUrl : logoUrl} alt="" />{[0, 1, 2, 3, 4].map((item) => <i className={item === 0 ? 'is-active' : ''} key={item} />)}</div>
              <div className="welcome-preview-main">
                <div className="welcome-preview-heading"><strong>工具箱</strong><span>工作台预览</span></div>
                <div className="welcome-preview-tools">
                  {constellationNodes.map((node, index) => <div className="welcome-preview-tool" key={node.id}><span className="welcome-preview-tool-icon"><img src={providers[node.id].icon} alt="" /></span><span><strong>{node.label}</strong><small>{index < 2 ? '已安装 · 可配置' : '可选工具'}</small></span><b>{index < 2 ? '打开' : '查看'}</b></div>)}
                </div>
                <div className="welcome-preview-row"><span>最近记录</span><strong>在这里继续你的工作</strong></div>
              </div>
            </div>
          </div>
        </div>

        <div className="welcome-bottom">
        <div className="welcome-cards3">
            {heroCards.map((card) => (
              <div className="welcome-card" key={card.title}>
                <div className="welcome-card-icon"><card.Icon size={20} aria-hidden="true" /></div>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </div>
          ))}
          <button
            type="button"
            className="welcome-card welcome-support-card"
            onClick={handleSupportClick}
            title={qrError ? '二维码暂不可用，直接打开客服' : '扫码添加客服'}
            aria-label={qrError ? '二维码暂不可用，直接打开客服' : '扫码添加客服'}
          >
            <span className="welcome-cs-qr">
              {qrDataUrl ? <img src={qrDataUrl} alt="" className="welcome-cs-qr-image" /> : qrError ? <span className="welcome-cs-qr-error" role="img" aria-label="二维码生成失败">!</span> : <LoaderCircle size={18} className="spin" aria-hidden="true" />}
            </span>
            <span className="welcome-cs-copy"><strong>{qrError ? '直接联系客服' : '扫码加客服'}</strong><span>{qrError ? '二维码暂不可用，点此打开客服' : '企业微信，点这里也能打开'}</span></span>
          </button>
        </div>
        <footer className="welcome-foot">
          <div className="welcome-foot-left">
            <span>{`© ${new Date().getFullYear()} 星芒 AI`}</span><span className="welcome-foot-dot">·</span>
            <button type="button" className="account-inline-link" onClick={() => setLegalKind('user-agreement')}>用户协议</button><span className="welcome-foot-dot">·</span>
            <button type="button" className="account-inline-link" onClick={() => setLegalKind('privacy-policy')}>隐私政策</button><span className="welcome-foot-dot">·</span><span>账号后台 <code>xm.solov.cc</code></span>
          </div>
        </footer>
        </div>
      </div>
    </div>
  )
}
