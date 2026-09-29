import type { StaleProxyClearResult } from '../../../../electron/ipc-contract'

type DetailValue = boolean | number | string | null

/**
 * 检查页「电脑里的代理设置」一项：主进程确认当前 Windows 账号下有一条指向没开的
 * 本机代理的设置时，才给「清掉这条旧设置」按钮（第十六批 5）。整台电脑那一份、
 * 开着的代理、指向别的机器的都不给。
 */
export function canClearStaleProxy(item: { code: string; details?: Record<string, DetailValue> }): boolean {
  return item.code === 'PROXY_ENVIRONMENT' && item.details?.fix === 'clear-user-proxy'
}

/** 确认框里那句话：说清清掉的是哪一条、不动什么、以后要用怎么办。 */
export function staleProxyConfirmBody(details?: Record<string, DetailValue>): string {
  const port = typeof details?.port === 'number' ? `本机 ${details.port} 端口` : '本机'
  return `会删掉你这个 Windows 账号下的一条代理设置（指向${port}，它现在没开）。整台电脑的设置不会动。以后要用这个代理，打开代理软件后照原来的教程再设一次就行。`
}

export function staleProxyClearMessage(result: StaleProxyClearResult): string {
  if (result.cleared.length) {
    return result.machineRemaining
      ? '已经清掉你这个账号下的那条。整台电脑还有一条同样的设置，要管理员才能改；从星芒打开的工具会继续自动绕开它。'
      : '已经清掉。以后新开的命令行窗口也不会再走这个代理。'
  }
  return result.machineRemaining
    ? '这条设置是给整台电脑设的，要管理员才能改。从星芒打开的工具已经会自动绕开它。'
    : '没有要清的了：这个代理现在能连上，或者这条设置已经不在了。'
}
