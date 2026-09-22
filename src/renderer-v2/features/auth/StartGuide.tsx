import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleCheck, Download, FolderOpen, FolderPlus, LogIn, MessageSquare, RefreshCw, Settings, Terminal } from 'lucide-react'
import type { ProviderConfigSummary, ProviderId } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Card, Logo, Pill, Progress } from '../../ui'
import { guideRecommendedTool, officialAccountNotes, tools as toolRegistry } from '../../registry/tools'
import { FirstRunSteps } from '../tools/FirstRun'
import { authErrorMessage } from './state'
import { classifyOperationError } from '../../operation-error'
import { errors } from '../../registry/errors'
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
  /** 缺 Node.js 时「安装」会先把它装上（Windows 代装）；缺省 = 旧行为，先单独准备。 */
  runtimeAutoPrepare?: boolean
  /** 同上，Gemini 的 Python。 */
  pythonAutoPrepare?: boolean
  detectionError?: boolean
  supported?: boolean
  installMode?: 'managed' | 'external' | 'unavailable'
  /** 来源是官方账号，但这个 CLI 里还没完成官方登录（R-G7）。 */
  officialLoginRequired?: boolean
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
  /** newFolder：不弹目录选择器，替用户新建一个项目文件夹再打开（只对四家 CLI 有意义）。 */
  onLaunch: (route: GuideRoute, newFolder?: boolean) => Promise<boolean | void>
  onComplete: (route: GuideRoute) => void
  onBack?: () => void
  onHelp?: () => void
}

const steps: readonly { id: GuideStep; title: string }[] = [{ id: 'choose', title: '选一种开始方式' }, { id: 'prepare', title: '准备工具' }, { id: 'connect', title: '确认连接' }, { id: 'ready', title: '开始使用' }]

/**
 * A Codex config that carries no relay key only tells us the user picked the
 * official account; the ChatGPT session itself lives in auth.json and shows up
 * as `codexAuthMode`. Treating the two as one made the guide report "已连接"
 * for someone who still has to sign in the first time they open Codex. The
 * other CLIs keep their official login outside the config files this app
 * reads, so nothing can be asserted about them and nothing is blocked.
 */
export function guideOfficialLoginRequired(provider: ProviderId, source: GuideToolState['source'], summary: Pick<ProviderConfigSummary, 'codexAuthMode'> | null | undefined): boolean {
  return provider === 'codex' && source === 'official' && summary?.codexAuthMode !== 'chatgpt'
}

const installFailureKeys = new Set<string>(['toolRunning', 'installBlocked', 'downloadTimeout', 'diskFull', 'certDate', 'tlsIntercepted', 'permission'])

/**
 * 「安装」把运行环境和工具串成一次之后，失败得说清是哪一段没装上，再给一个
 * 能点的出口；authErrorMessage 是为登录写的，会把下载超时说成「连接星芒服务器
 * 超时」、再补一句「输入已保留」，放在这里全是错的。
 */
export function guideInstallErrorMessage(reason: unknown, name: string): string {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  if (/运行环境正在准备/.test(message)) return '运行环境还在准备，等它装完再点「再试一次」。'
  const key = classifyOperationError(message)
  // 目录里「超时」那条的标题写的是「连不上星芒服务器」，安装走的是下载源，
  // 照搬会把人指错方向；账号、计费那几类在安装里不会出现，也不借。
  const why = key === 'timeout' ? '（网络连不上）' : installFailureKeys.has(key) ? `（${errors[key].title}）` : ''
  const what = /运行环境没装上/.test(message) ? `运行环境没装上${why}，${name} 还没开始装` : `${name} 没装上${why}`
  return `${what}。点「再试一次」，还不行就点「需要帮助」。`
}

/**
 * 引导第一步默认选中哪一项（第十一批候选 1）。上次停在半路的按上次的来；新来的
 * 直接给推荐项，新手一路「下一步」就能走完。推荐项在当前平台上看不到时（Linux）
 * 不替他选。
 */
