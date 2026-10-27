import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AccountSourceSwitchResult, AccountSourceTarget, AppSettingsV2, PlatformCapabilities, ProviderId, XingmangApi } from '../../../../electron/ipc-contract'
import type { LatestRequest } from '../../latest-request'
import { errorMessage } from '../../business-common'
import type { AccountBootstrapView } from '../app/useAccountBootstrap'
import type { AppApi, AppToast, Perform, Toolbox, ToolsApi } from '../app/runtime-context'
import type { WindowOs } from '../app/window-os'
import { accountKeyChangeInProgress } from './account-bootstrap'
import { chineseRuntimePatchAnswerMissing, shouldAskForChineseRuntimePatch } from './chinese-runtime-choice'
import { offersCodexDesktopRestartOnOpen } from './codex-desktop-open'
import { resolveToolKeySyncFailure } from './key-sync-failure'
import { launchWaitLabel, launchWarning } from './launch-notice'
import { waitWhileAccountConnectionPending } from './launch-wait'
import { codexNeedsRepair, presentTools, providerFor, readyOnceRepaired, type ToolId, type ToolSource } from './model'
import { modelSwapOffer, type ModelSwapChoice, type ModelSwapOffer } from './model-check'
import { isMissingWorkspace, launchWorkspaces, type CliLaunchChoice } from './recent-workspaces'
import { jobToolName } from './tool-jobs'

/**
 * 没有现成目录时怎么定：'choose' 弹选择器；'create' 替用户新建项目文件夹（下拉、引导里那一项）；
 * 'firstOpen' 是首页第一次点「打开」（已知40）：主进程记着的文件夹还在就用它，没有才新建，
 * 建不成说一句再弹选择器。
 */
export type LaunchFolder = 'choose' | 'create' | 'firstOpen'

interface ToolLaunchOptions {
  native: XingmangApi
  app: AppApi
  toolsApi: ToolsApi
  toolbox: Toolbox
  toast: AppToast
  perform: Perform
  settings: AppSettingsV2 | null
  setSettings: Dispatch<SetStateAction<AppSettingsV2 | null>>
  platform: PlatformCapabilities | null
  os: WindowOs
  scope: string
  mounted: RefObject<boolean>
  accountEpoch: LatestRequest
  accountBootstrapRef: RefObject<AccountBootstrapView | null>
  switchToolAccount(tool: ToolId, target: AccountSourceTarget): Promise<AccountSourceSwitchResult | null>
  openToolConfig(tool: ToolId): void
  setSwitchRestartOffer: Dispatch<SetStateAction<AccountSourceTarget | null>>
}

/**
 * 首页、托盘、快捷键、记录页「接着聊」打开工具的那一整条：打开前的几道关、要不要换默认模型、
 * Codex 桌面端开着要不要重开、要不要中文。每一步都认点「打开」时的那个账号，中途换了账号就停下。
 */
