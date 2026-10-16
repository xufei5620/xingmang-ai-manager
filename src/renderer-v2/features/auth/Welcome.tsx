import { useEffect, useState } from 'react'
import { ArrowUpRight, KeyRound, MessageCircle, Moon, ShieldCheck, Sun, Zap } from 'lucide-react'
import type { LegalDocumentKind } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Logo } from '../../ui'
import { welcomeOrbitItems } from '../../registry/tools'
import type { WindowOs } from '../app/window-os'
import { AuthWindow } from './AuthWindow'
import { WelcomeStarfield } from './WelcomeStarfield'
import './auth.css'

export interface WelcomeProps {
  onLogin: () => void
  onRegister: () => void
  onSteps: () => void
  /** 直接打开登录框并切到历史账号；缺省 = 不给这个入口。 */
  onHistoryLogin?: () => void
  onHelp: () => void
  onLegal: (kind: LegalDocumentKind) => void
  reducedMotion?: boolean
  onReducedMotionChange: (paused: boolean) => void
  /** 窗口条右上角的深浅色切换；不给 onThemeToggle 就不出这个按钮。 */
  theme?: 'light' | 'dark'
  onThemeToggle?: () => void
  supportQrUrl?: string
  platform?: WindowOs
}

/**
 * 低配电脑由主进程判一次，结论挂在根节点的 data-low-end 上（App.tsx）。欢迎页的星轨、
 * 闪烁、流星这些 CSS 动画据此全停，否则老电脑上光这一页就占一大截 CPU。
 */
function useLowEndDevice(): boolean {
  const [lowEnd, setLowEnd] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.lowEnd === 'true')
  useEffect(() => {
    const root = document.documentElement
    const update = () => setLowEnd(root.dataset.lowEnd === 'true')
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-low-end'] })
    return () => observer.disconnect()
  }, [])
  return lowEnd
}

/**
 * 窗口没焦点（切去别的程序）或看不见（最小化、缩到托盘）时，星轨和闪烁停在原地：露在后面没人看着，
 * 转着只是白耗 CPU 和显卡（批次性能要求 批03 第 3 条）。停用的是 animation-play-state，回来接着转，不会跳一下。
 */
function useWindowActive(): boolean {
  const [active, setActive] = useState(() => typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus()))
  useEffect(() => {
    const update = () => setActive(document.visibilityState === 'visible' && document.hasFocus())
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return active
}

export function Welcome({ onLogin, onRegister, onSteps, onHistoryLogin, onHelp, onLegal, reducedMotion = false, onReducedMotionChange, theme, onThemeToggle, supportQrUrl, platform }: WelcomeProps) {
  const [systemReduced, setSystemReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setSystemReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const lowEnd = useLowEndDevice()
  const active = useWindowActive()
  const paused = reducedMotion || systemReduced || lowEnd
  const themeToggle = onThemeToggle ? <button type="button" className="v2-topbar-icon" aria-label="切换深浅色" title="切换深浅色" onClick={onThemeToggle} data-testid="welcome-theme">{theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}</button> : null
  return <AuthWindow platform={platform} variant="welcome" actions={themeToggle}><main className="auth-welcome welcome-page welcome-v4" data-testid="welcome-page" data-motion-paused={paused} data-motion-idle={!active}>
    {/* 0.2.18 的满屏星空、连线和流星，不再用整窗画布逐帧重画（批次性能要求 批03 第 2 条）。 */}
    <WelcomeStarfield />
    <div className="auth-welcome-hero">
      <div className="auth-welcome-copy">
        {/* 标志加侧栏那份「星芒 AI」字样，横版标志下面那行英文名不放。 */}
        <div className="auth-welcome-brand"><Logo kind="symbol" height={64} /><Logo kind="wordmark" height={40} /></div>
        <h1>装好就能用的<br />AI 编程工具</h1>
        <p className="auth-welcome-lead">一个账号，用上多款 AI 编程工具。环境、安装、密钥都由这里帮你配好，不用敲命令，也不用改配置文件。</p>
        <div className="auth-welcome-cta"><Button variant="primary" onClick={onLogin} testId="welcome-login">登录</Button><Button onClick={onRegister} testId="welcome-register">注册新账号</Button></div>
        <div className="auth-welcome-links">
          <button type="button" onClick={onSteps} data-testid="welcome-steps">先看看使用步骤</button>
          {onHistoryLogin && <button type="button" onClick={onHistoryLogin} data-testid="welcome-history-login">用历史账号登录</button>}
          <button type="button" onClick={() => onLegal('user-agreement')} data-testid="welcome-terms">用户协议</button>
          <button type="button" onClick={() => onLegal('privacy-policy')} data-testid="welcome-privacy">隐私政策</button>
          {!lowEnd && <button type="button" onClick={() => onReducedMotionChange(!reducedMotion)} data-testid="welcome-motion">{reducedMotion ? '开启动画' : '减少动画'}</button>}
        </div>
      </div>
      <div className="auth-orbit-scene" role="img" aria-label="星芒与 AI 编程工具的星轨" data-testid="welcome-orbit-scene">
        {/* 10-16 yoyo 定：星轨照 0.2.18 的样子（斜着的三道椭圆、星芒的光和光柱、虚线轨道），v4 原型那一圈细线不用。 */}
        <div className="auth-orbit-ellipses" aria-hidden="true"><i /><i /><i /><b /></div>
        <div className="auth-orbit-glow" aria-hidden="true" />
        <div className="auth-orbit-beam" aria-hidden="true" />
        {/* 一圈轨道整体转，四颗每隔 90° 一个、各自反着转回来保持正着：转到哪个角度都不会叠在一起。
            只动 transform（批次性能要求 批03 第 1 条），不再动自定义属性、left 这些每帧都要重排的东西。 */}
        <div className="auth-orbit-ring">{welcomeOrbitItems.map((item, index) => <span className="auth-orbit-satellite" data-position={index} key={item.key}><span className="auth-orbit-planet"><BrandIcon tool={item.tool} model={item.model} size={22} variant="xs" />{item.name}</span></span>)}</div>
        <div className="auth-orbit-core"><Logo kind="symbol" height={105} /></div>
      </div>
    </div>
    <div className="auth-welcome-foot">
      <div className="auth-welcome-feature"><Zap size={16} aria-hidden="true" /><div><strong>不用敲命令</strong><p>点几下就装好，装失败会自动撤回。</p></div></div>
      <div className="auth-welcome-feature"><KeyRound size={16} aria-hidden="true" /><div><strong>一个账号就够</strong><p>每个工具的密钥自动配好，额度共用。</p></div></div>
      <div className="auth-welcome-feature"><ShieldCheck size={16} aria-hidden="true" /><div><strong>用量随时能对账</strong><p>余额、请求明细和密钥额度，都能在个人中心查看。</p></div></div>
      <div className="auth-welcome-support" data-testid="welcome-support">{supportQrUrl ? <img src={supportQrUrl} alt="微信客服二维码" /> : <MessageCircle size={28} aria-hidden="true" />}<div><strong>装不上？找客服</strong><p>微信扫码，装不上、付了没到账都可以问。</p><Button variant="ghost" size="xs" iconRight={ArrowUpRight} onClick={onHelp} testId="welcome-help">打开客服</Button></div></div>
    </div>
  </main></AuthWindow>
}
