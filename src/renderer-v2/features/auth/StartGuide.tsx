import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleCheck, Copy, Download, FolderOpen, FolderPlus, KeyRound, LogIn, MessageSquare, RefreshCw, Settings, Terminal, Zap } from 'lucide-react'
import type { AccountSourceSwitchResult, ProviderConfigSummary, ProviderId, StoreAppLaunchBlock } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Card, Logo, Pill, Progress } from '../../ui'
import { guideRecommendedTool, officialAccountNames, officialAccountNotes, tools as toolRegistry } from '../../registry/tools'
import { FirstRunSteps } from '../tools/FirstRun'
import { storeAppLaunchNotice } from '../tools/elevation-notice'
import { switchAccountLabel, type ToolUpdateOffer } from '../tools/model'
import { matchNetworkFailureMessage } from '../../../../electron/network-failure'
import { classifyOperationError, presentOperationError, type OperationAction, type OperationActionId } from '../../operation-error'
import { supportDetailOf, userFacingErrorMessage } from '../../business-common'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { buildSupportBundle, type SupportFailure, type SupportIdentityInput } from '../app/SupportIdentity'
import { errors } from '../../registry/errors'
import { clearGuideProgress, getGuideStorage, readGuideProgress, writeGuideProgress } from './guide-progress'
import { buildGuideSetupResult, type GuideSetupResult } from './guide-result'
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
  /** 这台电脑上装它、用它都不需要 Node.js（Windows 版 Grok，第十八批 8）；缺省 = 需要。 */
  runtimeNotNeeded?: boolean
  pythonReady?: boolean
  /** 这台电脑上装它、用它都不需要 Python（Linux 上的 Gemini，Linux 版拆分 ③）；缺省 = 按原来的判断。 */
  pythonNotNeeded?: boolean
  /** 缺 Node.js 时「安装」会先把它装上（Windows 代装）；缺省 = 旧行为，先单独准备。 */
  runtimeAutoPrepare?: boolean
  /** 同上，Gemini 的 Python。 */
  pythonAutoPrepare?: boolean
  detectionError?: boolean
  supported?: boolean
  installMode?: 'managed' | 'external' | 'unavailable'
  /** 来源是官方账号，但这个 CLI 里还没完成官方登录（R-G7）。 */
  officialLoginRequired?: boolean
  /** 装着的版本建议先换掉（旧了，或有已知问题）；缺省 = 不提。只是建议，不挡「下一步」。 */
  update?: ToolUpdateOffer | null
  model?: string
  workspace?: string
  /**
   * 来源没确认（source 为 unknown）时，Key 到底是哪种（方案盘查 2026-09-25）：
   * otherSite = 不是当前账号所在站的 Key，在这里用不了；otherAccount = 当前账号
   * 那个站上、却认不出是当前账号的 Key，能用但用量可能算到别的账号上；changed =
   * 替当前账号写过、之后在软件之外被改动过。缺省 = 按 otherSite 处理（旧行为：拦住）。
   */
  keyState?: 'otherSite' | 'otherAccount' | 'changed'
  /** 只有 Codex 桌面端会带：这个 Windows 账户多半打不开商店应用，装之前先说一句（第十九批 6）。 */
  storeAppLaunchBlock?: StoreAppLaunchBlock
}
export interface StartGuideProps {
  platform: 'win' | 'mac' | 'linux'
  tools: readonly GuideToolState[]
  signedIn: boolean
  busy?: boolean
  progress?: { label: string; percent: number }
  onDetect: () => Promise<void>
  /** version：点名装哪个版本（「更新」到推荐版本时）；缺省 = 按名单或最新版。 */
  onInstall: (route: Exclude<GuideRoute, 'chat'>, version?: string) => Promise<void>
  onInstallRuntime?: () => Promise<void>
  onInstallPython?: () => Promise<void>
  resumeKey?: string
  onConfigure: (route: Exclude<GuideRoute, 'chat'>) => Promise<void>
  /**
   * 第 3 步的一键「改用 <账号名>」：主进程先备份、再写入、再自检，连不上自动恢复原样，
   * 失败时抛错。返回 null = 没切（还没登录，先去登录了）。缺省 = 旧行为，只给「打开配置」。
   */
  onSwitchAccount?: (route: Exclude<GuideRoute, 'chat'>) => Promise<AccountSourceSwitchResult | null>
  /** 按钮上的账号名；没登录为 null。 */
  accountName?: string | null
  /**
   * 失败时「找客服」「去充值」「去备份页」「换成新版 Node.js」这些出口；缺省 = 只给「再试一次」。
   * retry 只在安装类失败时带上：换完 Node.js 要接着重装刚才那个工具。
   */
  onFailureAction?: (action: OperationActionId, retry?: () => void) => void
  /** 这台电脑能不能由本软件把 Node.js 换成新版（只有 Windows）；缺省 = 不能。 */
  canReplaceNode?: boolean
  onLogin: () => void
  /** newFolder：不弹目录选择器，替用户新建一个项目文件夹再打开（只对四家 CLI 有意义）。 */
  onLaunch: (route: GuideRoute, newFolder?: boolean) => Promise<boolean | void>
  onComplete: (route: GuideRoute) => void
  onBack?: () => void
  onHelp?: () => void
  /** 账号、版本、系统；给了才在红字旁出「复制给客服」（和错误框同一份内容）。 */
  support?: SupportIdentityInput
  /** 引导里的失败也记进帮助框的「最近一次出错」；缺省 = 不记。 */
  onFailure?: (failure: SupportFailure) => void
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

const installFailureKeys = new Set<string>(['toolRunning', 'installBlocked', 'downloadTimeout', 'diskFull', 'certDate', 'tlsIntercepted', 'toolCertOutdatedNode', 'toolCertElevated', 'permission'])

/**
 * 引导红字的三样东西，和错误框一个规矩（#670）：上屏那句、认出来的原因（认不出为空）、
 * 给客服看的原话（脱路径、打码，和上屏那句一样时不留）。
 */
export interface GuideFailure {
  message: string
  reason?: string
  detail?: string
}

const unrecognized = '（没认出是哪一类问题，原话在下面）'

/** 认不出原因时往哪儿指：有「复制给客服」就让他复制，没有才说「需要帮助」。 */
function guideFailureTail(unknown: boolean, copyable: boolean): string {
  return unknown && copyable ? '点「再试一次」，还不行就点「复制给客服」发给客服。' : '点「再试一次」，还不行就点「需要帮助」。'
}

function guideDetail(error: unknown, shown: string): string | undefined {
  const raw = supportDetailOf(error)
  return raw && raw !== shown ? raw : undefined
}

/**
 * 「安装」把运行环境和工具串成一次之后，失败得说清是哪一段没装上，再给一个
 * 能点的出口；authErrorMessage 是为登录写的，会把下载超时说成「连接星芒服务器
 * 超时」、再补一句「输入已保留」，放在这里全是错的。认不出原因时原话不再丢掉
 * （第二十一批 1）：红字说一句「原话在下面」，原话折在下面给客服看。
 */
export function guideInstallFailure(error: unknown, name: string, canReplaceNode = false, copyable = false): GuideFailure {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/运行环境正在准备/.test(message)) return { message: '运行环境还在准备，等它装完再点「再试一次」。' }
  const key = classifyOperationError(message)
  // 这一类重试只会撞同一个错，出路是换 Node.js（第十九批 1）；换完引导接着装。
  if (key === 'toolCertOutdatedNode' && canReplaceNode) {
    const shown = `${name} 没装上：这台电脑上的 Node.js 太旧，认不了公司电脑装的证书。点「换成新版 Node.js」，换好后星芒会接着装。`
    return { message: shown, reason: errors[key].title, detail: guideDetail(error, shown) }
  }
  // 目录里「超时」那条的标题写的是「连不上星芒服务器」，安装走的是下载源，
  // 照搬会把人指错方向；账号、计费那几类在安装里不会出现，也不借。
  const reason = key === 'timeout' ? '网络连不上' : installFailureKeys.has(key) ? errors[key].title : undefined
  const detail = guideDetail(error, '')
  const why = reason ? `（${reason}）` : detail ? unrecognized : ''
  const what = /运行环境没装上/.test(message) ? `运行环境没装上${why}，${name} 还没开始装` : `${name} 没装上${why}`
  return { message: `${what}。${guideFailureTail(!reason && Boolean(detail), copyable)}`, reason, detail }
}