export function defaultGuideRoute(restored: GuideRoute | null | undefined, visible: readonly string[]): GuideRoute | null {
  if (restored) return restored
  return visible.includes(guideRecommendedTool) ? guideRecommendedTool : null
}

/**
 * 「确认连接」这一步只对需要人看一眼的情况停下来（第十一批候选 3）。装完工具后
 * 账号 Key 已经自动写好、检测也确认连上了，这一步就是纯过场，直接跳到最后一步。
 * 已有第三方配置、官方账号（要看它自己的限制和登录状态）、手动填的密钥都照旧停下；
 * 聊天路线不在这里改。
 */
export function guideCanSkipConnect(route: GuideRoute | null, state: GuideToolState | undefined, signedIn: boolean): boolean {
  if (!route || route === 'chat' || !state || state.source !== 'account') return false
  const readiness = resolveGuideReadiness(route, state, signedIn)
  return readiness.prepared && readiness.connected
}

export function resolveGuideReadiness(route: GuideRoute | null, state: GuideToolState | undefined, signedIn: boolean) {
  if (!route) return { prepared: false, connected: false }
  if (route === 'chat') return { prepared: true, connected: signedIn }
  return { prepared: Boolean(state && state.installed && !state.detectionError && state.supported !== false && state.installMode !== 'unavailable' && (route === 'codexDesktop' || state.runtimeReady === true) && (route !== 'gemini' || state.pythonReady === true)), connected: Boolean(state && !state.detectionError && state.source !== 'unknown' && state.source !== 'none' && !state.officialLoginRequired && (state.configured || state.source === 'official')) }
}

export function StartGuide(props: StartGuideProps) {
  return <AuthWindow platform={props.platform}><ScopedStartGuide key={`${props.resumeKey ?? 'volatile'}:${props.platform}`} {...props} /></AuthWindow>
}

