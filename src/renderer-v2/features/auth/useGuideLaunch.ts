import { useEffect, useState } from 'react'
import type { MultiProviderSessionPage, ProviderId } from '../../../../electron/ipc-contract'
import type { ToolsApi } from '../app/runtime-context'
import { launchWorkspaces, opensUntouchedStarterWorkspace, startsInNewFolder } from '../tools/recent-workspaces'
import type { GuideToolState } from './StartGuide'

/** 引导最后一步那颗「打开」落在哪（D46，新手流程 N2）：跟首页这个工具的「打开」同一套。 */
export interface GuideLaunchTarget {
  /** 首页「打开」写着的那个文件夹（launchWorkspaces 的第一个）；没有 = 不在现成的文件夹里开。 */
  workspace?: string
  /** 没用过、也没记过文件夹：替他新建项目文件夹打开（已知40，startsInNewFolder）。 */
  startsFresh: boolean
}

/**
 * 首页卡片按会话记录定「打开」落在哪。引导叠在首页上面，也可能叠在欢迎页上面（那时首页没挂），
 * 所以自己读一份；toolsApi 缓存一分钟，跟首页读的是同一份，不多读盘。只在引导开着时读，
 * revision 变了（主动重新检测、记录有变）再读一次。读不到当没读到：「打开」弹选择窗口，跟首页一样。
 */
export function useGuideLaunch(toolsApi: Pick<ToolsApi, 'recent'>, open: boolean, revision: number, remembered: string | undefined): (provider: ProviderId) => GuideLaunchTarget {
  const [recent, setRecent] = useState<MultiProviderSessionPage | null>(null)
  useEffect(() => {
    if (!open) return
    let current = true
    void toolsApi.recent().then((page) => { if (current) setRecent(page) }).catch(() => { if (current) setRecent(null) })
    return () => { current = false }
  }, [toolsApi, open, revision])
  return (provider) => guideLaunchTarget(recent, provider, remembered)
}

export function guideLaunchTarget(recent: MultiProviderSessionPage | null, provider: ProviderId, remembered: string | undefined): GuideLaunchTarget {
  const workspaces = launchWorkspaces(recent?.items ?? [], provider, remembered)
  return { ...(workspaces[0] ? { workspace: workspaces[0].path } : {}), startsFresh: startsInNewFolder(recent, provider, workspaces) }
}

/**
 * 交给引导的那两样：「打开」旁边给不给「选择其他文件夹…」（opensIn），那句粘进去的话按「打开」会落在
 * 哪个文件夹挑（freshFolder，D45），判法跟首页「试试第一条命令」那张卡一样。
 */
export function guideFolderFields(
  target: GuideLaunchTarget,
  config: { rememberedWorkspace?: string; rememberedWorkspaceFresh?: boolean } | null | undefined,
): Pick<GuideToolState, 'opensIn' | 'freshFolder'> {
  const opensIn = target.startsFresh ? 'newFolder' as const : target.workspace ? 'lastFolder' as const : undefined
  return {
    ...(opensIn ? { opensIn } : {}),
    freshFolder: opensUntouchedStarterWorkspace({ createsFolder: target.startsFresh, workspace: target.workspace }, config),
  }
}
