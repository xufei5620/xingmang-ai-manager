import { RefreshCw, WifiOff } from 'lucide-react'
import { Button } from '../../ui'
import { offlineBannerText } from './online-status'
import { useOnlineStatus } from './useOnlineStatus'

/** 断网时挂在窗口顶部的唯一一条说法；网络回来自动收起，不弹别的。 */
export function OfflineBanner() {
  const { offline, checking, recheck } = useOnlineStatus()
  if (!offline) return null
  return <div className="v2-offline-banner" role="status" data-testid="offline-banner">
    <WifiOff size={15} aria-hidden="true" /><span>{offlineBannerText}</span>
    <Button size="xs" variant="ghost" icon={RefreshCw} loading={checking} onClick={recheck} testId="offline-banner-recheck">重新检测</Button>
  </div>
}
