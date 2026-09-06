import { useEffect, useRef, useState } from 'react'
import { AppWindow, ArrowLeft, ArrowRight, Check, CheckCircle2, Download, LoaderCircle, MessageSquare, Minus, RefreshCw, Settings2, Terminal, X } from 'lucide-react'
import { officialAccountLabel } from '../../account-source'
import { shortVersion } from '../../app-shared'
import { errorMessage } from '../../error-message'
import { codexRuntimeSetupMessage } from '../../onboarding-runtime'
import { providers } from '../../provider-meta'
import type { AppConfigSummary, PlatformCapabilities, SystemSnapshot } from '../../types'
import { Banner, Button, IconButton, Pill, Progress, Radio } from '../ui'
import { availableGuideRoutes, guideNextStep, guideProvider, guideReadiness, type GuideConnection, type GuideRoute, type GuideStep } from './start-guide-state'
import './start-guide.css'

export type { GuideRoute } from './start-guide-state'

const steps: Array<{ id: GuideStep; title: string }> = [
  { id: 'choose', title: '选择工具' },
  { id: 'prepare', title: '准备工具' },
  { id: 'connect', title: '确认连接' },
  { id: 'ready', title: '开始使用' },
]

export function guideRouteLabel(route: GuideRoute): string {
  return route === 'chat' ? '直接聊天' : route === 'codexDesktop' ? 'Codex 桌面端' : providers[route].name
}

function connectionCopy(connection: GuideConnection, route: Exclude<GuideRoute, 'chat'>): { title: string; detail: string } {
  const provider = guideProvider(route)
  const official = officialAccountLabel(provider)
  switch (connection) {
    case 'relay': return { title: '星芒密钥已配置', detail: route === 'codexDesktop' || route === 'codex' ? 'Codex 桌面端与 CLI 使用同一份配置。' : '已读取本机配置中的星芒地址和密钥。' }
    case 'official': return { title: `${official}来源`, detail: provider === 'codex' ? '已读取本机 ChatGPT 登录身份，模型在 Codex 窗口里选择。' : `保留 ${official}来源。登录是否有效仍需在工具窗口中确认。` }
    case 'official-login-required': return { title: 'ChatGPT 账号尚未登录', detail: '先在官方窗口完成登录，再返回这里重新检测。' }
    case 'unknown': return { title: '已有第三方配置', detail: '当前地址来自已有配置。请检查配置并明确选择要使用的账号来源。' }
    case 'unread': return { title: '配置摘要暂未获取', detail: '重新检测后再确认连接。' }
    default: return { title: '尚未连接账号', detail: '选择星芒密钥或工具支持的官方账号来源。' }
  }
}