/**
 * 引导里除「安装」以外的几步（准备环境、准备 Python、检测、确认连接、打开工具）
 * 失败时的说法（全面检测 Q8）。这几步都不是登录，以前借 authErrorMessage 翻译，
 * 于是「Node.js 下载超时」成了「连接星芒服务器超时」，主进程写好的中文原因
 * （「请先确认账号连接，再打开工具。」）被换成「输入已保留，请稍后重试」。
 * 现在按统一的操作失败分类说出是哪一类；分不出类的中文原话本身就是给人看的，
 * 原样留着（先脱路径再打码，I13）；分不出类的英文原文不再丢，折在红字下面。
 */
export function guideStepFailure(error: unknown, action: string, copyable = false): GuideFailure {
  const message = userFacingErrorMessage(error)
  // 主进程已经按受限网络的几种情形写好了中文（DNS、证书被替换、门户认证没做完），原样上屏。
  const network = matchNetworkFailureMessage(message)
  if (network) return { message: network, reason: network, detail: guideDetail(error, network) }
  const key = classifyOperationError(message)
  // 目录里「超时」那条的标题是「连不上星芒服务器」，这几步多半连的是下载源或本机，
  // 照搬会把人指错方向。
  if (key === 'timeout') return { message: `${action}没有成功：网络连不上。检查网络后点「再试一次」。`, reason: '网络连不上', detail: guideDetail(error, '') }
  if (key !== 'unknown') {
    const { title, body } = errors[key]
    return { message: `${action}没有成功：${title}。${body ? body.replace(/。?$/, '。') : ''}`, reason: title, detail: guideDetail(error, '') }
  }
  if (/[\u3400-\u9fff]/.test(message)) return { message: redactSecretPatterns(message) }
  const detail = guideDetail(error, '')
  return { message: `${action}没有成功${detail ? unrecognized : ''}。${guideFailureTail(Boolean(detail), copyable)}`, detail }
}

/** 「复制给客服」里「做什么」那一行：说清是引导里的哪一步、哪个工具。 */
export function guideSupportAction(action: string, name: string): string {
  if (action === '安装工具') return `新手引导 · 安装 ${name}`
  if (action === '更新工具') return `新手引导 · 更新 ${name}`
  if (action === '打开工具') return `新手引导 · 打开 ${name}`
  if (action === '改用当前账号') return `新手引导 · ${name} 改用当前账号`
  return `新手引导 · ${action}`
}

