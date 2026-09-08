import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleCheck, Download, FolderOpen, LogIn, MessageSquare, RefreshCw, Settings, Terminal } from 'lucide-react'
import { BrandIcon, Button, Card, Logo, Pill, Progress } from '../../ui'
import { tools as toolRegistry } from '../../registry/tools'
import { authErrorMessage } from './state'
import { clearGuideProgress, getGuideStorage, readGuideProgress, writeGuideProgress } from './guide-progress'
import { AuthWindow } from './AuthWindow'
import './auth.css'

export type GuideRoute = 'claude' | 'codex' | 'codexDesktop' | 'gemini' | 'grok' | 'chat'
export type GuideStep = 'choose' | 'prepare' | 'connect' | 'ready'
export interface GuideToolState {
  id: Exclude<GuideRoute, 'chat'>
  installed: boolean
  configured: boolean
  source: 'account' | 'official' | 'manual' | 'unknown' | 'none'
  version?: string
  runtimeReady?: boolean
  pythonReady?: boolean
  detectionError?: boolean
  supported?: boolean
  installMode?: 'managed' | 'external' | 'unavailable'
  model?: string
  workspace?: string
}
export interface StartGuideProps {
  platform: 'win' | 'mac' | 'linux'
  tools: readonly GuideToolState[]
  signedIn: boolean
  busy?: boolean
  progress?: { label: string; percent: number }
  onDetect: () => Promise<void>
  onInstall: (route: Exclude<GuideRoute, 'chat'>) => Promise<void>
  onInstallRuntime?: () => Promise<void>
  onInstallPython?: () => Promise<void>
  resumeKey?: string
  onConfigure: (route: Exclude<GuideRoute, 'chat'>) => Promise<void>
  onLogin: () => void
  onLaunch: (route: GuideRoute) => Promise<boolean | void>
  onComplete: (route: GuideRoute) => void
  onBack?: () => void
  onHelp?: () => void
}

const steps: readonly { id: GuideStep; title: string }[] = [{ id: 'choose', title: '选一种开始方式' }, { id: 'prepare', title: '准备工具' }, { id: 'connect', title: '确认连接' }, { id: 'ready', title: '开始使用' }]

export function resolveGuideReadiness(route: GuideRoute | null, state: GuideToolState | undefined, signedIn: boolean) {
  if (!route) return { prepared: false, connected: false }
  if (route === 'chat') return { prepared: true, connected: signedIn }
  return { prepared: Boolean(state && state.installed && !state.detectionError && state.supported !== false && state.installMode !== 'unavailable' && (route === 'codexDesktop' || state.runtimeReady === true) && (route !== 'gemini' || state.pythonReady === true)), connected: Boolean(state && !state.detectionError && state.source !== 'unknown' && state.source !== 'none' && (state.configured || state.source === 'official')) }
}

export function StartGuide(props: StartGuideProps) {
  return <AuthWindow platform={props.platform}><ScopedStartGuide key={`${props.resumeKey ?? 'volatile'}:${props.platform}`} {...props} /></AuthWindow>
}

