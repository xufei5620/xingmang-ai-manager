import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AccountSessionState, AppSettingsV2, ProviderId, XingmangApi } from '../../../../electron/ipc-contract'
import type { ActiveProviderId } from '../../../../electron/catalog'
import { useLatestRequest, type LatestRequest } from '../../latest-request'
import { errorMessage } from '../../business-common'
import { accountScope, type AccountSiteId } from '../../account-context'
import type { AuthMode } from '../auth'
import { KeyRewriteSkippedError, bootstrapAccountTools, describeAccountBootstrapFailure, describeAccountBootstrapResult, sessionChangeKeepsBootstrap, skippedNamedProviders, subscriptionSwitchResult, type AccountBootstrapLogLine, type AccountBootstrapMode, type AccountBootstrapProgress, type AccountBootstrapResult } from '../tools/account-bootstrap'
import { idleOnlineResync, noteBootstrapOutcome, planOnlineResync } from '../tools/online-resync'
import { markDiagnosticsStale } from './environment-status'
import { toolTemplateFilledNotice, type StartupNotice } from './startup-notice'
import { createTemplateFillRetry } from './template-fill-retry'
import type { AppToast, Toolbox } from './runtime-context'

export interface AccountBootstrapView extends AccountBootstrapProgress {
  scope: string
  result?: AccountBootstrapResult
  /** result 落下来的时刻，首页「已完成…」那句据此到点收起（已知12）。 */
  finishedAt?: number
  error?: string
  /** 跟着连接线路悄悄改工具配置的那一轮（followRelayRoute）：首页不摆进度，出了错照常说。 */
  quiet?: boolean
}

interface AccountBootstrapOptions {
  native: XingmangApi
  settings: AppSettingsV2 | null
  toast: AppToast
  toolbox: Toolbox
  session: AccountSessionState
  scope: string
  siteId: AccountSiteId
  boot: 'loading' | 'ready' | 'failed'
  auth: AuthMode | null
  offline: boolean
  noteStartupCheck(notice: StartupNotice): void
  mounted: RefObject<boolean>
  accountEpoch: LatestRequest
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
  setWorkspaceEntered: Dispatch<SetStateAction<boolean>>
  /** 缩到托盘关掉界面以后重新加载的这一次（useRendererRelease.ts）：恢复那一轮照跑，首页不再摆进度。 */
  restoredBoot?: boolean
}

/**
 * 登录、开机恢复、装完工具之后把账号密钥写进各家工具（bootstrapAccountTools）。同一个账号同一种
 * 写法一次只跑一轮；换了账号，在跑的那一轮结果作废。断网时没写成的，网回来自动补一次。
 */
