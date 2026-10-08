import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import { Notice } from '../../ui'

type LaunchInstall = NonNullable<UpdateSnapshot['launchInstallNotice']>

/** 离开始安装还有几秒；到点之后是 0。 */
export function launchInstallSecondsLeft(installAt: number, now: number): number {
  return Math.max(0, Math.ceil((installAt - now) / 1_000))
}

export function launchInstallCountdownText(secondsLeft: number): string {
  return secondsLeft > 0 ? `还有 ${secondsLeft} 秒开始安装。` : '正在开始安装，软件马上关掉。'
}

/**
 * 开机自动装上次下好的版本前，窗口里和系统通知说同一句话。系统通知可能被专注助手或
 * 通知权限静默吞掉，这张卡是兜底：用户至少知道窗口为什么要关、授权窗为什么弹。
 * 不放「先不装」也不放关闭叉——装不装早已定了，这张卡只负责说清楚，几秒后自己就没了。
 */
export function LaunchInstallNotice({ notice, now = Date.now }: { notice: LaunchInstall; now?: () => number }) {
  const [secondsLeft, setSecondsLeft] = useState(() => launchInstallSecondsLeft(notice.installAt, now()))
  useEffect(() => {
    setSecondsLeft(launchInstallSecondsLeft(notice.installAt, now()))
    const timer = window.setInterval(() => setSecondsLeft(launchInstallSecondsLeft(notice.installAt, now())), 250)
    return () => window.clearInterval(timer)
  }, [notice.installAt, now])
  return <Notice tone="accent" icon={RefreshCw} title={notice.title}
    body={<>{notice.body}<br />{launchInstallCountdownText(secondsLeft)}</>} testId="launch-install-notice" />
}