function ScopedStartGuide({ platform, tools, signedIn, busy = false, progress, onDetect, onInstall, onInstallRuntime, onInstallPython, resumeKey, onConfigure, onLogin, onLaunch, onComplete, onBack, onHelp }: StartGuideProps) {
  const [restored] = useState(() => readGuideProgress(getGuideStorage(), resumeKey, platform))
  const [route, setRoute] = useState<GuideRoute | null>(restored?.route ?? null)
  const [step, setStep] = useState<GuideStep>(restored?.step ?? 'choose')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [storageWarning, setStorageWarning] = useState('')
  const lock = useRef(false)
  const owner = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => () => { owner.current++; lock.current = false }, [])
  useEffect(() => { heading.current?.focus() }, [step])
  useEffect(() => { if (restored && restored.route !== 'chat' && restored.step !== 'choose') void run('检测工具', onDetect) }, [])
  const tool = tools.find((item) => item.id === route)
  const definition = toolRegistry.find((item) => item.id === route)
  const name = route === 'chat' ? '星芒聊天' : definition?.name ?? ''
  const readiness = resolveGuideReadiness(route, tool, signedIn)
  const currentStep = steps.findIndex((item) => item.id === step)
  const locked = busy || Boolean(pending)
  const options = toolRegistry.filter((item) => !item.hidden?.(platform)).sort((a, b) => a.shortcutIndex - b.shortcutIndex)
  const saveProgress = (chosen: GuideRoute, currentStep: GuideStep) => {
    if (!writeGuideProgress(getGuideStorage(), resumeKey, { route: chosen, step: currentStep })) setStorageWarning('引导进度没有保存到本机，当前步骤仍可继续')
    else setStorageWarning('')
  }
  const choose = (chosen: GuideRoute) => { if (locked) return; setRoute(chosen); setError(''); saveProgress(chosen, 'choose') }
  const move = (nextStep: GuideStep) => { setStep(nextStep); if (route) saveProgress(route, nextStep) }
  const complete = (chosen: GuideRoute) => { clearGuideProgress(getGuideStorage(), resumeKey); onComplete(chosen) }
  const run = async (action: string, work: () => Promise<void>) => {
    if (lock.current || busy) return
    const ticket = owner.current
    lock.current = true; setPending(action); setError('')
    try { await work() }
    catch (reason) { if (ticket === owner.current) setError(authErrorMessage(reason, action)) }
    finally { if (ticket === owner.current) { lock.current = false; setPending('') } }
  }
  const next = () => {
    if (locked || !route) return
    if (step === 'choose') { move('prepare'); if (route !== 'chat') void run('检测工具', onDetect) }
    else if (step === 'prepare' && readiness.prepared) move('connect')
    else if (step === 'connect' && readiness.prepared && readiness.connected) move('ready')
    setError('')
  }
  const launch = () => {
    if (!route || !readiness.prepared || !readiness.connected) return
    const chosen = route
    void run('打开工具', async () => {
      const ticket = owner.current
      const launched = await onLaunch(chosen)
      if (launched !== false && ticket === owner.current) complete(chosen)
    })
  }
  const sourceLabel = tool?.source === 'official' ? '官方账号' : tool?.source === 'account' ? '星芒账号' : tool?.source === 'manual' ? '手动填写密钥' : tool?.source === 'unknown' ? '已有第三方配置' : '尚未选择连接方式'
  return <main className="auth-guide" data-testid="onboarding-page">
    <div className="auth-guide-frame" data-testid="start-guide" data-guide-step={step} data-guide-route={route ?? ''} aria-busy={locked} data-busy={locked}>
      <Card><div className="auth-guide-brand"><div><Logo kind="micro" height={28} /><Logo kind="wordmark" height={22} /></div><span>第 {currentStep + 1} 步，共 4 步</span></div>
        <ol className="auth-guide-steps start-guide-steps" aria-label="首次使用进度">{steps.map((item, index) => <li key={item.id} aria-current={item.id === step ? 'step' : undefined} data-completed={index < currentStep}><i>{index < currentStep ? <Check size={14} aria-hidden="true" /> : index + 1}</i><span>{item.title}</span></li>)}</ol>
        <h1 ref={heading} tabIndex={-1} data-testid="guide-heading">{step === 'ready' ? '可以开始了' : steps[currentStep].title}</h1>
        <div className="auth-guide-body">
          {step === 'choose' && <><p className="auth-guide-lead">{signedIn ? '账号已登录。' : ''}选一个先开始，之后随时可以再装别的。</p><fieldset className="auth-guide-choices" disabled={locked}><legend>开始方式</legend>{options.map((item) => <label className="auth-guide-choice" data-selected={route === item.id} key={item.id}><input type="radio" name="start-guide-route" value={item.id} checked={route === item.id} onChange={() => choose(item.id as GuideRoute)} data-testid={`guide-route-${item.id}`} /><BrandIcon tool={item.id} size={32} variant="tile" /><strong>{item.name}</strong><span>{item.vendor} · {item.kind === 'desktop' ? '图形界面，不需要 Node.js' : item.id === 'gemini' ? '命令行，需要 Node.js 和 Python' : '命令行，需要 Node.js'}</span></label>)}<label className="auth-guide-choice" data-selected={route === 'chat'}><input type="radio" name="start-guide-route" value="chat" checked={route === 'chat'} onChange={() => choose('chat')} data-testid="guide-route-chat" /><MessageSquare size={26} aria-hidden="true" /><strong>先在星芒里聊天</strong><span>直接描述你的问题，稍后再准备编程工具</span></label></fieldset></>}
          {step === 'prepare' && route === 'chat' && <p className="auth-guide-callout">聊天在星芒内打开，这一步无需安装其他工具。</p>}
          {step === 'prepare' && route && route !== 'chat' && <>
            <p className="auth-guide-lead">{readiness.prepared ? `${name} 已经装好。` : `核对 ${name} 的安装状态，再按顺序准备。`}</p>
            {!tool || tool.detectionError ? <p className="auth-error" role="alert">暂时无法确认工具是否已安装，请重新检测。</p> : <div className="auth-guide-checklist">
              {route !== 'codexDesktop' && <div className="auth-guide-check-row"><Terminal size={20} aria-hidden="true" /><div><strong>Node.js 与 npm</strong><p>{tool.runtimeReady ? '运行环境已就绪' : platform === 'win' ? '命令行工具需要运行环境' : '在应用外安装完成后回来重新检测'}</p></div><Pill tone={tool.runtimeReady ? 'ok' : 'warn'}>{tool.runtimeReady ? '已就绪' : '待准备'}</Pill>{!tool.runtimeReady && onInstallRuntime && <Button icon={Download} disabled={locked} onClick={() => void run('准备环境', onInstallRuntime)} testId="guide-node">{platform === 'win' ? '一键安装' : '安装指南'}</Button>}</div>}
              {route === 'gemini' && <div className="auth-guide-check-row" data-testid="guide-python-step"><BrandIcon tool="python" size={26} /><div><strong>Python</strong><p>{tool.pythonReady ? 'Python 已就绪' : !tool.runtimeReady ? '先准备 Node.js 与 npm，再继续这一步' : platform === 'win' ? 'Gemini 的准备清单包含 Python 环境' : '在应用外安装 Python 后回来重新检测'}</p></div><Pill tone={tool.pythonReady ? 'ok' : 'warn'}>{tool.pythonReady ? '已就绪' : '待准备'}</Pill>{!tool.pythonReady && onInstallPython && <Button icon={Download} disabled={locked || !tool.runtimeReady} onClick={() => void run('准备 Python', onInstallPython)} testId="guide-python">{platform === 'win' ? '一键安装' : '安装指南'}</Button>}</div>}
              <div className="auth-guide-check-row"><BrandIcon tool={route} size={26} /><div><strong>{name}</strong><p>{tool.installed ? `已找到${tool.version ? ` v${tool.version}` : ''}` : '尚未检测到安装'}</p></div><Pill tone={tool.installed ? 'ok' : 'warn'}>{tool.installed ? '已安装' : '未安装'}</Pill>{!tool.installed && tool.supported !== false && tool.installMode !== 'unavailable' && <Button icon={Download} disabled={locked || (route !== 'codexDesktop' && !tool.runtimeReady) || (route === 'gemini' && !tool.pythonReady)} onClick={() => void run('安装工具', () => onInstall(route))} testId="guide-install">{tool.installMode === 'external' ? '安装指南' : '安装'}</Button>}</div>
              {(tool.supported === false || tool.installMode === 'unavailable') && <p className="auth-error">当前平台暂不支持这个工具，请返回选择其他开始方式。</p>}
            </div>}
            <Button icon={RefreshCw} disabled={locked} onClick={() => void run('检测工具', onDetect)} testId="guide-installed-rescan">我已装好，重新检测</Button>
          </>}
          {step === 'connect' && route === 'chat' && <><p className="auth-guide-callout">{signedIn ? '进入聊天后，选择分组和模型，再输入第一个问题。' : '登录星芒账号后即可开始聊天。'}</p>{!signedIn && <Button variant="primary" icon={LogIn} onClick={onLogin} testId="guide-login">登录账号</Button>}</>}
          {step === 'connect' && route && route !== 'chat' && <><p className="auth-guide-lead">{name} 的连接方式：<strong>{sourceLabel}</strong></p><p className="auth-guide-callout">{tool?.source === 'unknown' ? '已保留现有第三方配置。请先查看处理步骤，确认哪些设置需要保留后再决定如何连接。' : tool?.source === 'official' ? '保留当前官方来源。官方账号的登录和可用额度，请在工具内确认。' : readiness.connected ? '当前连接已确认。需要换密钥、模型或工作文件夹时，可以打开配置。' : '打开配置选择连接来源、密钥、模型和工作文件夹，确认后保存。'}</p>{tool?.model && <p className="auth-hint">模型：{tool.model}</p>}{tool?.workspace && <p className="auth-hint">工作文件夹：{tool.workspace}</p>}<div className="auth-form-actions"><Button icon={Settings} variant={readiness.connected ? 'secondary' : 'primary'} disabled={locked} onClick={() => void run('确认连接', () => onConfigure(route))} testId="guide-config">{tool?.source === 'unknown' ? '查看已有配置处理步骤' : readiness.connected ? '查看连接配置' : '去完成连接配置'}</Button><Button icon={RefreshCw} disabled={locked} onClick={() => void run('检测工具', onDetect)} testId="guide-connection-rescan">重新检测</Button></div></>}
          {step === 'ready' && <><p className="auth-guide-lead">{route === 'chat' ? '从一个问题开始，慢慢熟悉你的 AI 工作台。' : readiness.prepared && readiness.connected ? `${name} 已准备好。打开工具，即可开始第一次任务。` : '工具或配置状态已变化，请返回复核。'}</p><div className="auth-guide-ready"><CircleCheck size={30} aria-hidden="true" /><span>有需要时，可从首页重新打开这份引导。</span></div></>}
          {(step === 'connect' || step === 'ready') && !readiness.prepared && <p className="auth-error" role="alert">工具或运行环境尚未准备好，请返回准备工具步骤后再继续。</p>}
          {pending && <p className="auth-hint" role="status">正在{pending}，请稍候</p>}{progress && locked && <Progress value={progress.percent} label={progress.label} testId="guide-progress" />}{error && <p className="auth-error" role="alert" data-testid="guide-error">{error}</p>}{storageWarning && <p className="auth-hint" role="status">{storageWarning}</p>}
        </div>
        <footer className="auth-guide-actions start-guide-footer">
          {step !== 'choose' && <Button icon={ArrowLeft} variant="ghost" disabled={locked} onClick={() => { setError(''); move(steps[currentStep - 1].id) }} testId="guide-back">上一步</Button>}
          <span className="auth-footer-spacer" />
          {step === 'ready' ? <><Button variant="primary" icon={route === 'chat' ? MessageSquare : FolderOpen} loading={pending === '打开工具'} disabled={locked || !readiness.prepared || !readiness.connected} onClick={launch} testId={route === 'chat' ? 'guide-chat' : 'guide-open-tool'}>{route === 'chat' ? '开始聊天' : `打开 ${name}`}</Button><Button disabled={locked || !route || !readiness.prepared || !readiness.connected} onClick={() => { if (route) complete(route) }} testId="guide-home">进入首页</Button></> : <Button variant="primary" iconRight={ArrowRight} disabled={locked || !route || (step === 'prepare' && !readiness.prepared) || (step === 'connect' && (!readiness.prepared || !readiness.connected))} onClick={next} testId="guide-next">下一步</Button>}
          {onBack && <Button variant="ghost" disabled={locked} onClick={() => { if (route) saveProgress(route, step); onBack() }} testId="guide-pause">稍后继续</Button>}{onHelp && <Button variant="ghost" disabled={locked} onClick={onHelp} testId="guide-help">需要帮助</Button>}
        </footer>
      </Card>
    </div>
  </main>
}
