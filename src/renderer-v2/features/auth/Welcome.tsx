import { useEffect, useState } from 'react'
import { ArrowUpRight, Key, MessageCircle, ShieldCheck, Zap } from 'lucide-react'
import type { LegalDocumentKind } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Card, Logo } from '../../ui'
import { tools } from '../../registry/tools'
import { Starfield } from './Starfield'
import { AuthWindow } from './AuthWindow'
import './auth.css'

export interface WelcomeProps {
  onLogin: () => void
  onRegister: () => void
  onSteps: () => void
  onHelp: () => void
  onLegal: (kind: LegalDocumentKind) => void
  reducedMotion?: boolean
  onReducedMotionChange: (paused: boolean) => void
  environmentLabel?: string
  keyStatusLabel?: string
  supportQrUrl?: string
}

export function Welcome({ onLogin, onRegister, onSteps, onHelp, onLegal, reducedMotion = false, onReducedMotionChange, environmentLabel = '环境待检测', keyStatusLabel = '登录后确认连接', supportQrUrl }: WelcomeProps) {
  const [systemReduced, setSystemReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setSystemReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const paused = reducedMotion || systemReduced
  const providers = tools.filter((tool) => tool.kind === 'cli').sort((a, b) => a.shortcutIndex - b.shortcutIndex)
  return <AuthWindow><main className="auth-welcome welcome-page welcome-v3" data-testid="welcome-page" data-motion-paused={paused}>
    <Starfield paused={paused} />
    <div className="auth-welcome-hero">
      <div className="auth-welcome-copy">
        <div className="auth-welcome-brand"><Logo kind="horizontal" height={128} /></div>
        <h1>装好就能用的<br /><em>AI 编程工具</em></h1>
        <p className="auth-welcome-lead">一个账号，四家工具。环境、安装、Key 全都由这里帮你配好，不用敲命令，不用改配置文件。</p>
        <div className="auth-welcome-brands">{providers.map((tool) => <span key={tool.id}><BrandIcon tool={tool.id} size={22} variant="xs" />{tool.name}</span>)}</div>
        <div className="auth-welcome-cta"><Button variant="primary" onClick={onLogin} testId="welcome-login">登录</Button><Button onClick={onRegister} testId="welcome-register">注册新账号</Button></div>
        <div className="auth-welcome-links"><Button variant="ghost" size="xs" onClick={onSteps} testId="welcome-steps">先看看使用步骤</Button><Button variant="ghost" size="xs" onClick={() => onReducedMotionChange(!reducedMotion)} testId="welcome-motion">{reducedMotion ? '开启动画' : '减少动画'}</Button></div>
        <div className="auth-welcome-legal"><Button variant="ghost" size="xs" onClick={() => onLegal('user-agreement')} testId="welcome-terms">用户协议</Button><Button variant="ghost" size="xs" onClick={() => onLegal('privacy-policy')} testId="welcome-privacy">隐私政策</Button></div>
      </div>
      <div className="auth-orbit-scene" aria-label="星芒与四家工具的星轨" data-testid="welcome-orbit-scene">
        <div className="auth-orbit-ellipses" aria-hidden="true"><i /><i /><i /><b /></div>
        <div className="auth-orbit-glow" aria-hidden="true" />
        <div className="auth-orbit-beam" aria-hidden="true" />
        <div className="auth-orbit-ring auth-orbit-inner">{providers.slice(0, 2).map((tool, index) => <span className="auth-orbit-satellite" data-position={index} key={tool.id}><BrandIcon tool={tool.id} size={22} variant="xs" />{tool.name}</span>)}</div>
        <div className="auth-orbit-ring auth-orbit-outer">{providers.slice(2).map((tool, index) => <span className="auth-orbit-satellite" data-position={index} key={tool.id}><BrandIcon tool={tool.id} size={22} variant="xs" />{tool.name}</span>)}</div>
        <div className="auth-orbit-core"><Logo kind="symbol" height={105} /></div>
        <div className="auth-orbit-hud"><span>{environmentLabel}</span><i><b /></i><span>{keyStatusLabel}</span></div>
      </div>
    </div>
    <div className="auth-welcome-foot">
      <Card><div className="auth-welcome-feature"><Zap size={18} aria-hidden="true" /><div><strong>不用敲命令</strong><p>环境、工具、配置点几下就好。准备进度和遇到的问题都能看到。</p></div></div></Card>
      <Card><div className="auth-welcome-feature"><Key size={18} aria-hidden="true" /><div><strong>一个账号就够</strong><p>管理各工具的连接与密钥，在确认后写入对应配置。</p></div></div></Card>
      <Card><div className="auth-welcome-feature"><ShieldCheck size={18} aria-hidden="true" /><div><strong>用量随时能对账</strong><p>余额、请求明细和密钥额度，都能在个人中心查看。</p></div></div></Card>
      <Card testId="welcome-support"><div className="auth-welcome-support">{supportQrUrl ? <img src={supportQrUrl} alt="微信客服二维码" /> : <MessageCircle size={42} aria-hidden="true" />}<div><strong>微信扫码找客服</strong><p>装不上、付了没到账，都可以问。</p><Button variant="ghost" size="xs" iconRight={ArrowUpRight} onClick={onHelp} testId="welcome-help">打开客服</Button></div></div></Card>
    </div>
  </main></AuthWindow>
}
