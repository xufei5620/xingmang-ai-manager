import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AccountSessionState, AccountSourceTarget, ExternalToolId, PlatformCapabilities } from '../../../../electron/ipc-contract'
import type { LatestRequest } from '../../latest-request'
import { operationFailureFrom } from '../../business-common'
import { operationTargetOf, presentOperationFailure } from '../../operation-error'
import type { ToolInstallOutcome } from '../../pages-maintenance'
import type { PageId } from '../../registry/pages'
import { macDesktopTutorialTopic } from '../../registry/business'
import { tools } from '../../registry/tools'
import type { AuthMode } from '../auth'
import type { OperationFailure } from '../app/OperationErrorDialog'
import type { AppApi, AppToast, PendingConfirmation, Perform, Toolbox, ToolsApi } from '../app/runtime-context'
import type { AccountBootstrap } from '../app/useAccountBootstrap'
import { offlineActionMessage } from '../shell/online-status'
import type { ToolInstallIntent } from './Home'
import { manualUninstallState, type ManualUninstallState } from './ManualUninstall'
import { managedSwitchVersion } from './managed-switch'
import { canSwitchToManagedInstall, presentTools, providerFor, recommendedVersionVerb, spacedName, type ToolId } from './model'
import { describeNodeReplaceOutcome } from './node-replace'
import { describeRuntimeInstallOutcome, type RuntimeInstallOutcome } from './runtime-install-outcome'
import { cliInstallStageLabel, cliNeedsNodeRuntime, planCliInstall, runtimeStageFailureMessage, type InstallRuntimeId } from './runtime-readiness'
import { jobToolName, withoutTool } from './tool-jobs'
import { rememberRevertedToolUpdate } from './update-notice'
import { uninstallHandOffNotice } from './uninstall-handoff'
import { clientLaunchWaitLabel } from './launch-notice'
import { installedToolSyncLabel } from './useToolbox'

interface ToolInstallOptions {
  app: AppApi
  toolsApi: ToolsApi
  toolbox: Toolbox
  toast: AppToast
  perform: Perform
  platform: PlatformCapabilities | null
  session: AccountSessionState
  scope: string
  latestScope: RefObject<string>
  offline: boolean
  offlineNow: RefObject<boolean>
  mounted: RefObject<boolean>
  accountEpoch: LatestRequest
  runAccountBootstrap: AccountBootstrap['runAccountBootstrap']
  refreshRecent(): void
  navigate(page: PageId, section?: string): void
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
  setConfirmation: Dispatch<SetStateAction<PendingConfirmation | null>>
  setOperationError: Dispatch<SetStateAction<OperationFailure | null>>
  setExternalClient: Dispatch<SetStateAction<ExternalToolId | null>>
}

/**
 * 装、更新、退回、卸载工具，准备运行环境，以及三个桌面客户端的装、开、换账号。进度挂在首页
 * 工具卡上（toolbox.run）；装完把账号密钥写进去再重新检测，这一段也算在同一个任务里。
 */