export function useAccountBootstrap(options: AccountBootstrapOptions) {
  const { native, settings, toast, toolbox, session, scope, siteId, boot, auth, offline, noteStartupCheck, mounted, accountEpoch, setAuth, setWorkspaceEntered, restoredBoot = false } = options
  // 开机那轮工具开着、设置没补成的，隔一阵再要（第二十六批 E）；真补上了照样在角落说一句。
  const templateFillRetry = useMemo(() => createTemplateFillRetry({
    fill: () => native.fillToolTemplateDefaults(true),
    filled: (providers) => {
      const notice = toolTemplateFilledNotice(providers)
      if (notice) noteStartupCheck(notice)
    },
  }), [native, noteStartupCheck])
  useEffect(() => {
    function foreground() {
      if (document.visibilityState !== 'hidden') templateFillRetry.foreground()
    }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
      templateFillRetry.stop()
    }
  }, [templateFillRetry])
  // 换了账号或退出登录：欠着的是上一个账号的，不再替它要（主进程那边也认账号）。
  useEffect(() => { templateFillRetry.stop() }, [templateFillRetry, scope, session.authenticated])
  const bootstrapRequest = useLatestRequest()
  const bootstrapInFlight = useRef<{ scope: string; promise: Promise<void> } | null>(null)
  const bootstrapAttempts = useRef(new Set<string>())
  const suppressedRestores = useRef(new Set<string>())
  const onlineResync = useRef(idleOnlineResync())
  const resumeOnline = useRef<(() => void) | null>(null)
  const [accountBootstrap, setAccountBootstrap] = useState<AccountBootstrapView | null>(null)
  const accountBootstrapRef = useRef(accountBootstrap)
  accountBootstrapRef.current = accountBootstrap
  const runAccountBootstrap = useCallback(async (userId: number, mode: AccountBootstrapMode = 'restore', force = false, onlyProviders?: readonly ProviderId[], accountSite: AccountSiteId = siteId, quiet = false) => {
    if (!settings || !Number.isSafeInteger(userId) || userId < 1) return
    const bootstrapScope = accountScope({ siteId: accountSite, account: { userId } as AccountSessionState['account'] })
    const attemptKey = `${bootstrapScope}:${mode}:${onlyProviders?.join(',') ?? 'all'}`
    const existing = bootstrapInFlight.current?.scope === bootstrapScope ? bootstrapInFlight.current.promise : null
    if (!force && bootstrapAttempts.current.has(attemptKey)) return existing ?? undefined
    if (existing) await existing
    bootstrapAttempts.current.add(attemptKey)
    const thisRound = bootstrapRequest.begin()
    const updateProgress = (progress: AccountBootstrapProgress) => {
      if (!mounted.current || !thisRound()) return
      setAccountBootstrap({ ...progress, scope: bootstrapScope, ...(quiet ? { quiet } : {}) })
    }
    updateProgress({ phase: 'syncing', label: '正在同步账号专属密钥', percent: 5 })
    // 结论要能被调用方读到：这个函数自己把失败收进首页的横幅，而「重新写入密钥」
    // 的人正站在「检查」页上，横幅在他看不见的地方。用对象而不是 let，是因为赋值
    // 发生在闭包里，TypeScript 会把 let 的类型收窄成初始值。
    const outcome: { result?: AccountBootstrapResult; error?: string } = {}
    // 这一轮给哪几家写了、跳过了谁、为什么，只进本机运行日志（info / warn 不上报），
    // 客服拿到报告才看得出「登录成功」和「打开工具」之间发生了什么。
    function logAccountBootstrap(line: AccountBootstrapLogLine) {
      void native.reportRendererError({ message: line.message, context: 'account-bootstrap', level: line.level }).catch(() => undefined)
    }
    const promise = (async () => {
      try {
        const result = await bootstrapAccountTools(native, userId, updateProgress, mode, onlyProviders)
        outcome.result = result
        // 真往工具配置里写了（或顺手修了 Codex 认不出的老配置），状态栏那份检查结果就说不准了（已知6）。
        // 换了账号也照样算：文件已经改了。
        if (result.configured.length || result.repairedShadowed?.length) markDiagnosticsStale()
        logAccountBootstrap(describeAccountBootstrapResult(mode, result))
        // 开机恢复只核对连没连上、一个字不写，老客户因此拿不到后来加进模板的设置。
        // 这里让主进程给当前账号写过、版本落后的配置补一次缺省项；补不成只进日志，
        // 真补了才在角落说一句。工具开着没补成的交给 templateFillRetry 隔一阵再要，
        // 等结果这段时间换了账号就不跟了。
        if (mode === 'restore') {
          const sameAccount = accountEpoch.capture()
          void Promise.resolve().then(() => native.fillToolTemplateDefaults()).then((filled) => {
            const notice = toolTemplateFilledNotice(filled.filled)
            if (notice) noteStartupCheck(notice)
            if (sameAccount()) templateFillRetry.follow(filled)
          }).catch(() => undefined)
        }
        if (!mounted.current || !thisRound()) return
        setAccountBootstrap((current) => current && current.scope === bootstrapScope
          ? { ...current, phase: 'verifying', label: result.failed.length ? '密钥同步完成，部分工具待处理' : '密钥已写入，正在刷新工具状态', percent: 100, result, finishedAt: Date.now() }
          : current)
        setWorkspaceEntered(true)
        // 只重读配置，不再把整轮环境探测走第二遍：跟着 Key 变的只有配置状态，
        // 已装/版本/桌面端是首屏那遍刚探完的（见 useToolbox.refreshConfig）。
        await toolbox.refreshConfig().catch(() => undefined)
        // 开机那一轮替客户修好了 Codex 认不出的老配置：没人点过按钮，轻轻说一句改了什么、
        // 原样在哪找回。点名重写的那一档由调用方自己报结果，这里不重复。
        if (mode !== 'rewrite' && result.repairedShadowed?.length) toast.show('已修好 Codex 的配置文件，坏掉的那份已备份', 'ok')
      } catch (cause) {
        outcome.error = errorMessage(cause, '账号密钥没有配好')
        logAccountBootstrap(describeAccountBootstrapFailure(mode, outcome.error))
        if (!mounted.current || !thisRound()) return
        setWorkspaceEntered(true)
        setAccountBootstrap((current) => ({
          ...(current ?? { phase: 'verifying', label: '密钥没有配好', percent: 100, scope: bootstrapScope }),
          scope: bootstrapScope,
          error: errorMessage(cause, '账号密钥没有配好'),
        }))
      }
    })()
    bootstrapInFlight.current = { scope: bootstrapScope, promise }
    try { await promise } finally {
      if (bootstrapInFlight.current?.promise === promise) bootstrapInFlight.current = null
    }
    onlineResync.current = noteBootstrapOutcome(onlineResync.current, bootstrapScope, outcome)
    return outcome
  }, [native, settings, toast.show, toolbox.refreshConfig, siteId, noteStartupCheck, templateFillRetry, accountEpoch, bootstrapRequest, mounted, setWorkspaceEntered])
  /**
   * 「重新写入密钥」与「密钥失效」的「一键修复」共用的入口：跑的就是装完工具后
   * 那条同样的重写流程（syncAfterToolInstalled 里的这一行），只是限定到指定的工具。
   * 主进程说不成的原因原样抛回给调用方，由它决定显示在哪，不在这里吞掉。
   */
  const rewriteAccountKeys = useCallback(async (providers?: readonly ProviderId[]) => {
    // 登录已经掉了就没有「当前账号」可写，这时该做的是把登录框打开，而不是报一句
    // 成功。返回值说的就是这次到底写没写。
    if (!session.authenticated || !session.account) { setAuth('login'); return false }
    // 点名某个工具 = 用户明确要求覆盖它，这一档才会去改写一份「被改动过」的配置；
    // 不点名的整轮修复照旧只碰来源确认过的那些，免得顺手改掉别的工具。
    const outcome = await runAccountBootstrap(session.account.userId, providers ? 'rewrite' : 'login', true, providers)
    if (outcome?.error) throw new Error(outcome.error)
    const failed = outcome?.result?.failed ?? []
    const relevant = providers ? failed.filter((entry) => providers.includes(entry.provider)) : failed
    if (relevant.length) throw new Error(relevant.map((entry) => entry.message).join('；'))
    // 点名的工具被跳过 = 配置里还是原来那把 Key，不能算写好了（#478）。
    const skipped = skippedNamedProviders(outcome?.result, providers)
    if (skipped.length) throw new KeyRewriteSkippedError(skipped)
    return true
  }, [runAccountBootstrap, session.account, session.authenticated, setAuth])
  /**
   * 订阅开通之后把用得上它的工具换过去。走的是开机恢复那一档：主进程这一轮发现哪家
   * 工具的 Key 换进了订阅分组，就只改写那几家，其余已连好的工具不碰。
   */
  const applySubscriptionToTools = useCallback(async (): Promise<ActiveProviderId[]> => {
    if (!session.authenticated || !session.account) return []
    const outcome = await runAccountBootstrap(session.account.userId, 'restore', true)
    if (outcome?.error) throw new Error(outcome.error)
    return subscriptionSwitchResult(outcome?.result)
  }, [runAccountBootstrap, session.account, session.authenticated])
  useEffect(() => {
    if (boot === 'ready' && !auth && session.authenticated && session.account) {
      const restoredScope = accountScope(session)
      if (!suppressedRestores.current.delete(restoredScope)) void runAccountBootstrap(session.account.userId, 'restore', false, undefined, siteId, restoredBoot)
    }
    if (!session.authenticated) {
      bootstrapRequest.invalidate()
      bootstrapInFlight.current = null
      onlineResync.current = idleOnlineResync()
      setAccountBootstrap(null)
    }
  }, [boot, runAccountBootstrap, session.account?.userId, session.authenticated, siteId, auth, restoredBoot])
  /**
   * 断网时打开软件，Key 同步这一步必然失败，而引导段每次启动只跑一次，网络回来
   * 之后不会有人再去补。这里挂一次自动补跑：只在上一轮确实是被网络拦住时补，
   * 每次离线→在线最多一次，补跑本身不弹任何对话框（结果照旧写进首页那条横幅）。
   *
   * 补跑仍走 restore 模式：已经连好的工具照旧跳过，不会覆盖任何现成配置。
   */
  useEffect(() => {
    if (boot !== 'ready' || !session.authenticated || !session.account) return
    const userId = session.account.userId
    function resume() {
      const plan = planOnlineResync(onlineResync.current, scope)
      onlineResync.current = plan.state
      if (!plan.scope) return
      void runAccountBootstrap(userId, 'restore', true).then((outcome) => {
        // 补跑再失败不打扰用户——他并没有点任何东西。留一行给运行日志，客服排查
        // 「明明联网了 Key 还是没写上」时才有据可查。
        const reason = outcome?.error || outcome?.result?.failed.map((entry) => entry.message).join('；') || ''
        if (!reason) return
        void native.reportRendererError({ message: `联网后自动补跑 Key 同步仍未完成：${reason}`, context: 'account-bootstrap-online-resync', level: 'warn' }).catch(() => undefined)
      })
    }
    resumeOnline.current = resume
    window.addEventListener('online', resume)
    return () => {
      resumeOnline.current = null
      window.removeEventListener('online', resume)
    }
  }, [boot, native, runAccountBootstrap, scope, session.account?.userId, session.authenticated])
  // 代理恢复、门户认证做完时系统不会发 online 事件，只有请求重新成功才知道网回来了；
  // 这时同样补跑一次。planOnlineResync 挡住了和 online 事件撞在一起的重复补跑。
  // 要排在上面那个 effect 后面：两个在同一次提交里都重跑时，这里叫到的得是刚挂上的那个 resume。
  const wasOffline = useRef(offline)
  useEffect(() => {
    if (wasOffline.current && !offline) resumeOnline.current?.()
    wasOffline.current = offline
  }, [offline])
  /** 会话事件来了：换到的不是在跑那一轮的账号，就让那一轮停下（sessionChangeKeepsBootstrap）。 */
  const followSessionChange = useCallback((next: AccountSessionState) => {
    if (!sessionChangeKeepsBootstrap(bootstrapInFlight.current?.scope, next)) {
      bootstrapRequest.invalidate()
      bootstrapInFlight.current = null
    }
  }, [bootstrapRequest])
  /** 「切换账号」里换了号：在跑的那一轮作废，首页那条进度收起。 */
  const abandonAccountBootstrap = useCallback(() => {
    bootstrapRequest.invalidate()
    bootstrapInFlight.current = null
    setAccountBootstrap(null)
  }, [bootstrapRequest])
  /** 刚登录、刚换号的账号由调用方自己跑一轮，开机恢复那一轮就不再跟着跑一次。 */
  const suppressRestore = useCallback((restoredScope: string) => {
    suppressedRestores.current.add(restoredScope)
  }, [])
  return { accountBootstrap, accountBootstrapRef, runAccountBootstrap, rewriteAccountKeys, applySubscriptionToTools, followSessionChange, abandonAccountBootstrap, suppressRestore }
}

export type AccountBootstrap = ReturnType<typeof useAccountBootstrap>
