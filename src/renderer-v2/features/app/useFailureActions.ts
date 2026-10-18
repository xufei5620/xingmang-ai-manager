import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { ProviderId } from '../../../../electron/ipc-contract'
import { claudeDesktopDownloadPageUrl } from '../../../../electron/claude-desktop-install-failure'
import { codexDesktopStoreUrl } from '../../../../electron/codex-desktop-install-failure'
import { operationLogSection, rewriteKeyAction, type OperationActionId } from '../../operation-error'
import type { ToolInstallOutcome } from '../../pages-maintenance'
import { macDesktopTutorialTopic } from '../../registry/business'
import type { PageId } from '../../registry/pages'
import type { AuthMode } from '../auth'
import type { ToolboxSnapshot, ToolId } from '../tools/model'
import type { OperationFailure } from './OperationErrorDialog'
import type { AppApi, AppToast, PendingConfirmation, Perform, ToolsApi } from './runtime-context'

interface FailureActionsOptions {
  app: AppApi
  toolsApi: ToolsApi
  toast: AppToast
  perform: Perform
  navigate(page: PageId, section?: string): void
  operationError: OperationFailure | null
  setOperationError: Dispatch<SetStateAction<OperationFailure | null>>
  rewriteAccountKeys(providers?: readonly ProviderId[]): Promise<boolean>
  install(id: ToolId): Promise<ToolInstallOutcome>
  snapshot: ToolboxSnapshot | null
  setConfirmation: Dispatch<SetStateAction<PendingConfirmation | null>>
  setNodeReplace: Dispatch<SetStateAction<{ retry?: () => void } | null>>
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
  setHelp: Dispatch<SetStateAction<boolean>>
}

/** 错误框和新手引导里那些「改用…」「去…」的出口按钮，各自通到哪（operation-error 的目录）。 */
export function useFailureActions({ app, toolsApi, toast, perform, navigate, operationError, setOperationError, rewriteAccountKeys, install, snapshot, setConfirmation, setNodeReplace, setAuth, setHelp }: FailureActionsOptions) {
  // 商店链接在主进程外链白名单里（全等匹配）。系统没接住时说清楚自己去哪儿找，
  // 不留一颗按了没反应的按钮。打不开多半是这台电脑没有商店（第二十一批 2），
  // 那就别再叫人去开始菜单里找它，回星芒重装会改走 OpenAI 官网的离线安装包或国内线路。
  const openCodexDesktopStore = useCallback(async () => {
    if (!await app.openExternal(codexDesktopStoreUrl)) throw new Error('没能打开微软商店，这台电脑可能没有它。回星芒再点一次安装，星芒会改用 OpenAI 官网的离线安装包或国内线路装；还不行就找客服。')
  }, [app])
  // 错误框里的「重置 Codex」：清掉的是 Codex 桌面端自己的登录和缓存，先问一句再动手；
  // 重置完接着把刚才没打开的那一次再跑一遍，客户不用再回首页点「打开」。
  const requestCodexDesktopReset = useCallback((retry?: () => void) => {
    setConfirmation({ title: '重置 Codex 桌面端？', body: 'Codex 桌面端里的登录状态和缓存会被清掉，星芒写好的连接设置不受影响。重置完会自动再打开一次。', label: '重置', danger: true, tool: 'codexDesktop', work: async () => {
      await toolsApi.resetCodexDesktop()
      if (retry) retry()
      else toast.show('Codex 桌面端已经重置，回首页点「打开」试试。', 'ok')
    } })
  }, [toast, toolsApi, setConfirmation])
  const runOperationAction = useCallback((action: OperationActionId) => {
    const failure = operationError
    setOperationError(null)
    if (action === 'retry') failure?.retry?.()
    else if (action === 'log') navigate('feedback', failure ? operationLogSection(failure) : 'log')
    else if (action === 'network') navigate('health')
    else if (action === 'recharge') navigate('account', 'recharge')
    else if (action === 'backups') navigate('backups')
    else if (action === 'relogin') setAuth('login')
    // 目录里 keyInvalid 的「一键修复」就是这件事：对当前账号把已配置的工具重新
    // 写一次 Key。一次点击只重写一次，连续失败的出口仍旧是「找客服」。
    else if (action === 'repair') void perform(rewriteKeyAction, () => rewriteAccountKeys())
    else if (action === 'replaceNode') setNodeReplace(failure?.retry ? { retry: failure.retry } : {})
    else if (action === 'openStore') void perform('打开微软商店', openCodexDesktopStore)
    else if (action === 'resetCodexDesktop') requestCodexDesktopReset(failure?.retry)
    else if (action === 'useCodexCli') switchToCodexCli()
    else if (action === 'installGuide') navigate('tutorial', macDesktopTutorialTopic)
    // Windows 上 Claude Desktop 一键安装没装上时的出口；下载页在主进程外链白名单里（全等匹配）。
    else if (action === 'claudeDesktopDownload') void perform('打开下载页', () => app.openExternal(claudeDesktopDownloadPageUrl))
    else setHelp(true)
  }, [app, navigate, openCodexDesktopStore, operationError, perform, requestCodexDesktopReset, rewriteAccountKeys, setAuth, setHelp, setNodeReplace, setOperationError])
  // 引导里「改用」或安装失败时的出口：和错误框同一张表，只是没有「再试一次」
  //（引导自己有）。去充值、去设置 › 备份迁移会离开引导，进度照旧留着；换 Node.js 不离开，
  // 换完接着重跑引导里失败的那一步。
  const runGuideFailureAction = useCallback((action: OperationActionId, retry?: () => void) => {
    if (action === 'replaceNode') setNodeReplace(retry ? { retry } : {})
    else if (action === 'recharge') navigate('account', 'recharge')
    else if (action === 'backups') navigate('backups')
    else if (action === 'log') navigate('feedback', 'log')
    else if (action === 'network') navigate('health')
    else if (action === 'relogin') setAuth('login')
    else if (action === 'repair') void perform(rewriteKeyAction, () => rewriteAccountKeys())
    else if (action === 'openStore') void perform('打开微软商店', openCodexDesktopStore)
    else if (action === 'resetCodexDesktop') requestCodexDesktopReset(retry)
    else if (action === 'useCodexCli') switchToCodexCli()
    else if (action === 'installGuide') navigate('tutorial', macDesktopTutorialTopic)
    else if (action === 'claudeDesktopDownload') void perform('打开下载页', () => app.openExternal(claudeDesktopDownloadPageUrl))
    else setHelp(true)
  }, [app, navigate, openCodexDesktopStore, perform, requestCodexDesktopReset, rewriteAccountKeys, setAuth, setHelp, setNodeReplace])
  // Codex 桌面端这一版已知打不开时的「改用 Codex 命令行版」：回到首页 Codex 那一行；
  // 还没装就直接开始装，装好了由客户自己点「打开」（第十九批 7）。
  function switchToCodexCli() {
    navigate('home')
    if (snapshot?.system.clis.codex.installed) toast.show('Codex 命令行版在首页，点它那一行的「打开」就能用。', 'neutral')
    else void perform('安装工具', () => install('codex'), 'codex')
  }
  return { openCodexDesktopStore, runOperationAction, runGuideFailureAction }
}
