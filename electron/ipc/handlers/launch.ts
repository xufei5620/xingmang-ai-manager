// 主窗口业务通道的处理器：选工作目录、在工作目录里打开命令行工具、打开 Codex 桌面端。
// 敏感目录的提醒、替用户新建项目文件夹、打开前试写这几步都只有这里用，跟着一起搬来。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildSensitiveWorkspacePrompt,
  classifyWorkspace,
  resolveRememberedWorkspace,
  sensitiveWorkspaceAsksAtLaunch,
  sensitiveWorkspaceLabel,
  sensitiveWorkspacePolicy,
  type SensitiveWorkspaceKind,
} from '../../workspace-guard'
import {
  buildDocumentsFallbackPrompt,
  buildWorkspaceNotWritablePrompt,
  createStarterWorkspaceWithFallback,
  inspectWorkspaceWritable,
  shouldCheckWorkspaceWritable,
} from '../../documents-fallback'
import { isActiveProviderId, type ProviderId } from '../../catalog'
import type { CliLaunchMode, CliLaunchResult } from '../../system-service'
import type { QueuedAccountWork } from '../../account-work-gate'
import {
  parseChooseWorkspaceOptions,
  parseCliLaunchMode,
  parseCodexResumeRecordId,
  parseDesktopLaunchMode,
  parseWorkspace,
} from '../parsers/tools'
import type { IpcHandlerContext } from './context'

