import { ExternalLink, RefreshCw, Settings, WifiOff } from 'lucide-react'
import { Button } from '../../ui'
import { offlineBannerTexts, proxyBypassedBannerText } from './online-status'
import { useOnlineStatus } from './useOnlineStatus'

/** 断网时挂在窗口顶部的唯一一条说法；网络回来自动收起，不弹别的。 */
export function OfflineBanner() {
  const { offline, cause = 'offline', proxyBypassNotice, checking, recheck, openNetworkSettings, dismissProxyBypassNotice } = useOnlineStatus()
  if (!offline) {
    if (!proxyBypassNotice) return null
    return <div className="v2-offline-banner" role="status" data-testid="proxy-bypass-banner">
      <Settings size={15} aria-hidden="true" /><span>{proxyBypassedBannerText}</span>
      {openNetworkSettings && <Button size="xs" variant="ghost" icon={Settings} onClick={() => openNetworkSettings('proxy')} testId="offline-banner-proxy-settings">打开系统代理设置</Button>}
      {dismissProxyBypassNotice && <Button size="xs" variant="ghost" onClick={dismissProxyBypassNotice} testId="proxy-bypass-banner-dismiss">知道了</Button>}
    </div>
  }
  return <div className="v2-offline-banner" role="status" data-testid="offline-banner" data-cause={cause}>
    <WifiOff size={15} aria-hidden="true" /><span>{offlineBannerTexts[cause]}</span>
    {cause === 'proxy' && openNetworkSettings && <Button size="xs" variant="ghost" icon={Settings} onClick={() => openNetworkSettings('proxy')} testId="offline-banner-proxy-settings">打开系统代理设置</Button>}
    {cause === 'portal' && openNetworkSettings && <Button size="xs" variant="ghost" icon={ExternalLink} onClick={() => openNetworkSettings('captive-portal')} testId="offline-banner-portal">打开认证页</Button>}
    <Button size="xs" variant="ghost" icon={RefreshCw} loading={checking} onClick={recheck} testId="offline-banner-recheck">重新检测</Button>
  </div>
}