function ScopedStartGuide({ platform, tools, signedIn, busy = false, progress, onDetect, onInstall, onInstallRuntime, onInstallPython, resumeKey, onConfigure, onLogin, onLaunch, onComplete, onBack, onHelp }: StartGuideProps) {
  const [restored] = useState(() => readGuideProgress(getGuideStorage(), resumeKey, platform))
  const options = toolRegistry.filter((item) => !item.hidden?.(platform)).sort((a, b) => Number(b.id === guideRecommendedTool) - Number(a.id === guideRecommendedTool) || a.shortcutIndex - b.shortcutIndex)
  const [route, setRoute] = useState<GuideRoute | null>(() => defaultGuideRoute(restored?.route, options.map((item) => item.id)))
  const [step, setStep] = useState<GuideStep>(restored?.step ?? 'choose')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [installFailed, setInstallFailed] = useState(false)
  const [storageWarning, setStorageWarning] = useState('')
  const lock = useRef(false)
  // 在「准备工具」这一步点「安装」成功后记下路线；等检测结果跟上来、工具确实
  // 装好了，就替用户点那一下「下一步」。
  const advanceAfterInstall = useRef<GuideRoute | null>(null)
  const owner = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => () => { owner.current++; lock.current = false }, [])
  useEffect(() => { heading.current?.focus() }, [step])
  useEffect(() => { if (restored && restored.route !== 'chat' && restored.step !== 'choose') void run('检测工具', onDetect) }, [])
  const tool = tools.find((item) => item.id === route)
  const definition = toolRegistry.find((item) => item.id === route)
  const name = route === 'chat' ? '星芒聊天' : definition?.name ?? ''
  const readiness = resolveGuideReadiness(route, tool, signedIn)
  const skipConnect = guideCanSkipConnect(route, tool, signedIn)
  // 工具还没装、缺的运行环境又都能代装时，这一步只剩一颗「安装」：它会先把
  // 环境装上再装工具。工具已经装了却缺环境（比如 Node 版本太旧）时没有「安装」
  // 可点，运行环境那一行照旧给自己的按钮，不然用户会卡在这一步。
  const oneButton = Boolean(tool && !tool.installed && route !== 'codexDesktop' && (tool.runtimeReady || tool.runtimeAutoPrepare) && (route !== 'gemini' || tool.pythonReady || tool.pythonAutoPrepare))
  const currentStep = steps.findIndex((item) => item.id === step)
  const locked = busy || Boolean(pending)
  const saveProgress = (chosen: GuideRoute, currentStep: GuideStep) => {
    if (!writeGuideProgress(getGuideStorage(), resumeKey, { route: chosen, step: currentStep })) setStorageWarning('引导进度没有保存到本机，当前步骤仍可继续')
    else setStorageWarning('')
  }
  const choose = (chosen: GuideRoute) => { if (locked) return; setRoute(chosen); setError(''); setInstallFailed(false); saveProgress(chosen, 'choose') }
  const install = () => {
    if (!route || route === 'chat') return
    const chosen = route
    void run('安装工具', async () => { await onInstall(chosen); advanceAfterInstall.current = chosen })
  }
  useEffect(() => {
    if (!advanceAfterInstall.current) return
    if (step !== 'prepare' || route !== advanceAfterInstall.current) { advanceAfterInstall.current = null; return }
    if (locked || !readiness.prepared) return
    advanceAfterInstall.current = null
    setError(''); setInstallFailed(false)
    move(skipConnect ? 'ready' : 'connect')
  }, [step, route, locked, readiness.prepared, skipConnect])
  const move = (nextStep: GuideStep) => { setStep(nextStep); if (route) saveProgress(route, nextStep) }
  const complete = (chosen: GuideRoute) => { clearGuideProgress(getGuideStorage(), resumeKey); onComplete(chosen) }
  const run = async (action: string, work: () => Promise<void>) => {
    if (lock.current || busy) return
    const ticket = owner.current
    lock.current = true; setPending(action); setError(''); setInstallFailed(false)
    try { await work() }
    catch (reason) {
      if (ticket !== owner.current) return
      if (action === '安装工具') { setError(guideInstallErrorMessage(reason, name)); setInstallFailed(true) }
      else setError(authErrorMessage(reason, action))
    }
    finally { if (ticket === owner.current) { lock.current = false; setPending('') } }
  }
  const next = () => {
    if (locked || !route) return
    if (step === 'choose') { move('prepare'); if (route !== 'chat') void run('检测工具', onDetect) }
    else if (step === 'prepare' && readiness.prepared) move(skipConnect ? 'ready' : 'connect')
    else if (step === 'connect' && readiness.prepared && readiness.connected) move('ready')
    setError(''); setInstallFailed(false)
  }
  const launch = (newFolder = false) => {
    if (!route || !readiness.prepared || !readiness.connected) return
    const chosen = route
    void run('打开工具', async () => {
      const ticket = owner.current
      const launched = await onLaunch(chosen, newFolder)
      if (launched !== false && ticket === owner.current) complete(chosen)
    })
  }
  // Codex 桌面端自己管工作区，只有四家 CLI 打开时要选文件夹。
  const opensFolder = route !== null && route !== 'chat' && route !== 'codexDesktop'
  // 保留着官方来源的工具,在这一步也要看到它自己的限制(Gemini 的个人 Google
  // 账号已经登不上去了),否则用户会拿着一份用不了的连接走完引导。
  const officialNote = route && route !== 'chat' && tool?.source === 'official' ? officialAccountNotes[route === 'codexDesktop' ? 'codex' : route] : null
  const sourceLabel = tool?.source === 'official' ? tool.officialLoginRequired ? '官方账号（未登录）' : '官方账号' : tool?.source === 'account' ? '星芒账号' : tool?.source === 'manual' ? '手动填写密钥' : tool?.source === 'unknown' ? '用的是别处的配置' : '尚未选择连接方式'
  return <main className="auth-guide" data-testid="onboarding-page">
    <div className="auth-guide-frame" data-testid="start-guide" data-guide-step={step} data-guide-route={route ?? ''} aria-busy={locked} data-busy={locked}>
      <Card><div className="auth-guide-brand"><div><Logo kind="micro" height={28} /><Logo kind="wordmark" height={22} /></div><span>第 {currentStep + 1} 步，共 4 步</span></div>
        <ol className="auth-guide-steps start-guide-steps" aria-label="首次使用进度">{steps.map((item, index) => <li key={item.id} aria-current={item.id === step ? 'step' : undefined} data-completed={index < currentStep}><i>{index < currentStep ? <Check size={14} aria-hidden="true" /> : index + 1}</i><span>{item.title}</span></li>)}</ol>
        <h1 ref={heading} tabIndex={-1} data-testid="guide-heading">{step === 'ready' ? '可以开始了' : steps[currentStep].title}</h1>
        <div className="auth-guide-body">
          {step === 'choose' && <><p className="auth-guide-lead">{signedIn ? '账号已登录。' : ''}选一个先开始，之后随时可以再装别的。</p><fieldset className="auth-guide-choices" disabled={locked}><legend>开始方式</legend>{options.map((item) => <label className="auth-guide-choice" data-selected={route === item.id} key={item.id}><input type="radio" name="start-guide-route" value={item.id} checked={route === item.id} onChange={() => choose(item.id as GuideRoute)} data-testid={`guide-route-${item.id}`} /><BrandIcon tool={item.id} size={32} variant="tile" /><strong>{item.name}{item.id === guideRecommendedTool && <Pill tone="accent" testId="guide-recommended">推荐</Pill>}</strong><span>{item.vendor} · {item.kind === 'desktop' ? '图形界面，点开就能用' : platform === 'win' ? '命令行，会自动帮你准备运行环境' : '命令行，要先按提示准备运行环境'}</span></label>)}<label className="auth-guide-choice" data-selected={route === 'chat'}><input type="radio" name="start-guide-route" value="chat" checked={route === 'chat'} onChange={() => choose('chat')} data-testid="guide-route-chat" /><MessageSquare size={26} aria-hidden="true" /><strong>先在星芒里聊天</strong><span>直接描述你的问题，稍后再准备编程工具</span></label></fieldset></>}
          {step === 'prepare' && route === 'chat' && <p className="auth-guide-callout">聊天在星芒内打开，这一步无需安装其他工具。</p>}
          {step === 'prepare' && route && route !== 'chat' && <>
            <p className="auth-guide-lead">{readiness.prepared ? `${name} 已经装好。` : oneButton ? '点「安装」就行，缺的运行环境会一并装好。' : `核对 ${name} 的安装状态，再按顺序准备。`}</p>
            {!tool || tool.detectionError ? <p className="auth-error" role="alert">暂时无法确认工具是否已安装，请重新检测。</p> : <div className="auth-guide-checklist">
              {route !== 'codexDesktop' && <div className="auth-guide-check-row"><Terminal size={20} aria-hidden="true" /><div><strong>Node.js 与 npm</strong><p>{tool.runtimeReady ? '运行环境已就绪' : oneButton ? '点「安装」时会一并装好' : platform === 'win' ? '命令行工具需要运行环境' : '在应用外安装完成后回来重新检测'}</p></div><Pill tone={tool.runtimeReady ? 'ok' : oneButton ? 'neutral' : 'warn'}>{tool.runtimeReady ? '已就绪' : oneButton ? '自动准备' : '待准备'}</Pill>{!tool.runtimeReady && !oneButton && onInstallRuntime && <Button icon={Download} disabled={locked} onClick={() => void run('准备环境', onInstallRuntime)} testId="guide-node">{platform === 'win' ? '一键安装' : '安装指南'}</Button>}</div>}
              {route === 'gemini' && <div className="auth-guide-check-row" data-testid="guide-python-step"><BrandIcon tool="python" size={26} /><div><strong>Python</strong><p>{tool.pythonReady ? 'Python 已就绪' : oneButton ? '点「安装」时会一并装好' : !tool.runtimeReady ? '先准备 Node.js 与 npm，再继续这一步' : platform === 'win' ? 'Gemini 的准备清单包含 Python 环境' : '在应用外安装 Python 后回来重新检测'}</p></div><Pill tone={tool.pythonReady ? 'ok' : oneButton ? 'neutral' : 'warn'}>{tool.pythonReady ? '已就绪' : oneButton ? '自动准备' : '待准备'}</Pill>{!tool.pythonReady && !oneButton && onInstallPython && <Button icon={Download} disabled={locked || !tool.runtimeReady} onClick={() => void run('准备 Python', onInstallPython)} testId="guide-python">{platform === 'win' ? '一键安装' : '安装指南'}</Button>}</div>}
              <div className="auth-guide-check-row"><BrandIcon tool={route} size={26} /><div><strong>{name}</strong><p>{tool.installed ? `已找到${tool.version ? ` v${tool.version}` : ''}` : '尚未检测到安装'}</p></div><Pill tone={tool.installed ? 'ok' : 'warn'}>{tool.installed ? '已安装' : '未安装'}</Pill>{!tool.installed && tool.supported !== false && tool.installMode !== 'unavailable' && <Button icon={Download} disabled={locked || (!oneButton && ((route !== 'codexDesktop' && !tool.runtimeReady) || (route === 'gemini' && !tool.pythonReady)))} onClick={install} testId="guide-install">{tool.installMode === 'external' ? '安装指南' : '安装'}</Button>}</div>
              {(tool.supported === false || tool.installMode === 'unavailable') && <p className="auth-error">当前平台暂不支持这个工具，请返回选择其他开始方式。</p>}
            </div>}
            <Button icon={RefreshCw} disabled={locked} onClick={() => void run('检测工具', onDetect)} testId="guide-installed-rescan">我已装好，重新检测</Button>
          </>}
          {step === 'connect' && route === 'chat' && <><p className="auth-guide-callout">{signedIn ? '进入聊天后，选择分组和模型，再输入第一个问题。' : '登录星芒账号后即可开始聊天。'}</p>{!signedIn && <Button variant="primary" icon={LogIn} onClick={onLogin} testId="guide-login">登录账号</Button>}</>}
          {step === 'connect' && route && route !== 'chat' && <><p className="auth-guide-lead">{name} 的连接方式：<strong>{sourceLabel}</strong></p><p className="auth-guide-callout" data-testid={tool?.officialLoginRequired ? 'guide-official-login' : undefined}>{tool?.source === 'unknown' ? '你原来的配置已经原样留着。先看看处理步骤，确认哪些设置要留下，再决定怎么连接。' : tool?.officialLoginRequired ? `当前选的是官方账号，但还没有在 ${name} 里登录。请打开 ${name} 用 ChatGPT 账号登录后回来重新检测，或打开配置改用星芒账号的密钥。` : tool?.source === 'official' ? '保留当前官方来源。官方账号的登录和可用额度，请在工具内确认。' : readiness.connected ? '当前连接已确认。需要换密钥、模型或工作文件夹时，可以打开配置。' : '打开配置选择连接来源、密钥、模型和工作文件夹，确认后保存。'}</p>{officialNote && <p className="auth-hint" data-testid="guide-official-note">{officialNote}</p>}{tool?.model && <p className="auth-hint">模型：{tool.model}</p>}{tool?.workspace && <p className="auth-hint">工作文件夹：{tool.workspace}</p>}<div className="auth-form-actions"><Button icon={Settings} variant={readiness.connected ? 'secondary' : 'primary'} disabled={locked} onClick={() => void run('确认连接', () => onConfigure(route))} testId="guide-config">{tool?.source === 'unknown' ? '查看已有配置处理步骤' : readiness.connected ? '查看连接配置' : '去完成连接配置'}</Button><Button icon={RefreshCw} disabled={locked} onClick={() => void run('检测工具', onDetect)} testId="guide-connection-rescan">重新检测</Button></div></>}
          {step === 'ready' && <><p className="auth-guide-lead">{route === 'chat' ? '从一个问题开始，慢慢熟悉你的 AI 工作台。' : readiness.prepared && readiness.connected ? `${name} 已准备好。打开工具，即可开始第一次任务。` : '工具或配置状态已变化，请返回复核。'}</p>{skipConnect && <p className="auth-hint auth-guide-connected" data-testid="guide-connected-note">已用当前账号连好。想换密钥或模型，<Button variant="ghost" size="sm" disabled={locked} onClick={() => { if (route && route !== 'chat') void run('确认连接', () => onConfigure(route)) }} testId="guide-connected-config">点这里</Button></p>}{definition?.firstRun && readiness.prepared && readiness.connected && <FirstRunSteps key={route} name={name} firstRun={definition.firstRun} testId="guide-first-run" />}{opensFolder && readiness.prepared && readiness.connected && <div className="auth-guide-check-row" data-testid="guide-folder-hint"><FolderPlus size={20} aria-hidden="true" /><div><strong>选哪个文件夹</strong><p>打开时要选一个项目文件夹。不知道选哪个，就点「新建并打开」，软件替你建好一个空文件夹并直接打开。</p></div><Button icon={FolderPlus} disabled={locked} onClick={() => launch(true)} testId="guide-open-tool-new-folder">新建并打开</Button></div>}<div className="auth-guide-ready"><CircleCheck size={30} aria-hidden="true" /><span>有需要时，可从首页重新打开这份引导。</span></div></>}
          {(step === 'connect' || step === 'ready') && !readiness.prepared && <p className="auth-error" role="alert">工具或运行环境尚未准备好，请返回准备工具步骤后再继续。</p>}
          {pending && <p className="auth-hint" role="status">正在{pending}，请稍候</p>}{progress && locked && <Progress value={progress.percent} label={progress.label} testId="guide-progress" />}{error && <p className="auth-error" role="alert" data-testid="guide-error">{error}</p>}{error && installFailed && step === 'prepare' && tool && !tool.installed && <Button icon={RefreshCw} disabled={locked} onClick={install} testId="guide-retry">再试一次</Button>}{storageWarning && <p className="auth-hint" role="status">{storageWarning}</p>}
        </div>
        <footer className="auth-guide-actions start-guide-footer">
          {step !== 'choose' && <Button icon={ArrowLeft} variant="ghost" disabled={locked} onClick={() => { setError(''); move(steps[currentStep - 1].id) }} testId="guide-back">上一步</Button>}
          <span className="auth-footer-spacer" />
          {step === 'ready' ? <><Button variant="primary" icon={route === 'chat' ? MessageSquare : FolderOpen} loading={pending === '打开工具'} disabled={locked || !readiness.prepared || !readiness.connected} onClick={() => launch()} testId={route === 'chat' ? 'guide-chat' : 'guide-open-tool'}>{route === 'chat' ? '开始聊天' : `打开 ${name}`}</Button><Button disabled={locked || !route || !readiness.prepared || !readiness.connected} onClick={() => { if (route) complete(route) }} testId="guide-home">进入首页</Button></> : <Button variant="primary" iconRight={ArrowRight} disabled={locked || !route || (step === 'prepare' && !readiness.prepared) || (step === 'connect' && (!readiness.prepared || !readiness.connected))} onClick={next} testId="guide-next">下一步</Button>}
          {onBack && <Button variant="ghost" disabled={locked} onClick={() => { if (route) saveProgress(route, step); onBack() }} testId="guide-pause">稍后继续</Button>}{onHelp && <Button variant="ghost" disabled={locked} onClick={onHelp} testId="guide-help">需要帮助</Button>}
        </footer>
      </Card>
    </div>
  </main>
}