function sameLaunchWorkspace(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

export function registerLaunchHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, externalShell } = ctx
  function documentsDirectory(): string | null {
    if (!options.documentsDirectory) return path.join(os.homedir(), 'Documents')
    try {
      return options.documentsDirectory()
    } catch {
      // app.getPath 拿不到「文档」时退到主目录（resolveNewProjectParent）。
      return null
    }
  }
  // 建不成就说一句、回到选择器，由用户自己选；返回 null 让外层循环再开一次选择器。
  async function createStarterWorkspaceOrExplain(parentWindow: BrowserWindow | undefined, nextStep: string): Promise<string | null> {
    try {
      const context = { platform: process.platform, home: options.homeDirectory?.() ?? os.homedir(), env: process.env }
      const placement = createStarterWorkspaceWithFallback(documentsDirectory(), context)
      // 不记路径（I13）：客服要的只是「这个目录是软件替他建的」和它是不是换过地方。
      options.runtimeLog.log('info', 'config', 'workspace.starter.created', '已替用户新建项目文件夹', {
        movedFromDocuments: placement.movedFromDocuments,
      })
      if (placement.movedFromDocuments) await explainDocumentsFallback(parentWindow, placement.directory)
      return placement.directory
    } catch (error) {
      options.runtimeLog.exception('config', 'workspace.starter.failed', error)
      const errorBoxOptions = {
        type: 'error' as const,
        title: '没能新建项目文件夹',
        message: '没能替你新建项目文件夹。',
        detail: `${error instanceof Error ? error.message : '未知错误'}\n\n${nextStep}`,
        buttons: ['知道了'],
        noLink: true,
      }
      if (parentWindow) await dialog.showMessageBox(parentWindow, errorBoxOptions)
      else await dialog.showMessageBox(errorBoxOptions)
      return null
    }
  }
  // 「文档」不让写、项目改建在主目录下：照实说项目在哪，给一颗「打开文件夹」。
  // 这是本机弹框、不进日志，完整路径照样显示，用户才找得到。
  async function explainDocumentsFallback(parentWindow: BrowserWindow | undefined, directory: string): Promise<void> {
    const prompt = buildDocumentsFallbackPrompt(directory, process.platform)
    const messageBoxOptions = {
      type: 'info' as const,
      title: prompt.title,
      message: prompt.message,
      detail: prompt.detail,
      buttons: [...prompt.buttons],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const answer = parentWindow
      ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions)
    if (answer.response !== prompt.openFolderIndex) return
    await externalShell.openPath(directory).catch((error) => {
      options.runtimeLog.exception('config', 'workspace.starter.open-folder-failed', error)
    })
  }
  // 在选择器里选到敏感目录、点了「仍然打开」，紧接着的那次打开不再重复问。只认同一个
  // 路径、只用一次、两分钟内有效，之后从最近记录等别的入口再打开，照样会问。
  let confirmedSensitiveWorkspace: { workspace: string; expiresAt: number } | null = null
  function consumeConfirmedSensitiveWorkspace(workspace: string): boolean {
    const confirmed = confirmedSensitiveWorkspace
    confirmedSensitiveWorkspace = null
    return confirmed !== null && confirmed.workspace === workspace && Date.now() <= confirmed.expiresAt
  }
  function classifyLocalWorkspace(workspace: string): SensitiveWorkspaceKind | null {
    return classifyWorkspace(workspace, { platform: process.platform, home: os.homedir() })
  }
  // 「新建一个项目文件夹」是默认按钮（#347）；续接对话时没有它，默认落在取消键上。
  async function askAboutSensitiveWorkspace(
    parentWindow: BrowserWindow | undefined,
    sensitivity: SensitiveWorkspaceKind,
    allowChooseAnother: boolean,
  ): Promise<'continue' | 'create' | 'cancel'> {
    const prompt = buildSensitiveWorkspacePrompt(sensitivity, { allowChooseAnother })
    const messageBoxOptions = {
      type: 'warning' as const,
      title: prompt.title,
      message: prompt.message,
      detail: prompt.detail,
      buttons: [...prompt.buttons],
      defaultId: prompt.createIndex ?? prompt.cancelIndex,
      cancelId: prompt.cancelIndex,
      noLink: true,
    }
    const answer = parentWindow
      ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions)
    if (prompt.createIndex !== null && answer.response === prompt.createIndex) return 'create'
    if (answer.response !== prompt.continueIndex) return 'cancel'
    // 只记类别不记路径（I13）；这条是客服排查「为什么工具又问了一次信任」的落点。
    options.runtimeLog.log('warn', 'config', 'workspace.guard.accepted', `用户确认在${sensitiveWorkspaceLabel(sensitivity)}里打开工具`, {
      kind: sensitivity,
      policy: sensitiveWorkspacePolicy(sensitivity),
    })
    return 'continue'
  }
  // 选到敏感目录时先说清楚风险。「换一个文件夹」直接把选择器再打开一次，用户点
  // 一次「打开」仍然能走到底；「新建一个项目文件夹」（默认）替用户建好一个普通目录
  // 直接返回，信任写入与 AGENTS.md 都照常，建不成就回到选择器；「仍然打开」照常
  // 返回，打开时会跳过信任写入与 AGENTS.md 生成（workspace-guard.ts）。
  async function pickWorkspace(parentWindow: BrowserWindow | undefined): Promise<string | null> {
    const dialogOptions: OpenDialogOptions = {
      title: '选择 CLI 工作目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    for (;;) {
      const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (result.canceled || !result.filePaths[0]) return null
      const selected = result.filePaths[0]
      const sensitivity = classifyLocalWorkspace(selected)
      if (!sensitivity) return selected
      const decision = await askAboutSensitiveWorkspace(parentWindow, sensitivity, true)
      if (decision === 'continue') {
        confirmedSensitiveWorkspace = { workspace: selected, expiresAt: Date.now() + 120_000 }
        return selected
      }
      if (decision === 'create') {
        const created = await createStarterWorkspaceOrExplain(parentWindow, '接下来会重新打开文件夹选择窗口，可以在里面自己新建一个文件夹再选它。')
        if (created !== null) return created
      }
    }
  }
  // 「每次都提醒」的目录不记住：不写进配置，下次还得重新选或在打开时再确认。
  async function rememberWorkspace(workspace: string): Promise<void> {
    const sensitivity = classifyLocalWorkspace(workspace)
    if (sensitivity && sensitiveWorkspacePolicy(sensitivity) === 'every-time') return
    await service.updateStoredConfig({ version: 2, workspace })
    options.extensionService.setRepositoryContext(workspace)
    options.providerExtensionService.setRepositoryRoot(workspace)
  }
  // 首页第一次点「打开」（已知40）时主进程已经记着的文件夹：上一次建好、记下了，只是没打开成
  // （比如终端没起来）。渲染层那份快照要等打开成功才知道记下了哪个，再点「打开」或错误框里的
  // 「重试」还会带着 firstOpen 来，这时用回它，不再建 my-project-2、-3。被删掉了就当没有。
  // 和快照里的 rememberedWorkspace 同一个认法（system-service 的 rememberedWorkspaceFor）。
  function rememberedExistingWorkspace(): string | null {
    const remembered = resolveRememberedWorkspace(service.readStoredConfig().workspace, {
      platform: process.platform,
      home: options.providerRoots?.userHome ?? os.homedir(),
      defaultWorkspace: os.homedir(),
    })
    if (!remembered) return null
    try {
      return fs.statSync(remembered).isDirectory() ? remembered : null
    } catch {
      return null
    }
  }
  registerTrustedHandler('workspace:choose', async (event, rawOptions: unknown) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const chooseOptions = parseChooseWorkspaceOptions(rawOptions)
    // 首页「新建项目文件夹」与引导里那颗按钮：不弹选择器，直接走提示框里「新建」
    // 那一支。路径由主进程决定，渲染层只能说「要新建」，给不出任何路径（I5）。
    // 首页第一次点「打开」（已知40）建不成时不让人再点一次：说完接着弹选择器。
    const workspace = !chooseOptions.createStarter
      ? await pickWorkspace(parentWindow)
      : chooseOptions.firstOpen
        ? rememberedExistingWorkspace()
          ?? await createStarterWorkspaceOrExplain(parentWindow, '接下来会重新打开文件夹选择窗口，可以在里面自己新建一个文件夹再选它。')
          ?? await pickWorkspace(parentWindow)
        : await createStarterWorkspaceOrExplain(parentWindow, '可以再点一次「打开」，自己选一个文件夹。')
    if (workspace === null) return null
    await rememberWorkspace(workspace)
    return workspace
  })
  registerTrustedHandler('repository:get-context', () => options.extensionService.getRepositoryContext())
  /**
   * 记录这边核对一遍再交给 Codex:记录还在、而且就在要打开的这个文件夹里,才按
   * id 接;查不到(刚被删、数据库暂时读不了)或文件夹对不上,就退回按目录找最近
   * 一条 —— 也就是加这个参数之前的行为,不会因此打不开。
   */
  async function verifiedCodexResumeSessionId(recordId: string, workspace: string): Promise<string | null> {
    try {
      const recorded = await options.providerSessionsService.resolveWorkspace(recordId)
      if (!recorded || !sameLaunchWorkspace(recorded, workspace)) return null
      return recordId.slice('codex:'.length)
    } catch {
      return null
    }
  }
  function launchProviderWith(provider: ProviderId, target: string, launchMode: CliLaunchMode, resumeSessionId: string | null) {
    const accountWork = options.accountWork?.queue()
    if (accountWork) return launchQueued(accountWork, () => service.launchProvider(provider, target, launchMode, resumeSessionId, accountWork))
    return resumeSessionId === null
      ? service.launchProvider(provider, target, launchMode)
      : service.launchProvider(provider, target, launchMode, resumeSessionId)
  }
  // 点两下同一个「打开」时第二下跟着第一下那份排队，它自己那份从没交给队列：请求一结束就交还。
  function launchQueued<T>(accountWork: QueuedAccountWork & { release(): void }, launch: () => Promise<T>): Promise<T> {
    try {
      return Promise.resolve(launch()).finally(() => accountWork.release())
    } catch (error) {
      accountWork.release()
      throw error
    }
  }
  registerTrustedHandler('cli:launch', (event, provider: unknown, workspace: unknown, mode: unknown, recordId: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    const stored = service.readStoredConfig()
    const target = parseWorkspace(workspace, stored.workspace)
    const launchMode = parseCliLaunchMode(mode)
    const resumeRecordId = parseCodexResumeRecordId(provider, launchMode, recordId)
    if (resumeRecordId === null) return launchCliInWorkspace(event, provider, target, launchMode, null)
    return (async () => launchCliInWorkspace(
      event,
      provider,
      target,
      launchMode,
      await verifiedCodexResumeSessionId(resumeRecordId, target),
    ))()
  })
  function launchCliInWorkspace(
    event: IpcMainInvokeEvent,
    provider: ProviderId,
    target: string,
    launchMode: CliLaunchMode,
    resumeSessionId: string | null,
  ) {
    const sensitivity = classifyLocalWorkspace(target)
    if (
      !sensitivity
      || !sensitiveWorkspaceAsksAtLaunch(sensitivity, launchMode === 'resumeLast')
      || consumeConfirmedSensitiveWorkspace(target)
    ) {
      return launchUnlessUnwritable(event, provider, target, launchMode, resumeSessionId, sensitivity)
    }
    // 首页「打开」从记录推出来的目录、最近记录、记录页「接着上次对话」、老版本记住的目录都
    // 不经过选择器，所以在这里再问一次。续接对话换了目录就接不上，那一问只给「先不打开」，
    // 不给「新建」和「换一个文件夹」。
    return (async () => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const allowChooseAnother = launchMode === 'new'
      const decision = await askAboutSensitiveWorkspace(parentWindow, sensitivity, allowChooseAnother)
      if (decision === 'continue') return launchUnlessUnwritable(event, provider, target, launchMode, resumeSessionId, sensitivity)
      let replacement: string | null = null
      if (decision === 'create') {
        replacement = await createStarterWorkspaceOrExplain(parentWindow, '接下来会重新打开文件夹选择窗口，可以在里面自己新建一个文件夹再选它。')
      }
      if (replacement === null && allowChooseAnother) replacement = await pickWorkspace(parentWindow)
      if (replacement === null) {
        options.runtimeLog.log('info', 'config', 'workspace.guard.declined', `用户没有在${sensitiveWorkspaceLabel(sensitivity)}里打开工具`, {
          kind: sensitivity,
        })
        // 明说没打开：以前回 undefined，记录页把它当成功，照样弹「已打开…」。
        const declined: CliLaunchResult = { declined: true }
        return declined
      }
      consumeConfirmedSensitiveWorkspace(replacement)
      await rememberWorkspace(replacement)
      // 换来的目录和从选择器直接选的一样先试写：首页「打开」进主目录那一问以后，换的多半是
      // 文档里的项目文件夹，受控文件夹访问拦的正是那儿。
      return launchUnlessUnwritable(event, provider, replacement, launchMode, null, classifyLocalWorkspace(replacement))
    })()
  }
  // 桌面、文档、下载问过「仍然打开」以后，照旧先试写一次（launchIfWritable）；
  // 系统目录和存密钥的目录不试写，问完直接打开。
  function launchUnlessUnwritable(
    event: IpcMainInvokeEvent,
    provider: ProviderId,
    target: string,
    launchMode: CliLaunchMode,
    resumeSessionId: string | null,
    sensitivity: SensitiveWorkspaceKind | null,
  ) {
    const writeCheckPlatform = options.workspaceWriteCheck?.platform ?? process.platform
    if (!shouldCheckWorkspaceWritable(sensitivity, writeCheckPlatform)) {
      return launchProviderWith(provider, target, launchMode, resumeSessionId)
    }
    return launchIfWritable(event, provider, target, launchMode, resumeSessionId)
  }
  // 受控文件夹访问、安全软件的文档保护开着时，工具照样起得来，但 AI 一改文件就是一串
  // 英文 EPERM，客户只看到「说改了但文件没变」。以前写信任、生成 AGENTS.md 失败只记一条
  // warn（system-service.ts），这里在打开前先试写一次，写不进就先说一句。
  async function launchIfWritable(
    event: IpcMainInvokeEvent,
    provider: ProviderId,
    target: string,
    launchMode: CliLaunchMode,
    resumeSessionId: string | null,
  ) {
    const startedAt = Date.now()
    const writability = await inspectWorkspaceWritable(target, options.workspaceWriteCheck ? { probe: options.workspaceWriteCheck.probe } : {})
    // 不记路径（I13）：客服要的是结果和耗时。
    options.runtimeLog.log(writability === 'denied' ? 'warn' : 'info', 'config', 'workspace.write-check', writability === 'denied'
      ? '选中的文件夹不让写入，打开前先提醒'
      : '打开前试写了选中的文件夹', { provider, result: writability, durationMs: Date.now() - startedAt })
    if (writability !== 'denied') return launchProviderWith(provider, target, launchMode, resumeSessionId)
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const prompt = buildWorkspaceNotWritablePrompt({ allowCreate: launchMode === 'new' })
    const messageBoxOptions = {
      type: 'warning' as const,
      title: prompt.title,
      message: prompt.message,
      detail: prompt.detail,
      buttons: [...prompt.buttons],
      defaultId: prompt.defaultIndex,
      cancelId: prompt.cancelIndex,
      noLink: true,
    }
    const answer = parentWindow
      ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions)
    if (answer.response === prompt.continueIndex) {
      options.runtimeLog.log('info', 'config', 'workspace.write-check.continued', '文件夹不让写入，用户仍然照常打开', { provider })
      return launchProviderWith(provider, target, launchMode, resumeSessionId)
    }
    let replacement: string | null = null
    if (answer.response === prompt.createIndex) {
      replacement = await createStarterWorkspaceOrExplain(parentWindow, '接下来会重新打开文件夹选择窗口，可以自己选一个能写的文件夹。')
      if (replacement === null) replacement = await pickWorkspace(parentWindow)
    }
    if (replacement === null) {
      options.runtimeLog.log('info', 'config', 'workspace.write-check.declined', '文件夹不让写入，用户没有打开工具', { provider })
      const declined: CliLaunchResult = { declined: true }
      return declined
    }
    consumeConfirmedSensitiveWorkspace(replacement)
    await rememberWorkspace(replacement)
    return launchProviderWith(provider, replacement, launchMode, null)
  }
  registerTrustedHandler('desktop:launch-codex', (event, mode: unknown) => {
    const launchMode = parseDesktopLaunchMode(mode)
    const accountWork = options.accountWork?.queue()
    return accountWork
      ? launchQueued(accountWork, () => service.launchCodexDesktop(launchMode, event.sender, { accountWork }))
      : service.launchCodexDesktop(launchMode, event.sender)
  })
}
