import { useEffect, useState } from 'react'
import type { CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { newerRemoteSnapshot, remoteAnyEnabled } from './remote-view'

/**
 * 外壳状态栏的「手机遥控中」：有渠道开着就亮，点了去设置里那张卡关掉。手机上能让这台电脑跑命令，
 * 开着时坐在电脑前的人要一眼看得到。读不到当没开：开关不落盘，开着的一定是这次在设置卡上打开的，卡上看得到。
 */
export function useCodexRemoteActive(api: V2Bridge): boolean {
  const [snapshot, setSnapshot] = useState<CodexRemoteSnapshot | null>(null)
  useEffect(() => {
    let current = true
    function accept(next: CodexRemoteSnapshot) {
      if (current) setSnapshot((previous) => newerRemoteSnapshot(previous, next))
    }
    const unsubscribe = api.onCodexRemoteStateChanged(accept)
    void api.getCodexRemoteState().then(accept, () => undefined)
    return () => {
      current = false
      unsubscribe()
    }
  }, [api])
  return snapshot !== null && remoteAnyEnabled(snapshot)
}