/** 「改用」失败时在「再试一次」之外给的出口；重试已经有自己的按钮，这里不再给。 */
export function guideFailureExits(reason: unknown): OperationAction[] {
  return presentOperationError(userFacingErrorMessage(reason))?.actions.filter((action) => action.id !== 'retry' && action.id !== 'copyPath') ?? []
}

/** 引导里会装东西的几步：失败时和错误框一样给出口，不只「再试一次」（第十九批 1）。 */
const guideInstallActions = new Set(['安装工具', '更新工具', '准备环境', '准备 Python'])

/**
 * 安装类失败的出口：和错误框（operationErrorActions）同一张表。「换成新版 Node.js」
 * 只有 Windows 换得了，换不了时重试只会撞同一个错，改给「找客服」；分不出类的
 * 也至少给「找客服」，别让人只剩「再试一次」。
 */
export function guideInstallExits(reason: unknown, canReplaceNode = false): OperationAction[] {
  const all = guideFailureExits(reason)
  const exits = all.filter((action) => canReplaceNode || action.id !== 'replaceNode')
  if (exits.length && exits.length === all.length) return exits
  return exits.some((action) => action.id === 'support') ? exits : [...exits, { id: 'support', label: '找客服' }]
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

/** 这一步要不要看 Node.js：桌面端与不需要它的命令行工具都不看。 */
function guideNeedsNodeRuntime(route: GuideRoute | null, state: GuideToolState | undefined): boolean {
  return route !== 'codexDesktop' && state?.runtimeNotNeeded !== true
}

/** 这一步要不要看 Python：只有 Gemini 看，而且主进程说这台电脑不需要时也不看。 */
function guideNeedsPython(route: GuideRoute | null, state: GuideToolState | undefined): boolean {
  return route === 'gemini' && state?.pythonNotNeeded !== true
}

export function resolveGuideReadiness(route: GuideRoute | null, state: GuideToolState | undefined, signedIn: boolean) {
  if (!route) return { prepared: false, connected: false }
  if (route === 'chat') return { prepared: true, connected: signedIn }
  return { prepared: Boolean(state && state.installed && !state.detectionError && state.supported !== false && state.installMode !== 'unavailable' && (!guideNeedsNodeRuntime(route, state) || state.runtimeReady === true) && (!guideNeedsPython(route, state) || state.pythonReady === true)), connected: Boolean(state && !state.detectionError && state.source !== 'none' && !state.officialLoginRequired
    // 来源没确认的只放行 Key 就在当前账号那个站上、确实能用的两种；别的站的 Key 在这里用不了。
    && (state.source !== 'unknown' || state.keyState === 'otherAccount' || state.keyState === 'changed')
    && (state.configured || state.source === 'official')) }
}

export function StartGuide(props: StartGuideProps) {
  return <AuthWindow platform={props.platform}><ScopedStartGuide key={`${props.resumeKey ?? 'volatile'}:${props.platform}`} {...props} /></AuthWindow>
}

/**
 * 很多客户是客服远程装好的，走完引导也没人告诉他钱从哪来、没钱了去哪充。
 * onRecharge 只在最后一步、而且花的确实是当前账号的余额时才给。
 */
function GuideResultCard({ result, onRecharge, disabled = false }: { result: GuideSetupResult; onRecharge?: () => void; disabled?: boolean }) {
  return <section className="auth-guide-result" aria-label="安装与连接结果" data-testid="guide-result">
    {([
      ['install', '安装情况', result.install],
      ['connection', '用的账号', result.connection],
      ['next', '下一步', result.next],
    ] as const).map(([id, label, row]) => <div className="auth-guide-result-row" key={id} data-testid={`guide-result-${id}`}>
      <strong>{label}</strong><div><Pill tone={row.tone}>{row.value}</Pill><p>{row.detail}</p></div>
    </div>)}
    <p className="auth-guide-result-billing" data-testid="guide-result-billing">费用：{result.billing}</p>
    {onRecharge && result.usesAccountBalance && <div className="auth-guide-check-row" data-testid="guide-recharge"><Zap size={20} aria-hidden="true" /><div><strong>还没充值的话先充值</strong><p>点「去充值」在软件里付款，付完马上能用，不用重新设置。以后余额用完了，点左下角余额旁边的「充值」就行。</p></div><Button variant="balance" size="sm" icon={Zap} disabled={disabled} onClick={onRecharge} testId="guide-recharge-button">去充值</Button></div>}
  </section>
}

function GuideFirstTaskPrompt({ prompt, disabled }: { prompt: string; disabled: boolean }) {
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null)
  const active = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  function copyPrompt() {
    if (!navigator.clipboard?.writeText) { setCopyState('failed'); return }
    void navigator.clipboard.writeText(prompt).then(
      () => { if (active.current) setCopyState('copied') },
      () => { if (active.current) setCopyState('failed') },
    )
  }
  return <div className="auth-guide-first-task" data-testid="guide-first-task">
    <strong>试试第一句话</strong>
    <p>打开后把这句话粘进去发出去。</p>
    <div><code data-testid="guide-first-task-prompt">{prompt}</code><Button size="sm" icon={Copy} disabled={disabled} onClick={copyPrompt} testId="guide-first-task-copy">复制这句话</Button></div>
    {copyState && <p role="status" data-testid="guide-first-task-copy-status">{copyState === 'copied' ? '已复制，打开后粘贴发出去就行' : '没能复制，可以手动选中上面这句话复制'}</p>}
  </div>
}