export function useToolLaunch(options: ToolLaunchOptions) {
  const { native, app, toolsApi, toolbox, toast, perform, settings, setSettings, platform, os, scope, mounted, accountEpoch, accountBootstrapRef, switchToolAccount, openToolConfig, setSwitchRestartOffer } = options
  const [modelSwap, setModelSwap] = useState<{ offer: ModelSwapOffer; answer: (choice: ModelSwapChoice) => void } | null>(null)
  const [restartDialog, setRestartDialog] = useState(false)
  const [chineseDialog, setChineseDialog] = useState(false)
  /** 换模型弹框还开着时切了账号，要替用户点掉：那是上一个账号的提问（#538）。 */
  const pendingModelSwap = useRef<((choice: ModelSwapChoice) => void) | null>(null)
  /** 还在准备（主进程那边还没开始打开）的「打开中」，按工具记着怎么放掉；见 holdLaunch。 */
  const preparingLaunches = useRef(new Map<ToolId, () => void>())
  const launchRequest = useRef<{ id: ToolId; epoch: () => boolean } | null>(null)
  const cancelPendingLaunchDialogs = useCallback(() => {
    // 上一个账号点的「打开」后面每一步都会自己停下（launchIsCurrent），卡片上的「打开中」不陪它
    // 等完读配置、核对模型，新账号点「打开」也不被它挡住。主进程已经在打开的不放，照旧等它做完。
    const releases = [...preparingLaunches.current.values()]
    preparingLaunches.current.clear()
    for (const release of releases) release()
    pendingModelSwap.current?.('cancel')
    pendingModelSwap.current = null
    setModelSwap(null)
    setRestartDialog(false)
    setSwitchRestartOffer(null)
    setChineseDialog(false)
  }, [setSwitchRestartOffer])
  function launchIsCurrent(epoch: () => boolean): boolean {
    return mounted.current && epoch()
  }
  function accountConnectionPending(provider: ProviderId): boolean {
    const latest = accountBootstrapRef.current
    return accountKeyChangeInProgress(latest?.scope === scope ? latest : null, provider)
  }
  /**
   * 这个工具点下去的「打开」是不是停在等账号那一轮（waitForAccountConnection，最长 3 分钟）。
   * 停在那里的那次只占自己那张卡的「打开中」：首页 launchWaitingForAccount 看的是同一件事，把它从
   * launchBusy 里去掉；requestLaunch 也放别的工具过，不让一个工具等账号把全部工具都按住。
   */
  function launchParkedOnAccount(id: ToolId): boolean {
    const snapshot = toolbox.snapshot
    const tool = snapshot ? presentTools(snapshot).find((entry) => entry.id === id) : undefined
    return tool?.source === 'account' && accountConnectionPending(tool.provider)
  }
  /**
   * 账号这一轮还在给这个工具换密钥时点了「打开」（主路卡点 F7）：以前只弹一句「请稍后再打开」就停下，
   * 好了也不自己打开。现在弹「好了会自动打开」，等那一轮写完再接着往下走。那一轮没给这个工具写成的，
   * 首页横幅已经在说原因，这里把同一句弹一下、不打开；等太久就放手，说回原来那句。
   * 等的这段仍挂在自己那张卡的「打开中」上（holdLaunch），别的工具不受连累（launchParkedOnAccount）。
   * 'ready' = 没什么要等的；'waited' = 等完了、密钥刚换过，调用方要重读配置；'stop' = 这次不开。
   */
  async function waitForAccountConnection(tool: { id: ToolId; source: ToolSource; provider: ProviderId }, epoch: () => boolean): Promise<'ready' | 'waited' | 'stop'> {
    if (tool.source !== 'account' || !accountConnectionPending(tool.provider)) return 'ready'
    toast.show('正在连接账号，好了会自动打开。', 'neutral')
    const outcome = await waitWhileAccountConnectionPending({ pending: () => accountConnectionPending(tool.provider), current: () => launchIsCurrent(epoch) })
    if (outcome === 'stopped') return 'stop'
    if (outcome === 'timeout') { toast.show('正在同步这个工具的账号连接，请稍后再打开。', 'neutral'); return 'stop' }
    const latest = accountBootstrapRef.current
    const failure = resolveToolKeySyncFailure(latest?.scope === scope ? latest : null, tool.provider, tool.id)
    if (failure) { toast.show(failure.text, 'warn'); return 'stop' }
    return 'waited'
  }
  /**
   * 真打开之前那几道关：检测出没出错、装没装、Codex 老配置先修、没连好账号先去连、核对默认模型。
   * 首页「打开」「接着聊」走 openTool()，记录页「接着聊」自己叫主进程打开，两边都先过这里
   * （第四十批 B：记录页以前一道都没过）。返回打开前读到的快照、配置和工具；null = 不往下走
   * （问话框里关掉了，或者中途换了账号），什么都不打开，也不报错。
   */
  async function prepareToolLaunch(id: ToolId, epoch: () => boolean) {
    try {
      if (!launchIsCurrent(epoch)) return null
      const current = toolbox.snapshot
      if (!current) throw new Error('请先完成工具检测')
      let config = await toolsApi.readConfig()
      if (!launchIsCurrent(epoch)) return null
      let tool = presentTools({ ...current, config }).find((entry) => entry.id === id)
      if (!tool) throw new Error('当前平台暂不支持打开这个工具')
      if (tool.error) throw new Error(tool.error)
      if (!tool.status.installed) throw new Error('工具尚未安装，请先完成准备。')
      // Shortcuts, tray actions and the records page share this entry, including
      // after the scan finishes but account configuration is still waiting on the backend.
      const waited = await waitForAccountConnection(tool, epoch)
      if (waited === 'stop') return null
      if (waited === 'waited') {
        // 那一轮刚写进去的密钥要读进来，接下去修配置、核对模型看的才是新的那份。
        config = await toolsApi.readConfig()
        if (!launchIsCurrent(epoch)) return null
        tool = presentTools({ ...current, config }).find((entry) => entry.id === id) ?? tool
      }
      // Codex 老配置写在它不认的名字下，照原样打开必然报 Key 无效。修完就能用的，
      // 先替用户修（和「修好它」同一条路：备份、写入、自检，失败会恢复原样）再打开。
      if (!tool.configured && readyOnceRepaired(config.providers[tool.provider], tool.provider)) {
        const repaired = await switchToolAccount(id, 'account')
        if (!repaired || !launchIsCurrent(epoch)) return null
        const fresh = await toolsApi.readConfig()
        if (!launchIsCurrent(epoch)) return null
        tool = presentTools({ ...current, config: fresh }).find((entry) => entry.id === id) ?? tool
        if (codexNeedsRepair(fresh.providers[tool.provider], tool.provider)) throw new Error('Codex 的连接设置没修好，已保持原样。请在首页点「修好它」再试一次。')
      }
      if (!tool.configured) { openToolConfig(id); throw new Error('请先确认账号连接，再打开工具。') }
      // Every awaited step belongs to the account that requested this launch. A
      // later session event must not resume the old request against a new owner.
      const offer = modelSwapOffer(tool.name, await toolsApi.checkModels(id))
      if (!launchIsCurrent(epoch)) return null
      if (offer) {
        let answerCurrent: (choice: ModelSwapChoice) => void = () => undefined
        const choice = await new Promise<ModelSwapChoice>((answer) => {
          answerCurrent = answer
          // 首页、托盘的「打开」一次只放一个（launchRequest），记录页「接着聊」不走那里：记录页这一问
          // 还开着时从托盘打开工具，新的一问会顶掉它。旧的那一问替用户关掉（等于这次先不打开），
          // 不然它永远等不到回答，记录页一直转圈。
          pendingModelSwap.current?.('cancel')
          pendingModelSwap.current = answer
          setModelSwap({ offer, answer })
        })
        if (pendingModelSwap.current === answerCurrent) {
          pendingModelSwap.current = null
          setModelSwap(null)
        }
        if (choice === 'cancel' || !launchIsCurrent(epoch)) return null
        if (choice === 'swap') {
          // Empty key keeps the existing source; an ordinary save failure still
          // opens with the old model, while an account change stops the launch.
          let saved = false
          try {
            await toolsApi.saveManual({ provider: providerFor(id), apiKey: '', model: offer.replacement, mode: 'merge' })
            saved = true
          }
          catch (cause) {
            if (!launchIsCurrent(epoch)) return null
            toast.show(`模型没换成，先照旧打开：${errorMessage(cause)}`, 'warn')
          }
          if (!launchIsCurrent(epoch)) return null
          if (saved) {
            const refreshed = await toolbox.refreshSavedConfig(() => launchIsCurrent(epoch))
            if (!launchIsCurrent(epoch)) return null
            if (!refreshed) toast.show('模型已保存，但最新配置没有读到；工具列表可能仍显示旧模型。请重新检测，无需重复保存。', 'warn')
          }
        }
      }
      return { current, config, tool }
    } catch (cause) {
      if (!launchIsCurrent(epoch)) return null
      throw cause
    }
  }
  /**
   * 首页「打开」一点下去就挂上「正在打开工具」（#1104 第 3 条）：读配置、核对默认模型要好几秒，
   * 以前等这几步走完才挂，卡片一动不动，再点一下又被 launchRequest 悄悄挡掉，客户以为没点上。
   * 同一个 key 的任务只放一个（toolbox.run 的锁），所以只在最外层挂一次：requestLaunch 和
   * launch() 各自挂，里面那几步走 openTool，不再自己挂。准备到一半换了账号，这一次当场放掉
   * （cancelPendingLaunchDialogs）。
   */
  function holdLaunch(id: ToolId, work: () => Promise<void>): Promise<boolean> {
    return toolbox.run(`launch:${id}`, launchWaitLabel(toolbox.jobs, jobToolName), () => new Promise<void>((resolve, reject) => {
      const release = () => resolve()
      preparingLaunches.current.set(id, release)
      work().then(resolve, reject).finally(() => { if (preparingLaunches.current.get(id) === release) preparingLaunches.current.delete(id) })
    }))
  }
  /**
   * mode 走的是 toolsApi.launch 那套「两侧各取自己认得的那个」:codexDesktop 认
   * 'open' | 'restart',各家 CLI 认 'new' | 'resumeLast'(#292),Codex 接着聊另带记录 id。
   */
  async function launch(id: ToolId, mode: 'open' | 'restart' | CliLaunchChoice = 'open', remembered?: string, folder: LaunchFolder = 'choose', epoch = accountEpoch.capture()): Promise<boolean> {
    const outcome = { opened: false }
    try {
      const started = await holdLaunch(id, async () => { outcome.opened = await openTool(id, mode, remembered, folder, epoch) })
      return launchIsCurrent(epoch) && started && outcome.opened
    } catch (cause) {
      if (!launchIsCurrent(epoch)) return false
      throw cause
    }
  }
  /** launch() 去掉挂任务那一层，只在已经挂着「正在打开工具」的时候调。 */
  async function openTool(id: ToolId, mode: 'open' | 'restart' | CliLaunchChoice, remembered: string | undefined, folder: LaunchFolder, epoch: () => boolean): Promise<boolean> {
    const prepared = await prepareToolLaunch(id, epoch)
    if (!prepared) return false
    const { current, config, tool } = prepared
    let workspace = config.workspace
    if (id !== 'codexDesktop') {
      // 不弹选择器的两种：主进程在「文档」下替用户建一个空的项目文件夹；第一次点「打开」
      // 时先用主进程记着的（上次建好了却没打开成），建不成再弹选择器（已知40）。
      const selectedWorkspace = remembered ?? await toolsApi.chooseWorkspace(folder === 'choose' ? undefined
        : folder === 'create' ? { createStarter: true } : { createStarter: true, firstOpen: true })
      if (!launchIsCurrent(epoch) || !selectedWorkspace) return false
      workspace = selectedWorkspace
    }
    if (!launchIsCurrent(epoch)) return false
    // 选文件夹那一会儿账号又开了一轮（跟线路悄悄改配置的那种）：照样等它写完，主进程打开时自己读配置。
    if (await waitForAccountConnection(tool, epoch) === 'stop') return false
    // 从这里起是主进程在打开，换了账号也要等它做完，「打开中」不再提前放掉。
    preparingLaunches.current.delete(id)
    const result = await toolsApi.launch(id, workspace, mode)
    const warning = launchWarning(result)
    if (launchIsCurrent(epoch) && warning) toast.show(warning, 'warn')
    // 刚选的文件夹主进程已经记下，随打开结果带回来；首页按钮马上写「打开 它」，其余工具也不再问。
    if (launchIsCurrent(epoch) && result && 'rememberedWorkspace' in result) {
      const rememberedWorkspace = result.rememberedWorkspace ?? undefined
      toolbox.setSnapshot((current) => current && current.config.rememberedWorkspace !== rememberedWorkspace
        ? { ...current, config: { ...current.config, rememberedWorkspace } }
        : current)
      // 开机检测还没跑完就打开的（首页摆的还是上次的结果）：那一轮落地时带的是打开前读的配置，
      // 会把刚记下的目录盖回去。重读一次配置，落地时就用这份新的（见 useToolbox 的 configRevision）。
      if (current.system.cachedAt) void toolbox.refreshSavedConfig(() => launchIsCurrent(epoch)).catch(() => undefined)
    }
    return launchIsCurrent(epoch)
  }
  /**
   * The Chinese runtime patch is what makes Codex start with a local debugging
   * port, so it is off until answered (E-S3). Users upgrading from a build
   * where it was always on would lose Chinese without noticing, so the first
   * launch with no stored answer asks, and the answer is stored either way.
   */
  async function askForChineseRuntimePatch(epoch = accountEpoch.capture()): Promise<boolean> {
    const storedChoice = settings?.codexDesktopChineseRuntimePatch
    if (!chineseRuntimePatchAnswerMissing(platform, storedChoice)) return false
    const locale = await toolsApi.getLocale().catch(() => null)
    if (!launchIsCurrent(epoch)) return false
    if (!shouldAskForChineseRuntimePatch({ platform, storedChoice, locale })) return false
    setChineseDialog(true)
    return true
  }
  async function answerChineseRuntimePatch(choice: 'enabled' | 'disabled'): Promise<void> {
    const epoch = accountEpoch.capture()
    // 'enabled' goes through setCodexDesktopLocale, the one path that owns both
    // config.toml and the stored answer; only the refusal is written directly.
    try {
      if (choice === 'enabled') await toolsApi.setLocale('zh-CN')
      else await app.savePreferences({ version: 2, codexDesktopChineseRuntimePatch: 'disabled' })
      if (!launchIsCurrent(epoch)) return
      const nextSettings = await app.readSettings()
      if (!launchIsCurrent(epoch)) return
      setSettings(nextSettings)
      setChineseDialog(false)
      await launch('codexDesktop', 'open', undefined, 'choose', epoch)
    } catch (cause) {
      if (launchIsCurrent(epoch)) throw cause
    }
  }
  function requestLaunch(id: ToolId, remembered?: string, mode: CliLaunchChoice = 'new', folder: LaunchFolder = 'choose') {
    const request = { id, epoch: accountEpoch.capture() }
    // 同一个账号点下去的上一次还没走完：这一下不再叠一次。上一次是停在等账号那一轮的，只拦它自己
    // 再点（那张卡本来就按不动），别的工具照常开，不陪它等那最长 3 分钟。
    const inFlight = launchRequest.current
    if (inFlight?.epoch() && (inFlight.id === id || !launchParkedOnAccount(inFlight.id))) return
    launchRequest.current = request
    void perform('打开工具', async () => {
      try {
        // Codex 桌面端先查在不在运行、问不问中文，也算在「正在打开工具」里；要弹框问的，
        // 这一次就到这里，框里的按钮走 launch() 再挂一次。
        await holdLaunch(id, async () => {
          if (!launchIsCurrent(request.epoch)) return
          if (id === 'codexDesktop') {
            const status = await native.getCodexDesktopStatus()
            if (!launchIsCurrent(request.epoch)) return
            if (offersCodexDesktopRestartOnOpen(os, status.running)) { setRestartDialog(true); return }
            const asking = await askForChineseRuntimePatch(request.epoch)
            if (!launchIsCurrent(request.epoch) || asking) return
          }
          if (remembered) await launchRemembered(id, remembered, mode, request.epoch)
          else await openTool(id, mode, undefined, folder, request.epoch)
        })
      } catch (cause) {
        if (launchIsCurrent(request.epoch)) throw cause
      }
    }).finally(() => { if (launchRequest.current === request) launchRequest.current = null })
  }
  /**
   * 记住的目录随时可能被删掉或改名。那种情况下退回目录选择器，用户点一次
   * 「打开」仍然能走到底，而不是只收到一条错误（N7）。只在 requestLaunch 挂着的那次任务里调。
   */
  async function launchRemembered(id: ToolId, remembered: string, mode: CliLaunchChoice = 'new', epoch = accountEpoch.capture()): Promise<boolean> {
    try { return await openTool(id, mode, remembered, 'choose', epoch) }
    catch (cause) {
      if (!launchIsCurrent(epoch)) return false
      if (!isMissingWorkspace(cause)) throw cause
      // 目录没了就没有「上次那条对话」可接,退回选择器开新的,总比只甩一条错误强。
      toast.show('上次用的目录已经找不到了，请重新选择。', 'warn')
      return openTool(id, 'open', undefined, 'choose', epoch)
    }
  }
  /**
   * 托盘「已安装的工具」和快捷键 Ctrl / Command + 1～5 没有按钮可看，就在首页那颗「打开 xx」
   * 写的同一个文件夹打开（launchWorkspaces）。以前这两处什么都不带，每次都弹选择框（第四十批 A）。
   * 记录读不到就只看上次选过的文件夹，都没有才弹；文件夹不在了，launchRemembered 提示一句再弹。
   * Codex 桌面端自己管工作区，照旧。
   */
  async function requestLaunchInLastWorkspace(id: ToolId) {
    if (id === 'codexDesktop') { requestLaunch(id); return }
    const epoch = accountEpoch.capture()
    const recent = await toolsApi.recent().catch(() => null)
    // 读记录的这一下换了账号：这次按下去是上一个账号的，不接着打开（同 launch 里的 epoch）。
    if (!launchIsCurrent(epoch)) return
    requestLaunch(id, launchWorkspaces(recent?.items ?? [], providerFor(id), toolbox.snapshot?.config.rememberedWorkspace)[0]?.path)
  }
  return {
    modelSwap, restartDialog, setRestartDialog, chineseDialog, setChineseDialog,
    cancelPendingLaunchDialogs, prepareToolLaunch, launch, requestLaunch, requestLaunchInLastWorkspace, answerChineseRuntimePatch,
  }
}
