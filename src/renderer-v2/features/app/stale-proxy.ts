import type { StaleProxyClearResult } from '../../../../electron/ipc-contract'

type DetailValue = boolean | number | string | null

/**
 * 检查页「电脑中的代理设置」一项：主进程确认当前 Windows 账号下有一条指向没开的
 * 本机代理的设置时，才给「清掉这条旧设置」按钮（第十六批 5）。整台电脑那一份、
 * 开着的代理、指向别的机器的都不给。
 */
export function canClearStaleProxy(item: { code: string; details?: Record<string, DetailValue> }): boolean {
  return item.code === 'PROXY_ENVIRONMENT' && item.details?.fix === 'clear-user-proxy'
}

/** 确认框里那句话：说清清掉的是哪一条、不动什么、以后要用怎么办。 */
export function staleProxyConfirmBody(details?: Record<string, DetailValue>): string {
  const port = typeof details?.port === 'number' ? `本机 ${details.port} 端口` : '本机'
  return `将删除当前 Windows 用户下的一条代理设置（指向${port}，当前未运行），系统级设置不受影响。如需再次使用该代理，请打开代理软件后按原教程重新设置。`
}

export function staleProxyClearMessage(result: StaleProxyClearResult): string {
  if (result.cleared.length) {
    return result.machineRemaining
      ? '已清除当前用户下的代理设置。系统级仍存在相同设置，需管理员权限修改；从星芒打开的工具将继续自动绕过该设置。'
      : '已清除。之后新打开的命令行窗口将不再使用该代理。'
  }
  return result.machineRemaining
    ? '该设置为系统级设置，需管理员权限修改。从星芒打开的工具已自动绕过该设置。'
    : '无需处理：该代理当前可连接，或该设置已不存在。'
}