function ScopedStartGuide({ platform, tools, signedIn, busy = false, progress, onDetect, onInstall, onInstallRuntime, onInstallPython, resumeKey, onConfigure, onSwitchAccount, accountName = null, onFailureAction, canReplaceNode = false, onLogin, onLaunch, onComplete, onBack, onHelp, support, onFailure }: StartGuideProps) {
  const [restored] = useState(() => readGuideProgress(getGuideStorage(), resumeKey, platform))
  const options = toolRegistry.filter((item) => !item.hidden?.(platform)).sort((a, b) => Number(b.id === guideRecommendedTool) - Number(a.id === guideRecommendedTool) || a.shortcutIndex - b.shortcutIndex)
  const [route, setRoute] = useState<GuideRoute | null>(() => defaultGuideRoute(restored?.route, options.map((item) => item.id)))
  const [step, setStep] = useState<GuideStep>(restored?.step ?? 'choose')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  // 上一次失败的那一步，留着给「再试一次」原样再跑一遍；以前只有「安装」有这颗按钮。
  const [failed, setFailed] = useState<{ action: string; work: () => Promise<void> } | null>(null)
  // 「改用」失败时除了「再试一次」还要给的出口（没开通找客服、余额不足去充值、恢复失败去备份页）。
  const [failureExits, setFailureExits] = useState<OperationAction[]>([])
  // 这次失败交给客服的那份（原因、原话、哪一步）；复制的是出错那一刻的内容。
  const [failureNote, setFailureNote] = useState<SupportFailure | null>(null)
  const [supportCopy, setSupportCopy] = useState<{ state: 'ok' | 'failed'; text: string } | null>(null)
  // 这一轮引导里改用过的是哪个工具、结果如何：第 4 步据此说「已改用」还是「没能确认能用」。
  const [switched, setSwitched] = useState<{ route: GuideRoute; result: AccountSourceSwitchResult } | null>(null)
  // 改用成功后替用户点「下一步」；还没登录时先去登录，登好了接着改。
  const advanceAfterSwitch = useRef<GuideRoute | null>(null)
  const switchAfterLogin = useRef<GuideRoute | null>(null)
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
  // 装着的版本旧了（或有已知问题）只是一句建议加一颗按钮，「下一步」照常能点（Q50）。
  // 只在工具和运行环境都齐了时才提：没齐的时候先要做的是把它们准备好。
  const update = readiness.prepared && tool?.update ? tool.update : null
  // 只提醒，不拦「安装」：这种账户装不装得上没核过，装得上、打不开是推测。
  const storeAppNotice = route === 'codexDesktop' && tool && !tool.installed ? storeAppLaunchNotice(tool.storeAppLaunchBlock) : null
  const updateLabel = update?.newer === false ? '换成推荐版本' : '更新'
  const oneButton = Boolean(tool && !tool.installed && route !== 'codexDesktop' && (!guideNeedsNodeRuntime(route, tool) || tool.runtimeReady || tool.runtimeAutoPrepare) && (!guideNeedsPython(route, tool) || tool.pythonReady || tool.pythonAutoPrepare))
  // Node.js 由本软件准备的平台，运行环境那几句说「自动」「一键」，别把人支到软件外面去。
  // Linux 版拆分 ② 起 Linux 也是，按能力判断；Windows、Mac 两边的字样这次不动。
  const runtimeByApp = platform === 'win' || (platform === 'linux' && tools.some((entry) => entry.runtimeAutoPrepare === true))
  const currentStep = steps.findIndex((item) => item.id === step)
  const locked = busy || Boolean(pending)
  const saveProgress = (chosen: GuideRoute, currentStep: GuideStep) => {
    if (!writeGuideProgress(getGuideStorage(), resumeKey, { route: chosen, step: currentStep })) setStorageWarning('引导进度没有保存到本机，当前步骤仍可继续')
    else setStorageWarning('')
  }
  const choose = (chosen: GuideRoute) => { if (locked) return; setRoute(chosen); setSwitched(null); setError(''); setFailed(null); saveProgress(chosen, 'choose') }
  const install = () => {
    if (!route || route === 'chat') return
    const chosen = route
    const ticket = owner.current
    void run('安装工具', async () => { await onInstall(chosen); if (ticket === owner.current) advanceAfterInstall.current = chosen })
  }
  // 更新不接「装好后替他点下一步」：工具本来就装好了，更新被取消时版本没变，
  // 跟着往下走会让人以为已经更完。
  const updateTool = () => {
    if (!route || route === 'chat' || !update || update.manualHint) return
    const chosen = route
    const version = update.version ?? undefined
    void run('更新工具', () => onInstall(chosen, version))
  }
  useEffect(() => {
    if (!advanceAfterInstall.current) return
    if (step !== 'prepare' || route !== advanceAfterInstall.current) { advanceAfterInstall.current = null; return }
    if (locked || !readiness.prepared) return
    advanceAfterInstall.current = null
    setError(''); setFailed(null)
    move(skipConnect ? 'ready' : 'connect')
  }, [step, route, locked, readiness.prepared, skipConnect])
  useEffect(() => {
    if (!advanceAfterSwitch.current) return
    if (step !== 'connect' || route !== advanceAfterSwitch.current) { advanceAfterSwitch.current = null; return }
    if (locked || !readiness.prepared || !readiness.connected) return
    advanceAfterSwitch.current = null
    move('ready')
  }, [step, route, locked, readiness.prepared, readiness.connected])
  useEffect(() => {
    if (!switchAfterLogin.current || !signedIn || locked) return
    if (step !== 'connect' || route !== switchAfterLogin.current) { switchAfterLogin.current = null; return }
    switchAfterLogin.current = null
    switchAccount()
  }, [signedIn, locked, step, route])
  const move = (nextStep: GuideStep) => { setStep(nextStep); if (route) saveProgress(route, nextStep) }
  const complete = (chosen: GuideRoute) => { clearGuideProgress(getGuideStorage(), resumeKey); onComplete(chosen) }
  // 去充值就算走完引导：否则下次登录引导又从头弹出来，客户以为刚才没弄好。
  const recharge = (chosen: GuideRoute) => { if (locked) return; complete(chosen); onFailureAction?.('recharge') }
  const run = async (action: string, work: () => Promise<void>) => {
    if (lock.current || busy) return
    const ticket = owner.current
    lock.current = true; setPending(action); setError(''); setFailed(null); setFailureExits([]); setFailureNote(null); setSupportCopy(null)
    try { await work() }
    catch (reason) {
      if (ticket !== owner.current) return
      const failure = action === '安装工具' ? guideInstallFailure(reason, name, canReplaceNode, Boolean(support)) : guideStepFailure(reason, action, Boolean(support))
      const note: SupportFailure = { at: new Date(), action: guideSupportAction(action, name), message: failure.message, reason: failure.reason, detail: failure.detail }
      setError(failure.message)
      setFailureNote(note)
      onFailure?.(note)
      setFailed({ action, work })
      if (action === '改用当前账号' && onFailureAction) setFailureExits(guideFailureExits(reason))
      else if (guideInstallActions.has(action) && onFailureAction) setFailureExits(guideInstallExits(reason, canReplaceNode))
    }
    finally { if (ticket === owner.current) { lock.current = false; setPending('') } }
  }
  const copySupport = () => {
    if (!support || !failureNote) return
    const text = buildSupportBundle(support, failureNote)
    const ticket = owner.current
    // 剪贴板写不进时把同一份摆出来让他自己选中，和错误框一个处理。
    if (!navigator.clipboard?.writeText) { setSupportCopy({ state: 'failed', text }); return }
    void navigator.clipboard.writeText(text).then(
      () => { if (ticket === owner.current) setSupportCopy({ state: 'ok', text }) },
      () => { if (ticket === owner.current) setSupportCopy({ state: 'failed', text }) },
    )
  }
  const switchAccount = () => {
    if (!route || route === 'chat' || !onSwitchAccount || locked) return
    const chosen = route
    if (!signedIn) { switchAfterLogin.current = chosen; onLogin(); return }
    const ticket = owner.current
    void run('改用当前账号', async () => {
      const result = await onSwitchAccount(chosen)
      if (!result || ticket !== owner.current) return
      setSwitched({ route: chosen, result })
      advanceAfterSwitch.current = chosen
    })
  }
  const next = () => {
    if (locked || !route) return
    if (step === 'choose') { move('prepare'); if (route !== 'chat') void run('检测工具', onDetect) }
    else if (step === 'prepare' && readiness.prepared) move(skipConnect ? 'ready' : 'connect')
    else if (step === 'connect' && readiness.prepared && readiness.connected) move('ready')
    setError(''); setFailed(null)
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
  const officialName = route && route !== 'chat' ? officialAccountNames[route === 'codexDesktop' ? 'codex' : route] ?? '官方账号' : '官方账号'
  const switchLabel = switchAccountLabel(accountName)
  // 来源没确认时按 Key 的归属分三种说法；没接「改用」的调用方仍走旧的「打开配置」那条路。
  const foreign = tool?.source === 'unknown' && onSwitchAccount ? tool.keyState ?? 'otherSite' : null
  const codexShared = route === 'codex' || route === 'codexDesktop' ? 'Codex CLI 和 Codex 桌面端共用这份设置，会一起改。' : ''
  const foreignLead = { otherSite: `${name} 现在用的不是当前账号的 Key。`, otherAccount: `${name} 现在用的 Key 可能不是当前账号的。`, changed: `${name} 的配置在软件之外被改动过。` }
  const switchButton = signedIn ? switchLabel : '登录后改用我的账号'
  const foreignCallout = { otherSite: `点「${switchButton}」就能接着往下走。改之前会先把现在的设置备份一份。`, otherAccount: `能直接用，但用量可能算到别的账号上。点「${switchButton}」换成你自己的，改之前会先备份。`, changed: `现在还能用。想恢复成你账号的设置，点「${switchButton}」，改之前会先备份。` }
  // 官方账号本来就能用，「改用」只是旁边一颗次要按钮；没登录时不给，免得点了先弹登录。
  const offerSwitch = Boolean(onSwitchAccount && (foreign || (tool?.source === 'official' && signedIn)))
  const switchedHere = switched && switched.route === route ? switched.result : null
  const sourceLabel = tool?.source === 'official' ? tool.officialLoginRequired ? `${officialName}（未登录）` : officialName : tool?.source === 'account' ? '星芒账号' : tool?.source === 'manual' ? '手动填写密钥' : tool?.source === 'unknown' ? '用的是别处的配置' : '尚未选择连接方式'
  // 切换的回执：失败时原因一定要留着（余额不足、网络不通），只去掉和标题重复的开头；
  // 真有备份编号才说能找回。
  function switchReceipt(result: AccountSourceSwitchResult) {
    const backup = result.backupId.trim() ? '原来的设置已备份，在「备份」里能找回。' : ''
    if (result.target === 'official') return `已换回 ${officialName}。${result.loginRequired ? `还要打开 ${name}，用 ${officialName}登录一次。` : ''}${backup}`
    if (result.verified) return `已${switchLabel}。${backup}`
    return `${result.message.replace(/^已改用当前账号[，。]?/, '')}${backup}`
  }
  // 有「换成新版 Node.js」时它才是出路：排在「再试一次」前面、当主按钮，和错误框一个规矩。
  const replaceFirst = Boolean(onFailureAction && failureExits.some((action) => action.id === 'replaceNode'))
  const result = route ? buildGuideSetupResult({ route, tool, signedIn, readiness, name, officialName, accountName, switched: switchedHere }) : null
  return <main className="auth-guide" data-testid="onboarding-page">
    <div className="auth-guide-frame" data-testid="start-guide" data-guide-step={step} data-guide-route={route ?? ''} aria-busy={locked} data-busy={locked}>
      <Card><div className="auth-guide-brand"><div><Logo kind="micro" height={28} /><Logo kind="wordmark" height={22} /></div><span>第 {currentStep + 1} 步，共 4 步</span></div>
        <ol className="auth-guide-steps start-guide-steps" aria-label="首次使用进度">{steps.map((item, index) => <li key={item.id} aria-current={item.id === step ? 'step' : undefined} data-completed={index < currentStep}><i>{index < currentStep ? <Check size={14} aria-hidden="true" /> : index + 1}</i><span>{item.title}</span></li>)}</ol>
        <h1 ref={heading} tabIndex={-1} data-testid="guide-heading">{step === 'ready' ? '可以开始了' : steps[currentStep].title}</h1>
        <div className="auth-guide-body">
          {step === 'choose' && <><p className="auth-guide-lead">{signedIn ? '账号已登录。' : ''}选一个先开始，之后随时可以再装别的。</p><fieldset className="auth-guide-choices" disabled={locked}><legend>开始方式</legend>{options.map((item) => <label className="auth-guide-choice" data-selected={route === item.id} key={item.id}><input type="radio" name="start-guide-route" value={item.id} checked={route === item.id} onChange={() => choose(item.id as GuideRoute)} data-testid={`guide-route-${item.id}`} /><BrandIcon tool={item.id} size={32} variant="tile" /><strong>{item.name}{item.id === guideRecommendedTool && <Pill tone="accent" testId="guide-recommended">推荐</Pill>}</strong><span>{item.vendor} · {item.kind === 'desktop' ? '图形界面，点开就能用' : runtimeByApp ? '命令行，会自动帮你准备运行环境' : '命令行，要先按提示准备运行环境'}</span></label>)}<label className="auth-guide-choice" data-selected={route === 'chat'}><input type="radio" name="start-guide-route" value="chat" checked={route === 'chat'} onChange={() => choose('chat')} data-testid="guide-route-chat" /><MessageSquare size={26} aria-hidden="true" /><strong>先在星芒里聊天</strong><span>直接描述你的问题，稍后再准备编程工具</span></label></fieldset></>}
          {step === 'prepare' && route === 'chat' && <p className="auth-guide-callout">聊天在星芒内打开，这一步无需安装其他工具。</p>}
          {step === 'prepare' && route && route !== 'chat' && <>
            <p className="auth-guide-lead">{readiness.prepared ? update ? `${name} 已经装好，但${update.knownIssue ? '这个版本有已知问题，用起来会出错' : '版本旧了'}，建议先${update.manualHint ? '用它原来的方式更新' : `点「${updateLabel}」`}。${update.knownIssue ? '' : '不更新也能直接点「下一步」。'}` : `${name} 已经装好。` : oneButton ? '点「安装」就行，缺的运行环境会一并装好。' : `核对 ${name} 的安装状态，再按顺序准备。`}</p>
            {!tool || tool.detectionError ? <p className="auth-error" role="alert">暂时无法确认工具是否已安装，请重新检测。</p> : <div className="auth-guide-checklist">
              {guideNeedsNodeRuntime(route, tool) && <div className="auth-guide-check-row"><Terminal size={20} aria-hidden="true" /><div><strong>运行环境</strong><p>{tool.runtimeReady ? '运行环境已就绪' : oneButton ? '点「安装」时会一并装好' : runtimeByApp ? '命令行工具需要运行环境' : '在应用外安装完成后回来重新检测'}</p></div><Pill tone={tool.runtimeReady ? 'ok' : oneButton ? 'neutral' : 'warn'}>{tool.runtimeReady ? '已就绪' : oneButton ? '自动准备' : '待准备'}</Pill>{!tool.runtimeReady && !oneButton && onInstallRuntime && <Button icon={Download} disabled={locked} onClick={() => void run('准备环境', onInstallRuntime)} testId="guide-node">{runtimeByApp ? '一键安装' : '安装指南'}</Button>}</div>}
              {guideNeedsPython(route, tool) && <div className="auth-guide-check-row" data-testid="guide-python-step"><BrandIcon tool="python" size={26} /><div><strong>Python</strong><p>{tool.pythonReady ? 'Python 已就绪' : oneButton ? '点「安装」时会一并装好' : !tool.runtimeReady ? '先准备运行环境，再继续这一步' : platform === 'win' ? 'Gemini 的准备清单包含 Python 环境' : '在应用外安装 Python 后回来重新检测'}</p></div><Pill tone={tool.pythonReady ? 'ok' : oneButton ? 'neutral' : 'warn'}>{tool.pythonReady ? '已就绪' : oneButton ? '自动准备' : '待准备'}</Pill>{!tool.pythonReady && !oneButton && onInstallPython && <Button icon={Download} disabled={locked || !tool.runtimeReady} onClick={() => void run('准备 Python', onInstallPython)} testId="guide-python">{platform === 'win' ? '一键安装' : '安装指南'}</Button>}</div>}
              <div className="auth-guide-check-row"><BrandIcon tool={route} size={26} /><div><strong>{name}</strong><p>{tool.installed ? `已找到${tool.version ? ` v${tool.version}` : ''}${update?.target ? `，${update.newer ? '新版' : '推荐版本'}是 ${update.target}` : ''}` : '尚未检测到安装'}</p>{storeAppNotice && <p className="auth-hint" data-testid="guide-store-app-notice">{storeAppNotice}</p>}</div><Pill tone={tool.installed && !update ? 'ok' : 'warn'} testId="guide-tool-status">{!tool.installed ? '未安装' : update ? update.knownIssue ? '有已知问题' : '可更新' : '已安装'}</Pill>{update && !update.manualHint && <Button icon={Download} disabled={locked} onClick={updateTool} testId="guide-update">{updateLabel}</Button>}{!tool.installed && tool.supported !== false && tool.installMode !== 'unavailable' && <Button icon={Download} disabled={locked || (!oneButton && ((guideNeedsNodeRuntime(route, tool) && !tool.runtimeReady) || (guideNeedsPython(route, tool) && !tool.pythonReady)))} onClick={install} testId="guide-install">{tool.installMode === 'external' ? '安装指南' : '安装'}</Button>}</div>
              {update?.manualHint && <p className="auth-hint" data-testid="guide-update-manual">{update.manualHint}</p>}
              {(tool.supported === false || tool.installMode === 'unavailable') && <p className="auth-error">当前平台暂不支持这个工具，请返回选择其他开始方式。</p>}
            </div>}
            <Button icon={RefreshCw} disabled={locked} onClick={() => void run('检测工具', onDetect)} testId="guide-installed-rescan">我已装好，重新检测</Button>
          </>}
          {step === 'connect' && route === 'chat' && <><p className="auth-guide-callout">{signedIn ? '进入聊天后，选择分组和模型，再输入第一个问题。' : '登录星芒账号后即可开始聊天。'}</p>{!signedIn && <Button variant="primary" icon={LogIn} onClick={onLogin} testId="guide-login">登录账号</Button>}</>}
          {step === 'connect' && route && route !== 'chat' && <>{foreign ? <p className="auth-guide-lead" data-testid="guide-foreign-key" data-key-state={foreign}>{foreignLead[foreign]}</p> : <p className="auth-guide-lead">{name} 的连接方式：<strong>{sourceLabel}</strong></p>}<p className="auth-guide-callout" data-testid={tool?.officialLoginRequired ? 'guide-official-login' : undefined}>{foreign ? `${foreignCallout[foreign]}${codexShared}` : tool?.source === 'unknown' ? '你原来的配置已经原样留着。先看看处理步骤，确认哪些设置要留下，再决定怎么连接。' : tool?.officialLoginRequired ? `当前选的是官方账号，但还没有在 ${name} 里登录。请打开 ${name} 用 ChatGPT 账号登录后回来重新检测，或打开配置改用星芒账号的密钥。` : tool?.source === 'official' ? '保留当前官方来源。官方账号的登录和可用额度，请在工具内确认。' : readiness.connected ? '当前连接已确认。需要换密钥、模型或工作文件夹时，可以打开配置。' : '打开配置选择连接来源、密钥、模型和工作文件夹，确认后保存。'}</p>{officialNote && <p className="auth-hint" data-testid="guide-official-note">{officialNote}</p>}{tool?.model && <p className="auth-hint">模型：{tool.model}</p>}{tool?.workspace && <p className="auth-hint">工作文件夹：{tool.workspace}</p>}<div className="auth-form-actions">{offerSwitch && <Button icon={KeyRound} variant={foreign === 'otherSite' ? 'primary' : 'secondary'} loading={pending === '改用当前账号'} disabled={locked} onClick={switchAccount} testId="guide-switch-account">{switchButton}</Button>}{foreign !== 'otherSite' && <><Button icon={Settings} variant={readiness.connected || offerSwitch ? 'secondary' : 'primary'} disabled={locked} onClick={() => void run('确认连接', () => onConfigure(route))} testId="guide-config">{tool?.source === 'unknown' && !foreign ? '查看已有配置处理步骤' : readiness.connected ? '查看连接配置' : '去完成连接配置'}</Button><Button icon={RefreshCw} disabled={locked} onClick={() => void run('检测工具', onDetect)} testId="guide-connection-rescan">重新检测</Button></>}</div></>}
          {(step === 'connect' || step === 'ready') && result && <GuideResultCard result={result} disabled={locked} onRecharge={step === 'ready' && onFailureAction && route && readiness.prepared && readiness.connected ? () => recharge(route) : undefined} />}
          {step === 'ready' && <>
            <p className="auth-guide-lead">{route === 'chat' ? '从一个问题开始，慢慢熟悉你的 AI 工作台。' : readiness.prepared && readiness.connected ? switchedHere?.target === 'account' && !switchedHere.verified ? `${name} 已改用你的账号，但这次没能确认能用。` : `${name} 已准备好。打开工具，即可开始第一次任务。` : '工具或配置状态已变化，请返回复核。'}</p>
            {switchedHere ? <div className="auth-hint auth-guide-connected" data-testid="guide-switched-note" data-backup-id={switchedHere.backupId.trim() || undefined}><p>{switchReceipt(switchedHere)}</p>{switchedHere.target === 'account' && !switchedHere.verified && onFailureAction && guideFailureExits(switchedHere.message).map((action) => <Button key={action.id} size="sm" disabled={locked} onClick={() => onFailureAction(action.id)} testId={`guide-exit-${action.id}`}>{action.label}</Button>)}</div> : skipConnect && <p className="auth-hint auth-guide-connected" data-testid="guide-connected-note">已用当前账号连好。想换密钥或模型，<Button variant="ghost" size="sm" disabled={locked} onClick={() => { if (route && route !== 'chat') void run('确认连接', () => onConfigure(route)) }} testId="guide-connected-config">点这里</Button></p>}
            {definition?.firstRun && readiness.prepared && readiness.connected && <FirstRunSteps key={route} name={name} firstRun={definition.firstRun} testId="guide-first-run" />}
            {result?.prompt && readiness.prepared && readiness.connected && <GuideFirstTaskPrompt key={route} prompt={result.prompt} disabled={locked} />}
            {opensFolder && readiness.prepared && readiness.connected && <div className="auth-guide-check-row" data-testid="guide-folder-hint"><FolderPlus size={20} aria-hidden="true" /><div><strong>选哪个文件夹</strong><p>打开时要选一个项目文件夹。不知道选哪个，就点「新建并打开」，软件替你建好一个空文件夹并直接打开。</p></div><Button icon={FolderPlus} disabled={locked} onClick={() => launch(true)} testId="guide-open-tool-new-folder">新建并打开</Button></div>}
            <Button icon={RefreshCw} disabled={locked} onClick={() => void run('检测工具', onDetect)} testId="guide-ready-rescan">重新检测</Button>
            <div className="auth-guide-ready"><CircleCheck size={30} aria-hidden="true" /><span>有需要时，可从首页重新打开这份引导。</span></div>
          </>}
          {(step === 'connect' || step === 'ready') && !readiness.prepared && <p className="auth-error" role="alert">工具或运行环境尚未准备好，请返回准备工具步骤后再继续。</p>}
          {pending && <p className="auth-hint" role="status">正在{pending}，请稍候</p>}{progress && locked && <Progress value={progress.percent} label={progress.label} testId="guide-progress" />}{error && <p className="auth-error" role="alert" data-testid="guide-error">{error}</p>}{error && failureNote?.detail && <details className="auth-guide-raw" open={!failureNote.reason} data-testid="guide-error-raw"><summary>给客服看的原话</summary><pre>{failureNote.detail}</pre></details>}{error && replaceFirst && failed && <Button variant="primary" disabled={locked} onClick={() => onFailureAction?.('replaceNode', () => void run(failed.action, failed.work))} testId="guide-exit-replaceNode">换成新版 Node.js</Button>}{error && failed && <Button icon={RefreshCw} disabled={locked} onClick={() => void run(failed.action, failed.work)} testId="guide-retry">再试一次</Button>}{error && support && failureNote && <Button icon={Copy} disabled={locked} onClick={copySupport} testId="guide-copy-support">复制给客服</Button>}{error && onFailureAction && failureExits.filter((action) => action.id !== 'replaceNode').map((action) => <Button key={action.id} disabled={locked} onClick={() => onFailureAction(action.id)} testId={`guide-exit-${action.id}`}>{action.label}</Button>)}{error && supportCopy && <p className="auth-hint" role="status" data-testid="guide-copy-support-status">{supportCopy.state === 'ok' ? '已复制，发给客服就行' : '没能写进剪贴板，手动选中下面这几行复制就行'}</p>}{error && supportCopy?.state === 'failed' && <pre className="auth-guide-support-text" data-testid="guide-copy-support-text">{supportCopy.text}</pre>}{storageWarning && <p className="auth-hint" role="status">{storageWarning}</p>}
        </div>
        <footer className="auth-guide-actions start-guide-footer">
          {step !== 'choose' && <Button icon={ArrowLeft} variant="ghost" disabled={locked} onClick={() => { setError(''); move(steps[currentStep - 1].id) }} testId="guide-back">上一步</Button>}
          <span className="auth-footer-spacer" />
          {step === 'ready' ? <><Button variant="primary" icon={route === 'chat' ? MessageSquare : FolderOpen} loading={pending === '打开工具'} disabled={locked || !readiness.prepared || !readiness.connected} onClick={() => launch()} testId={route === 'chat' ? 'guide-chat' : 'guide-open-tool'}>{route === 'chat' ? '开始聊天' : `打开 ${name}`}</Button><Button disabled={locked || !route || !readiness.prepared || !readiness.connected} onClick={() => { if (route) complete(route) }} testId="guide-home">进入首页</Button></> : step === 'connect' && foreign === 'otherSite' ? null : <Button variant="primary" iconRight={ArrowRight} disabled={locked || !route || (step === 'prepare' && !readiness.prepared) || (step === 'connect' && (!readiness.prepared || !readiness.connected))} onClick={next} testId="guide-next">下一步</Button>}
          {onBack && <Button variant="ghost" disabled={locked} onClick={() => { if (route) saveProgress(route, step); onBack() }} testId="guide-pause">稍后继续</Button>}{onHelp && <Button variant="ghost" disabled={locked} onClick={onHelp} testId="guide-help">需要帮助</Button>}
        </footer>
      </Card>
    </div>
  </main>
}