export function useToolInstall(options: ToolInstallOptions) {
  const { app, toolsApi, toolbox, toast, perform, platform, session, scope, latestScope, offline, offlineNow, mounted, accountEpoch, runAccountBootstrap, refreshRecent, navigate, setAuth, setConfirmation, setOperationError, setExternalClient } = options
  // 首页卡片上正在装的是更新、回到推荐版本还是退回（v4 批 04）：进度那一行开头说清楚。
  const [installIntents, setInstallIntents] = useState<Partial<Record<ToolId, ToolInstallIntent>>>({})
  // 首页卡片上第一次装没装上的原因：卡片写「没装上：…，已撤回」，「看原因」再弹一次同一个错误框。
  const [installFailures, setInstallFailures] = useState<Partial<Record<ToolId, { reason: string; failure: OperationFailure }>>>({})
  // 国内下载线路还没跟上微软商店时，这次「更新」其实没换版本：说一句，并给出去商店的按钮。
  const [storeNewerVersion, setStoreNewerVersion] = useState<string | null>(null)
  const [manualUninstall, setManualUninstall] = useState<ManualUninstallState | null>(null)
  const [runtimeRestart, setRuntimeRestart] = useState(false)
  // 官方安装器装的 Claude Code 换成星芒装的之前那一问（第三十一批 B）；answer(false) = 不换。
  const [managedSwitch, setManagedSwitch] = useState<{ version: string; answer: (confirmed: boolean) => void } | null>(null)
  const pendingManagedSwitch = useRef<((confirmed: boolean) => void) | null>(null)
  /** done 传了就把「装完以后账号密钥写没写进去」记进去：首页装好时那句话要按它说（v4 批 04）。 */
  async function install(id: ToolId, version?: string, done?: { keyWritten?: boolean }): Promise<ToolInstallOutcome> {
    const state = toolbox.snapshot
    if (!state) throw new Error('请先完成工具检测')
    const management = id === 'codexDesktop' ? state.platform.codexDesktop.install : state.platform.cliInstall[id]
    // 这不是一次失败：macOS 上这几个桌面端本来就要客户自己下载。以前当错误抛出来，
    // 用户会同时看到红色错误框和一个跳到教程首页、又没有对应章节的页面（第七批 3）。
    // Linux 的教程里没有 Mac 那一章，跳过去只会落到第一章：只说一句，不跳。
    if (management === 'external' && state.platform.platform === 'linux') { toast.show(`${tools.find((tool) => tool.id === id)?.name ?? '这个工具'}在这台电脑上暂时不能一键安装。`, 'neutral'); return 'skipped' }
    if (management === 'external') { navigate('tutorial', macDesktopTutorialTopic); toast.show('这个系统要你自己下载安装，教程里是完整步骤。', 'neutral'); return 'skipped' }
    if (offline) { toast.show(offlineActionMessage, 'warn'); return 'skipped' }
    const definition = tools.find((tool) => tool.id === id)
    const toolName = definition?.name ?? '工具'
    const plan = id === 'codexDesktop'
      ? { prepare: [], blocked: null }
      : planCliInstall({ runtime: state.system.runtime, needsNode: cliNeedsNodeRuntime(state.platform, id), nodeInstall: platform?.nodeRuntimeInstall })
    if (plan.blocked) throw new Error(plan.blocked)
    const current = presentTools(state).find((tool) => tool.id === id)
    // 官方安装器装的 Claude Code 星芒更新不了，只能先卸掉再装回星芒自己的（第三十一批 B）。
    // 卸之前问一句；问之前上面已经确认过没断网、运行环境装得上。
    const switchVersion = current && canSwitchToManagedInstall(id, current.status) ? managedSwitchVersion(current, version) : null
    if (switchVersion) {
      // 这一份已经在换（比如首页点过、又在卡片「…」里点「重新安装」）：再问一遍「先把它卸掉」
      // 只会让人糊涂。和 toolbox.run 撞锁一样，当作已经在装。
      if (toolbox.jobs[id]) return 'skipped'
      if (!await confirmManagedSwitch(switchVersion)) return 'declined'
      // 确认框里写的是哪一版，就点名装哪一版。
      version = switchVersion
    }
    const total = plan.prepare.length + 1
    // 运行环境那一段主进程没有取消通道；这时按「取消」要说清楚，而不是回一句
    //「没有正在进行的安装」。换装时卸载那一步同样没有；装完以后同步 Key、重新检测
    // 那几秒也没有，主进程装完就不再登记这次安装（第四十批 C）。
    let preparing = plan.prepare.length > 0
    let uninstalling = false
    let finishing = false
    let outcome: ToolInstallOutcome = 'installed'
    const updating = Boolean(current?.status.installed)
    // 收尾必须留在同一个安装任务里。任务一结束工具行就回落到安装前的快照：
    // 同步 Key 和重新检测还没跑完，版本号已经退回旧值、「更新」按钮跟着回弹，
    // 用户看到的是「装完了又要装一次」（yoyo 2026-09-20 真机反馈①）。
    // 用户中途取消时安装那一步抛出，收尾自然不会跑：本来就没装上，不用写 Key。
    const finished = await toolbox.run(id, switchVersion && !preparing ? '正在卸载' : version ? `正在安装 ${version}` : preparing ? cliInstallStageLabel(plan.prepare[0], 0, total, toolName) : '正在安装', async (report) => {
      for (const [index, runtime] of plan.prepare.entries()) {
        report(cliInstallStageLabel(runtime, index, total, toolName))
        // MSI 回 3010 时 Windows 要重启才算装完，接着装工具多半失败（第七批 5）：
        // 停在这里弹「现在重启」，重启后再点一次「安装」只剩装工具这一段。
        if ((await prepareRuntimeForInstall(runtime, toolName)).restartRequired) {
          await toolbox.refresh(true).catch(() => undefined)
          if (mounted.current) setRuntimeRestart(true)
          outcome = 'restart'
          return
        }
      }
      preparing = false
      if (switchVersion) {
        // 运行环境备齐了才卸：卸完到装上之间越短越好，环境要重启电脑时官方那份也还在。
        // 确认框可能开着放了好一阵，运行环境也可能刚装了几分钟：真动手卸之前再看一眼网，
        // 断了就先不卸，免得卸完装不回来。
        if (offlineNow.current) {
          if (mounted.current) toast.show(offlineActionMessage, 'warn')
          outcome = 'skipped'
          return
        }
        uninstalling = true
        report('正在卸载')
        try {
          if (!await uninstallBeforeSwitch(id, toolName)) { outcome = 'skipped'; return }
        }
        catch (cause) {
          void toolbox.refresh(true).catch(() => undefined)
          throw cause
        }
        finally { uninstalling = false }
        report(plan.prepare.length > 0 ? cliInstallStageLabel('tool', total - 1, total, toolName) : `正在安装 ${version}`)
      }
      else if (plan.prepare.length > 0) report(cliInstallStageLabel('tool', total - 1, total, toolName))
      try {
        const result = await toolsApi.install(id, version)
        if (id === 'codexDesktop' && result && 'storeNewerVersion' in result && result.storeNewerVersion && mounted.current) setStoreNewerVersion(result.storeNewerVersion)
      }
      catch (cause) {
        // 环境已经装好、工具没装上：刷新一次，下次再点只剩装工具这一段。
        // 换装时官方那份已经卸掉了：刷新后这一行变回「安装」，再点一次就好。
        if (plan.prepare.length > 0 || switchVersion) void toolbox.refresh(true).catch(() => undefined)
        throw cause
      }
      finishing = true
      report(installedToolSyncLabel)
      const keyWritten = await syncAfterToolInstalled(id)
      if (done) done.keyWritten = keyWritten
    }, { cancel: async () => preparing ? { cancelled: false, reason: '正在准备运行环境，这一步不能取消；准备好后会接着安装工具。' } : uninstalling || finishing ? { cancelled: false, reason: '这一步已经不能取消了。' } : toolsApi.cancelInstall(id), notice: { updating, unfinished: () => outcome !== 'installed' } })
    // run 返回 false 只有两种：用户取消了，或同一个工具已经有一次安装在跑。
    return finished ? outcome : 'skipped'
  }
  /** 弹「换成星芒装的」确认框，等客户点；关掉框和点「取消」一样算不换。 */
  function confirmManagedSwitch(version: string): Promise<boolean> {
    pendingManagedSwitch.current?.(false)
    return new Promise<boolean>((resolve) => {
      const answer = (confirmed: boolean) => {
        if (pendingManagedSwitch.current !== answer) return
        pendingManagedSwitch.current = null
        setManagedSwitch(null)
        resolve(confirmed)
      }
      pendingManagedSwitch.current = answer
      setManagedSwitch({ version, answer })
    })
  }
  /**
   * 「换成星芒装的」的前一半：和「卸载」走同一条路、同一套结果处理，只多带 reinstall，
   * 主进程先看盘够不够装回来再动手。返回 false = 卸载转交给了别的窗口，这次先不装。
   */
  async function uninstallBeforeSwitch(id: ToolId, name: string): Promise<boolean> {
    const result = await toolsApi.uninstall(id, { reinstall: true })
    // 程序已经卸掉，只剩几个旧版本文件没删掉（多半是 Claude Code 还开着）：照常装上，清理那一步交给客户。
    if (result.outcome === 'manual-required') setManualUninstall(manualUninstallState(name, id, result.manualHelp))
    const handedOff = uninstallHandOffNotice(result)
    if (!handedOff) return true
    // 同「卸载」：转交出去时官方那份可能已经卸掉了，刷新一次，这一行照实际情况显示。
    void toolbox.refresh(true).catch(() => undefined)
    if (mounted.current) toast.show(handedOff, 'neutral')
    return false
  }
  /**
   * 串在「安装」里的运行环境那一段。单独占一个 node / python 任务，运行环境卡上
   * 的进度条照常走；那个任务已经在跑（用户先点过运行环境卡）时不重复发起。
   */
  async function prepareRuntimeForInstall(runtime: InstallRuntimeId, toolName: string): Promise<RuntimeInstallOutcome> {
    try {
      const done: { outcome?: RuntimeInstallOutcome } = {}
      const started = await toolbox.run(runtime, '正在准备运行环境', async () => {
        done.outcome = describeRuntimeInstallOutcome(runtime, await toolsApi.prepareRuntime(runtime))
      })
      if (!started || !done.outcome) throw new Error('运行环境正在准备，请等它完成后再点「安装」。')
      return done.outcome
    } catch (cause) {
      // 原话留着不先翻成中文：外层的错误分类要靠 ENOSPC、ETIMEDOUT 这类原词认出
      //「磁盘满」「下载超时」，展示前 errorMessage 会统一脱敏。
      throw new Error(runtimeStageFailureMessage(runtime, toolName, cause))
    }
  }
  async function cancelInstall(id: ToolId | ExternalToolId) {
    const outcome = await toolbox.cancel(id)
    // 主进程拒绝取消时必须说清楚为什么，否则按钮看起来像坏了。
    if (!outcome.cancelled && outcome.reason) toast.show(outcome.reason, 'warn')
  }
  /**
   * 装完一个工具要做两件收尾：把账号 Key 写进刚装好的工具，再刷新检测结果。
   * 装工具的入口都必须共用这一段，否则装完只提示「工具状态已更新」，首页还停在「未安装」、
   * Key 也没写（R-G3）。
   */
  async function syncAfterToolInstalled(id: ToolId): Promise<boolean> {
    let keyWritten = false
    // 装到一半退出登录或换了账号：这一轮只会被「账号已变化」拦下，失败那条路还会把
    // 欢迎页换成未登录的首页。不跑；再登录时那一轮会给装好的工具写 Key（#1097）。
    if (session.authenticated && session.account && scope === latestScope.current) {
      const outcome = await runAccountBootstrap(session.account.userId, 'login', true, [providerFor(id)])
      keyWritten = Boolean(outcome?.result?.configured.includes(providerFor(id)))
    }
    // 以前「安装卸载」页装完走的是它自己的 bridge 调用，绕开了 toolsApi 那侧的作废，才补了这一刀；那一页拆掉了
    // （第 10 批），留着它不碍事：刷新「最近」只是多读一次，哪条安装入口以后再绕开 toolsApi 也不会漏。
    refreshRecent()
    await toolbox.refresh(true)
    return keyWritten
  }
  async function installRuntime(runtime: 'node' | 'python' | 'git') {
    if (offline) { toast.show(offlineActionMessage, 'warn'); return }
    // Git 按钮在 Windows 和 macOS 出现。以前点了是打开官网让客户自己下安装包，小白卡在
    // 这一步（yoyo 2026-09-24）。Windows 由主进程按当前用户代装；Mac 弹苹果自己的安装
    // 窗口，客户可能在那里点取消，那时主进程带回 installed: false 和要说的那句话（第十六批 2）。
    if (runtime === 'git') {
      const outcome: { message?: string } = {}
      const done = await toolbox.run('git', '正在准备安装 Git', async () => {
        const result = await toolsApi.installGit()
        if (!result.installed) outcome.message = result.message ?? '没有装 Git。需要时再点一次「安装 Git」就行。'
      }, { notice: { unfinished: () => Boolean(outcome.message) } })
      await toolbox.refresh(true)
      if (done && mounted.current) toast.show(outcome.message ?? 'Git 装好了。', outcome.message ? 'warn' : 'ok')
      return
    }
    const mode = runtime === 'node' ? platform?.nodeRuntimeInstall : platform?.pythonRuntimeInstall
    if (mode !== 'managed') { await app.openExternal(runtime === 'node' ? 'https://nodejs.org/' : 'https://www.python.org/downloads/'); return }
    // 主进程装完带回「要重启 / 要刷新 PATH」两个标记，以前这里直接扔掉（第七批 5）。
    const done: { outcome?: RuntimeInstallOutcome } = {}
    await toolbox.run(runtime, '正在准备运行环境', async () => {
      done.outcome = describeRuntimeInstallOutcome(runtime, await toolsApi.prepareRuntime(runtime))
    }, { notice: { unfinished: () => Boolean(done.outcome?.restartRequired) } })
    await toolbox.refresh(true)
    if (!done.outcome || !mounted.current) return
    if (done.outcome.restartRequired) setRuntimeRestart(true)
    else toast.show(done.outcome.message, done.outcome.tone)
  }
  async function replaceNode(retry?: () => void) {
    if (offline) { toast.show(offlineActionMessage, 'warn'); return }
    const done: { outcome?: RuntimeInstallOutcome } = {}
    await toolbox.run('node', '正在换成新版 Node.js', async () => {
      done.outcome = describeNodeReplaceOutcome(await toolsApi.replaceNode(), Boolean(retry))
    }, { notice: { unfinished: () => Boolean(done.outcome?.restartRequired) } })
    await toolbox.refresh(true)
    if (!done.outcome || !mounted.current) return
    if (done.outcome.restartRequired) { setRuntimeRestart(true); return }
    toast.show(done.outcome.message, done.outcome.tone)
    retry?.()
  }
  async function installExternal(id: ExternalToolId) {
    const epoch = accountEpoch.capture()
    try {
      const completed = await toolbox.run(id, '正在安装', () => toolsApi.installExternal(id), { cancel: () => toolsApi.cancelExternalInstall(id), notice: {} })
      if (!completed || !mounted.current || !epoch()) return
      await toolbox.refreshExternal()
      if (mounted.current && epoch()) toast.show(`${spacedName(jobToolName(id) ?? id)}已装好，点「确认连接」用上当前账号`, 'ok')
    } catch (cause) { if (mounted.current && epoch()) throw cause }
  }
  async function launchExternal(id: ExternalToolId) {
    const epoch = accountEpoch.capture()
    try {
      // 只等这一家自己正在装的那一次，别的工具在装不等（I11 的登记例外）。
      const waitLabel = clientLaunchWaitLabel(toolbox.jobs, id, jobToolName)
      const launched = await toolbox.run(`launch:${id}`, waitLabel, () => toolsApi.launchExternal(id))
      // 打开以后变的只有这一行的「运行中」：不再整轮重扫，那会让三行按钮一起变灰（第三十一批 C）。
      if (launched && mounted.current && epoch()) toolbox.noteExternalLaunched(id)
    } catch (cause) { if (mounted.current && epoch()) throw cause }
  }
  // Claude Desktop 卡上的「切回官方账号 / 改用当前账号」：只改它登录页那个选择。星芒那份配置用不上了
  // （不在了、不是当前账号的密钥）时主进程一个字没写，这里接着打开「连接 Claude Desktop」重新保存。
  async function switchExternalSource(id: ExternalToolId, target: AccountSourceTarget) {
    if (target === 'account' && (!session.authenticated || !session.account)) { setAuth('login'); return }
    const epoch = accountEpoch.capture()
    const outcome: { result?: Awaited<ReturnType<typeof toolsApi.switchExternalSource>> } = {}
    try {
      await toolbox.run(`switch:${id}`, target === 'account' ? '正在改用当前账号' : '正在切回官方账号', async () => {
        try {
          outcome.result = await toolsApi.switchExternalSource(id, target)
        } finally {
          await toolbox.refreshExternal(true).catch(() => undefined)
        }
      })
    } catch (cause) { if (mounted.current && epoch()) throw cause }
    const result = outcome.result
    if (!result || !mounted.current || !epoch()) return
    if (result.outcome === 'reconnect') {
      // 弹框前先说一句为什么弹（#1111 第 1 条）：客户点的是「改用当前账号」，看到的却是一个配置框。
      // 不点按钮名：配置框的主按钮会跟着检测结果在「保存并检测」「保存配置」之间变。
      toast.show('原来那份连接用不上了，在弹出的窗口里保存一次，就改用当前账号', 'neutral')
      setExternalClient(id)
    } else toast.show(result.message, 'ok')
  }
  function finishExternalConfigSave() {
    const epoch = accountEpoch.capture()
    void toolbox.refreshExternal().catch(() => {
      if (mounted.current && epoch()) toast.show('配置已保存，客户端状态尚未读到，请重新检测。', 'warn')
    })
  }
  function requestUninstall(id: ToolId) {
    const definition = tools.find((tool) => tool.id === id)!
    setConfirmation({ title: `卸载 ${definition.name}？`, body: `会删掉 ${spacedName(definition.name)}程序，配置和历史会话都保留，重装后直接能用。`, label: `卸载 ${definition.name}`, danger: true, tool: id, work: async () => {
      let uninstalled = false
      await toolbox.run(id, '正在卸载', async () => {
        const result = await toolsApi.uninstall(id)
        if (result.outcome === 'manual-required') {
          setManualUninstall(manualUninstallState(definition.name, id, result.manualHelp))
          return
        }
        // 管理员模式下卸载转交给普通窗口：是预料之中的一步，给中性提示，不当失败弹红框。
        const handedOff = uninstallHandOffNotice(result)
        if (handedOff && mounted.current) toast.show(handedOff, 'neutral')
        uninstalled = result.outcome === 'uninstalled'
      }, { kind: 'uninstall' })
      // 真卸掉了、紧接着的检测没读到（已知32）：卸载本身做成了，不弹「操作没有完成」，确认框
      // 照常关，免得客户以为没卸成又点一次「卸载工具」。首页顶上检测自己的那句照旧。转交给
      // 命令窗口的、要自己手动卸的，照旧当没做完。
      const refreshed = await toolbox.refresh(true).then(() => true, (cause: unknown) => {
        if (!uninstalled) throw cause
        if (mounted.current) toast.show(`${definition.name} 已卸载，但最新状态没有读到。请重新检测，无需重复卸载。`, 'warn')
        return false
      })
      // 转交给命令窗口的、要自己手动卸的不说这句（照字表）：那时程序还没卸掉。
      if (uninstalled && refreshed && mounted.current) toast.show(`${spacedName(definition.name)}已卸载，配置已保留`, 'ok')
    } })
  }
  function requestRevert(id: ToolId, version: string) {
    const name = tools.find((tool) => tool.id === id)?.name ?? '工具'
    const latestVersion = toolbox.snapshot ? presentTools(toolbox.snapshot).find((tool) => tool.id === id)?.latestVersion ?? null : null
    const shown = version.replace(/^v/, '')
    setConfirmation({ title: `退回 v${shown}？`, body: `会把 ${spacedName(name)}换回更新前的 v${shown}，配置和历史会话都保留。退回后还会显示有新版本，等下次更新写明修好了再更新。`, label: `退回 v${shown}`, tool: id, work: async () => {
      // 确认框马上关掉，进度交给工具卡片，和「更新」一样可以看进度、可以取消。
      void perform('退回工具版本', async () => {
        rememberRevertedToolUpdate(id, latestVersion)
        setInstallIntents((current) => ({ ...current, [id]: { kind: 'revert', version: shown } }))
        try {
          if (await install(id, version) === 'installed' && mounted.current) toast.show(`${spacedName(name)}已退回 v${shown}`, 'ok')
        } finally {
          if (mounted.current) setInstallIntents((current) => withoutTool(current, id))
        }
      }, id)
    } })
  }
  /**
   * 首页卡片上的安装、更新、回到推荐版本、重新安装（v4 批 04），走的就是上面那个 install。
   * 推荐版本比装着的旧时先问一句再回去；进度那一行开头写「更新到 / 回到 v…」；做完照字表说一句。
   */
  function installFromHome(id: ToolId, version?: string, intent?: 'update' | 'rollback') {
    const current = toolbox.snapshot ? presentTools(toolbox.snapshot).find((tool) => tool.id === id) : undefined
    const name = tools.find((tool) => tool.id === id)?.name ?? current?.name ?? '工具'
    const target = version?.replace(/^v/, '')
    const goingBack = intent === 'rollback' && current !== undefined && recommendedVersionVerb(current) === '回到'
    if (goingBack && target && current?.currentVersion) {
      const installed = current.currentVersion.replace(/^v/, '')
      setConfirmation({ title: `回到推荐版本 v${target}？`, label: `回到 v${target}`, tool: id,
        body: <><p>{`现在装的是 v${installed}，比星芒验证过的版本新。遇到问题时可以回到 v${target}。`}</p><p>配置和历史会话都会保留。</p></>,
        // 确认框马上关掉，进度交给工具卡片，同「退回」。
        work: async () => { void runHomeInstall(id, name, version, 'rollback', true) } })
      return
    }
    void runHomeInstall(id, name, version, goingBack ? 'rollback' : intent || current?.status.installed ? 'update' : undefined, Boolean(current?.status.installed))
  }
  async function runHomeInstall(id: ToolId, name: string, version: string | undefined, kind: 'update' | 'rollback' | undefined, wasInstalled: boolean) {
    const target = version?.replace(/^v/, '')
    // 重新安装（装着、没点名版本）不算更新：进度那一行不加开头，装完也不说「已更新到」。
    const shownKind = kind === 'update' && !version ? undefined : kind
    if (shownKind && target) setInstallIntents((current) => ({ ...current, [id]: { kind: shownKind, version: target } }))
    setInstallFailures((current) => withoutTool(current, id))
    setOperationError(null)
    const done: { keyWritten?: boolean } = {}
    try {
      const outcome = await install(id, version, done)
      if (outcome !== 'installed' || !mounted.current) return
      if (!wasInstalled) toast.show(done.keyWritten ? `${spacedName(name)}已装好，并配好了你的账号` : `${spacedName(name)}已装好`, 'ok')
      else if (shownKind === 'rollback' && target) toast.show(`${spacedName(name)}已回到推荐版本 v${target}`, 'ok')
      else if (shownKind === 'update' && target) toast.show(`${spacedName(name)}已更新到 v${target}，有问题可以在「更多操作」里退回`, 'ok')
    } catch (cause) {
      const action = '安装工具'
      const operationTarget = operationTargetOf(action)
      const failure: OperationFailure = { ...operationFailureFrom(cause, action), action, retry: () => void runHomeInstall(id, name, version, kind, wasInstalled), tool: id, ...(operationTarget ? { target: operationTarget } : {}) }
      if (!mounted.current) return
      setOperationError(failure)
      // 第一次装没装上：卡片上留一句原因和「看原因」。Codex 桌面端装不上时错误框里有自己的出路（去商店），卡片照旧。
      if (!wasInstalled && id !== 'codexDesktop') {
        const reason = presentOperationFailure(failure)?.title ?? failure.message.replace(/[。.\s]+$/, '')
        setInstallFailures((current) => ({ ...current, [id]: { reason, failure } }))
      }
    } finally {
      if (mounted.current) setInstallIntents((current) => withoutTool(current, id))
    }
  }
  /** 首页卡片上的「取消」：停下来以后照字表说一句，主进程不让停时说为什么。 */
  async function cancelHomeInstall(id: ToolId) {
    const current = toolbox.snapshot ? presentTools(toolbox.snapshot).find((tool) => tool.id === id) : undefined
    const name = tools.find((tool) => tool.id === id)?.name ?? current?.name ?? '工具'
    const outcome = await toolbox.cancel(id)
    if (!outcome.cancelled) { if (outcome.reason) toast.show(outcome.reason, 'warn'); return }
    if (!mounted.current) return
    if (!current?.status.installed) toast.show(`已取消安装 ${name}，没有留下文件`, 'neutral')
    else if (current.currentVersion) toast.show(`已取消，${spacedName(name)}还是 v${current.currentVersion.replace(/^v/, '')}`, 'neutral')
  }
  return {
    installIntents, installFailures, storeNewerVersion, setStoreNewerVersion, manualUninstall, setManualUninstall, runtimeRestart, setRuntimeRestart, managedSwitch,
    install, cancelInstall, installRuntime, replaceNode, installExternal, launchExternal, switchExternalSource, finishExternalConfigSave,
    requestUninstall, requestRevert, installFromHome, cancelHomeInstall,
  }
}