export function StartGuide({ platform, snapshot, config, scanning, busy, onScan, onInstall, onPrepareRuntime, onConfigure, onComplete, onCancel, progress, cancelLabel = '返回工作台' }: {
  platform: PlatformCapabilities
  snapshot: SystemSnapshot
  config: AppConfigSummary | null
  scanning: boolean
  busy: boolean
  onScan: () => Promise<void>
  onInstall: (route: GuideRoute) => Promise<void>
  onPrepareRuntime: () => Promise<void>
  onConfigure: (route: GuideRoute) => void
  onComplete: (route: GuideRoute) => Promise<void>
  onCancel: () => void
  progress?: { label: string; percent?: number }
  cancelLabel?: string
}) {
  const [route, setRoute] = useState<GuideRoute | null>(null)
  const [step, setStep] = useState<GuideStep>('choose')
  const [pending, setPending] = useState<'scan' | 'runtime' | 'install' | 'complete' | null>(null)
  const [error, setError] = useState('')
  const [externalNotice, setExternalNotice] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const heading = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const locked = busy || scanning || pending !== null
  const readiness = route ? guideReadiness(route, platform, snapshot, config) : null
  const nextStep = guideNextStep(step, route, readiness)
  const currentIndex = steps.findIndex((entry) => entry.id === step)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { heading.current?.focus() }, [step])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  const run = async (kind: NonNullable<typeof pending>, operation: () => Promise<void>) => {
    if (inFlight.current || locked) return
    inFlight.current = true
    setPending(kind)
    setError('')
    try { await operation() } catch (failure) { if (mounted.current) setError(errorMessage(failure)) }
    finally { inFlight.current = false; if (mounted.current) setPending(null) }
  }
  const chooseNext = () => {
    if (locked || nextStep === step) return
    setError('')
    setStep(nextStep)
    if (step === 'choose' && route !== 'chat') void run('scan', onScan)
  }
  const configure = () => {
    if (!route || locked) return
    setError('')
    try { onConfigure(route) } catch (failure) { setError(errorMessage(failure)) }
  }
  const prepareRuntime = () => void run('runtime', async () => {
    await onPrepareRuntime()
    if (mounted.current && platform.nodeRuntimeInstall === 'external') setExternalNotice('请完成外部运行环境安装，再重新检测。')
    await onScan()
  })
  const install = () => {
    if (!route || route === 'chat' || !readiness || !readiness.supported || !readiness.runtimeReady || readiness.toolDetectionFailed) return
    const selectedRoute = route
    void run('install', async () => {
      await onInstall(selectedRoute)
      const external = selectedRoute === 'codexDesktop' ? platform.codexDesktop.install === 'external' : platform.cliInstall[selectedRoute] === 'external'
      if (mounted.current && external) setExternalNotice('请完成外部工具安装，再重新检测。')
      await onScan()
    })
  }
  const complete = () => {
    if (!route || !readiness?.prepared || !readiness.connected || locked) return
    const selectedRoute = route
    void run('complete', () => onComplete(selectedRoute))
  }

  return (
    <main className="start-guide" data-testid="start-guide" data-guide-step={step} data-guide-route={route ?? ''} aria-busy={locked}>
      <div className="start-guide-inner">
        <header className="start-guide-header">
          <div><span className="start-guide-brand">星芒 AI</span><h1>准备你的工作台</h1></div>
          <IconButton icon={X} label={cancelLabel} onClick={onCancel} disabled={locked} />
        </header>
        <ol className="start-guide-steps" aria-label="首次准备进度">
          {steps.map((entry, index) => <li key={entry.id} aria-current={entry.id === step ? 'step' : undefined} data-completed={index < currentIndex && !(route === 'chat' && index > 0)}>
            <span className="start-guide-step-number" aria-hidden="true">{index < currentIndex ? route === 'chat' && index > 0 ? <Minus size={14} /> : <Check size={14} /> : index + 1}</span><span>{entry.title}{route === 'chat' && index > 0 && index < currentIndex ? '（不适用）' : ''}</span>
          </li>)}
        </ol>
        <section className="start-guide-content" aria-labelledby="start-guide-heading">
          <h2 ref={heading} tabIndex={-1} id="start-guide-heading">{step === 'choose' ? '选择一种开始方式' : step === 'prepare' ? `准备 ${route ? guideRouteLabel(route) : ''}` : step === 'connect' ? '确认账号来源' : '准备完成'}</h2>
          {step === 'choose' && <fieldset className="start-guide-routes" disabled={locked}>
            <legend className="sr-only">开始方式</legend>
            {availableGuideRoutes(platform).map((item) => <div className="start-guide-choice" data-selected={route === item} key={item}>
              <Radio name="start-guide-route" value={item} checked={route === item} onChange={() => { setRoute(item); setError(''); setExternalNotice('') }} testId={`guide-route-${item}`}
                label={<span className="start-guide-route-label">{item === 'chat' ? <MessageSquare size={24} aria-hidden="true" /> : <img src={providers[guideProvider(item)].icon} alt="" aria-hidden="true" data-provider={guideProvider(item)} />}<strong>{guideRouteLabel(item)}</strong></span>}
                description={item === 'chat' ? '使用星芒聊天，无需本地运行环境' : item === 'codexDesktop' ? '独立桌面应用，无需 Node.js' : `${providers[item].company} · 命令行工具`} />
            </div>)}
          </fieldset>}

          {step === 'prepare' && route && route !== 'chat' && readiness && <>
            {!readiness.supported && <Banner tone="warn" title="当前平台不支持这个工具" actions={<Button onClick={() => setStep('choose')}>重新选择</Button>} />}
            <div className="start-guide-checklist">
              {readiness.runtimeRequired && <div className="start-guide-check-row">
                <Terminal size={20} aria-hidden="true" /><div><strong>Node.js 与 npm</strong><p>{readiness.runtimeFailed ? '运行环境检测失败，请重新检测' : readiness.runtimeReady ? `Node.js ${shortVersion(snapshot.runtime.node.version)} · npm ${shortVersion(snapshot.runtime.npm.version)}` : codexRuntimeSetupMessage(snapshot.runtime)}</p></div>
                <Pill tone={readiness.runtimeReady ? 'ok' : readiness.runtimeFailed ? 'bad' : 'warn'}>{readiness.runtimeReady ? '已就绪' : readiness.runtimeFailed ? '检测失败' : '待准备'}</Pill>
              </div>}
              <div className="start-guide-check-row">
                {route === 'codexDesktop' ? <AppWindow size={20} aria-hidden="true" /> : <Terminal size={20} aria-hidden="true" />}<div><strong>{guideRouteLabel(route)}</strong><p>{readiness.toolDetectionFailed ? '暂时无法确认安装状态' : readiness.toolInstalled ? '已检测到本机安装' : '尚未检测到安装'}</p></div>
                <Pill tone={readiness.toolDetectionFailed ? 'bad' : readiness.toolInstalled ? 'ok' : 'warn'}>{readiness.toolDetectionFailed ? '检测失败' : readiness.toolInstalled ? '已安装' : '未安装'}</Pill>
              </div>
            </div>
            {externalNotice && <Banner title={externalNotice} tone="info" />}
            <div className="start-guide-task-actions">
              {readiness.runtimeRequired && !readiness.runtimeReady && !readiness.runtimeFailed && <Button icon={Download} variant="primary" disabled={locked} loading={pending === 'runtime'} onClick={prepareRuntime}>{platform.nodeRuntimeInstall === 'managed' ? '准备运行环境' : '打开环境安装入口'}</Button>}
              {readiness.runtimeReady && !readiness.toolInstalled && !readiness.toolDetectionFailed && readiness.supported && <Button icon={Download} variant="primary" disabled={locked} loading={pending === 'install'} onClick={install}>{(route === 'codexDesktop' ? platform.codexDesktop.install : platform.cliInstall[route]) === 'managed' ? `安装 ${guideRouteLabel(route)}` : '打开工具安装入口'}</Button>}
              <Button icon={RefreshCw} disabled={locked} loading={pending === 'scan' || scanning} onClick={() => void run('scan', onScan)}>重新检测</Button>
            </div>
          </>}

          {step === 'connect' && route && route !== 'chat' && readiness && <>
            <Banner tone={readiness.connected ? 'ok' : 'warn'} title={connectionCopy(readiness.connection, route).title}>{connectionCopy(readiness.connection, route).detail}</Banner>
            <dl className="start-guide-connection-details"><div><dt>工具</dt><dd>{guideRouteLabel(route)}</dd></div>
              {config?.providers[guideProvider(route)].officialAccountEmail && readiness.connection === 'official' && <div><dt>官方身份</dt><dd>{config.providers[guideProvider(route)].officialAccountEmail}</dd></div>}
              <div><dt>工作文件夹</dt><dd>{config?.workspace || '尚未选择'}</dd></div>
            </dl>
            <div className="start-guide-task-actions"><Button icon={Settings2} variant={readiness.connected ? 'secondary' : 'primary'} disabled={locked} onClick={configure}>检查与配置</Button><Button icon={RefreshCw} disabled={locked} loading={pending === 'scan' || scanning} onClick={() => void run('scan', onScan)}>重新检测</Button></div>
          </>}

          {step === 'ready' && route && readiness && <>
            <div className="start-guide-ready"><CheckCircle2 size={36} aria-hidden="true" /><div><strong>{guideRouteLabel(route)}</strong><p>{route === 'chat' ? '已选择星芒聊天' : readiness.connected && readiness.prepared ? '本机工具与连接配置已确认' : '工具或配置状态已变化，请返回复核'}</p></div></div>
            {route === 'chat' && <Pill>本地环境不适用</Pill>}
          </>}
          {progress && locked && <Progress label={progress.label} value={progress.percent} />}
          {locked && <Banner title={pending === 'complete' ? '正在打开所选工具' : '当前任务正在执行'} tone="info">任务完成后可返回；返回不会取消后台安装。</Banner>}
          {error && <div ref={errorRef} tabIndex={-1}><Banner title="操作未完成" tone="bad" live="assertive">{error}</Banner></div>}
        </section>
        <footer className="start-guide-footer">
          <Button icon={step === 'choose' ? X : ArrowLeft} disabled={locked} onClick={() => {
            if (step === 'choose') onCancel()
            else { setError(''); setStep(route === 'chat' ? 'choose' : steps[Math.max(0, currentIndex - 1)].id) }
          }}>{step === 'choose' ? cancelLabel : '上一步'}</Button>
          {step === 'ready'
            ? <Button variant="primary" icon={pending === 'complete' ? LoaderCircle : route === 'chat' ? MessageSquare : AppWindow} disabled={locked || !readiness?.prepared || !readiness.connected} loading={pending === 'complete'} onClick={complete}>{route === 'chat' ? '开始聊天' : '打开工具'}</Button>
            : <Button variant="primary" iconRight={ArrowRight} disabled={locked || nextStep === step} onClick={chooseNext}>下一步</Button>}
        </footer>
      </div>
    </main>
  )
}
